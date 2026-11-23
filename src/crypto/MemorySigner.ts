/**
 * MemorySigner — generates an Ed25519 keypair in memory.
 *
 * For tests only. Never used in dev (FileSigner) or prod (KmsSigner).
 * Key never leaves the process; verify uses the matching public key
 * exposed via getPublicKeyPem().
 */

import { generateKeyPairSync, sign as nodeSign, createPublicKey, verify as nodeVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { Signer, SignerKind } from './Signer.js';
import type { SignatureEnvelope } from '../crypto.js';
import type { PublicKeyEntry } from './keyRegistry.js';

export class MemorySigner implements Signer {
  readonly kind: SignerKind = 'memory';

  private constructor(
    private readonly privateKey: KeyObject,
    private readonly publicKey: KeyObject,
    private readonly keyVersion: string,
  ) {}

  static async generate(version = 'test-v1'): Promise<MemorySigner> {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return new MemorySigner(privateKey, publicKey, version);
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

  getPublicKeyPem(): string {
    return this.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  }

  getKeyVersion(): string {
    return this.keyVersion;
  }
}
