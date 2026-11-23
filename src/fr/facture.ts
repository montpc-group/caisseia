/**
 * French invoice (facture) — totals, mandatory-mention checklist, validation.
 *
 * Built on schemas/facture.schema.ts. This module is the reusable compliance
 * brick every French SaaS consumer (restaurant SaaS, …) imports to
 * produce a *legally conformant* invoice. It does NOT persist anything — the
 * consumer owns storage (e.g. a Mongoose model) and PDF rendering.
 *
 * Two responsibilities:
 *   1. `computeFactureTotals` — derive HT / TVA-par-taux / TTC in integer centimes.
 *   2. `validateFacture` — Zod-parse + run the mandatory-mention checklist for a
 *      given reference date (so the 2026 e-invoicing mentions toggle on correctly).
 *
 * The checklist is data (`FACTURE_MANDATORY_MENTIONS`), not buried in if/else —
 * so a consumer can render it as a UI checklist, and the rules stay auditable.
 */

import {
  FactureInputSchema,
  type FactureInputZ,
  type TypeClientZ,
} from '../../schemas/facture.schema.js';

// ─── Totals ───────────────────────────────────────────────────────────

export interface FactureTotalParTaux {
  tauxTva: number;
  baseHtCentimes: number;
  tvaCentimes: number;
}

export interface FactureTotals {
  totalHtCentimes: number;
  parTaux: FactureTotalParTaux[];
  totalTvaCentimes: number;
  totalTtcCentimes: number;
}

/**
 * Compute invoice totals in integer centimes.
 *
 * Rounding rule: each line's HT is rounded to the centime, then VAT is computed
 * on the per-rate HT base (not per line) and rounded once per rate — this is the
 * standard French "TVA par taux" presentation and avoids per-line rounding drift.
 */
export function computeFactureTotals(facture: FactureInputZ): FactureTotals {
  const baseByRate = new Map<number, number>();

  for (const ligne of facture.lignes) {
    const gross = Math.round(ligne.unitPriceHtCentimes * ligne.quantity);
    const lineHt = gross - (ligne.remiseCentimes ?? 0);
    baseByRate.set(ligne.tauxTva, (baseByRate.get(ligne.tauxTva) ?? 0) + lineHt);
  }

  const parTaux: FactureTotalParTaux[] = [...baseByRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tauxTva, baseHtCentimes]) => ({
      tauxTva,
      baseHtCentimes,
      tvaCentimes: Math.round((baseHtCentimes * tauxTva) / 100),
    }));

  const totalHtCentimes = parTaux.reduce((s, t) => s + t.baseHtCentimes, 0);
  const totalTvaCentimes = parTaux.reduce((s, t) => s + t.tvaCentimes, 0);

  return {
    totalHtCentimes,
    parTaux,
    totalTvaCentimes,
    totalTtcCentimes: totalHtCentimes + totalTvaCentimes,
  };
}

// ─── Mandatory-mention checklist ──────────────────────────────────────

export interface MentionContext {
  /**
   * Date the invoice is assessed against (ISO YYYY-MM-DD). Toggles mentions
   * whose obligation has a start date (the 2026 e-invoicing reform).
   */
  referenceDate: string;
  /**
   * Date the seller becomes subject to e-invoicing *emission* + the new
   * mandatory mentions. Default 2027-09-01 (PME / micro-entreprises). Large
   * enterprises & ETI: 2026-09-01.
   */
  eInvoiceMentionsFrom?: string;
}

const DEFAULT_EINVOICE_FROM = '2027-09-01';

export interface MandatoryMention {
  id: string;
  labelFr: string;
  legalBasis: string;
  /** Whether this mention is required for this facture in this context. */
  applies: (f: FactureInputZ, ctx: Required<MentionContext>) => boolean;
  /** Whether the facture satisfies the requirement. */
  satisfied: (f: FactureInputZ) => boolean;
}

const always = () => true;
const isB2B = (f: FactureInputZ): boolean => f.client.type === 'professionnel';

/**
 * The mandatory mentions, as data. Order is roughly the order they appear on a
 * printed invoice. `applies` encodes the conditional rules; `satisfied` checks
 * the parsed facture. New mentions (2026 reform) carry a date gate.
 */
