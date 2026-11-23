# Integration Guide — CAISSEIA

Step-by-step guide for consumer apps integrating CAISSEIA.

---

## 1. Prerequisites

- Node >= 20
- PostgreSQL instance (dedicated database or schema recommended)
- Ed25519 signing key (generated, chmod 600)
- `caisseia` (no attestation éditeur is signed yet: see `ATTESTATION.md`)

## 2. Install

```bash
npm install caisseia
# or
pnpm add caisseia
```

## 3. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CAISSEIA_DATABASE_URL` | Yes | Postgres connection string (role `nf525_app` in prod) |
| `CAISSEIA_STORAGE` | Yes (set to `postgres` by `initialize({ databaseUrl })`) | `postgres`, or `memory` for tests and demos only (records lost on restart, one warning per process). Unset with no `setActiveStorage(...)` → every call throws `NF525_STORAGE_NOT_CONFIGURED` |
| `CAISSEIA_SIGNER` | Yes | `file` (dev/prod) or `memory` (tests) or `kms` (future) |
| `CAISSEIA_SIGNING_KEY_PATH` | If signer=file | Path to Ed25519 PEM key, chmod 600 |
| `CAISSEIA_SIGNING_KEY_VERSION` | Yes | Active key version in the public key registry |

Example `.env`:

```env
CAISSEIA_DATABASE_URL=postgresql://nf525_app:password@localhost:5432/nf525
CAISSEIA_STORAGE=postgres
CAISSEIA_SIGNER=file
CAISSEIA_SIGNING_KEY_PATH=/etc/nf525/signing-key.pem
CAISSEIA_SIGNING_KEY_VERSION=v1
```

The former `NF525_*` names (`NF525_DATABASE_URL`, …) are still read when the `CAISSEIA_*` one is unset, with one deprecation warning per name (`CAISSEIA_ENV_DEPRECATED`).

## 4. Database Migration

Run once before first use, with the role that owns the database (it creates the `nf525_app` role). Plain node, no extra tooling:

```bash
CAISSEIA_DATABASE_URL=postgresql://... npx caisseia-migrate
```

Or from your own deploy code:

```typescript
import { migrate } from 'caisseia';

await migrate({ connectionString: process.env.CAISSEIA_DATABASE_URL });
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
  databaseUrl: process.env.CAISSEIA_DATABASE_URL!,
  defaultWorkspaceId: 'ws-your-tenant-id',
  signerKind: 'file',
  defaultCurrency: 'EUR',
  tvaRates: [
    { code: 'TVA20', rate: 0.2, label: 'TVA 20%' },
    { code: 'TVA10', rate: 0.1, label: 'TVA 10%' },
    { code: 'TVA55', rate: 0.055, label: 'TVA 5,5%' },
    { code: 'EXONERE', rate: 0, label: 'Exonéré' },
  ],
});
```

## 6. Recording Payments (Encaissements)

Every client payment must go through `recordEncaissement()`:

```typescript
import { recordEncaissement } from 'caisseia';

const enc = await recordEncaissement('ws-tenant-123', {
  montantCentimes: 5000, // 50.00 EUR — always in centimes, integer
  devise: 'EUR',         // 'EUR' | 'CHF'
  mode: 'cb',            // 'especes' | 'cb' | 'cb_mobile' | 'virement' | 'cheque' | 'stripe' | 'wallet' | 'autre'
  tvaCode: 'TVA20',      // uppercase code, e.g. TVA20, TVA55, FRANCHISE_BASE
  factureId: 'INV-2026-001',
  clientRef: 'ACME SARL',
  operatorId: 'user-42',
});
// enc._id, enc.sequence, enc.hash: the hash-chained record
```

**Rules:**
- The input is strict: an unknown field is refused (optional fields: `factureId`, `reservationId`,
  `clientRef`, `stripeRef`, `notes`, `operatorId`, `registerId`)
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

