/**
 * CAISSEIA_* environment variables, with the NF525_* names kept as a
 * deprecated fallback (one warning per old name per process).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readEnv, _resetEnvWarnings } from '../src/env.js';
import { getActiveStorage, _resetActiveStorage } from '../src/storage/index.js';

const NAMES = ['CAISSEIA_STORAGE', 'NF525_STORAGE', 'CAISSEIA_SIGNER', 'NF525_SIGNER'] as const;

describe('readEnv', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of NAMES) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    _resetEnvWarnings();
    _resetActiveStorage();
  });
  afterEach(() => {
    for (const k of NAMES) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetActiveStorage();
    vi.restoreAllMocks();
  });

  it('the CAISSEIA_ name wins over the NF525_ one, without a warning', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    process.env['CAISSEIA_SIGNER'] = 'memory';
    process.env['NF525_SIGNER'] = 'file';
    expect(readEnv('SIGNER')).toBe('memory');
    expect(warn).not.toHaveBeenCalled();
  });

  it('the old NF525_ name still works and warns once', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    process.env['NF525_SIGNER'] = 'file';
    expect(readEnv('SIGNER')).toBe('file');
    expect(readEnv('SIGNER')).toBe('file');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/NF525_SIGNER.*CAISSEIA_SIGNER/);
  });

  it('neither set → undefined, and storage keeps its clear refusal', async () => {
    expect(readEnv('STORAGE')).toBeUndefined();
    await expect(getActiveStorage()).rejects.toThrow(/NF525_STORAGE_NOT_CONFIGURED.*CAISSEIA_STORAGE/);
  });

  it('storage honours the new name', async () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    process.env['CAISSEIA_STORAGE'] = 'memory';
    await expect(getActiveStorage()).resolves.toBeDefined();
  });
});