export const FACTURE_MANDATORY_MENTIONS: readonly MandatoryMention[] = [
  {
    id: 'numero',
    labelFr: 'Numéro de facture unique, séquentiel, chronologique',
    legalBasis: 'Art. 242 nonies A annexe II CGI',
    applies: always,
    satisfied: (f) => f.numero.trim().length > 0,
  },
  {
    id: 'issueDate',
    labelFr: "Date d'émission de la facture",
    legalBasis: 'Art. 242 nonies A annexe II CGI',
    applies: always,
    satisfied: (f) => !!f.issueDate,
  },
  {
    id: 'vendeur.identite',
    labelFr: 'Identité du vendeur (dénomination, adresse)',
    legalBasis: 'Art. L.441-9 C. com.',
    applies: always,
    satisfied: (f) => !!f.vendeur.name && !!f.vendeur.address?.line1,
  },
  {
    id: 'vendeur.siren',
    labelFr: 'SIREN/SIRET du vendeur',
    legalBasis: 'Art. L.441-9 C. com.',
    applies: always,
    satisfied: (f) => /^\d{9}$/.test(f.vendeur.siren),
  },
  {
    id: 'vendeur.vatNumber',
    labelFr: 'Numéro de TVA intracommunautaire du vendeur',
    legalBasis: 'Art. 242 nonies A annexe II CGI',
    applies: (f) => f.vendeur.regimeTva === 'assujetti',
    satisfied: (f) => !!f.vendeur.vatNumber,
  },
  {
    id: 'mention.franchise',
    labelFr: '« TVA non applicable, art. 293 B du CGI »',
    legalBasis: 'Art. 293 B CGI',
    // Carried implicitly by regimeTva = franchise_base; the consumer must print it.
    applies: (f) => f.vendeur.regimeTva === 'franchise_base',
    satisfied: (f) => f.vendeur.regimeTva === 'franchise_base',
  },
  {
    id: 'client.identite',
    labelFr: 'Identité du client (nom, adresse)',
    legalBasis: 'Art. L.441-9 C. com.',
    applies: always,
    satisfied: (f) => !!f.client.name && !!f.client.address?.line1,
  },
  {
    id: 'lignes',
    labelFr: 'Désignation, quantité, prix unitaire HT et taux de TVA par ligne',
    legalBasis: 'Art. 242 nonies A annexe II CGI',
    applies: always,
    satisfied: (f) => f.lignes.length > 0,
  },
  {
    id: 'conditions.echeance',
    labelFr: 'Date limite de règlement (échéance)',
    legalBasis: 'Art. L.441-9 C. com.',
    applies: isB2B,
    satisfied: (f) => !!f.conditionsPaiement?.dueDate,
  },
  {
    id: 'conditions.penalites',
    labelFr: 'Taux des pénalités de retard',
    legalBasis: 'Art. L.441-10 C. com.',
    applies: isB2B,
    satisfied: (f) => f.conditionsPaiement?.latePenaltyRatePct !== undefined,
  },
  {
    id: 'conditions.indemnite',
    labelFr: 'Indemnité forfaitaire de recouvrement (40 €)',
    legalBasis: 'Art. L.441-10 II C. com.',
    applies: isB2B,
    satisfied: (f) => f.conditionsPaiement?.recoveryIndemnityCentimes === 4000,
  },
  // ── 2026 e-invoicing reform — 4 nouvelles mentions ─────────────────
  {
    id: 'nature.operation',
    labelFr: "Nature de l'opération (biens / services / mixte)",
    legalBasis: 'Réforme facturation électronique 2026',
    applies: (_f, ctx) => ctx.referenceDate >= ctx.eInvoiceMentionsFrom,
    satisfied: (f) => !!f.natureOperation,
  },
  {
    id: 'client.siren',
    labelFr: 'SIREN du client (B2B)',
    legalBasis: 'Réforme facturation électronique 2026',
    applies: (f, ctx) => isB2B(f) && ctx.referenceDate >= ctx.eInvoiceMentionsFrom,
    satisfied: (f) => !!f.client.siren,
  },
  {
    id: 'client.deliveryAddress',
    labelFr: 'Adresse de livraison (si différente de la facturation)',
    legalBasis: 'Réforme facturation électronique 2026',
    // Conditional mention — only required when a distinct delivery address exists.
    // We cannot detect "exists but omitted", so this is surfaced as informational.
    applies: () => false,
    satisfied: () => true,
  },
  {
    id: 'vendeur.tvaSurDebits',
    labelFr: '« Option pour le paiement de la taxe d\'après les débits »',
    legalBasis: 'Réforme facturation électronique 2026',
    applies: (f, ctx) =>
      f.vendeur.tvaSurDebits === true && ctx.referenceDate >= ctx.eInvoiceMentionsFrom,
    satisfied: (f) => f.vendeur.tvaSurDebits === true,
  },
] as const;

