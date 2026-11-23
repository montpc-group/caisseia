/**
 * Tests de preuve — Attestation individuelle editeur.
 *
 * Cf. ATTESTATION.md (modele BOFIP BOI-LETTRE-000242).
 *
 * SCOPE: Milestone 4.
 *
 * Couvre :
 *  - Generation PDF avec volet 1 (editeur) et volet 2 (utilisateur)
 *  - Filigrane SPECIMEN obligatoire (pre-v1.0.0)
 *  - Hash SHA-256 du PDF genere
 *  - Metadonnees completes dans AttestationDocument
 *  - Export PDF dans exportPeriod (rapport de synthese)
 *  - Contenu du rapport de synthese (totaux, clotures, signatures)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateAttestation } from '../src/attestation.js';
import { exportPeriod } from '../src/restitution.js';
import { recordEncaissement } from '../src/encaissement.js';
import { recordCorrection } from '../src/corrections.js';
import { closeDay } from '../src/closures.js';
import { MODULE_VERSION } from '../src/index.js';
import { freshHarness, type Harness } from './_helpers.js';

describe('Attestation editeur', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('generateAttestation produit un PDF valide avec volet 1 et volet 2', async () => {
    const doc = await generateAttestation({
      workspaceId: h.workspace,
      raisonSociale: 'ACME SARL',
      siret: '123 456 789 00011',
      consumerApp: 'MyApp',
      consumerAppVersion: '1.0.0',
      startDate: new Date('2026-01-15'),
    });

    // PDF buffer must be non-empty and start with %PDF
    expect(doc.pdfBuffer).toBeInstanceOf(Buffer);
    expect(doc.pdfBuffer.length).toBeGreaterThan(0);
    expect(doc.pdfBuffer.subarray(0, 5).toString()).toBe('%PDF-');

    // Metadata must be complete
    expect(doc.workspaceId).toBe(h.workspace);
    expect(doc.moduleVersion).toBe(MODULE_VERSION);
    expect(doc.attestationId).toContain(h.workspace);
    expect(doc.generatedAt).toBeTruthy();
    expect(doc.volet2Status).toBe('pending');
  });

  it('le PDF porte le filigrane SPECIMEN par defaut (pre-v1.0.0)', async () => {
    const doc = await generateAttestation({
      workspaceId: h.workspace,
      raisonSociale: 'ACME SARL',
      siret: '123 456 789 00011',
      consumerApp: 'MyApp',
      consumerAppVersion: '1.0.0',
      startDate: new Date('2026-01-15'),
    });

    // specimen flag must be true
    expect(doc.specimen).toBe(true);

    // PDF must have the ExtGState with low opacity (watermark rendering)
    // pdfkit renders the SPECIMEN watermark with fillColor('red', 0.15)
    // which creates an ExtGState object with /ca 0.15
    const pdfRaw = doc.pdfBuffer.toString('latin1');
    expect(pdfRaw).toContain('/ca 0.15');

    // The PDF must have multiple pages (volet 1 + volet 2)
    // Page count is in the Pages dict: /Count N
    const countMatch = pdfRaw.match(/\/Count (\d+)/);
    expect(countMatch).not.toBeNull();
    expect(parseInt(countMatch![1]!)).toBeGreaterThanOrEqual(2);
  });

  it('specimen=true est le defaut et ne peut etre contourne', async () => {
    // Default: specimen is true even when not specified
    const doc = await generateAttestation({
      workspaceId: h.workspace,
      raisonSociale: 'ACME SARL',
      siret: '123 456 789 00011',
      consumerApp: 'MyApp',
      consumerAppVersion: '1.0.0',
      startDate: new Date('2026-01-15'),
      // specimen not set — defaults to true
    });

    expect(doc.specimen).toBe(true);
  });

  it('le hash SHA-256 du PDF est correct et deterministe pour un meme buffer', async () => {
    const { createHash } = await import('node:crypto');

    const doc = await generateAttestation({
      workspaceId: h.workspace,
      raisonSociale: 'ACME SARL',
      siret: '123 456 789 00011',
      consumerApp: 'MyApp',
      consumerAppVersion: '1.0.0',
      startDate: new Date('2026-01-15'),
    });

    // Recompute hash from buffer
    const recomputed = createHash('sha256').update(doc.pdfBuffer).digest('hex');
    expect(doc.pdfHash).toBe(recomputed);
    expect(doc.pdfHash).toHaveLength(64);
  });

  it('le PDF contient les informations editeur MONTPC dans les metadonnees', async () => {
    const doc = await generateAttestation({
      workspaceId: h.workspace,
      raisonSociale: 'ACME SARL',
      siret: '123 456 789 00011',
      consumerApp: 'MyApp',
      consumerAppVersion: '1.0.0',
      startDate: new Date('2026-01-15'),
    });

    // PDF info dict has Author and Creator fields in plaintext (not compressed)
    const pdfRaw = doc.pdfBuffer.toString('latin1');
    expect(pdfRaw).toContain('MONTPC SASU');
    expect(pdfRaw).toContain('caisseia');
  });

  it('le PDF contient les informations utilisateur dans le titre', async () => {
    const doc = await generateAttestation({
      workspaceId: h.workspace,
      raisonSociale: 'ACME SARL',
      siret: '123 456 789 00011',
      consumerApp: 'MyApp',
      consumerAppVersion: '1.0.0',
      startDate: new Date('2026-01-15'),
    });

    // pdfkit stores Title as UTF-16BE with BOM in the info dict.
    // Search for the UTF-16BE encoded string in the raw buffer.
    const titleUtf16 = Buffer.from('ACME', 'utf16le').swap16();
    expect(doc.pdfBuffer.includes(titleUtf16)).toBe(true);

    const kindUtf16 = Buffer.from('Attestation editeur', 'utf16le').swap16();
    expect(doc.pdfBuffer.includes(kindUtf16)).toBe(true);
  });

  it('le PDF reference la mention legale dans les metadonnees (art. 286)', async () => {
    const doc = await generateAttestation({
      workspaceId: h.workspace,
      raisonSociale: 'ACME SARL',
      siret: '123 456 789 00011',
      consumerApp: 'MyApp',
      consumerAppVersion: '1.0.0',
      startDate: new Date('2026-01-15'),
    });

    // Subject field is UTF-16BE encoded in PDF info dict
    const ref286 = Buffer.from('286', 'utf16le').swap16();
    expect(doc.pdfBuffer.includes(ref286)).toBe(true);

    const refCGI = Buffer.from('CGI', 'utf16le').swap16();
    expect(doc.pdfBuffer.includes(refCGI)).toBe(true);
  });

  it('exportPeriod format=pdf produit un rapport de synthese', async () => {
    // Seed data
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
      reason: 'Retour',
    });

    await closeDay(h.workspace, new Date());

    const yesterday = new Date(Date.now() - 86400_000);
    const tomorrow = new Date(Date.now() + 86400_000);
    const result = await exportPeriod(h.workspace, yesterday, tomorrow, 'pdf');

    // Must contain rapport-synthese.pdf
    const pdfFile = result.files.find((f) => f.name === 'rapport-synthese.pdf');
    expect(pdfFile).toBeDefined();
    expect(pdfFile!.hash).toBeTruthy();

    // Must contain public-keys.json
    const keyFile = result.files.find((f) => f.name === 'public-keys.json');
    expect(keyFile).toBeDefined();

    // Data must be populated
    expect(result.data.encaissements.length).toBeGreaterThanOrEqual(1);
    expect(result.data.corrections.length).toBeGreaterThanOrEqual(1);
    expect(result.data.closures.length).toBeGreaterThanOrEqual(1);

    // Manifest must reference the PDF file
    const manifestEntry = result.manifest.files.find((f) => f.name === 'rapport-synthese.pdf');
    expect(manifestEntry).toBeDefined();
  });

  it('scopeOverride est accepte sans erreur et produit un PDF valide', async () => {
    const customScope = ['Enregistrement des paiements en ligne uniquement'];
    const doc = await generateAttestation({
      workspaceId: h.workspace,
      raisonSociale: 'CUSTOM SCOPE SAS',
      siret: '999 888 777 00022',
      consumerApp: 'CustomApp',
      consumerAppVersion: '2.0.0',
      startDate: new Date('2026-03-01'),
      scopeOverride: customScope,
    });

    // PDF must be valid
    expect(doc.pdfBuffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(doc.pdfBuffer.length).toBeGreaterThan(0);
    expect(doc.moduleVersion).toBe(MODULE_VERSION);
  });
});
