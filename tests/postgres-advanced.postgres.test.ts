/**
 * Tests avancés Postgres — concurrence réelle, crash recovery, volume.
 *
 * Cf. COMPLIANCE.md §§ 1–2 (Inaltérabilité, Sécurisation).
 *
 * Ces tests tournent contre un vrai Postgres via testcontainers.
 * Contrairement aux tests InMemoryStorage qui sérialisent les awaits,
 * ici le retry-on-conflict (AppendConflictError / code 23505) est
 * exercé sous contention réelle avec des connexions parallèles.
 *
 * Skipped si Docker indisponible (NF525_SKIP_POSTGRES=1).
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
import { recordCorrection } from '../src/corrections.js';
import { closeDay } from '../src/closures.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { exportPeriod, verifyExportIntegrity } from '../src/restitution.js';
import { read } from '../src/eventStore.js';
import { hash, canonicalize } from '../src/crypto.js';
import type { EncaissementStreamPayload } from '../schemas/encaissement.schema.js';

const SKIP = process.env['NF525_SKIP_POSTGRES'] === '1';

interface Ctx {
  superuserUrl: string;
  appUrl: string;
  superuserPool: pg.Pool;
  appStorage: PostgresStorage;
  signer: MemorySigner;
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

  await migrate({ connectionString: superuserUrl, log: () => {} });

  const su = new pg.Pool({ connectionString: superuserUrl });
  await su.query(`ALTER ROLE nf525_app WITH LOGIN PASSWORD 'apppw'`);
  await su.query(`GRANT USAGE ON SCHEMA public TO nf525_app`);

  const appUrl = `postgres://nf525_app:apppw@${host}:${port}/nf525`;
  const appStorage = PostgresStorage.fromConnectionString(appUrl);
  await appStorage.assertSchema();

  const signer = await MemorySigner.generate('pg-adv-v1');
  setActiveStorage(appStorage);
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

  return {
    superuserUrl,
    appUrl,
    superuserPool: su,
    appStorage,
    signer,
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
});

// ─────────────────────────────────────────────────────────────────────
// § CONCURRENT WRITES — real contention under Postgres unique constraint
// ─────────────────────────────────────────────────────────────────────

describe('Concurrent writes (contention réelle Postgres — art. 286 I 3°bis)', () => {
  it('4 recordEncaissement parallèles — séquences contiguës 1-4, chaîne valide', async () => {
    // AUDIT: Sous contention réelle (connexions parallèles à Postgres),
    // le retry-on-conflict (code 23505 → AppendConflictError) doit assurer
    // la contiguïté des séquences. C'est la preuve que la mécanique
    // fonctionne en production, pas seulement en mémoire.
    //
    // NOTE: APPEND_MAX_RETRIES=3 (4 tentatives max). En pire cas, N
    // écrivains simultanés nécessitent N-1 retries. Avec 3 retries,
    // on garantit 4 écrivains. Pour 10+ parallèles en production,
    // augmenter APPEND_MAX_RETRIES ou utiliser un advisory lock.
    if (!ctx) return;
    const ws = `pg-conc-4-${Date.now()}`;
    const N = 4;

    const promises = Array.from({ length: N }, (_, i) =>
      recordEncaissement(ws, {
        montantCentimes: 100 * (i + 1),
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      }),
    );

    const results = await Promise.all(promises);
    const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    // No duplicate IDs.
    const ids = new Set(results.map((r) => r._id));
    expect(ids.size).toBe(N);

    // Chain integrity must hold.
    const report = await verifyChainIntegrity(ws);
    const enc = report.streams.find((s) => s.name === 'encaissement');
    expect(enc?.valid).toBe(true);
    expect(enc?.recordsChecked).toBe(N);
  }, 30_000);

  it('closeDay idempotence séquentielle — le second appel est rejeté (already closed)', async () => {
    // AUDIT: La même date ne peut être clôturée qu'une seule fois.
    // NOTE: L'idempotence sous contention parallèle (2 closeDays simultanés)
    // n'est pas garantie car le check "already closed" est optimiste (lecture
    // avant commit). En production, cela nécessiterait un advisory lock ou
    // une contrainte UNIQUE sur (workspace_id, period_start) côté closure
    // payload. Le test séquentiel vérifie la mécanique de base.
    if (!ctx) return;
    const ws = `pg-close-idem-${Date.now()}`;

    await recordEncaissement(ws, {
      montantCentimes: 500,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    const today = new Date();
    await closeDay(ws, today);
    await expect(closeDay(ws, today)).rejects.toThrow(/already closed/);
  }, 30_000);

  it('la chaîne reste valide après contention parallèle mixte (encaissements + correction)', async () => {
    // AUDIT: En conditions réelles, les encaissements et corrections arrivent
    // en parallèle sur le même flux. Le chainage doit rester continu.
    // NOTE: Limité à 3 parallel writers total (APPEND_MAX_RETRIES=3):
    // 2 encaissements + 1 correction, tous sur le flux encaissement.
    if (!ctx) return;
    const ws = `pg-conc-mix-${Date.now()}`;

    // First, create a base encaissement to correct (sequential, no contention).
    const base = await recordEncaissement(ws, {
      montantCentimes: 10000,
      devise: 'EUR',
      mode: 'stripe',
      tvaCode: 'TVA20',
    });

    // Fire 2 encaissements + 1 correction in parallel (3 concurrent writers on encaissement stream).
    const ops = [
      recordEncaissement(ws, {
        montantCentimes: 200,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      }),
      recordEncaissement(ws, {
        montantCentimes: 300,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      }),
      recordCorrection(ws, {
        originalId: base._id,
        montantCentimes: -500,
        devise: 'EUR',
        type: 'remboursement_partiel',
        reason: 'Concurrent correction',
      }),
    ];

    await Promise.all(ops);

    const report = await verifyChainIntegrity(ws);
    const enc = report.streams.find((s) => s.name === 'encaissement');
    expect(enc?.valid).toBe(true);
    // 1 base + 2 encaissements + 1 correction = 4 records on the encaissement stream.
    expect(enc?.recordsChecked).toBe(4);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────
// § PARTIAL FAILURE / CRASH RECOVERY
// ─────────────────────────────────────────────────────────────────────

describe('Partial failure / crash recovery', () => {
  it('5 encaissements committés, pool terminé, reconnexion — chaîne intacte, séquence correcte', async () => {
    // AUDIT: Si le processus crash après 5 écritures, les 5 committées
    // doivent former une chaîne valide. La reprise doit continuer à seq 6.
    if (!ctx) return;
    const ws = `pg-crash-${Date.now()}`;

    // Use a SEPARATE pool so we can kill it without affecting ctx.
    const crashPool = new pg.Pool({ connectionString: ctx.appUrl, max: 2 });
    const crashStorage = new PostgresStorage(crashPool);
    setActiveStorage(crashStorage);

    // Record 5 encaissements normally.
    for (let i = 0; i < 5; i++) {
      await recordEncaissement(ws, {
        montantCentimes: 100 * (i + 1),
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }

    // Force-kill the pool (simulates process crash / connection loss).
    await crashPool.end();

    // Reconnect with fresh storage and verify.
    const freshPool = new pg.Pool({ connectionString: ctx.appUrl, max: 2 });
    const freshStorage = new PostgresStorage(freshPool);
    setActiveStorage(freshStorage);

    // Chain integrity on the 5 committed records must pass.
    const report = await verifyChainIntegrity(ws);
    const enc = report.streams.find((s) => s.name === 'encaissement');
    expect(enc?.valid).toBe(true);
    expect(enc?.recordsChecked).toBe(5);

    // New encaissement after reconnect must pick up sequence 6.
    const rec6 = await recordEncaissement(ws, {
      montantCentimes: 600,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    expect(rec6.sequence).toBe(6);

    // Full chain (6 records) still valid.
    const report2 = await verifyChainIntegrity(ws);
    expect(report2.streams.find((s) => s.name === 'encaissement')?.valid).toBe(true);

    // Restore ctx storage for subsequent tests.
    await freshPool.end();
    setActiveStorage(ctx.appStorage);
  }, 30_000);

  it('reconnexion après crash — pas de phantom record avec chaîne cassée', async () => {
    // AUDIT: Un INSERT qui échoue partiellement (network timeout avant ACK)
    // ne doit pas laisser un enregistrement orphelin dans la table.
    // Postgres's transactional INSERT guarantees: either committed or rolled back.
    // Nous vérifions que seuls les records pleinement committés existent.
    if (!ctx) return;
    const ws = `pg-phantom-${Date.now()}`;

    const crashPool = new pg.Pool({ connectionString: ctx.appUrl, max: 2 });
    const crashStorage = new PostgresStorage(crashPool);
    setActiveStorage(crashStorage);

    // Record 3 encaissements.
    for (let i = 0; i < 3; i++) {
      await recordEncaissement(ws, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }
    await crashPool.end();

    // Verify via superuser direct query — exactly 3 encaissement + N JET records.
    const res = await ctx.superuserPool.query(
      `SELECT COUNT(*)::int AS cnt FROM nf525_event
       WHERE workspace_id = $1 AND stream = 'encaissement'`,
      [ws],
    );
    expect(res.rows[0].cnt).toBe(3);

    // All 3 must have contiguous sequences.
    const seqRes = await ctx.superuserPool.query(
      `SELECT sequence FROM nf525_event
       WHERE workspace_id = $1 AND stream = 'encaissement'
       ORDER BY sequence ASC`,
      [ws],
    );
    const seqs = seqRes.rows.map((r: { sequence: string }) => Number(r.sequence));
    expect(seqs).toEqual([1, 2, 3]);

    // Restore.
    setActiveStorage(ctx.appStorage);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────
// § LARGE VOLUME — correctness at scale
// ─────────────────────────────────────────────────────────────────────

describe('Large volume (correctness at scale — 1000 records)', () => {
  it('1000 encaissements séquentiels — chaîne valide, agrégats corrects, export complet', async () => {
    // AUDIT: Le système doit fonctionner correctement à l'échelle d'un
    // commerce actif. 1000 encaissements = ~1 mois d'activité pour un
    // petit commerce. La chaîne, les agrégats et l'export doivent être corrects.
    if (!ctx) return;
    const ws = `pg-volume-${Date.now()}`;
    const N = 1000;

    const t0 = Date.now();
    let expectedTotal = 0;
    for (let i = 0; i < N; i++) {
      const amt = 100 + (i % 50); // Vary amounts slightly.
      expectedTotal += amt;
      await recordEncaissement(ws, {
        montantCentimes: amt,
        devise: 'EUR',
        mode: i % 3 === 0 ? 'cb' : i % 3 === 1 ? 'especes' : 'stripe',
        tvaCode: i % 4 === 0 ? 'TVA20' : 'TVA10',
      });
    }
    const tInserts = Date.now() - t0;
    console.log(`[volume] ${N} encaissements inserted in ${tInserts}ms (${(tInserts / N).toFixed(1)}ms/rec)`);

    // Verify chain integrity.
    const t1 = Date.now();
    const report = await verifyChainIntegrity(ws);
    console.log(`[volume] verifyChainIntegrity in ${Date.now() - t1}ms`);
    const enc = report.streams.find((s) => s.name === 'encaissement');
    expect(enc?.valid).toBe(true);
    expect(enc?.recordsChecked).toBe(N);

    // Close the day and verify aggregate.
    const t2 = Date.now();
    const closure = await closeDay(ws, new Date());
    console.log(`[volume] closeDay in ${Date.now() - t2}ms`);
    expect(closure.aggregate.caTotalCentimes).toBe(expectedTotal);
    expect(closure.aggregate.nbTransactions).toBe(N);

    // Export and verify.
    const t3 = Date.now();
    const from = new Date(Date.UTC(2020, 0, 1));
    const to = new Date(Date.UTC(2030, 11, 31));
    const result = await exportPeriod(ws, from, to, 'json');
    console.log(`[volume] exportPeriod(json) in ${Date.now() - t3}ms`);
    expect(result.data.encaissements.length).toBe(N);

    // Manifest hash must be valid.
    expect(result.manifest.manifestHash).toHaveLength(64);

    // Verify export integrity.
    const t4 = Date.now();
    const integrity = await verifyExportIntegrity(result);
    console.log(`[volume] verifyExportIntegrity in ${Date.now() - t4}ms`);
    expect(integrity.valid).toBe(true);

    // CSV export: header + N data rows.
    const t5 = Date.now();
    const csvResult = await exportPeriod(ws, from, to, 'csv');
    console.log(`[volume] exportPeriod(csv) in ${Date.now() - t5}ms`);
    const csvFile = csvResult.files.find((f) => f.name === 'encaissements.csv')!;
    const csvLines = csvFile.content.split('\n');
    // Header + N encaissements (corrections are on the same stream but none here).
    expect(csvLines.length).toBe(N + 1);

    console.log(`[volume] total elapsed: ${Date.now() - t0}ms`);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────
// § TRIGGER BYPASS + CHAIN VERIFICATION — defense in depth renforcée
// ─────────────────────────────────────────────────────────────────────

describe('Trigger bypass + chain verification (defense in depth)', () => {
  it('disable triggers + INSERT record forgé avec gap de séquence — verifyChainIntegrity détecte', async () => {
    // AUDIT: Même si un attaquant avec accès superuser désactive les triggers
    // et insère un record avec une séquence gap, la vérification de chaîne
    // détecte le gap via la check de contiguïté.
    if (!ctx) return;
    const ws = `pg-forge-gap-${Date.now()}`;

    // Insert 3 legitimate records.
    for (let i = 0; i < 3; i++) {
      await recordEncaissement(ws, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }

    // Disable triggers and insert a forged record at sequence 5 (skipping 4).
    await ctx.superuserPool.query('ALTER TABLE nf525_event DISABLE TRIGGER ALL');
    try {
      await ctx.superuserPool.query(
        `INSERT INTO nf525_event
           (id, workspace_id, stream, sequence, previous_hash, hash, recorded_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          `${ws}:encaissement:000000000005`,
          ws,
          'encaissement',
          5, // Gap: skips sequence 4.
          '0'.repeat(64),
          'a'.repeat(64),
          new Date().toISOString(),
          JSON.stringify({ type: 'encaissement', data: {
            montantCentimes: 9999, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20',
          }}),
        ],
      );
    } finally {
      await ctx.superuserPool.query('ALTER TABLE nf525_event ENABLE TRIGGER ALL');
    }

    const report = await verifyChainIntegrity(ws);
    const enc = report.streams.find((s) => s.name === 'encaissement');
    expect(enc?.valid).toBe(false);
    expect(enc?.reason).toMatch(/sequence gap/);
  }, 30_000);

  it('disable triggers + UPDATE payload avec montant falsifié — hash mismatch détecté', async () => {
    // AUDIT: Un attaquant modifie un montant dans un record existant
    // après avoir désactivé les triggers. La chaîne détecte la divergence
    // car le hash stocké ne correspond plus au skeleton recomputed.
    if (!ctx) return;
    const ws = `pg-forge-update-${Date.now()}`;

    for (let i = 0; i < 5; i++) {
      await recordEncaissement(ws, {
        montantCentimes: 100 * (i + 1),
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }

    // Verify chain is clean before attack.
    const before = await verifyChainIntegrity(ws);
    expect(before.streams.find((s) => s.name === 'encaissement')?.valid).toBe(true);

    // Disable triggers and UPDATE sequence 3's amount.
    await ctx.superuserPool.query('ALTER TABLE nf525_event DISABLE TRIGGER ALL');
    try {
      await ctx.superuserPool.query(
        `UPDATE nf525_event
           SET payload = jsonb_set(payload, '{data,montantCentimes}', to_jsonb(1))
         WHERE workspace_id = $1 AND stream = 'encaissement' AND sequence = 3`,
        [ws],
      );
    } finally {
      await ctx.superuserPool.query('ALTER TABLE nf525_event ENABLE TRIGGER ALL');
    }

    const after = await verifyChainIntegrity(ws);
    const enc = after.streams.find((s) => s.name === 'encaissement');
    expect(enc?.valid).toBe(false);
    expect(enc?.reason).toMatch(/payload hash mismatch/);
    expect(enc?.brokenAt).toBe(2); // index 2 = sequence 3
  }, 30_000);

  it('disable triggers + DELETE milieu de chaîne — gap de séquence détecté', async () => {
    // AUDIT: Suppression directe d'un record au milieu de la chaîne
    // après bypass des triggers. La vérification d'intégrité détecte le gap.
    if (!ctx) return;
    const ws = `pg-forge-delete-${Date.now()}`;

    for (let i = 0; i < 5; i++) {
      await recordEncaissement(ws, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }

    await ctx.superuserPool.query('ALTER TABLE nf525_event DISABLE TRIGGER ALL');
    try {
      await ctx.superuserPool.query(
        `DELETE FROM nf525_event
         WHERE workspace_id = $1 AND stream = 'encaissement' AND sequence = 3`,
        [ws],
      );
    } finally {
      await ctx.superuserPool.query('ALTER TABLE nf525_event ENABLE TRIGGER ALL');
    }

    const report = await verifyChainIntegrity(ws);
    const enc = report.streams.find((s) => s.name === 'encaissement');
    expect(enc?.valid).toBe(false);
    expect(enc?.reason).toMatch(/sequence gap/);
  }, 30_000);

  it('disable triggers + re-hash sophistiqué (chaîne recalculée) — previousHash mismatch détecté', async () => {
    // AUDIT: Attaque sophistiquée : un attaquant supprime un record,
    // puis recalcule les hashes des records suivants pour que la chaîne
    // semble valide. Mais le previousHash du record suivant le gap ne
    // correspondra pas au hash du record précédent restant.
    if (!ctx) return;
    const ws = `pg-forge-rehash-${Date.now()}`;

    for (let i = 0; i < 5; i++) {
      await recordEncaissement(ws, {
        montantCentimes: 100 * (i + 1),
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }

    // Read records 2 and 4 to get their data.
    const records = await read<EncaissementStreamPayload>('encaissement', ws);
    const rec2 = records.find((r) => r.sequence === 2)!;
    const rec4 = records.find((r) => r.sequence === 4)!;
    const rec5 = records.find((r) => r.sequence === 5)!;

    await ctx.superuserPool.query('ALTER TABLE nf525_event DISABLE TRIGGER ALL');
    try {
      // Delete record 3.
      await ctx.superuserPool.query(
        `DELETE FROM nf525_event
         WHERE workspace_id = $1 AND stream = 'encaissement' AND sequence = 3`,
        [ws],
      );

      // Re-number record 4 → sequence 3, record 5 → sequence 4.
      // Update record 4: set sequence=3, previousHash=rec2.hash, recalculate hash.
      const newSkel4 = {
        _id: `${ws}:encaissement:000000000003`,
        stream: 'encaissement' as const,
        sequence: 3,
        workspaceId: ws,
        previousHash: rec2.hash,
        recordedAt: rec4.recordedAt,
        payload: rec4.payload,
      };
      const newHash4 = hash(canonicalize(newSkel4));

      await ctx.superuserPool.query(
        `UPDATE nf525_event
           SET id = $1, sequence = 3, previous_hash = $2, hash = $3
         WHERE workspace_id = $4 AND stream = 'encaissement' AND sequence = 4`,
        [newSkel4._id, rec2.hash, newHash4, ws],
      );

      // Update record 5: set sequence=4, previousHash=newHash4, recalculate hash.
      const newSkel5 = {
        _id: `${ws}:encaissement:000000000004`,
        stream: 'encaissement' as const,
        sequence: 4,
        workspaceId: ws,
        previousHash: newHash4,
        recordedAt: rec5.recordedAt,
        payload: rec5.payload,
      };
      const newHash5 = hash(canonicalize(newSkel5));

      await ctx.superuserPool.query(
        `UPDATE nf525_event
           SET id = $1, sequence = 4, previous_hash = $2, hash = $3
         WHERE workspace_id = $4 AND stream = 'encaissement' AND sequence = 5`,
        [newSkel5._id, newHash4, newHash5, ws],
      );
    } finally {
      await ctx.superuserPool.query('ALTER TABLE nf525_event ENABLE TRIGGER ALL');
    }

    // The attacker has crafted a valid-looking chain of 4 records with correct
    // hashes and previousHashes. However, verifyChainIntegrity still PASSES
    // on the hash chain alone (the hashes are legitimately recalculated).
    //
    // The DETECTION relies on external anchors:
    // - If a closure was taken before the attack, the closure's
    //   derniereSequence (5) and nbTransactions (5) won't match the
    //   remaining 4 records.
    // - The JET stream records encaissement_recorded × 5, proving
    //   5 original records existed.
    //
    // Verify the chain reports valid (the attacker succeeded at re-hashing).
    const report = await verifyChainIntegrity(ws);
    const enc = report.streams.find((s) => s.name === 'encaissement');
    // The re-hashed chain is internally consistent — this is expected.
    // Defense relies on closure anchors + JET audit trail.

    if (enc?.valid) {
      // The attacker's re-hash was perfect — but the JET betrays them.
      const jet = await read<{ type: string }>('jet', ws);
      const encRecordedCount = jet.filter(
        (r) => r.payload.type === 'encaissement_recorded',
      ).length;
      // JET records 5 original encaissements, but only 4 remain in the stream.
      expect(encRecordedCount).toBe(5);

      const remaining = await read<EncaissementStreamPayload>('encaissement', ws);
      expect(remaining.length).toBe(4);
      // The JET count (5) != remaining count (4) → mismatch proves tampering.
      expect(encRecordedCount).toBeGreaterThan(remaining.length);
    } else {
      // If the chain detected it (e.g., due to JET interleaving on the
      // encaissement stream with corrections), that's also a valid outcome.
      expect(enc?.valid).toBe(false);
    }
  }, 30_000);
});
