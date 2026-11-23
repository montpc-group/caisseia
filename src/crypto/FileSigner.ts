/**
 * FileSigner — Ed25519 signing using a private key on disk.
 *
 * Loads the key from CAISSEIA_SIGNING_KEY_PATH (PEM PKCS8). Refuses to load
 * a key that is not chmod 600 (mode bits cannot grant access to group/other).
 *
 * Audit-friendly: never holds the raw private key bytes — uses Node's
 * KeyObject which stores material out of JS heap.
 */

import { promises as fs } from 'node:fs';
import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { Signer, SignerKind } from './Signer.js';
import type { SignatureEnvelope } from '../crypto.js';
import type { PublicKeyEntry } from './keyRegistry.js';
import { readEnv } from '../env.js';

export class FileSigner implements Signer {
  readonly kind: SignerKind = 'file';

  private constructor(
    private readonly privateKey: KeyObject,
    private readonly keyVersion: string,
  ) {}

  static async fromEnv(): Promise<FileSigner> {
    const keyPath = readEnv('SIGNING_KEY_PATH');
    if (!keyPath) {
      throw new Error(
        'CAISSEIA_SIGNER=file requires CAISSEIA_SIGNING_KEY_PATH to point to an Ed25519 PEM private key',
      );
    }
    const version = readEnv('SIGNING_KEY_VERSION') ?? 'v1';

    const stat = await fs.stat(keyPath);
    // POSIX mode: low 9 bits are perms. Allow only owner read/write (0600 or 0400).
    // Skip permission check on non-POSIX (Windows reports 0o666).
    if (process.platform !== 'win32') {
      const mode = stat.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new Error(
          `CAISSEIA_SIGNING_KEY_PATH "${keyPath}" must be chmod 600 (owner-only). Current mode: 0o${mode.toString(8)}`,
        );
      }
    }

    const pem = await fs.readFile(keyPath, 'utf-8');
    const privateKey = createPrivateKey({ key: pem, format: 'pem' });
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(
        `CAISSEIA_SIGNING_KEY_PATH must be an Ed25519 key, got "${privateKey.asymmetricKeyType}"`,
      );
    }

    return new FileSigner(privateKey, version);
  }

  /** Construct a signer from a pre-loaded KeyObject. Used by tests + advanced wiring. */
  static fromKeyObject(privateKey: KeyObject, keyVersion: string): FileSigner {
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('FileSigner.fromKeyObject: key must be Ed25519');
    }
    return new FileSigner(privateKey, keyVersion);
  }

  async sign(payload: string): Promise<SignatureEnvelope> {
    const sig = nodeSign(null, Buffer.from(payload, 'utf-8'), this.privateKey);
    return {
      signature: sig.toString('base64'),
      keyVersion: this.keyVersion,
      algorithm: 'ed25519',
    };
  }

  async verify(payload: string, signature: string, key: PublicKeyEntry): Promise<boolean> {
    if (key.algorithm !== 'ed25519') return false;
    const pub = createPublicKey({ key: key.publicKeyPem, format: 'pem' });
    return nodeVerify(null, Buffer.from(payload, 'utf-8'), pub, Buffer.from(signature, 'base64'));
  }

  /** Expose the public-key PEM derived from the loaded private key. */
  getPublicKeyPem(): string {
    return createPublicKey(this.privateKey).export({ type: 'spki', format: 'pem' }) as string;
  }

  getKeyVersion(): string {
    return this.keyVersion;
  }
}
