/**
 * CAISSEIA
 *
 * Registre inaltérable des encaissements (art. 286 I 3° bis CGI).
 *
 * Cf. README.md pour usage, COMPLIANCE.md pour le mapping légal.
 *
 * NE PAS UTILISER EN PRODUCTION TANT QUE :
 * - Toutes les fonctions sont implémentées
 * - Une attestation v1.0.0 est signée et archivée
 */

// ─── Public API surface (Milestone 1) ─────────────────────────────────

export {
  recordEncaissement,
  type Encaissement,
  type EncaissementInput,
  type ModePaiement,
} from './encaissement.js';

export {
  recordCorrection,
  getNetAmount,
  type Correction,
  type CorrectionInput,
  type CorrectionType,
} from './corrections.js';

export {
  logTechnicalEvent,
  type JetEvent,
  type JetEventType,
} from './jet.js';

export {
  verifyChainIntegrity,
  type IntegrityReport,
} from './integrity.js';

// ─── Public API surface (deferred to M2/M3 — exports kept for type stability) ─

export {
  closeDay,
  closeMonth,
  closeYear,
  getCurrentDayClosure,
  getMonthClosure,
  getYearClosure,
  type Closure,
  type ClosureType,
  type ClosureAggregate,
  type CloseOptions,
} from './closures.js';

export {
  exportPeriod,
  verifyExportIntegrity,
  generateManifest,
  type ExportFormat,
  type ExportManifest,
  type ExportResult,
  type ExportFile,
  type ExportIntegrityResult,
} from './restitution.js';

export {
  generateAttestation,
  renderSummaryReportPdf,
  type AttestationInput,
  type AttestationDocument,
  type SummaryReportData,
} from './attestation.js';

// ─── Infra surface (advanced wiring) ──────────────────────────────────

export {
  setActiveStorage,
  getActiveStorage,
  InMemoryStorage,
  PostgresStorage,
  type EventStorage,
} from './storage/index.js';
export type { TxOptions } from './storage/EventStorage.js';

export { migrate, type MigrateOptions } from './storage/migrate.js';

export {
  setActiveSigner,
  getActiveSigner,
  type Signer,
} from './crypto/Signer.js';

export {
  hash,
  canonicalize,
  verifyChain,
  GENESIS_HASH,
  type HashedRecord,
  type ChainVerificationResult,
  type SignatureEnvelope,
} from './crypto.js';

// ─── Configuration ────────────────────────────────────────────────────

/**
 * Configuration globale du module.
 * À initialiser une fois au démarrage de chaque app consommatrice.
 */
export interface NF525Config {
  /** Connection Postgres pour la table nf525_event (rôle nf525_app). */
  databaseUrl: string;

  /** Identifiant du workspace/tenant (multi-tenant) — défaut, peut être surchargé par appel. */
  defaultWorkspaceId?: string;

  /**
   * Backend de signature ('file' | 'kms' | 'memory').
   * Surchargeable par NF525_SIGNER. 'file' attend NF525_SIGNING_KEY_PATH.
   */
  signerKind?: 'file' | 'kms' | 'memory';

  /** Chemin de stockage des exports DGFIP générés. */
  exportPath?: string;

  /** Devise par défaut (EUR pour France, CHF pour Suisse). */
  defaultCurrency: 'EUR' | 'CHF';

  /** Taux de TVA configurés pour ce workspace. */
  tvaRates: { code: string; rate: number; label: string }[];
}

/**
 * Initialise le module avec la configuration de l'app consommatrice.
 * Doit être appelé une seule fois au démarrage. Idempotent.
 */
export async function initialize(config: NF525Config): Promise<void> {
  if (!config.databaseUrl) {
    throw new Error('NF525.initialize: databaseUrl is required');
  }
  // Defer wiring until first use — getActiveStorage / getActiveSigner read env.
  // For now we only set process.env so subsequent lazy resolves see the values.
  if (!process.env['NF525_DATABASE_URL']) {
    process.env['NF525_DATABASE_URL'] = config.databaseUrl;
  }
  if (config.signerKind && !process.env['NF525_SIGNER']) {
    process.env['NF525_SIGNER'] = config.signerKind;
  }
  if (!process.env['NF525_STORAGE']) {
    process.env['NF525_STORAGE'] = 'postgres';
  }
}

// ─── Constants ────────────────────────────────────────────────────────

/** Version du module — synchronisée avec package.json */
export const MODULE_VERSION = '1.0.0-rc.5';

/** Référence légale principale */
export const LEGAL_REFERENCE = 'Article 286 I 3°bis CGI';

/** Algorithme de hash utilisé pour le chainage */
export const HASH_ALGORITHM = 'sha256' as const;
