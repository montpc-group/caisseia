/**
 * Enregistrement des encaissements.
 *
 * Cf. COMPLIANCE.md § 1 (Inaltérabilité).
 *
 * API minimale : seule fonction publique = recordEncaissement.
 * Pas de update. Pas de delete. Les corrections passent par corrections.ts.
 */

import { append } from './eventStore.js';
import { logTechnicalEvent } from './jet.js';
import type { TxOptions } from './storage/EventStorage.js';
import {
  EncaissementInputSchema,
  type EncaissementStreamPayload,
} from '../schemas/encaissement.schema.js';

/**
 * Enregistre un nouvel encaissement.
 * Une fois enregistré, l'encaissement est immutable.
 * Pour le corriger : voir recordCorrection() dans corrections.ts.
 *
 * @param workspaceId - identifiant du workspace (multi-tenant)
 * @param input - données du paiement client
 * @param opts - `client` : l'encaissement et son entrée JET sont écrits sur la
 *   connexion de l'appelant, dans sa transaction ; la connexion n'est jamais
 *   relâchée par le SDK
 * @returns l'encaissement enregistré (avec hash + sequence)
 */
export async function recordEncaissement(
  workspaceId: string,
  input: EncaissementInput,
  opts: TxOptions = {},
): Promise<Encaissement> {
  const validated = EncaissementInputSchema.parse(input);
  const payload: EncaissementStreamPayload = {
    type: 'encaissement',
    data: validated,
  };
  const record = await append<EncaissementStreamPayload>(
    'encaissement',
    workspaceId,
    payload,
    opts,
  );

  await logTechnicalEvent(workspaceId, 'encaissement_recorded', {
    encaissementId: record._id,
    sequence: record.sequence,
    montantCentimes: validated.montantCentimes,
    devise: validated.devise,
    mode: validated.mode,
    tvaCode: validated.tvaCode,
  }, {}, opts);

  return {
    _id: record._id,
    workspaceId: record.workspaceId,
    sequence: record.sequence,
    recordedAt: record.recordedAt,
    data: validated,
    previousHash: record.previousHash,
    hash: record.hash,
    type: 'encaissement',
  };
}

// ─── Types ────────────────────────────────────────────────────────────

export type ModePaiement =
  | 'especes'
  | 'cb'
  | 'cb_mobile'
  | 'virement'
  | 'cheque'
  | 'stripe'
  | 'wallet'           // Apple Pay, Google Pay
  | 'autre';

export interface EncaissementInput {
  /** Montant en centimes (jamais en flottant) */
  montantCentimes: number;
  /** Devise ISO 4217 */
  devise: 'EUR' | 'CHF';
  /** Mode de paiement */
  mode: ModePaiement;
  /** Code TVA appliqué (ex: 'TVA20', 'FRANCHISE_BASE') */
  tvaCode: string;
  /** Identifiant de la facture associée (si applicable) */
  factureId?: string;
  /** Identifiant de la réservation associée (si l'application en gère) */
  reservationId?: string;
  /** Identifiant client (pour traçabilité, anonymisable) */
  clientRef?: string;
  /** Référence externe Stripe (charge_id, payment_intent_id) */
  stripeRef?: string;
  /** Notes opérateur (limitées, pas de PII inutile) */
  notes?: string;
  /** Identifiant de l'opérateur ayant enregistré (traçabilité BOFIP) */
  operatorId?: string;
  /** Identifiant du terminal/caisse (multi-registre) */
  registerId?: string;
}

export interface Encaissement {
  _id: string;
  workspaceId: string;
  /** Numéro séquentiel global du flux encaissement (immutable, pas de gap) */
  sequence: number;
  /** Date d'enregistrement serveur */
  recordedAt: string;
  /** Données fournies à l'input */
  data: EncaissementInput;
  /** Hash de l'encaissement précédent dans le flux */
  previousHash: string;
  /** Hash propre */
  hash: string;
  /** Type de l'enregistrement (utile pour différencier encaissement original vs correction) */
  type: 'encaissement';
}
