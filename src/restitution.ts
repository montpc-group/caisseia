/**
 * Restitution / export DGFIP.
 *
 * Cf. COMPLIANCE.md § 5 (Restitution) et BOI-CF-COM-20-60.
 *
 * Génère un export complet et vérifiable des données d'encaissement
 * d'une période donnée. L'export est auto-portant : il inclut le
 * registre de clés publiques pour permettre la vérification offline
 * des signatures, même des années après la rotation des clés.
 */

import { read } from './eventStore.js';
import type { EventRecord } from './eventStore.js';
import { hash, canonicalize, GENESIS_HASH, verifyClosureSignature } from './crypto.js';
import { logTechnicalEvent } from './jet.js';
import type { TxOptions } from './storage/EventStorage.js';
import { loadRegistry, type KeyRegistry } from './crypto/keyRegistry.js';
import { chainHeadFailures, closureLinkBroken, elapsedDaysWithoutClosure, legacyClosureWarnings } from './integrity.js';
import { renderSummaryReportPdf, type SummaryReportData } from './attestation.js';
import type { EncaissementStreamPayload } from '../schemas/encaissement.schema.js';
import type { ClosurePayloadZ } from '../schemas/cloture.schema.js';
import type { JetPayloadZ } from '../schemas/jet.schema.js';
import { MODULE_VERSION } from './index.js';

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Génère un export DGFIP pour une période et un format donnés.
 *
 * L'export est un objet structuré contenant tous les flux de la période,
 * un manifest d'intégrité avec SHA-256 de chaque section, et une copie
 * du registre de clés publiques pour vérification offline.
 *
 * @param workspaceId - identifiant du workspace (multi-tenant)
 * @param from - début de période (inclusive)
 * @param to - fin de période (inclusive)
 * @param format - 'csv' | 'json' | 'pdf'
 * @param opts - `client` : lectures et entrées JET sur la connexion de
 *   l'appelant, dans sa transaction (indispensable sous RLS) ; jamais relâchée
 */
export async function exportPeriod(
  workspaceId: string,
  from: Date,
  to: Date,
  format: ExportFormat = 'json',
  opts: TxOptions = {},
): Promise<ExportResult> {
  const tx: TxOptions = opts.client ? { client: opts.client } : {};
  const client = tx.client;
  if (from > to) {
    throw new Error('NF525_RESTITUTION: from must be <= to');
  }

  await logTechnicalEvent(workspaceId, 'export_requested', {
    periodFrom: from.toISOString(),
    periodTo: to.toISOString(),
    format,
  }, {}, tx);

  const fromISO = from.toISOString();
  const toISO = to.toISOString();

  // Read all streams for the period
  const encaissements = await read<EncaissementStreamPayload>('encaissement', workspaceId, { from, to, client });
  const closuresDays = await read<ClosurePayloadZ>('closure-day', workspaceId, { client });
  const closuresMonths = await read<ClosurePayloadZ>('closure-month', workspaceId, { client });
  const closuresYears = await read<ClosurePayloadZ>('closure-year', workspaceId, { client });
  const jetEvents = await read<JetPayloadZ>('jet', workspaceId, { from, to, client });

  // Filter closures to the period (closures don't use recordedAt for period membership —
  // they use payload.periodStart/periodEnd)
  const filterClosures = (records: EventRecord<ClosurePayloadZ>[]) =>
    records.filter((r) => r.payload.periodStart >= fromISO && r.payload.periodEnd <= toISO);

  const closures = [
    ...filterClosures(closuresDays),
    ...filterClosures(closuresMonths),
    ...filterClosures(closuresYears),
  ];

  // Separate originals and corrections
  const originals = encaissements.filter((r) => r.payload.type === 'encaissement');
  const corrections = encaissements.filter((r) => r.payload.type === 'correction');

  // Load key registry for offline verification
  const keyRegistry = await loadRegistry();

  // Build export files
  const files: ExportFile[] = [];

  if (format === 'csv') {
    const csvContent = generateCsv(encaissements);
    files.push({
      name: 'encaissements.csv',
      content: csvContent,
      hash: hash(csvContent),
    });
  }

  if (format === 'json') {
    const encJson = JSON.stringify(encaissements, null, 2);
    files.push({
      name: 'encaissements.json',
      content: encJson,
      hash: hash(encJson),
    });

    const corrJson = JSON.stringify(corrections, null, 2);
    files.push({
      name: 'corrections.json',
      content: corrJson,
      hash: hash(corrJson),
    });

    const closJson = JSON.stringify(closures, null, 2);
    files.push({
      name: 'closures.json',
      content: closJson,
      hash: hash(closJson),
    });

    const jetJson = JSON.stringify(jetEvents, null, 2);
    files.push({
      name: 'jet.json',
      content: jetJson,
      hash: hash(jetJson),
    });
  }

  if (format === 'pdf') {
    // COMPLIANCE.md § 5 — Human-readable summary report for inspectors
    const reportData = buildSummaryReportData(
      workspaceId, fromISO, toISO, originals, corrections, closures, jetEvents,
    );
    const pdfBuffer = await renderSummaryReportPdf(reportData);
    const pdfContent = pdfBuffer.toString('base64');
    files.push({
      name: 'rapport-synthese.pdf',
      content: pdfContent,
      hash: hash(pdfContent),
    });
  }

  // Always include the key registry snapshot
  const keyRegJson = JSON.stringify(keyRegistry, null, 2);
  files.push({
    name: 'public-keys.json',
    content: keyRegJson,
    hash: hash(keyRegJson),
  });

  // Build manifest
  const manifest = generateManifest(
    workspaceId,
    fromISO,
    toISO,
    format,
    files,
  );

  await logTechnicalEvent(workspaceId, 'export_completed', {
    periodFrom: fromISO,
    periodTo: toISO,
    format,
    fileCount: files.length,
    encaissementCount: originals.length,
    correctionCount: corrections.length,
    closureCount: closures.length,
    jetEventCount: jetEvents.length,
  }, {}, tx);

  return {
    manifest,
    files,
    data: {
      encaissements: originals,
      corrections,
      closures,
      jet: jetEvents,
      keyRegistry,
    },
  };
}

