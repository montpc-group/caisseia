/**
 * recordEncaissement / recordCorrection / logTechnicalEvent with { client }:
 * the whole chain step (read last, hash, insert) and the JET entry run on the
 * caller's connection, inside the caller's transaction. The client is never
 * released by the SDK. Parallel caller transactions serialize per stream:
 * no fork, no duplicate sequence.
 *
 * A container that fails to start FAILS this file (set NF525_SKIP_POSTGRES=1
 * to skip it explicitly).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { migrate } from '../src/storage/migrate.js';
import { PostgresStorage } from '../src/storage/PostgresStorage.js';
import { setActiveStorage, _resetActiveStorage } from '../src/storage/index.js';
import { recordEncaissement } from '../src/encaissement.js';
import { recordCorrection } from '../src/corrections.js';
import { logTechnicalEvent } from '../src/jet.js';
import { read } from '../src/eventStore.js';
import { verifyChain } from '../src/crypto.js';

const d = process.env['NF525_SKIP_POSTGRES'] === '1' ? describe.skip : describe;

const enc = (montantCentimes: number) => ({
  montantCentimes,
  devise: 'EUR' as const,
  mode: 'cb' as const,
  tvaCode: 'TVA20',
});

d('public writers inside a caller transaction', () => {
  let stop: () => Promise<void>;
  let pool: pg.Pool;

  /** A pool client whose release() is counted, so the test proves the SDK never calls it. */
  async function tracked(): Promise<{ c: PoolClient; released: () => number; done: () => void }> {
    const c = await pool.connect();
    const realRelease = c.release.bind(c);
    let n = 0;
    c.release = ((err?: Error | boolean) => {
      n++;
      return realRelease(err);
    }) as PoolClient['release'];
    return { c, released: () => n, done: () => c.release() };
  }

  const count = async (ws: string, stream: string) =>
    (
      await pool.query(`SELECT count(*)::int AS n FROM nf525_event WHERE workspace_id = $1 AND stream = $2`, [
        ws,
        stream,
      ])
    ).rows[0].n as number;

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
    pool = new pg.Pool({ connectionString: `postgres://nf525_app:apppw@${base}`, max: 10 });
    // The SDK's own storage gets a separate pool: a write on it would land outside the caller tx.
    const sdkStorage = PostgresStorage.fromConnectionString(`postgres://nf525_app:apppw@${base}`);
    setActiveStorage(sdkStorage);
    stop = async () => {
      _resetActiveStorage();
      await sdkStorage.close();
      await pool.end();
      await container.stop();
    };
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  });

  it('rollback → neither the encaissement nor its JET entry exists; client not released', async () => {
    const t = await tracked();
    try {
      await t.c.query('BEGIN');
      const e = await recordEncaissement('ws-rb', enc(1000), { client: t.c });
      expect(e.sequence).toBe(1);
      await t.c.query('ROLLBACK');
      expect(t.released()).toBe(0);
    } finally {
      t.done();
    }
    expect(await count('ws-rb', 'encaissement')).toBe(0);
    expect(await count('ws-rb', 'jet')).toBe(0);
  });

  it('commit → encaissement, correction and JET commit together; client not released', async () => {
    const t = await tracked();
    try {
      await t.c.query('BEGIN');
      const e = await recordEncaissement('ws-ok', enc(5000), { client: t.c });
      // The correction finds its original through the caller's client (not yet committed).
      await recordCorrection(
        'ws-ok',
        { originalId: e._id, montantCentimes: -1000, devise: 'EUR', type: 'remboursement_partiel', reason: 'Retour' },
        { client: t.c },
      );
      await logTechnicalEvent('ws-ok', 'user_login', { via: 'test' }, {}, { client: t.c });
      expect(await count('ws-ok', 'encaissement')).toBe(0); // invisible outside before COMMIT
      await t.c.query('COMMIT');
      expect(t.released()).toBe(0);
    } finally {
      t.done();
    }
    expect(await count('ws-ok', 'encaissement')).toBe(2);
    expect(await count('ws-ok', 'jet')).toBe(3);
  });

  it('two caller transactions in parallel serialize: contiguous sequences, one unbroken chain', async () => {
    const ws = 'ws-race';
    const a = await tracked();
    const b = await tracked();
    try {
      await a.c.query('BEGIN');
      await b.c.query('BEGIN');
      const [ea, eb] = await Promise.all([
        recordEncaissement(ws, enc(100), { client: a.c }).then(async (r) => {
          await a.c.query('COMMIT');
          return r;
        }),
        recordEncaissement(ws, enc(200), { client: b.c }).then(async (r) => {
          await b.c.query('COMMIT');
          return r;
        }),
      ]);
      expect([ea.sequence, eb.sequence].sort()).toEqual([1, 2]);
      expect(a.released() + b.released()).toBe(0);
    } finally {
      a.done();
      b.done();
    }
    for (const stream of ['encaissement', 'jet'] as const) {
      const chain = await read(stream, ws);
      expect(chain.map((r) => r.sequence)).toEqual([1, 2]);
      expect(chain[1]!.previousHash).toBe(chain[0]!.hash);
      expect(verifyChain(chain).valid).toBe(true);
    }
  });
});
