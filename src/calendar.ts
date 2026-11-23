/**
 * Business calendar: how a workspace's records are grouped into closure
 * periods.
 *
 *  - A business day is the LOCAL civil day of the business (IANA time zone,
 *    default Europe/Paris), from its cut-off hour (default 00:00, e.g. 05:00
 *    for a bar) to the next day's cut-off. DST days last 23 or 25 hours.
 *    Timestamps stay stored in UTC; only the grouping is local.
 *  - The exercice (yearly closure) ends with its fiscal-year-end month.
 *  - A change is a logged JET event (`business_calendar_set`) effective from
 *    the day after the last day closure: never retroactive.
 *  - A workspace that already holds UTC-bounded (schema v1/v2) day closures and
 *    has never set a calendar keeps UTC 00:00, so its periods stay contiguous.
 */

import { read, withStreamLock } from './eventStore.js';
import type { EventRecord } from './eventStore.js';
import { logTechnicalEvent } from './jet.js';
import type { TxOptions } from './storage/EventStorage.js';
import {
  BusinessCalendarSchema,
  type BusinessCalendar,
  type ClosurePayloadZ,
} from '../schemas/cloture.schema.js';
import type { JetPayloadZ } from '../schemas/jet.schema.js';

export type { BusinessCalendar };

export const DEFAULT_CALENDAR: BusinessCalendar = Object.freeze({
  timeZone: 'Europe/Paris',
  dayCutoff: '00:00',
  fiscalYearEndMonth: 12,
});

/** Calendar of workspaces sealed with UTC bounds before rc.7 (schema v1/v2) that never set one. */
export const LEGACY_UTC_CALENDAR: BusinessCalendar = Object.freeze({
  timeZone: 'UTC',
  dayCutoff: '00:00',
  fiscalYearEndMonth: 12,
});

const CALENDAR_EVENT = 'business_calendar_set';
/** effectiveFrom of a calendar set before any day closure: it covers every day. */
const FROM_THE_START = '0001-01-01';

interface CalendarChange {
  effectiveFrom: string;
  calendar: BusinessCalendar;
}

/**
 * The calendar in force for each business day, built from the calendar JET
 * events and the calendars signed in v3 day closures (an export that starts
 * after a change still knows the calendar of the days it holds).
 */
export class CalendarTimeline {
  private readonly changes: CalendarChange[];

  constructor(changes: CalendarChange[], private readonly base: BusinessCalendar) {
    // Stable sort: for one effectiveFrom, the later entry wins.
    this.changes = [...changes].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
  }

  at(date: string): BusinessCalendar {
    let cal = this.base;
    for (const c of this.changes) {
      if (c.effectiveFrom > date) break;
      cal = c.calendar;
    }
    return cal;
  }

  /** First instant (ms) of business day `date` on the calendar. */
  start(date: string): number {
    return this.end(shiftDate(date, -1)) + 1;
  }

  /** Last instant (ms) of business day `date` on the calendar: the next day's cut-off, minus 1 ms. */
  end(date: string): number {
    const cal = this.at(date);
    return localInstant(shiftDate(date, 1), cal.dayCutoff, cal.timeZone) - 1;
  }

  /** The business day whose calendar bounds contain `instant` (ms). */
  dayOf(instant: number): string {
    const utc = new Date(instant).toISOString().slice(0, 10);
    // Cut-off < 24 h and offsets within ±14 h: the day is at most 2 days before or 1 after the UTC date.
    for (const d of [shiftDate(utc, 1), utc, shiftDate(utc, -1), shiftDate(utc, -2)]) {
      if (this.start(d) <= instant && instant <= this.end(d)) return d;
    }
    throw new Error(`NF525_CLOSURE: no business day contains ${new Date(instant).toISOString()}`);
  }
}

/**
 * Timeline from a workspace's JET records and day closures. `base` is the
 * legacy UTC calendar when a day closure without a calendar (v1/v2) exists.
 */
