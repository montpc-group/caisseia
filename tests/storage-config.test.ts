/**
 * No silent in-memory register: with no storage configured the SDK refuses
 * to record (a consumer that forgot its Postgres wiring would otherwise
 * « record » payments in process memory, lost on restart). In-memory is an
 * explicit opt-in (initialize({ storage: 'memory' }) or CAISSEIA_STORAGE=memory)
 * and warns once per process. The in-memory store refuses a caller client
 * (it has no transactions) instead of ignoring it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { getActiveStorage, _resetActiveStorage, InMemoryStorage } from '../src/storage/index.js';
import { _resetMemoryWarning } from '../src/storage/index.js';
import { initialize } from '../src/index.js';
import { recordEncaissement } from '../src/encaissement.js';

const ENV = ['NF525_STORAGE', 'NF525_DATABASE_URL', 'CAISSEIA_STORAGE', 'CAISSEIA_DATABASE_URL'] as const;
const cfg = { defaultCurrency: 'EUR' as const, tvaRates: [] };

describe('storage configuration', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    _resetActiveStorage();
    _resetMemoryWarning();
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetActiveStorage();
    vi.restoreAllMocks();
  });

  it('nothing configured → a clear error, nothing recorded in memory', async () => {
    await expect(getActiveStorage()).rejects.toThrow(/NF525_STORAGE_NOT_CONFIGURED/);
    await expect(
      recordEncaissement('ws', { montantCentimes: 100, devise: 'EUR', mode: 'cb', tvaCode: 'TVA20' }),
    ).rejects.toThrow(/NF525_STORAGE_NOT_CONFIGURED/);
  });

  it('initialize() without databaseUrl and without storage: memory is refused', async () => {
    await expect(initialize({ ...cfg } as never)).rejects.toThrow(/databaseUrl is required/);
  });

  it("initialize({ storage: 'memory' }) opts in, and warns once per process", async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    await initialize({ ...cfg, storage: 'memory' });
    expect(await getActiveStorage()).toBeInstanceOf(InMemoryStorage);
    _resetActiveStorage();
    expect(await getActiveStorage()).toBeInstanceOf(InMemoryStorage);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/in-memory.*restart/i);
  });

  it('CAISSEIA_STORAGE=memory is the same explicit opt-in', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    process.env['CAISSEIA_STORAGE'] = 'memory';
    expect(await getActiveStorage()).toBeInstanceOf(InMemoryStorage);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('the in-memory store refuses a caller client instead of ignoring it', async () => {
    const s = new InMemoryStorage();
    const client = {} as PoolClient;
    const input = {
      workspaceId: 'ws', stream: 'encaissement' as const, sequence: 1,
      previousHash: 'p', hash: 'h', recordedAt: '2026-11-23T00:00:00.000Z', payload: {},
    };
    await expect(s.append(input, { client })).rejects.toThrow(/NF525_STORAGE: \{ client \} given but the active storage is in-memory/);
    await expect(s.read({ workspaceId: 'ws', stream: 'encaissement' }, { client })).rejects.toThrow(/in-memory/);
    await expect(s.getLast('ws', 'encaissement', { client })).rejects.toThrow(/in-memory/);
    await expect(s.withStreamLock('ws', 'encaissement', async () => 1, { client })).rejects.toThrow(/in-memory/);
  });
});
