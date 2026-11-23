# Integration Guide — CAISSEIA

Step-by-step guide for consumer apps integrating CAISSEIA.

---

## 1. Prerequisites

- Node >= 20
- PostgreSQL instance (dedicated database or schema recommended)
- Ed25519 signing key (generated, chmod 600)
- `caisseia` at a version covered by a signed attestation éditeur (see `ATTESTATION.md`)

## 2. Install

```bash
npm install caisseia
# or
pnpm add caisseia
```

## 3. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NF525_DATABASE_URL` | Yes | Postgres connection string (role `nf525_app` in prod) |
| `NF525_STORAGE` | Yes | `postgres` (prod) or `memory` (tests) |
| `NF525_SIGNER` | Yes | `file` (dev/prod) or `memory` (tests) or `kms` (future) |
| `NF525_SIGNING_KEY_PATH` | If signer=file | Path to Ed25519 PEM key, chmod 600 |
| `NF525_SIGNING_KEY_VERSION` | Yes | Active key version in the public key registry |

Example `.env`:

```env
NF525_DATABASE_URL=postgresql://nf525_app:password@localhost:5432/nf525
NF525_STORAGE=postgres
NF525_SIGNER=file
NF525_SIGNING_KEY_PATH=/etc/nf525/signing-key.pem
NF525_SIGNING_KEY_VERSION=v1
```

## 4. Database Migration

Run once before first use, with the role that owns the database (it creates the `nf525_app` role). Plain node, no extra tooling:

```bash
NF525_DATABASE_URL=postgresql://... npx caisseia-migrate
```

Or from your own deploy code:

```typescript
import { migrate } from 'caisseia';

await migrate({ connectionString: process.env.NF525_DATABASE_URL });
// → { applied: ['001_initial.sql', ...] }
```

The SQL files ship in `dist/src/storage/migrations/` and are applied in lexical order.

This creates the `nf525_event` table, `nf525_app` role, REVOKE constraints, and the `refuse_mutation` trigger. Idempotent — safe to re-run.

Verify REVOKE is effective:

```sql
-- Connect as nf525_app and attempt (must fail):
SET ROLE nf525_app;
UPDATE nf525_event SET payload = '{}' WHERE id = 'test';
-- ERROR: permission denied
```

## 5. Initialization

Call `initialize()` once at app startup:

```typescript
import { initialize } from 'caisseia';

await initialize({
  databaseUrl: process.env.NF525_DATABASE_URL!,
  defaultWorkspaceId: 'ws-your-tenant-id',
  signerKind: 'file',
  defaultCurrency: 'EUR',
  tvaRates: [
    { code: '20', rate: 20, label: 'TVA 20%' },
    { code: '10', rate: 10, label: 'TVA 10%' },
    { code: '5.5', rate: 5.5, label: 'TVA 5.5%' },
    { code: '0', rate: 0, label: 'Exonere' },
  ],
});
```

## 6. Recording Payments (Encaissements)

Every client payment must go through `recordEncaissement()`:

```typescript
import { recordEncaissement } from 'caisseia';

const result = await recordEncaissement({
  workspaceId: 'ws-tenant-123',
  montantCentimes: 5000,         // 50.00 EUR — always in centimes, integer
  modePaiement: 'carte_bancaire', // 'especes' | 'carte_bancaire' | 'virement' | 'cheque' | 'stripe' | 'autre'
  tvaCode: '20',
  referenceExterne: 'INV-2026-001',
  operateurId: 'user-42',
  metadata: { client: 'ACME SARL' },
});
// result.event contains the signed, hash-chained record
```

**Rules:**
- `montantCentimes` must be a strictly positive integer
- Never use floats for monetary amounts
- Every call creates an immutable, hash-chained record

### Inside your own transaction

Pass your Postgres client to record the encaissement (and its JET entry) in the same
transaction as your own rows. The SDK never begins, commits or releases that client.

