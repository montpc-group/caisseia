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
 */
export const CLOSURE_SCHEMA_VERSION = 2;

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
    // Optional only so v1 (legacy) closures still parse; v2 closures always set both.
    schemaVersion: z.literal(CLOSURE_SCHEMA_VERSION).optional(),
    chainHeads: ChainHeadsSchema.optional(),
    previousClosureHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
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
  );

export type ClosurePayloadZ = z.infer<typeof ClosurePayloadSchema>;
