/**
 * Tests de preuve — Journal d'Événements Techniques (JET).
 *
 * Cf. COMPLIANCE.md § JET.
 *
 * Démontre :
 *  - Toute opération métier (encaissement, correction, intégrité) produit
 *    un événement JET correspondant.
 *  - Le JET est lui-même chaîné (chaque entrée référence la précédente).
 *  - Le JET est lui-même inaltérable (mêmes garanties que encaissement).
 *  - Les types d'événement sont validés (zod refuse un type inconnu).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordEncaissement } from '../src/encaissement.js';
import { recordCorrection } from '../src/corrections.js';
import { logTechnicalEvent } from '../src/jet.js';
import { read } from '../src/eventStore.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { freshHarness, type Harness } from './_helpers.js';

describe('JET — Journal d\'Événements Techniques', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('recordEncaissement produit un événement JET encaissement_recorded', async () => {
    const e = await recordEncaissement(h.workspace, {
      montantCentimes: 1_000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    const jet = await read<{ type: string; details: { encaissementId: string } }>('jet', h.workspace);
    const evt = jet.find(
      (j) => j.payload.type === 'encaissement_recorded' && j.payload.details.encaissementId === e._id,
    );
    expect(evt).toBeDefined();
  });

  it('recordCorrection produit un événement JET correction_recorded', async () => {
    const original = await recordEncaissement(h.workspace, {
      montantCentimes: 5_000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    const correction = await recordCorrection(h.workspace, {
      originalId: original._id,
      montantCentimes: -1_000,
      devise: 'EUR',
      type: 'remboursement_partiel',
      reason: 'Test correction logging',
    });
    const jet = await read<{ type: string; details: { correctionId: string } }>('jet', h.workspace);
    const evt = jet.find(
      (j) => j.payload.type === 'correction_recorded' && j.payload.details.correctionId === correction._id,
    );
    expect(evt).toBeDefined();
  });

  it('verifyChainIntegrity (chaîne saine) produit un événement integrity_check_run', async () => {
    await recordEncaissement(h.workspace, {
      montantCentimes: 100,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(true);
    const jet = await read<{ type: string }>('jet', h.workspace);
    const evt = jet.find((j) => j.payload.type === 'integrity_check_run');
    expect(evt).toBeDefined();
  });

  it('le JET est lui-même chaîné (sequence contiguë + previousHash valide)', async () => {
    await logTechnicalEvent(h.workspace, 'system_boot', { v: 1 });
    await logTechnicalEvent(h.workspace, 'config_changed', { what: 'tva-rates' });
    await logTechnicalEvent(h.workspace, 'user_login', { userId: 'u1' });

    const jet = await read('jet', h.workspace);
    expect(jet.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < jet.length; i++) {
      expect(jet[i]!.sequence).toBe(jet[i - 1]!.sequence + 1);
      expect(jet[i]!.previousHash).toBe(jet[i - 1]!.hash);
    }
  });

  it('un type d\'événement inconnu est rejeté par zod', async () => {
    await expect(
      // @ts-expect-error — testing runtime guard
      logTechnicalEvent(h.workspace, 'forged_event_type', {}),
    ).rejects.toThrow();
  });

  it('les détails restent un Record arbitraire mais sont bien persistés', async () => {
    const detail = { foo: 'bar', n: 42, nested: { ok: true } };
    await logTechnicalEvent(h.workspace, 'system_boot', detail);
    const jet = await read<{ type: string; details: Record<string, unknown> }>('jet', h.workspace);
    const last = jet[jet.length - 1]!;
    expect(last.payload.details).toEqual(detail);
  });
});
