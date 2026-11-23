/**
 * Storage factory + cached singleton accessor.
 *
 * The package's domain modules (encaissement, corrections, integrity, …)
 * never instantiate a storage adapter directly — they call getActiveStorage()
 * which honors what the consumer app set via setActiveStorage(...) or, in
 * absence, builds one from environment.
 *
 * Defaults:
 *   NF525_STORAGE=memory  (tests; default when nothing set)
 *   NF525_STORAGE=postgres (reads NF525_DATABASE_URL)
 */

import type { EventStorage } from './EventStorage.js';

export type StorageKind = 'memory' | 'postgres';

let active: EventStorage | null = null;

export function setActiveStorage(storage: EventStorage): void {
  active = storage;
}

export async function getActiveStorage(): Promise<EventStorage> {
  if (active) return active;
  const kind = (process.env['NF525_STORAGE'] ?? 'memory') as StorageKind;
  if (kind === 'memory') {
    const { InMemoryStorage } = await import('./InMemoryStorage.js');
    active = new InMemoryStorage();
    return active;
  }
  if (kind === 'postgres') {
    const { PostgresStorage } = await import('./PostgresStorage.js');
    active = PostgresStorage.fromEnv();
    await active.assertSchema();
    return active;
  }
  throw new Error(`NF525_STORAGE: unknown kind "${kind}"`);
}

/** Test helper. */
export function _resetActiveStorage(): void {
  active = null;
}

export { InMemoryStorage } from './InMemoryStorage.js';
export { PostgresStorage } from './PostgresStorage.js';
export type { EventStorage, AppendInput, ReadFilter } from './EventStorage.js';
export { AppendConflictError, InalterableViolationError } from './EventStorage.js';
