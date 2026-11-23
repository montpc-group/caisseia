/**
 * Closures, integrity check and export on the caller's
 * client. The consumer puts FORCE RLS on nf525_event (workspace_id =
 * app.space_id): the SDK's own pool has no GUC and sees no rows, so every
 * read along these paths must run on the caller's client, where the GUC is
 * set — otherwise a closure seals an EMPTY day.
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
import { setActiveSigner, _resetActiveSigner } from '../src/crypto/Signer.js';
import { _setRegistryForTests } from '../src/crypto/keyRegistry.js';
import { MemorySigner } from '../src/crypto/MemorySigner.js';
import { recordEncaissement } from '../src/encaissement.js';
import { closeDay, closeMonth, getCurrentDayClosure } from '../src/closures.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { exportPeriod } from '../src/restitution.js';

const d = process.env['NF525_SKIP_POSTGRES'] === '1' ? describe.skip : describe;

const WS = 'ws-rls';

d('closures / integrity / export on the caller client under FORCE RLS', () => {
  let stop: () => Promise<void>;
  let pool: pg.Pool;

  /** A pool client in an open tx with app.space_id set; release() is counted. */
  async function spaceClient(): Promise<{ c: PoolClient; released: () => number; done: () => void }> {
    const c = await pool.connect();
    const realRelease = c.release.bind(c);
    let n = 0;
    c.release = ((err?: Error | boolean) => {
      n++;
      return realRelease(err);
    }) as PoolClient['release'];
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.space_id', $1, true)`, [WS]);
    return { c, released: () => n, done: () => c.release() };
  }

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
    // A consumer's isolation: FORCE RLS keyed on a session setting.
    await su.query(`ALTER TABLE nf525_event ENABLE ROW LEVEL SECURITY`);
    await su.query(`ALTER TABLE nf525_event FORCE ROW LEVEL SECURITY`);
    await su.query(
      `CREATE POLICY space_isolation ON nf525_event
         USING (workspace_id = current_setting('app.space_id', true))
         WITH CHECK (workspace_id = current_setting('app.space_id', true))`,
    );
    await su.end();
    pool = new pg.Pool({ connectionString: `postgres://nf525_app:apppw@${base}`, max: 10 });
    // The SDK pool: same role, no GUC → sees nothing under the policy.
    const sdkStorage = PostgresStorage.fromConnectionString(`postgres://nf525_app:apppw@${base}`);
    setActiveStorage(sdkStorage);
    const signer = await MemorySigner.generate('rls-v1');
    setActiveSigner(signer);
    _setRegistryForTests({
      keys: [
        {
          version: signer.getKeyVersion(),
          algorithm: 'ed25519',
          publicKeyPem: signer.getPublicKeyPem(),
          validFrom: '2026-01-01T00:00:00Z',
          validUntil: null,
        },
      ],
    });
    stop = async () => {
      _resetActiveStorage();
      _resetActiveSigner();
      _setRegistryForTests(null);
      await sdkStorage.close();
      await pool.end();
      await container.stop();
    };
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  });

  it('closeDay, closeMonth, verifyChainIntegrity and exportPeriod see and seal the real rows', async () => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const t = await spaceClient();
    try {
      await recordEncaissement(WS, { montantCentimes: 1200, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' }, { client: t.c });
      await recordEncaissement(WS, { montantCentimes: 800, devise: 'EUR', mode: 'especes', tvaCode: 'TVA20' }, { client: t.c });

      const day = await closeDay(WS, now, { client: t.c });
      expect(day.aggregate.nbTransactions).toBe(2);
      expect(day.aggregate.caTotalCentimes).toBe(2000);
      expect(day.aggregate.cumulPerpetuel).toBe(2000);
      expect(day.chainHeads?.encaissement.sequence).toBe(2);
      expect((await getCurrentDayClosure(WS, now, { client: t.c }))?._id).toBe(day._id);

      for (let dd = 1; dd <= lastDay; dd++) {
        if (dd === now.getUTCDate()) continue;
        await closeDay(WS, new Date(Date.UTC(year, month - 1, dd)), { client: t.c });
      }
      const m = await closeMonth(WS, year, month, { client: t.c });
      expect(m.aggregate.nbTransactions).toBe(2);
      expect(m.aggregate.caTotalCentimes).toBe(2000);

      const report = await verifyChainIntegrity(WS, { now, client: t.c });
      expect(report.error).toBeUndefined();
      expect(report.valid).toBe(true);
      expect(report.streams.find((s) => s.name === 'encaissement')?.recordsChecked).toBe(2);
      expect(report.streams.find((s) => s.name === 'closure-day')?.recordsChecked).toBe(lastDay);

      const exp = await exportPeriod(
        WS,
        new Date(Date.UTC(year, month - 1, 1)),
        new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
        'json',
        { client: t.c },
      );
      expect(exp.data.encaissements).toHaveLength(2);
      expect(exp.data.closures).toHaveLength(lastDay + 1);

      await t.c.query('COMMIT');
      expect(t.released()).toBe(0);
    } finally {
      t.done();
    }
  });
});
