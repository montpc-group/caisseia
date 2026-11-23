/**
 * closeDay vs a payment in flight (caller transactions, Postgres): the payment
 * is counted in the sealed day or lands after it, never inside an
 * already-sealed day. closeDay takes the encaissement stream lock before it
 * reads the day, and a day closed before its calendar end ends at the closing
 * instant.
 *
 * A container that fails to start FAILS this file (set CAISSEIA_SKIP_POSTGRES=1
 * to skip it explicitly).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { migrate } from '../src/storage/migrate.js';
import { PostgresStorage } from '../src/storage/PostgresStorage.js';
import { setActiveStorage, _resetActiveStorage } from '../src/storage/index.js';
import { setActiveSigner } from '../src/crypto/Signer.js';
import { MemorySigner } from '../src/crypto/MemorySigner.js';
import { recordEncaissement } from '../src/encaissement.js';
import { append } from '../src/eventStore.js';
import { closeDay } from '../src/closures.js';
import { readEnv } from '../src/env.js';

const d = readEnv('SKIP_POSTGRES') === '1' ? describe.skip : describe;

const PAY = { montantCentimes: 1200, devise: 'EUR' as const, mode: 'cb' as const, tvaCode: 'TVA20' };

d('closeDay vs an in-flight payment (Postgres)', () => {
  let stop: () => Promise<void>;
  let pool: pg.Pool;

  beforeAll(async () => {
    setActiveSigner(await MemorySigner.generate());
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

  async function begin(): Promise<PoolClient> {
    const c = await pool.connect();
    await c.query('BEGIN');
    return c;
  }
  async function end(c: PoolClient, op: 'COMMIT' | 'ROLLBACK' = 'COMMIT'): Promise<void> {
    try {
      await c.query(op);
    } finally {
      c.release();
    }
  }
  const settledWithin = (p: Promise<unknown>, ms: number) =>
    Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))]);

  it('a payment appended but not committed: closeDay waits for it, then counts it', async () => {
    const ws = 'ws-inflight-before';
    await recordEncaissement(ws, PAY);
    // Only the encaissement row (no JET entry): the wait must come from the
    // encaissement lock itself, not from the JET lock a payment also holds.
    const payTx = await begin();
    await append('encaissement', ws, { type: 'encaissement', data: { ...PAY, montantCentimes: 3300 } }, { client: payTx });

    const closeTx = await begin();
    const closing = closeDay(ws, new Date(), { client: closeTx });
    expect(await settledWithin(closing, 1500)).toBe(false);

    await end(payTx);
    const closure = await closing;
    await end(closeTx);
    expect(closure.aggregate.nbTransactions).toBe(2);
    expect(closure.aggregate.caTotalCentimes).toBe(4500);
  });

  it('a payment started while closeDay holds the lock lands after the sealed day', async () => {
    const ws = 'ws-inflight-after';
    await recordEncaissement(ws, PAY);

    const closeTx = await begin();
    const closure = await closeDay(ws, new Date(), { client: closeTx });

    const payTx = await begin();
    const paying = recordEncaissement(ws, { ...PAY, montantCentimes: 700 }, { client: payTx });
    expect(await settledWithin(paying, 1500)).toBe(false);

    await end(closeTx);
    const late = await paying;
    await end(payTx);

    expect(closure.aggregate.nbTransactions).toBe(1);
    expect(Date.parse(late.recordedAt)).toBeGreaterThan(Date.parse(closure.periodEnd));
  });

  it('a day that has not started cannot be sealed', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000);
    await expect(closeDay('ws-future', tomorrow)).rejects.toThrow(/NF525_CLOSURE: .*not started/);
  });
});
