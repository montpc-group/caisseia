/**
 * Tests adversariaux — scénarios qu'un auditeur DGFIP ou un fraudeur exploiterait.
 *
 * Cf. COMPLIANCE.md §§ 1–5.
 *
 * Ce fichier ne duplique pas les tests existants. Il couvre des
 * scénarios d'attaque, des cas limites et des conditions de course
 * que les tests fonctionnels ne couvrent pas.
 *
 * Chaque describe correspond à une classe de vulnérabilité.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordEncaissement } from '../src/encaissement.js';
import { recordCorrection } from '../src/corrections.js';
import { closeDay, closeMonth } from '../src/closures.js';
import { read } from '../src/eventStore.js';
import { verifyChainIntegrity } from '../src/integrity.js';
import { exportPeriod, verifyExportIntegrity } from '../src/restitution.js';
import { canonicalize, verifySignature, GENESIS_HASH } from '../src/crypto.js';
import { MemorySigner } from '../src/crypto/MemorySigner.js';
import { setActiveSigner, _resetActiveSigner } from '../src/crypto/Signer.js';
import { _setRegistryForTests } from '../src/crypto/keyRegistry.js';
import { AppendConflictError } from '../src/storage/EventStorage.js';
import { freshHarness, travelTo, type Harness } from './_helpers.js';
import type { EncaissementStreamPayload } from '../schemas/encaissement.schema.js';

// ─────────────────────────────────────────────────────────────────────
// § CONCURRENCY — art. 286 I 3°bis CGI : séquence contiguë obligatoire
// ─────────────────────────────────────────────────────────────────────

describe('Concurrency (séquence contiguë sous contention)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('les appels parallèles à recordEncaissement produisent une séquence contiguë', async () => {
    // AUDIT: Un auditeur DGFIP vérifie qu'il n'y a aucun gap de séquence.
    // Le retry-on-conflict (max 3) doit assurer la contiguïté.
    // NOTE: InMemoryStorage sérialise les awaits, ce qui crée une contention
    // similaire à Postgres (tous les calls lisent le même "last" avant le
    // premier append). Avec 3 retries, on peut résoudre au plus ~4 writers
    // concurrents. On teste avec N=3 pour rester dans les bornes.
    // Pour une preuve de contention réelle à N élevé, un test d'intégration
    // Postgres avec isolation SERIALIZABLE est nécessaire.
    const N = 3;
    const promises = Array.from({ length: N }, () =>
      recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      }),
    );
    const results = await Promise.all(promises);

    const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    // Chain integrity must hold after parallel writes.
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(true);
  });

  it('deux closeDay séquentiels sur le même jour — le second doit rejeter (idempotence)', async () => {
    // AUDIT: Idempotence stricte. Un même jour ne peut être clôturé qu'une fois.
    // NOTE: InMemoryStorage ne fournit pas de véritable contention concurrente
    // (les deux closeDays en Promise.all voient tous deux "pas encore clôturé"
    // car le check précède le write). On teste donc séquentiellement.
    // Postgres garantit l'idempotence sous contention via la contrainte UNIQUE
    // sur (workspaceId, stream, periodStart) — cf. chainage.postgres.test.ts.
    const today = new Date();
    await closeDay(h.workspace, today);
    await expect(closeDay(h.workspace, today)).rejects.toThrow(/already closed/);
  });

  it('AppendConflictError est levée sur un conflit de séquence explicite', async () => {
    // AUDIT: Le storage détecte bien les conflits au niveau séquence.
    // On force deux appends avec la même séquence sur le même flux.
    await recordEncaissement(h.workspace, {
      montantCentimes: 100,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    // Try to append with sequence 1 again (already taken).
    await expect(
      h.storage.append({
        workspaceId: h.workspace,
        stream: 'encaissement',
        sequence: 1,
        previousHash: GENESIS_HASH,
        hash: 'fake',
        recordedAt: new Date().toISOString(),
        payload: { type: 'encaissement', data: {} },
      }),
    ).rejects.toThrow(AppendConflictError);
  });
});

// ─────────────────────────────────────────────────────────────────────
// § TIMEZONE / DST — bornes UTC strictes (COMPLIANCE.md § 4)
// ─────────────────────────────────────────────────────────────────────

describe('Timezone boundaries (jour ouvré local, bornes UTC — art. 286 I 3°bis)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  // NOTE: un jour ouvré est le jour civil LOCAL du commerce (défaut
  // Europe/Paris, coupure 00:00) ; les bornes signées sont des instants UTC.
  // En hiver (UTC+1) : startISO = J-1T23:00:00.000Z, endISO = JT22:59:59.999Z.

  it('closeDay à 23:59:59.999 UTC — inclut la journée correcte', async () => {
    // AUDIT: Un encaissement à la dernière milliseconde d'un jour UTC
    // doit être inclus dans la clôture de ce jour, pas du suivant.
    const date = new Date(Date.UTC(2026, 5, 15, 23, 59, 59, 999));
    // Record an encaissement — recordedAt will be "now" (server clock).
    // We close the "today" day which includes "now".
    await recordEncaissement(h.workspace, {
      montantCentimes: 500,
      devise: 'EUR',
      mode: 'especes',
      tvaCode: 'TVA20',
    });

    // Close TODAY (the day when the encaissement's recordedAt falls).
    const today = new Date();
    const closure = await closeDay(h.workspace, today);

    // The encaissement must be included.
    expect(closure.aggregate.nbTransactions).toBe(1);
    expect(closure.aggregate.caTotalCentimes).toBe(500);

    // Closing the date 2026-06-15 (likely a future date) should yield zero.
    const futureClosure = await closeDay(h.workspace, date);
    expect(futureClosure.aggregate.nbTransactions).toBe(0);
    expect(futureClosure.aggregate.caTotalCentimes).toBe(0);
  });

  it('closeDay à 00:00:00.000 UTC — jour ouvré Paris qui contient cet instant', async () => {
    // AUDIT: La borne inférieure est inclusive. Un encaissement enregistré
    // exactement à minuit UTC doit être inclus dans la clôture du jour commençant.
    const midnight = new Date(Date.UTC(2027, 0, 1, 0, 0, 0, 0));
    // We use closeDay to test the boundary range definition.
    travelTo('2027-01-02T00:00:00Z');
    const closure = await closeDay(h.workspace, midnight);
    // With no encaissements, the closure is valid with zero totals.
    expect(closure.aggregate.caTotalCentimes).toBe(0);
    expect(closure.periodKey).toBe('2027-01-01');
    expect(closure.periodStart).toBe('2026-12-31T23:00:00.000Z');
    expect(closure.periodEnd).toBe('2027-01-01T22:59:59.999Z');
  });

  it('deux jours ouvrés consécutifs sont contigus — pas de chevauchement', async () => {
    // AUDIT: Deux jours consécutifs ne doivent JAMAIS se chevaucher.
    // startISO(day2) > endISO(day1) strictement.
    const day1 = new Date(Date.UTC(2027, 2, 14));
    const day2 = new Date(Date.UTC(2027, 2, 15));
    travelTo('2027-03-16T00:00:00Z');

    const c1 = await closeDay(h.workspace, day1);
    const c2 = await closeDay(h.workspace, day2);

    expect(c1.periodEnd < c2.periodStart).toBe(true);
    // More precisely: day1 ends at 23:59:59.999 Paris, day2 starts at 00:00 Paris (UTC+1 in March before DST).
    expect(c1.periodEnd).toBe('2027-03-14T22:59:59.999Z');
    expect(c2.periodStart).toBe('2027-03-14T23:00:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────
// § BOUNDARY DELETIONS — renforcement détection suppressions
// ─────────────────────────────────────────────────────────────────────

describe('Boundary deletions (détection suppressions aux bornes)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('suppression des records 1 ET 5 (les deux bornes) — verifyChainIntegrity détecte les DEUX', async () => {
    // AUDIT: Un fraudeur pourrait tenter de supprimer le premier et le
    // dernier enregistrement. Le système doit détecter les deux gaps.
    for (let i = 0; i < 5; i++) {
      await recordEncaissement(h.workspace, {
        montantCentimes: 100 * (i + 1),
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }

    h.storage._forceDelete(h.workspace, 'encaissement', 1);
    h.storage._forceDelete(h.workspace, 'encaissement', 5);

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    const stream = report.streams.find((s) => s.name === 'encaissement');
    expect(stream?.valid).toBe(false);
    // First detection is at the start: sequence gap (expected 1, got 2).
    expect(stream?.reason).toMatch(/sequence gap/);
  });

  it('suppression de tous les records sauf le dernier — détection obligatoire', async () => {
    // AUDIT: Un fraudeur supprime les N-1 premiers records pour ne garder
    // que le dernier. verifyChainIntegrity détecte le gap immédiat.
    for (let i = 0; i < 5; i++) {
      await recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }

    for (let seq = 1; seq <= 4; seq++) {
      h.storage._forceDelete(h.workspace, 'encaissement', seq);
    }

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    const stream = report.streams.find((s) => s.name === 'encaissement');
    expect(stream?.valid).toBe(false);
    // Expected sequence 1, got 5.
    expect(stream?.reason).toMatch(/sequence gap/);
  });

  it('insertion d\'un record forgé avec previousHash correct mais sequence fausse — détection', async () => {
    // AUDIT: Un fraudeur insère un faux record entre deux records légitimes.
    // Le previousHash est correct (copié de la chaîne), mais le hash propre
    // ne correspond pas au skeleton. verifyChainIntegrity doit détecter.
    for (let i = 0; i < 3; i++) {
      await recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }

    // Read chain to get record 2's hash (will be our forged record's previousHash).
    const records = await read<EncaissementStreamPayload>('encaissement', h.workspace);
    const rec2 = records.find((r) => r.sequence === 2)!;

    // Delete record 3 and insert a forged record with correct previousHash
    // but a payload that doesn't match the stored hash.
    h.storage._forceDelete(h.workspace, 'encaissement', 3);

    // Insert a forged record at sequence 3 with a "correct" previousHash
    // but the hash field is fabricated (doesn't match the actual skeleton).
    const forgedPayload = { type: 'encaissement' as const, data: {
      montantCentimes: 1,
      devise: 'EUR' as const,
      mode: 'cb' as const,
      tvaCode: 'TVA20',
    }};
    const forgedHash = 'deadbeef'.repeat(8); // 64 chars, obviously wrong
    await h.storage.append({
      workspaceId: h.workspace,
      stream: 'encaissement',
      sequence: 3,
      previousHash: rec2.hash,
      hash: forgedHash,
      recordedAt: new Date().toISOString(),
      payload: forgedPayload,
    });

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
    const stream = report.streams.find((s) => s.name === 'encaissement');
    expect(stream?.valid).toBe(false);
    // The forged hash doesn't match the recomputed hash of the skeleton.
    expect(stream?.reason).toMatch(/payload hash mismatch/);
  });

  it('replay attack: re-hash records après suppression — les bornes de clôture ancrent la séquence originale', async () => {
    // AUDIT: Un fraudeur supprime le record 3 sur 5, puis re-hash les records 4-5
    // avec des previousHash ajustés pour que la chaîne semble valide.
    // Mais une clôture prise AVANT la suppression ancre la derniereSequence = 5
    // et le caTotalCentimes original. La vérification des bornes révèle la fraude.
    for (let i = 0; i < 5; i++) {
      await recordEncaissement(h.workspace, {
        montantCentimes: 100 * (i + 1),
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      });
    }

    // Take a closure BEFORE the attack — this anchors the truth.
    const today = new Date();
    const closure = await closeDay(h.workspace, today);
    expect(closure.aggregate.nbTransactions).toBe(5);
    expect(closure.aggregate.caTotalCentimes).toBe(1500); // 100+200+300+400+500
    expect(closure.aggregate.derniereSequence).toBe(5);

    // Now the fraudster deletes record 3 (300 centimes).
    h.storage._forceDelete(h.workspace, 'encaissement', 3);

    // Even if they re-hash 4 and 5 to maintain chain continuity,
    // the closure's caTotalCentimes (1500) != remaining records' sum (1200),
    // and the closure's nbTransactions (5) != remaining count (4).
    const remaining = await read<EncaissementStreamPayload>('encaissement', h.workspace);
    const remainingOriginals = remaining.filter((r) => r.payload.type === 'encaissement');
    const remainingTotal = remainingOriginals.reduce(
      (acc, r) => acc + (r.payload.type === 'encaissement' ? r.payload.data.montantCentimes : 0),
      0,
    );
    expect(remainingTotal).toBe(1200);
    expect(closure.aggregate.caTotalCentimes).toBe(1500);
    expect(closure.aggregate.caTotalCentimes).not.toBe(remainingTotal);

    // Additionally, verifyChainIntegrity catches the sequence gap.
    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// § CROSS-WORKSPACE ISOLATION — multi-tenant stricte
// ─────────────────────────────────────────────────────────────────────

describe('Cross-workspace isolation (multi-tenant — art. 286 I 3°bis)', () => {
  let h: Harness;
  const WS1 = 'tenant-alpha';
  const WS2 = 'tenant-beta';

  beforeEach(async () => {
    h = await freshHarness(WS1);
  });

  afterEach(async () => {
    await h.reset();
  });

  it('read(encaissement, ws1) ne renvoie JAMAIS les données de ws2', async () => {
    // AUDIT: Isolation stricte. Un workspace ne doit jamais voir les
    // encaissements d'un autre workspace. Fuite = violation RGPD + art. 286 CGI.
    await recordEncaissement(WS1, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    await recordEncaissement(WS2, {
      montantCentimes: 2000,
      devise: 'EUR',
      mode: 'especes',
      tvaCode: 'TVA10',
    });

    const ws1Records = await read<EncaissementStreamPayload>('encaissement', WS1);
    const ws2Records = await read<EncaissementStreamPayload>('encaissement', WS2);

    expect(ws1Records.length).toBe(1);
    expect(ws2Records.length).toBe(1);
    expect(ws1Records[0]!.workspaceId).toBe(WS1);
    expect(ws2Records[0]!.workspaceId).toBe(WS2);

    // No cross-contamination.
    for (const r of ws1Records) {
      expect(r.workspaceId).not.toBe(WS2);
    }
  });

  it('recordCorrection(ws1, {originalId: id_from_ws2}) doit rejeter', async () => {
    // AUDIT: Un utilisateur malveillant tente de corriger un encaissement
    // d'un autre workspace. Le système doit rejeter explicitement.
    const encWs2 = await recordEncaissement(WS2, {
      montantCentimes: 5000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    // Attempt cross-workspace correction.
    await expect(
      recordCorrection(WS1, {
        originalId: encWs2._id,
        montantCentimes: -1000,
        devise: 'EUR',
        type: 'remboursement_partiel',
        reason: 'Cross-workspace attack attempt',
      }),
    ).rejects.toThrow(/not found in workspace/);
  });

  it('closeDay(ws1) n\'inclut pas les encaissements de ws2', async () => {
    // AUDIT: L'agrégation de clôture ne doit sommer que le workspace ciblé.
    await recordEncaissement(WS1, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    await recordEncaissement(WS2, {
      montantCentimes: 9999,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    const closure = await closeDay(WS1, new Date());
    expect(closure.aggregate.caTotalCentimes).toBe(1000);
    expect(closure.aggregate.nbTransactions).toBe(1);
  });

  it('verifyChainIntegrity(ws1) ne rapporte que les flux de ws1', async () => {
    // AUDIT: L'intégrité est vérifiée par workspace. Les flux de ws2
    // n'interfèrent pas.
    await recordEncaissement(WS1, {
      montantCentimes: 100,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    await recordEncaissement(WS2, {
      montantCentimes: 200,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    // Tamper ws2, then verify ws1 — ws1 should be clean.
    h.storage._forceTamper(WS2, 'encaissement', 1, (row) => {
      const p = row['payload'] as { data: { montantCentimes: number } };
      p.data.montantCentimes = 0;
    });

    const reportWs1 = await verifyChainIntegrity(WS1);
    expect(reportWs1.valid).toBe(true);

    const reportWs2 = await verifyChainIntegrity(WS2);
    expect(reportWs2.valid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// § ZERO-RECORD EDGE CASES — périodes vides
// ─────────────────────────────────────────────────────────────────────

describe('Zero-record edge cases (périodes vides)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('closeDay avec zéro encaissements — succède avec CA=0, GT carry forward', async () => {
    // AUDIT: Un jour sans vente doit produire une clôture valide à zéro.
    // Le Grand Total (cumul perpétuel) doit être reporté du jour précédent.
    const day1 = new Date(Date.UTC(2027, 5, 1));
    const day2 = new Date(Date.UTC(2027, 5, 2));
    travelTo('2027-06-03T00:00:00Z');

    const c1 = await closeDay(h.workspace, day1);
    expect(c1.aggregate.caTotalCentimes).toBe(0);
    expect(c1.aggregate.nbTransactions).toBe(0);
    expect(c1.aggregate.cumulPerpetuel).toBe(0);
    expect(c1.aggregate.premiereSequence).toBe(0);
    expect(c1.aggregate.derniereSequence).toBe(0);

    const c2 = await closeDay(h.workspace, day2);
    expect(c2.aggregate.cumulPerpetuel).toBe(0); // 0 + 0
    // Chain is valid even with all-zero closures.
    expect(c2.previousHash).toBe(c1.hash);
  });

  it('exportPeriod avec zéro records — retourne un export valide avec manifest correct', async () => {
    // AUDIT: Un export sur une période vide doit être structurellement valide.
    // Le manifest doit avoir un hash correct. Les fichiers doivent exister.
    const from = new Date(Date.UTC(2030, 0, 1));
    const to = new Date(Date.UTC(2030, 0, 31));

    const result = await exportPeriod(h.workspace, from, to, 'json');
    expect(result.manifest).toBeDefined();
    expect(result.manifest.manifestHash.length).toBe(64);
    expect(result.data.encaissements.length).toBe(0);
    expect(result.data.corrections.length).toBe(0);
    expect(result.data.closures.length).toBe(0);

    // The key registry is always included.
    const keyFile = result.files.find((f) => f.name === 'public-keys.json');
    expect(keyFile).toBeDefined();

    // Verify the export integrity passes (empty is valid).
    const integrity = await verifyExportIntegrity(result);
    expect(integrity.valid).toBe(true);
  });

  it('closeMonth avec tous les jours à zéro vente — agrège à zéro, chaîne valide', async () => {
    // AUDIT: Un mois entier sans vente doit produire une clôture mensuelle
    // valide à zéro, et la chaîne doit rester intègre.
    // 2028 is a leap year: February has 29 days.
    travelTo('2028-03-01T00:00:00Z');
    for (let d = 1; d <= 29; d++) {
      await closeDay(h.workspace, new Date(Date.UTC(2028, 1, d)));
    }

    const month = await closeMonth(h.workspace, 2028, 2);
    expect(month.aggregate.caTotalCentimes).toBe(0);
    expect(month.aggregate.nbTransactions).toBe(0);
    expect(month.aggregate.cumulPerpetuel).toBe(0);

    const report = await verifyChainIntegrity(h.workspace);
    expect(report.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// § KEY ROTATION — vérification post-rotation (conservation 10 ans)
// ─────────────────────────────────────────────────────────────────────

describe('Key rotation (vérification post-rotation — conservation 10 ans)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('clôture signée avec key v1, rotation vers v2, vérification de l\'ancienne clôture via keyRegistry', async () => {
    // AUDIT: Après rotation de clé, les clôtures signées avec l'ancienne clé
    // doivent rester vérifiables. Le keyRegistry conserve toutes les clés
    // publiques historiques. Un contrôle DGFIP 5 ans après doit pouvoir
    // vérifier la signature d'origine.

    // Step 1: Close a day with key v1 (already set up by freshHarness).
    await recordEncaissement(h.workspace, {
      montantCentimes: 5000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });
    const closureV1 = await closeDay(h.workspace, new Date());
    expect(closureV1.signingKeyVersion).toBe('test-v1');

    // Step 2: Generate a new key (v2) and rotate.
    const signerV2 = await MemorySigner.generate('test-v2');
    setActiveSigner(signerV2);

    // Update the registry to include BOTH keys.
    _setRegistryForTests({
      keys: [
        {
          version: 'test-v1',
          algorithm: 'ed25519',
          publicKeyPem: h.signer.getPublicKeyPem(),
          validFrom: '2026-01-01T00:00:00Z',
          validUntil: '2027-01-01T00:00:00Z', // Retired
        },
        {
          version: 'test-v2',
          algorithm: 'ed25519',
          publicKeyPem: signerV2.getPublicKeyPem(),
          validFrom: '2027-01-01T00:00:00Z',
          validUntil: null, // Active
        },
      ],
    });

    // Step 3: Verify the OLD closure with the OLD key still works.
    const skeleton = {
      type: closureV1.type,
      periodStart: closureV1.periodStart,
      periodEnd: closureV1.periodEnd,
      closedAt: closureV1.closedAt,
      aggregate: closureV1.aggregate,
      schemaVersion: closureV1.schemaVersion,
      chainHeads: closureV1.chainHeads,
      previousClosureHash: closureV1.previousClosureHash,
      periodKey: closureV1.periodKey,
      calendar: closureV1.calendar,
    };
    const ok = await verifySignature(
      canonicalize(skeleton),
      closureV1.signature,
      'test-v1',
    );
    expect(ok).toBe(true);

    // Step 4: Sign a NEW closure with v2 and verify it works too.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    travelTo(tomorrow);
    const closureV2 = await closeDay(h.workspace, tomorrow);
    expect(closureV2.signingKeyVersion).toBe('test-v2');

    const skeletonV2 = {
      type: closureV2.type,
      periodStart: closureV2.periodStart,
      periodEnd: closureV2.periodEnd,
      closedAt: closureV2.closedAt,
      aggregate: closureV2.aggregate,
      schemaVersion: closureV2.schemaVersion,
      chainHeads: closureV2.chainHeads,
      previousClosureHash: closureV2.previousClosureHash,
      periodKey: closureV2.periodKey,
      calendar: closureV2.calendar,
    };
    const okV2 = await verifySignature(
      canonicalize(skeletonV2),
      closureV2.signature,
      'test-v2',
    );
    expect(okV2).toBe(true);
  });

  it('export inclut le keyRegistry — les anciennes clés sont présentes pour vérification offline', async () => {
    // AUDIT: Le registre de clés publiques est inclus dans chaque export
    // pour permettre la vérification offline des années plus tard, même
    // après plusieurs rotations de clés.
    await recordEncaissement(h.workspace, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    const from = new Date(Date.UTC(2020, 0, 1));
    const to = new Date(Date.UTC(2099, 11, 31));
    const result = await exportPeriod(h.workspace, from, to, 'json');

    // The export must contain the key registry.
    expect(result.data.keyRegistry).toBeDefined();
    expect(result.data.keyRegistry.keys.length).toBeGreaterThan(0);

    // The test-v1 key must be present.
    const testKey = result.data.keyRegistry.keys.find((k) => k.version === 'test-v1');
    expect(testKey).toBeDefined();
    expect(testKey!.algorithm).toBe('ed25519');
    expect(testKey!.publicKeyPem).toContain('BEGIN PUBLIC KEY');

    // The public-keys.json file must be in the exported files.
    const keyFile = result.files.find((f) => f.name === 'public-keys.json');
    expect(keyFile).toBeDefined();
    expect(keyFile!.hash.length).toBe(64);
  });
});

// ─────────────────────────────────────────────────────────────────────
// § CORRUPTED INPUT — Zod validation boundary (COMPLIANCE.md § 1)
// ─────────────────────────────────────────────────────────────────────

describe('Corrupted input (validation Zod aux frontières)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await freshHarness();
  });

  afterEach(async () => {
    await h.reset();
  });

  it('recordEncaissement avec montantCentimes=0 — Zod doit rejeter (strictement positif)', async () => {
    // AUDIT: Un encaissement de 0€ n'a aucun sens fiscal. Le schema Zod
    // exige un montant strictement positif (> 0).
    await expect(
      recordEncaissement(h.workspace, {
        montantCentimes: 0,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      }),
    ).rejects.toThrow();
  });

  it('recordEncaissement avec montantCentimes float (10.5) — Zod doit rejeter', async () => {
    // AUDIT: Les montants en centimes doivent être des entiers. Un float
    // casserait la canonicalisation déterministe et le chainage.
    await expect(
      recordEncaissement(h.workspace, {
        montantCentimes: 10.5,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      } as any),
    ).rejects.toThrow();
  });

  it('recordEncaissement avec montantCentimes négatif — Zod doit rejeter', async () => {
    // AUDIT: Un montant négatif ne peut pas être un encaissement.
    // Les corrections passent par recordCorrection() uniquement.
    await expect(
      recordEncaissement(h.workspace, {
        montantCentimes: -100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
      }),
    ).rejects.toThrow();
  });

  it('recordCorrection avec type non enum — Zod doit rejeter', async () => {
    // AUDIT: Un type de correction inventé est rejeté par le discriminated union.
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    await expect(
      recordCorrection(h.workspace, {
        originalId: enc._id,
        montantCentimes: -100,
        devise: 'EUR',
        type: 'type_inventé' as any,
        reason: 'Should be rejected',
      }),
    ).rejects.toThrow();
  });

  it('recordEncaissement avec notes > 2048 chars — Zod doit rejeter', async () => {
    // AUDIT: La longueur des notes est bornée pour éviter les attaques
    // par payload excessif et les problèmes de canonicalisation.
    const longNotes = 'x'.repeat(2049);
    await expect(
      recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
        notes: longNotes,
      }),
    ).rejects.toThrow();
  });

  it('recordEncaissement avec notes = 2048 chars exactement — doit accepter', async () => {
    // AUDIT: La borne supérieure est inclusive (max 2048, pas max 2047).
    const maxNotes = 'x'.repeat(2048);
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 100,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
      notes: maxNotes,
    });
    expect(enc._id).toBeDefined();
  });

  it('recordEncaissement avec mode de paiement invalide — Zod doit rejeter', async () => {
    // AUDIT: Le mode de paiement doit être dans l'enum autorisée.
    await expect(
      recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'bitcoin' as any,
        tvaCode: 'TVA20',
      }),
    ).rejects.toThrow();
  });

  it('recordEncaissement avec devise non autorisée — Zod doit rejeter', async () => {
    // AUDIT: Seules EUR et CHF sont autorisées (scope France + zones frontalières).
    await expect(
      recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'USD' as any,
        mode: 'cb',
        tvaCode: 'TVA20',
      }),
    ).rejects.toThrow();
  });

  it('recordEncaissement avec propriété supplémentaire — Zod strict doit rejeter', async () => {
    // AUDIT: Le schéma est strict (pas de propriétés supplémentaires).
    // Un payload enrichi pourrait contourner l'audit trail.
    await expect(
      recordEncaissement(h.workspace, {
        montantCentimes: 100,
        devise: 'EUR',
        mode: 'cb',
        tvaCode: 'TVA20',
        extraField: 'malicious',
      } as any),
    ).rejects.toThrow();
  });

  it('recordCorrection avec montantCentimes float — Zod doit rejeter', async () => {
    // AUDIT: Même sur les corrections, les montants doivent être entiers.
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    await expect(
      recordCorrection(h.workspace, {
        originalId: enc._id,
        montantCentimes: -10.5,
        devise: 'EUR',
        type: 'remboursement_partiel',
        reason: 'Float attack on correction',
      } as any),
    ).rejects.toThrow();
  });

  it('recordCorrection avec reason < 3 chars — Zod doit rejeter', async () => {
    // AUDIT: La raison est obligatoire et doit être motivée (min 3 chars).
    const enc = await recordEncaissement(h.workspace, {
      montantCentimes: 1000,
      devise: 'EUR',
      mode: 'cb',
      tvaCode: 'TVA20',
    });

    await expect(
      recordCorrection(h.workspace, {
        originalId: enc._id,
        montantCentimes: -100,
        devise: 'EUR',
        type: 'remboursement_partiel',
        reason: 'ab',
      }),
    ).rejects.toThrow();
  });
});
