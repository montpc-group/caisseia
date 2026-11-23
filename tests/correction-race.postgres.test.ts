/**
 * recordCorrection serializes the net check per (workspace, encaissement
 * stream): two parallel corrections whose sum exceeds the net → exactly one
 * passes and the net never goes below 0 — with caller clients (caller txs)
 * and without (the SDK opens its own transaction).
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
import { recordCorrection, getNetAmount } from '../src/corrections.js';
import { read } from '../src/eventStore.js';
import { verifyChain, hash, canonicalize } from '../src/crypto.js';
import type { AppendInput, TxOptions } from '../src/storage/EventStorage.js';
import type { EventRecord } from '../src/eventStore.js';

/**
 * Before the first correction insert, an encaissement written WITHOUT the
 * stream lock (no caller client, own pool connection, autocommit) takes the
 * same sequence: the correction insert then hits the unique conflict.
 */
class UnlockedWriterBetween extends PostgresStorage {
  private fired = false;
  constructor(private readonly other: PostgresStorage, pool: pg.Pool) {
    super(pool);
  }
  override async append<T>(input: AppendInput<T>, opts?: TxOptions): Promise<EventRecord<T>> {
    const p = input.payload as { type?: string };
    if (!this.fired && input.stream === 'encaissement' && p.type === 'correction') {
      this.fired = true;
      const payload = { type: 'encaissement', data: { montantCentimes: 50, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' } };
      const skeleton = {
        _id: `${input.workspaceId}:${input.stream}:${input.sequence.toString().padStart(12, '0')}`,
        stream: input.stream, sequence: input.sequence, workspaceId: input.workspaceId,
        previousHash: input.previousHash, recordedAt: input.recordedAt, payload,
      };
      await this.other.append({ ...input, payload, hash: hash(canonicalize(skeleton)) });
    }
    return super.append(input, opts);
  }
}

const d = process.env['NF525_SKIP_POSTGRES'] === '1' ? describe.skip : describe;

const refund = (originalId: string, reason: string) => ({
  originalId, montantCentimes: -700, devise: 'EUR' as const, type: 'remboursement_partiel' as const, reason,
});

d('recordCorrection — parallel corrections (Postgres)', () => {
  let stop: () => Promise<void>;
  let pool: pg.Pool;
  let appUrl: string;

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
    appUrl = `postgres://nf525_app:apppw@${base}`;
    pool = new pg.Pool({ connectionString: appUrl, max: 10 });
    const sdkStorage = PostgresStorage.fromConnectionString(`postgres://nf525_app:apppw@${base}`);
    setActiveStorage(sdkStorage);
    stop = async () => {
      _resetActiveStorage();
      await sdkStorage.close();
      await cleanup();
      await pool.end();
      await container.stop();
    };
  }, 120_000);

  let cleanup = async () => {};

  afterAll(async () => {
    await stop?.();
  });

  async function expectOneOfTwo(results: PromiseSettledResult<unknown>[], ws: string, originalId: string) {
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/NF525_CORRECTION: cumulative corrections would bring net amount negative/);
    expect(await getNetAmount(ws, originalId)).toBe(300);
    for (const stream of ['encaissement', 'jet'] as const) {
      expect(verifyChain(await read(stream, ws)).valid).toBe(true);
    }
  }

  it('without a client: the SDK serializes both corrections in its own transactions', async () => {
    // Ten rounds: on the unlocked code the interleaving is timing-dependent.
    for (let round = 0; round < 10; round++) {
      const ws = `ws-race-sdk-${round}`;
      const e = await recordEncaissement(ws, { montantCentimes: 1000, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
      const results = await Promise.allSettled([
        recordCorrection(ws, refund(e._id, 'Retour A')),
        recordCorrection(ws, refund(e._id, 'Retour B')),
      ]);
      await expectOneOfTwo(results, ws, e._id);
      expect((await read('encaissement', ws)).length).toBe(2);
    }
  });

  it('with caller clients: the second tx waits for the first commit, then sees its correction', async () => {
    const ws = 'ws-race-caller';
    const e = await recordEncaissement(ws, { montantCentimes: 1000, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    const inTx = async (reason: string) => {
      const c: PoolClient = await pool.connect();
      try {
        await c.query('BEGIN');
        try {
          const r = await recordCorrection(ws, refund(e._id, reason), { client: c });
          await c.query('COMMIT');
          return r;
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
      } finally {
        c.release();
      }
    };
    const results = await Promise.allSettled([inTx('Retour A'), inTx('Retour B')]);
    await expectOneOfTwo(results, ws, e._id);
  });

  it('without a client: a conflict with an unlocked writer retries the whole check, net re-read', async () => {
    const ws = 'ws-race-unlocked';
    const e = await recordEncaissement(ws, { montantCentimes: 1000, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    const other = PostgresStorage.fromConnectionString(appUrl);
    const interfering = new UnlockedWriterBetween(other, new pg.Pool({ connectionString: appUrl, max: 2 }));
    const previous = await import('../src/storage/index.js').then((m) => m.getActiveStorage());
    setActiveStorage(interfering);
    cleanup = async () => {
      await interfering.close();
      await other.close();
    };
    try {
      const c = await recordCorrection(ws, refund(e._id, 'Retour C'));
      expect(c.sequence).toBe(3);
    } finally {
      setActiveStorage(previous);
    }
    expect(await getNetAmount(ws, e._id)).toBe(300);
    expect(verifyChain(await read('encaissement', ws)).valid).toBe(true);
    expect(verifyChain(await read('jet', ws)).valid).toBe(true);
  });
});
