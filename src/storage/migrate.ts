#!/usr/bin/env node
/**
 * Idempotent migration runner. Applies every .sql file in
 * src/storage/migrations/ in lexical order. Safe to re-run.
 *
 * CLI usage:  caisseia-migrate, or pnpm migrate after pnpm build
 *             (plain node on dist; reads NF525_DATABASE_URL)
 */

import { promises as fs, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import pg from 'pg';

export interface MigrateOptions {
  /** Postgres connection string. Falls back to NF525_DATABASE_URL. */
  connectionString?: string;
  /** Migrations directory. Defaults to ./migrations next to this file. */
  migrationsDir?: string;
  /** Logger; defaults to console. */
  log?: (msg: string) => void;
}

export async function migrate(opts: MigrateOptions = {}): Promise<{ applied: string[] }> {
  const url = opts.connectionString ?? process.env['NF525_DATABASE_URL'];
  if (!url) {
    throw new Error('migrate: NF525_DATABASE_URL or opts.connectionString is required');
  }
  const log = opts.log ?? ((m) => console.warn(`[nf525:migrate] ${m}`));
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = opts.migrationsDir ?? resolvePath(here, 'migrations');

  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const pool = new pg.Pool({ connectionString: url });
  const applied: string[] = [];
  try {
    for (const file of files) {
      const sql = await fs.readFile(resolvePath(dir, file), 'utf-8');
      log(`applying ${file}`);
      await pool.query(sql);
      applied.push(file);
    }
    log(`done (${applied.length} migration(s) applied / re-applied idempotently)`);
    return { applied };
  } finally {
    await pool.end();
  }
}

// CLI entrypoint when this very file is the script node was started with
// (resolved through symlinks, e.g. the npm bin). A consumer script that merely
// imports the package never runs it, whatever its own file name.
function isEntrypoint(argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false; // argv[1] is not a file (node -e … arg): not us
  }
}
const isMain = isEntrypoint(process.argv[1]);
if (isMain) {
  migrate().catch((err) => {
    console.error('[nf525:migrate] FAILED', err);
    process.exit(1);
  });
}
