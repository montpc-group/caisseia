/**
 * Clôtures périodiques.
 *
 * Cf. COMPLIANCE.md § 4 (Archivage).
 *
 * Trois niveaux : journalier (Z), mensuel, annuel.
 * Chaque clôture agrège la période, est scellée cryptographiquement (Ed25519
 * via le Signer actif), puis chaînée via l'event store dans son flux dédié
 * (`closure-day` / `closure-month` / `closure-year`).
 *
 * Une fois persistée, une clôture est immuable :
 *  - L'event store calcule un hash propre qui inclut la signature.
 *  - Tout tampering casse la chaîne (cf. tests/inalterabilite + Postgres triggers).
 *
 * NOTE TZ : M2 utilise des bornes UTC strictes (00:00:00.000Z → 23:59:59.999Z).
 *           Une variante TZ-aware est différée à M2.5 si une app consommatrice
 *           en a besoin — l'app peut déjà passer la date "déjà bucketed".
 */

import { append, read, getLast, withStreamLock } from './eventStore.js';
import type { EventRecord } from './eventStore.js';
import { canonicalize, signClosure, GENESIS_HASH } from './crypto.js';
import { logTechnicalEvent } from './jet.js';
import type { TxOptions } from './storage/EventStorage.js';
import {
  ClosurePayloadSchema,
  CLOSURE_SCHEMA_VERSION,
  CHAIN_HEAD_STREAMS,
  type ChainHeads,
  type ClosurePayloadZ,
} from '../schemas/cloture.schema.js';
import type { EncaissementStreamPayload } from '../schemas/encaissement.schema.js';

/**
 * `client` (toutes les clôtures) : lectures, scellement, écriture et entrées
 * JET sur la connexion de l'appelant, dans sa transaction, sous le verrou du
 * flux de clôture ; jamais relâchée par le SDK. Indispensable quand l'app
 * isole nf525_event par RLS : le pool du SDK n'y voit aucune ligne.
 */
export interface CloseOptions extends TxOptions {
  /**
   * Map `tvaCode → taux` (ex: `{ TVA20: 0.20, TVA10: 0.10 }`) optionnellement
   * fournie par l'app consommatrice pour ventiler HT/TVA. Si omise, la
   * ventilation est `ht = ttc, tva = 0` (l'agrégat reste exact en TTC).
   */
  tvaRates?: Record<string, number>;
}

// ─── Public API ───────────────────────────────────────────────────────

export async function closeDay(
  workspaceId: string,
  date: Date,
  options: CloseOptions = {},
): Promise<Closure> {
  return underClosureLock('closure-day', workspaceId, options, (tx) => closeDayLocked(workspaceId, date, options, tx));
}

async function closeDayLocked(
  workspaceId: string,
  date: Date,
  options: CloseOptions,
  tx: TxOptions,
): Promise<Closure> {
  const { startISO, endISO } = utcDayRange(date);

  await logTechnicalEvent(workspaceId, 'closure_day_initiated', {
    periodStart: startISO,
    periodEnd: endISO,
  }, {}, tx);

  const existing = await getCurrentDayClosure(workspaceId, date, tx);
  if (existing) {
    throw new Error(
      `NF525_CLOSURE: day ${startISO.slice(0, 10)} already closed (id=${existing._id})`,
    );
  }

  // Read the full encaissement stream once: we need every encaissement (any date)
  // to attribute mode/TVA to corrections that may target prior-day originals.
  const allEnc = await read<EncaissementStreamPayload>('encaissement', workspaceId, { client: tx.client });
  // A read that sees no row while the stream has a last record is a read on the
  // wrong connection (e.g. RLS without the caller's client): never seal it.
  if (allEnc.length === 0 && (await getLast('encaissement', workspaceId, tx))) {
    throw new Error(
      `NF525_CLOSURE: refusing to seal day ${startISO.slice(0, 10)}: the encaissement read returned 0 rows but the stream has records (pass the caller's client)`,
    );
  }
  const inWindow = allEnc.filter(
    (r) => r.recordedAt >= startISO && r.recordedAt <= endISO,
  );

  const aggregate = buildPeriodAggregate(allEnc, inWindow, options.tvaRates);

  // Cumul perpétuel = previous day closure's cumul + this day's net CA.
  const previousDay = await getLast<ClosurePayloadZ>('closure-day', workspaceId, tx);
  const previousCumul = previousDay?.payload.aggregate.cumulPerpetuel ?? 0;
  aggregate.cumulPerpetuel = previousCumul + aggregate.caTotalCentimes;

  const payload = await sealAndBuildPayload(workspaceId, 'day', startISO, endISO, aggregate, tx);
  const record = await append<ClosurePayloadZ>('closure-day', workspaceId, payload, tx);

  await logTechnicalEvent(workspaceId, 'closure_day_completed', {
    closureId: record._id,
    sequence: record.sequence,
    periodStart: startISO,
    caTotalCentimes: aggregate.caTotalCentimes,
    cumulPerpetuel: aggregate.cumulPerpetuel,
    nbTransactions: aggregate.nbTransactions,
  }, {}, tx);

  return toClosure(record, payload);
}

