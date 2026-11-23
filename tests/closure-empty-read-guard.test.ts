/**
 * closeDay never seals an empty day when the encaissement read saw no row but
 * the stream has a last record (a read on the wrong connection, e.g. RLS on
 * the SDK pool while getLast went through the caller's client).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshHarness, type Harness } from './_helpers.js';
import { InMemoryStorage, setActiveStorage } from '../src/storage/index.js';
import type { ReadFilter } from '../src/storage/EventStorage.js';
import type { EventRecord } from '../src/eventStore.js';
import { recordEncaissement } from '../src/encaissement.js';
import { closeDay, getCurrentDayClosure } from '../src/closures.js';

/** read() of the encaissement stream sees nothing; getLast() still sees the records. */
class BlindEncaissementRead extends InMemoryStorage {
  override async read<T>(filter: ReadFilter): Promise<EventRecord<T>[]> {
    return filter.stream === 'encaissement' ? [] : super.read<T>(filter);
  }
}

describe('closeDay — 0-row read guard', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await freshHarness('ws-guard');
    setActiveStorage(new BlindEncaissementRead());
  });
  afterEach(async () => {
    await h.reset();
  });

  it('refuses to seal when the read is empty but getLast shows events', async () => {
    const now = new Date();
    await recordEncaissement(h.workspace, { montantCentimes: 500, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' });
    await expect(closeDay(h.workspace, now)).rejects.toThrow(/NF525_CLOSURE: refusing to seal day .* 0 rows/);
    expect(await getCurrentDayClosure(h.workspace, now)).toBeNull();
  });

  it('still seals a genuinely empty stream (no last record)', async () => {
    const c = await closeDay(h.workspace, new Date());
    expect(c.aggregate.nbTransactions).toBe(0);
  });
});
