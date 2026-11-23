/**
 * Two corrections on the same original, in parallel, whose sum exceeds the
 * net: the net check and the append must be one serialized step per stream,
 * so exactly one passes and the net never goes below 0.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshHarness, type Harness } from './_helpers.js';
import { recordEncaissement } from '../src/encaissement.js';
import { recordCorrection, getNetAmount } from '../src/corrections.js';

describe('recordCorrection — parallel corrections (in-memory)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await freshHarness('ws-race-mem');
  });
  afterEach(async () => {
    await h.reset();
  });

  it('exactly one of two refunds exceeding the net together passes; net stays >= 0', async () => {
    const e = await recordEncaissement(h.workspace, { montantCentimes: 1000, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    const refund = (reason: string) =>
      recordCorrection(h.workspace, {
        originalId: e._id, montantCentimes: -700, devise: 'EUR', type: 'remboursement_partiel', reason,
      });
    const results = await Promise.allSettled([refund('Retour A'), refund('Retour B')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/NF525_CORRECTION: cumulative corrections would bring net amount negative/);
    expect(await getNetAmount(h.workspace, e._id)).toBe(300);
  });
});
