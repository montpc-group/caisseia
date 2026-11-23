/**
 * caisseia/fr — France-specific layer (art. 286 I 3° bis CGI / BOFIP)
 *
 * Builds the French fiscal compliance surface on top of `caisseia/core`:
 *
 *  - `recordEncaissement` — FR ModePaiement (especes/cb/...) + tvaCode
 *  - `recordCorrection`   — FR CorrectionType (remboursement_partiel, ...)
 *  - `logTechnicalEvent`  — FR JetEventType vocabulary
 *  - `closeDay/Month/Year`— FR closure model (cumul perpétuel, parTva, parMode)
 *  - `exportPeriod`       — DGFIP-shaped CSV/JSON/PDF export
 *  - `generateAttestation`— BOFIP attestation éditeur PDF (volet 1 + 2)
 *  - `verifyChainIntegrity` — wraps core chain verification over the FR streams
 *
 * Anything in this barrel encodes French regulatory choices. A sibling
 * `caisseia/es` (Spain VeriFactu) or `caisseia/it` (Italian RT) would
 * sit at the same level and depend on `caisseia/core` directly.
 *
 * For backwards compatibility, `caisseia` (root) re-exports both `core`
 * and `fr` — so existing consumers keep `import { recordEncaissement } from
 * 'caisseia'` and never notice the split.
 */

// ─── Re-export core so a consumer who only wants FR can import a single subpath
export * from '../core/index.js';

// ─── FR domain APIs ──────────────────────────────────────────────────

export {
  recordEncaissement,
  type Encaissement,
  type EncaissementInput,
  type ModePaiement,
} from '../encaissement.js';

export {
  recordCorrection,
  getNetAmount,
  type Correction,
  type CorrectionInput,
  type CorrectionType,
} from '../corrections.js';

export {
  logTechnicalEvent,
  type JetEvent,
  type JetEventType,
} from '../jet.js';

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
} from '../closures.js';

export {
  exportPeriod,
  verifyExportIntegrity,
  generateManifest,
  type ExportFormat,
  type ExportManifest,
  type ExportResult,
  type ExportFile,
  type ExportIntegrityResult,
} from '../restitution.js';

export {
  generateAttestation,
  renderSummaryReportPdf,
  type AttestationInput,
  type AttestationDocument,
  type SummaryReportData,
} from '../attestation.js';

export {
  verifyChainIntegrity,
  type IntegrityReport,
} from '../integrity.js';

// ─── FR Zod schemas (validation contracts) ───────────────────────────

export {
  EncaissementInputSchema,
  CorrectionInputSchema,
  EncaissementPayloadSchema,
  CorrectionPayloadSchema,
  EncaissementStreamPayloadSchema,
  ModePaiementSchema,
  DeviseSchema,
  CorrectionTypeSchema,
  ENCAISSEMENT_SCHEMA_VERSION,
  type EncaissementInputZ,
  type CorrectionInputZ,
  type EncaissementStreamPayload,
} from '../../schemas/encaissement.schema.js';

export {
  ClosurePayloadSchema,
  ClosureAggregateSchema,
  ClosureTypeSchema,
  CLOSURE_SCHEMA_VERSION,
  type ClosurePayloadZ,
} from '../../schemas/cloture.schema.js';

export {
  JetPayloadSchema,
  JetEventTypeSchema,
  JetDetailsSchema,
  JET_SCHEMA_VERSION,
  type JetPayloadZ,
} from '../../schemas/jet.schema.js';

// ─── FR facture (invoice) — mentions obligatoires + validation ───────

export {
  FactureInputSchema,
  VendeurSchema,
  ClientSchema,
  LigneFactureSchema,
  ConditionsPaiementSchema,
  PostalAddressSchema,
  RegimeTvaSchema,
  NatureOperationSchema,
  TypeClientSchema,
  TauxTvaSchema,
  FACTURE_SCHEMA_VERSION,
  type FactureInputZ,
  type VendeurZ,
  type ClientZ,
  type LigneFactureZ,
  type ConditionsPaiementZ,
  type PostalAddressZ,
  type RegimeTvaZ,
  type NatureOperationZ,
  type TypeClientZ,
} from '../../schemas/facture.schema.js';

export {
  computeFactureTotals,
  validateFacture,
  factureChecklist,
  FACTURE_MANDATORY_MENTIONS,
  MENTION_FRANCHISE_BASE,
  type FactureTotals,
  type FactureTotalParTaux,
  type MentionContext,
  type MandatoryMention,
  type AnnotatedMention,
  type MissingMention,
  type FactureValidationResult,
} from './facture.js';

// ─── FR constants ────────────────────────────────────────────────────

export {
  MODULE_VERSION,
  LEGAL_REFERENCE,
  HASH_ALGORITHM,
  initialize,
  type NF525Config,
} from '../index.js';
