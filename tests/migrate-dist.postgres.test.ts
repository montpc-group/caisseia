/**
 * The published package runs its own migration: SQL shipped in dist, `migrate`
 * exported from the public entry, CLI runnable with plain node (no tsx).
 *
 * Builds the package first (`pnpm build`). A container that fails to start
 * FAILS this file (set CAISSEIA_SKIP_POSTGRES=1 to skip it explicitly).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { readEnv } from '../src/env.js';

const d = readEnv('SKIP_POSTGRES') === '1' ? describe.skip : describe;
const ROOT = resolve(__dirname, '..');
const DIST_INDEX = join(ROOT, 'dist/src/index.js');
const DIST_MIGRATE = join(ROOT, 'dist/src/storage/migrate.js');

d('migrate from the built package (dist)', () => {
  let stop: () => Promise<void>;
  let url: string;

  beforeAll(async () => {
    execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'pipe' });
    const { GenericContainer, Wait } = await import('testcontainers');
    const container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'pw', POSTGRES_USER: 'postgres', POSTGRES_DB: 'pkg' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    url = `postgres://postgres:pw@${container.getHost()}:${container.getMappedPort(5432)}/pkg`;
    stop = async () => {
      await container.stop();
    };
  }, 180_000);

  afterAll(async () => {
    await stop?.();
  });

  it('ships the SQL migrations in dist', () => {
    expect(existsSync(join(ROOT, 'dist/src/storage/migrations/001_initial.sql'))).toBe(true);
  });

  it('plain node runs the dist CLI and creates the schema', async () => {
    const r = spawnSync(process.execPath, [DIST_MIGRATE], {
      env: { PATH: process.env['PATH'], CAISSEIA_DATABASE_URL: url },
      encoding: 'utf-8',
    });
    expect(r.stderr).toContain('applying 001_initial.sql');
    expect(r.status).toBe(0);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const { rows } = await c.query(`SELECT to_regclass('public.nf525_event') AS t`);
    await c.end();
    expect(rows[0].t).toBe('nf525_event');
  });

  it('exports migrate from the public entry, idempotent on re-run', async () => {
    const pkg = (await import(pathToFileURL(DIST_INDEX).href)) as {
      migrate: (o: { connectionString: string; log: (m: string) => void }) => Promise<{ applied: string[] }>;
    };
    expect(typeof pkg.migrate).toBe('function');
    const res = await pkg.migrate({ connectionString: url, log: () => {} });
    expect(res.applied).toEqual(['001_initial.sql']);
  });

  it('importing the package from a script named migrate.js does not run the CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkg-consumer-'));
    const script = join(dir, 'migrate.js');
    writeFileSync(
      script,
      `import(${JSON.stringify(pathToFileURL(DIST_INDEX).href)}).then(() => console.log('imported'));\n`,
    );
    const r = spawnSync(process.execPath, [script], {
      env: { PATH: process.env['PATH'] },
      encoding: 'utf-8',
    });
    expect(r.stdout).toContain('imported');
    expect(r.stderr).not.toContain('FAILED');
    expect(r.status).toBe(0);
  });
});
