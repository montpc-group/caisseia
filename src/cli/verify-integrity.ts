#!/usr/bin/env node
/**
 * CLI: verify-integrity
 *
 * Thin wrapper over verifyChainIntegrity().
 * Exits 0 if all chains valid and every closure signature verifies,
 * 1 if any is broken or the key registry is empty/missing,
 * 3 if valid but NOT fully verified (legacy v1 closure without signed chain head).
 *
 * Usage:
 *   node dist/src/cli/verify-integrity.js <workspaceId>
 *
 * Environment:
 *   CAISSEIA_DATABASE_URL — Postgres connection string
 *   CAISSEIA_STORAGE — 'postgres' (default) or 'memory'
 *   CAISSEIA_KEY_REGISTRY_PATH — public-key registry (default: bundled keys/public-keys.json).
 *     Must list every signing key version used; empty → FAIL.
 */

import { verifyChainIntegrity } from '../integrity.js';
import { defaultEnv } from '../env.js';

const workspaceId = process.argv[2];

if (!workspaceId) {
  console.error('Usage: verify-integrity <workspaceId>');
  console.error('');
  console.error('Environment:');
  console.error('  CAISSEIA_DATABASE_URL  Postgres connection string');
  console.error('  CAISSEIA_STORAGE       postgres (default) | memory');
  console.error('  CAISSEIA_KEY_REGISTRY_PATH  public-key registry JSON (required non-empty)');
  process.exit(2);
}

// A production check: Postgres unless the caller chose otherwise (documented default above).
defaultEnv('STORAGE', 'postgres');

try {
  const report = await verifyChainIntegrity(workspaceId);

  if (report.valid) {
    console.log(`OK: All ${report.streams.length} chains valid for workspace ${workspaceId}`);
    for (const s of report.streams) {
      console.log(`  ${s.name}: ${s.recordsChecked} records checked`);
    }
    if (!report.fullyVerified) {
      console.error('WARN: valid but NOT fully verified');
      for (const w of report.warnings ?? []) console.error(`  ${w}`);
      process.exit(3);
    }
    process.exit(0);
  } else {
    console.error(`FAIL: Chain integrity broken for workspace ${workspaceId}`);
    if (report.error) console.error(`  ${report.error}`);
    for (const s of report.streams) {
      if (!s.valid) {
        console.error(`  ${s.name}: BROKEN at record ${s.brokenAt} — ${s.reason}`);
      } else {
        console.log(`  ${s.name}: OK (${s.recordsChecked} records)`);
      }
    }
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(2);
}
