/**
 * Vérification d'intégrité des chaînes hashées.
 *
 * Cf. COMPLIANCE.md § 2 (Sécurisation).
 *
 * Permet de détecter toute altération des données en base depuis
 * la dernière vérification. À exécuter périodiquement (cron quotidien)
 * et avant chaque export DGFIP.
 */

import { hash, canonicalize, GENESIS_HASH, verifyClosureSignature } from './crypto.js';
import { loadRegistry, type KeyRegistry } from './crypto/keyRegistry.js';
import { read } from './eventStore.js';
import type { StreamName, EventRecord } from './eventStore.js';
import { logTechnicalEvent } from './jet.js';
import type { TxOptions } from './storage/EventStorage.js';
import { CHAIN_HEAD_STREAMS, type ChainHeads } from '../schemas/cloture.schema.js';

const CHECKED_STREAMS: StreamName[] = [
  'encaissement',
  'jet',
  'closure-day',
  'closure-month',
  'closure-year',
];

/**
 * Vérifie l'intégrité de tous les flux d'un workspace.
 * Détecte les ruptures de chaîne (hash invalide, séquence manquante) et,
 * pour les flux de clôture (seuls enregistrements signés), vérifie la
 * signature Ed25519 de chaque clôture contre le registre de clés.
 *
 * Le registre est `options.keyRegistry` sinon le registre chargé
 * (NF525_KEY_REGISTRY_PATH / keys/public-keys.json). Registre absent ou
 * vide → rapport invalide (`error`), jamais de vérification ignorée.
 *
 * `options.client` : lectures et entrée JET sur la connexion de l'appelant,
 * dans sa transaction (indispensable sous RLS) ; jamais relâchée par le SDK.
 */
export async function verifyChainIntegrity(
  workspaceId: string,
  options: { keyRegistry?: KeyRegistry; now?: Date } & TxOptions = {},
): Promise<IntegrityReport> {
  const tx: TxOptions = options.client ? { client: options.client } : {};
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  const streamReports: IntegrityReport['streams'] = [];
  const registry = options.keyRegistry ?? (await loadRegistry());
  const errors: string[] = registry?.keys?.length
    ? []
    : ['NF525_INTEGRITY: key registry is empty or missing — closure signatures cannot be verified'];
  const registryOk = errors.length === 0;

  const byStream: Record<string, EventRecord<unknown>[]> = {};
  const closures: EventRecord<ClosureLike>[] = [];
  for (const stream of CHECKED_STREAMS) {
    const records = await read<unknown>(stream, workspaceId, { client: tx.client });
    byStream[stream] = records;
    let r = verifySingleStream(stream, records);
    if (stream.startsWith('closure-')) {
      closures.push(...(records as EventRecord<ClosureLike>[]));
      if (r.valid && registryOk) r = await verifyClosures(stream, records, registry, byStream);
    }
    streamReports.push(r);
  }

  const unclosed = elapsedDaysWithoutClosure(
    [...byStream['encaissement']!, ...byStream['jet']!],
    byStream['closure-day']! as EventRecord<{ periodStart: string }>[],
    now,
  );
  if (unclosed.length) {
    errors.push(`NF525_INTEGRITY: elapsed day(s) with records but no day closure: ${unclosed.join(', ')}`);
  }
  const error = errors.length ? errors.join(' | ') : undefined;
  const valid = !error && streamReports.every((s) => s.valid);
  const warnings = legacyClosureWarnings(closures);
  const report: IntegrityReport = {
    workspaceId,
    checkedAt,
    valid,
    fullyVerified: valid && warnings.length === 0,
    ...(error ? { error } : {}),
    ...(warnings.length ? { warnings } : {}),
    streams: streamReports,
  };

  // Log to JET — but only if the JET stream itself is sane, to avoid
  // an infinite loop when JET is the broken chain.
  const jetReport = streamReports.find((s) => s.name === 'jet');
  const jetSane = jetReport?.valid ?? false;
  if (jetSane) {
    await logTechnicalEvent(
      workspaceId,
      valid ? 'integrity_check_run' : 'integrity_check_failed',
      {
        streams: streamReports.map((s) => ({
          name: s.name,
          valid: s.valid,
          recordsChecked: s.recordsChecked,
          ...(s.brokenAt !== undefined ? { brokenAt: s.brokenAt } : {}),
          ...(s.reason !== undefined ? { reason: s.reason } : {}),
        })),
        ...(error ? { error } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
      {},
      tx,
    );
  }

  return report;
}

function verifySingleStream(
  name: StreamName,
  records: EventRecord<unknown>[],
): IntegrityReport['streams'][number] {
  // Records are already ordered by sequence ASC.
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const expectedSeq = i + 1;
    if (r.sequence !== expectedSeq) {
      return {
        name,
        valid: false,
        recordsChecked: i,
        brokenAt: i,
        reason: `sequence gap: expected ${expectedSeq}, got ${r.sequence}`,
      };
    }
    const expectedPrev = i === 0 ? GENESIS_HASH : records[i - 1]!.hash;
    if (r.previousHash !== expectedPrev) {
      return {
        name,
        valid: false,
        recordsChecked: i,
        brokenAt: i,
        reason: `previousHash mismatch at sequence ${r.sequence}`,
      };
    }
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
      return {
        name,
        valid: false,
        recordsChecked: i,
        brokenAt: i,
        reason: `payload hash mismatch at sequence ${r.sequence}`,
      };
    }
  }
  return { name, valid: true, recordsChecked: records.length };
}

