/**
 * Tests audit-grade — extensions de schéma Tier 1 pour certification INFOCERT/LNE.
 *
 * Cf. COMPLIANCE.md §§ 1, JET.
 *
 * Vérifie que les champs optionnels operatorId et registerId :
 * - Sont acceptés par le schéma Zod
 * - Sont inclus dans le hash chain (canonicalisé)
 * - N'altèrent pas le fonctionnement existant quand omis
 *
 * Vérifie que les nouveaux types JET (mode dégradé, configuration)
 * sont acceptés par la validation et chaînés correctement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordEncaissement } from '../src/encaissement.js';
import { recordCorrection } from '../src/corrections.js';
import { logTechnicalEvent } from '../src/jet.js';
import { read } from '../src/eventStore.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { freshHarness, type Harness } from './_helpers.js';
import type { EncaissementStreamPayload } from '../schemas/encaissement.schema.js';

// ─────────────────────────────────────────────────────────────────────
// § operatorId — traçabilité opérateur (BOI-TVA-DECLA-30-10-30)
// ─────────────────────────────────────────────────────────────────────

describe('operatorId (traçabilité opérateur — BOI-TVA-DECLA-30-10-30)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('encaissement avec operatorId est enregistré et récupérable', async () => {
    // AUDIT: L'inspecteur DGFIP demande « montrez-moi tous les encaissements
    // de l'opérateur OP-42 ». Le champ doit être persisté et restituable.
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 5000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
      operatorId: 'OP-42',
    });

    expect(enc.data.operatorId).toBe('OP-42');

    const records = await read<EncaissementStreamPayload>('encaissement', h.workspace);
    const found = records.find((r) => r._id === enc._id);
    expect(found).toBeDefined();
    if (found?.payload.type === 'encaissement') {
      expect(found.payload.data.operatorId).toBe('OP-42');
    }
  });

  it('operatorId est inclus dans le hash — le modifier casse la chaîne', async () => {
    // AUDIT: Le champ operatorId fait partie du payload canonicalisé.
    // Si un attaquant modifie l'opérateur sans recalculer le hash,
    // verifyChainIntegrity doit détecter la divergence.
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
      operatorId: 'OP-LEGIT',
    });

    // Tamper the operatorId in storage.
    h.storage._forceTamper(h.workspace, 'encaissement', enc.sequence, (row) => {
      const p = row['payload'] as { data: { operatorId?: string } };
      p.data.operatorId = 'OP-FORGED';
    });

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    const stream = report.streams.find((s) => s.name === 'encaissement');
    expect(stream?.valid).toBe(false);
    expect(stream?.reason).toMatch(/payload hash mismatch/);
  });

  it('encaissement sans operatorId reste valide (rétrocompatibilité)', async () => {
    // AUDIT: Les encaissements existants sans operatorId doivent continuer
    // à fonctionner. Le champ est optionnel.
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 2000,
      devise: 'EUR',
      mode: 'especes',
      tvaCode: 'TVA20',
    });

    expect(enc.data.operatorId).toBeUndefined();

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(true);
  });

  it('correction avec operatorId est enregistrée correctement', async () => {
    // AUDIT: La traçabilité opérateur s'étend aux corrections.
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 5000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    const corr = await recordCorrection(h.workspace, {
      originalId: enc._id,
      montantCentimes: -1000,
      devise: 'EUR',
      type: 'remboursement_partiel',
      reason: 'Retour produit',
      operatorId: 'OP-SUPERVISOR',
    });

    expect(corr.data.operatorId).toBe('OP-SUPERVISOR');
  });
});

// ─────────────────────────────────────────────────────────────────────
// § registerId — traçabilité terminal (multi-registre)
// ─────────────────────────────────────────────────────────────────────

describe('registerId (traçabilité terminal — multi-registre)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('encaissement avec registerId est persisté et récupérable', async () => {
    // AUDIT: L'inspecteur demande « tous les encaissements du terminal
    // CAISSE-01 ». Le registerId permet ce filtrage.
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 3000,
      devise: 'EUR',
      mode: 'especes',
      tvaCode: 'TVA20',
      registerId: 'CAISSE-01',
    });

    expect(enc.data.registerId).toBe('CAISSE-01');

    const records = await read<EncaissementStreamPayload>('encaissement', h.workspace);
    const found = records.find((r) => r._id === enc._id);
    if (found?.payload.type === 'encaissement') {
      expect(found.payload.data.registerId).toBe('CAISSE-01');
    }
  });

  it('registerId est inclus dans le hash — le modifier casse la chaîne', async () => {
    // AUDIT: Le registerId fait partie du skeleton hashé.
    await recordEncaissement(h.workspace, {
      montantCentimes: 500,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
      registerId: 'POS-MOBILE-01',
    });

    h.storage._forceTamper(h.workspace, 'encaissement', 1, (row) => {
      const p = row['payload'] as { data: { registerId?: string } };
      p.data.registerId = 'POS-FORGED';
    });

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
  });

  it('encaissement sans registerId reste valide (rétrocompatibilité)', async () => {
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    expect(enc.data.registerId).toBeUndefined();
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(true);
  });

  it('operatorId + registerId combinés dans un même encaissement', async () => {
    // AUDIT: Un commerce avec plusieurs caisses et opérateurs doit
    // pouvoir croiser les deux dimensions de traçabilité.
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 7500,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
      operatorId: 'OP-JEAN',
      registerId: 'CAISSE-02',
    });

    expect(enc.data.operatorId).toBe('OP-JEAN');
    expect(enc.data.registerId).toBe('CAISSE-02');

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// § Degraded mode JET events
// ─────────────────────────────────────────────────────────────────────

describe('Degraded mode JET events (mode dégradé — BOI-TVA-DECLA-30-10-30 §160)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('degraded_mode_enter est accepté et chaîné dans le JET', async () => {
    // AUDIT: L'inspecteur demande « le système a-t-il été en panne ? ».
    // L'événement degraded_mode_enter prouve l'entrée en mode dégradé.
    const event = await logTechnicalEvent(h.workspace, 'degraded_mode_enter', {
      reason: 'Coupure réseau identifiée',
      operator: 'OP-ADMIN',
      timestamp: new Date().toISOString(),
    });

    expect(event.type).toBe('degraded_mode_enter');
    expect(event.hash).toBeTruthy();

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.streams.find((s) => s.name === 'jet')?.valid).toBe(true);
  });

  it('degraded_mode_exit est accepté et chaîné', async () => {
    await logTechnicalEvent(h.workspace, 'degraded_mode_enter', {
      reason: 'Maintenance planifiée',
    });

    const exit = await logTechnicalEvent(h.workspace, 'degraded_mode_exit', {
      reason: 'Système restauré',
      manualRecordsCount: 3,
    });

    expect(exit.type).toBe('degraded_mode_exit');
    expect(exit.previousHash).toBeTruthy();
  });

  it('manual_entry_injected est accepté pour la réinjection post-panne', async () => {
    // AUDIT: Après une panne, les encaissements manuels sont réinjectés.
    // Chaque réinjection est tracée dans le JET.
    const event = await logTechnicalEvent(h.workspace, 'manual_entry_injected', {
      originalTimestamp: '2027-03-15T14:32:00Z',
      amount: 8500,
      operator: 'OP-HAMZA',
    });

    expect(event.type).toBe('manual_entry_injected');
  });
});

// ─────────────────────────────────────────────────────────────────────
// § Config change JET events
// ─────────────────────────────────────────────────────────────────────

describe('Config change JET events (traçabilité configuration)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('payment_method_config_changed est accepté par Zod et chaîné', async () => {
    // AUDIT: INFOCERT vérifie que les modifications de modes de paiement
    // sont tracées. Par ex. ajout d'un mode "wallet" ou retrait de "chèque".
    const event = await logTechnicalEvent(h.workspace, 'payment_method_config_changed', {
      action: 'added',
      method: 'wallet',
      operator: 'OP-ADMIN',
    });

    expect(event.type).toBe('payment_method_config_changed');
    expect(event.hash).toBeTruthy();
  });

  it('operator_config_changed est accepté par Zod et chaîné', async () => {
    // AUDIT: Modification des permissions opérateur tracée.
    const event = await logTechnicalEvent(h.workspace, 'operator_config_changed', {
      action: 'permission_granted',
      operatorId: 'OP-NEW',
      grantedBy: 'OP-ADMIN',
      permissions: ['record_encaissement', 'record_correction'],
    });

    expect(event.type).toBe('operator_config_changed');
  });

  it('les nouveaux types JET coexistent avec les types existants dans la même chaîne', async () => {
    // AUDIT: L'ajout de nouveaux types ne casse pas le chainage JET existant.
    await logTechnicalEvent(h.workspace, 'system_boot', { version: '0.0.0' });
    await logTechnicalEvent(h.workspace, 'degraded_mode_enter', { reason: 'test' });
    await logTechnicalEvent(h.workspace, 'payment_method_config_changed', { action: 'test' });
    await logTechnicalEvent(h.workspace, 'operator_config_changed', { action: 'test' });
    await logTechnicalEvent(h.workspace, 'degraded_mode_exit', { reason: 'test' });

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.streams.find((s) => s.name === 'jet')?.valid).toBe(true);
  });
});