/**
 * Génère un manifest d'intégrité pour un ensemble de fichiers exportés.
 *
 * Le manifest inclut le SHA-256 de chaque fichier + un hash global
 * du manifest lui-même pour détection de tampering.
 */
export function generateManifest(
  workspaceId: string,
  periodFrom: string,
  periodTo: string,
  format: ExportFormat,
  files: ExportFile[],
): ExportManifest {
  const generatedAt = new Date().toISOString();
  const fileEntries = files.map((f) => ({
    name: f.name,
    size: Buffer.byteLength(f.content, 'utf-8'),
    hash: f.hash,
  }));

  const manifestSkeleton = {
    moduleVersion: MODULE_VERSION,
    workspaceId,
    periodFrom,
    periodTo,
    format,
    generatedAt,
    files: fileEntries,
  };

  const manifestHash = hash(canonicalize(manifestSkeleton));

  return {
    ...manifestSkeleton,
    manifestHash,
  };
}

/**
 * Vérifie l'intégrité d'un export DGFIP.
 *
 * Recalcule le hash de chaque fichier, vérifie contre le manifest,
 * puis vérifie les chaînes de hash et les signatures des clôtures.
 *
 * Les signatures sont vérifiées contre le registre de clés DE CONFIANCE
 * (`options.keyRegistry`, sinon le registre chargé) — pas contre la copie
 * incluse dans l'export, qu'un attaquant pourrait remplacer. Registre absent
 * ou vide (dans l'export ou côté vérificateur) → export invalide.
 *
 * Peut être exécuté offline — aucun accès à la base requis.
 *
 * @param exportResult - le résultat d'un exportPeriod précédent
 * @param options.keyRegistry - registre de confiance (ex : public-keys.json publié par l'éditeur)
 * @param options.now - date de vérification (défaut : maintenant) ; les jours UTC antérieurs sont « écoulés »
 */
