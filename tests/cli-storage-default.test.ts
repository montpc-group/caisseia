/**
 * verify-integrity is a production check: its documented default storage is
 * Postgres. Without CAISSEIA_DATABASE_URL it must say so and fail — never
 * « verify » an empty in-memory register.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli/verify-integrity.ts', import.meta.url));

describe('verify-integrity CLI storage default', () => {
  it('no storage and no database URL set → fails naming CAISSEIA_DATABASE_URL', () => {
    const env = { ...process.env };
    for (const p of ['NF525_', 'CAISSEIA_']) {
      delete env[`${p}STORAGE`];
      delete env[`${p}DATABASE_URL`];
    }
    const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'ws-x'], { env, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/CAISSEIA_DATABASE_URL is required/);
    expect(r.stdout + r.stderr).not.toMatch(/records checked|OK \(/);
  });
});
