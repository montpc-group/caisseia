/**
 * Tests de cycle de vie complet — scénario end-to-end DGFIP.
 *
 * Cf. COMPLIANCE.md §§ 1–5, BOI-CF-COM-20-60.
 *
 * Ce test simule exactement ce qu'un inspecteur DGFIP vérifierait :
 * enregistrement, corrections, clôtures, intégrité, export, JET.
 * C'est la preuve de bout en bout que le module fonctionne dans un
 * scénario réaliste, pas isolé par composant.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordEncaissement } from '../src/encaissement.js';
import { recordCorrection } from '../src/corrections.js';
import { closeDay, closeMonth } from '../src/closures.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { exportPeriod, verifyExportIntegrity } from '../src/restitution.js';
import { read } from '../src/eventStore.js';
import { freshHarness, type Harness } from './_helpers.js';
import type { Encaissement } from '../src/encaissement.js';
import type { JetPayloadZ } from '../schemas/jet.schema.js';

describe('Lifecycle end-to-end (scénario contrôle DGFIP — art. 286 I 3°bis CGI)', () => {
  let h: Harness;

  // Use 2 distinct UTC days for encaissement distribution.
  const DAY2 = new Date(Date.UTC(2027, 2, 11)); // 2027-03-11
  const DAY3 = new Date(Date.UTC(2027, 2, 12)); // 2027-03-12

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('scénario complet : 10 encaissements, 2 corrections, 3 clôtures jour, 1 clôture mois, intégrité, export, JET', async () => {
    // ================================================================
    // STEP 1 — Record 10 encaissements across 3 days (mixed modes, mixed TVA)
    // ================================================================
    // NOTE: recordedAt is server clock ("now"). We cannot backdate records
    // via the public API (by design — inaltérabilité). For the lifecycle test,
    // all 10 records will fall in "today's" window. We close "today" after
    // recording, which captures all of them. Days 2 and 3 will be empty —
    // this still proves the full lifecycle including zero-day closures.

    const encaissements: Encaissement[] = [];

    // Batch 1: 4 encaissements simulating day 1 activity (CB + espèces, TVA20)
    for (const [amt, mode] of [
      [2500, 'cb'],
      [1500, 'especes'],
      [3000, 'cb'],
      [800, 'especes'],
    ] as const) {
      encaissements.push(
        await recordEncaissement(h.workspace, {
          montantCentimes: amt,
          devise: 'EUR',
          mode,
          tvaCode: 'TVA20',
        }),
      );
    }

    // Batch 2: 3 encaissements simulating day 2 activity (Stripe + virement, TVA10)
    for (const [amt, mode] of [
      [5000, 'stripe'],
      [7500, 'virement'],
      [1200, 'stripe'],
    ] as const) {
      encaissements.push(
        await recordEncaissement(h.workspace, {
          montantCentimes: amt,
          devise: 'EUR',
          mode,
          tvaCode: 'TVA10',
        }),
      );
    }

    // Batch 3: 3 encaissements simulating day 3 activity (wallet + chèque, mixed TVA)
    for (const [amt, mode, tva] of [
      [4000, 'wallet', 'TVA20'],
      [2200, 'cheque', 'TVA10'],
      [900, 'wallet', 'TVA5_5'],
    ] as const) {
      encaissements.push(
        await recordEncaissement(h.workspace, {
          montantCentimes: amt,
          devise: 'EUR',
          mode,
          tvaCode: tva,
        }),
      );
    }

    expect(encaissements.length).toBe(10);
    const totalBrut = encaissements.reduce((acc, e) => acc + e.data.montantCentimes, 0);
    // 2500+1500+3000+800+5000+7500+1200+4000+2200+900 = 28600
    expect(totalBrut).toBe(28600);

    // ================================================================
    // STEP 2 — Record 2 corrections
    // ================================================================

    // Partial refund on the first encaissement.
    const corr1 = await recordCorrection(h.workspace, {
      originalId: encaissements[0]!._id,
      montantCentimes: -1000,
      devise: 'EUR',
      type: 'remboursement_partiel',
      reason: 'Client a annulé une prestation sur deux',
    });

    // Error correction on the 5th encaissement (upward — operator entered too little).
    const corr2 = await recordCorrection(h.workspace, {
      originalId: encaissements[4]!._id,
      montantCentimes: -500,
      devise: 'EUR',
      type: 'erreur_montant',
      reason: 'Erreur de saisie corrigée par le superviseur',
    });

    const totalNet = totalBrut + corr1.data.montantCentimes + corr2.data.montantCentimes;
    // 28600 - 1000 - 500 = 27100
    expect(totalNet).toBe(27100);

    // ================================================================
    // STEP 3 — Close 3 days
    // ================================================================
    // "Today" captures all 10 encaissements + 2 corrections (all recorded now).
    // Days 2 and 3 are future UTC days — they'll be empty closures.
    const today = new Date();
    const closureDay1 = await closeDay(h.workspace, today);
    const closureDay2 = await closeDay(h.workspace, DAY2);
    const closureDay3 = await closeDay(h.workspace, DAY3);

    // Day 1 (today) has all the action.
    expect(closureDay1.aggregate.caTotalCentimes).toBe(totalNet);
    expect(closureDay1.aggregate.nbTransactions).toBe(10);

    // Days 2 and 3 are empty.
    expect(closureDay2.aggregate.caTotalCentimes).toBe(0);
    expect(closureDay2.aggregate.nbTransactions).toBe(0);
    expect(closureDay3.aggregate.caTotalCentimes).toBe(0);
    expect(closureDay3.aggregate.nbTransactions).toBe(0);

    // ================================================================
    // STEP 4 — Close the "month" (requires ALL days of that month closed)
    // ================================================================
    // We close March 2027 — need all 31 days.
    // We already closed today (which is NOT March 2027 in real time), plus
    // days 2 and 3 which are 2027-03-11 and 2027-03-12.
    // Close the remaining days of March 2027.
    for (let d = 1; d <= 31; d++) {
      const dayDate = new Date(Date.UTC(2027, 2, d));
      // Skip days already closed (11 and 12).
      if (d === 11 || d === 12) continue;
      // Skip day 10 only if it matches "today" (unlikely in practice).
      await closeDay(h.workspace, dayDate).catch(() => {
        // If already closed (e.g., day 10 = today), ignore.
      });
    }

    const monthClosure = await closeMonth(h.workspace, 2027, 3);
    expect(monthClosure.type).toBe('month');
    expect(monthClosure.periodStart.startsWith('2027-03-01')).toBe(true);
    expect(monthClosure.periodEnd.startsWith('2027-03-31')).toBe(true);

    // ================================================================
    // STEP 5 — Verify chain integrity
    // ================================================================
    const integrityReport = await verifyChainIntegrity(h.workspace);
    expect(integrityReport.valid).toBe(true);
    for (const stream of integrityReport.streams) {
      expect(stream.valid, `stream ${stream.name} must be valid`).toBe(true);
    }

    // ================================================================
    // STEP 6 — Export the period (JSON)
    // ================================================================
    const exportFrom = new Date(Date.UTC(2020, 0, 1)); // Wide window.
    const exportTo = new Date(Date.UTC(2030, 11, 31));
    const jsonExport = await exportPeriod(h.workspace, exportFrom, exportTo, 'json');

    expect(jsonExport.data.encaissements.length).toBe(10);
    expect(jsonExport.data.corrections.length).toBe(2);
    expect(jsonExport.data.closures.length).toBeGreaterThanOrEqual(3); // At least 3 day + 1 month
    expect(jsonExport.data.jet.length).toBeGreaterThan(0);
    expect(jsonExport.data.keyRegistry.keys.length).toBeGreaterThan(0);

    // ================================================================
    // STEP 6b — Export the period (CSV)
    // ================================================================
    const csvExport = await exportPeriod(h.workspace, exportFrom, exportTo, 'csv');
    const csvFile = csvExport.files.find((f) => f.name === 'encaissements.csv')!;
    const csvLines = csvFile.content.split('\n');
    // Header + 12 data rows (10 encaissements + 2 corrections).
    expect(csvLines.length).toBe(13);

    // ================================================================
    // STEP 7 — Verify export integrity
    // ================================================================
    const jsonIntegrity = await verifyExportIntegrity(jsonExport);
    expect(jsonIntegrity.valid).toBe(true);
    expect(jsonIntegrity.errors).toBeUndefined();

    // ================================================================
    // STEP 8 — Verify JET contains all expected event types
    // ================================================================
    const jetRecords = await read<JetPayloadZ>('jet', h.workspace);
    const jetTypes = jetRecords.map((r) => r.payload.type);

    // encaissement_recorded × 10
    const encRecordedCount = jetTypes.filter((t) => t === 'encaissement_recorded').length;
    expect(encRecordedCount).toBe(10);

    // correction_recorded × 2
    const corrRecordedCount = jetTypes.filter((t) => t === 'correction_recorded').length;
    expect(corrRecordedCount).toBe(2);

    // closure_day_completed — at least 3 (today + day2 + day3), likely more (remaining days of March).
    const closureDayCount = jetTypes.filter((t) => t === 'closure_day_completed').length;
    expect(closureDayCount).toBeGreaterThanOrEqual(3);

    // closure_month_completed × 1
    const closureMonthCount = jetTypes.filter((t) => t === 'closure_month_completed').length;
    expect(closureMonthCount).toBe(1);

    // export_requested — 2 (JSON + CSV exports above)
    const exportRequestedCount = jetTypes.filter((t) => t === 'export_requested').length;
    expect(exportRequestedCount).toBe(2);

    // export_completed — 2
    const exportCompletedCount = jetTypes.filter((t) => t === 'export_completed').length;
    expect(exportCompletedCount).toBe(2);

    // integrity_check_run — at least 1 (from verifyChainIntegrity)
    const integrityCheckCount = jetTypes.filter((t) => t === 'integrity_check_run').length;
    expect(integrityCheckCount).toBeGreaterThanOrEqual(1);

    // ================================================================
    // STEP 9 — Verify GT in month closure = sum of all daily closures
    // ================================================================
    // The month closure's cumulPerpetuel = last day's cumulPerpetuel.
    // The month's caTotalCentimes = sum of all days' caTotalCentimes.
    // Since only "today" had non-zero activity AND "today" may or may not
    // be in March 2027, we verify the structural relationship:
    // month.caTotalCentimes = sum of day closures in that month.

    // Read all day closures for March 2027.
    const allDayClosures = await read<any>('closure-day', h.workspace);
    const marchDays = allDayClosures.filter(
      (r: any) =>
        r.payload.periodStart >= '2027-03-01T00:00:00.000Z' &&
        r.payload.periodStart <= '2027-03-31T23:59:59.999Z',
    );
    const sumDays = marchDays.reduce(
      (acc: number, r: any) => acc + r.payload.aggregate.caTotalCentimes,
      0,
    );
    expect(monthClosure.aggregate.caTotalCentimes).toBe(sumDays);

    // cumulPerpetuel of the month = last day of month's cumul (structural invariant).
    const lastMarchDay = marchDays[marchDays.length - 1];
    if (lastMarchDay) {
      expect(monthClosure.aggregate.cumulPerpetuel).toBe(
        lastMarchDay.payload.aggregate.cumulPerpetuel,
      );
    }
  });

  it('la chaîne de hash reste valide après un cycle complet encaissements → corrections → clôtures', async () => {
    // AUDIT: Vérification structurelle que le cycle complet ne casse jamais
    // la chaîne. Test séparé du scénario complet pour isoler la preuve.
    for (let i = 0; i < 5; i++) {
      await recordEncaissement(h.workspace, {
        montantCentimes: 100 * (i + 1),
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 999,
      devise: 'EUR',
      mode: 'especes',
      tvaCode: 'TVA10',
    });
    await recordCorrection(h.workspace, {
      originalId: enc._id,
      montantCentimes: -99,
      devise: 'EUR',
      type: 'avoir_commercial',
      reason: 'Geste commercial fidélité',
    });

    await closeDay(h.workspace, new Date());

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(true);
    // Every stream that has records must be checked and valid.
    const nonEmpty = report.streams.filter((s) => s.recordsChecked > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(3); // encaissement, jet, closure-day at minimum
    for (const s of nonEmpty) {
      expect(s.valid, `${s.name} chain must be valid`).toBe(true);
    }
  });

  it('l\'export couvre exactement la période demandée — pas de fuite de données hors fenêtre', async () => {
    // AUDIT: Un export sur une période restreinte ne doit pas inclure
    // des encaissements hors de cette période. C'est une exigence de
    // minimisation des données (RGPD + confiance inspecteur).
    await recordEncaissement(h.workspace, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    // Export a future window that cannot contain our "now" record.
    const futureFrom = new Date(Date.UTC(2099, 0, 1));
    const futureTo = new Date(Date.UTC(2099, 11, 31));
    const result = await exportPeriod(h.workspace, futureFrom, futureTo, 'json');

    // No encaissements in the future window.
    expect(result.data.encaissements.length).toBe(0);
    expect(result.data.corrections.length).toBe(0);

    // But the export is still structurally valid.
    const check = await verifyExportIntegrity(result);
    expect(check.valid).toBe(true);
  });
});