export async function closeMonth(
  workspaceId: string,
  year: number,
  month: number,
  opts: TxOptions = {},
): Promise<Closure> {
  return underClosureLock('closure-month', workspaceId, opts, (tx) => closeMonthLocked(workspaceId, year, month, tx));
}

async function closeMonthLocked(
  workspaceId: string,
  year: number,
  month: number,
  tx: TxOptions,
): Promise<Closure> {
  const { startISO, endISO } = utcMonthRange(year, month);

  await logTechnicalEvent(workspaceId, 'closure_month_initiated', {
    year,
    month,
    periodStart: startISO,
    periodEnd: endISO,
  }, {}, tx);

  const existing = await getMonthClosure(workspaceId, year, month, tx);
  if (existing) {
    throw new Error(
      `NF525_CLOSURE: month ${year}-${pad2(month)} already closed (id=${existing._id})`,
    );
  }

  // Verify every day of the month has a day closure.
  const days = eachDayOfMonth(year, month);
  const allDayClosures = await read<ClosurePayloadZ>('closure-day', workspaceId, { client: tx.client });
  const byPeriodStart = new Map(allDayClosures.map((r) => [r.payload.periodStart, r.payload]));

  const dayPayloads: ClosurePayloadZ[] = [];
  const missing: string[] = [];
  for (const d of days) {
    const dStart = utcDayRange(d).startISO;
    const dc = byPeriodStart.get(dStart);
    if (!dc) {
      missing.push(dStart.slice(0, 10));
    } else {
      dayPayloads.push(dc);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `NF525_CLOSURE: cannot close month ${year}-${pad2(month)}; missing day closures: ${missing.join(', ')}`,
    );
  }

  const aggregate = sumAggregates(dayPayloads.map((p) => p.aggregate));
  // Period closure cumul = last day's perpetual cumul (already perpetual, do not re-sum).
  aggregate.cumulPerpetuel =
    dayPayloads[dayPayloads.length - 1]!.aggregate.cumulPerpetuel;

  const payload = await sealAndBuildPayload(workspaceId, 'month', startISO, endISO, aggregate, tx);
  const record = await append<ClosurePayloadZ>('closure-month', workspaceId, payload, tx);

  await logTechnicalEvent(workspaceId, 'closure_month_completed', {
    closureId: record._id,
    year,
    month,
    caTotalCentimes: aggregate.caTotalCentimes,
    cumulPerpetuel: aggregate.cumulPerpetuel,
  }, {}, tx);

  return toClosure(record, payload);
}

export async function closeYear(
  workspaceId: string,
  year: number,
  opts: TxOptions = {},
): Promise<Closure> {
  return underClosureLock('closure-year', workspaceId, opts, (tx) => closeYearLocked(workspaceId, year, tx));
}

async function closeYearLocked(workspaceId: string, year: number, tx: TxOptions): Promise<Closure> {
  const { startISO, endISO } = utcYearRange(year);

  await logTechnicalEvent(workspaceId, 'closure_year_initiated', {
    year,
    periodStart: startISO,
    periodEnd: endISO,
  }, {}, tx);

  const existing = await getYearClosure(workspaceId, year, tx);
  if (existing) {
    throw new Error(
      `NF525_CLOSURE: year ${year} already closed (id=${existing._id})`,
    );
  }

  // Verify every month of the year has a month closure.
  const allMonthClosures = await read<ClosurePayloadZ>('closure-month', workspaceId, { client: tx.client });
  const byPeriodStart = new Map(
    allMonthClosures.map((r) => [r.payload.periodStart, r.payload]),
  );

  const monthPayloads: ClosurePayloadZ[] = [];
  const missing: number[] = [];
  for (let m = 1; m <= 12; m++) {
    const mStart = utcMonthRange(year, m).startISO;
    const mc = byPeriodStart.get(mStart);
    if (!mc) {
      missing.push(m);
    } else {
      monthPayloads.push(mc);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `NF525_CLOSURE: cannot close year ${year}; missing month closures: ${missing.map(pad2).join(', ')}`,
    );
  }

  const aggregate = sumAggregates(monthPayloads.map((p) => p.aggregate));
  aggregate.cumulPerpetuel =
    monthPayloads[monthPayloads.length - 1]!.aggregate.cumulPerpetuel;

  const payload = await sealAndBuildPayload(workspaceId, 'year', startISO, endISO, aggregate, tx);
  const record = await append<ClosurePayloadZ>('closure-year', workspaceId, payload, tx);

  await logTechnicalEvent(workspaceId, 'closure_year_completed', {
    closureId: record._id,
    year,
    caTotalCentimes: aggregate.caTotalCentimes,
    cumulPerpetuel: aggregate.cumulPerpetuel,
  }, {}, tx);

  return toClosure(record, payload);
}

