/**
 * Tests de preuve — Clôtures.
 *
 * Cf. COMPLIANCE.md § 4 (Archivage).
 *
 * SCOPE: Milestone 2.
 *
 * Couvre :
 *  - Agrégation journalière (encaissements + corrections, ventilation mode/TVA).
 *  - Idempotence (refus de re-clôturer une période déjà scellée).
 *  - Chaînage cryptographique entre clôtures successives du même type.
 *  - Signature Ed25519 vérifiable hors du processus (verifySignature).
 *  - Inaltérabilité post-scellement (chain hash + integrity check).
 *  - Cumul perpétuel (Grand Total) à travers les clôtures journalières.
 *  - Refus de clôture mensuelle/annuelle si jours/mois manquants.
 *  - Agrégation mensuelle / annuelle correcte.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  closeDay,
  closeMonth,
  closeYear,
  getMonthClosure,
} from '../src/closures.js';
import { recordEncaissement } from '../src/encaissement.js';
import { recordCorrection } from '../src/corrections.js';
import { canonicalize, verifySignature } from '../src/crypto.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { freshHarness, type Harness } from './_helpers.js';

describe('Clôtures périodiques', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  describe('Clôture journalière (Z journalier)', () => {
    it('agrège correctement les encaissements de la journée', async () => {
      await recordEncaissement(h.workspace, {
        montantCentimes: 1000,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
      await recordEncaissement(h.workspace, {
        montantCentimes: 500,
        devise: 'EUR',
        mode: 'especes',
        tvaCode: 'TVA20',
      });
      await recordEncaissement(h.workspace, {
        montantCentimes: 2000,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA10',
      });

      const closure = await closeDay(h.workspace, new Date());
      expect(closure.aggregate.caTotalCentimes).toBe(3500);
      expect(closure.aggregate.nbTransactions).toBe(3);
      expect(closure.aggregate.parMode).toEqual({ cb: 3000, especes: 500 });
      // Default ventilation (no rates passed): ht = ttc, tva = 0.
      expect(closure.aggregate.parTva).toEqual({
        TVA20: { ht: 1500, tva: 0, ttc: 1500 },
        TVA10: { ht: 2000, tva: 0, ttc: 2000 },
      });
      expect(closure.aggregate.devise).toBe('EUR');
      expect(closure.aggregate.premiereSequence).toBeGreaterThan(0);
      expect(closure.aggregate.derniereSequence).toBeGreaterThanOrEqual(
        closure.aggregate.premiereSequence,
      );
    });

    it('inclut les corrections de la journée dans le total net', async () => {
      const orig = await recordEncaissement(h.workspace, {
        montantCentimes: 1000,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
      await recordCorrection(h.workspace, {
        originalId: orig._id,
        montantCentimes: -300,
        devise: 'EUR',
        type: 'remboursement_partiel',
        reason: 'Service partiel',
      });

      const closure = await closeDay(h.workspace, new Date());
      expect(closure.aggregate.caTotalCentimes).toBe(700);
      // Correction inherits original's mode/TVA.
      expect(closure.aggregate.parMode).toEqual({ cb: 700 });
      expect(closure.aggregate.parTva).toEqual({
        TVA20: { ht: 700, tva: 0, ttc: 700 },
      });
      // Corrections do not increment nbTransactions.
      expect(closure.aggregate.nbTransactions).toBe(1);
    });

    it("ne peut pas clôturer une date déjà clôturée", async () => {
      const today = new Date();
      await closeDay(h.workspace, today);
      await expect(closeDay(h.workspace, today)).rejects.toThrow(/already closed/);
    });

    it('chaîne correctement avec la clôture précédente', async () => {
      const day1 = new Date(Date.UTC(2026, 3, 24));
      const day2 = new Date(Date.UTC(2026, 3, 25));

      const c1 = await closeDay(h.workspace, day1);
      const c2 = await closeDay(h.workspace, day2);

      // Chain linkage in the closure-day stream is enforced by eventStore.
      expect(c1.previousHash).toBe('0'.repeat(64));
      expect(c2.previousHash).toBe(c1.hash);
    });

    it('est signée avec la clé privée éditeur', async () => {
      const closure = await closeDay(h.workspace, new Date());

      expect(closure.signature.length).toBeGreaterThan(0);
      expect(closure.signingKeyVersion).toBe(h.signer.getKeyVersion());

      // Reconstruct the exact signing skeleton (payload minus signature/signingKeyVersion).
      const skeleton = {
        type: closure.type,
        periodStart: closure.periodStart,
        periodEnd: closure.periodEnd,
        closedAt: closure.closedAt,
        aggregate: closure.aggregate,
        schemaVersion: closure.schemaVersion,
        chainHeads: closure.chainHeads,
        previousClosureHash: closure.previousClosureHash,
      };
      const ok = await verifySignature(
        canonicalize(skeleton),
        closure.signature,
        closure.signingKeyVersion,
      );
      expect(ok).toBe(true);

      // Tampering must invalidate.
      const tamperedSkeleton = { ...skeleton, aggregate: { ...skeleton.aggregate, caTotalCentimes: 999999 } };
      const bad = await verifySignature(
        canonicalize(tamperedSkeleton),
        closure.signature,
        closure.signingKeyVersion,
      );
      expect(bad).toBe(false);
    });

    it('est immutable une fois scellée', async () => {
      await recordEncaissement(h.workspace, {
        montantCentimes: 1234,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
      const closure = await closeDay(h.workspace, new Date());

      void closure;
      // Tamper the stored closure-day record (sequence 1, the only closure).
      // Bypasses inalterability to prove verifyChainIntegrity catches it
      // (real Postgres also blocks at trigger level — cf. chainage.postgres.test).
      h.storage._forceTamper(h.workspace, 'closure-day', 1, (row) => {
        const payload = row['payload'] as { aggregate: { caTotalCentimes: number } };
        payload.aggregate.caTotalCentimes = 0;
      });

      const report = await verifyChainIntegrity(h.workspace);
      expect(report.valid).toBe(false);
      const stream = report.streams.find((s) => s.name === 'closure-day');
      expect(stream?.valid).toBe(false);
    });

    it('cumule correctement le Grand Total Perpétuel', async () => {
      // recordedAt is set to "now" by the eventStore, so we close today's UTC
      // date to capture the event. Tomorrow's window will be empty — perfect to
      // prove cumul carries forward across closures.
      const today = new Date();
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

      await recordEncaissement(h.workspace, {
        montantCentimes: 1000,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
      const c1 = await closeDay(h.workspace, today);
      expect(c1.aggregate.caTotalCentimes).toBe(1000);
      expect(c1.aggregate.cumulPerpetuel).toBe(1000);

      // Day 2: no new encaissements after midnight in the test, so day2's window
      // contains zero rows. Cumul carries forward.
      const c2 = await closeDay(h.workspace, tomorrow);
      expect(c2.aggregate.caTotalCentimes).toBe(0);
      expect(c2.aggregate.cumulPerpetuel).toBe(1000);
      expect(c2.aggregate.nbTransactions).toBe(0);
      expect(c2.aggregate.premiereSequence).toBe(0);
      expect(c2.aggregate.derniereSequence).toBe(0);
    });
  });

  describe('Clôture mensuelle', () => {
    it('refuse de clôturer un mois si toutes les journées ne sont pas clôturées', async () => {
      // Close only a couple of days of February 2027 (28 days).
      await closeDay(h.workspace, new Date(Date.UTC(2027, 1, 1)));
      await closeDay(h.workspace, new Date(Date.UTC(2027, 1, 2)));

      await expect(closeMonth(h.workspace, 2027, 2)).rejects.toThrow(
        /missing day closures/,
      );
    });

    it('agrège les clôtures journalières du mois', async () => {
      // recordedAt is server-clock; we can't rewind it without faking time.
      // Instead test the aggregation MECHANICS over a fully-closed empty month
      // (Feb 2027 = 28 days). Non-zero aggregation per day is exercised in the
      // day-level tests above.
      for (let d = 1; d <= 28; d++) {
        await closeDay(h.workspace, new Date(Date.UTC(2027, 1, d)));
      }

      const month = await closeMonth(h.workspace, 2027, 2);
      expect(month.type).toBe('month');
      expect(month.periodStart.startsWith('2027-02-01')).toBe(true);
      expect(month.periodEnd.startsWith('2027-02-28')).toBe(true);
      expect(month.aggregate.caTotalCentimes).toBe(0);
      expect(month.aggregate.nbTransactions).toBe(0);
      // Cumul perpétuel of month closure = last day's cumul (0 here).
      expect(month.aggregate.cumulPerpetuel).toBe(0);

      // Idempotency on month closure.
      await expect(closeMonth(h.workspace, 2027, 2)).rejects.toThrow(/already closed/);
      // Lookup by year/month works.
      const found = await getMonthClosure(h.workspace, 2027, 2);
      expect(found?._id).toBe(month._id);
    });
  });

  describe('Clôture annuelle', () => {
    it("refuse de clôturer une année si tous les mois ne sont pas clôturés", async () => {
      // Close only Jan 2027 (all 31 days + month closure).
      for (let d = 1; d <= 31; d++) {
        await closeDay(h.workspace, new Date(Date.UTC(2027, 0, d)));
      }
      await closeMonth(h.workspace, 2027, 1);

      await expect(closeYear(h.workspace, 2027)).rejects.toThrow(/missing month closures/);
    });

    it("agrège les clôtures mensuelles de l'année", async () => {
      // Close every day of every month of 2027 (empty closures), then every month, then year.
      // 365 days + 12 months + 1 year — runs in <1s on InMemoryStorage.
      for (let m = 1; m <= 12; m++) {
        const lastDay = new Date(Date.UTC(2027, m, 0)).getUTCDate();
        for (let d = 1; d <= lastDay; d++) {
          await closeDay(h.workspace, new Date(Date.UTC(2027, m - 1, d)));
        }
        await closeMonth(h.workspace, 2027, m);
      }

      const year = await closeYear(h.workspace, 2027);
      expect(year.type).toBe('year');
      expect(year.periodStart.startsWith('2027-01-01')).toBe(true);
      expect(year.periodEnd.startsWith('2027-12-31')).toBe(true);
      expect(year.aggregate.caTotalCentimes).toBe(0);
      expect(year.aggregate.nbTransactions).toBe(0);

      // Year closure is itself signed and chained.
      expect(year.signature.length).toBeGreaterThan(0);
      expect(year.previousHash).toBe('0'.repeat(64));

      // And the chain across all five streams stays valid.
      const integrity = await verifyChainIntegrity(h.workspace);
      expect(integrity.valid).toBe(true);
    });
  });
});
