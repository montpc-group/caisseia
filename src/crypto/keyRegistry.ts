/**
 * Public-key registry — tracks every signing key version that has ever been
 * used to seal a closure / export. Required for offline verification of an
 * archived export ten years from now.
 *
 * The registry is committed at `keys/public-keys.json` and bundled in every
 * restitution export (see Milestone 3). Each entry is a public key only;
 * private keys live with their Signer (file on disk, KMS in prod).
 *
 * Schema:
 * {
 *   "keys": [
 *     { "version": "v1", "algorithm": "ed25519",
 *       "publicKeyPem": "-----BEGIN PUBLIC KEY-----...",
 *       "validFrom": "2026-04-26T00:00:00Z",
 *       "validUntil": null }
 *   ]
 * }
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { readEnv } from '../env.js';

export interface PublicKeyEntry {
  version: string;
  algorithm: 'ed25519';
  publicKeyPem: string;
  validFrom: string;
  validUntil: string | null;
}

export interface KeyRegistry {
  keys: PublicKeyEntry[];
}

let cached: KeyRegistry | null = null;
let cachedPath: string | null = null;
let testOverride: KeyRegistry | null = null;

function defaultRegistryPath(): string {
  // Resolve ./keys/public-keys.json relative to package root (compiled in dist/crypto/).
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, '..', '..', 'keys', 'public-keys.json');
}

/** Load the registry from disk (cached). Path overridable via CAISSEIA_KEY_REGISTRY_PATH. */
export async function loadRegistry(path?: string): Promise<KeyRegistry> {
  if (testOverride) return testOverride;
  const p = path ?? readEnv('KEY_REGISTRY_PATH') ?? defaultRegistryPath();
  if (cached && cachedPath === p) return cached;
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as KeyRegistry;
    if (!parsed.keys || !Array.isArray(parsed.keys)) {
      throw new Error(`NF525_KEY_REGISTRY: malformed registry at ${p}`);
    }
    cached = parsed;
    cachedPath = p;
    return parsed;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      cached = { keys: [] };
      cachedPath = p;
      return cached;
    }
    throw err;
  }
}

/** Resolve a public key by version. Throws if not found. */
export async function resolvePublicKey(
  version: string,
  registry?: KeyRegistry,
): Promise<PublicKeyEntry> {
  const reg = registry ?? (await loadRegistry());
  const entry = reg.keys.find((k) => k.version === version);
  if (!entry) {
    throw new Error(`NF525_KEY_REGISTRY: no public key found for version "${version}"`);
  }
  return entry;
}

/** Test helper: inject a registry without hitting disk. */
export function _setRegistryForTests(reg: KeyRegistry | null): void {
  testOverride = reg;
  cached = null;
  cachedPath = null;
}