```typescript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  // ... your own writes (order, invoice) ...
  const enc = await recordEncaissement(workspaceId, input, { client });
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

The same `{ client }` option exists on `recordCorrection(workspaceId, input, { client })`
and `logTechnicalEvent(workspaceId, type, details, context, { client })`. Appends to the
same (workspace, stream) are serialized by a transaction-scoped advisory lock, held until
you commit or roll back: keep these transactions short. Your transaction must be READ
COMMITTED (the Postgres default).

`recordCorrection` checks the net amount and appends under that same lock, so two
parallel corrections on one encaissement can never push its net below 0. Without
`{ client }` the SDK opens its own short transaction for it.

Closures, the integrity check and the export take `{ client }` too, and then do every
read and write on your connection:
`closeDay(workspaceId, date, { tvaRates, client })`, `closeMonth(workspaceId, year, month, { client })`,
`closeYear(workspaceId, year, { client })`, `getCurrentDayClosure / getMonthClosure / getYearClosure(…, { client })`,
`verifyChainIntegrity(workspaceId, { client })`, `exportPeriod(workspaceId, from, to, format, { client })`.
If you isolate `nf525_event` with row-level security (e.g. `workspace_id = current_setting('app.space_id')`),
pass the client on which that setting is made: the SDK's own pool sees no rows there.
`closeDay` refuses to seal a day when its encaissement read returns no row while the
stream has records.

## 7. Corrections (Refunds / Adjustments)

Never modify an existing record. Create a correction:

```typescript
import { recordCorrection } from 'caisseia';

const correction = await recordCorrection({
  workspaceId: 'ws-tenant-123',
  originalId: result.event.id,       // references the original encaissement
  montantCentimes: -2500,            // negative = refund (partial: -25.00 EUR)
  motif: 'Remboursement partiel client',
  type: 'annulation_partielle',      // 'annulation_totale' | 'annulation_partielle' | 'rectification'
  operateurId: 'user-42',
});
```

To get the net amount after corrections:

```typescript
import { getNetAmount } from 'caisseia';

const net = await getNetAmount('ws-tenant-123', originalId);
// net.netAmountCentimes = 5000 + (-2500) = 2500
```

## 8. Closures (Daily / Monthly / Annual)

Closures must be automated. They seal the period and produce signed aggregates.

### Daily Closure (Z journalier)

Run at end of each business day (or 00:00 UTC via cron):

```typescript
import { closeDay } from 'caisseia';

const closure = await closeDay('ws-tenant-123', '2026-05-18', {
  tvaRates: [
    { code: '20', rate: 20 },
    { code: '10', rate: 10 },
  ],
});
// closure contains signed aggregates: totals by payment mode, by TVA code, cumul perpetuel
```

### Monthly Closure

Run on the 1st of each month. Requires all daily closures for the previous month:

```typescript
import { closeMonth } from 'caisseia';

const monthly = await closeMonth('ws-tenant-123', 2026, 5);
// Aggregates all daily closures for May 2026
```

### Annual Closure

Run on January 1. Requires all monthly closures for the previous year:

```typescript
import { closeYear } from 'caisseia';

const annual = await closeYear('ws-tenant-123', 2026);
// Aggregates all monthly closures for 2026
```

### Automation Example (Node cron)

```typescript
import cron from 'node-cron';
import { closeDay, closeMonth, closeYear } from 'caisseia';

// Daily at 00:05 UTC
cron.schedule('5 0 * * *', async () => {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];
  await closeDay('ws-tenant-123', dateStr);
});

// Monthly on the 1st at 00:30 UTC
cron.schedule('30 0 1 * *', async () => {
  const now = new Date();
  const prevMonth = now.getUTCMonth(); // 0-indexed, so current = previous+1
  const year = prevMonth === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const month = prevMonth === 0 ? 12 : prevMonth;
  await closeMonth('ws-tenant-123', year, month);
});

// Annual on Jan 1 at 01:00 UTC
cron.schedule('0 1 1 1 *', async () => {
  const prevYear = new Date().getUTCFullYear() - 1;
  await closeYear('ws-tenant-123', prevYear);
});
```

## 9. Export for DGFIP (Restitution)

When an inspector requests data, or for periodic archival:

```typescript
import { exportPeriod, verifyExportIntegrity } from 'caisseia';

// Export as JSON (complete: encaissements, corrections, closures, JET)
const jsonExport = await exportPeriod('ws-tenant-123', '2026-01-01', '2026-12-31', 'json');

// Export as CSV (FR locale, Excel-parsable)
const csvExport = await exportPeriod('ws-tenant-123', '2026-01-01', '2026-12-31', 'csv');