export async function verifyExportIntegrity(
  exportResult: ExportResult,
  options: { keyRegistry?: KeyRegistry; now?: Date } = {},
): Promise<ExportIntegrityResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { manifest, files, data } = exportResult;

  // 1. Verify each file hash matches the manifest
  for (const manifestFile of manifest.files) {
    const file = files.find((f) => f.name === manifestFile.name);
    if (!file) {
      errors.push(`Fichier manquant : ${manifestFile.name}`);
      continue;
    }
    const recomputed = hash(file.content);
    if (recomputed !== manifestFile.hash) {
      errors.push(
        `Hash modifié pour ${manifestFile.name} : attendu ${manifestFile.hash}, obtenu ${recomputed}`,
      );
    }
  }

  // 2. Verify manifest hash
  const { manifestHash: _ignore, ...skeletonFields } = manifest;
  const recomputedManifestHash = hash(canonicalize(skeletonFields));
  if (recomputedManifestHash !== manifest.manifestHash) {
    errors.push('Hash du manifest modifié');
  }

  // 3. Verify chain integrity on each stream present in the export
  if (data) {
    // Verify encaissement chain
    const allEnc = [...data.encaissements, ...data.corrections].sort(
      (a, b) => a.sequence - b.sequence,
    );
    verifyChainOnRecords(allEnc, 'encaissement', errors);

    // Verify closure chains
    const closuresByType = groupClosuresByStream(data.closures);
    for (const [stream, records] of Object.entries(closuresByType)) {
      verifyChainOnRecords(records, stream, errors);
    }

    // Verify JET chain
    verifyChainOnRecords(data.jet, 'jet', errors);

    // 4. Verify closure signatures — never skipped. The bundled registry must be
    //    present, and signatures are checked against the TRUSTED registry
    //    (options.keyRegistry, else the verifier's loaded registry), not the
    //    bundled copy an attacker could swap along with the data.
    const trusted = options.keyRegistry ?? (await loadRegistry());
    if (!data.keyRegistry?.keys?.length || !trusted?.keys?.length) {
      errors.push('Registre de clés absent ou vide : signatures des clôtures non vérifiables');
    } else {
      for (const closure of data.closures) {
        const failure = await verifyClosureSignature(closure.payload, trusted);
        if (failure === 'signature invalid') {
          errors.push(`Signature invalide pour clôture ${closure._id}`);
        } else if (failure) {
          errors.push(`Erreur vérification signature ${closure._id}: ${failure}`);
        } else {
          // 5. NF-11: signed chain heads vs the exported (hash-verified) records.
          const byStream = { encaissement: allEnc, jet: data.jet };
          for (const f of chainHeadFailures(closure.payload.chainHeads, byStream, true)) {
            errors.push(`Tête de chaîne ${f} — clôture ${closure._id}`);
          }
          if (closureLinkBroken(closure)) {
            errors.push(`Chaîne des clôtures rompue : previousClosureHash signé ≠ clôture précédente — clôture ${closure._id}`);
          }
        }
      }
    }
    // 6. NF-11: every elapsed day fully inside the export window that has
    //    records must have its day closure in the export.
    const unclosed = elapsedDaysWithoutClosure(
      [...allEnc, ...data.jet],
      data.closures.filter((c) => c.stream === 'closure-day'),
      options.now ?? new Date(),
      { from: manifest.periodFrom, to: manifest.periodTo },
    );
    if (unclosed.length) {
      errors.push(`Jour(s) écoulé(s) avec enregistrements sans clôture journalière : ${unclosed.join(', ')}`);
    }
    warnings.push(...legacyClosureWarnings(data.closures));
  } else {
    errors.push('Données absentes de l\'export : chaînes et signatures non vérifiables');
  }

  return {
    valid: errors.length === 0,
    fullyVerified: errors.length === 0 && warnings.length === 0,
    manifest,
    errors: errors.length > 0 ? errors : undefined,
    ...(warnings.length ? { warnings } : {}),
  };
}

// ─── Internals ────────────────────────────────────────────────────────

function buildSummaryReportData(
  workspaceId: string,
  periodFrom: string,
  periodTo: string,
  originals: EventRecord<EncaissementStreamPayload>[],
  corrections: EventRecord<EncaissementStreamPayload>[],
  closures: EventRecord<ClosurePayloadZ>[],
  jetEvents: EventRecord<JetPayloadZ>[],
): SummaryReportData {
  // Totals by payment mode (from originals only — corrections don't carry a mode)
  const modeMap = new Map<string, { count: number; totalCentimes: number }>();
  for (const r of originals) {
    if (r.payload.type === 'encaissement') {
      const mode = r.payload.data.mode;
      const entry = modeMap.get(mode) ?? { count: 0, totalCentimes: 0 };
      entry.count++;
      entry.totalCentimes += r.payload.data.montantCentimes;
      modeMap.set(mode, entry);
    }
  }

  // Totals by TVA code
  const tvaMap = new Map<string, { count: number; totalCentimes: number }>();
  for (const r of originals) {
    if (r.payload.type === 'encaissement') {
      const tva = r.payload.data.tvaCode;
      const entry = tvaMap.get(tva) ?? { count: 0, totalCentimes: 0 };
      entry.count++;
      entry.totalCentimes += r.payload.data.montantCentimes;
      tvaMap.set(tva, entry);
    }
  }

  // Closure chain validity (simple: check previousHash linkage within export)
  const closuresByStream = groupClosuresByStream(closures);
  const closureChains = Object.entries(closuresByStream).map(([stream, records]) => {
    const errors: string[] = [];
    verifyChainOnRecords(records, stream, errors);
    return { stream, count: records.length, valid: errors.length === 0 };
  });

  return {
    workspaceId,
    periodFrom,
    periodTo,
    generatedAt: new Date().toISOString(),
    counts: {
      encaissements: originals.length,
      corrections: corrections.length,
      closures: closures.length,
      jet: jetEvents.length,
    },
    totalsByMode: [...modeMap.entries()].map(([mode, v]) => ({ mode, ...v })),
    totalsByTva: [...tvaMap.entries()].map(([tvaCode, v]) => ({ tvaCode, ...v })),
    closureChains,
    signatureStatus: {
      total: closures.length,
      verified: closures.filter((c) => c.payload.signature).length,
      errors: [],
    },
  };
}

