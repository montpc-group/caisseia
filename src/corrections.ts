/**
 * Écritures correctives.
 *
 * Cf. COMPLIANCE.md § 1 (Inaltérabilité).
 *
 * Une correction n'est jamais une modification de l'encaissement original.
 * C'est un nouvel enregistrement qui référence l'original avec un montant
 * signé (positif ou négatif). Le total net se calcule à la lecture.
 */

import { append, read, withStreamLock } from './eventStore.js';
import { logTechnicalEvent } from './jet.js';
import { AppendConflictError, type TxOptions } from './storage/EventStorage.js';
import {
  CorrectionInputSchema,
  type EncaissementStreamPayload,
} from '../schemas/encaissement.schema.js';

const CORRECTION_MAX_ATTEMPTS = 3;

/**
 * Enregistre une correction sur un encaissement existant.
 * La correction crée un NOUVEL enregistrement, l'original reste intact.
 *
 * @param workspaceId - identifiant du workspace
 * @param input - données de la correction
 * La lecture du net, sa vérification et l'écriture se font sous le verrou du
 * flux 'encaissement' : deux corrections parallèles sur le même original ne
 * peuvent pas valider le même net (le net ne passe jamais sous 0).
 * Sans `client`, un conflit de séquence avec un écrivain qui ne prend pas ce
 * verrou (encaissement sans `client`) annule la transaction du SDK et rejoue
 * toute l'étape (net relu), comme `append` rejoue la sienne.
 *
 * @param opts - `client` : verrou, lecture de l'original, correction et entrée
 *   JET sur la connexion de l'appelant, dans sa transaction ; jamais relâchée
 *   par le SDK. Sans `client`, le SDK ouvre sa propre transaction.
 * @returns la correction enregistrée
 */
export async function recordCorrection(
  workspaceId: string,
  input: CorrectionInput,
  opts: TxOptions = {},
): Promise<Correction> {
  const validated = CorrectionInputSchema.parse(input);
  const attempts = opts.client ? 1 : CORRECTION_MAX_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await withStreamLock(
        'encaissement',
        workspaceId,
        (locked) => recordCorrectionLocked(workspaceId, validated, locked),
        opts,
      );
    } catch (err) {
      if (err instanceof AppendConflictError && attempt < attempts) continue;
      throw err;
    }
  }
}

async function recordCorrectionLocked(
  workspaceId: string,
  validated: CorrectionInput,
  opts: TxOptions,
): Promise<Correction> {
  // 1. Validate that the original exists and is an 'encaissement' (not a correction).
  const all = await read<EncaissementStreamPayload>('encaissement', workspaceId, { client: opts.client });
  const original = all.find(
    (r) => r._id === validated.originalId && r.payload.type === 'encaissement',
  );
  if (!original) {
    throw new Error(
      `NF525_CORRECTION: original encaissement "${validated.originalId}" not found in workspace "${workspaceId}"`,
    );
  }
  const originalData = original.payload.type === 'encaissement' ? original.payload.data : null;
  if (!originalData) {
    throw new Error(
      `NF525_CORRECTION: target "${validated.originalId}" is not an encaissement (cannot correct a correction)`,
    );
  }
  if (originalData.devise !== validated.devise) {
    throw new Error(
      `NF525_CORRECTION: devise mismatch (original=${originalData.devise}, correction=${validated.devise})`,
    );
  }

  // 2. Validate that net amount stays sane.
  const correctionsForOriginal = all.filter(
    (r) => r.payload.type === 'correction' && r.payload.data.originalId === validated.originalId,
  );
  const currentNet =
    originalData.montantCentimes +
    correctionsForOriginal.reduce(
      (acc, r) =>
        r.payload.type === 'correction' ? acc + r.payload.data.montantCentimes : acc,
      0,
    );
  const projectedNet = currentNet + validated.montantCentimes;

  if (validated.type === 'annulation_totale') {
    // annulation_totale must zero out the net.
    if (projectedNet !== 0) {
      throw new Error(
        `NF525_CORRECTION: annulation_totale must bring net to 0 (projected=${projectedNet}, expected=0)`,
      );
    }
  } else if (projectedNet < 0) {
    throw new Error(
      `NF525_CORRECTION: cumulative corrections would bring net amount negative (projected=${projectedNet})`,
    );
  }

  // 3. Append to the same 'encaissement' stream.
  const payload: EncaissementStreamPayload = {
    type: 'correction',
    data: validated,
  };
  const record = await append<EncaissementStreamPayload>(
    'encaissement',
    workspaceId,
    payload,
    opts,
  );

  // 4. Log to JET.
  await logTechnicalEvent(workspaceId, 'correction_recorded', {
    correctionId: record._id,
    originalId: validated.originalId,
    montantCentimes: validated.montantCentimes,
    correctionType: validated.type,
    reason: validated.reason,
  }, {}, opts);

  return {
    _id: record._id,
    workspaceId: record.workspaceId,
    sequence: record.sequence,
    recordedAt: record.recordedAt,
    data: validated,
    previousHash: record.previousHash,
    hash: record.hash,
    type: 'correction',
  };
}

/**
 * Calcule le montant net d'un encaissement après application
 * de toutes les corrections référençantes.
 */
export async function getNetAmount(
  workspaceId: string,
  originalId: string,
): Promise<number> {
  const all = await read<EncaissementStreamPayload>('encaissement', workspaceId);
  const original = all.find(
    (r) => r._id === originalId && r.payload.type === 'encaissement',
  );
  if (!original || original.payload.type !== 'encaissement') {
    throw new Error(
      `NF525_GET_NET: encaissement "${originalId}" not found in workspace "${workspaceId}"`,
    );
  }
  let total = original.payload.data.montantCentimes;
  for (const r of all) {
    if (r.payload.type === 'correction' && r.payload.data.originalId === originalId) {
      total += r.payload.data.montantCentimes;
    }
  }
  return total;
}

// ─── Types ────────────────────────────────────────────────────────────

export type CorrectionType =
  | 'erreur_montant'           // Montant erroné
  | 'remboursement_partiel'    // Remboursement client partiel
  | 'remboursement_total'      // Remboursement client intégral
  | 'annulation_totale'        // Annulation complète (mission non rendue)
  | 'avoir_commercial'         // Geste commercial post-mission
  | 'autre';

export interface CorrectionInput {
  /** ID de l'encaissement original à corriger */
  originalId: string;
  /** Montant signé en centimes (négatif pour remboursement, positif pour rectif à la hausse) */
  montantCentimes: number;
  /** Devise (doit matcher l'original) */
  devise: 'EUR' | 'CHF';
  /** Type de correction */
  type: CorrectionType;
  /** Raison documentée (obligatoire) */
  reason: string;
  /** Référence externe (ex: refund Stripe id) */
  stripeRefundId?: string;
  /** Identifiant de l'opérateur ayant enregistré la correction */
  operatorId?: string;
}

export interface Correction {
  _id: string;
  workspaceId: string;
  sequence: number;
  recordedAt: string;
  data: CorrectionInput;
  previousHash: string;
  hash: string;
  /** Type de l'enregistrement */
  type: 'correction';
}
