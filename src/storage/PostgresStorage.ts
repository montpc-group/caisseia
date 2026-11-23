/**
 * PostgresStorage — production EventStorage adapter.
 *
 * Connects as the `nf525_app` role (REVOKE UPDATE, DELETE) and inserts into
 * `nf525_event`. Concurrency is handled by the unique (workspace_id, stream,
 * sequence) constraint: a duplicate-key error becomes an AppendConflictError
 * the caller retries.
 *
 * SERIALIZABLE isolation is *not* required for append because the unique
 * constraint already serializes effectively at the index level. We use the
 * default READ COMMITTED for write throughput and rely on retry-on-conflict.
 */

import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import type { EventStorage, AppendInput, ReadFilter, TxOptions } from './EventStorage.js';
import { AppendConflictError } from './EventStorage.js';
import type { StreamName, EventRecord } from '../eventStore.js';
import { readEnv } from '../env.js';

export class PostgresStorage implements EventStorage {
  constructor(private readonly pool: Pool) {}

  static fromConnectionString(connectionString: string): PostgresStorage {
    const pool = new pg.Pool({ connectionString });
    return new PostgresStorage(pool);
  }

  static fromEnv(): PostgresStorage {
    const url = readEnv('DATABASE_URL');
    if (!url) {
      throw new Error('PostgresStorage.fromEnv: CAISSEIA_DATABASE_URL is required');
    }
    return PostgresStorage.fromConnectionString(url);
  }