function verifyChainOnRecords(
  records: EventRecord<unknown>[],
  streamLabel: string,
  errors: string[],
): void {
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const expectedPrev = i === 0 ? GENESIS_HASH : records[i - 1]!.hash;

    // Chain linkage: previousHash must match predecessor's hash.
    // NOTE: we only check continuity within the exported window.
    // The first record in the export may have a previousHash pointing
    // to a record outside the window — that's expected.
    if (i > 0 && r.previousHash !== expectedPrev) {
      errors.push(
        `Rupture de chaîne ${streamLabel} à séquence ${r.sequence}: previousHash mismatch`,
      );
    }

    // Recompute own hash
    const skeleton = {
      _id: r._id,
      stream: r.stream,
      sequence: r.sequence,
      workspaceId: r.workspaceId,
      previousHash: r.previousHash,
      recordedAt: r.recordedAt,
      payload: r.payload,
    };
    const recomputed = hash(canonicalize(skeleton));
    if (recomputed !== r.hash) {
      errors.push(
        `Hash altéré ${streamLabel} à séquence ${r.sequence}: attendu ${recomputed}, obtenu ${r.hash}`,
      );
    }
  }
}

function groupClosuresByStream(
  closures: EventRecord<ClosurePayloadZ>[],
): Record<string, EventRecord<ClosurePayloadZ>[]> {
  const result: Record<string, EventRecord<ClosurePayloadZ>[]> = {};
  for (const c of closures) {
    const stream = c.stream as string;
    if (!result[stream]) result[stream] = [];
    result[stream].push(c);
  }
  // Sort each group by sequence
  for (const records of Object.values(result)) {
    records.sort((a, b) => a.sequence - b.sequence);
  }
  return result;
}

/**
 * Generates a CSV export of encaissements.
 * One line per record (encaissement or correction), columns standardized,
 * parsable by Excel/LibreOffice (semicolon delimiter for FR locale).
 */
function generateCsv(records: EventRecord<EncaissementStreamPayload>[]): string {
  const SEP = ';';
  const headers = [
    'id',
    'sequence',
    'type',
    'recordedAt',
    'montantCentimes',
    'devise',
    'mode',
    'tvaCode',
    'originalId',
    'correctionType',
    'reason',
    'factureId',
    'reservationId',
    'clientRef',
    'stripeRef',
    'notes',
    'previousHash',
    'hash',
  ];

  const lines = [headers.join(SEP)];

  for (const r of records) {
    const p = r.payload;
    let row: string[];
    if (p.type === 'encaissement') {
      const d = p.data;
      row = [
        csvEscape(r._id),
        String(r.sequence),
        'encaissement',
        r.recordedAt,
        String(d.montantCentimes),
        d.devise,
        d.mode,
        d.tvaCode,
        '', '', '', // originalId, correctionType, reason
        csvEscape(d.factureId ?? ''),
        csvEscape(d.reservationId ?? ''),
        csvEscape(d.clientRef ?? ''),
        csvEscape(d.stripeRef ?? ''),
        csvEscape(d.notes ?? ''),
        r.previousHash,
        r.hash,
      ];
    } else {
      const d = p.data;
      row = [
        csvEscape(r._id),
        String(r.sequence),
        'correction',
        r.recordedAt,
        String(d.montantCentimes),
        d.devise,
        '', '', // mode, tvaCode
        d.originalId,
        d.type,
        csvEscape(d.reason),
        '', '', '', '', '', // factureId..notes
        r.previousHash,
        r.hash,
      ];
    }
    lines.push(row.join(SEP));
  }

  return lines.join('\n');
}

function csvEscape(value: string): string {
  if (value.includes(';') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

// ─── Types ────────────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'json' | 'pdf';

export interface ExportFile {
  name: string;
  content: string;
  hash: string;
}

export interface ExportManifest {
  moduleVersion: string;
  workspaceId: string;
  periodFrom: string;
  periodTo: string;
  format: ExportFormat;
  generatedAt: string;
  files: { name: string; size: number; hash: string }[];
  manifestHash: string;
}

export interface ExportResult {
  manifest: ExportManifest;
  files: ExportFile[];
  data: {
    encaissements: EventRecord<EncaissementStreamPayload>[];
    corrections: EventRecord<EncaissementStreamPayload>[];
    closures: EventRecord<ClosurePayloadZ>[];
    jet: EventRecord<JetPayloadZ>[];
    keyRegistry: KeyRegistry;
  };
}

export interface ExportIntegrityResult {
  valid: boolean;
  /** valid ET aucune clôture v1 legacy non couverte (cf. IntegrityReport.fullyVerified) */
  fullyVerified: boolean;
  /** Avertissements (ex : « legacy closure, chain head not signed ») */
  warnings?: string[];
  manifest: ExportManifest;
  errors?: string[];
}
