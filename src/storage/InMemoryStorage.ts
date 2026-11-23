/**
 * InMemoryStorage — deterministic, hermetic event store for unit tests.
 *
 * Mirrors the structural guarantees of PostgresStorage:
 *  - unique (workspaceId, stream, sequence) — duplicate append throws AppendConflictError
 *  - frozen records — once appended, mutation attempts throw InalterableViolationError
 *
 * Records are returned as deep clones to prevent test code from mutating
 * internal state and accidentally "passing" because of shared references.
 */

import type { EventStorage, AppendInput, ReadFilter, TxOptions } from './EventStorage.js';
import { AppendConflictError, InalterableViolationError } from './EventStorage.js';
import type { StreamName, EventRecord } from '../eventStore.js';

interface StoredRow {
  workspaceId: string;
  stream: StreamName;
  sequence: number;
  payload: unknown;
  previousHash: string;
  hash: string;
  recordedAt: string;
  _id: string;
}

export class InMemoryStorage implements EventStorage {
  private rows: StoredRow[] = [];
  /** Tail of the withStreamLock queue per `workspaceId:stream`. */
  private locks = new Map<string, Promise<unknown>>();

  async append<T>(input: AppendInput<T>): Promise<EventRecord<T>> {
    const conflict = this.rows.find(
      (r) =>
        r.workspaceId === input.workspaceId &&
        r.stream === input.stream &&
        r.sequence === input.sequence,
    );
    if (conflict) {
      throw new AppendConflictError(input.workspaceId, input.stream, input.sequence);
    }
    const _id = makeRowId(input.workspaceId, input.stream, input.sequence);
    const row: StoredRow = {
      workspaceId: input.workspaceId,
      stream: input.stream,
      sequence: input.sequence,
      payload: clone(input.payload),
      previousHash: input.previousHash,
      hash: input.hash,
      recordedAt: input.recordedAt,
      _id,
    };
    Object.freeze(row);
    this.rows.push(row);
    return rowToRecord<T>(row);
  }

  async read<T>(filter: ReadFilter): Promise<EventRecord<T>[]> {
    let out = this.rows.filter(
      (r) => r.workspaceId === filter.workspaceId && r.stream === filter.stream,
    );
    if (filter.from) out = out.filter((r) => r.recordedAt >= filter.from!);
    if (filter.to) out = out.filter((r) => r.recordedAt <= filter.to!);
    if (filter.fromSequence !== undefined) out = out.filter((r) => r.sequence >= filter.fromSequence!);
    if (filter.toSequence !== undefined) out = out.filter((r) => r.sequence <= filter.toSequence!);
    out.sort((a, b) => a.sequence - b.sequence);
    if (filter.limit !== undefined) out = out.slice(0, filter.limit);
    return out.map((r) => rowToRecord<T>(r));
  }

  async getLast<T>(workspaceId: string, stream: StreamName): Promise<EventRecord<T> | null> {
    let last: StoredRow | null = null;
    for (const r of this.rows) {
      if (r.workspaceId !== workspaceId || r.stream !== stream) continue;
      if (!last || r.sequence > last.sequence) last = r;
    }
    return last ? rowToRecord<T>(last) : null;
  }

  async withStreamLock<R>(
    workspaceId: string,
    stream: StreamName,
    fn: (opts: TxOptions) => Promise<R>,
    opts: TxOptions = {},
  ): Promise<R> {
    const key = `${workspaceId}:${stream}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(() => fn(opts));
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async count(filter: Omit<ReadFilter, 'limit'>): Promise<number> {
    const rows = await this.read({ ...filter, limit: undefined });
    return rows.length;
  }

  async assertSchema(): Promise<void> {
    /* in-memory has no schema to assert */
  }

  async close(): Promise<void> {
    this.rows = [];
  }

  // ─── Test-only helpers (NOT part of the EventStorage contract) ────────

  /**
   * Forces a mutation of a row, bypassing inalterability — used by integrity
   * tests to simulate "what if a malicious actor with raw DB access tampered
   * with the chain". Production code can never reach this.
   */
  _forceTamper(workspaceId: string, stream: StreamName, sequence: number, mutator: (row: Record<string, unknown>) => void): void {
    const idx = this.rows.findIndex(
      (r) => r.workspaceId === workspaceId && r.stream === stream && r.sequence === sequence,
    );
    if (idx === -1) {
      throw new Error(`_forceTamper: no row at (${workspaceId}, ${stream}, ${sequence})`);
    }
    const target = this.rows[idx]!;
    const writable: Record<string, unknown> = { ...target };
    mutator(writable);
    this.rows[idx] = writable as unknown as StoredRow;
  }

  /** Force-delete a row (simulates a SQL DELETE bypass). */
  _forceDelete(workspaceId: string, stream: StreamName, sequence: number): void {
    const idx = this.rows.findIndex(
      (r) => r.workspaceId === workspaceId && r.stream === stream && r.sequence === sequence,
    );
    if (idx === -1) {
      throw new Error(`_forceDelete: no row at (${workspaceId}, ${stream}, ${sequence})`);
    }
    this.rows.splice(idx, 1);
  }

  /**
   * Rejects a mutation attempt against the public API. Currently a noop because
   * the only mutator is _forceTamper (test-only). Kept to mirror the Postgres
   * trigger surface in case future code paths add a mutating method.
   */
  _rejectMutation(): never {
    throw new InalterableViolationError('row in nf525_event cannot be modified');
  }
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function makeRowId(workspaceId: string, stream: StreamName, sequence: number): string {
  return `${workspaceId}:${stream}:${sequence.toString().padStart(12, '0')}`;
}

function rowToRecord<T>(row: StoredRow): EventRecord<T> {
  return {
    _id: row._id,
    stream: row.stream,
    sequence: row.sequence,
    workspaceId: row.workspaceId,
    previousHash: row.previousHash,
    hash: row.hash,
    recordedAt: row.recordedAt,
    payload: clone(row.payload) as T,
  };
}
