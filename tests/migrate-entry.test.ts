/**
 * src/storage/migrate.ts runs its CLI only when it is the script node was
 * started with — never when another script that merely imports it happens to
 * be called migrate.ts / migrate.js.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(__dirname, '..');
const MIGRATE_TS = join(ROOT, 'src/storage/migrate.ts');

function runWithTsx(script: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] },
    encoding: 'utf-8',
  });
}

describe('migrate CLI entry', () => {
  it('importing migrate from a consumer script named migrate.ts does not run the CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nf-consumer-'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    const script = join(dir, 'migrate.ts');
    writeFileSync(
      script,
      `const m = await import(${JSON.stringify(pathToFileURL(MIGRATE_TS).href)});\n` +
        `console.log('imported', typeof m.migrate);\n`,
    );
    const r = runWithTsx(script);
    expect(r.stderr).not.toContain('FAILED');
    expect(r.stdout).toContain('imported function');
    expect(r.status).toBe(0);
  });

  it('running migrate.ts directly still runs the CLI', () => {
    const r = runWithTsx(MIGRATE_TS);
    expect(r.stderr).toContain('CAISSEIA_DATABASE_URL or opts.connectionString is required');
    expect(r.status).toBe(1);
  });
});
