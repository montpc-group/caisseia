/**
 * Shared test helpers — wires an in-memory storage + memory signer + key
 * registry for each test, returning a handle to inspect / tamper.
 *
 * Tests should call `await freshHarness()` in their `beforeEach` (or per-test)
 * so state isolation is explicit. No global mutable state leaks across files.
 */

import { InMemoryStorage, setActiveStorage, _resetActiveStorage } from '../src/storage/index.js';
import { MemorySigner } from '../src/crypto/MemorySigner.js';
import { setActiveSigner, _resetActiveSigner } from '../src/crypto/Signer.js';
import { _setRegistryForTests } from '../src/crypto/keyRegistry.js';

export interface Harness {
  storage: InMemoryStorage;
  signer: MemorySigner;
  workspace: string;
  reset(): Promise<void>;
}

export async function freshHarness(workspace = 'ws-test'): Promise<Harness> {
  _resetActiveStorage();
  _resetActiveSigner();

  const storage = new InMemoryStorage();
  setActiveStorage(storage);

  const signer = await MemorySigner.generate('test-v1');
  setActiveSigner(signer);

  _setRegistryForTests({
    keys: [
      {
        version: signer.getKeyVersion(),
        algorithm: 'ed25519',
        publicKeyPem: signer.getPublicKeyPem(),
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: null,
      },
    ],
  });

  return {
    storage,
    signer,
    workspace,
    async reset() {
      await storage.close();
      _resetActiveStorage();
      _resetActiveSigner();
      _setRegistryForTests(null);
    },
  };
}