export async function getCurrentDayClosure(
  workspaceId: string,
  date: Date,
  opts: TxOptions = {},
): Promise<Closure | null> {
  const { startISO } = utcDayRange(date);
  const all = await read<ClosurePayloadZ>('closure-day', workspaceId, { client: opts.client });
  const found = all.find((r) => r.payload.periodStart === startISO);
  return found ? toClosure(found, found.payload) : null;
}

export async function getMonthClosure(
  workspaceId: string,
  year: number,
  month: number,
  opts: TxOptions = {},
): Promise<Closure | null> {
  const { startISO } = utcMonthRange(year, month);
  const all = await read<ClosurePayloadZ>('closure-month', workspaceId, { client: opts.client });
  const found = all.find((r) => r.payload.periodStart === startISO);
  return found ? toClosure(found, found.payload) : null;
}

export async function getYearClosure(
  workspaceId: string,
  year: number,
  opts: TxOptions = {},
): Promise<Closure | null> {
  const { startISO } = utcYearRange(year);
  const all = await read<ClosurePayloadZ>('closure-year', workspaceId, { client: opts.client });
  const found = all.find((r) => r.payload.periodStart === startISO);
  return found ? toClosure(found, found.payload) : null;
}

// ─── Internals ────────────────────────────────────────────────────────

/**
 * With a caller client: the whole closure runs under the closure stream's
 * lock, inside the caller's transaction (two closures of the same stream
 * cannot both pass the « already closed » check). Without one, unchanged: no
 * SDK transaction, so a refused closure keeps its « initiated » JET entry.
 */
function underClosureLock(
  stream: 'closure-day' | 'closure-month' | 'closure-year',
  workspaceId: string,
  opts: TxOptions,
  fn: (tx: TxOptions) => Promise<Closure>,
): Promise<Closure> {
  const tx: TxOptions = opts.client ? { client: opts.client } : {};
  return tx.client ? withStreamLock(stream, workspaceId, fn, tx) : fn(tx);
}

/**
 * Sign the period payload over its canonical "skeleton minus signature" form,
 * then validate the full payload (with signature included) via the Zod schema.
 *
 * Including signature in the persisted payload is deliberate: the eventStore
 * recomputes a hash over `{previousHash, recordedAt, payload, …}`, so any
 * tampering with the signature also breaks the chain — defense in depth.
 */
async function sealAndBuildPayload(
  workspaceId: string,
  type: ClosureType,
  periodStart: string,
  periodEnd: string,
  aggregate: ClosureAggregate,
  tx: TxOptions,
): Promise<ClosurePayloadZ> {
  const closedAt = new Date().toISOString();
  const chainHeads = await chainHeadsAt(workspaceId, periodEnd, tx);
  // NF-11 closure chain: sign the hash of the previous closure of this stream,
  // so deleting/renumbering a closure breaks the next one's signed link.
  // Serialized against a concurrent closure of the same stream only with a caller client (underClosureLock);
  // without one, a race fails verification loudly.
  const previous = await getLast(`closure-${type}`, workspaceId, tx);
  const skeletonForSig = {
    type, periodStart, periodEnd, closedAt, aggregate,
    schemaVersion: CLOSURE_SCHEMA_VERSION, chainHeads,
    previousClosureHash: previous?.hash ?? GENESIS_HASH,
  };
  const envelope = await signClosure(canonicalize(skeletonForSig));
  return ClosurePayloadSchema.parse({
    ...skeletonForSig,
    signature: envelope.signature,
    signingKeyVersion: envelope.keyVersion,
  });
}

/**
 * NF-11: last record (sequence + hash) of each covered stream recorded at or
 * before `periodEnd`. Signed with the closure, so rewriting any record up to
 * that point — even with the whole chain recomputed — changes the hash at the
 * signed sequence and is detected by verifyChainIntegrity / verifyExportIntegrity.
 */
