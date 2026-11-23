/**
 * PostgresStorage.append(input, { client }): the caller owns the transaction.
 * The record must commit or roll back WITH the caller's other writes, so an
 * application can seal an invoice in the same transaction as its own rows.
 *
 * Unlike the other Postgres suites, a container that fails to start FAILS
 * this file (set NF525_SKIP_POSTGRES=1 to skip it explicitly).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/storage/migrate.js';
import { PostgresStorage } from '../src/storage/PostgresStorage.js';

const d = process.env['NF525_SKIP_POSTGRES'] === '1' ? describe.skip : describe;
const H = (c: string) => c.repeat(64);

d('PostgresStorage.append inside a caller transaction', () => {
  let stop: () => Promise<void>;
  let pool: pg.Pool;
  let storage: PostgresStorage;

  const input = (workspaceId: string) => ({
    workspaceId,
    stream: 'encaissement' as const,
    sequence: 1,
    previousHash: H('0'),
    hash: H('a'),
    recordedAt: '2026-11-23T10:00:00.000Z',
    payload: { montantCentimes: 1000 },
  });
  const countOf = async (ws: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM nf525_event WHERE workspace_id = $1`, [ws])).rows[0].n as number;

  beforeAll(async () => {
    const { GenericContainer, Wait } = await import('testcontainers');
    const container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'pw', POSTGRES_USER: 'postgres', POSTGRES_DB: 'nf525' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    const base = `${container.getHost()}:${container.getMappedPort(5432)}/nf525`;
    await migrate({ connectionString: `postgres://postgres:pw@${base}`, log: () => {} });
    const su = new pg.Client({ connectionString: `postgres://postgres:pw@${base}` });
    await su.connect();
    await su.query(`ALTER ROLE nf525_app WITH LOGIN PASSWORD 'apppw'`);
    await su.query(`GRANT USAGE ON SCHEMA public TO nf525_app`);
    await su.end();
    pool = new pg.Pool({ connectionString: `postgres://nf525_app:apppw@${base}` });
    storage = new PostgresStorage(pool);
    stop = async () => {
      await pool.end();
      await container.stop();
    };
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  });

  it('caller rolls back → no row', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const rec = await storage.append(input('ws-rollback'), { client: c });
      expect(rec.sequence).toBe(1);
      const inside = await c.query(`SELECT count(*)::int AS n FROM nf525_event WHERE workspace_id = 'ws-rollback'`);
      expect(inside.rows[0].n).toBe(1);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(await countOf('ws-rollback')).toBe(0);
  });

  it('caller commits → row persists', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await storage.append(input('ws-commit'), { client: c });
      expect(await countOf('ws-commit')).toBe(0); // not visible outside before COMMIT
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(await countOf('ws-commit')).toBe(1);
  });

  it('without a client: unchanged autocommit behaviour', async () => {
    await storage.append(input('ws-auto'));
    expect(await countOf('ws-auto')).toBe(1);
  });
});
