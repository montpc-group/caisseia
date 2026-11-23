/**
 * Tests de preuve — Facture (mentions obligatoires + totaux).
 *
 * Cf. schemas/facture.schema.ts et src/fr/facture.ts.
 *
 * Démontre :
 *  - Les totaux HT / TVA-par-taux / TTC sont calculés en centimes entiers,
 *    avec arrondi par taux (pas de dérive d'arrondi par ligne).
 *  - La cohérence régime TVA ↔ lignes est imposée (franchise => 0 TVA ;
 *    assujetti => n° TVA obligatoire).
 *  - Un client particulier ne porte pas de SIREN ; un client pro le porte
 *    (mention 2026).
 *  - La checklist des mentions obligatoires bascule correctement à la date
 *    de référence (réforme facturation électronique 2026).
 */

import { describe, it, expect } from 'vitest';
import {
  computeFactureTotals,
  validateFacture,
  factureChecklist,
  MENTION_FRANCHISE_BASE,
} from '../src/fr/facture.js';
import {
  FactureInputSchema,
  type FactureInputZ,
} from '../schemas/facture.schema.js';

// ─── Fixtures ─────────────────────────────────────────────────────────

const adresse = {
  line1: '12 rue des Lavandes',
  postalCode: '74190',
  city: 'Passy',
  country: 'FR',
};

/** A franchise-en-base detailer invoicing a private customer (the common case). */
function factureFranchiseB2C(overrides: Partial<FactureInputZ> = {}): unknown {
  return {
    numero: 'F-2026-0001',
    issueDate: '2026-05-29',
    vendeur: {
      name: 'Detailing Mont-Blanc',
      siren: '900123456',
      address: adresse,
      regimeTva: 'franchise_base',
    },
    client: {
      type: 'particulier',
      name: 'Jean Dupont',
      address: adresse,
    },
    lignes: [
      {
        description: 'Detailing complet intérieur/extérieur',
        quantity: 1,
        unitPriceHtCentimes: 18000,
        tauxTva: 0,
      },
    ],
    natureOperation: 'prestation_services',
    ...overrides,
  };
}

/** A VAT-liable shop invoicing a business customer. */
function factureAssujettiB2B(overrides: Partial<FactureInputZ> = {}): unknown {
  return {
    numero: 'F-2026-0002',
    issueDate: '2026-05-29',
    vendeur: {
      name: 'MONTPC SASU',
      legalForm: 'SASU',
      shareCapitalCentimes: 100000,
      siren: '993766369',
      address: adresse,
      regimeTva: 'assujetti',
      vatNumber: 'FR12993766369',
    },
    client: {
      type: 'professionnel',
      name: 'Garage Léon SARL',
      address: adresse,
      siren: '812345678',
    },
    lignes: [
      { description: 'Forfait detailing flotte', quantity: 3, unitPriceHtCentimes: 15000, tauxTva: 20 },
      { description: 'Traitement céramique', quantity: 1, unitPriceHtCentimes: 25000, tauxTva: 20 },
    ],
    natureOperation: 'prestation_services',
    conditionsPaiement: {
      dueDate: '2026-06-28',
      latePenaltyRatePct: 10,
      recoveryIndemnityCentimes: 4000,
      escompte: "Pas d'escompte pour paiement anticipé",
    },
    ...overrides,
  };
}

const CTX_2026 = { referenceDate: '2026-05-29' };
const CTX_POST_REFORM = { referenceDate: '2027-09-15' };

// ─── Totals ───────────────────────────────────────────────────────────

describe('computeFactureTotals', () => {
  it('single franchise line: TTC = HT, zéro TVA', () => {
    const f = FactureInputSchema.parse(factureFranchiseB2C());
    const t = computeFactureTotals(f);
    expect(t.totalHtCentimes).toBe(18000);
    expect(t.totalTvaCentimes).toBe(0);
    expect(t.totalTtcCentimes).toBe(18000);
    expect(t.parTaux).toEqual([{ tauxTva: 0, baseHtCentimes: 18000, tvaCentimes: 0 }]);
  });

  it('multi-line at 20%: base et TVA agrégées par taux', () => {
    const f = FactureInputSchema.parse(factureAssujettiB2B());
    const t = computeFactureTotals(f);
    // 3*15000 + 1*25000 = 70000 HT @ 20% => 14000 TVA => 84000 TTC
    expect(t.totalHtCentimes).toBe(70000);
    expect(t.totalTvaCentimes).toBe(14000);
    expect(t.totalTtcCentimes).toBe(84000);
    expect(t.parTaux).toHaveLength(1);
    expect(t.parTaux[0]).toEqual({ tauxTva: 20, baseHtCentimes: 70000, tvaCentimes: 14000 });
  });

  it('mélange de taux: une entrée parTaux par taux, triée', () => {
    const f = FactureInputSchema.parse(
      factureAssujettiB2B({
        lignes: [
          { description: 'Service', quantity: 1, unitPriceHtCentimes: 10000, tauxTva: 20 },
          { description: 'Produit réduit', quantity: 1, unitPriceHtCentimes: 10000, tauxTva: 5.5 },
        ],
      }),
    );
    const t = computeFactureTotals(f);
    expect(t.parTaux.map((p) => p.tauxTva)).toEqual([5.5, 20]);
    // 10000 @ 5.5% = 550 ; 10000 @ 20% = 2000
    expect(t.totalTvaCentimes).toBe(2550);
    expect(t.totalTtcCentimes).toBe(22550);
  });

  it('remise et quantité fractionnaire: arrondi au centime', () => {
    const f = FactureInputSchema.parse(
      factureAssujettiB2B({
        lignes: [
          // 1.5 * 3333 = 4999.5 -> 5000 ; remise 500 -> base 4500 @ 20% = 900
          { description: 'Main d\'oeuvre', quantity: 1.5, unitPriceHtCentimes: 3333, tauxTva: 20, remiseCentimes: 500 },
        ],
      }),
    );
    const t = computeFactureTotals(f);
    expect(t.totalHtCentimes).toBe(4500);
    expect(t.totalTvaCentimes).toBe(900);
    expect(t.totalTtcCentimes).toBe(5400);
  });
});

