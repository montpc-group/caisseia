/**
 * Tests de preuve — Chainage cryptographique.
 *
 * Cf. COMPLIANCE.md § 2 (Sécurisation).
 *
 * Run against InMemoryStorage. The same suite is replayed against a real
 * Postgres in chainage.postgres.test.ts to prove the chain holds with the
 * actual REVOKE + trigger constraints in play.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { canonicalize, hash, GENESIS_HASH, verifyChain } from '../src/crypto.js';
import { recordEncaissement } from '../src/encaissement.js';
import { logTechnicalEvent } from '../src/jet.js';
import { read } from '../src/eventStore.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { freshHarness, type Harness } from './_helpers.js';

describe('Chainage cryptographique', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('la canonicalisation est déterministe (mêmes données → même chaîne)', () => {
    const a = canonicalize({ b: 1, a: 2, c: 3 });
    const b = canonicalize({ a: 2, c: 3, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('le premier enregistrement de chaque flux a previousHash = GENESIS_HASH', async () => {
    const e = await recordEncaissement(h.workspace, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    expect(e.previousHash).toBe(GENESIS_HASH);
    expect(e.previousHash).toBe('0'.repeat(64));
  });

  it('chaque enregistrement référence correctement le hash du précédent', async () => {
    const records = [];
    for (let i = 0; i < 5; i++) {
      records.push(
        await recordEncaissement(h.workspace, {
          montantCentimes: 100 + i,
          devise: 'EUR',
          mode: 'cb',
          tvaCode: 'TVA20',
        }),
      );
    }
    for (let i = 1; i < records.length; i++) {
      expect(records[i]!.previousHash).toBe(records[i - 1]!.hash);
    }
  });

  it('le hash propre est calculé sur previousHash + payload canonicalisé', async () => {
    const e = await recordEncaissement(h.workspace, {
      montantCentimes: 1500,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    // Reconstruct exactly what eventStore.append hashed.
    const skeleton = {
      _id: e._id,
      stream: 'encaissement' as const,
      sequence: e.sequence,
      workspaceId: e.workspaceId,
      previousHash: e.previousHash,
      recordedAt: e.recordedAt,
      payload: { type: 'encaissement', data: e.data },
    };
    expect(hash(canonicalize(skeleton))).toBe(e.hash);
  });

  it('la modification du payload après écriture casse la chaîne', async () => {
    const records = [];
    for (let i = 0; i < 3; i++) {
      records.push(
        await recordEncaissement(h.workspace, {
          montantCentimes: 100,
          devise: 'EUR',
          mode: 'cb',
          tvaCode: 'TVA20',
        }),
      );
    }

    // Force-tamper sequence #2 — bypass inalterability to simulate a malicious
    // actor with raw DB access. verifyChainIntegrity must catch the divergence.
    h.storage._forceTamper(h.workspace, 'encaissement', 2, (row) => {
      const payload = row['payload'] as { type: string; data: { montantCentimes: number } };
      payload.data.montantCentimes = 999;
    });

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    const stream = report.streams.find((s) => s.name === 'encaissement');
    expect(stream?.valid).toBe(false);
    expect(stream?.brokenAt).toBe(1); // index 1 = sequence 2
  });

  it('le chainage est strict : un gap de séquence invalide la chaîne', async () => {
    for (let i = 0; i < 5; i++) {
      await recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }
    // Force-delete the 3rd record.
    h.storage._forceDelete(h.workspace, 'encaissement', 3);

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    const stream = report.streams.find((s) => s.name === 'encaissement');
    expect(stream?.valid).toBe(false);
    expect(stream?.reason).toMatch(/sequence gap/);
  });

  it('le hash est sensible à la moindre modification du payload', () => {
    const h1 = hash(canonicalize({ amount: 100, mode: 'cb' }));
    const h2 = hash(canonicalize({ amount: 101, mode: 'cb' }));
    expect(h1).not.toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('les chaînes de flux différents sont indépendantes', async () => {
    const enc1 = await recordEncaissement(h.workspace, {
      montantCentimes: 100,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    const jet1 = await logTechnicalEvent(h.workspace, 'system_boot', { v: 1 });

    // Each stream maintains its own independent sequence starting at 1.
    // (recordEncaissement also writes a JET event, so jet1 will be sequence 2.)
    expect(enc1.sequence).toBe(1);
    expect(jet1.sequence).toBeGreaterThanOrEqual(1);

    // The encaissement chain links to GENESIS, not to any JET hash.
    expect(enc1.previousHash).toBe(GENESIS_HASH);

    // verifyChain over the encaissement stream alone must validate.
    const encRecords = await read('encaissement', h.workspace);
    const result = verifyChain(
      encRecords.map((r) => ({
        hash: r.hash,
        previousHash: r.previousHash,
        _id: r._id,
        stream: r.stream,
        sequence: r.sequence,
        workspaceId: r.workspaceId,
        recordedAt: r.recordedAt,
        payload: r.payload,
      })),
    );
    expect(result.valid).toBe(true);
  });
});