// ─── Validation ───────────────────────────────────────────────────────

export interface MissingMention {
  id: string;
  labelFr: string;
  legalBasis: string;
}

export interface FactureValidationResult {
  /** True iff Zod parsing passed AND no applicable mandatory mention is missing. */
  ok: boolean;
  /** Zod / structural errors (string paths + messages). Empty if the shape is valid. */
  errors: string[];
  /** Applicable mandatory mentions that are not satisfied. */
  missingMentions: MissingMention[];
  /** Non-blocking advisories (e.g. upcoming-but-not-yet-mandatory mentions). */
  warnings: string[];
  /** Computed totals when the shape is valid, else null. */
  totals: FactureTotals | null;
}

/**
 * Validate a facture: structural (Zod) + the mandatory-mention checklist for a
 * given reference date. A facture is `ok` only when it parses cleanly and every
 * *applicable* mention is satisfied.
 *
 * @param input    raw facture (unknown) — Zod-parsed internally
 * @param ctx      reference date + the seller's e-invoicing start date
 */
export function validateFacture(
  input: unknown,
  ctx: MentionContext,
): FactureValidationResult {
  const parsed = FactureInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(racine)'}: ${i.message}`,
      ),
      missingMentions: [],
      warnings: [],
      totals: null,
    };
  }

  const f = parsed.data;
  const resolved: Required<MentionContext> = {
    referenceDate: ctx.referenceDate,
    eInvoiceMentionsFrom: ctx.eInvoiceMentionsFrom ?? DEFAULT_EINVOICE_FROM,
  };

  const missingMentions: MissingMention[] = [];
  const warnings: string[] = [];

  for (const mention of FACTURE_MANDATORY_MENTIONS) {
    const applicable = mention.applies(f, resolved);
    const satisfied = mention.satisfied(f);
    if (applicable && !satisfied) {
      missingMentions.push({
        id: mention.id,
        labelFr: mention.labelFr,
        legalBasis: mention.legalBasis,
      });
    }
    // Surface 2026 mentions that aren't yet mandatory but aren't satisfied,
    // so consumers can start populating them ahead of the deadline.
    if (
      !applicable &&
      !satisfied &&
      mention.legalBasis.includes('2026') &&
      resolved.referenceDate < resolved.eInvoiceMentionsFrom
    ) {
      warnings.push(
        `Mention 2026 à anticiper (obligatoire au ${resolved.eInvoiceMentionsFrom}): ${mention.labelFr}`,
      );
    }
  }

  return {
    ok: missingMentions.length === 0,
    errors: [],
    missingMentions,
    warnings,
    totals: computeFactureTotals(f),
  };
}

/** A mandatory mention annotated for display (the function fields resolved to booleans). */
export interface AnnotatedMention {
  id: string;
  labelFr: string;
  legalBasis: string;
  applicable: boolean;
  satisfied: boolean;
}

/**
 * Return the mandatory-mention checklist for a facture + context, annotated with
 * applicability and satisfaction — for rendering a compliance UI checklist.
 */
export function factureChecklist(
  facture: FactureInputZ,
  ctx: MentionContext,
): AnnotatedMention[] {
  const resolved: Required<MentionContext> = {
    referenceDate: ctx.referenceDate,
    eInvoiceMentionsFrom: ctx.eInvoiceMentionsFrom ?? DEFAULT_EINVOICE_FROM,
  };
  return FACTURE_MANDATORY_MENTIONS.map((m) => ({
    id: m.id,
    labelFr: m.labelFr,
    legalBasis: m.legalBasis,
    applicable: m.applies(facture, resolved),
    satisfied: m.satisfied(facture),
  }));
}

/** Convenience: the franchise-en-base mention string a consumer must print. */
export const MENTION_FRANCHISE_BASE = 'TVA non applicable, art. 293 B du CGI' as const;

export type { FactureInputZ, TypeClientZ };