export function timelineFrom(
  jet: EventRecord<JetPayloadZ>[],
  dayClosures: EventRecord<ClosurePayloadZ>[],
): CalendarTimeline {
  const changes: CalendarChange[] = [];
  let legacy = false;
  for (const c of dayClosures) {
    if (c.payload.calendar && c.payload.periodKey) {
      changes.push({ effectiveFrom: c.payload.periodKey, calendar: c.payload.calendar });
    } else {
      legacy = true;
    }
  }
  for (const r of jet) {
    if (r.payload.type !== CALENDAR_EVENT) continue;
    const d = r.payload.details as { effectiveFrom: string } & BusinessCalendar;
    changes.push({
      effectiveFrom: d.effectiveFrom,
      calendar: { timeZone: d.timeZone, dayCutoff: d.dayCutoff, fiscalYearEndMonth: d.fiscalYearEndMonth },
    });
  }
  return new CalendarTimeline(changes, legacy ? LEGACY_UTC_CALENDAR : DEFAULT_CALENDAR);
}

/** Reads what the timeline needs (JET + day closures) on the caller's connection if given. */
export async function loadTimeline(
  workspaceId: string,
  opts: TxOptions = {},
): Promise<{ timeline: CalendarTimeline; dayClosures: EventRecord<ClosurePayloadZ>[] }> {
  // ponytail: reads the whole JET for its calendar events; index them if the JET gets huge.
  const jet = await read<JetPayloadZ>('jet', workspaceId, { client: opts.client });
  const dayClosures = await read<ClosurePayloadZ>('closure-day', workspaceId, { client: opts.client });
  return { timeline: timelineFrom(jet, dayClosures), dayClosures };
}

/**
 * Sets the workspace's business calendar (fields not given keep their current
 * value). Logged as a `business_calendar_set` JET event, effective from the
 * day after the last day closure (from the first day if none): sealed days
 * never change. Serialized with closeDay by the closure-day stream lock.
 */
export async function setBusinessCalendar(
  workspaceId: string,
  change: Partial<BusinessCalendar>,
  opts: TxOptions = {},
): Promise<{ effectiveFrom: string; calendar: BusinessCalendar }> {
  return withStreamLock('closure-day', workspaceId, async (tx) => {
    const { timeline, dayClosures } = await loadTimeline(workspaceId, tx);
    const lastKey = dayClosures.map(dayKey).sort().at(-1);
    const effectiveFrom = lastKey ? shiftDate(lastKey, 1) : FROM_THE_START;
    const calendar = BusinessCalendarSchema.parse({ ...timeline.at(effectiveFrom), ...change });
    await logTechnicalEvent(workspaceId, CALENDAR_EVENT, { ...calendar, effectiveFrom }, {}, tx);
    return { effectiveFrom, calendar };
  }, opts.client ? { client: opts.client } : {});
}

/** The calendar in force for business day `date` (YYYY-MM-DD; default: the current business day). */
export async function getBusinessCalendar(
  workspaceId: string,
  date?: string,
  opts: TxOptions = {},
): Promise<BusinessCalendar> {
  const { timeline } = await loadTimeline(workspaceId, opts);
  return timeline.at(date ?? timeline.dayOf(Date.now()));
}

/** Business day of a day closure: signed periodKey (v3), else its UTC start date (v1/v2). */
export function dayKey(r: EventRecord<ClosurePayloadZ>): string {
  return r.payload.periodKey ?? r.payload.periodStart.slice(0, 10);
}

// ─── Date arithmetic ──────────────────────────────────────────────────

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * UTC instant (ms) of local wall time `date` `hhmm` in `timeZone`. A wall
 * time skipped by a DST jump moves forward by the gap (02:30 → 03:30); a wall
 * time that occurs twice resolves to its later occurrence.
 */
export function localInstant(date: string, hhmm: string, timeZone: string): number {
  const wall = Date.parse(`${date}T${hhmm}:00.000Z`);
  const guess = wall - offsetMs(wall, timeZone);
  const t = wall - offsetMs(guess, timeZone);
  return offsetMs(t, timeZone) === wall - t ? t : Math.max(guess, t);
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** Offset (local wall time − UTC, ms) of `timeZone` at `instant`. */
function offsetMs(instant: number, timeZone: string): number {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formats.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p['year']!, +p['month']! - 1, +p['day']!, +p['hour']!, +p['minute']!, +p['second']!);
  return asUtc - (instant - (((instant % 1000) + 1000) % 1000));
}
