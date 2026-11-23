# CAISSEIA

**CAISSEIA — Caisse · Inaltérabilité · Archivage**

> Registre inaltérable des encaissements pour les logiciels de caisse
> Inaltérabilité, sécurisation, conservation, archivage

Conçu pour les conditions d'inaltérabilité, de sécurisation, de conservation et d'archivage de l'article 286, I, 3° bis du CGI. Ce logiciel n'est pas certifié NF525. MONTPC prévoit de délivrer une attestation éditeur pour les versions qu'elle publie ; aucune n'est signée à ce jour (voir ATTESTATION.md).

Projet open source indépendant, sans lien avec la DGFiP ni l'administration fiscale.

**Statut** : v1.0.0-rc.7 (release candidate) ; aucune attestation éditeur n'est signée à ce jour
**Éditeur** : MONTPC SASU · SIRET 993 766 369 00010

## Install (npm — once published)

```bash
npm install caisseia
# or
pnpm add caisseia
```

```ts
import { recordEncaissement, closeDay, verifyChainIntegrity } from 'caisseia';
```

See [`docs/INTEGRATION.md`](./docs/INTEGRATION.md) for the full step-by-step guide.

**Key registry required for verification** : `verifyChainIntegrity(workspaceId, { keyRegistry? })`,
`verifyExportIntegrity(export, { keyRegistry? })` and the `caisseia-verify-integrity` CLI verify every
closure signature against the public-key registry (option, else `CAISSEIA_KEY_REGISTRY_PATH`, else the
bundled `keys/public-keys.json`). An empty or missing registry is a FAILURE, never a skipped check.

**Closures sign chain heads (closure schema v2+, NF-11; v3 also signs the business period key and calendar)** : every closure (day / month / year) signs,
with its totals, the chain head of the `encaissement` stream (encaissements + corrections) and of the
`jet` stream: sequence + hash of the last record recorded at or before the period end. Both
verifiers recompute each chain and check that the record at every signed sequence has exactly the
signed hash, so rewriting a record and recomputing the whole hash chain is detected
(`valid: false`). Closures sealed before v2 carry no chain head: they are reported in `warnings`
(« legacy closure, chain head not signed ») with `fullyVerified: false`, until a v2 closure with a
later or equal period end covers them. Check `fullyVerified`, not only `valid`.

**Closure chain + no unclosed elapsed day (NF-11)** : every v2 closure also signs
`previousClosureHash` = hash of the previous closure record of its own stream (`closure-day`,
`closure-month`, `closure-year` each chain separately; GENESIS_HASH, 64 zeros, for the first). The
verifiers check that signed link against the store link, end to end: deleting a closure and
renumbering + rechaining the closure stream is detected (`closure chain broken`). Both verifiers also
raise an ERROR (`valid: false`, never a warning) for every **elapsed day** that has encaissement or
JET records that no day closure covers. Elapsed day = business day (local civil day of the business,
default Europe/Paris, from its cut-off hour; see docs/INTEGRATION.md § 8) ended before the verification
date; the running day is never an error. Two day closures that overlap are an error too. The date is
`options.now` (default: now). `verifyExportIntegrity` checks only the days lying entirely inside the
export window. Consequence for integrators: **close every day that has any record**, JET included
(a verification, an export or a closure run writes a JET record on the day it runs).

**Known gaps (stated plainly)** :
- Records after the period end of the latest closure (the unsealed tail) are hash-chained only:
  anyone who can write the store can rewrite, rechain or truncate them undetected until the next
  closure seals them. Close daily.
- An export only checks the chain heads whose record is inside the exported window; a head before
  the window is not checkable from that export alone.
- Residual limit of the closure chain: the newest closure of a stream has no successor to sign its
  hash. Deleting the newest **day** closure is caught only by the elapsed-day ERROR, so it is
  invisible (a) while its day is not yet elapsed (today's closure), and (b) if the attacker also
  deletes every encaissement and JET record after the previous day closure's signed heads (pure tail
  truncation of all streams back to the last remaining closure: no record, no unclosed day, chains
  consistent). Only a copy held outside the store (an earlier export, a printed Z ticket) shows it.
  Deleting the newest **month** or **year** closure is detected only once a later closure of the
  same stream exists; it reopens no record (the day closures still sign the chain heads).
- This change alters the signed closure content: it needs a new attestation éditeur before release.

---

## Country-portable architecture (`/core` + `/fr`)

The package exposes three entry points, so a future Spain (VeriFactu) or Italy (cloud RT) adapter can reuse the engine without dragging in French semantics:

| Import path | Surface | Country |
|---|---|---|
| `caisseia` | Everything (backwards compatible) | FR (today) |
| `caisseia/fr` | `recordEncaissement`, `closeDay`, `exportPeriod`, `generateAttestation`, FR Zod schemas, `LEGAL_REFERENCE`, `MODULE_VERSION` — plus re-exports of core | France-specific |
| `caisseia/core` | `append` / `read` event store, `hash` / `canonicalize` / `verifyChain`, `Signer` (`MemorySigner`, `FileSigner`, `KmsSigner`), `keyRegistry`, `EventStorage` (`InMemoryStorage`, `PostgresStorage`) | Country-agnostic engine — no FR vocabulary, no Zod schemas, no BOFIP |