const correction = await recordCorrection('ws-tenant-123', {
  originalId: enc._id,      // the original encaissement
  montantCentimes: -2500,   // negative = refund (partial: -25.00 EUR)
  devise: 'EUR',            // must match the original
  type: 'remboursement_partiel', // 'erreur_montant' | 'remboursement_partiel' | 'remboursement_total' | 'annulation_totale' | 'avoir_commercial' | 'autre'
  reason: 'Remboursement partiel client',
  operatorId: 'user-42',
});
```

To get the net amount after corrections:

```typescript
import { getNetAmount } from 'caisseia';

const net = await getNetAmount('ws-tenant-123', enc._id);
// net = 5000 + (-2500) = 2500 (centimes)
```

## 8. Closures (Daily / Monthly / Annual)

Closures must run on a schedule. They seal the period and produce signed aggregates.

### Business days

A day closure covers one **business day**: the business's local civil day, in its IANA
time zone (default `Europe/Paris`; overseas departments use their own zone), from its
cut-off hour (default `00:00`) to the next day's cut-off. DST days last 23 or 25 hours.
Timestamps stay stored in UTC; only the grouping is local. A month closure covers the
calendar month at that cut-off; a yearly closure covers the exercice, which ends with the
fiscal-year-end month (default December).

```typescript
import { setBusinessCalendar } from 'caisseia';

// A bar open until 4 a.m.: a 03:30 sale belongs to the previous business day.
await setBusinessCalendar('ws-tenant-123', { dayCutoff: '05:00' });
// Exercice ending 30 June:
await setBusinessCalendar('ws-tenant-123', { fiscalYearEndMonth: 6 });
```

A change is logged in the JET (`business_calendar_set`) and applies from the day after the
last day closure: sealed days never change. A workspace that already holds UTC-bounded day
closures (sealed before rc.7) keeps UTC until it calls `setBusinessCalendar`.

Each closure signs its `periodKey` (day `YYYY-MM-DD`, month `YYYY-MM`, exercice: its last
month `YYYY-MM`) and the calendar used. `periodStart` / `periodEnd` are UTC instants: identify
a closure by `periodKey`, never by the UTC date of `periodStart`.

### Daily Closure (Z journalier)

Run at the end of each business day:

```typescript
import { closeDay } from 'caisseia';

const closure = await closeDay('ws-tenant-123', '2026-05-18', {
  tvaRates: { TVA20: 0.2, TVA10: 0.1 },
});
// closure contains signed aggregates: totals by payment mode, by TVA code, cumul perpetuel
```

`date` is a business date (`'YYYY-MM-DD'`) or a `Date` (the business day containing that
instant). A day that has not started is refused. A day closed before its end (a Z taken at
19:00) ends at the closing instant; later sales that day belong to the next business day.
A payment in flight while the day is being closed is either counted in it or dated after
it, never inside a sealed day.

### Monthly Closure

Run on the 1st of each month. Requires the closure of every business day of the month:

```typescript
import { closeMonth } from 'caisseia';

const monthly = await closeMonth('ws-tenant-123', 2026, 5);
// Aggregates all daily closures for May 2026
```

### Annual Closure (exercice)

Run after the last month of the exercice is closed. `closeYear(ws, year)` closes the exercice
that ends in `year`; it starts the month after the previous yearly closure (the first one: at
the first month closure). Requires every month closure in between:

```typescript
import { closeYear } from 'caisseia';

const annual = await closeYear('ws-tenant-123', 2026);
// Aggregates the month closures of the exercice ending in 2026
```

### Scheduling Example (Node cron)

```typescript
import cron from 'node-cron';
import { closeDay, closeMonth, closeYear } from 'caisseia';

// Business date of the day that just ended (cut-off 00:00, time zone Europe/Paris).
const businessDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);

// Daily at 00:05 Paris time
cron.schedule('5 0 * * *', async () => {
  await closeDay('ws-tenant-123', businessDate(new Date(Date.now() - 12 * 3600_000)));
}, { timezone: 'Europe/Paris' });

// Monthly on the 1st at 00:30 Paris time
cron.schedule('30 0 1 * *', async () => {
  const [y, m] = businessDate(new Date(Date.now() - 12 * 3600_000)).split('-').map(Number);
  await closeMonth('ws-tenant-123', y!, m!);
}, { timezone: 'Europe/Paris' });

