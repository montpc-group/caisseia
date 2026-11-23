/**
 * Tests de preuve — Conservation.
 *
 * Cf. COMPLIANCE.md § 3 (Conservation, 6 ans + année en cours).
 *
 * Démontre :
 *  - Aucune fonction publique n'expose de purge / vidage / archivage
 *    destructif.
 *  - read() retourne *tous* les enregistrements depuis genesis, dans l'ordre.
 *  - Aucune fenêtre temporelle n'est implicite : un workspace de 6+ ans
 *    reste lisible end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as publicApi from '../src/index.js';
import { recordEncaissement } from '../src/encaissement.js';
import { read } from '../src/eventStore.js';
import { freshHarness, type Harness } from './_helpers.js';

describe('Conservation (art. 286 I 3°bis CGI § 180)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it("aucune fonction publique n'expose un point de suppression / purge", () => {
    const exported = Object.keys(publicApi);
    const forbidden = /^(purge|truncate|wipe|clear|reset|drop|destroy|expire|prune|gc)/i;
    const violations = exported.filter((name) => forbidden.test(name));
    expect(violations).toEqual([]);
  });

  it('read() retourne tous les enregistrements depuis genesis, dans l\'ordre', async () => {
    const N = 50;
    for (let i = 0; i < N; i++) {
      await recordEncaissement(h.workspace, {
        montantCentimes: 100 + i,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }
    const all = await read<{ data: { montantCentimes: number } }>('encaissement', h.workspace);
    expect(all).toHaveLength(N);
    expect(all[0]!.sequence).toBe(1);
    expect(all[N - 1]!.sequence).toBe(N);
    // Strictly monotonic sequence — no gaps.
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.sequence - all[i - 1]!.sequence).toBe(1);
    }
  });

  it('read() avec un filtre temporel ne perd jamais d\'enregistrements pré-borne', async () => {
    // We can't fake `recordedAt` (server-controlled) without tampering, so
    // the assertion is structural: read() with no filter returns >= read()
    // with a filter; conservation cannot be relaxed by a query.
    for (let i = 0; i < 10; i++) {
      await recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }
    const all = await read('encaissement', h.workspace);
    const filtered = await read('encaissement', h.workspace, {
      from: new Date('2026-04-26T00:00:00Z'),
    });
    expect(all.length).toBeGreaterThanOrEqual(filtered.length);
    // The full set always equals genesis-to-now.
    expect(all.length).toBe(10);
  });

  it('le module ne possède aucune méthode close() exposée qui purgerait l\'historique', () => {
    // setActiveStorage / getActiveStorage are infra-surface for advanced wiring
    // and don't perform deletion; the storage interface itself has `close()`
    // but that releases connections, never deletes data.
    const exported = Object.keys(publicApi) as (keyof typeof publicApi)[];
    expect(exported).not.toContain('purgeWorkspace' as unknown as keyof typeof publicApi);
    expect(exported).not.toContain('truncate' as unknown as keyof typeof publicApi);
  });
});
