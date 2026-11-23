/**
 * Zod validation schemas for a French invoice (facture).
 *
 * Cf. src/fr/facture.ts for the validation/checklist helpers built on top.
 *
 * Scope: this is the *facturation* document (mentions obligatoires), NOT the
 * encaissement record (src/encaissement.ts). The two are distinct artifacts — the encaissement
 * (EncaissementInputSchema) is the inalterable cash record; the facture is the
 * legal billing document handed to the customer. A consumer app
 * persists both and links them via `factureId` on the encaissement.
 *
 * Legal basis for mandatory mentions:
 *  - Art. L.441-9 Code de commerce (B2B invoicing)
 *  - Art. 242 nonies A annexe II CGI (mentions obligatoires)
 *  - Art. 293 B CGI (franchise en base — "TVA non applicable")
 *  - Réforme facturation électronique 2026 — 4 nouvelles mentions
 *    (SIREN client, adresse de livraison, nature de l'opération, option débits)
 *
 * Like every schema in this package: amounts are integer centimes, `.strict()`
 * is enforced, and `parse()` is the single source of truth for accepted input.
 */

import { z } from 'zod';

export const FACTURE_SCHEMA_VERSION = 1;

// ─── Primitives ───────────────────────────────────────────────────────

const IntegerCentimes = z
  .number()
  .int('montant doit être un entier (centimes), jamais un flottant')
  .finite()
  .refine((n) => Number.isSafeInteger(n), { message: 'montant doit être un entier sûr' });

const NonNegativeCentimes = IntegerCentimes.refine((n) => n >= 0, {
  message: 'montant ne peut pas être négatif sur une facture',
});

/** ISO date (YYYY-MM-DD) — invoices are dated to the day, not the instant. */
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date doit être au format ISO YYYY-MM-DD');

/** SIREN = 9 digits ; SIRET = 14 digits. */
const Siren = z.string().regex(/^\d{9}$/, 'SIREN doit comporter 9 chiffres');
const Siret = z.string().regex(/^\d{14}$/, 'SIRET doit comporter 14 chiffres');

/** FR intra-EU VAT number: FR + 2 key chars + 9-digit SIREN. */
const VatNumberFr = z
  .string()
  .regex(/^FR[0-9A-Z]{2}\d{9}$/, 'numéro de TVA intracommunautaire FR invalide');

/**
 * French legal VAT rates (percent). 0 is used for franchise / exonéré lines.
 * Stored as a number because a rate is not money — only amounts are centimes.
 */
export const TauxTvaSchema = z
  .number()
  .refine((r) => [0, 2.1, 5.5, 10, 20].includes(r), {
    message: 'taux de TVA non reconnu (attendu: 0 / 2.1 / 5.5 / 10 / 20)',
  });

export const PostalAddressSchema = z
  .object({
    line1: z.string().min(1).max(200),
    line2: z.string().min(1).max(200).optional(),
    postalCode: z.string().min(1).max(16),
    city: z.string().min(1).max(120),
    country: z.string().length(2).default('FR'), // ISO 3166-1 alpha-2
  })
  .strict();

export type PostalAddressZ = z.infer<typeof PostalAddressSchema>;

// ─── VAT regime (discriminated) ───────────────────────────────────────

/**
 * The seller's VAT regime drives most conditional mentions:
 *  - franchise_base → no VAT charged, mention art. 293 B mandatory, no VAT number needed
 *  - assujetti      → VAT charged per line, intra-EU VAT number required
 */
export const RegimeTvaSchema = z.enum(['franchise_base', 'assujetti']);
export type RegimeTvaZ = z.infer<typeof RegimeTvaSchema>;

// ─── Nature of operation (2026 mandatory mention) ─────────────────────

export const NatureOperationSchema = z.enum([
  'livraison_biens',
  'prestation_services',
  'mixte',
]);
export type NatureOperationZ = z.infer<typeof NatureOperationSchema>;

// ─── Parties ──────────────────────────────────────────────────────────

/** The seller — a shop owner, a restaurant, etc. */
export const VendeurSchema = z
  .object({
    /** Dénomination sociale, or "Prénom Nom" for an entrepreneur individuel. */
    name: z.string().min(1).max(200),
    /** SASU / SAS / SARL / EI / EURL / micro-entreprise … (sociétés only). */
    legalForm: z.string().min(1).max(60).optional(),
    /** Capital social en centimes (sociétés only). */
    shareCapitalCentimes: NonNegativeCentimes.optional(),
    siren: Siren,
    siret: Siret.optional(),
    /** Greffe city for the RCS, or RNE registration locality (artisan). */
    rcsOrRneCity: z.string().min(1).max(120).optional(),
    /** APE/NAF code (e.g. 5829C, 6201Z). */
    apeCode: z.string().regex(/^\d{4}[A-Z]$/, 'code APE invalide (ex: 5829C)').optional(),
    address: PostalAddressSchema,
    regimeTva: RegimeTvaSchema,
    /** Required when regimeTva = assujetti. */
    vatNumber: VatNumberFr.optional(),
    /** Artisan: professional liability insurance + insurer coverage area. */
    assurancePro: z.string().min(1).max(300).optional(),
    /** "Option pour le paiement de la taxe d'après les débits" (2026 mention). */
    tvaSurDebits: z.boolean().optional(),
  })
  .strict();