// Yearly on 1 January at 01:00 Paris time (exercice ending in December)
cron.schedule('0 1 1 1 *', async () => {
  await closeYear('ws-tenant-123', new Date().getFullYear() - 1);
}, { timezone: 'Europe/Paris' });
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
// the TRUSTED registry (option, else CAISSEIA_KEY_REGISTRY_PATH), never skipped:
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
(`CAISSEIA_KEY_REGISTRY_PATH`, default bundled `keys/public-keys.json`) must list
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
elapsed business day that has encaissement or JET records no day closure
covers (« elapsed day(s) with records but no day closure: YYYY-MM-DD »).
Elapsed day = business day (§ 8) ended before `options.now` (default now); the
running day is never an error. Overlapping day closures are an error too. `verifyExportIntegrity(export, { now })`
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
await logTechnicalEvent('ws-tenant-123', 'user_login', {}, { userId: 'user-42', sourceIp: '192.168.1.1' });

// Log configuration change
await logTechnicalEvent(
  'ws-tenant-123',
  'config_changed',
  { field: 'tva_rates', oldValue: 'TVA20', newValue: 'TVA20,TVA10' },
  { userId: 'admin-1' },
);
```

Supported event types: `system_boot`, `system_shutdown`, `config_changed`, `tva_rate_changed`, `signing_key_rotated`, `user_login`, `user_logout`, `user_login_failed`, `encaissement_recorded`, `correction_recorded`, `mutation_attempt_refused`, `closure_day_initiated`, `closure_day_completed`, `closure_month_initiated`, `closure_month_completed`, `closure_year_initiated`, `closure_year_completed`, `export_requested`, `export_completed`, `integrity_check_run`, `integrity_check_failed`, `degraded_mode_enter`, `degraded_mode_exit`, `manual_entry_injected`, `business_calendar_set`, `payment_method_config_changed`, `operator_config_changed`, `error_application`, `error_compliance`.

## 14. Error Handling

All CAISSEIA functions throw on validation failure (Zod parse errors). Wrap calls appropriately:

```typescript
try {
  await recordEncaissement(workspaceId, input);
} catch (error) {
  if (error instanceof z.ZodError) {
    // Validation failed — do NOT proceed, log to JET (no raw input: it may hold personal data)
    await logTechnicalEvent(workspaceId, 'error_application', {
      reason: 'encaissement input refused',
      issues: error.issues.map((i) => i.path.join('.')),
    });
  }
  throw error; // Re-throw — the encaissement did NOT happen
}
```

## 15. Testing in Consumer Apps

The SDK never falls back to an in-memory register on its own: with no storage
configured, every call throws `NF525_STORAGE_NOT_CONFIGURED`. For tests, inject
the in-memory storage and signer on purpose (in-memory refuses `{ client }`:
it has no transactions):

```typescript
import { setActiveStorage, InMemoryStorage, setActiveSigner } from 'caisseia';
import { MemorySigner } from 'caisseia/core';

beforeEach(async () => {
  setActiveStorage(new InMemoryStorage());
  setActiveSigner(await MemorySigner.generate('test-v1'));
});
```

For a demo without Postgres: `await initialize({ storage: 'memory', defaultCurrency: 'EUR', tvaRates: [] })`
(a one-time warning says the records do not survive a restart).

---

## Quick Reference

| Operation | Function | Frequency |
|-----------|----------|-----------|
| Record payment | `recordEncaissement()` | Every transaction |
| Record refund | `recordCorrection()` | Every correction |
| Daily closure | `closeDay()` | Daily (scheduled) |
| Monthly closure | `closeMonth()` | Monthly (scheduled) |
| Annual closure | `closeYear()` | Annually (scheduled) |
| Export data | `exportPeriod()` | On demand / inspector request |
| Verify integrity | `verifyChainIntegrity()` | Monthly (recommended) |
| Generate attestation | `generateAttestation()` | Per workspace onboarding |
| Log technical event | `logTechnicalEvent()` | App-level events |
