/**
 * Tests de validation export DGFIP — format, intégrité, scénarios réels.
 *
 * Cf. COMPLIANCE.md § 5 (Restitution) et BOI-CF-COM-20-60.
 *
 * Ces tests vérifient que l'export produit par le module est exploitable
 * par un inspecteur DGFIP : format correct, manifest intègre, détection
 * de tampering, données réalistes avec modes mixtes et corrections.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { exportPeriod, verifyExportIntegrity } from '../src/restitution.js';
import { recordEncaissement } from '../src/encaissement.js';
import { recordCorrection } from '../src/corrections.js';
import { closeDay } from '../src/closures.js';
import { hash } from '../src/crypto.js';
import { freshHarness, type Harness } from './_helpers.js';

// Wide period covering "now" — used across all tests since recordedAt = server clock.
const wide = () => ({
  from: new Date(Date.now() - 86400_000),
  to: new Date(Date.now() + 86400_000),
});

// ─────────────────────────────────────────────────────────────────────
// § EXPORT FORMAT VALIDATION — BOI-CF-COM-20-60 (restitution DGFIP)
// ─────────────────────────────────────────────────────────────────────

describe('Export format validation (restitution DGFIP)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  describe('CSV format', () => {
    it('utilise le séparateur point-virgule (norme FR) avec header complet', async () => {
      // AUDIT: L'inspecteur ouvre le CSV dans Excel FR. Le séparateur standard
      // est le point-virgule car la virgule est le séparateur décimal en FR.
      await recordEncaissement(h.workspace, {
        montantCentimes: 5000,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });

      const { from, to } = wide();
      const result = await exportPeriod(h.workspace, from, to, 'csv');
      const csvFile = result.files.find((f) => f.name === 'encaissements.csv')!;
      const lines = csvFile.content.split('\n');
      const header = lines[0]!;

      // Semicolon-delimited header with all required columns.
      const cols = header.split(';');
      expect(cols).toContain('id');
      expect(cols).toContain('sequence');
      expect(cols).toContain('type');
      expect(cols).toContain('recordedAt');
      expect(cols).toContain('montantCentimes');
      expect(cols).toContain('devise');
      expect(cols).toContain('mode');
      expect(cols).toContain('tvaCode');
      expect(cols).toContain('previousHash');
      expect(cols).toContain('hash');
    });

    it('les montants sont en centimes entiers, jamais en flottant', async () => {
      // AUDIT: La canonicalisation exige des entiers sur les clés monétaires.
      // Le CSV doit refléter exactement les centimes stockés.
      await recordEncaissement(h.workspace, {
        montantCentimes: 12345,
        devise: 'EUR',
        mode: 'especes',
        tvaCode: 'TVA20',
      });

      const { from, to } = wide();
      const result = await exportPeriod(h.workspace, from, to, 'csv');
      const csvFile = result.files.find((f) => f.name === 'encaissements.csv')!;
      const dataLine = csvFile.content.split('\n')[1]!;
      const cols = dataLine.split(';');
      const header = csvFile.content.split('\n')[0]!.split(';');
      const amtIdx = header.indexOf('montantCentimes');
      expect(amtIdx).toBeGreaterThan(-1);

      // Must be "12345", not "123.45" or "12345.0".
      const amtStr = cols[amtIdx]!;
      expect(amtStr).toBe('12345');
      expect(amtStr).not.toContain('.');
    });

    it('les dates sont au format ISO 8601 UTC', async () => {
      // AUDIT: ISO 8601 est le format standard interopérable.
      await recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });

      const { from, to } = wide();
      const result = await exportPeriod(h.workspace, from, to, 'csv');
      const csvFile = result.files.find((f) => f.name === 'encaissements.csv')!;
      const dataLine = csvFile.content.split('\n')[1]!;
      const cols = dataLine.split(';');
      const header = csvFile.content.split('\n')[0]!.split(';');
      const dateIdx = header.indexOf('recordedAt');
      const dateStr = cols[dateIdx]!;

      // ISO 8601 with Z suffix (UTC).
      expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    });

    it('inclut corrections et encaissements dans le même CSV', async () => {
      // AUDIT: Le CSV doit montrer la traçabilité complète.
      const enc = await recordEncaissement(h.workspace, {
        montantCentimes: 5000,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
      await recordCorrection(h.workspace, {
        originalId: enc._id,
        montantCentimes: -1000,
        devise: 'EUR',
        type: 'remboursement_partiel',
        reason: 'Retour client',
      });

      const { from, to } = wide();
      const result = await exportPeriod(h.workspace, from, to, 'csv');
      const csvFile = result.files.find((f) => f.name === 'encaissements.csv')!;
      const lines = csvFile.content.split('\n');

      // Header + 2 data rows (1 encaissement + 1 correction).
      expect(lines.length).toBe(3);

      const header = lines[0]!.split(';');
      const typeIdx = header.indexOf('type');
      const types = lines.slice(1).map((l) => l.split(';')[typeIdx]);
      expect(types).toContain('encaissement');
      expect(types).toContain('correction');
    });
  });

  describe('JSON format', () => {
    it('contient les 4 flux + public-keys.json — JSON valide, dates ISO 8601', async () => {
      // AUDIT: L'export JSON est la source de vérité pour l'inspection numérique.
      const enc = await recordEncaissement(h.workspace, {
        montantCentimes: 2000,
        devise: 'EUR',
        mode: 'virement',
        tvaCode: 'TVA10',
      });
      await recordCorrection(h.workspace, {
        originalId: enc._id,
        montantCentimes: -500,
        devise: 'EUR',
        type: 'avoir_commercial',
        reason: 'Geste commercial',
      });
      await closeDay(h.workspace, new Date());

      const { from, to } = wide();
      const result = await exportPeriod(h.workspace, from, to, 'json');
      const fileNames = result.files.map((f) => f.name);

      expect(fileNames).toContain('encaissements.json');
      expect(fileNames).toContain('corrections.json');
      expect(fileNames).toContain('closures.json');
      expect(fileNames).toContain('jet.json');
      expect(fileNames).toContain('public-keys.json');

      // All JSON files must parse without error.
      for (const f of result.files) {
        if (f.name.endsWith('.json')) {
          expect(() => JSON.parse(f.content), `${f.name} must be valid JSON`).not.toThrow();
        }
      }

      // Encaissement data must have ISO 8601 recordedAt.
      for (const enc of result.data.encaissements) {
        expect(enc.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });
  });

  describe('Manifest integrity', () => {
    it('chaque fichier de l\'export a une entrée SHA-256 dans le manifest', async () => {
      // AUDIT: Le manifest est la preuve qu'aucun fichier n'a été ajouté,
      // retiré ou modifié après l'export.
      await recordEncaissement(h.workspace, {
        montantCentimes: 1000,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });

      const { from, to } = wide();
      const result = await exportPeriod(h.workspace, from, to, 'json');

      // Every file must have a manifest entry.
      for (const file of result.files) {
        const entry = result.manifest.files.find((f) => f.name === file.name);
        expect(entry, `manifest must reference ${file.name}`).toBeDefined();
        expect(entry!.hash).toBe(hash(file.content));
        expect(entry!.size).toBe(Buffer.byteLength(file.content, 'utf-8'));
      }

      // No manifest entry without a corresponding file.
      for (const entry of result.manifest.files) {
        const file = result.files.find((f) => f.name === entry.name);
        expect(file, `orphan manifest entry: ${entry.name}`).toBeDefined();
      }
    });

    it('le manifestHash couvre le manifest complet', async () => {
      // AUDIT: Le hash global du manifest empêche un attaquant de modifier
      // les entrées individuelles du manifest.
      await recordEncaissement(h.workspace, {
        montantCentimes: 500,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });

      const { from, to } = wide();
      const result = await exportPeriod(h.workspace, from, to, 'json');

      expect(result.manifest.manifestHash).toHaveLength(64);
      expect(result.manifest.moduleVersion).toBeDefined();
      expect(result.manifest.workspaceId).toBe(h.workspace);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// § REAL-WORLD DATA PATTERNS — scénarios de données réalistes
// ─────────────────────────────────────────────────────────────────────

describe('Real-world data patterns (scénarios réalistes)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('export avec modes de paiement mixtes — totaux par mode corrects', async () => {
    // AUDIT: L'inspecteur vérifie que la ventilation par mode de paiement
    // de la clôture journalière correspond aux lignes individuelles.
    await recordEncaissement(h.workspace, { montantCentimes: 1000, devise: 'EUR', mode: 'especes', tvaCode: 'TVA20' });
    await recordEncaissement(h.workspace, { montantCentimes: 2000, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    await recordEncaissement(h.workspace, { montantCentimes: 3000, devise: 'EUR', mode: 'stripe', tvaCode: 'TVA20' });
    await recordEncaissement(h.workspace, { montantCentimes: 500, devise: 'EUR', mode: 'virement', tvaCode: 'TVA20' });

    const closure = await closeDay(h.workspace, new Date());
    expect(closure.aggregate.parMode).toEqual({
      especes: 1000,
      cb: 2000,
      stripe: 3000,
      virement: 500,
    });
    expect(closure.aggregate.caTotalCentimes).toBe(6500);
    expect(closure.aggregate.nbTransactions).toBe(4);

    // Export and verify the data matches.
    const { from, to } = wide();
    const result = await exportPeriod(h.workspace, from, to, 'json');
    expect(result.data.encaissements.length).toBe(4);
  });

  it('export avec remboursements partiels — montants nets corrects, originalId valides', async () => {
    // AUDIT: Les corrections doivent référencer des encaissements existants.
    // L'export doit contenir les originaux ET les corrections, avec des
    // montants nets cohérents dans la clôture.
    const enc1 = await recordEncaissement(h.workspace, {
      montantCentimes: 10000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    const enc2 = await recordEncaissement(h.workspace, {
      montantCentimes: 5000,
      devise: 'EUR',
      mode: 'especes',
      tvaCode: 'TVA10',
    });

    // Partial refund on enc1, error correction on enc2.
    await recordCorrection(h.workspace, {
      originalId: enc1._id,
      montantCentimes: -3000,
      devise: 'EUR',
      type: 'remboursement_partiel',
      reason: 'Client insatisfait — prestation partielle',
    });
    await recordCorrection(h.workspace, {
      originalId: enc2._id,
      montantCentimes: -500,
      devise: 'EUR',
      type: 'erreur_montant',
      reason: 'Erreur de saisie opérateur',
    });

    const closure = await closeDay(h.workspace, new Date());
    // Net: (10000-3000) + (5000-500) = 7000 + 4500 = 11500
    expect(closure.aggregate.caTotalCentimes).toBe(11500);

    const { from, to } = wide();
    const result = await exportPeriod(h.workspace, from, to, 'json');
    expect(result.data.encaissements.length).toBe(2);
    expect(result.data.corrections.length).toBe(2);

    // All corrections must reference valid originalIds present in encaissements.
    const encIds = new Set(result.data.encaissements.map((r) => r._id));
    for (const corr of result.data.corrections) {
      if (corr.payload.type === 'correction') {
        expect(encIds.has(corr.payload.data.originalId)).toBe(true);
      }
    }
  });

  it('export avec ventilation TVA mixte — clôture reflète tous les codes TVA', async () => {
    // AUDIT: Si un commerçant enregistre des encaissements avec des taux TVA
    // différents, la clôture doit ventiler correctement par code TVA.
    // NOTE: recordedAt = server clock, donc tous les encaissements sont "today".
    // On ferme "today" pour capturer tous les records dans la même clôture.
    await recordEncaissement(h.workspace, { montantCentimes: 1000, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    await recordEncaissement(h.workspace, { montantCentimes: 2000, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    await recordEncaissement(h.workspace, { montantCentimes: 500, devise: 'EUR', mode: 'especes', tvaCode: 'TVA10' });
    await recordEncaissement(h.workspace, { montantCentimes: 800, devise: 'EUR', mode: 'especes', tvaCode: 'TVA5_5' });

    const closure = await closeDay(h.workspace, new Date());
    const tvaCodes = Object.keys(closure.aggregate.parTva).sort();
    expect(tvaCodes).toEqual(['TVA10', 'TVA20', 'TVA5_5'].sort());
    expect(closure.aggregate.parTva['TVA20']!.ttc).toBe(3000);
    expect(closure.aggregate.parTva['TVA10']!.ttc).toBe(500);
    expect(closure.aggregate.parTva['TVA5_5']!.ttc).toBe(800);
    expect(closure.aggregate.caTotalCentimes).toBe(4300);
  });
});

// ─────────────────────────────────────────────────────────────────────
// § OFFLINE VERIFICATION — détection tampering hors-ligne
// ─────────────────────────────────────────────────────────────────────

describe('Offline verification (détection tampering — BOI-CF-COM-20-60)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('roundtrip intègre : export → verify → PASS', async () => {
    // AUDIT: L'export non modifié doit toujours passer la vérification.
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 5000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    await recordCorrection(h.workspace, {
      originalId: enc._id,
      montantCentimes: -1000,
      devise: 'EUR',
      type: 'remboursement_partiel',
      reason: 'Retour produit',
    });
    await closeDay(h.workspace, new Date());

    const { from, to } = wide();
    const result = await exportPeriod(h.workspace, from, to, 'json');
    const check = await verifyExportIntegrity(result);
    expect(check.valid).toBe(true);
    expect(check.errors).toBeUndefined();
  });

  it('tampering CSV (un seul caractère modifié) — détecté', async () => {
    // AUDIT: Même une modification d'un seul caractère dans le CSV doit
    // être détectée par le hash SHA-256 du manifest.
    await recordEncaissement(h.workspace, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    const { from, to } = wide();
    const result = await exportPeriod(h.workspace, from, to, 'csv');

    const tampered = structuredClone(result);
    const csvFile = tampered.files.find((f) => f.name === 'encaissements.csv')!;
    // Change a single character in the content without updating the hash.
    csvFile.content = csvFile.content.replace('1000', '1001');

    const check = await verifyExportIntegrity(tampered);
    expect(check.valid).toBe(false);
    expect(check.errors!.some((e) => e.includes('encaissements.csv'))).toBe(true);
  });

  it('fichier manquant dans l\'export — détecté par manifest', async () => {
    // AUDIT: Si un fichier est retiré de l'export, le manifest le signale.
    await recordEncaissement(h.workspace, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    const { from, to } = wide();
    const result = await exportPeriod(h.workspace, from, to, 'json');

    const tampered = structuredClone(result);
    // Remove the corrections.json file but keep the manifest entry.
    tampered.files = tampered.files.filter((f) => f.name !== 'corrections.json');

    const check = await verifyExportIntegrity(tampered);
    expect(check.valid).toBe(false);
    expect(check.errors!.some((e) => e.includes('corrections.json'))).toBe(true);
  });

  it('hashes de fichiers permutés dans le manifest — détecté', async () => {
    // AUDIT: Un attaquant permute les hashes de deux fichiers dans le manifest.
    // La vérification doit détecter que chaque hash ne correspond plus à son fichier.
    await recordEncaissement(h.workspace, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    await closeDay(h.workspace, new Date());

    const { from, to } = wide();
    const result = await exportPeriod(h.workspace, from, to, 'json');

    const tampered = structuredClone(result);
    const encEntry = tampered.manifest.files.find((f) => f.name === 'encaissements.json')!;
    const jetEntry = tampered.manifest.files.find((f) => f.name === 'jet.json')!;

    // Swap hashes between encaissements.json and jet.json.
    const tmpHash = encEntry.hash;
    encEntry.hash = jetEntry.hash;
    jetEntry.hash = tmpHash;

    const check = await verifyExportIntegrity(tampered);
    expect(check.valid).toBe(false);
    // Both swapped files should be flagged.
    expect(check.errors!.length).toBeGreaterThanOrEqual(1);
  });

  it('chaîne de hash cassée dans les données exportées — détecté par verifyExportIntegrity', async () => {
    // AUDIT: Même si les fichiers JSON sont recalculés après tampering,
    // la chaîne de hash interne aux records sera invalide.
    await recordEncaissement(h.workspace, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    await recordEncaissement(h.workspace, {
      montantCentimes: 2000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    const { from, to } = wide();
    const result = await exportPeriod(h.workspace, from, to, 'json');

    // Tamper the data directly (not the file) — change an amount in the records.
    const tampered = structuredClone(result);
    if (tampered.data.encaissements[0]?.payload.type === 'encaissement') {
      (tampered.data.encaissements[0].payload as any).data.montantCentimes = 9999;
    }

    const check = await verifyExportIntegrity(tampered);
    expect(check.valid).toBe(false);
    // The hash mismatch on the tampered record should be caught.
    expect(check.errors!.some((e) => e.includes('Hash'))).toBe(true);
  });
});