  /**
   * With `opts.client`, the INSERT runs on the caller's connection and inside
   * the caller's transaction: no BEGIN/COMMIT here, the client is not
   * released, and the record commits or rolls back with the caller's writes.
   * A conflict (AppendConflictError) then aborts the caller's transaction too.
   */
  async append<T>(input: AppendInput<T>, opts?: TxOptions): Promise<EventRecord<T>> {
    const _id = makeRowId(input.workspaceId, input.stream, input.sequence);
    const client: PoolClient = opts?.client ?? (await this.pool.connect());
    try {
      const res = await client.query(
        `INSERT INTO nf525_event
            (id, workspace_id, stream, sequence, previous_hash, hash, recorded_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING id, workspace_id, stream, sequence, previous_hash, hash, recorded_at, payload`,
        [
          _id,
          input.workspaceId,
          input.stream,
          input.sequence,
          input.previousHash,
          input.hash,
          input.recordedAt,
          JSON.stringify(input.payload),
        ],
      );
      const row = res.rows[0]!;
      return rowToRecord<T>(row);
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === '23505') {
        // unique_violation
        throw new AppendConflictError(input.workspaceId, input.stream, input.sequence, err);
      }
      throw err;
    } finally {
      if (!opts?.client) client.release();
    }
  }

  async read<T>(filter: ReadFilter, opts?: TxOptions): Promise<EventRecord<T>[]> {
    const params: unknown[] = [filter.workspaceId, filter.stream];
    let where = 'workspace_id = $1 AND stream = $2';
    if (filter.from) {
      params.push(filter.from);
      where += ` AND recorded_at >= $${params.length}`;
    }
    if (filter.to) {
      params.push(filter.to);
      where += ` AND recorded_at <= $${params.length}`;
    }
    if (filter.fromSequence !== undefined) {
      params.push(filter.fromSequence);
      where += ` AND sequence >= $${params.length}`;
    }
    if (filter.toSequence !== undefined) {
      params.push(filter.toSequence);
      where += ` AND sequence <= $${params.length}`;
    }
    let sql = `SELECT id, workspace_id, stream, sequence, previous_hash, hash, recorded_at, payload
               FROM nf525_event WHERE ${where} ORDER BY sequence ASC`;
    if (filter.limit !== undefined) {
      params.push(filter.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const res = await (opts?.client ?? this.pool).query(sql, params);
    return res.rows.map((r) => rowToRecord<T>(r));
  }

  /**
   * With `opts.client`: first takes a transaction-scoped advisory lock on
   * (workspaceId, stream), held until the caller commits or rolls back, then
   * reads on the caller's connection. A parallel caller transaction appending
   * to the same stream waits here, then (READ COMMITTED, a fresh snapshot per
   * statement) sees the committed record and takes the next sequence: no fork.
   * The caller's transaction must be READ COMMITTED (the Postgres default).
   */
  async getLast<T>(workspaceId: string, stream: StreamName, opts?: TxOptions): Promise<EventRecord<T> | null> {
    if (opts?.client) await lockStream(opts.client, workspaceId, stream);
    const res = await (opts?.client ?? this.pool).query(
      `SELECT id, workspace_id, stream, sequence, previous_hash, hash, recorded_at, payload
       FROM nf525_event
       WHERE workspace_id = $1 AND stream = $2
       ORDER BY sequence DESC
       LIMIT 1`,
      [workspaceId, stream],
    );
    return res.rows[0] ? rowToRecord<T>(res.rows[0]) : null;
  }

  async withStreamLock<R>(
    workspaceId: string,
    stream: StreamName,
    fn: (opts: TxOptions) => Promise<R>,
    opts?: TxOptions,
  ): Promise<R> {
    if (opts?.client) {
      await lockStream(opts.client, workspaceId, stream);
      return fn(opts);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await lockStream(client, workspaceId, stream);
        const out = await fn({ client });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } finally {
      client.release();
    }
  }

  async count(filter: Omit<ReadFilter, 'limit'>): Promise<number> {
    const params: unknown[] = [filter.workspaceId, filter.stream];
    let where = 'workspace_id = $1 AND stream = $2';
    if (filter.from) {
      params.push(filter.from);
      where += ` AND recorded_at >= $${params.length}`;
    }
    if (filter.to) {
      params.push(filter.to);
      where += ` AND recorded_at <= $${params.length}`;
    }
    if (filter.fromSequence !== undefined) {
      params.push(filter.fromSequence);
      where += ` AND sequence >= $${params.length}`;
    }
    if (filter.toSequence !== undefined) {
      params.push(filter.toSequence);
      where += ` AND sequence <= $${params.length}`;
    }
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM nf525_event WHERE ${where}`,
      params,
    );
    return (res.rows[0] as { cnt: number }).cnt;
  }

  async assertSchema(): Promise<void> {
    const res = await this.pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_name = 'nf525_event'`,
    );
    if (res.rowCount === 0) {
      throw new Error(
        'PostgresStorage.assertSchema: table nf525_event missing — run `pnpm migrate` first',
      );
    }
    const trig = await this.pool.query(
      `SELECT trigger_name FROM information_schema.triggers
       WHERE event_object_table = 'nf525_event'
         AND trigger_name IN ('nf525_refuse_update', 'nf525_refuse_delete')`,
    );
    if ((trig.rowCount ?? 0) < 2) {
      throw new Error(
        'PostgresStorage.assertSchema: inalterability triggers missing — run migrations',
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Transaction-scoped advisory lock on (workspaceId, stream). Re-entrant within
 * a session: getLast taking it again inside withStreamLock does not block.
 */
async function lockStream(client: PoolClient, workspaceId: string, stream: StreamName): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `nf525_event:${workspaceId}:${stream}`,
  ]);
}

function makeRowId(workspaceId: string, stream: StreamName, sequence: number): string {
  return `${workspaceId}:${stream}:${sequence.toString().padStart(12, '0')}`;
}

interface DbRow {
  id: string;
  workspace_id: string;
  stream: StreamName;
  sequence: string | number;
  previous_hash: string;
  hash: string;
  recorded_at: Date | string;
  payload: unknown;
}

function rowToRecord<T>(row: DbRow): EventRecord<T> {
  const recordedAt =
    row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at);
  return {
    _id: row.id,
    workspaceId: row.workspace_id,
    stream: row.stream,
    sequence: typeof row.sequence === 'string' ? Number(row.sequence) : row.sequence,
    previousHash: row.previous_hash,
    hash: row.hash,
    recordedAt,
    payload: row.payload as T,
  };
}
