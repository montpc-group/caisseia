/**
 * KmsSigner — KMS-backed Ed25519 signer.
 *
 * Concrete implementation deferred to Milestone 3 (production deployment).
 * Calling sign/verify before that throws a clear error so misconfiguration
 * is caught at startup, not at first encaissement.
 *
 * The architecture is already KMS-shaped (Signer interface, key registry with
 * versions, JET event on every sign), so swapping FileSigner → KmsSigner in M3
 * is a constructor change — no domain code touches signing internals.
 */

import type { Signer, SignerKind } from './Signer.js';
import type { SignatureEnvelope } from '../crypto.js';
import type { PublicKeyEntry } from './keyRegistry.js';

export class KmsSigner implements Signer {
  readonly kind: SignerKind = 'kms';

  async sign(_payload: string): Promise<SignatureEnvelope> {
    throw new Error(
      'NOT_IMPLEMENTED: KmsSigner is deferred to Milestone 3. ' +
        'For local development set NF525_SIGNER=file (with NF525_SIGNING_KEY_PATH).',
    );
  }

  async verify(_payload: string, _signature: string, _key: PublicKeyEntry): Promise<boolean> {
    throw new Error(
      'NOT_IMPLEMENTED: KmsSigner.verify is deferred to Milestone 3. ' +
        'For local development set NF525_SIGNER=file.',
    );
  }
}