async function chainHeadsAt(workspaceId: string, periodEnd: string, tx: TxOptions): Promise<ChainHeads> {
  const heads = {} as ChainHeads;
  for (const stream of CHAIN_HEAD_STREAMS) {
    // ponytail: reads the stream up to periodEnd; add a storage "last before date" query if streams get huge.
    const recs = await read(stream, workspaceId, { to: new Date(periodEnd), client: tx.client });
    const last = recs[recs.length - 1];
    heads[stream] = last
      ? { sequence: last.sequence, hash: last.hash }
      : { sequence: 0, hash: GENESIS_HASH };
  }
  return heads;
}

function buildPeriodAggregate(
  allEnc: EventRecord<EncaissementStreamPayload>[],
  inWindow: EventRecord<EncaissementStreamPayload>[],
  tvaRates?: Record<string, number>,
): ClosureAggregate {
  // Originals lookup so corrections inherit mode/TVA from the encaissement they target.
  const originalsById = new Map<string, { mode: string; tvaCode: string; devise: 'EUR' | 'CHF' }>();
  for (const r of allEnc) {
    if (r.payload.type === 'encaissement') {
      originalsById.set(r._id, {
        mode: r.payload.data.mode,
        tvaCode: r.payload.data.tvaCode,
        devise: r.payload.data.devise,
      });
    }
  }

  let devise: 'EUR' | 'CHF' = 'EUR';
  const parMode: Record<string, number> = {};
  const parTva: Record<string, { ht: number; tva: number; ttc: number }> = {};
  let caTotalCentimes = 0;
  let nbTransactions = 0;
  let premiereSequence = 0;
  let derniereSequence = 0;

  for (const r of inWindow) {
    if (premiereSequence === 0) premiereSequence = r.sequence;
    derniereSequence = r.sequence;

    if (r.payload.type === 'encaissement') {
      const d = r.payload.data;
      devise = d.devise;
      caTotalCentimes += d.montantCentimes;
      nbTransactions += 1;
      parMode[d.mode] = (parMode[d.mode] ?? 0) + d.montantCentimes;
      addTvaSlice(parTva, d.tvaCode, d.montantCentimes, tvaRates);
    } else {
      const orig = originalsById.get(r.payload.data.originalId);
      if (!orig) continue; // recordCorrection enforces existence; defensive only.
      devise = orig.devise;
      const amt = r.payload.data.montantCentimes;
      caTotalCentimes += amt;
      parMode[orig.mode] = (parMode[orig.mode] ?? 0) + amt;
      addTvaSlice(parTva, orig.tvaCode, amt, tvaRates);
    }
  }

  return {
    caTotalCentimes,
    devise,
    parMode,
    parTva,
    nbTransactions,
    cumulPerpetuel: 0, // filled by caller
    premiereSequence,
    derniereSequence,
  };
}

function addTvaSlice(
  parTva: Record<string, { ht: number; tva: number; ttc: number }>,
  tvaCode: string,
  ttcDelta: number,
  tvaRates?: Record<string, number>,
): void {
  const rate = tvaRates?.[tvaCode];
  let htDelta: number;
  let tvaDelta: number;
  if (typeof rate === 'number' && rate >= 0) {
    htDelta = Math.round(ttcDelta / (1 + rate));
    tvaDelta = ttcDelta - htDelta;
  } else {
    htDelta = ttcDelta;
    tvaDelta = 0;
  }
  const cur = parTva[tvaCode] ?? { ht: 0, tva: 0, ttc: 0 };
  parTva[tvaCode] = {
    ht: cur.ht + htDelta,
    tva: cur.tva + tvaDelta,
    ttc: cur.ttc + ttcDelta,
  };
}

function sumAggregates(aggs: ClosureAggregate[]): ClosureAggregate {
  const out: ClosureAggregate = {
    caTotalCentimes: 0,
    devise: aggs[0]?.devise ?? 'EUR',
    parMode: {},
    parTva: {},
    nbTransactions: 0,
    cumulPerpetuel: 0, // overwritten by caller
    premiereSequence: 0,
    derniereSequence: 0,
  };
  for (const a of aggs) {
    out.caTotalCentimes += a.caTotalCentimes;
    out.nbTransactions += a.nbTransactions;
    if (a.premiereSequence > 0) {
      out.premiereSequence =
        out.premiereSequence === 0
          ? a.premiereSequence
          : Math.min(out.premiereSequence, a.premiereSequence);
    }
    if (a.derniereSequence > out.derniereSequence) {
      out.derniereSequence = a.derniereSequence;
    }
    for (const [mode, amt] of Object.entries(a.parMode)) {
      out.parMode[mode] = (out.parMode[mode] ?? 0) + amt;
    }
    for (const [code, vals] of Object.entries(a.parTva)) {
      const cur = out.parTva[code] ?? { ht: 0, tva: 0, ttc: 0 };
      out.parTva[code] = {
        ht: cur.ht + vals.ht,
        tva: cur.tva + vals.tva,
        ttc: cur.ttc + vals.ttc,
      };
    }
  }
  return out;
}