// Export as PDF (summary report)
const pdfExport = await exportPeriod('ws-tenant-123', '2026-01-01', '2026-12-31', 'pdf');

// Each export includes a manifest with SHA-256 hashes
// Verify offline (no DB access needed). Closure signatures are checked against
// the TRUSTED registry (option, else NF525_KEY_REGISTRY_PATH), never skipped:
const integrity = await verifyExportIntegrity(jsonExport, { keyRegistry: trustedRegistry });
// integrity.valid === true if no tampering detected; false if the registry is empty
//   or a signed chain head does not match the exported records, the signed closure
//   chain is broken, or an elapsed day fully inside the window has records but no day closure
// integrity.fullyVerified === false + integrity.warnings when a legacy (v1) closure is present
```

## 10. Integrity Verification

Run periodically (recommended: monthly) to detect any chain tampering:

```typescript
import { verifyChainIntegrity } from 'caisseia';

const report = await verifyChainIntegrity('ws-tenant-123');
// or: verifyChainIntegrity('ws-tenant-123', { keyRegistry })
// report.valid: boolean
// report.error: set (and valid=false) when the key registry is empty or missing,
//   or an elapsed UTC day has records but no day closure (joined by « | »)
// report.fullyVerified: valid AND no legacy (v1) closure left uncovered by a v2 closure
// report.warnings: « legacy closure, chain head not signed: … » per uncovered v1 closure
// report.streams: per-stream results (encaissement, jet, closure-day, closure-month, closure-year)
```

Hash links are checked on every stream; the Ed25519 signature of every closure
(the only signed records) is checked against the key registry. The registry
(`NF525_KEY_REGISTRY_PATH`, default bundled `keys/public-keys.json`) must list
every signing key version ever used — an empty registry makes the check FAIL.
Encaissement / correction / JET records are not signed one by one, but every
closure (schema v2) signs the chain head of the `encaissement` and `jet`
streams at its period end (`payload.chainHeads = { encaissement, jet }`, each
`{ sequence, hash }`, `payload.schemaVersion = 2`). The verifier recomputes
each chain and requires the record at the signed sequence to have the signed
hash: a rewrite + full rechain of any record up to a closure's period end
fails with `chain head mismatch: <stream> at sequence N`.

Legacy closures (v1, sealed before this change) sign totals only. They still
verify (`valid` unaffected) but each one not covered by a later v2 closure is
listed in `warnings` and sets `fullyVerified: false`. Treat
`fullyVerified: false` as "not proven unaltered".

Closure chain: every v2 closure also signs `payload.previousClosureHash` =
hash of the previous closure record of the same stream (`closure-day`,
`closure-month`, `closure-year` chain separately; GENESIS_HASH for the
first). Deleting or renumbering a closure and rechaining its stream fails with
`closure chain broken at sequence N` (export: « Chaîne des clôtures rompue »).

Elapsed days without closure: `report.error` (so `valid: false`) lists every
elapsed day that has encaissement or JET records but no day closure
(« elapsed day(s) with records but no day closure: YYYY-MM-DD »). Elapsed day =
UTC calendar day strictly before `options.now` (default now); closures use UTC
day bounds. Today is never an error. `verifyExportIntegrity(export, { now })`
checks only the days lying entirely inside the export window. Every
verification, export and closure writes a JET record, so a day with only that
activity still needs its day closure: run `closeDay` for every day.

```typescript
const report = await verifyChainIntegrity('ws-tenant-123', { keyRegistry, now: new Date() });
```

Remaining gaps: records after the latest closure's period end are protected
by the hash chain only (rewrite + rechain or truncation of that tail is not
detected until the next closure). The newest closure of a stream has no
successor signing it: deleting the newest day closure is caught only once its
day has elapsed, and not at all if every encaissement and JET record after the
previous closure's signed heads is deleted with it (see README « Known gaps »).
Close every day.

CLI alternative:

```bash
pnpm verify-integrity ws-tenant-123
# Exit 0 = all chains valid
# Exit 3 = valid but NOT fully verified (legacy v1 closure, chain head not signed)
# Exit 1 = integrity broken
```

## 11. Attestation Generation

Generate attestation PDF for a workspace user:

```typescript
import { generateAttestation } from 'caisseia';

