/**
 * Generation de l'attestation individuelle editeur (art. 286 I 3 bis CGI).
 *
 * Cf. ATTESTATION.md pour le modele BOFIP (BOI-LETTRE-000242).
 *
 * Genere un PDF pre-rempli :
 *  - Volet 1 (editeur) : identite MONTPC, version logiciel, declaration conformite
 *  - Volet 2 (utilisateur) : identite workspace, app consommatrice, dates
 *
 * HARD RULE: Tout PDF genere avant v1.0.0 (attestation editeur non signee)
 * porte un filigrane SPECIMEN.
 */

import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import { MODULE_VERSION } from './index.js';

// ─── Editor constants (MONTPC SASU) ─────────────────────────────────

const EDITOR = {
  name: 'MONTPC',
  forme: 'SASU',
  siren: '993 766 369',
  dirigeant: '[NOM Prenom du dirigeant MONTPC]',
  qualite: 'President',
  siege: '[ADRESSE_SIEGE_MONTPC]',
  capital: '[MONTANT]',
} as const;

const SOFTWARE = {
  name: 'CAISSEIA',
  package: 'caisseia',
  description: 'Registre inalterable des encaissements (art. 286 I 3 bis CGI).',
} as const;

const SCOPE_COVERED = [
  'Enregistrement des reglements clients (especes, carte bancaire, virement bancaire, paiement Stripe, cheque)',
  'Inalterabilite des enregistrements via event-sourcing append-only',
  'Securisation par chainage cryptographique SHA-256 des enregistrements',
  'Conservation des donnees sur 10 annees glissantes minimum',
  'Archivage par clotures journaliere, mensuelle et annuelle scellees cryptographiquement',
  'Restitution sur demande au format CSV, JSON et PDF avec manifest d\'integrite',
  'Journal des Evenements Techniques (JET) tracant les actions sensibles',
];

const SCOPE_NOT_COVERED = [
  'Generation des factures (geree par chaque app consommatrice)',
  'Transmission des factures electroniques B2B vers les Plateformes Agreees',
  'Gestion comptable au sens de l\'enregistrement comptable',
  'Tickets de caisse imprimes sur supports physiques',
];

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Genere le PDF d'attestation individuelle pour un workspace.
 *
 * Le Volet 1 (editeur) est pre-rempli par le SDK.
 * Le Volet 2 (utilisateur) est pre-rempli avec les infos du workspace.
 *
 * @returns AttestationDocument avec le buffer PDF et les metadonnees
 */
export async function generateAttestation(
  input: AttestationInput,
): Promise<AttestationDocument> {
  const generatedAt = new Date().toISOString();
  const attestationId = `att-${input.workspaceId}-${MODULE_VERSION}-${Date.now()}`;
  const specimen = input.specimen !== false; // default true (pre-v1.0.0 safety)

  const pdfBuffer = await renderAttestationPdf(input, specimen);
  const pdfHash = createHash('sha256').update(pdfBuffer).digest('hex');

  return {
    attestationId,
    workspaceId: input.workspaceId,
    moduleVersion: MODULE_VERSION,
    pdfBuffer,
    pdfHash,
    generatedAt,
    specimen,
    volet2Status: 'pending',
  };
}

// ─── PDF Rendering ───────────────────────────────────────────────────

