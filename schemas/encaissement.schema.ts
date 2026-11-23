/**
 * Zod validation schemas for encaissements & corrections.
 *
 * Cf. src/encaissement.ts and src/corrections.ts for the public API.
 *
 * The schemas are the single source of truth for what is acceptable input
 * and what is persisted. `parse()` is called on every boundary write —
 * required for the "written exactly as-validated" inalterability argument.
 */

import { z } from 'zod';

export const ENCAISSEMENT_SCHEMA_VERSION = 1;

export const ModePaiementSchema = z.enum([
  'especes',
  'cb',
  'cb_mobile',
  'virement',
  'cheque',
  'stripe',
  'wallet',
  'autre',
]);

export const DeviseSchema = z.enum(['EUR', 'CHF']);

const TVA_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

const IntegerCentimes = z
  .number()
  .int('montantCentimes doit être un entier (centimes), jamais un flottant')
  .finite()
  .refine((n) => Number.isSafeInteger(n), { message: 'montantCentimes doit être un entier sûr' });

export const EncaissementInputSchema = z
  .object({
    montantCentimes: IntegerCentimes.refine((n) => n > 0, {
      message: 'montantCentimes doit être strictement positif pour un encaissement original',
    }),
    devise: DeviseSchema,
    mode: ModePaiementSchema,
    tvaCode: z.string().regex(TVA_CODE_PATTERN, 'tvaCode invalide (ex: TVA20, FRANCHISE_BASE)'),
    factureId: z.string().min(1).max(128).optional(),
    reservationId: z.string().min(1).max(128).optional(),
    clientRef: z.string().min(1).max(128).optional(),
    stripeRef: z.string().min(1).max(128).optional(),
    notes: z.string().max(2048).optional(),
    operatorId: z.string().min(1).max(128).optional(),
    registerId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type EncaissementInputZ = z.infer<typeof EncaissementInputSchema>;

export const CorrectionTypeSchema = z.enum([
  'erreur_montant',
  'remboursement_partiel',
  'remboursement_total',
  'annulation_totale',
  'avoir_commercial',
  'autre',
]);

export const CorrectionInputSchema = z
  .object({
    originalId: z.string().min(1).max(128),
    montantCentimes: IntegerCentimes, // signed: negative for refunds, positive for upward correction
    devise: DeviseSchema,
    type: CorrectionTypeSchema,
    reason: z.string().min(3, 'Une correction doit être motivée').max(2048),
    stripeRefundId: z.string().min(1).max(128).optional(),
    operatorId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // annulation_totale must explicitly carry a non-positive amount
    if (val.type === 'annulation_totale' && val.montantCentimes > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Une annulation_totale ne peut pas avoir un montant positif",
        path: ['montantCentimes'],
      });
    }
  });

export type CorrectionInputZ = z.infer<typeof CorrectionInputSchema>;

/** Persisted shape (what eventStore stores as payload). */
export const EncaissementPayloadSchema = z
  .object({
    type: z.literal('encaissement'),
    data: EncaissementInputSchema,
  })
  .strict();

export const CorrectionPayloadSchema = z
  .object({
    type: z.literal('correction'),
    data: CorrectionInputSchema,
  })
  .strict();

export const EncaissementStreamPayloadSchema = z.discriminatedUnion('type', [
  EncaissementPayloadSchema,
  CorrectionPayloadSchema,
]);

export type EncaissementStreamPayload = z.infer<typeof EncaissementStreamPayloadSchema>;
