/**
 * NF-11 — integrity must verify closure signatures, not only hash links.
 *
 * Only closures carry a signature (closures.ts sealAndBuildPayload);
 * encaissement / correction / JET records are hash-chained only.
 * So: verifyChainIntegrity checks the hash chain of every stream AND the
 * Ed25519 signature of every closure record against a non-empty key registry,
 * and FAILS (never skips) when the registry is missing or empty.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordEncaissement } from '../src/encaissement.js';
import { closeDay } from '../src/closures.js';
import { hash, canonicalize } from '../src/crypto.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { exportPeriod, verifyExportIntegrity } from '../src/restitution.js';
import { read } from '../src/eventStore.js';
import { _setRegistryForTests } from '../src/crypto/keyRegistry.js';
import { MemorySigner } from '../src/crypto/MemorySigner.js';
import { freshHarness, type Harness } from './_helpers.js';

/** Rewrite a stored record and recompute its own hash (attacker with table write access). */
function rehash(row: Record<string, unknown>): void {
  row['hash'] = hash(
    canonicalize({
      _id: row['_id'],
      stream: row['stream'],
      sequence: row['sequence'],
      workspaceId: row['workspaceId'],
      previousHash: row['previousHash'],
      recordedAt: row['recordedAt'],
      payload: row['payload'],
    }),
  );
}

async function seedClosedDay(h: Harness) {
  await recordEncaissement(h.workspace, { montantCentimes: 5000, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
  return closeDay(h.workspace, new Date());
}

const closureStream = (r: Awaited<ReturnType<typeof verifyChainIntegrity>>) =>
  r.streams.find((s) => s.name === 'closure-day');

describe('NF-11 verifyChainIntegrity checks closure signatures', () => {
  let h: Harness;
  beforeEach(async () => { h = await freshHarness(); });
  afterEach(async () => { await h.reset(); });

  it('(d) a valid signed chain passes', async () => {
    await seedClosedDay(h);
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(true);
    expect(closureStream(report)?.recordsChecked).toBe(1);
  });

  it('(a) tampered closure with recomputed hash FAILS on signature', async () => {
    const c = await seedClosedDay(h);
    h.storage._forceTamper(h.workspace, 'closure-day', 1, (row) => {
      const p = row['payload'] as { aggregate: { caTotalCentimes: number } };
      p.aggregate.caTotalCentimes = 1;
      rehash(row);
    });
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    expect(closureStream(report)?.valid).toBe(false);
    expect(closureStream(report)?.reason).toMatch(/signature invalid at sequence 1/);
    expect(c.signature).toBeTruthy();
  });

  it('(b) forged signature (other key, same version) FAILS', async () => {
    await seedClosedDay(h);
    const forger = await MemorySigner.generate('test-v1');
    const [rec] = await read<Record<string, unknown>>('closure-day', h.workspace);
    const { signature: _s, signingKeyVersion: _v, ...skel } = rec!.payload;
    const forged = await forger.sign(canonicalize(skel));
    h.storage._forceTamper(h.workspace, 'closure-day', 1, (row) => {
      (row['payload'] as Record<string, unknown>)['signature'] = forged.signature;
      rehash(row);
    });
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    expect(closureStream(report)?.reason).toMatch(/signature invalid/);
  });

  it('(b) garbage signature FAILS', async () => {
    await seedClosedDay(h);
    h.storage._forceTamper(h.workspace, 'closure-day', 1, (row) => {
      (row['payload'] as Record<string, unknown>)['signature'] = Buffer.from('nope').toString('base64');
      rehash(row);
    });
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    expect(closureStream(report)?.reason).toMatch(/signature invalid/);
  });

  it('(c) empty key registry FAILS with a clear error, even with no closures', async () => {
    await recordEncaissement(h.workspace, { montantCentimes: 100, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    _setRegistryForTests({ keys: [] });
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    expect(report.error).toMatch(/key registry is empty/);
  });

  it('(c) unknown key version FAILS (no silent skip)', async () => {
    await seedClosedDay(h);
    _setRegistryForTests({
      keys: [{ version: 'other', algorithm: 'ed25519', publicKeyPem: h.signer.getPublicKeyPem(), validFrom: '2026-01-01T00:00:00Z', validUntil: null }],
    });
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    expect(closureStream(report)?.reason).toMatch(/no public key found for version "test-v1"/);
  });

  it('accepts an explicit trusted registry', async () => {
    await seedClosedDay(h);
    const reg = { keys: [{ version: 'test-v1', algorithm: 'ed25519' as const, publicKeyPem: h.signer.getPublicKeyPem(), validFrom: '2026-01-01T00:00:00Z', validUntil: null }] };
    _setRegistryForTests({ keys: [] });
    const report = await verifyChainIntegrity(h.workspace, { keyRegistry: reg });
    expect(report.valid).toBe(true);
  });
});

describe('NF-11 verifyExportIntegrity never skips signature checks', () => {
  let h: Harness;
  beforeEach(async () => { h = await freshHarness(); });
  afterEach(async () => { await h.reset(); });

  const window = () => [new Date(Date.now() - 86400_000), new Date(Date.now() + 86400_000)] as const;

  it('(d) valid export passes', async () => {
    await seedClosedDay(h);
    const [from, to] = window();
    const check = await verifyExportIntegrity(await exportPeriod(h.workspace, from, to, 'json'));
    expect(check.errors).toBeUndefined();
    expect(check.valid).toBe(true);
  });

  it('(c) missing keyRegistry in export data FAILS', async () => {
    await seedClosedDay(h);
    const [from, to] = window();
    const result = await exportPeriod(h.workspace, from, to, 'json');
    _setRegistryForTests({ keys: [] });
    const tampered = { ...result, data: { ...result.data, keyRegistry: undefined as never } };
    const check = await verifyExportIntegrity(tampered);
    expect(check.valid).toBe(false);
    expect(check.errors?.join('\n')).toMatch(/registre de clés absent ou vide/i);
  });

  it('(c) empty trusted registry FAILS', async () => {
    await seedClosedDay(h);
    const [from, to] = window();
    const result = await exportPeriod(h.workspace, from, to, 'json');
    _setRegistryForTests({ keys: [] });
    const check = await verifyExportIntegrity(result, { keyRegistry: { keys: [] } });
    expect(check.valid).toBe(false);
    expect(check.errors?.join('\n')).toMatch(/registre de clés absent ou vide/i);
  });

  it('(b) forged closure signature in export FAILS', async () => {
    await seedClosedDay(h);
    const [from, to] = window();
    const result = await exportPeriod(h.workspace, from, to, 'json');
    const c = result.data.closures[0]!;
    const tampered = {
      ...result,
      data: { ...result.data, closures: [{ ...c, payload: { ...c.payload, signature: Buffer.from('x').toString('base64') } }] },
    };
    const check = await verifyExportIntegrity(tampered);
    expect(check.valid).toBe(false);
    expect(check.errors?.join('\n')).toMatch(/Signature invalide/);
  });
});
