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
 * Périodes : jour ouvré LOCAL du commerce (fuseau IANA, heure de coupure),
 * mois civil, exercice — cf. src/calendar.ts. Les bornes signées restent des
 * instants UTC ; le libellé de la période est `periodKey` (schéma v3).
 */

import { append, read, getLast, withStreamLock } from './eventStore.js';
import type { EventRecord } from './eventStore.js';
import { canonicalize, signClosure, GENESIS_HASH } from './crypto.js';
import { logTechnicalEvent } from './jet.js';
import type { TxOptions } from './storage/EventStorage.js';
import { loadTimeline, dayKey, shiftDate, type CalendarTimeline } from './calendar.js';
import {
  ClosurePayloadSchema,
  CLOSURE_SCHEMA_VERSION,
  CHAIN_HEAD_STREAMS,
  type ChainHeads,
  type ClosurePayloadZ,
  type BusinessCalendar,
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

/**
 * Seals business day `date`: a 'YYYY-MM-DD' business date, or a Date = the
 * business day containing that instant (src/calendar.ts). A day that is still
 * running ends at the closing instant; the rest of it belongs to the next day.
 */
export async function closeDay(
  workspaceId: string,
  date: Date | string,
  options: CloseOptions = {},
): Promise<Closure> {
  return underClosureLock('closure-day', workspaceId, options, (tx) =>
    // Lock order, the same for every writer: closure stream → encaissement → jet
    // (a payment takes encaissement, then jet for its JET entry). closeDay takes
    // the encaissement lock before its first JET entry and before it reads the
    // day, so:
    //  - a payment committed before the lock is read and counted;
    //  - a payment still in flight holds the lock: closeDay waits for its commit;
    //  - a payment that starts later waits for closeDay's commit and is dated
    //    after it, while a running day ends at the closing instant (`now`):
    //    it lands in the next period, never in a sealed one.
    // Do not move the JET entry or the reads above this lock.
    withStreamLock('encaissement', workspaceId, () => closeDayLocked(workspaceId, date, options, tx), tx),
  );
}

async function closeDayLocked(
  workspaceId: string,
  date: Date | string,
  options: CloseOptions,
  tx: TxOptions,
): Promise<Closure> {
  const now = Date.now();
  const { timeline, dayClosures } = await loadTimeline(workspaceId, tx);
  const periodKey = typeof date === 'string' ? businessDate(date) : timeline.dayOf(date.getTime());
  const { startISO, endISO } = dayPeriod(periodKey, timeline, dayClosures, now);

  await logTechnicalEvent(workspaceId, 'closure_day_initiated', {
    periodKey,
    periodStart: startISO,
    periodEnd: endISO,
  }, {}, tx);

  const existing = dayClosures.find((r) => dayKey(r) === periodKey);
  if (existing) {
    throw new Error(
      `NF525_CLOSURE: day ${periodKey} already closed (id=${existing._id})`,
    );
  }

  // Read the full encaissement stream once: we need every encaissement (any date)
  // to attribute mode/TVA to corrections that may target prior-day originals.
  const allEnc = await read<EncaissementStreamPayload>('encaissement', workspaceId, { client: tx.client });
  // A read that sees no row while the stream has a last record is a read on the
  // wrong connection (e.g. RLS without the caller's client): never seal it.
  if (allEnc.length === 0 && (await getLast('encaissement', workspaceId, tx))) {
    throw new Error(
      `NF525_CLOSURE: refusing to seal day ${periodKey}: the encaissement read returned 0 rows but the stream has records (pass the caller's client)`,
    );
  }
  const from = Date.parse(startISO);
  const to = Date.parse(endISO);
  const inWindow = allEnc.filter((r) => {
    const t = Date.parse(r.recordedAt);
    return t >= from && t <= to;
  });

  const aggregate = buildPeriodAggregate(allEnc, inWindow, options.tvaRates);

  // Cumul perpétuel = previous day closure's cumul + this day's net CA.
  const previousDay = await getLast<ClosurePayloadZ>('closure-day', workspaceId, tx);
  const previousCumul = previousDay?.payload.aggregate.cumulPerpetuel ?? 0;
  aggregate.cumulPerpetuel = previousCumul + aggregate.caTotalCentimes;

  const payload = await sealAndBuildPayload(workspaceId, 'day', startISO, endISO, aggregate, tx, {
    periodKey,
    calendar: timeline.at(periodKey),
  });
  const record = await append<ClosurePayloadZ>('closure-day', workspaceId, payload, tx);

  await logTechnicalEvent(workspaceId, 'closure_day_completed', {
    closureId: record._id,
    sequence: record.sequence,
    periodKey,
    periodStart: startISO,
    caTotalCentimes: aggregate.caTotalCentimes,
    cumulPerpetuel: aggregate.cumulPerpetuel,
    nbTransactions: aggregate.nbTransactions,
  }, {}, tx);

  return toClosure(record, payload);
}

/** Seals calendar month `month` (1..12) of `year`: every business day of it must be closed. */
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
  const periodKey = monthKeyOf(year, month);
  const { timeline, dayClosures } = await loadTimeline(workspaceId, tx);

  await logTechnicalEvent(workspaceId, 'closure_month_initiated', {
    year,
    month,
    periodKey,
  }, {}, tx);

  const existing = await getMonthClosure(workspaceId, year, month, tx);
  if (existing) {
    throw new Error(
      `NF525_CLOSURE: month ${periodKey} already closed (id=${existing._id})`,
    );
  }

  // Verify every day of the month has a day closure.
  const byKey = new Map(dayClosures.map((r) => [dayKey(r), r.payload]));
  const dayPayloads: ClosurePayloadZ[] = [];
  const missing: string[] = [];
  for (const d of daysOfMonth(year, month)) {
    const dc = byKey.get(d);
    if (!dc) {
      missing.push(d);
    } else {
      dayPayloads.push(dc);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `NF525_CLOSURE: cannot close month ${periodKey}; missing day closures: ${missing.join(', ')}`,
    );
  }

  const aggregate = sumAggregates(dayPayloads.map((p) => p.aggregate));
  // Period closure cumul = last day's perpetual cumul (already perpetual, do not re-sum).
  const lastDay = dayPayloads[dayPayloads.length - 1]!;
  aggregate.cumulPerpetuel = lastDay.aggregate.cumulPerpetuel;

  const startISO = dayPayloads[0]!.periodStart;
  const endISO = lastDay.periodEnd;
  const payload = await sealAndBuildPayload(workspaceId, 'month', startISO, endISO, aggregate, tx, {
    periodKey,
    calendar: timeline.at(`${periodKey}-${pad2(lastDayOfMonth(year, month))}`),
  });
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

/**
 * Seals the exercice that ends in `year`: it ends with the month whose
 * calendar names it the fiscal-year-end month (latest such month of `year`),
 * and starts the month after the previous yearly closure, or at the first
 * month closure for a first exercice (short or long). Every month in between
 * must be closed.
 */
export async function closeYear(
  workspaceId: string,
  year: number,
  opts: TxOptions = {},
): Promise<Closure> {
  return underClosureLock('closure-year', workspaceId, opts, (tx) => closeYearLocked(workspaceId, year, tx));
}

async function closeYearLocked(workspaceId: string, year: number, tx: TxOptions): Promise<Closure> {
  const { timeline } = await loadTimeline(workspaceId, tx);
  const endMonth = fiscalYearEndIn(timeline, year);
  const periodKey = monthKeyOf(year, endMonth);

  await logTechnicalEvent(workspaceId, 'closure_year_initiated', {
    year,
    periodKey,
  }, {}, tx);

  const yearClosures = await read<ClosurePayloadZ>('closure-year', workspaceId, { client: tx.client });
  const existing = yearClosures.find((r) => yearKey(r) === periodKey);
  if (existing) {
    throw new Error(
      `NF525_CLOSURE: year ${year} already closed (id=${existing._id})`,
    );
  }

  const monthClosures = await read<ClosurePayloadZ>('closure-month', workspaceId, { client: tx.client });
  const byKey = new Map(monthClosures.map((r) => [monthKey(r), r.payload]));
  const previous = yearClosures[yearClosures.length - 1];
  const firstKey = previous
    ? nextMonthKey(yearKey(previous))
    : [...byKey.keys()].sort()[0] ?? periodKey;

  const monthPayloads: ClosurePayloadZ[] = [];
  const missing: string[] = [];
  for (let k = firstKey; k <= periodKey; k = nextMonthKey(k)) {
    const mc = byKey.get(k);
    if (!mc) {
      missing.push(k);
    } else {
      monthPayloads.push(mc);
    }
  }
  if (monthPayloads.length === 0 || missing.length > 0) {
    throw new Error(
      `NF525_CLOSURE: cannot close year ${year} (exercice ${firstKey} → ${periodKey}); missing month closures: ${(missing.length ? missing : [periodKey]).join(', ')}`,
    );
  }

  const aggregate = sumAggregates(monthPayloads.map((p) => p.aggregate));
  const lastMonth = monthPayloads[monthPayloads.length - 1]!;
  aggregate.cumulPerpetuel = lastMonth.aggregate.cumulPerpetuel;

  const payload = await sealAndBuildPayload(workspaceId, 'year', monthPayloads[0]!.periodStart, lastMonth.periodEnd, aggregate, tx, {
    periodKey,
    calendar: timeline.at(`${periodKey}-${pad2(lastDayOfMonth(year, endMonth))}`),
  });
  const record = await append<ClosurePayloadZ>('closure-year', workspaceId, payload, tx);

  await logTechnicalEvent(workspaceId, 'closure_year_completed', {
    closureId: record._id,
    year,
    periodKey,
    caTotalCentimes: aggregate.caTotalCentimes,
    cumulPerpetuel: aggregate.cumulPerpetuel,
  }, {}, tx);

  return toClosure(record, payload);
}

/** Closure of business day `date` ('YYYY-MM-DD', or a Date = the business day containing it). */
export async function getCurrentDayClosure(
  workspaceId: string,
  date: Date | string,
  opts: TxOptions = {},
): Promise<Closure | null> {
  const { timeline, dayClosures } = await loadTimeline(workspaceId, opts);
  const key = typeof date === 'string' ? businessDate(date) : timeline.dayOf(date.getTime());
  const found = dayClosures.find((r) => dayKey(r) === key);
  return found ? toClosure(found, found.payload) : null;
}

export async function getMonthClosure(
  workspaceId: string,
  year: number,
  month: number,
  opts: TxOptions = {},
): Promise<Closure | null> {
  const key = monthKeyOf(year, month);
  const all = await read<ClosurePayloadZ>('closure-month', workspaceId, { client: opts.client });
  const found = all.find((r) => monthKey(r) === key);
  return found ? toClosure(found, found.payload) : null;
}

/** Closure of the exercice that ends in `year` (the latest one if two end in the same year). */
export async function getYearClosure(
  workspaceId: string,
  year: number,
  opts: TxOptions = {},
): Promise<Closure | null> {
  const all = await read<ClosurePayloadZ>('closure-year', workspaceId, { client: opts.client });
  const found = all.filter((r) => yearKey(r).startsWith(`${year}-`)).at(-1);
  return found ? toClosure(found, found.payload) : null;
}

// ─── Internals ────────────────────────────────────────────────────────

/**
 * The whole closure runs under the closure stream's lock, in one transaction:
 * the caller's (with a client) or the SDK's own. Two closures of the same
 * stream cannot both pass the « already closed » check, and a refused
 * closure leaves nothing behind (its « initiated » JET entry rolls back too).
 */
function underClosureLock(
  stream: 'closure-day' | 'closure-month' | 'closure-year',
  workspaceId: string,
  opts: TxOptions,
  fn: (tx: TxOptions) => Promise<Closure>,
): Promise<Closure> {
  return withStreamLock(stream, workspaceId, fn, opts.client ? { client: opts.client } : {});
}

/**
 * Bounds of business day `date`: it starts right after the previous day's
 * closure if there is one (a day closed early hands the rest of its calendar
 * day to the next one), else at its calendar start; it ends right before the
 * next day's closure if there is one, else at its calendar end, or at `now`
 * while it is still running. Every instant thus sits in exactly one day. A
 * day whose calendar start is still to come cannot be closed.
 */
function dayPeriod(
  date: string,
  timeline: CalendarTimeline,
  dayClosures: EventRecord<ClosurePayloadZ>[],
  now: number,
): { startISO: string; endISO: string } {
  const calStart = timeline.start(date);
  if (calStart > now) {
    throw new Error(`NF525_CLOSURE: day ${date} has not started (starts ${new Date(calStart).toISOString()})`);
  }
  const byKey = new Map(dayClosures.map((r) => [dayKey(r), r.payload]));
  const prev = byKey.get(shiftDate(date, -1));
  const next = byKey.get(shiftDate(date, 1));
  const start = prev ? Date.parse(prev.periodEnd) + 1 : calStart;
  const end = next ? Date.parse(next.periodStart) - 1 : Math.min(timeline.end(date), now);
  if (end < start) {
    throw new Error(`NF525_CLOSURE: day ${date} has no time left to close (previous day closed until ${prev?.periodEnd})`);
  }
  return { startISO: new Date(start).toISOString(), endISO: new Date(end).toISOString() };
}

/** Latest month of `year` whose calendar names it the fiscal-year-end month. */
function fiscalYearEndIn(timeline: CalendarTimeline, year: number): number {
  for (let m = 12; m >= 1; m--) {
    if (timeline.at(`${monthKeyOf(year, m)}-${pad2(lastDayOfMonth(year, m))}`).fiscalYearEndMonth === m) return m;
  }
  throw new Error(`NF525_CLOSURE: no exercice ends in ${year} (fiscal-year-end month changed during the year)`);
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
  period: { periodKey: string; calendar: BusinessCalendar },
): Promise<ClosurePayloadZ> {
  const closedAt = new Date().toISOString();
  const chainHeads = await chainHeadsAt(workspaceId, periodEnd, tx);
  // NF-11 closure chain: sign the hash of the previous closure of this stream,
  // so deleting/renumbering a closure breaks the next one's signed link.
  // Serialized against a concurrent closure of the same stream by underClosureLock.
  const previous = await getLast(`closure-${type}`, workspaceId, tx);
  const skeletonForSig = {
    type, periodStart, periodEnd, closedAt, aggregate,
    schemaVersion: CLOSURE_SCHEMA_VERSION, chainHeads,
    previousClosureHash: previous?.hash ?? GENESIS_HASH,
    periodKey: period.periodKey,
    calendar: { ...period.calendar },
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
    ...(payload.periodKey ? { periodKey: payload.periodKey, calendar: payload.calendar } : {}),
    signature: payload.signature,
    signingKeyVersion: payload.signingKeyVersion,
  };
}

// ─── Period keys ──────────────────────────────────────────────────────

/** Month of a month closure: signed periodKey (v3), else its UTC start month (v1/v2). */
function monthKey(r: EventRecord<ClosurePayloadZ>): string {
  return r.payload.periodKey ?? r.payload.periodStart.slice(0, 7);
}

/** Last month of a yearly closure's exercice: signed periodKey (v3), else December of its UTC start year (v1/v2). */
function yearKey(r: EventRecord<ClosurePayloadZ>): string {
  return r.payload.periodKey ?? `${r.payload.periodStart.slice(0, 4)}-12`;
}

function businessDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || shiftDate(date, 0) !== date) {
    throw new Error(`NF525_CLOSURE: business date must be YYYY-MM-DD (got ${date})`);
  }
  return date;
}

function monthKeyOf(year: number, month: number): string {
  if (month < 1 || month > 12) {
    throw new Error(`NF525_CLOSURE: month must be 1..12 (got ${month})`);
  }
  return `${year}-${pad2(month)}`;
}

function nextMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return m === 12 ? monthKeyOf(y + 1, 1) : monthKeyOf(y, m + 1);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function daysOfMonth(year: number, month: number): string[] {
  const days: string[] = [];
  for (let d = 1; d <= lastDayOfMonth(year, month); d++) days.push(`${monthKeyOf(year, month)}-${pad2(d)}`);
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
  /** v3 : jour ouvré (YYYY-MM-DD), mois (YYYY-MM) ou dernier mois de l'exercice (YYYY-MM) ; absent avant v3 */
  periodKey?: string;
  /** v3 : calendrier (fuseau, coupure, fin d'exercice) utilisé, signé avec la clôture */
  calendar?: BusinessCalendar;
  /** Signature Ed25519 du payload (skeleton sans signature) */
  signature: string;
  /** Version de la clé éditeur ayant signé */
  signingKeyVersion: string;
}
