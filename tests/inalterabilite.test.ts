/**
 * Tests de preuve — Inaltérabilité.
 *
 * Cf. COMPLIANCE.md § 1.
 *
 * Ces tests ne sont pas de simples tests unitaires.
 * Ce sont la PREUVE en cas de contrôle DGFIP que le module
 * respecte effectivement l'exigence d'inaltérabilité.
 *
 * À exécuter avant chaque release. À conserver dans les artefacts de release.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as publicApi from '../src/index.js';
import { recordEncaissement } from '../src/encaissement.js';
import { recordCorrection, getNetAmount } from '../src/corrections.js';
import { read } from '../src/eventStore.js';
import { logTechnicalEvent } from '../src/jet.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { freshHarness, type Harness } from './_helpers.js';

describe('Inaltérabilité (art. 286 I 3°bis CGI)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it("aucune fonction publique du package n'expose UPDATE ou DELETE sur encaissement", () => {
    const exported = Object.keys(publicApi);
    const forbidden = /^(update|delete|remove|drop|patch|set|edit|modify|alter|destroy)/i;
    const violations = exported.filter(
      (name) => forbidden.test(name) && /encaissement|correction|closure|jet/i.test(name),
    );
    expect(violations).toEqual([]);
    // Spot-check known good exports are present.
    expect(exported).toContain('recordEncaissement');
    expect(exported).toContain('recordCorrection');
    expect(exported).toContain('verifyChainIntegrity');
    // No raw `setActive` on event records — only on storage adapter (infra surface).
    expect(exported).not.toContain('updateEncaissement');
    expect(exported).not.toContain('deleteEncaissement');
  });

  it("une correction crée un nouvel enregistrement, n'altère pas l'original", async () => {
    const original = await recordEncaissement(h.workspace, {
      montantCentimes: 10_000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    await recordCorrection(h.workspace, {
      originalId: original._id,
      montantCentimes: -2_000,
      devise: 'EUR',
      type: 'remboursement_partiel',
      reason: 'Client a annulé une prestation',
    });

    // Read the original directly from the stream — it must still be 10 000 €.
    const allRecords = await read<{ type: string; data: { montantCentimes: number } }>(
      'encaissement',
      h.workspace,
    );
    const originalInDb = allRecords.find((r) => r._id === original._id)!;
    expect(originalInDb.payload.type).toBe('encaissement');
    expect(originalInDb.payload.data.montantCentimes).toBe(10_000);

    // Net amount reflects the correction.
    expect(await getNetAmount(h.workspace, original._id)).toBe(8_000);
  });

  it('une mutation directe en base est détectée par verifyChainIntegrity', async () => {
    const records = [];
    for (let i = 0; i < 5; i++) {
      records.push(
        await recordEncaissement(h.workspace, {
          montantCentimes: 100 * (i + 1),
          devise: 'EUR',
          mode: 'cb',
          tvaCode: 'TVA20',
        }),
      );
    }
    // Tamper sequence #3 directly in storage (bypass).
    h.storage._forceTamper(h.workspace, 'encaissement', 3, (row) => {
      const p = row['payload'] as { data: { montantCentimes: number } };
      p.data.montantCentimes = 1; // forged value
    });

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    const stream = report.streams.find((s) => s.name === 'encaissement');
    expect(stream?.valid).toBe(false);
    expect(stream?.brokenAt).toBe(2); // index 2 = sequence 3
  });

  it('une suppression directe en base est détectée par verifyChainIntegrity', async () => {
    for (let i = 0; i < 5; i++) {
      await recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }
    h.storage._forceDelete(h.workspace, 'encaissement', 3);
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    const stream = report.streams.find((s) => s.name === 'encaissement');
    expect(stream?.valid).toBe(false);
  });

  it('le calcul du net inclut toutes les corrections référençantes', async () => {
    const original = await recordEncaissement(h.workspace, {
      montantCentimes: 10_000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    await recordCorrection(h.workspace, {
      originalId: original._id,
      montantCentimes: -1_000,
      devise: 'EUR',
      type: 'remboursement_partiel',
      reason: 'Acompte remboursé',
    });
    await recordCorrection(h.workspace, {
      originalId: original._id,
      montantCentimes: -500,
      devise: 'EUR',
      type: 'avoir_commercial',
      reason: 'Geste commercial post-mission',
    });
    expect(await getNetAmount(h.workspace, original._id)).toBe(8_500);
  });

  it('le numéro de séquence est strictement contigu (pas de gap)', async () => {
    for (let i = 0; i < 10; i++) {
      await recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }
    const records = await read('encaissement', h.workspace);
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('la suppression du PREMIER enregistrement est détectée par verifyChainIntegrity', async () => {
    for (let i = 0; i < 5; i++) {
      await recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }
    h.storage._forceDelete(h.workspace, 'encaissement', 1);
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    const stream = report.streams.find((s) => s.name === 'encaissement');
    expect(stream?.valid).toBe(false);
    expect(stream?.reason).toMatch(/sequence gap/);
  });

  it('la suppression du DERNIER enregistrement est détectable via les bornes de clôture', async () => {
    // Record 5 encaissements, close the day, then delete the last record.
    // The closure's derniereSequence anchors the expected count — a post-closure
    // deletion leaves the chain internally valid but the closure proves the gap.
    for (let i = 0; i < 5; i++) {
      await recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }

    const { closeDay } = await import('../src/closures.js');
    const closure = await closeDay(h.workspace, new Date());
    expect(closure.aggregate.derniereSequence).toBe(5);
    expect(closure.aggregate.nbTransactions).toBe(5);

    // Now delete the last encaissement (sequence 5).
    h.storage._forceDelete(h.workspace, 'encaissement', 5);

    // The chain over remaining [1,2,3,4] is still internally valid...
    // ...but the closure's derniereSequence (5) exceeds the stream's actual last (4).
    const records = await read('encaissement', h.workspace);
    const actualLast = records[records.length - 1]!.sequence;
    expect(actualLast).toBe(4);
    expect(closure.aggregate.derniereSequence).toBeGreaterThan(actualLast);
    // This mismatch is the detection mechanism for last-record deletion.
  });

  it('une tentative de mutation est loguée dans le JET', async () => {
    // Public API has no mutation, so we simulate the consumer-app side: when
    // an app catches an inalterability violation, it logs it to the JET.
    await logTechnicalEvent(h.workspace, 'mutation_attempt_refused', {
      attemptedBy: 'test-user',
      target: 'encaissement:42',
      reason: 'simulated mutation attempt',
    });

    const jet = await read<{ type: string }>('jet', h.workspace);
    const refused = jet.filter((e) => e.payload.type === 'mutation_attempt_refused');
    expect(refused.length).toBe(1);
  });
});