async function verifyClosures(
  name: StreamName,
  records: EventRecord<unknown>[],
  registry: KeyRegistry,
  byStream: Record<string, EventRecord<unknown>[]>,
): Promise<IntegrityReport['streams'][number]> {
  for (let i = 0; i < records.length; i++) {
    const r = records[i] as EventRecord<ClosureLike>;
    const failure = await verifyClosureSignature(r.payload, registry);
    const headFailure = failure ? [] : chainHeadFailures(r.payload.chainHeads, byStream, false);
    const linkFailure = !failure && closureLinkBroken(r);
    if (failure || headFailure.length || linkFailure) {
      return {
        name,
        valid: false,
        recordsChecked: i,
        brokenAt: i,
        reason: failure
          ? `signature invalid at sequence ${r.sequence}: ${failure}`
          : headFailure.length
            ? `chain head mismatch: ${headFailure.join('; ')} (closure sequence ${r.sequence})`
            : `closure chain broken at sequence ${r.sequence}: signed previousClosureHash differs from the previous closure`,
      };
    }
  }
  return { name, valid: true, recordsChecked: records.length };
}

type ClosureLike = Parameters<typeof verifyClosureSignature>[0] & { chainHeads?: ChainHeads };

/**
 * NF-11 closure chain: a v2 closure's signed previousClosureHash must equal the
 * record's store link (previousHash). The store link itself is checked against
 * the previous record (verifySingleStream / verifyChainOnRecords), so the two
 * together verify the signed closure chain end to end. v1 closures: no link signed.
 */
export function closureLinkBroken(r: EventRecord<{ previousClosureHash?: string; schemaVersion?: number }>): boolean {
  return r.payload.schemaVersion !== undefined && r.payload.previousClosureHash !== r.previousHash;
}

/**
 * NF-11: compare each signed chain head with the recomputed (already
 * hash-verified) stream. `partial` = the records are an export window: a head
 * before the first exported record is outside the window and not checkable.
 * Returns one `<stream> …` line per mismatch (empty = ok, or v1 closure).
 */
export function chainHeadFailures(
  heads: ChainHeads | undefined,
  byStream: Record<string, EventRecord<unknown>[]>,
  partial: boolean,
): string[] {
  if (!heads) return [];
  const out: string[] = [];
  for (const stream of CHAIN_HEAD_STREAMS) {
    const head = heads[stream];
    const recs = byStream[stream] ?? [];
    if (head.sequence === 0) {
      if (head.hash !== GENESIS_HASH) out.push(`${stream} at sequence 0: hash is not genesis`);
      continue;
    }
    if (partial && (recs.length === 0 || head.sequence < recs[0]!.sequence)) continue;
    const rec = recs.find((x) => x.sequence === head.sequence);
    if (!rec) out.push(`${stream} at sequence ${head.sequence}: signed record missing`);
    else if (rec.hash !== head.hash) out.push(`${stream} at sequence ${head.sequence}: hash differs from signed head`);
  }
  return out;
}

/**
 * NF-11: elapsed days (UTC calendar day strictly before `now`'s UTC day — the
 * closures' own UTC day bounds) with encaissement/JET records but no day
 * closure. Deleting the newest day closure leaves exactly that. `window`
 * (export): only days entirely inside [from, to] are checkable.
 */
export function elapsedDaysWithoutClosure(
  records: { recordedAt: string }[],
  dayClosures: EventRecord<{ periodStart: string }>[],
  now: Date,
  window?: { from: string; to: string },
): string[] {
  const today = now.toISOString().slice(0, 10);
  const closed = new Set(dayClosures.map((c) => c.payload.periodStart.slice(0, 10)));
  const days = new Set<string>();
  for (const r of records) {
    const d = new Date(r.recordedAt).toISOString().slice(0, 10);
    if (d >= today || closed.has(d)) continue;
    if (window && (`${d}T00:00:00.000Z` < window.from || `${d}T23:59:59.999Z` > window.to)) continue;
    days.add(d);
  }
  return [...days].sort();
}

/**
 * v1 closures (no schemaVersion) sign totals only, not chain heads. A v1
 * closure is superseded when a v2 closure exists with periodEnd ≥ its
 * periodEnd (that v2 head covers every record it covered). Each
 * non-superseded v1 closure yields one warning.
 */
export function legacyClosureWarnings(
  closures: EventRecord<{ periodEnd: string; schemaVersion?: number }>[],
): string[] {
  const v2End = closures
    .filter((c) => c.payload.schemaVersion !== undefined)
    .reduce((max, c) => (c.payload.periodEnd > max ? c.payload.periodEnd : max), '');
  return closures
    .filter((c) => c.payload.schemaVersion === undefined && c.payload.periodEnd > v2End)
    .map(
      (c) =>
        `legacy closure, chain head not signed: ${c.stream} sequence ${c.sequence} (period end ${c.payload.periodEnd}) — records it covers are not protected against rewrite + rechain`,
    );
}

// ─── Types ────────────────────────────────────────────────────────────

export interface IntegrityReport {
  workspaceId: string;
  checkedAt: string;
  /** Globalement valide (aucune rupture, signature ou tête de chaîne fausse) */
  valid: boolean;
  /**
   * valid ET aucune clôture v1 legacy non couverte par une clôture v2.
   * false + `warnings` = chaînes cohérentes mais pas entièrement protégées.
   */
  fullyVerified: boolean;
  /** Avertissements (ex : « legacy closure, chain head not signed ») */
  warnings?: string[];
  /**
   * Erreur(s) globale(s), jointes par « | » (registre de clés vide, jour écoulé
   * avec enregistrements sans clôture journalière) — rend le rapport invalide
   */
  error?: string;
  /** Rapport par flux */
  streams: {
    name: string;
    valid: boolean;
    recordsChecked: number;
    /** Si invalide : index du premier enregistrement défaillant */
    brokenAt?: number;
    /** Si invalide : raison */
    reason?: string;
  }[];
}
