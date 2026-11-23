#!/usr/bin/env node
/**
 * CLI: generate-attestation
 *
 * Thin wrapper over generateAttestation().
 * Writes PDF to stdout (pipe to file) or to --output path.
 *
 * Usage:
 *   node dist/src/cli/generate-attestation.js \
 *     --workspace ws-123 \
 *     --raison-sociale "ACME SARL" \
 *     --siret "123 456 789 00011" \
 *     --app MyApp \
 *     --app-version 1.0.0 \
 *     --start-date 2026-01-15 \
 *     [--output attestation.pdf]
 *
 * Always generates SPECIMEN watermark (pre-v1.0.0 safety).
 */

import { writeFileSync } from 'node:fs';
import { generateAttestation } from '../attestation.js';

interface CliArgs {
  workspace: string;
  raisonSociale: string;
  siret: string;
  app: string;
  appVersion: string;
  startDate: string;
  output?: string;
}

function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2);
  const result: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    switch (arg) {
      case '--workspace': result['workspace'] = next ?? ''; i++; break;
      case '--raison-sociale': result['raisonSociale'] = next ?? ''; i++; break;
      case '--siret': result['siret'] = next ?? ''; i++; break;
      case '--app': result['app'] = next ?? ''; i++; break;
      case '--app-version': result['appVersion'] = next ?? ''; i++; break;
      case '--start-date': result['startDate'] = next ?? ''; i++; break;
      case '--output': result['output'] = next ?? ''; i++; break;
      case '--help': return null;
      default:
        console.error(`Unknown argument: ${arg}`);
        return null;
    }
  }

  const required = ['workspace', 'raisonSociale', 'siret', 'app', 'appVersion', 'startDate'];
  for (const key of required) {
    if (!result[key]) {
      console.error(`Missing required argument: --${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`);
      return null;
    }
  }

  return {
    workspace: result['workspace']!,
    raisonSociale: result['raisonSociale']!,
    siret: result['siret']!,
    app: result['app']!,
    appVersion: result['appVersion']!,
    startDate: result['startDate']!,
    output: result['output'],
  };
}

function printUsage(): void {
  console.error('Usage: generate-attestation [options]');
  console.error('');
  console.error('Options:');
  console.error('  --workspace        Workspace ID');
  console.error('  --raison-sociale   Company name');
  console.error('  --siret            SIRET number');
  console.error('  --app              Consumer app name (e.g. MyApp)');
  console.error('  --app-version      Consumer app version');
  console.error('  --start-date       Start date (YYYY-MM-DD)');
  console.error('  --output           Output file path (default: stdout)');
  console.error('');
  console.error('NOTE: All generated PDFs carry a SPECIMEN watermark (pre-v1.0.0).');
}

const parsed = parseArgs(process.argv);
if (!parsed) {
  printUsage();
  process.exit(2);
}

try {
  const doc = await generateAttestation({
    workspaceId: parsed.workspace,
    raisonSociale: parsed.raisonSociale,
    siret: parsed.siret,
    consumerApp: parsed.app,
    consumerAppVersion: parsed.appVersion,
    startDate: new Date(parsed.startDate),
    specimen: true, // HARD RULE: always specimen pre-v1.0.0
  });

  if (parsed.output) {
    writeFileSync(parsed.output, doc.pdfBuffer);
    console.error(`Attestation written to ${parsed.output}`);
    console.error(`SHA-256: ${doc.pdfHash}`);
    console.error(`Attestation ID: ${doc.attestationId}`);
    console.error(`SPECIMEN: ${doc.specimen}`);
  } else {
    process.stdout.write(doc.pdfBuffer);
  }

  process.exit(0);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