const attestation = await generateAttestation({
  workspaceId: 'ws-tenant-123',
  raisonSociale: 'ACME SARL',
  siret: '123 456 789 00011',
  consumerAppName: 'MyApp',
  consumerAppVersion: '1.0.0',
  startDate: '2026-06-01',
  specimen: false,  // ONLY set false after v1.0.0 attestation is signed
});
// attestation.pdfBuffer: Buffer — the PDF
// attestation.pdfHash: string — SHA-256 of the PDF
```

CLI alternative:

```bash
pnpm generate-attestation \
  --workspace ws-tenant-123 \
  --raison-sociale "ACME SARL" \
  --siret "123 456 789 00011" \
  --app MyApp \
  --app-version 1.0.0 \
  --start-date 2026-06-01 \
  --output attestation.pdf
```

## 12. UI Requirements (BOFIP)

The BOFIP requires that compliance information be accessible to an inspector in under 2 clicks. Your app must expose:

### Required UI Elements

1. **Version display** — Show the `caisseia` version in an "About" or "Settings" page
2. **Integrity check** — "Verifier l'integrite" button that calls `verifyChainIntegrity()` and displays result
3. **Export button** — "Exporter pour controle DGFIP" button with format selector (CSV/JSON/PDF)
4. **Closures list** — View daily/monthly/annual closure history
5. **Attestation access** — Link to or display of the signed attestation PDF

### Placement

```
Settings > Compliance
├── Version: CAISSEIA v1.0.0
├── [Verifier l'integrite]        → calls verifyChainIntegrity()
├── [Exporter donnees DGFIP]      → calls exportPeriod()
├── Historique clotures           → list of closures
└── Attestation                   → link to signed PDF
```

All must be reachable from the main navigation in 2 clicks or fewer.

## 13. JET (Journal des Evenements Techniques)

Log app-level technical events:

```typescript
import { logTechnicalEvent } from 'caisseia';

// Log user login
await logTechnicalEvent({
  workspaceId: 'ws-tenant-123',
  type: 'user_login',
  operateurId: 'user-42',
  details: { ip: req.ip },
});

// Log configuration change
await logTechnicalEvent({
  workspaceId: 'ws-tenant-123',
  type: 'config_change',
  operateurId: 'admin-1',
  details: { field: 'tva_rates', oldValue: '20', newValue: '20,10' },
});
```

Supported event types: `system_start`, `system_stop`, `user_login`, `user_logout`, `config_change`, `mutation_rejected`, `export_requested`, `export_completed`, `closure_triggered`, `error`, `degraded_mode_enter`, `degraded_mode_exit`.

## 14. Error Handling

All CAISSEIA functions throw on validation failure (Zod parse errors). Wrap calls appropriately:

```typescript
try {
  await recordEncaissement(input);
} catch (error) {
  if (error instanceof z.ZodError) {
    // Validation failed — do NOT proceed, log to JET
    await logTechnicalEvent({
      workspaceId,
      type: 'mutation_rejected',
      details: { reason: error.message, input },
    });
  }
  throw error; // Re-throw — the encaissement did NOT happen
}
```

## 15. Testing in Consumer Apps

For tests, use in-memory storage and signer:

```typescript
import { setActiveStorage, InMemoryStorage, setActiveSigner } from 'caisseia';
import { MemorySigner } from 'caisseia/dist/src/crypto/Signer.js';

beforeEach(() => {
  setActiveStorage(new InMemoryStorage());
  setActiveSigner(new MemorySigner());
});
```

---

## Quick Reference

| Operation | Function | Frequency |
|-----------|----------|-----------|
| Record payment | `recordEncaissement()` | Every transaction |
| Record refund | `recordCorrection()` | Every correction |
| Daily closure | `closeDay()` | Daily (automated) |
| Monthly closure | `closeMonth()` | Monthly (automated) |
| Annual closure | `closeYear()` | Annually (automated) |
| Export data | `exportPeriod()` | On demand / inspector request |
| Verify integrity | `verifyChainIntegrity()` | Monthly (recommended) |
| Generate attestation | `generateAttestation()` | Per workspace onboarding |
| Log technical event | `logTechnicalEvent()` | App-level events |