export type VendeurZ = z.infer<typeof VendeurSchema>;

export const TypeClientSchema = z.enum(['particulier', 'professionnel']);
export type TypeClientZ = z.infer<typeof TypeClientSchema>;

export const ClientSchema = z
  .object({
    type: TypeClientSchema,
    name: z.string().min(1).max(200),
    address: PostalAddressSchema,
    /** B2B: client SIREN — mandatory from the 2026 e-invoicing reform. */
    siren: Siren.optional(),
    /** Intra-EU VAT number for B2B / intra-community operations. */
    vatNumber: z.string().min(4).max(20).optional(),
    /** 2026 mention: delivery address if different from billing. */
    deliveryAddress: PostalAddressSchema.optional(),
  })
  .strict();

export type ClientZ = z.infer<typeof ClientSchema>;

// ─── Line items ───────────────────────────────────────────────────────

export const LigneFactureSchema = z
  .object({
    description: z.string().min(1).max(500),
    /** Quantity (allows fractional units, e.g. hours). */
    quantity: z.number().positive().finite(),
    /** Unit price excl. VAT, in centimes. */
    unitPriceHtCentimes: NonNegativeCentimes,
    /** VAT rate for the line. 0 for franchise/exonéré. */
    tauxTva: TauxTvaSchema,
    /** Optional per-line discount in centimes (applied to the HT line total). */
    remiseCentimes: NonNegativeCentimes.optional(),
  })
  .strict();

export type LigneFactureZ = z.infer<typeof LigneFactureSchema>;

// ─── Payment terms ────────────────────────────────────────────────────

export const ConditionsPaiementSchema = z
  .object({
    /** Échéance / due date. */
    dueDate: IsoDate.optional(),
    /** Taux des pénalités de retard (percent). */
    latePenaltyRatePct: z.number().min(0).max(100).optional(),
    /**
     * Indemnité forfaitaire pour frais de recouvrement (B2B): 40 € = 4000 centimes.
     * Art. L.441-10 II Code de commerce.
     */
    recoveryIndemnityCentimes: NonNegativeCentimes.optional(),
    /** Conditions d'escompte, or explicit "Pas d'escompte". */
    escompte: z.string().min(1).max(200).optional(),
  })
  .strict();

export type ConditionsPaiementZ = z.infer<typeof ConditionsPaiementSchema>;

// ─── Facture ──────────────────────────────────────────────────────────

export const FactureInputSchema = z
  .object({
    /** Numéro unique, séquentiel, chronologique, sans rupture. */
    numero: z.string().min(1).max(64),
    /** Date d'émission. */
    issueDate: IsoDate,
    /** Date de la vente/prestation, si différente de l'émission. */
    saleDate: IsoDate.optional(),
    vendeur: VendeurSchema,
    client: ClientSchema,
    lignes: z.array(LigneFactureSchema).min(1, 'une facture doit comporter au moins une ligne'),
    /** Nature de l'opération — mention obligatoire 2026. */
    natureOperation: NatureOperationSchema,
    conditionsPaiement: ConditionsPaiementSchema.optional(),
    /** Numéro de bon de commande, si applicable. */
    bonCommande: z.string().min(1).max(64).optional(),
    /** Link back to the encaissement that settled this facture. */
    encaissementId: z.string().min(1).max(128).optional(),
    notes: z.string().max(2048).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    // ── Regime ↔ VAT coherence ──────────────────────────────────────
    if (f.vendeur.regimeTva === 'franchise_base') {
      const lineWithVat = f.lignes.findIndex((l) => l.tauxTva > 0);
      if (lineWithVat >= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'franchise en base (art. 293 B): aucune ligne ne peut porter de TVA (taux doit être 0)',
          path: ['lignes', lineWithVat, 'tauxTva'],
        });
      }
    } else {
      // assujetti
      if (!f.vendeur.vatNumber) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'un vendeur assujetti doit porter un numéro de TVA intracommunautaire',
          path: ['vendeur', 'vatNumber'],
        });
      }
    }

    // ── Customer type ↔ identifiers coherence ───────────────────────
    if (f.client.type === 'particulier' && f.client.siren) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'un client particulier ne porte pas de SIREN',
        path: ['client', 'siren'],
      });
    }

    // ── Delivery address must actually differ when provided ─────────
    if (
      f.client.deliveryAddress &&
      JSON.stringify(f.client.deliveryAddress) === JSON.stringify(f.client.address)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "adresse de livraison identique à l'adresse de facturation — l'omettre plutôt que la dupliquer",
        path: ['client', 'deliveryAddress'],
      });
    }
  });

export type FactureInputZ = z.infer<typeof FactureInputSchema>;
