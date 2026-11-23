/**
 * Storage factory + cached singleton accessor.
 *
 * The package's domain modules (encaissement, corrections, integrity, …)
 * never instantiate a storage adapter directly — they call getActiveStorage()
 * which honors what the consumer app set via setActiveStorage(...) or, in
 * absence, builds one from environment:
 *   CAISSEIA_STORAGE=postgres (reads CAISSEIA_DATABASE_URL; set by initialize())
 *   CAISSEIA_STORAGE=memory   explicit opt-in only (initialize({ storage: 'memory' })):
 *                          records live in process memory and are lost on restart
 *   unset                  refused (NF525_STORAGE_NOT_CONFIGURED) — never a silent
 *                          in-memory register
 */

import type { EventStorage } from './EventStorage.js';
import { readEnv } from '../env.js';

export type StorageKind = 'memory' | 'postgres';

let active: EventStorage | null = null;

export function setActiveStorage(storage: EventStorage): void {
  active = storage;
}

export async function getActiveStorage(): Promise<EventStorage> {
  if (active) return active;
  const kind = readEnv('STORAGE');
  if (!kind) {
    throw new Error(
      'NF525_STORAGE_NOT_CONFIGURED: no storage configured. Call initialize({ databaseUrl, … }), ' +
        'setActiveStorage(new PostgresStorage(pool)), or set CAISSEIA_STORAGE=postgres with CAISSEIA_DATABASE_URL. ' +
        "In-memory (records lost on restart) only on purpose: initialize({ storage: 'memory', … }) or CAISSEIA_STORAGE=memory.",
    );
  }
  if (kind === 'memory') {
    const { InMemoryStorage } = await import('./InMemoryStorage.js');
    warnMemoryOnce();
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

let memoryWarned = false;

function warnMemoryOnce(): void {
  if (memoryWarned) return;
  memoryWarned = true;
  process.emitWarning(
    'NF525 storage is in-memory: records live in this process only and do not survive a restart. Use it for tests and demos, never for real payments.',
    { code: 'NF525_STORAGE_MEMORY' },
  );
}

/** Test helper: the in-memory warning fires again. */
export function _resetMemoryWarning(): void {
  memoryWarned = false;
}

export { InMemoryStorage } from './InMemoryStorage.js';
export { PostgresStorage } from './PostgresStorage.js';
export type { EventStorage, AppendInput, ReadFilter } from './EventStorage.js';
export { AppendConflictError, InalterableViolationError } from './EventStorage.js';
