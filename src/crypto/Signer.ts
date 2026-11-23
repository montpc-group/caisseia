/**
 * Signer interface — abstraction over signing backends.
 *
 * In dev / CI we use the FileSigner (Ed25519 key on disk, chmod 600).
 * In production we plug a KMS-backed implementation (deferred to Milestone 3).
 *
 * The contract: sign(payload) → SignatureEnvelope, verify(payload, sig, pubKey) → bool.
 * Both operations log a JET event (`signing_used` / `signature_verified`) — wired
 * by the consumer when calling these (the Signer itself stays infra-only).
 */

import type { SignatureEnvelope } from '../crypto.js';
import type { PublicKeyEntry } from './keyRegistry.js';
import { readEnv } from '../env.js';

export interface Signer {
  /** Signs a canonicalized payload, returns base64 signature + key version. */
  sign(payload: string): Promise<SignatureEnvelope>;
  /** Verifies a signature using a public key from the registry. */
  verify(payload: string, signature: string, key: PublicKeyEntry): Promise<boolean>;
  /** Logical name of this signer ('file' | 'kms' | 'memory'). */
  readonly kind: SignerKind;
}

export type SignerKind = 'file' | 'kms' | 'memory';

let activeSigner: Signer | null = null;

/** Override the active signer (used at app boot and in tests). */
export function setActiveSigner(signer: Signer): void {
  activeSigner = signer;
}

/** Resolve the active signer based on env (`CAISSEIA_SIGNER`) when not explicitly set. */
export async function getActiveSigner(): Promise<Signer> {
  if (activeSigner) return activeSigner;

  const kind = (readEnv('SIGNER') ?? 'file') as SignerKind;
  if (kind === 'file') {
    const { FileSigner } = await import('./FileSigner.js');
    activeSigner = await FileSigner.fromEnv();
    return activeSigner;
  }
  if (kind === 'kms') {
    const { KmsSigner } = await import('./KmsSigner.js');
    activeSigner = new KmsSigner();
    return activeSigner;
  }
  if (kind === 'memory') {
    const { MemorySigner } = await import('./MemorySigner.js');
    activeSigner = await MemorySigner.generate();
    return activeSigner;
  }
  throw new Error(`NF525_SIGNER: unknown signer kind "${kind}"`);
}

/** Test helper. Resets the cached signer so the next call re-resolves. */
export function _resetActiveSigner(): void {
  activeSigner = null;
}
