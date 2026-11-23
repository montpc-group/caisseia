/**
 * Zod validation schema for JET (Journal d'Événements Techniques) entries.
 *
 * Cf. src/jet.ts for the public API.
 *
 * Every boundary call to logTechnicalEvent runs payloads through this schema
 * before they hit the event store — the JET is itself an inalterable chain,
 * so we cannot afford a malformed entry slipping in.
 */

import { z } from 'zod';

export const JET_SCHEMA_VERSION = 1;

export const JetEventTypeSchema = z.enum([
  // Système
  'system_boot',
  'system_shutdown',
  'config_changed',
  'tva_rate_changed',
  'signing_key_rotated',

  // Auth
  'user_login',
  'user_logout',
  'user_login_failed',

  // Encaissement
  'encaissement_recorded',
  'correction_recorded',
  'mutation_attempt_refused',

  // Clôtures
  'closure_day_initiated',
  'closure_day_completed',
  'closure_month_initiated',
  'closure_month_completed',
  'closure_year_initiated',
  'closure_year_completed',

  // Restitution
  'export_requested',
  'export_completed',
  'integrity_check_run',
  'integrity_check_failed',

  // Mode dégradé
  'degraded_mode_enter',
  'degraded_mode_exit',
  'manual_entry_injected',

  // Configuration
  'payment_method_config_changed',
  'operator_config_changed',

  // Erreurs
  'error_application',
  'error_compliance',
]);

/** Details object — must be a JSON-serializable record without nested undefineds. */
export const JetDetailsSchema = z.record(z.unknown()).default({});

export const JetPayloadSchema = z
  .object({
    type: JetEventTypeSchema,
    details: JetDetailsSchema,
    userId: z.string().min(1).max(128).optional(),
    sourceIp: z.string().min(1).max(64).optional(),
  })
  .strict();

export type JetPayloadZ = z.infer<typeof JetPayloadSchema>;