// ─── Schema coherence (structural) ────────────────────────────────────

describe('FactureInputSchema — cohérence structurelle', () => {
  it('accepte une facture franchise B2C valide', () => {
    expect(() => FactureInputSchema.parse(factureFranchiseB2C())).not.toThrow();
  });

  it('rejette une ligne avec TVA sous régime franchise', () => {
    const bad = factureFranchiseB2C({
      lignes: [{ description: 'x', quantity: 1, unitPriceHtCentimes: 1000, tauxTva: 20 }],
    });
    expect(() => FactureInputSchema.parse(bad)).toThrow(/293 B|TVA/);
  });

  it('rejette un assujetti sans numéro de TVA', () => {
    const bad = factureAssujettiB2B({
      vendeur: {
        name: 'X', siren: '993766369', address: adresse, regimeTva: 'assujetti',
      } as FactureInputZ['vendeur'],
    });
    expect(() => FactureInputSchema.parse(bad)).toThrow(/TVA intracommunautaire/);
  });

  it('rejette un client particulier porteur de SIREN', () => {
    const bad = factureFranchiseB2C({
      client: { type: 'particulier', name: 'Jean', address: adresse, siren: '812345678' },
    });
    expect(() => FactureInputSchema.parse(bad)).toThrow(/particulier.*SIREN/);
  });

  it('rejette un montant en flottant (non-centime)', () => {
    const bad = factureFranchiseB2C({
      lignes: [{ description: 'x', quantity: 1, unitPriceHtCentimes: 180.5, tauxTva: 0 }],
    });
    expect(() => FactureInputSchema.parse(bad)).toThrow(/entier/);
  });

  it('rejette les champs inconnus (.strict)', () => {
    const bad = { ...(factureFranchiseB2C() as object), champInconnu: true };
    expect(() => FactureInputSchema.parse(bad)).toThrow();
  });

  it('rejette une facture sans ligne', () => {
    const bad = factureFranchiseB2C({ lignes: [] });
    expect(() => FactureInputSchema.parse(bad)).toThrow(/au moins une ligne/);
  });
});

// ─── validateFacture — checklist mentions obligatoires ────────────────

describe('validateFacture', () => {
  it('franchise B2C valide: ok, mention 293 B portée', () => {
    const r = validateFacture(factureFranchiseB2C(), CTX_2026);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.missingMentions).toEqual([]);
    expect(r.totals?.totalTtcCentimes).toBe(18000);
    expect(MENTION_FRANCHISE_BASE).toContain('293 B');
  });

  it('assujetti B2B complet: ok', () => {
    const r = validateFacture(factureAssujettiB2B(), CTX_2026);
    expect(r.ok).toBe(true);
    expect(r.missingMentions).toEqual([]);
  });

  it('B2B sans conditions de paiement: mentions B2B manquantes', () => {
    const r = validateFacture(
      factureAssujettiB2B({ conditionsPaiement: undefined }),
      CTX_2026,
    );
    expect(r.ok).toBe(false);
    const ids = r.missingMentions.map((m) => m.id);
    expect(ids).toContain('conditions.echeance');
    expect(ids).toContain('conditions.penalites');
    expect(ids).toContain('conditions.indemnite');
  });

  it('structurellement invalide: errors peuplé, totals null', () => {
    const r = validateFacture({ numero: 'F1' }, CTX_2026);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.totals).toBeNull();
  });

  it('SIREN client B2B: non requis avant la réforme, requis après', () => {
    const sansSiren = factureAssujettiB2B({
      client: { type: 'professionnel', name: 'Garage Léon SARL', address: adresse },
    });
    // Avant 2027-09-01 (défaut PME/micro): pas bloquant, mais averti.
    const before = validateFacture(sansSiren, CTX_2026);
    expect(before.missingMentions.map((m) => m.id)).not.toContain('client.siren');
    expect(before.warnings.join(' ')).toMatch(/SIREN du client/);

    // Après la date d'application: mention obligatoire manquante.
    const after = validateFacture(sansSiren, CTX_POST_REFORM);
    expect(after.ok).toBe(false);
    expect(after.missingMentions.map((m) => m.id)).toContain('client.siren');
  });

  it('eInvoiceMentionsFrom configurable (grande entreprise 2026-09-01)', () => {
    const sansSiren = factureAssujettiB2B({
      client: { type: 'professionnel', name: 'Garage Léon SARL', address: adresse },
    });
    const r = validateFacture(sansSiren, {
      referenceDate: '2026-10-01',
      eInvoiceMentionsFrom: '2026-09-01',
    });
    expect(r.missingMentions.map((m) => m.id)).toContain('client.siren');
  });
});

// ─── factureChecklist ─────────────────────────────────────────────────

describe('factureChecklist', () => {
  it('annoté applicable/satisfied par mention', () => {
    const f = FactureInputSchema.parse(factureFranchiseB2C());
    const checklist = factureChecklist(f, CTX_2026);
    const franchise = checklist.find((m) => m.id === 'mention.franchise');
    expect(franchise?.applicable).toBe(true);
    expect(franchise?.satisfied).toBe(true);
    // VAT-number mention does not apply to a franchise seller.
    const vat = checklist.find((m) => m.id === 'vendeur.vatNumber');
    expect(vat?.applicable).toBe(false);
  });
});
