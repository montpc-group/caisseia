/**
 * Crypto primitives pour le chainage et la signature.
 *
 * Cf. COMPLIANCE.md § 2 (Sécurisation).
 *
 * @internal Toutes les fonctions de ce module sont des primitives bas-niveau.
 *           Les autres modules les utilisent ; les apps consommatrices ne devraient
 *           jamais les appeler directement.
 */

import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { getActiveSigner } from './crypto/Signer.js';
import { resolvePublicKey, type KeyRegistry } from './crypto/keyRegistry.js';

/** Genesis hash (premier maillon de chaque chaîne). */
export const GENESIS_HASH = '0'.repeat(64);

/** Clés monétaires sur lesquelles les flottants sont strictement interdits. */
const MONEY_KEY_PATTERN = /(centimes|montant|amount|total|cumul|tva|ht|ttc|net|brut)/i;

/**
 * Un taux n'est pas un montant : `tauxTva: 5.5`, `vatRate: 0.055`. Testé sur la
 * clé feuille seulement, pour qu'un taux sous un parent « monétaire »
 * (`totals.parTaux[].tauxTva`) reste accepté. Ce test ne fait que lever ou non
 * une erreur : la forme canonique d'une valeur acceptée ne change pas.
 */
function isRateKey(leaf: string): boolean {
  return /^(taux|rate)/i.test(leaf) || /(Rates?|_rates?)$/.test(leaf) || /(pourcent|percent)/i.test(leaf);
}

function isMoneyKey(keyContext: string): boolean {
  const leaf = keyContext.slice(keyContext.lastIndexOf('.') + 1);
  return MONEY_KEY_PATTERN.test(keyContext) && !isRateKey(leaf);
}

/**
 * Calcule le hash SHA-256 d'une chaîne.
 *
 * @param input - chaîne canonicalisée à hasher
 * @returns hash hexadécimal 64 caractères
 */
export function hash(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Sérialise un objet en JSON canonique :
 * - clés triées alphabétiquement (récursivement)
 * - aucun whitespace
 * - montants en centimes integer (jamais flottants)
 * - UTF-8 NFC, échappement conforme RFC 8785 / ECMAScript JSON.stringify
 *
 * Compatible RFC 8785 (JSON Canonicalization Scheme) pour les types
 * supportés ici (string, number entier, boolean, null, array, object).
 *
 * @param obj - objet à canonicaliser
 * @returns chaîne JSON canonique déterministe
 */
export function canonicalize(obj: unknown): string {
  return canonicalizeValue(obj, '');
}

function canonicalizeValue(value: unknown, keyContext: string): string {
  if (value === null) return 'null';
  if (value === undefined) {
    throw new Error('NF525_CANONICALIZE: undefined is not representable in canonical JSON');
  }

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new Error('NF525_CANONICALIZE: non-finite number is forbidden');
    }
    if (!Number.isInteger(n) && isMoneyKey(keyContext)) {
      throw new Error(
        `NF525_CANONICALIZE: float forbidden on monetary key "${keyContext}" (got ${n})`,
      );
    }
    // RFC 8785: numbers serialize as JSON.stringify on integers; floats use shortest round-trip.
    // For integers, JSON.stringify is canonical.
    return JSON.stringify(n);
  }

  if (t === 'bigint') {
    // BigInt isn't valid JSON; we permit it as a stringified integer to keep amounts safe.
    return JSON.stringify((value as bigint).toString());
  }

  if (t === 'string') {
    // NFC normalize and escape via JSON.stringify (RFC 8785 compatible for BMP chars).
    return JSON.stringify((value as string).normalize('NFC'));
  }

  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalizeValue(v, keyContext)).join(',') + ']';
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    const parts = keys.map((k) => {
      const childKey = keyContext ? `${keyContext}.${k}` : k;
      return JSON.stringify(k.normalize('NFC')) + ':' + canonicalizeValue(obj[k], childKey);
    });
    return '{' + parts.join(',') + '}';
  }

  throw new Error(`NF525_CANONICALIZE: unsupported type ${t}`);
}