async function renderAttestationPdf(
  input: AttestationInput,
  specimen: boolean,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        info: {
          Title: `Attestation editeur art. 286 CGI — ${input.raisonSociale}`,
          Author: `${EDITOR.name} ${EDITOR.forme}`,
          Subject: 'Attestation individuelle art. 286 I 3°bis CGI',
          Creator: `${SOFTWARE.package} v${MODULE_VERSION}`,
        },
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const PAGE_WIDTH = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // ── SPECIMEN watermark on every page ──
      if (specimen) {
        doc.on('pageAdded', () => addSpecimenWatermark(doc));
        addSpecimenWatermark(doc);
      }

      // ── VOLET 1 — Editeur ──

      doc.fontSize(16).font('Helvetica-Bold')
        .text('VOLET 1 — ATTESTATION EDITEUR', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica-Bold')
        .text(
          'Attestation individuelle relative a l\'utilisation d\'un logiciel ou d\'un systeme de caisse securise',
          { align: 'center' },
        );
      doc.moveDown(1);

      // Editor identity
      doc.fontSize(10).font('Helvetica');
      doc.text(
        `Je soussigne, ${EDITOR.dirigeant}, representant legal de la societe ${EDITOR.name} ` +
        `(${EDITOR.forme} au capital de ${EDITOR.capital} EUR, SIREN ${EDITOR.siren}, ` +
        `dont le siege social est situe ${EDITOR.siege}), editeur du logiciel / systeme de caisse :`,
      );
      doc.moveDown(0.5);

      doc.font('Helvetica-Bold')
        .text(`${SOFTWARE.name} (${SOFTWARE.package})`, { indent: 20 });
      doc.font('Helvetica')
        .text(SOFTWARE.description, { indent: 20 });
      doc.moveDown(0.5);

      doc.text(
        `atteste que les fonctionnalites de caisse de ce logiciel, dans sa version n\u00b0 ${MODULE_VERSION}, ` +
        'satisfont aux conditions d\'inalterabilite, de securisation, de conservation et ' +
        'd\'archivage des donnees en vue du controle de l\'administration fiscale, prevues au ' +
        '3\u00b0 bis du I de l\'article 286 du code general des impots.',
      );
      doc.moveDown(0.5);

      const majorVersion = MODULE_VERSION.split('.')[0];
      doc.text(
        `J'atteste que la derniere version majeure de ce logiciel est identifiee avec la racine : ` +
        `${majorVersion}.0.0 et que les versions mineures developpees ulterieurement sont ou seront ` +
        `identifiees par les subdivisions de cette racine.`,
      );
      doc.moveDown(1);

      // Scope covered
      doc.font('Helvetica-Bold').text('Perimetre couvert par cette attestation');
      doc.moveDown(0.3);
      doc.font('Helvetica');
      for (const item of (input.scopeOverride ?? SCOPE_COVERED)) {
        doc.text(`  \u2022 ${item}`, { indent: 10 });
      }
      doc.moveDown(0.5);

      // Scope NOT covered
      doc.font('Helvetica-Bold').text('Perimetre NON couvert par cette attestation');
      doc.moveDown(0.3);
      doc.font('Helvetica');
      for (const item of SCOPE_NOT_COVERED) {
        doc.text(`  \u2022 ${item}`, { indent: 10 });
      }
      doc.moveDown(1);

      // Legal warning
      drawLegalWarning(doc, PAGE_WIDTH);
      doc.moveDown(1);

      // Signature block
      doc.font('Helvetica');
      doc.text(`Fait a : ________________`);
      doc.text(`Le : ${formatDateFR(new Date())}`);
      doc.moveDown(0.5);
      doc.text('Signature et tampon de la societe editrice :');
      doc.moveDown(0.5);
      doc.text(`${EDITOR.dirigeant}`);
      doc.text(`${EDITOR.qualite}`);
      doc.text(EDITOR.name);

      // ── Page break before Volet 2 ──
      doc.addPage();

      // ── VOLET 2 — Utilisateur ──

      doc.fontSize(16).font('Helvetica-Bold')
        .text('VOLET 2 — ATTESTATION UTILISATEUR', { align: 'center' });
      doc.moveDown(1);

      doc.fontSize(10).font('Helvetica');
      doc.text(
        `Je soussigne, [NOM Prenom du dirigeant utilisateur], representant legal de la societe / ` +
        `entreprise individuelle ${input.raisonSociale}, SIRET ${input.siret}, certifie avoir ` +
        `acquis ou telecharge le ${formatDateFR(input.startDate)}, aupres de ${EDITOR.name}, ` +
        `le logiciel / systeme de caisse mentionne au volet 1 de cette attestation.`,
      );
      doc.moveDown(0.5);

      doc.text(
        `J'atteste utiliser ce logiciel / systeme de caisse pour enregistrer les reglements ` +
        `de mes clients particuliers, conformement a la reglementation fiscale en vigueur, ` +
        `depuis le ${formatDateFR(input.startDate)}.`,
      );
      doc.moveDown(0.5);

      doc.text(`Le logiciel est utilise via l'application : `);
      doc.font('Helvetica-Bold')
        .text(`${input.consumerApp}, version ${input.consumerAppVersion}`, { indent: 20 });
      doc.moveDown(1);

      // Legal warning
      drawLegalWarning(doc, PAGE_WIDTH);
      doc.moveDown(1);

      // Signature block
      doc.font('Helvetica');
      doc.text(`Fait a : ________________`);
      doc.text(`Le : ________________`);
      doc.moveDown(0.5);
      doc.text('Signature de l\'utilisateur :');
      doc.moveDown(0.5);
      doc.text('[NOM Prenom]');
      doc.text('[Qualite — President, Gerant, Auto-entrepreneur, etc.]');

      // ── Footer metadata ──
      const pageCount = doc.bufferedPageRange().count;
      for (let i = 0; i < pageCount; i++) {
        doc.switchToPage(i);
        doc.fontSize(7).font('Helvetica')
          .text(
            `${SOFTWARE.package} v${MODULE_VERSION} | Genere le ${new Date().toISOString()} | Page ${i + 1}/${pageCount}`,
            doc.page.margins.left,
            doc.page.height - 40,
            { width: PAGE_WIDTH, align: 'center' },
          );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function addSpecimenWatermark(doc: PDFKit.PDFDocument): void {
  doc.save();
  doc.translate(doc.page.width / 2, doc.page.height / 2);
  doc.rotate(-45);
  doc.fontSize(72).font('Helvetica-Bold')
    .fillColor('red', 0.15)
    .text('SPECIMEN', -200, -40, { width: 400, align: 'center' });
  doc.restore();
}

function drawLegalWarning(doc: PDFKit.PDFDocument, _pageWidth: number): void {
  doc.font('Helvetica-BoldOblique').fontSize(9);
  doc.text(
    'Il est rappele que l\'etablissement d\'une fausse attestation est un delit penal ' +
    'passible de trois ans d\'emprisonnement et de 45 000 EUR d\'amende (code penal, art. 441-1). ' +
    'L\'usage d\'une fausse attestation est passible des memes peines.',
    { indent: 10 },
  );
  doc.font('Helvetica').fontSize(10);
}

function formatDateFR(date: Date): string {
  return date.toLocaleDateString('fr-FR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// ─── PDF summary report for exportPeriod(format='pdf') ──────────────

/**
 * Generates a human-readable PDF summary report for DGFIP inspection.
 * NOT a full data dump — that's CSV/JSON. This is a structured summary
 * showing period totals, closure chain status, and signature validity.
 */
export async function renderSummaryReportPdf(
  report: SummaryReportData,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
        info: {
          Title: `Rapport de synthese — ${report.workspaceId}`,
          Author: `${EDITOR.name} ${EDITOR.forme}`,
          Subject: 'Synthese d\'export DGFIP',
          Creator: `${SOFTWARE.package} v${MODULE_VERSION}`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Title
      doc.fontSize(16).font('Helvetica-Bold')
        .text('RAPPORT DE SYNTHESE — RESTITUTION DGFIP', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(9).font('Helvetica')
        .text(`${SOFTWARE.package} v${MODULE_VERSION} | Genere le ${report.generatedAt}`, { align: 'center' });
      doc.moveDown(1);

      // Period
      doc.fontSize(12).font('Helvetica-Bold').text('Periode');
      doc.fontSize(10).font('Helvetica');
      doc.text(`Du : ${report.periodFrom}`);
      doc.text(`Au : ${report.periodTo}`);
      doc.text(`Workspace : ${report.workspaceId}`);
      doc.moveDown(1);

      // Totals
      doc.fontSize(12).font('Helvetica-Bold').text('Totaux');
      doc.fontSize(10).font('Helvetica');
      doc.text(`Nombre d'encaissements : ${report.counts.encaissements}`);
      doc.text(`Nombre de corrections : ${report.counts.corrections}`);
      doc.text(`Nombre de clotures : ${report.counts.closures}`);
      doc.text(`Nombre d'evenements JET : ${report.counts.jet}`);
      doc.moveDown(1);

      // Totals by payment mode
      if (report.totalsByMode.length > 0) {
        doc.fontSize(12).font('Helvetica-Bold').text('Totaux par mode de paiement');
        doc.fontSize(10).font('Helvetica');
        for (const entry of report.totalsByMode) {
          const euros = (entry.totalCentimes / 100).toFixed(2);
          doc.text(`  ${entry.mode} : ${entry.count} operations, ${euros} EUR`);
        }
        doc.moveDown(1);
      }

      // Totals by TVA code
      if (report.totalsByTva.length > 0) {
        doc.fontSize(12).font('Helvetica-Bold').text('Totaux par code TVA');
        doc.fontSize(10).font('Helvetica');
        for (const entry of report.totalsByTva) {
          const euros = (entry.totalCentimes / 100).toFixed(2);
          doc.text(`  ${entry.tvaCode} : ${entry.count} operations, ${euros} EUR`);
        }
        doc.moveDown(1);
      }

      // Closure chain status
      doc.fontSize(12).font('Helvetica-Bold').text('Etat des chaines de cloture');
      doc.fontSize(10).font('Helvetica');
      for (const chain of report.closureChains) {
        const status = chain.valid ? 'VALIDE' : 'INVALIDE';
        doc.text(`  ${chain.stream} : ${chain.count} clotures — chaine ${status}`);
      }
      doc.moveDown(1);

      // Signature status
      doc.fontSize(12).font('Helvetica-Bold').text('Etat des signatures');
      doc.fontSize(10).font('Helvetica');
      doc.text(`Signatures verifiees : ${report.signatureStatus.verified} / ${report.signatureStatus.total}`);
      if (report.signatureStatus.errors.length > 0) {
        doc.text('Erreurs :');
        for (const err of report.signatureStatus.errors) {
          doc.text(`  - ${err}`, { indent: 10 });
        }
      }

      // Footer
      doc.moveDown(2);
      doc.fontSize(8).font('Helvetica')
        .text(
          'Ce document est un rapport de synthese genere par le logiciel. ' +
          'Les donnees completes sont disponibles aux formats CSV et JSON.',
          { align: 'center' },
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Types ────────────────────────────────────────────────────────────

export interface AttestationInput {
  /** Workspace pour lequel generer l'attestation */
  workspaceId: string;
  /** Raison sociale du workspace */
  raisonSociale: string;
  /** SIRET du workspace */
  siret: string;
  /** Nom de l'app consommatrice (ex: 'MyApp') */
  consumerApp: string;
  /** Version de l'app consommatrice */
  consumerAppVersion: string;
  /** Date de souscription / debut d'utilisation */
  startDate: Date;
  /** Perimetre fonctionnel couvert (surcharge le defaut si fourni) */
  scopeOverride?: string[];
  /**
   * Filigrane SPECIMEN. Default: true.
   * HARD RULE: must be true until the v1.0.0 editor attestation is signed.
   */
  specimen?: boolean;
}

export interface AttestationDocument {
  /** Identifiant unique de l'attestation */
  attestationId: string;
  /** Workspace */
  workspaceId: string;
  /** Version du module attestee */
  moduleVersion: string;
  /** Buffer PDF */
  pdfBuffer: Buffer;
  /** Hash SHA-256 du PDF genere */
  pdfHash: string;
  /** Date de generation (ISO 8601) */
  generatedAt: string;
  /** true si le PDF porte le filigrane SPECIMEN */
  specimen: boolean;
  /** Statut du Volet 2 */
  volet2Status: 'pending' | 'signed';
}

export interface SummaryReportData {
  workspaceId: string;
  periodFrom: string;
  periodTo: string;
  generatedAt: string;
  counts: {
    encaissements: number;
    corrections: number;
    closures: number;
    jet: number;
  };
  totalsByMode: { mode: string; count: number; totalCentimes: number }[];
  totalsByTva: { tvaCode: string; count: number; totalCentimes: number }[];
  closureChains: { stream: string; count: number; valid: boolean }[];
  signatureStatus: {
    total: number;
    verified: number;
    errors: string[];
  };
}