```ts
// FR consumer (today's apps — unchanged)
import { recordEncaissement, closeDay } from 'caisseia';

// Or, equivalently, scope-tagged
import { recordEncaissement, closeDay } from 'caisseia/fr';

// Future caisseia/es Spain adapter would build on:
import { append, hash, canonicalize, MemorySigner, PostgresStorage } from 'caisseia/core';
```

Rationale: every major EU regime (DE TSE, ES VeriFactu, IT RT, PT ATCUD, AT RKSV) shares the same five primitives (immutable chained ledger, signed transactions, tamper-evident receipt, regulated export, audit-on-demand). The `/core` subpath is exactly those primitives, ready to host a sibling country layer.

---

## Pourquoi ce package existe

L'article 286 I 3°bis du CGI impose à toute entreprise assujettie à la TVA qui utilise un logiciel d'enregistrement des paiements clients de respecter quatre conditions techniques : **inaltérabilité, sécurisation, conservation, archivage**. La preuve de conformité passe par un certificat d'organisme accrédité (INFOCERT/AFNOR ou LNE), ou — depuis son rétablissement par la loi de finances pour 2026 (art. 125), applicable depuis le 21 février 2026 — par une **attestation individuelle de l'éditeur**.

Ce package met en œuvre ces quatre conditions dans une brique réutilisable par tout logiciel qui enregistre des encaissements.

## Documents critiques

- [`COMPLIANCE.md`](./COMPLIANCE.md) — Mapping technique des 4 exigences art. 286 CGI vers l'implémentation
- [`ATTESTATION.md`](./ATTESTATION.md) — Modèle attestation individuelle conforme BOFIP
- [`CHANGELOG.md`](./CHANGELOG.md) — Historique versions + attestations associées
- [`docs/USER_OBLIGATIONS.md`](./docs/USER_OBLIGATIONS.md) — Obligations de l'utilisateur (document à remettre à chaque assujetti)

## Versioning et impact attestation

| Type bump | Exemple | Attestation |
|---|---|---|
| **Patch** | 1.0.0 → 1.0.1 | Bug fix non-compliance, **même attestation valide** |
| **Minor** | 1.0.0 → 1.1.0 | Ajout feature non-impactant, **même attestation valide** |
| **Major** | 1.0.0 → 2.0.0 | Changement structurel chainage / format encaissement, **nouvelle attestation requise** |

Chaque attestation signée référence une version exacte (ex: `caisseia@1.4.2`). Archive 10 ans en parallèle des données encaissement qu'elle couvre.

## Sanctions en cas de défaillance (rappel)

Article 1770 duodecies CGI (et 1770 undecies pour l'éditeur) :
- 7 500€ par système d'encaissement non conforme, **renouvelable tous les 60 jours après mise en demeure**
- Rejet de la comptabilité + reconstitution d'office du CA
- 80% de pénalité sur les droits dus en cas de manœuvre frauduleuse
- Pour l'éditeur : amende jusqu'à 15% du chiffre d'affaires
- **Fausse attestation : délit pénal · 3 ans d'emprisonnement · 45 000€ d'amende** (art. 441-1 Code pénal)

## Ce que couvre l'attestation de MONTPC

L'attestation éditeur de MONTPC couvre **uniquement les versions que MONTPC publie**, chacune désignée par son numéro de version et son empreinte (hash). Toute personne qui modifie ce logiciel, ou qui distribue sa propre version compilée, est l'**éditeur de cette version** : c'est à elle de fournir sa propre attestation ou son propre certificat. L'attestation de MONTPC ne couvre jamais « le code source » en général, ni une version modifiée. Détails : [`ATTESTATION.md`](./ATTESTATION.md).

## Liens BOFIP

- [BOI-TVA-DECLA-30-10-30](https://bofip.impots.gouv.fr/bofip/10691-PGP.html) — Obligation logiciels caisse sécurisés
- [BOI-LETTRE-000242](https://bofip.impots.gouv.fr/bofip/10692-PGP.html) — Modèle attestation individuelle
- [BOI-CF-COM-20-60](https://bofip.impots.gouv.fr/bofip/11316-PGP.html) — Droit de contrôle DGFIP
- [BOFIP ACTU-2026-00073](https://bofip.impots.gouv.fr/bofip/15035-PGP.html) — Rétablissement attestation éditeur (LF 2026 art. 125)

## Licence

Ce logiciel est distribué sous licence **GNU Affero General Public License v3.0** (AGPL-3.0-only), texte complet dans [`LICENSE`](./LICENSE). © 2026 MONTPC SASU.

Contributions : uniquement sous le [CLA](./CLA.md), voir [`CONTRIBUTING.md`](./CONTRIBUTING.md).

Le logiciel est fourni « en l'état », sans garantie, dans les limites prévues par l'AGPL-3.0 (articles 15 et 16).