/**
 * Vérifie l'intégrité d'une chaîne hashée.
 * Pour chaque enregistrement i ≥ 1 :
 *  - record[i].previousHash === record[i-1].hash
 *  - record[i].hash === sha256(canonicalize(record_sans_hash))
 *
 * Le premier enregistrement doit avoir previousHash = GENESIS_HASH.
 *
 * @param chain - séquence d'enregistrements liés, ordonnée par sequence ASC.
 */
export function verifyChain(chain: HashedRecord[]): ChainVerificationResult {
  for (let i = 0; i < chain.length; i++) {
    const rec = chain[i]!;
    const expectedPrev = i === 0 ? GENESIS_HASH : chain[i - 1]!.hash;
    if (rec.previousHash !== expectedPrev) {
      return {
        valid: false,
        brokenAt: i,
        expectedHash: expectedPrev,
        actualHash: rec.previousHash,
        message: `previousHash mismatch at index ${i}`,
      };
    }
    const recomputed = hash(canonicalize(stripHash(rec)));
    if (recomputed !== rec.hash) {
      return {
        valid: false,
        brokenAt: i,
        expectedHash: recomputed,
        actualHash: rec.hash,
        message: `payload hash mismatch at index ${i}`,
      };
    }
  }
  return { valid: true };
}

function stripHash(rec: HashedRecord): unknown {
  const { hash: _h, ...rest } = rec as HashedRecord & Record<string, unknown>;
  return rest;
}

/**
 * Signe une charge utile (clôture, manifeste, …) via le Signer actif.
 * En M1 le Signer par défaut est `FileSigner` (Ed25519 sur disque).
 *
 * @param payload - charge canonicalisée à signer
 * @returns signature base64
 */
export async function signClosure(payload: string): Promise<SignatureEnvelope> {
  const signer = await getActiveSigner();
  return signer.sign(payload);
}

/**
 * Vérifie une signature à partir du keyRegistry public (celui passé en
 * argument, sinon le registre chargé). Vérification par clé publique seule :
 * aucun Signer / clé privée requis (vérification offline).
 * Lève une erreur si la version de clé est absente du registre.
 */
export async function verifySignature(
  payload: string,
  signature: string,
  keyVersion: string,
  registry?: KeyRegistry,
): Promise<boolean> {
  const entry = await resolvePublicKey(keyVersion, registry);
  if (entry.algorithm !== 'ed25519') return false;
  const pub = createPublicKey({ key: entry.publicKeyPem, format: 'pem' });
  return nodeVerify(null, Buffer.from(payload, 'utf-8'), pub, Buffer.from(signature, 'base64'));
}

/**
 * Vérifie la signature d'un payload de clôture (signé sur son skeleton
 * sans signature, cf. closures.ts sealAndBuildPayload).
 * @returns null si valide, sinon la raison de l'échec.
 */
export async function verifyClosureSignature(
  payload: {
    type: string;
    periodStart: string;
    periodEnd: string;
    closedAt: string;
    aggregate: unknown;
    schemaVersion?: number;
    chainHeads?: unknown;
    previousClosureHash?: string;
    signature: string;
    signingKeyVersion: string;
  },
  registry: KeyRegistry,
): Promise<string | null> {
  // v2 signs schemaVersion + chainHeads + previousClosureHash too; on v1 they are undefined and
  // canonicalize drops them, so legacy signatures still verify.
  const { type, periodStart, periodEnd, closedAt, aggregate, schemaVersion, chainHeads, previousClosureHash } = payload;
  try {
    const ok = await verifySignature(
      canonicalize({ type, periodStart, periodEnd, closedAt, aggregate, schemaVersion, chainHeads, previousClosureHash }),
      payload.signature,
      payload.signingKeyVersion,
      registry,
    );
    return ok ? null : 'signature invalid';
  } catch (err) {
    return (err as Error).message;
  }
}

// ─── Types ────────────────────────────────────────────────────────────

export interface HashedRecord {
  hash: string;
  previousHash: string;
  [k: string]: unknown;
}

export interface ChainVerificationResult {
  valid: boolean;
  brokenAt?: number;
  expectedHash?: string;
  actualHash?: string;
  message?: string;
}

export interface SignatureEnvelope {
  /** Signature encodée en base64. */
  signature: string;
  /** Version de clé utilisée (cf. keys/public-keys.json). */
  keyVersion: string;
  /** Algorithme (ex: 'ed25519'). */
  algorithm: 'ed25519';
}
