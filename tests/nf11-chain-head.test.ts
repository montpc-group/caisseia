/**
 * NF-11 — a closure must sign each stream's chain head.
 *
 * Attacker model: write access to the event table. He rewrites an
 * encaissement / correction / JET record, then recomputes that record's hash
 * and every later previousHash/hash of the stream, so the hash chain alone
 * is self-consistent again. Only the signed chain head of a closure (last
 * record hash + sequence at period end) can reveal the rewrite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordEncaissement } from '../src/encaissement.js';
import { recordCorrection } from '../src/corrections.js';
import { closeDay } from '../src/closures.js';
import { hash, canonicalize, GENESIS_HASH, signClosure } from '../src/crypto.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { exportPeriod, verifyExportIntegrity } from '../src/restitution.js';
import { read, type StreamName } from '../src/eventStore.js';
import { CLOSURE_SCHEMA_VERSION } from '../schemas/cloture.schema.js';
import { freshHarness, type Harness } from './_helpers.js';

/** Mutate record `seq` of `stream`, then recompute the whole stream's chain from there. */
async function rewriteAndRechain(
  h: Harness,
  stream: StreamName,
  seq: number,
  mutate: (payload: Record<string, unknown>) => void,
): Promise<void> {
  const records = await read<Record<string, unknown>>(stream, h.workspace);
  let prev = seq === 1 ? GENESIS_HASH : records[seq - 2]!.hash;
  for (const r of records.filter((x) => x.sequence >= seq)) {
    h.storage._forceTamper(h.workspace, stream, r.sequence, (row) => {
      if (r.sequence === seq) mutate(row['payload'] as Record<string, unknown>);
      row['previousHash'] = prev;
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
      prev = row['hash'] as string;
    });
  }
}

async function seed(h: Harness) {
  const enc = await recordEncaissement(h.workspace, { montantCentimes: 5000, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
  await recordEncaissement(h.workspace, { montantCentimes: 700, devise: 'EUR', mode: 'especes', tvaCode: 'TVA10' });
  await recordCorrection(h.workspace, {
    originalId: enc._id, montantCentimes: -300, devise: 'EUR', type: 'remboursement_partiel', reason: 'Service partiel',
  });
  return closeDay(h.workspace, new Date());
}

const window = () => [new Date(Date.now() - 86400_000), new Date(Date.now() + 86400_000)] as const;

const setAmount = (amt: number) => (p: Record<string, unknown>) => {
  (p['data'] as Record<string, unknown>)['montantCentimes'] = amt;
};

const cases: [string, StreamName, number, (p: Record<string, unknown>) => void][] = [
  ['encaissement', 'encaissement', 1, setAmount(1)],
  ['correction', 'encaissement', 3, setAmount(-1)],
  ['JET', 'jet', 1, (p) => { p['data'] = { forged: true }; }],
];

describe('NF-11 closure signs chain heads', () => {
  let h: Harness;
  beforeEach(async () => { h = await freshHarness(); });
  afterEach(async () => { await h.reset(); });

  it('closure payload carries schemaVersion + signed chain heads', async () => {
    const c = await seed(h);
    const [rec] = await read<Record<string, unknown>>('closure-day', h.workspace);
    const p = rec!.payload as { schemaVersion: number; chainHeads: Record<string, { sequence: number; hash: string }> };
    expect(CLOSURE_SCHEMA_VERSION).toBe(2);
    expect(p.schemaVersion).toBe(2);
    const enc = await read('encaissement', h.workspace);
    expect(p.chainHeads['encaissement']).toEqual({ sequence: 3, hash: enc[2]!.hash });
    expect(p.chainHeads['jet']!.sequence).toBeGreaterThan(0);
    expect(c.chainHeads).toEqual(p.chainHeads);
  });

  it('control: untouched store -> valid:true, fully verified', async () => {
    await seed(h);
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(true);
    expect(report.fullyVerified).toBe(true);
    expect(report.warnings).toBeUndefined();
    const [from, to] = window();
    const check = await verifyExportIntegrity(await exportPeriod(h.workspace, from, to, 'json'));
    expect(check.errors).toBeUndefined();
    expect(check.valid).toBe(true);
    expect(check.fullyVerified).toBe(true);
  });

  for (const [label, stream, seq, mutate] of cases) {
    it(`rewritten ${label} + recomputed chain -> verifyChainIntegrity valid:false`, async () => {
      await seed(h);
      await rewriteAndRechain(h, stream, seq, mutate);
      const report = await verifyChainIntegrity(h.workspace);
      expect(report.valid).toBe(false);
      const cd = report.streams.find((s) => s.name === 'closure-day');
      expect(cd?.valid).toBe(false);
      expect(cd?.reason).toMatch(new RegExp(`chain head mismatch: ${stream}`));
    });

    it(`rewritten ${label} + recomputed chain -> verifyExportIntegrity valid:false`, async () => {
      await seed(h);
      await rewriteAndRechain(h, stream, seq, mutate);
      const [from, to] = window();
      const check = await verifyExportIntegrity(await exportPeriod(h.workspace, from, to, 'json'));
      expect(check.valid).toBe(false);
      expect(check.errors?.join('\n')).toMatch(new RegExp(`Tête de chaîne ${stream}`));
    });
  }

  it('truncated stream below the signed head -> valid:false', async () => {
    await seed(h);
    h.storage._forceDelete(h.workspace, 'encaissement', 3);
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
  });

  it('legacy closure (no chain head) is flagged, never reported fully verified', async () => {
    await recordEncaissement(h.workspace, { montantCentimes: 100, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    await closeDay(h.workspace, new Date());
    // Rewrite the closure as a pre-v2 one: no schemaVersion/chainHeads, re-signed with the real key.
    const [rec] = await read<Record<string, unknown>>('closure-day', h.workspace);
    const { schemaVersion: _v, chainHeads: _c, previousClosureHash: _p, signature: _s, signingKeyVersion: _k, ...legacy } = rec!.payload;
    const env = await signClosure(canonicalize(legacy));
    h.storage._forceTamper(h.workspace, 'closure-day', 1, (row) => {
      row['payload'] = { ...legacy, signature: env.signature, signingKeyVersion: env.keyVersion };
      row['hash'] = hash(canonicalize({
        _id: row['_id'], stream: row['stream'], sequence: row['sequence'], workspaceId: row['workspaceId'],
        previousHash: row['previousHash'], recordedAt: row['recordedAt'], payload: row['payload'],
      }));
    });
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(true);
    expect(report.fullyVerified).toBe(false);
    expect(report.warnings?.join('\n')).toMatch(/legacy closure, chain head not signed/);
    const [from, to] = window();
    const check = await verifyExportIntegrity(await exportPeriod(h.workspace, from, to, 'json'));
    expect(check.fullyVerified).toBe(false);
    expect(check.warnings?.join('\n')).toMatch(/legacy closure, chain head not signed/);
  });

  it('stripping chainHeads from a v2 closure breaks its signature (no downgrade)', async () => {
    await seed(h);
    h.storage._forceTamper(h.workspace, 'closure-day', 1, (row) => {
      const p = row['payload'] as Record<string, unknown>;
      delete p['chainHeads'];
      delete p['schemaVersion'];
      row['hash'] = hash(canonicalize({
        _id: row['_id'], stream: row['stream'], sequence: row['sequence'], workspaceId: row['workspaceId'],
        previousHash: row['previousHash'], recordedAt: row['recordedAt'], payload: row['payload'],
      }));
    });
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
  });
});
