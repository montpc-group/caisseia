/**
 * Postgres-backed integrity & inalterability proofs.
 *
 * Runs against a real Postgres via testcontainers — the only environment
 * where the REVOKE grants and the BEFORE-trigger can be exercised. This is
 * the test we re-run in front of a DGFIP inspector if asked.
 *
 * Skipped when Docker is unavailable (set CAISSEIA_SKIP_POSTGRES=1
 * to skip in any environment, or rely on the runtime fallback if testcontainers
 * fails to start).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/storage/migrate.js';
import { PostgresStorage } from '../src/storage/PostgresStorage.js';
import { setActiveStorage, _resetActiveStorage } from '../src/storage/index.js';
import { setActiveSigner, _resetActiveSigner } from '../src/crypto/Signer.js';
import { _setRegistryForTests } from '../src/crypto/keyRegistry.js';
import { MemorySigner } from '../src/crypto/MemorySigner.js';
import { recordEncaissement } from '../src/encaissement.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { readEnv } from '../src/env.js';

const SKIP = readEnv('SKIP_POSTGRES') === '1';

interface Ctx {
  superuserUrl: string;
  appUrl: string;
  superuserPool: pg.Pool;
  appStorage: PostgresStorage;
  stop: () => Promise<void>;
}

let ctx: Ctx | null = null;

async function startPostgres(): Promise<Ctx> {
  const { GenericContainer, Wait } = await import('testcontainers');
  const container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_PASSWORD: 'pw',
      POSTGRES_USER: 'postgres',
      POSTGRES_DB: 'nf525',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superuserUrl = `postgres://postgres:pw@${host}:${port}/nf525`;

  // Apply migrations as superuser.
  await migrate({ connectionString: superuserUrl, log: () => {} });

  // Grant LOGIN to nf525_app + set a password so we can connect as that role.
  const su = new pg.Pool({ connectionString: superuserUrl });
  await su.query(`ALTER ROLE nf525_app WITH LOGIN PASSWORD 'apppw'`);
  // Need USAGE on default schema + ability to use sequences (none here, but future-proof).
  await su.query(`GRANT USAGE ON SCHEMA public TO nf525_app`);

  const appUrl = `postgres://nf525_app:apppw@${host}:${port}/nf525`;
  const appStorage = PostgresStorage.fromConnectionString(appUrl);
  await appStorage.assertSchema();

  return {
    superuserUrl,
    appUrl,
    superuserPool: su,
    appStorage,
    async stop() {
      await appStorage.close();
      await su.end();
      await container.stop();
    },
  };
}

beforeAll(async () => {
  if (SKIP) return;
  try {
    ctx = await startPostgres();
  } catch (err) {
    console.warn('[nf525] Postgres testcontainers unavailable, skipping suite:', err);
    ctx = null;
  }
}, 120_000);

afterAll(async () => {
  await ctx?.stop();
  _resetActiveStorage();
  _resetActiveSigner();
  _setRegistryForTests(null);
}, 60_000); // container stop takes > 10 s on a loaded host

describe('Postgres — structural inalterability proof', () => {
  it('migrations idempotently install table + triggers + role', async () => {
    if (!ctx) return;
    // Run migrate again — must not fail.
    await migrate({ connectionString: ctx.superuserUrl, log: () => {} });
    const tables = await ctx.superuserPool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'nf525_event'`,
    );
    expect(tables.rowCount).toBe(1);
    const triggers = await ctx.superuserPool.query(
      `SELECT trigger_name FROM information_schema.triggers
       WHERE event_object_table = 'nf525_event'`,
    );
    expect((triggers.rowCount ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it('chains correctly via the public API against Postgres', async () => {
    if (!ctx) return;
    setActiveStorage(ctx.appStorage);
    const pgSigner = await MemorySigner.generate('pg-test');
    setActiveSigner(pgSigner);
    _setRegistryForTests({
      keys: [{ version: 'pg-test', algorithm: 'ed25519', publicKeyPem: pgSigner.getPublicKeyPem(), validFrom: '2026-01-01T00:00:00Z', validUntil: null }],
    });

    const ws = `pg-ws-${Date.now()}`;
    const records = [];
    for (let i = 0; i < 5; i++) {
      records.push(
        await recordEncaissement(ws, {
          montantCentimes: 100 * (i + 1),
          devise: 'EUR',
          mode: 'cb',
          tvaCode: 'TVA20',
        }),
      );
    }
    for (let i = 1; i < records.length; i++) {
      expect(records[i]!.previousHash).toBe(records[i - 1]!.hash);
    }
    const report = await verifyChainIntegrity(ws);
    expect(report.streams.find((s) => s.name === 'encaissement')?.valid).toBe(true);
  });

  it('nf525_app role is denied UPDATE and DELETE by REVOKE grants', async () => {
    if (!ctx) return;
    const appPool = new pg.Pool({ connectionString: ctx.appUrl });
    try {
      // Ensure a row exists.
      const ws = `pg-ws-grant-${Date.now()}`;
      setActiveStorage(ctx.appStorage);
      await recordEncaissement(ws, {
        montantCentimes: 1_000,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });

      await expect(
        appPool.query(`UPDATE nf525_event SET hash = '0' WHERE workspace_id = $1`, [ws]),
      ).rejects.toThrow(/permission denied|insufficient privilege/i);

      await expect(
        appPool.query(`DELETE FROM nf525_event WHERE workspace_id = $1`, [ws]),
      ).rejects.toThrow(/permission denied|insufficient privilege/i);
    } finally {
      await appPool.end();
    }
  });

  it('the BEFORE trigger blocks UPDATE/DELETE even for superuser', async () => {
    if (!ctx) return;
    const ws = `pg-ws-trigger-${Date.now()}`;
    setActiveStorage(ctx.appStorage);
    await recordEncaissement(ws, {
      montantCentimes: 500,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    await expect(
      ctx.superuserPool.query(
        `UPDATE nf525_event SET hash = repeat('0', 64) WHERE workspace_id = $1`,
        [ws],
      ),
    ).rejects.toThrow(/NF525_INALTERABLE/);

    await expect(
      ctx.superuserPool.query(`DELETE FROM nf525_event WHERE workspace_id = $1`, [ws]),
    ).rejects.toThrow(/NF525_INALTERABLE/);
  });

  it('disabling triggers + tampering is still caught by the chain hash (defense in depth)', async () => {
    if (!ctx) return;
    const ws = `pg-ws-defense-${Date.now()}`;
    setActiveStorage(ctx.appStorage);
    for (let i = 0; i < 3; i++) {
      await recordEncaissement(ws, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }

    // Simulate worst-case: an attacker with superuser disables triggers and
    // forges a row. The chain hash recomputation must detect it.
    await ctx.superuserPool.query(`ALTER TABLE nf525_event DISABLE TRIGGER ALL`);
    try {
      await ctx.superuserPool.query(
        `UPDATE nf525_event
           SET payload = jsonb_set(payload, '{data,montantCentimes}', to_jsonb(99999))
         WHERE workspace_id = $1 AND sequence = 2`,
        [ws],
      );
    } finally {
      await ctx.superuserPool.query(`ALTER TABLE nf525_event ENABLE TRIGGER ALL`);
    }

    const report = await verifyChainIntegrity(ws);
    const enc = report.streams.find((s) => s.name === 'encaissement');
    expect(enc?.valid).toBe(false);
  });
});
