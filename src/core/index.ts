/**
 * caisseia/core — country-agnostic engine
 *
 * Pure plumbing: append-only hash-chained event store, crypto primitives
 * (SHA-256, RFC 8785 canonicalisation, Ed25519 sign/verify), pluggable
 * Signer / Storage adapters, public-key registry.
 *
 * **No knowledge of French regulation, French VAT codes, JET event vocabulary,
 * BOFIP attestation templates, or any other FR-specific semantics.**
 *
 * This subpath exists so a future country adapter (`caisseia/es` for Spain
 * VeriFactu, `caisseia/it` for Italian RT cloud, etc.) can import only the
 * engine without pulling in `caisseia/fr`. The behaviour is identical to
 * what `caisseia` already shipped — this is a structural re-export, not a
 * refactor.
 *
 */

// ─── Crypto primitives ────────────────────────────────────────────────

export {
  hash,
  canonicalize,
  verifyChain,
  signClosure,
  verifySignature,
  GENESIS_HASH,
  type HashedRecord,
  type ChainVerificationResult,
  type SignatureEnvelope,
} from '../crypto.js';

// ─── Signer abstraction ───────────────────────────────────────────────

export {
  setActiveSigner,
  getActiveSigner,
  _resetActiveSigner,
  type Signer,
  type SignerKind,
} from '../crypto/Signer.js';

export { MemorySigner } from '../crypto/MemorySigner.js';
export { FileSigner } from '../crypto/FileSigner.js';
export { KmsSigner } from '../crypto/KmsSigner.js';

// ─── Public-key registry ──────────────────────────────────────────────

export {
  loadRegistry,
  resolvePublicKey,
  _setRegistryForTests,
  type PublicKeyEntry,
  type KeyRegistry,
} from '../crypto/keyRegistry.js';

// ─── Storage adapters ─────────────────────────────────────────────────

export {
  setActiveStorage,
  getActiveStorage,
  _resetActiveStorage,
  InMemoryStorage,
  PostgresStorage,
  type StorageKind,
} from '../storage/index.js';

export {
  AppendConflictError,
  InalterableViolationError,
  type EventStorage,
  type AppendInput,
  type ReadFilter,
} from '../storage/EventStorage.js';

// ─── Event store (generic append/read over arbitrary payloads) ───────

export {
  append,
  read,
  getLast,
  type StreamName,
  type EventRecord,
  type ReadOptions,
} from '../eventStore.js';
