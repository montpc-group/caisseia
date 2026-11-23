/**
 * Unit tests for crypto primitives — canonicalize, hash, verifyChain, signing.
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  hash,
  verifyChain,
  signClosure,
  verifySignature,
  GENESIS_HASH,
} from '../src/crypto.js';
import { freshHarness } from './_helpers.js';

describe('crypto.canonicalize', () => {
  it('sorts keys recursively', () => {
    expect(canonicalize({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('refuses non-finite numbers', () => {
    expect(() => canonicalize({ x: NaN })).toThrow(/non-finite/);
    expect(() => canonicalize({ x: Infinity })).toThrow(/non-finite/);
  });

  it('refuses floats on monetary keys', () => {
    expect(() => canonicalize({ montantCentimes: 1.5 })).toThrow(/float forbidden/);
    expect(() => canonicalize({ caTotalCentimes: 100.5 })).toThrow(/float forbidden/);
    // But integers are fine.
    expect(canonicalize({ montantCentimes: 100 })).toBe('{"montantCentimes":100}');
  });

  it('allows non-money floats', () => {
    expect(canonicalize({ ratio: 0.5 })).toBe('{"ratio":0.5}');
  });

  it('a rate is not an amount: tauxTva 5.5 / 2.1 are accepted, wherever they sit', () => {
    expect(canonicalize({ tauxTva: 5.5 })).toBe('{"tauxTva":5.5}');
    expect(canonicalize({ document: { lignes: [{ tauxTva: 2.1, montantHtCentimes: 1000 }] } })).toBe(
      '{"document":{"lignes":[{"montantHtCentimes":1000,"tauxTva":2.1}]}}',
    );
    // A float under a money-named parent is still accepted when the leaf is a rate.
    expect(canonicalize({ totals: { parTaux: [{ tauxTva: 5.5, montantTvaCentimes: 55 }] } })).toBe(
      '{"totals":{"parTaux":[{"montantTvaCentimes":55,"tauxTva":5.5}]}}',
    );
    expect(canonicalize({ taux: [5.5, 20] })).toBe('{"taux":[5.5,20]}');
    expect(canonicalize({ vatRate: 0.055 })).toBe('{"vatRate":0.055}');
  });

  it('an amount stays an amount: montantTva and friends still refuse floats', () => {
    expect(() => canonicalize({ montantTva: 5.5 })).toThrow(/float forbidden/);
    expect(() => canonicalize({ tva: 1.1 })).toThrow(/float forbidden/);
    expect(() => canonicalize({ totals: { parTaux: [{ montantTva: 0.5 }] } })).toThrow(/float forbidden/);
    expect(() => canonicalize({ totals: { count: 1.5 } })).toThrow(/float forbidden/);
  });

  it('canonical form of accepted payloads is unchanged (golden vectors from rc.3.1)', () => {
    const vectors: [unknown, string][] = [
      [
        { montantCentimes: 12_345, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20', recordedAt: '2026-11-23T10:00:00.000Z', notes: 'Café crème' },
        'e14fcae407773b7f3762c1fba25491d7f8c12f37ec769a2d8092356e9f15e8dd',
      ],
      [
        { originalId: 'ws:encaissement:1', montantCentimes: -1000, type: 'remboursement_partiel', reason: 'Retour' },
        'dd0f97a711b813721492bb9114986ae79e72eec01f5ff630f6efd76840f8a58d',
      ],
      [
        { caTotalCentimes: -250, cumulPerpetuel: 99_000, nbTransactions: 3, parMode: { cb: 5000, especes: -100 }, parTva: { TVA20: { ttc: 6000, ht: 5000, tva: 1000 } }, chainHeads: { encaissement: { sequence: 7, hash: 'a'.repeat(64) } } },
        '35e2037ca609b226fef487e94c8aa33984a5d8583380a0b0b7ac8f4fc1f82a1b',
      ],
      [
        { ratio: 0.5, list: [1, 2.25, 'x', null, true], nested: { z: 1, a: { b: [] } } },
        '62123b217bd38d5a081612e72e93efbb9a31dc074d6bf11334d903f12addd76c',
      ],
    ];
    for (const [payload, expected] of vectors) {
      expect(hash(canonicalize(payload))).toBe(expected);
    }
  });

  it('handles arrays, null, booleans, strings', () => {
    expect(canonicalize([1, 'a', null, true, false])).toBe('[1,"a",null,true,false]');
  });

  it('omits undefined keys (RFC 8785 spirit)', () => {
    expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('UTF-8 NFC normalizes strings', () => {
    // NFC-composed é vs decomposed e+◌́ should produce the same canonical form.
    const composed = '\u00E9'; // é
    const decomposed = 'e\u0301'; // e + combining acute
    expect(canonicalize({ x: composed })).toBe(canonicalize({ x: decomposed }));
  });
});

describe('crypto.hash', () => {
  it('returns 64-char hex SHA-256', () => {
    const h = hash('hello');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('avalanche: minimal input change → unrecognizable hash', () => {
    expect(hash('a')).not.toBe(hash('b'));
  });
});

describe('crypto.verifyChain', () => {
  it('validates a hand-built genesis-rooted chain', () => {
    const r1 = { previousHash: GENESIS_HASH, payload: 1 };
    const h1 = hash(canonicalize(r1));
    const r2 = { previousHash: h1, payload: 2 };
    const h2 = hash(canonicalize(r2));
    const result = verifyChain([
      { ...r1, hash: h1 },
      { ...r2, hash: h2 },
    ]);
    expect(result.valid).toBe(true);
  });

  it('detects a tampered hash', () => {
    const r1 = { previousHash: GENESIS_HASH, payload: 1 };
    const h1 = hash(canonicalize(r1));
    const result = verifyChain([{ ...r1, hash: 'f'.repeat(64) }]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(0);
    expect(result.actualHash).toBe('f'.repeat(64));
    expect(result.expectedHash).toBe(h1);
  });

  it('detects a broken previousHash linkage', () => {
    const r1 = { previousHash: GENESIS_HASH, payload: 1 };
    const h1 = hash(canonicalize(r1));
    const r2 = { previousHash: 'bad'.padStart(64, '0'), payload: 2 };
    const h2 = hash(canonicalize(r2));
    const result = verifyChain([
      { ...r1, hash: h1 },
      { ...r2, hash: h2 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });
});

describe('crypto.signClosure / verifySignature', () => {
  it('signs and verifies via the active signer', async () => {
    const h = await freshHarness();
    try {
      const env = await signClosure('hello world');
      expect(env.algorithm).toBe('ed25519');
      expect(env.keyVersion).toBe('test-v1');
      const ok = await verifySignature('hello world', env.signature, env.keyVersion);
      expect(ok).toBe(true);
    } finally {
      await h.reset();
    }
  });

  it('rejects an invalid signature', async () => {
    const h = await freshHarness();
    try {
      const env = await signClosure('hello world');
      const ok = await verifySignature('tampered payload', env.signature, env.keyVersion);
      expect(ok).toBe(false);
    } finally {
      await h.reset();
    }
  });
});
