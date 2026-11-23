/**
 * Journal des Événements Techniques (JET).
 *
 * Cf. COMPLIANCE.md § "Journal des Événements Techniques".
 *
 * Tracage immuable de toute action sensible. Le JET est lui-même
 * une chaîne hashée (cf. eventStore.ts), conservée 10 ans, restituable.
 */

import { append } from './eventStore.js';
import type { TxOptions } from './storage/EventStorage.js';
import { JetPayloadSchema, type JetPayloadZ } from '../schemas/jet.schema.js';

/**
 * Logue un événement technique dans le JET.
 * Appelé par les autres modules — rarement directement
 * par les apps consommatrices.
 */
export async function logTechnicalEvent(
  workspaceId: string,
  type: JetEventType,
  details: Record<string, unknown>,
  context: { userId?: string; sourceIp?: string } = {},
  opts: TxOptions = {},
): Promise<JetEvent> {
  const payload: JetPayloadZ = JetPayloadSchema.parse({
    type,
    details,
    ...(context.userId !== undefined ? { userId: context.userId } : {}),
    ...(context.sourceIp !== undefined ? { sourceIp: context.sourceIp } : {}),
  });
  const record = await append<JetPayloadZ>('jet', workspaceId, payload, opts);
  return {
    _id: record._id,
    workspaceId: record.workspaceId,
    sequence: record.sequence,
    recordedAt: record.recordedAt,
    type: payload.type,
    details: payload.details,
    ...(payload.userId !== undefined ? { userId: payload.userId } : {}),
    ...(payload.sourceIp !== undefined ? { sourceIp: payload.sourceIp } : {}),
    previousHash: record.previousHash,
    hash: record.hash,
  };
}

// ─── Types ────────────────────────────────────────────────────────────

export type JetEventType =
  // Système
  | 'system_boot'
  | 'system_shutdown'
  | 'config_changed'
  | 'tva_rate_changed'
  | 'signing_key_rotated'

  // Auth
  | 'user_login'
  | 'user_logout'
  | 'user_login_failed'

  // Encaissement
  | 'encaissement_recorded'
  | 'correction_recorded'
  | 'mutation_attempt_refused'  // Tentative d'altération refusée

  // Clôtures
  | 'closure_day_initiated'
  | 'closure_day_completed'
  | 'closure_month_initiated'
  | 'closure_month_completed'
  | 'closure_year_initiated'
  | 'closure_year_completed'

  // Restitution
  | 'export_requested'
  | 'export_completed'
  | 'integrity_check_run'
  | 'integrity_check_failed'

  // Mode dégradé
  | 'degraded_mode_enter'
  | 'degraded_mode_exit'
  | 'manual_entry_injected'

  // Configuration
  | 'business_calendar_set'        // Fuseau, heure de coupure, fin d'exercice (non rétroactif)
  | 'payment_method_config_changed'
  | 'operator_config_changed'

  // Erreurs
  | 'error_application'
  | 'error_compliance';

export interface JetEvent {
  _id: string;
  workspaceId: string;
  sequence: number;
  recordedAt: string;
  type: JetEventType;
  /** Détails contextuels (sans PII inutile) */
  details: Record<string, unknown>;
  /** ID utilisateur si disponible */
  userId?: string;
  /** IP source si disponible (anonymisée pour RGPD si nécessaire) */
  sourceIp?: string;
  previousHash: string;
  hash: string;
}
