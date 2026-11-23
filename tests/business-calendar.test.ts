/**
 * Business days: local civil day per business
 * (default Europe/Paris), per-business cut-off hour logged as a JET event and
 * never retroactive, yearly closure at the fiscal-year end, and every record
 * in exactly one closed period.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshHarness, travelTo, type Harness } from './_helpers.js';
import { recordEncaissement } from '../src/encaissement.js';
import { closeDay, closeMonth, closeYear, getCurrentDayClosure } from '../src/closures.js';
import {
  setBusinessCalendar,
  getBusinessCalendar,
  timelineFrom,
  localInstant,
  DEFAULT_CALENDAR,
  LEGACY_UTC_CALENDAR,
} from '../src/calendar.js';
import { overlappingDayClosures } from '../src/integrity.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { read } from '../src/eventStore.js';
import type { EventRecord } from '../src/eventStore.js';
import type { ClosurePayloadZ } from '../schemas/cloture.schema.js';

const PAY = { montantCentimes: 1000, devise: 'EUR' as const, mode: 'cb' as const, tvaCode: 'TVA20' };
const iso = (ms: number) => new Date(ms).toISOString();

describe('business calendar', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await freshHarness();
  });
  afterEach(async () => {
    await h.reset();
  });

  it('default: Europe/Paris civil day, 23 h and 25 h on DST days', async () => {
    expect(await getBusinessCalendar(h.workspace, '2027-03-28')).toEqual(DEFAULT_CALENDAR);
    travelTo('2027-11-02T12:00:00Z');
    const spring = await closeDay(h.workspace, '2027-03-28');
    expect([spring.periodStart, spring.periodEnd]).toEqual(['2027-03-27T23:00:00.000Z', '2027-03-28T21:59:59.999Z']);
    const autumn = await closeDay(h.workspace, '2027-10-31');
    expect([autumn.periodStart, autumn.periodEnd]).toEqual(['2027-10-30T22:00:00.000Z', '2027-10-31T22:59:59.999Z']);
    expect(spring.periodKey).toBe('2027-03-28');
    expect(spring.calendar).toEqual(DEFAULT_CALENDAR);
  });

  it('a Date closes the business day that contains it (here the next one in UTC terms)', async () => {
    travelTo('2027-03-12T12:00:00Z');
    // 23:30Z on 10 March = 00:30 on 11 March in Paris.
    const c = await closeDay(h.workspace, new Date('2027-03-10T23:30:00Z'));
    expect(c.periodKey).toBe('2027-03-11');
    expect((await getCurrentDayClosure(h.workspace, '2027-03-11'))?._id).toBe(c._id);
  });

  it('cut-off 05:00 (bar): a 03:30 sale belongs to the previous business day', async () => {
    travelTo('2027-03-09T20:00:00Z');
    const set = await setBusinessCalendar(h.workspace, { dayCutoff: '05:00' });
    expect(set.calendar).toEqual({ ...DEFAULT_CALENDAR, dayCutoff: '05:00' });
    await recordEncaissement(h.workspace, PAY);
    travelTo('2027-03-10T02:30:00Z'); // 03:30 Paris
    await recordEncaissement(h.workspace, { ...PAY, montantCentimes: 250 });
    travelTo('2027-03-10T12:00:00Z');
    const night = await closeDay(h.workspace, '2027-03-09');
    expect([night.periodStart, night.periodEnd]).toEqual(['2027-03-09T04:00:00.000Z', '2027-03-10T03:59:59.999Z']);
    expect(night.aggregate.nbTransactions).toBe(2);
    expect(night.aggregate.caTotalCentimes).toBe(1250);
  });

  it('a change is logged, effective after the last day closure, never retroactive; the transition day is contiguous', async () => {
    travelTo('2027-03-02T12:00:00Z');
    const d1 = await closeDay(h.workspace, '2027-03-01');
    const set = await setBusinessCalendar(h.workspace, { dayCutoff: '05:00' });
    expect(set.effectiveFrom).toBe('2027-03-02');
    const jet = await read<{ type: string; details: Record<string, unknown> }>('jet', h.workspace);
    expect(jet.at(-1)!.payload).toMatchObject({
      type: 'business_calendar_set',
      details: { timeZone: 'Europe/Paris', dayCutoff: '05:00', fiscalYearEndMonth: 12, effectiveFrom: '2027-03-02' },
    });
    expect(await getBusinessCalendar(h.workspace, '2027-03-01')).toEqual(DEFAULT_CALENDAR);

    travelTo('2027-03-04T12:00:00Z');
    const d2 = await closeDay(h.workspace, '2027-03-02');
    const d3 = await closeDay(h.workspace, '2027-03-03');
    // Day 1 is untouched; day 2 runs from day 1's end to the new 05:00 cut-off (29 h).
    expect(d1.periodEnd).toBe('2027-03-01T22:59:59.999Z');
    expect(d2.periodStart).toBe('2027-03-01T23:00:00.000Z');
    expect(d2.periodEnd).toBe('2027-03-03T03:59:59.999Z');
    expect(d3.periodStart).toBe('2027-03-03T04:00:00.000Z');
    expect(d2.calendar?.dayCutoff).toBe('05:00');
  });

  it('a day closed early hands the rest of its calendar day to the next one', async () => {
    travelTo('2027-05-10T17:00:00Z'); // 19:00 Paris
    await recordEncaissement(h.workspace, PAY);
    const z = await closeDay(h.workspace, '2027-05-10');
    expect(z.periodEnd).toBe('2027-05-10T17:00:00.000Z');
    travelTo('2027-05-10T18:00:00Z'); // a sale after the Z, same evening
    await recordEncaissement(h.workspace, { ...PAY, montantCentimes: 400 });
    travelTo('2027-05-12T12:00:00Z');
    const next = await closeDay(h.workspace, '2027-05-11');
    expect(next.periodStart).toBe('2027-05-10T17:00:00.001Z');
    expect(next.aggregate.caTotalCentimes).toBe(400);
  });

  it('every record sits in exactly one day closure, and integrity holds', async () => {
    const at = ['2027-06-01T08:00:00Z', '2027-06-01T21:30:00Z', '2027-06-01T22:30:00Z', '2027-06-02T10:00:00Z', '2027-06-02T21:59:00Z'];
    for (const t of at) {
      travelTo(t);
      await recordEncaissement(h.workspace, PAY);
    }
    travelTo('2027-06-02T15:00:00Z');
    await closeDay(h.workspace, '2027-06-01');
    await closeDay(h.workspace, '2027-06-02'); // closed early at 17:00 Paris
    travelTo('2027-06-02T21:59:00Z');
    await recordEncaissement(h.workspace, PAY);
    travelTo('2027-06-04T12:00:00Z');
    await closeDay(h.workspace, '2027-06-03');
    const days = await read<ClosurePayloadZ>('closure-day', h.workspace);
    for (const r of await read('encaissement', h.workspace)) {
      const t = Date.parse(r.recordedAt);
      const holders = days.filter((d) => Date.parse(d.payload.periodStart) <= t && t <= Date.parse(d.payload.periodEnd));
      expect(holders.length, r.recordedAt).toBe(1);
    }
    expect(days.reduce((n, d) => n + d.payload.aggregate.nbTransactions, 0)).toBe(at.length + 1);
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.error, report.error).toBeUndefined();
  });

  it('fiscal year ending in June: the (short first) exercice closes in June', async () => {
    travelTo('2027-07-02T12:00:00Z');
    await setBusinessCalendar(h.workspace, { fiscalYearEndMonth: 6 });
    for (let m = 1; m <= 6; m++) {
      const last = new Date(Date.UTC(2027, m, 0)).getUTCDate();
      for (let d = 1; d <= last; d++) await closeDay(h.workspace, `2027-0${m}-${String(d).padStart(2, '0')}`);
      await closeMonth(h.workspace, 2027, m);
    }
    const year = await closeYear(h.workspace, 2027);
    expect(year.periodKey).toBe('2027-06');
    expect([year.periodStart, year.periodEnd]).toEqual(['2026-12-31T23:00:00.000Z', '2027-06-30T21:59:59.999Z']);
    await expect(closeYear(h.workspace, 2027)).rejects.toThrow(/already closed/);
  });

  it('refuses an unknown time zone or a malformed cut-off', async () => {
    await expect(setBusinessCalendar(h.workspace, { timeZone: 'Mars/Olympus' })).rejects.toThrow(/time zone/);
    await expect(setBusinessCalendar(h.workspace, { dayCutoff: '25:00' })).rejects.toThrow();
  });
});

describe('calendar internals', () => {
  const dayClosure = (periodStart: string, periodEnd: string, extra: Partial<ClosurePayloadZ> = {}) =>
    ({ payload: { periodStart, periodEnd, ...extra } }) as unknown as EventRecord<ClosurePayloadZ>;

  it('a workspace with UTC-bounded (v2) day closures and no calendar keeps UTC', () => {
    const legacy = timelineFrom([], [dayClosure('2026-11-20T00:00:00.000Z', '2026-11-20T23:59:59.999Z')]);
    expect(legacy.at('2026-11-21')).toEqual(LEGACY_UTC_CALENDAR);
    expect(iso(legacy.start('2026-11-21'))).toBe('2026-11-21T00:00:00.000Z');
    expect(timelineFrom([], []).at('2026-11-21')).toEqual(DEFAULT_CALENDAR);
  });

  it('a wall time skipped by DST moves forward by the gap', () => {
    expect(iso(localInstant('2027-03-28', '02:30', 'Europe/Paris'))).toBe('2027-03-28T01:30:00.000Z');
    expect(iso(localInstant('2027-01-15', '05:00', 'America/Martinique'))).toBe('2027-01-15T09:00:00.000Z');
  });

  it('overlapping day closures are reported', () => {
    const a = dayClosure('2027-03-01T00:00:00.000Z', '2027-03-01T23:59:59.999Z');
    const b = dayClosure('2027-03-01T23:00:00.000Z', '2027-03-02T22:59:59.999Z', { periodKey: '2027-03-02' });
    expect(overlappingDayClosures([a, b])).toEqual(['2027-03-01 / 2027-03-02']);
    expect(overlappingDayClosures([a])).toEqual([]);
  });
});