function toClosure(
  record: EventRecord<ClosurePayloadZ>,
  payload: ClosurePayloadZ,
): Closure {
  return {
    _id: record._id,
    workspaceId: record.workspaceId,
    type: payload.type,
    periodStart: payload.periodStart,
    periodEnd: payload.periodEnd,
    closedAt: payload.closedAt,
    aggregate: payload.aggregate,
    previousHash: record.previousHash,
    hash: record.hash,
    ...(payload.chainHeads
      ? { schemaVersion: payload.schemaVersion, chainHeads: payload.chainHeads, previousClosureHash: payload.previousClosureHash }
      : {}),
    signature: payload.signature,
    signingKeyVersion: payload.signingKeyVersion,
  };
}

// ─── Date helpers (UTC) ───────────────────────────────────────────────

function utcDayRange(date: Date): { startISO: string; endISO: string } {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  return {
    startISO: new Date(Date.UTC(y, m, d, 0, 0, 0, 0)).toISOString(),
    endISO: new Date(Date.UTC(y, m, d, 23, 59, 59, 999)).toISOString(),
  };
}

function utcMonthRange(year: number, month: number): { startISO: string; endISO: string } {
  if (month < 1 || month > 12) {
    throw new Error(`NF525_CLOSURE: month must be 1..12 (got ${month})`);
  }
  const startISO = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)).toISOString();
  const endISO = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString();
  return { startISO, endISO };
}

function utcYearRange(year: number): { startISO: string; endISO: string } {
  return {
    startISO: new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)).toISOString(),
    endISO: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)).toISOString(),
  };
}

function eachDayOfMonth(year: number, month: number): Date[] {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: Date[] = [];
  for (let d = 1; d <= lastDay; d++) {
    days.push(new Date(Date.UTC(year, month - 1, d)));
  }
  return days;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

// ─── Types ────────────────────────────────────────────────────────────

export type ClosureType = 'day' | 'month' | 'year';

export interface ClosureAggregate {
  /** Total CA TTC en centimes (signé : peut être négatif si remboursements > ventes). */
  caTotalCentimes: number;
  /** Devise */
  devise: 'EUR' | 'CHF';
  /** CA par mode de paiement (clé = mode, valeur = centimes signés) */
  parMode: Record<string, number>;
  /** CA par code TVA (clé = tvaCode tel qu'enregistré) */
  parTva: Record<string, { ht: number; tva: number; ttc: number }>;
  /** Nombre de transactions de la période (corrections non comptées) */
  nbTransactions: number;
  /** Cumul depuis mise en service (Grand Total Perpétuel) */
  cumulPerpetuel: number;
  /** Première séquence d'encaissement de la période (0 si vide) */
  premiereSequence: number;
  /** Dernière séquence d'encaissement de la période (0 si vide) */
  derniereSequence: number;
}

export interface Closure {
  _id: string;
  workspaceId: string;
  type: ClosureType;
  /** ISO 8601 UTC, début de période (inclusive) */
  periodStart: string;
  /** ISO 8601 UTC, fin de période (inclusive) */
  periodEnd: string;
  /** ISO 8601 UTC, instant de scellement */
  closedAt: string;
  aggregate: ClosureAggregate;
  /** Hash de la clôture précédente du même type (chaîné via l'event store) */
  previousHash: string;
  /** Hash propre (calculé par l'event store sur tout le record) */
  hash: string;
  /** Version du contenu signé (2 ; absent sur une clôture v1 legacy) */
  schemaVersion?: number;
  /** NF-11 (v2) : têtes de chaîne signées (absent sur une clôture v1 legacy) */
  chainHeads?: ChainHeads;
  /** NF-11 (v2) : hash signé de la clôture précédente du même flux (GENESIS_HASH pour la première) */
  previousClosureHash?: string;
  /** Signature Ed25519 du payload (skeleton sans signature) */
  signature: string;
  /** Version de la clé éditeur ayant signé */
  signingKeyVersion: string;
}
