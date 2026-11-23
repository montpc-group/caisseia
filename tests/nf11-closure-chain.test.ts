/**
 * NF-11 gap 3 — deleting a closure must not reopen its period.
 *
 * (a) each closure signs `previousClosureHash` (hash of the previous closure
 *     record of the same stream, GENESIS_HASH for the first): deleting a
 *     closure and renumbering + rechaining its stream breaks the next
 *     closure's signed link.
 * (b) the verifiers raise an ERROR for any elapsed UTC day (strictly before
 *     the verification date) that has encaissement/JET records but no day
 *     closure: deleting the newest day closure is detected once its day elapsed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { recordEncaissement } from '../src/encaissement.js';
import { closeDay, closeMonth } from '../src/closures.js';
import { hash, canonicalize, GENESIS_HASH } from '../src/crypto.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { exportPeriod, verifyExportIntegrity } from '../src/restitution.js';
import { read, type StreamName } from '../src/eventStore.js';
import { freshHarness, type Harness } from './_helpers.js';

const day = (d: number, h = 12) => new Date(Date.UTC(2027, 2, d, h)); // March 2027
const AFTER = day(4, 10); // verification date: 1..3 March elapsed

/** Delete closure `seq` of `stream`, then renumber + rechain every later record (attacker with table write). */
async function deleteAndRechain(h: Harness, stream: StreamName, seq: number): Promise<void> {
  const records = await read(stream, h.workspace);
  h.storage._forceDelete(h.workspace, stream, seq);
  let prev = seq === 1 ? GENESIS_HASH : records[seq - 2]!.hash;
  for (const r of records.filter((x) => x.sequence > seq)) {
    h.storage._forceTamper(h.workspace, stream, r.sequence, (row) => {
      row['sequence'] = r.sequence - 1;
      row['previousHash'] = prev;
      row['hash'] = hash(canonicalize({
        _id: row['_id'], stream: row['stream'], sequence: row['sequence'], workspaceId: row['workspaceId'],
        previousHash: row['previousHash'], recordedAt: row['recordedAt'], payload: row['payload'],
      }));
      prev = row['hash'] as string;
    });
  }
}

/** One encaissement per day on 1..n March, each day closed that evening. */
async function seedDays(h: Harness, n = 3): Promise<void> {
  for (let d = 1; d <= n; d++) {
    vi.setSystemTime(day(d));
    await recordEncaissement(h.workspace, { montantCentimes: 1000 * d, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    vi.setSystemTime(day(d, 23));
    await closeDay(h.workspace, day(d));
  }
  vi.setSystemTime(AFTER);
}

const exportMarch = (h: Harness) =>
  exportPeriod(h.workspace, new Date(Date.UTC(2027, 2, 1)), new Date(Date.UTC(2027, 2, 3, 23, 59, 59, 999)), 'json');

describe('NF-11 closure chain + elapsed days', () => {
  let h: Harness;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    h = await freshHarness();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await h.reset();
  });

  it('closures sign previousClosureHash (genesis marker for the first)', async () => {
    await seedDays(h, 2);
    const [c1, c2] = await read<{ previousClosureHash: string }>('closure-day', h.workspace);
    expect(c1!.payload.previousClosureHash).toBe(GENESIS_HASH);
    expect(c2!.payload.previousClosureHash).toBe(c1!.hash);
  });

  it('control: untouched store -> valid + fullyVerified (chain and export)', async () => {
    await seedDays(h);
    const report = await verifyChainIntegrity(h.workspace, { now: AFTER });
    expect(report.error).toBeUndefined();
    expect(report.valid).toBe(true);
    expect(report.fullyVerified).toBe(true);
    const check = await verifyExportIntegrity(await exportMarch(h), { now: AFTER });
    expect(check.errors).toBeUndefined();
    expect(check.valid).toBe(true);
    expect(check.fullyVerified).toBe(true);
  });

  it('deleting the newest day closure -> valid:false (elapsed day without closure)', async () => {
    await seedDays(h);
    h.storage._forceDelete(h.workspace, 'closure-day', 3);
    const report = await verifyChainIntegrity(h.workspace, { now: AFTER });
    expect(report.valid).toBe(false);
    expect(report.error).toMatch(/elapsed day.*2027-03-03/);
    expect(report.warnings).toBeUndefined();
    const check = await verifyExportIntegrity(await exportMarch(h), { now: AFTER });
    expect(check.valid).toBe(false);
    expect(check.errors?.join('\n')).toMatch(/2027-03-03/);
  });

  it('deleting a middle day closure + rechain -> closure chain broken', async () => {
    await seedDays(h);
    await deleteAndRechain(h, 'closure-day', 2);
    const report = await verifyChainIntegrity(h.workspace, { now: AFTER });
    expect(report.valid).toBe(false);
    const cd = report.streams.find((s) => s.name === 'closure-day');
    expect(cd?.valid).toBe(false);
    expect(cd?.reason).toMatch(/closure chain/);
    const check = await verifyExportIntegrity(await exportMarch(h), { now: AFTER });
    expect(check.valid).toBe(false);
    expect(check.errors?.join('\n')).toMatch(/Chaîne des clôtures/);
  });

  it('deleting a month closure + rechain -> closure chain broken', async () => {
    for (let m = 1; m <= 3; m++) {
      const last = new Date(Date.UTC(2027, m, 0)).getUTCDate();
      for (let d = 1; d <= last; d++) await closeDay(h.workspace, new Date(Date.UTC(2027, m - 1, d)));
      await closeMonth(h.workspace, 2027, m);
    }
    await deleteAndRechain(h, 'closure-month', 2);
    const report = await verifyChainIntegrity(h.workspace, { now: AFTER });
    expect(report.valid).toBe(false);
    const cm = report.streams.find((s) => s.name === 'closure-month');
    expect(cm?.valid).toBe(false);
    expect(cm?.reason).toMatch(/closure chain/);
  });

  it('elapsed day with records but no day closure -> ERROR, not a warning', async () => {
    vi.setSystemTime(day(1));
    await recordEncaissement(h.workspace, { montantCentimes: 500, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    const report = await verifyChainIntegrity(h.workspace, { now: day(2) });
    expect(report.valid).toBe(false);
    expect(report.fullyVerified).toBe(false);
    expect(report.error).toMatch(/elapsed day.*2027-03-01/);
    expect(report.warnings).toBeUndefined();
    const exp = await exportPeriod(h.workspace, new Date(Date.UTC(2027, 2, 1)), new Date(Date.UTC(2027, 2, 1, 23, 59, 59, 999)), 'json');
    const check = await verifyExportIntegrity(exp, { now: day(2) });
    expect(check.valid).toBe(false);
    expect(check.errors?.join('\n')).toMatch(/2027-03-01/);
  });

  it('today (not elapsed) without closure is not an error', async () => {
    vi.setSystemTime(day(1));
    await recordEncaissement(h.workspace, { montantCentimes: 500, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    const report = await verifyChainIntegrity(h.workspace, { now: day(1, 23) });
    expect(report.valid).toBe(true);
    expect(report.fullyVerified).toBe(true);
  });

  it('export window not covering the whole day does not check it', async () => {
    vi.setSystemTime(day(1));
    await recordEncaissement(h.workspace, { montantCentimes: 500, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    const exp = await exportPeriod(h.workspace, day(1, 6), day(1, 18), 'json');
    const check = await verifyExportIntegrity(exp, { now: day(2) });
    expect(check.errors).toBeUndefined();
    expect(check.valid).toBe(true);
  });
});
