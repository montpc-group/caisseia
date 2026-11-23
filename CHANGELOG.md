# Changelog — CAISSEIA

> Toute version listée ici fait l'objet d'une attestation archivée
> par MONTPC (voir ATTESTATION.md).

## Format

Chaque entrée suit cette structure :
- **Version** + date
- **Type** : MAJOR / MINOR / PATCH
- **Impact attestation** : nouvelle attestation requise / attestation précédente reste valide
- **Changements** : liste des changements
- **Hash build** : SHA-256 du build figé (ajouté lors de la signature)
- **Lien attestation** : lien vers le PDF signé

---

## [1.0.0-rc.5] — 2026-11-23

**Type** : MINOR (API additive) + correctif. Aucun changement du contenu signé ni du chaînage.

- `recordCorrection` : lecture du net, contrôle et écriture sous le verrou du flux `encaissement` (avec `{ client }` dans la transaction de l'appelant, sinon dans une transaction ouverte par le SDK) : deux corrections parallèles ne peuvent plus faire passer le net sous 0. Sans `client`, un conflit de séquence avec un écrivain hors verrou rejoue toute l'étape (3 tentatives, net relu).
- `closeDay` / `closeMonth` / `closeYear`, `getCurrentDayClosure` / `getMonthClosure` / `getYearClosure`, `verifyChainIntegrity`, `exportPeriod` acceptent `{ client }` : toutes les lectures, le scellement, l'écriture et les entrées JET passent par la connexion de l'appelant (indispensable sous RLS). Avec un client, une clôture prend le verrou de son flux ; le SDK ne relâche jamais ce client.
- `closeDay` refuse de sceller un jour quand la lecture des encaissements renvoie 0 ligne alors que le flux a un dernier enregistrement.
- Contrat `EventStorage` : nouvelle méthode `withStreamLock` ; `getLast` (event store) accepte `{ client }`.

---

## [1.0.0-rc.4] — 2026-11-23

**Type** : MINOR (API additive) + correctifs. Aucun changement du contenu signé ni du chaînage.

- `recordEncaissement`, `recordCorrection`, `logTechnicalEvent` (5ᵉ argument) acceptent `{ client }` : lecture du dernier maillon, hash, insertion et entrée JET sur la connexion de l'appelant, dans sa transaction ; le SDK ne relâche jamais ce client. Postgres : verrou transactionnel `pg_advisory_xact_lock` par (workspace, flux) avant la lecture du dernier maillon, donc deux transactions parallèles se sérialisent sans fourche. La transaction appelante doit être en READ COMMITTED (défaut Postgres). Clôtures : pas encore.
- `canonicalize` : un taux n'est pas un montant (`tauxTva: 5.5` accepté) ; vecteurs de référence : hashes inchangés.

---

## [1.0.0-rc.3] — 2026-11-23

**Type** : MINOR (security fix NF-11) + licence
**Impact attestation** : nouvelle attestation requise

### Migration
- `migrate` exporté par l'entrée publique ; CLI `caisseia-migrate` (node simple sur `dist`, sans tsx) ; le build copie `src/storage/migrations/*.sql` dans `dist`. Un script consommateur nommé `migrate.js` n'exécute plus la CLI à l'import.

### Licence
- Licence **AGPL-3.0-only** (était UNLICENSED), © MONTPC SASU. `CLA.md` + `CONTRIBUTING.md` : contributions extérieures uniquement sous CLA.
- README + ATTESTATION.md : l'attestation de MONTPC couvre uniquement les versions publiées par MONTPC (version + empreinte) ; qui modifie ou distribue sa propre version en est l'éditeur.
- README : mention « n'est pas certifié NF525 » ; « nf525 » retiré de la description et des mots-clés (nom du paquet en attente).

### Stockage
- `PostgresStorage.append(input, { client })` : l'insertion rejoint la transaction de l'appelant (pas de BEGIN/COMMIT, client non relâché) ; sans `client`, comportement inchangé. Aucun changement du chaînage ni du contenu signé.

### Sécurité NF-11
**Impact attestation** : nouvelle attestation requise

- `verifyChainIntegrity(workspaceId, options?)` vérifie désormais la signature Ed25519 de chaque clôture (seuls enregistrements signés) en plus du hash chain. Registre de clés vide/absent → `valid: false` + `error` (plus de vérification ignorée).
- `verifyExportIntegrity(export, options?)` : signatures vérifiées contre le registre de confiance (option, sinon registre chargé), jamais ignorées ; registre absent/vide → erreur.
- `verifySignature(payload, sig, version, registry?)` : vérification par clé publique seule (plus besoin d'un Signer/clé privée pour vérifier).
- CLI `caisseia-verify-integrity` : `NF525_KEY_REGISTRY_PATH` documenté, erreur globale affichée.
- **Schéma de clôture v2** (`CLOSURE_SCHEMA_VERSION = 2`) : le contenu signé de chaque clôture inclut `schemaVersion` et `chainHeads` = tête de chaîne (séquence + hash du dernier enregistrement à la fin de période) des flux `encaissement` (encaissements + corrections) et `jet`. Change le contenu signé → **nouvelle attestation éditeur requise**.
- `verifyChainIntegrity` / `verifyExportIntegrity` : recalcul de chaque chaîne et contrôle que l'enregistrement à la séquence signée porte exactement le hash signé. Réécriture d'un encaissement / correction / événement JET avec recalcul complet de la chaîne, ou troncature sous la tête signée → `valid: false`.
- Clôtures v1 (sans tête de chaîne) : toujours lues et vérifiées, mais signalées `warnings` « legacy closure, chain head not signed » + `fullyVerified: false` tant qu'aucune clôture v2 de fin de période ≥ ne les couvre. Retirer `chainHeads` d'une clôture v2 casse sa signature (pas de downgrade).
- Nouveaux champs : `IntegrityReport.fullyVerified`, `IntegrityReport.warnings`, `ExportIntegrityResult.fullyVerified`, `ExportIntegrityResult.warnings`, `Closure.chainHeads`.
- **Chaîne des clôtures** (schéma v2, amendé avant release) : chaque clôture signe aussi `previousClosureHash` = hash de la clôture précédente du même flux (`closure-day` / `closure-month` / `closure-year`, GENESIS_HASH pour la première). Les deux vérificateurs contrôlent ce lien signé de bout en bout : suppression / renumérotation d'une clôture avec recalcul du flux → `valid: false` (« closure chain broken » / « Chaîne des clôtures rompue »). Change le contenu signé → **nouvelle attestation éditeur requise**.
- **Jour écoulé sans clôture = ERREUR** : `verifyChainIntegrity` et `verifyExportIntegrity` (jours entièrement dans la fenêtre d'export) rendent `valid: false` pour tout jour UTC antérieur à la date de vérification qui a des enregistrements encaissement/JET sans clôture journalière. Option `now` injectable (défaut : maintenant). Supprimer la dernière clôture journalière est détecté dès que son jour est écoulé. Impact intégrateur : clôturer chaque jour ayant un enregistrement (JET compris).
- Nouveau champ : `Closure.previousClosureHash`.
- Limite restante : la dernière clôture d'un flux n'est signée par aucune suivante — sa suppression avec toutes les écritures postérieures aux têtes signées de la clôture précédente n'est pas détectable depuis la base seule (cf. README « Known gaps »).
- Limite restante : la queue non scellée (après la fin de période de la dernière clôture) n'est protégée que par le chaînage (cf. README « Known gaps »).

---

## [1.0.0-rc.2] — 2026-05-29

**Type** : MAJOR (release candidate iteration)
**Impact attestation** : nouvelle attestation requise lors de la signature 1.0.0

### SDK structure + packaging (since rc.1)

- SDK split into country-agnostic **`/core`** + France-specific **`/fr`** via subpath exports.
- Migration SQL (`src/storage/migrations/*.sql`) now shipped in the published package.
- No domain logic changed since rc.1; inalterability/chaining/closure/restitution/attestation behaviour identical.

### Verification (frozen build)

- **152 tests passing, 0 fail / 0 todo / 0 skip**: 137 unit (`--major` mode) + 15 Postgres integration suites (REVOKE + BEFORE-trigger inalterability proofs, run against live `postgres:16-alpine`, confirmed executed not skipped).
- **Hash build** : `c7aa747f7ca2108374dfb18287e22b84b3e1a5acbddb42e61cde350addd776ac`
- Git tag : `v1.0.0-rc.2`

**Note** : la signature de l'attestation éditeur intervient avant la version 1.0.0 définitive.

## [1.0.0-rc.1] — 2026-05-22

**Type** : MAJOR (initial public release candidate)
**Impact attestation** : nouvelle attestation requise lors de la signature 1.0.0

### Publish prep

- `publishConfig.access: public`.
- Version bumped to `1.0.0-rc.1` (was `0.0.0`).
- Added `.github/workflows/publish.yml` — release-on-tag workflow with `--provenance` attestation.
- No domain logic changed; 137/137 unit tests still pass (Postgres integration suite unchanged).

## [Unreleased]

### Milestone 5 — code review, integration guide (2026-05-18)

- `docs/INTEGRATION.md` — step-by-step consumer app integration guide (initialize, encaissement, corrections, closures automation, export, integrity, attestation, UI requirements)
- Full code compliance review across all src/*.ts files
- README.md updated: status reflects v1.0.0-rc (code complete, pending attestation signing)
- Total suite: 75 pass / 0 todo / 0 fail (unchanged — M5 is non-code)

### Milestone 4 — attestation PDF + CLI (2026-05-18)

- `src/attestation.ts` — implémenté : `generateAttestation(input)` → `AttestationDocument` avec buffer PDF
- Volet 1 (éditeur) : identité MONTPC SASU, SIREN 993 766 369, version logiciel, déclaration conformité art. 286 I 3°bis CGI, périmètre couvert/non couvert, mention légale art. 441-1
- Volet 2 (utilisateur) : identité workspace (raison sociale, SIRET), app consommatrice, version, dates, bloc signature
- Filigrane SPECIMEN sur chaque page (obligatoire avant v1.0.0)
- `renderSummaryReportPdf(data)` — rapport de synthèse PDF pour `exportPeriod(format='pdf')` : totaux par mode/TVA, état chaînes de clôture, signatures
- `exportPeriod(format='pdf')` — wired : produit `rapport-synthese.pdf` + `public-keys.json` avec manifest intégrité
- `scopeOverride` permet de personnaliser le périmètre couvert dans l'attestation
- CLI `src/cli/verify-integrity.ts` — wrapper `verifyChainIntegrity()`, exit 0/1
- CLI `src/cli/generate-attestation.ts` — wrapper `generateAttestation()`, écrit PDF stdout ou `--output`
- `package.json` : champ `bin` ajouté (`caisseia-verify-integrity`, `caisseia-generate-attestation`), scripts mis à jour
- Nouveaux exports publics dans `src/index.ts` : `renderSummaryReportPdf`, `SummaryReportData`
- Tests : 9 tests — PDF valide, SPECIMEN watermark, hash SHA-256, métadonnées éditeur/utilisateur, mention légale, export PDF synthèse, scopeOverride
- Total suite : 75 pass / 0 todo / 0 fail

### Milestone 3 — restitution DGFIP (2026-05-17)

- `src/restitution.ts` — implémenté : `exportPeriod`, `generateManifest`, `verifyExportIntegrity`
- `exportPeriod(workspaceId, from, to, format)` — format ∈ `'csv' | 'json'` ; `'pdf'` déféré à M4 (throw NOT_IMPLEMENTED)
- Export JSON : 4 fichiers (encaissements, corrections, closures, jet) + public-keys.json (registre clés pour vérif offline)
- Export CSV : un encaissement/correction par ligne, séparateur `;` (FR locale), échappement guillemets, parsable Excel/LibreOffice
- `generateManifest` : SHA-256 de chaque fichier exporté + hash global du manifest pour détection de tampering
- `verifyExportIntegrity` : vérifie hashes fichiers, hash manifest, chaînes de hash par stream, signatures clôtures — exécutable offline sans accès base
- Copie du registre `keys/public-keys.json` incluse dans chaque export (vérification signatures Ed25519 offline, même après rotation)
- JET : `export_requested` + `export_completed` loggés pour chaque export
- Nouveaux exports publics dans `src/index.ts` : `generateManifest`, `ExportResult`, `ExportFile`, `ExportIntegrityResult`
- Tests : 8 tests (anciens `it.todo`) — exhaustivité export, manifest avec hashes, détection tampering, CSV parsable, JSON complet, clé registry incluse, JET tracé, vérification offline
- Dépendance `pdfkit` ajoutée (préparation M4)
- Total suite : 64 pass / 0 todo / 0 fail

### Milestone 2 — clôtures périodiques (2026-04-27)

- `src/closures.ts` — implémenté : `closeDay`, `closeMonth`, `closeYear`, `getCurrentDayClosure`, `getMonthClosure`, `getYearClosure`
- Bornes de période en UTC strict (00:00:00.000Z → 23:59:59.999Z) ; TZ-aware déféré à M2.5 si besoin app
- Agrégation : par mode de paiement, par code TVA (clé = `tvaCode` enregistré ; ventilation HT/TVA optionnelle si `CloseOptions.tvaRates` fourni, sinon `ht=ttc, tva=0`)
- Corrections incluses dans le total net de la journée où elles sont enregistrées, attribution mode/TVA héritée de l'encaissement original (lookup cross-period)
- Cumul perpétuel (Grand Total) carry-forward à travers les `closure-day` successives
- Idempotence : refus de re-clôture (jour/mois/année) ; refus mensuel si jour manquant ; refus annuel si mois manquant
- Signature Ed25519 sur skeleton canonicalisé (sans `signature`/`signingKeyVersion`) → signature persistée DANS le payload → l'event store l'inclut dans son hash de chaîne (defense-in-depth : tampering casse la chaîne)
- `schemas/cloture.schema.ts` — relâché : `caTotalCentimes`/`cumulPerpetuel` signés (refunds peuvent excéder ventes), `premiereSequence`/`derniereSequence` `nonneg` avec refinement "= 0 ssi nbTransactions = 0" (jours zéro-vente sont scellés pour continuité de chaîne)
- Tests : 11 tests (anciens `it.todo`) — agrégation jour, corrections, idempotence, chaînage, signature vérifiable hors processus, immutabilité (tampering détecté), cumul perpétuel, refus mois/année incomplets, agrégation mois/année
- Total suite : 56 pass / 8 todo (M3 restitution) / 0 fail

### Milestone 1 — fondations cryptographiques + storage (2026-04-26)

- `src/crypto.ts` — canonicalize (RFC 8785-compatible), hash, verifyChain implémentés
- `src/crypto/Signer.ts` — interface Signer + FileSigner (Ed25519 disque chmod 600), KmsSigner stub (M3), MemorySigner (tests)
- `src/crypto/keyRegistry.ts` + `keys/public-keys.json` — registre des clés publiques avec rotation
- `src/storage/EventStorage.ts` — interface adapter (append, read, getLast, count, assertSchema)
- `src/storage/InMemoryStorage.ts` — adapter unit-tests, déterministe, simule contrainte unique
- `src/storage/PostgresStorage.ts` — adapter prod via `pg`
- `src/storage/migrations/001_initial.sql` — table `nf525_event` + rôle `nf525_app` (REVOKE UPDATE/DELETE) + trigger `refuse_mutation` (BEFORE UPDATE/DELETE/TRUNCATE) + CHECK constraints + indices
- `src/storage/migrate.ts` — runner idempotent (`pnpm migrate`)
- `src/eventStore.ts` — réécrit sur EventStorage, retry-on-conflict (max 3), genesis hash
- `src/encaissement.ts`, `src/corrections.ts`, `src/integrity.ts`, `src/jet.ts` — domain modules
- `schemas/encaissement.schema.ts`, `schemas/jet.schema.ts`, `schemas/cloture.schema.ts` — schémas Zod (validation runtime + types)
- Tests : 45 tests pass / 19 todo (M2/M3) — chainage, inaltérabilité, conservation, JET, storage contract, crypto
- Tests Postgres via testcontainers : `tests/chainage.postgres.test.ts` (REVOKE proof + trigger proof + defense-in-depth)
- Toolchain : `pnpm`, `vitest` (html reporter `tests/_reports/`), `eslint`, `tsx`, `typescript` strict
- **Suppression de la dépendance `mongodb`** — remplacée par `pg` + `zod`

### Reste à faire avant v1.0.0

- [x] **M2** — `src/closures.ts` (closeDay/Month/Year), JET coverage complet, tests `cloture.test.ts` ✅ 2026-04-27
- [x] **M3** — `src/restitution.ts` (CSV/JSON + manifest + verify offline) ✅ 2026-05-17 (PDF deferred to M4)
- [x] **M4** — `src/attestation.ts` (PDF rendering BOFIP), CLI wrappers, PDF export ✅ 2026-05-18 (KmsSigner deferred to v1.1, CI workflow deferred to M5)
- [x] **M5** — code review, integration guide ✅ 2026-05-18

---

## v1.0.0 — [DATE_FIRST_RELEASE_TBD]

> Première version production-ready. Reservée tant que la checklist ci-dessus
> n'est pas complète.

- **Type** : MAJOR (initial release)
- **Impact attestation** : Attestation v1.0.0 à signer avant déploiement
- **Hash build** : `[À RENSEIGNER LORS DE LA SIGNATURE]`
- **Lien attestation** : publié avec la version 1.0.0

---

## Politique de versioning

### MAJOR (X.0.0)

Bump déclenche **nouvelle attestation obligatoire**. Cas concrets :

- Changement du format du hash chain (algo, structure, canonicalisation)
- Changement structurel du schéma encaissement
- Changement du format de signature des clôtures
- Changement du périmètre fonctionnel attesté (ajout d'un mode de paiement, par exemple Crypto)
- Changement de la procédure de restitution DGFIP

### MINOR (X.Y.0)

Bump **ne nécessite pas** de nouvelle attestation. Cas concrets :

- Ajout d'une nouvelle fonction publique non-impactante (ex: helper pour rapports)
- Améliorations de performance sur les fonctions existantes (sans changement comportemental)
- Refactor interne sans impact sur le comportement observable
- Ajout de tests
- Ajout de documentation

### PATCH (X.Y.Z)

Bump **ne nécessite pas** de nouvelle attestation. Cas concrets :

- Correction de bug n'affectant pas la compliance
- Mise à jour des dépendances de sécurité
- Correction de typos dans la documentation

### Cas litigieux

En cas de doute sur la classification d'un changement (mineur ou majeur du point de vue compliance), **par défaut classer en MAJOR** et regenérer l'attestation. Le coût marginal d'une attestation supplémentaire est faible. Le coût d'un contrôle qui révèle une non-conformité est lourd.

---

## Process de release

1. Tous les tests passent (`pnpm test` et `pnpm test:postgres`)
2. Mise à jour de [`COMPLIANCE.md`](./COMPLIANCE.md) si pertinent
3. Mise à jour de ce CHANGELOG avec une nouvelle entrée
4. Bump de version dans `package.json`
5. Si MAJOR : génération nouvelle attestation, signature, archivage par MONTPC
6. Tag git `v<version>` avec hash SHA-256 du build
7. Communication aux intégrateurs (notamment si MAJOR — ils doivent regénérer leurs attestations utilisateur)
