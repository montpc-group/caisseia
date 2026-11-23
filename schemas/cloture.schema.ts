/**
 * Zod validation schemas for closures (day / month / year).
 *
 * SKELETON — Milestone 1. Only the structural schema is wired; the closure
 * domain logic (closeDay, closeMonth, closeYear) is implemented in M2 and
 * its tests will exercise this schema then.
 *
 * Defined now because:
 *   1. The package's public types (Closure, ClosureAggregate) need a runtime
 *      counterpart so JET events that reference closure metadata can validate.
 *   2. The Postgres `nf525_event` CHECK constraint already accepts the
 *      'closure-*' streams; the schema below keeps app-side validation in
 *      sync with the SQL contract.
 */

import { z } from 'zod';

/**
 * v2 (NF-11): the signed closure content carries `schemaVersion` and
 * `chainHeads` (last record of each covered stream at period end) and
 * `previousClosureHash` (hash of the previous closure record of the same
 * stream, GENESIS_HASH for the first one: the closure chain).
 * v1 closures (no schemaVersion) are still read and reported as legacy.
 *
 * v3 (rc.7, business days): also signs `periodKey` (business day YYYY-MM-DD,
 * month YYYY-MM, exercice = its last month YYYY-MM) and the `calendar` used.
 * periodStart/periodEnd stay UTC instants; the label is periodKey, not the
 * UTC date of periodStart. v2 closures still parse and verify.
 */
export const CLOSURE_SCHEMA_VERSION = 3;

const VALID_TIME_ZONE = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** How a workspace groups records into closure periods (see src/calendar.ts). */
export const BusinessCalendarSchema = z
  .object({
    /** IANA time zone of the business (e.g. Europe/Paris, America/Martinique). */
    timeZone: z.string().min(1).refine(VALID_TIME_ZONE, { message: 'unknown IANA time zone' }),
    /** Local hour a business day starts (HH:MM, 24 h). */
    dayCutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    /** Month (1..12) the exercice ends with. */
    fiscalYearEndMonth: z.number().int().min(1).max(12),
  })
  .strict();

export type BusinessCalendar = z.infer<typeof BusinessCalendarSchema>;

/** Streams whose chain head a closure signs. */
export const CHAIN_HEAD_STREAMS = ['encaissement', 'jet'] as const;

/** Last record of a stream at period end (sequence 0 + GENESIS hash if empty). */
export const ChainHeadSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const ChainHeadsSchema = z
  .object({ encaissement: ChainHeadSchema, jet: ChainHeadSchema })
  .strict();

export type ChainHeads = z.infer<typeof ChainHeadsSchema>;

export const ClosureTypeSchema = z.enum(['day', 'month', 'year']);

export const ClosureAggregateSchema = z
  .object({
    // Signed: refunds recorded today for prior-day encaissements may push net negative.
    caTotalCentimes: z.number().int(),
    devise: z.enum(['EUR', 'CHF']),
    parMode: z.record(z.number().int()),
    parTva: z.record(
      z.object({
        ht: z.number().int(),
        tva: z.number().int(),
        ttc: z.number().int(),
      }),
    ),
    nbTransactions: z.number().int().nonnegative(),
    // Theoretically signed; alarm condition if negative but accepted by the schema.
    cumulPerpetuel: z.number().int(),
    // Allow 0 for empty periods (zero-sales days still get sealed for chain continuity).
    premiereSequence: z.number().int().nonnegative(),
    derniereSequence: z.number().int().nonnegative(),
  })
  .strict()
  .refine((v) => v.derniereSequence >= v.premiereSequence, {
    message: 'derniereSequence doit être ≥ premiereSequence',
  })
  .refine(
    (v) =>
      (v.nbTransactions === 0) === (v.premiereSequence === 0 && v.derniereSequence === 0),
    { message: 'premiereSequence/derniereSequence doivent valoir 0 ssi nbTransactions = 0' },
  );

export const ClosurePayloadSchema = z
  .object({
    type: ClosureTypeSchema,
    periodStart: z.string().datetime({ offset: true }),
    periodEnd: z.string().datetime({ offset: true }),
    closedAt: z.string().datetime({ offset: true }),
    aggregate: ClosureAggregateSchema,
    // Optional only so v1 (legacy) closures still parse; v2+ closures always set them.
    schemaVersion: z.union([z.literal(2), z.literal(CLOSURE_SCHEMA_VERSION)]).optional(),
    chainHeads: ChainHeadsSchema.optional(),
    previousClosureHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    periodKey: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(),
    calendar: BusinessCalendarSchema.optional(),
    signature: z.string().min(1),
    signingKeyVersion: z.string().min(1),
  })
  .strict()
  .refine((v) => v.periodStart <= v.periodEnd, {
    message: 'periodStart doit être ≤ periodEnd',
  })
  .refine(
    (v) =>
      (v.schemaVersion === undefined) === (v.chainHeads === undefined) &&
      (v.schemaVersion === undefined) === (v.previousClosureHash === undefined),
    { message: 'schemaVersion, chainHeads et previousClosureHash sont présents ensemble (v2) ou absents (v1 legacy)' },
  )
  .refine(
    (v) => (v.schemaVersion === 3) === (v.periodKey !== undefined) && (v.schemaVersion === 3) === (v.calendar !== undefined),
    { message: 'periodKey et calendar sont présents ssi schemaVersion = 3' },
  );

export type ClosurePayloadZ = z.infer<typeof ClosurePayloadSchema>;
