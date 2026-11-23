# Compliance — Mapping art. 286 I 3°bis CGI vers l'implémentation

> Document technique destiné à prouver, en cas de contrôle DGFIP,
> que le logiciel respecte effectivement les 4 exigences légales.

**Version logicielle couverte** : `0.0.0` (scaffolding — non utilisable en production)
**Dernière revue** : à faire avant signature attestation v1.0.0
**Reviewer recommandé** : expert-comptable + dev externe (peer review compliance)

---

## Cadre légal

Article 286 I 3°bis du CGI :

> « Les assujettis qui enregistrent les règlements de leurs clients au moyen d'un logiciel de comptabilité ou de gestion ou d'un système de caisse satisfont aux conditions d'**inaltérabilité, de sécurisation, de conservation et d'archivage** des données en vue du contrôle de l'administration fiscale. »

Quatre exigences. Chacune fait l'objet d'une section ci-dessous, avec :
1. **Définition légale** (citation BOFIP)
2. **Implémentation choisie** dans le code
3. **Fichiers concernés** (pointeurs vers le code)
4. **Tests de preuve** (suite tests qui démontrent la conformité)

---

## 0. Périmètre d'application — qui est concerné par l'obligation, et qui ne l'est pas

> **Cette section répond à la question** : *"est-ce que cette app, ou cette utilisation, déclenche l'obligation de l'art. 286 I 3° bis CGI ?"*
> Elle existe parce que la confusion sur ce point est l'erreur la plus fréquente — coûteuse dans les deux sens : croire qu'on est obligé alors qu'on ne l'est pas (over-engineering), ou croire qu'on ne l'est pas alors qu'on l'est (exposition 7 500 €).

### 0.1 La règle en une phrase

L'obligation de l'art. 286 I 3° bis CGI s'applique à **un logiciel qui est le système de référence pour l'enregistrement des règlements clients d'un assujetti à la TVA en relation B2C**. Pas à tous les logiciels qui touchent aux paiements. Pas à tous les outils de facturation. Au système de référence des encaissements.

### 0.2 Trois conditions cumulatives

L'obligation se déclenche si **les trois** sont vraies en même temps :

1. **L'utilisateur final est assujetti à la TVA** — pas en franchise en base. Au-dessus des seuils 2026 (37 500 € services / 85 000 € ventes).
2. **Il vend en B2C** — au moins partiellement à des particuliers. Une activité 100 % B2B échappe au régime.
3. **Le logiciel est le système de référence** pour enregistrer ces règlements — celui qui assigne le numéro de facture, qui persiste « cette facture a été payée le X par le moyen Y », qui produit la trace à présenter en cas de contrôle.

Si une seule condition manque, le logiciel n'a pas besoin d'être attesté.

### 0.3 La distinction critique : système de référence vs vue dérivée

C'est la distinction qui permet au BOFIP d'autoriser des architectures composites (la « tolérance brique » formalisée par la doctrine).

**Système de référence** : le logiciel qui *crée* l'artefact légal (numéro de facture, enregistrement d'encaissement, manifest d'archivage). C'est ce logiciel qui a besoin de l'attestation.

**Vue dérivée** : un logiciel qui *lit* les artefacts produits par un système de référence et les présente différemment (UI plus jolie, tableaux de bord, exports custom, vues client, intégrations CRM). Pas besoin d'attestation sur la vue dérivée tant qu'elle ne réécrit pas, ne renumérote pas, ne crée pas d'artefact légal divergent.

#### Exemple type : un CRM ↔ une caisse attestée tierce

```
CRM                       Caisse attestée tierce          CRM
───                       ──────────────────────          ───
Workflow métier      →    Crée la facture            →    Lit les données
                          (n° de facture, TVA,             Rend le PDF custom
                          encaissement, scellement)        Affiche dans l'UI
```

- **Système de référence** : la caisse attestée. C'est elle qui assigne le numéro, enregistre l'encaissement, tient la chaîne.
- **Vue dérivée** : le CRM. Il lit les données de la caisse via API et les rend en PDF custom. Le CRM ne crée *aucun* artefact légal indépendant.
- **Conséquence** : le CRM n'a pas besoin d'attestation propre. La conformité est portée par la caisse attestée. C'est une architecture courante.

### 0.4 Les 3 lignes rouges qui font basculer une vue dérivée en système de référence

Si une de ces lignes est franchie, le logiciel cesse d'être une vue dérivée et devient système de référence — donc concerné par l'obligation :

1. **Le logiciel assigne lui-même les numéros de facture.** Une facture créée hors du système attesté, avec un numéro qui n'existe pas dans ce système, est un artefact légal indépendant. Ce logiciel devient système de référence pour cette facture.
2. **Le logiciel enregistre des paiements qui ne transitent pas par l'attesté.** Si le CRM affiche un bouton « marquer comme payée en espèces » qui n'écrit pas l'encaissement dans le système attesté, c'est le CRM qui devient le registre — donc système de référence.
3. **Le logiciel modifie le contenu de l'artefact** au-delà de la présentation. Changer le montant, la description, le destinataire, le numéro avant affichage = créer un nouvel artefact divergent. Reformatter l'apparence en gardant données identiques = OK.

### 0.5 Cas types

| Scénario | Système de référence | Concerné par l'obligation ? | Justification |
|---|---|---|---|
| CRM qui affiche les ventes d'une caisse attestée | La caisse attestée | Non | Vue dérivée : n'assigne pas de n°, n'enregistre pas d'encaissement indépendant. |
| Entreprise en franchise en base de TVA | — | Non | Condition 1 non remplie (pas assujettie). |
| Application qui crée les factures et enregistre elle-même les encaissements B2C | L'application | **Oui** | Système de référence par construction : c'est le cas d'usage de `caisseia`. |
| SaaS multi-clients, certains sur une caisse attestée tierce, d'autres non | Variable | Selon le client | Seuls les clients pour lesquels l'application est le registre sont concernés. |
| Site web vitrine sans encaissement | — | Sans objet | Pas de système d'encaissement. |

### 0.6 Décision matricielle pour toute nouvelle app touchant à un paiement

Avant de coder une feature de paiement / facturation, répondre dans l'ordre :

```
1. L'utilisateur final de l'app sera-t-il assujetti à la TVA et en B2C ?
   ├── Non → hors obligation. Pas de brique nécessaire.
   └── Oui → continuer.

2. L'app va-t-elle assigner des numéros de facture, enregistrer des encaissements,
   ou être le seul registre du paiement ?
   ├── Non, l'app est une vue dérivée d'un système attesté tiers
   │   → hors obligation. Documenter quel système est de référence,
   │      vérifier que l'attestation tierce couvre le périmètre.
   └── Oui, l'app est le système de référence
       → obligation applicable. Intégrer `caisseia`,
         couvrir l'intégration par une attestation éditeur.
```

### 0.7 Ce que l'obligation ne couvre pas (autres régimes adjacents souvent confondus)

Pour éviter le scope creep dans la documentation et le code :

- **Génération de factures** (mentions obligatoires art. 289 CGI, Factur-X, structure XML) → régime distinct, géré ailleurs (module de facturation). `caisseia` ne génère pas de factures, il enregistre les encaissements.
- **E-invoicing B2B** (réforme 2026–2027, Plateformes Agréées, transmission obligatoire au PPF) → régime distinct. Hors de ce package.
- **Reçus Stripe / autres PSP** → ce sont des confirmations de mouvement bancaire, pas des factures au sens art. 289. Le PSP est plombier, pas registre légal. La facture reste à émettre par l'application ou le système de référence.
- **Comptabilité** (LCM, écritures, FEC) → régime distinct (livre journal, FEC export pour DGFIP). Concerne l'expert-comptable, pas le logiciel d'encaissement.
- **Conservation pièces RH / contrats** → relève d'autres durées et obligations (Code du travail, Code civil), traité ailleurs.

L'obligation est circonscrite. Les voisins ont leurs propres règles. **Ne pas mélanger** dans `COMPLIANCE.md`, `ATTESTATION.md`, et le code.

### 0.8 Référentiel — pourquoi cette section est juridiquement robuste

- **Tolérance brique** : doctrine BOFIP — un système d'encaissement complexe peut être composé de plusieurs modules, chacun attesté ou certifié séparément, à charge pour l'assujetti de réunir l'ensemble des preuves.
- **BOI-TVA-DECLA-30-10-30 §40** précise que l'obligation porte sur le logiciel qui *enregistre* les règlements, pas sur tout outil qui en présente les données.
- **BOI-CF-COM-20-60** (droit de contrôle DGFIP) impose la production des données du *système de référence*. Un inspecteur demande la chaîne d'encaissements à l'attesté, pas au CRM qui l'affiche.
- **LF 2026 art. 125 / BOFIP ACTU-2026-00073** rétablit l'attestation individuelle de l'éditeur — le mécanisme par lequel chaque module attesté de la chaîne couvre son périmètre.

---

## 1. Inaltérabilité

### Définition légale

BOI-TVA-DECLA-30-10-30 § 80 :

> « L'inaltérabilité consiste à figer les données enregistrées de telle manière que ces dernières ne puissent être modifiées ou supprimées (...). Toute correction d'une opération de règlement antérieure ne peut s'effectuer que par l'enregistrement d'une nouvelle opération venant l'annuler ou la corriger. »

### Implémentation

**Pattern** : event-sourcing append-only avec enregistrements correctifs.

- Chaque encaissement est une entrée immutable dans la collection MongoDB `encaissements`.
- Aucune méthode du package n'expose de fonction d'`UPDATE` ou `DELETE` sur les encaissements.
- L'API publique n'expose que `recordEncaissement()` et `recordCorrection()`.
- Une correction est un nouvel encaissement de type `correction` qui référence l'`originalId` et porte un montant signé (positif ou négatif) annulant ou corrigeant l'original.
- Le total d'un encaissement = somme du original + toutes les corrections référençant son ID.
- Au niveau base de données : index unique sur `_id` + write concern majoritaire + indices read-only sur les champs critiques (montant, mode, timestamp).

### Fichiers concernés

- `src/encaissement.ts` — `recordEncaissement()`, pas d'`update`
- `src/corrections.ts` — `recordCorrection(originalId, amount, reason)`
- `schemas/encaissement.schema.ts` — schema avec `readonly` sur les champs critiques

### Traçabilité opérateur et terminal (BOI-TVA-DECLA-30-10-30)

Chaque encaissement et correction peut porter un `operatorId` (identifiant de l'opérateur) et un `registerId` (identifiant du terminal/caisse). Ces champs sont optionnels mais inclus dans le hash chain (canonicalisés dans le skeleton hashé). Un auditeur DGFIP peut ainsi tracer « toutes les transactions de l'opérateur X » ou « toutes les transactions du terminal Y ».

### Numérotation séquentielle continue (BOI-TVA-DECLA-30-10-30 §80-90)

Chaque enregistrement dans l'event store reçoit un numéro de séquence (`sequence`) strictement croissant, contigu, et sans réutilisation : 1, 2, 3, ... Ce numéro est attribué par `eventStore.append()` (`sequence = last.sequence + 1`) et fait partie intégrante du hash chain (inclus dans le skeleton hashé). Il est également encodé dans l'identifiant déterministe (`workspaceId:stream:000000000001`).

**Détection des suppressions par numéro de séquence** :

| Scénario | Mécanisme de détection |
|---|---|
| Suppression d'un enregistrement intermédiaire | Rupture du hash chain (`previousHash` invalide) + gap de séquence (`verifyChainIntegrity`) |
| Suppression du premier enregistrement | Gap de séquence : le premier enregistrement restant a `sequence > 1` |
| Suppression du dernier enregistrement | Ancrage par la clôture : `derniereSequence` dans le Z journalier dépasse la dernière séquence effective du flux |

Ce mécanisme est complémentaire au chaînage cryptographique (§ 2) : le hash chain détecte les altérations de contenu, la numérotation séquentielle détecte les suppressions — y compris en bordure de chaîne.

### Garantie technique additionnelle

Aucun accès direct à la base de données depuis les apps consommatrices. Toute écriture passe obligatoirement par les fonctions exportées du package, qui appliquent le hash chain (cf. § 2). Une modification base de données hors API casse le hash chain et est détectable lors de la prochaine vérification d'intégrité.

### Tests de preuve

- `tests/inalterabilite.test.ts` :
  - Vérifie qu'aucune méthode publique ne permet la mutation d'un encaissement existant
  - Vérifie qu'une tentative de modification directe en base casse la chaîne de hashes
  - Vérifie qu'une correction crée bien un nouvel enregistrement référencant l'original
  - Vérifie que le calcul du montant net inclut toutes les corrections référencantes
  - Vérifie que la suppression du premier enregistrement est détectée (gap de séquence)
  - Vérifie que la suppression du dernier enregistrement est détectable via les bornes de clôture

---

## 2. Sécurisation

### Définition légale

BOI-TVA-DECLA-30-10-30 § 100 :

> « La sécurisation consiste à mettre en œuvre des procédés techniques (par exemple le chaînage des écritures, le procédé de signature électronique ou tout autre dispositif technique équivalent) qui garantissent la restitution des données dans leur état d'origine. »

### Implémentation

**Pattern** : chaînage cryptographique SHA-256.

- Chaque enregistrement (encaissement, correction, événement JET, clôture) contient un champ `previousHash` qui est le hash SHA-256 de l'enregistrement précédent dans son flux.
- Le hash propre de l'enregistrement est calculé sur l'ensemble (`previousHash` + payload canonicalisé).
- Genesis : le premier enregistrement de chaque flux a `previousHash = "0".repeat(64)`.
- Toute modification d'un enregistrement intermédiaire invalide tous les `previousHash` des enregistrements ultérieurs → détection lors de la vérification d'intégrité périodique.

**Canonicalisation** : avant hash, le payload est sérialisé en JSON canonique (clés triées alphabétiquement, pas de whitespace, pas de précision flottante, montants en centimes integer).

### Fichiers concernés

- `src/crypto.ts` — `hash()`, `canonicalize()`, `verifyChain()`
- `src/eventStore.ts` — applique le chaînage à chaque `append()`
- `src/integrity.ts` — vérification d'intégrité périodique de la chaîne

### Tests de preuve

- `tests/chainage.test.ts` :
  - Vérifie que chaque enregistrement référence correctement le hash du précédent
  - Vérifie que la modification d'un enregistrement intermédiaire est détectée
  - Vérifie que la suppression d'un enregistrement intermédiaire est détectée
  - Vérifie que la canonicalisation est déterministe (mêmes données → même hash, indépendamment de l'ordre des champs)

---

## 3. Conservation

### Définition légale

BOI-TVA-DECLA-30-10-30 § 180 :

> « Les données enregistrées par le logiciel ou système doivent être conservées sur un support fiable jusqu'à l'expiration du délai de prescription en matière fiscale, soit la sixième année suivant celle au cours de laquelle elles ont été enregistrées. »

Code de commerce art. L. 123-22 — Conservation des pièces comptables 10 ans.

### Implémentation

**Durée** : 10 ans (alignement sur la durée la plus longue applicable).

- Aucune purge par le module sur les collections `encaissements`, `jet`, `closures`.
- Politique de rétention configurée explicitement dans la config du package.
- Sauvegardes et tests de restauration : à la charge de l'intégrateur (hors du package), voir `docs/USER_OBLIGATIONS.md`.

### Fichiers concernés

- `src/retention.ts` — policy de rétention 10 ans
- `src/restitution.ts` — export sur demande

### Tests de preuve

- `tests/conservation.test.ts` :
  - Vérifie qu'aucune méthode du package ne purge des encaissements
  - Vérifie que la fonction d'export couvre l'intégralité des données depuis l'origine

---

## 4. Archivage

### Définition légale

BOI-TVA-DECLA-30-10-30 § 220 :

> « L'archivage est obligatoire et consiste à figer les données et donner date certaine aux documents archivés (...). Une procédure de clôture des données enregistrées doit être prévue (...) au minimum annuelle. Des clôtures journalières et mensuelles sont également recommandées. »

### Implémentation

**Pattern** : clôtures périodiques scellées cryptographiquement.

- **Clôture journalière (Z journalier)** : à 00:00 chaque jour, calcul agrégé des encaissements de la journée précédente (totaux par mode de paiement, par taux de TVA, cumul depuis ouverture). Scellement via hash SHA-256 du payload + signature avec clé privée éditeur.
- **Clôture mensuelle** : 1er du mois pour le mois précédent. Agrège les Z journaliers du mois.
- **Clôture annuelle** : 1er janvier pour l'année précédente. Agrège les clôtures mensuelles.
- Chaque clôture est immutable une fois scellée. Aucune modification possible.
- Les clôtures sont chaînées entre elles (chaque Z journalier référence le précédent).
- Format export : PDF lisible + JSON structuré + signature détachée.

### Fichiers concernés

- `src/closures.ts` — `closeDay()`, `closeMonth()`, `closeYear()`
- `schemas/cloture.schema.ts` — schema clôture
- `src/crypto.ts` — `signClosure()` avec clé privée éditeur

### Tests de preuve

- `tests/cloture.test.ts` :
  - Vérifie qu'une clôture, une fois scellée, ne peut plus être modifiée
  - Vérifie que le total d'une clôture journalière correspond à la somme des encaissements de la période
  - Vérifie que la signature de la clôture est vérifiable avec la clé publique éditeur
  - Vérifie le chaînage entre clôtures successives

---

## 5. Restitution (exigence opérationnelle dérivée)

Bien que non listée explicitement comme cinquième pilier, la restitution est exigée par BOI-CF-COM-20-60 pour le contrôle DGFIP : le logiciel doit pouvoir présenter à un inspecteur les données d'encaissement de façon lisible.

### Implémentation

- `src/restitution.ts` — fonction `exportPeriod(from, to, format)` qui produit :
  - **Format CSV** lisible (un encaissement par ligne, colonnes standardisées)
  - **Format JSON** structuré complet (encaissements + corrections + clôtures + JET)
  - **Format PDF** synthèse imprimable (totaux, plages, signature éditeur)
- L'export inclut un fichier de vérification d'intégrité (manifest avec tous les hashes pour permettre à l'inspecteur de vérifier indépendamment la chaîne).

### Tests de preuve

- `tests/restitution.test.ts` :
  - Vérifie l'exhaustivité de l'export (aucune donnée manquante sur la période)
  - Vérifie la lisibilité du format CSV (parsable par un tableur standard)
  - Vérifie que le manifest d'intégrité permet de vérifier l'export sans accès à la base

---

## Journal des Événements Techniques (JET)

Bien que non listé dans les 4 exigences, le JET est requis pour démontrer la traçabilité.

### Implémentation

- `src/jet.ts` — chaque action sensible loguée immutablement :
  - Démarrage / arrêt système
  - Login / logout utilisateur
  - Tentative de modification refusée
  - Configuration TVA modifiée
  - Clôture déclenchée
  - Export demandé
  - Erreur applicative
  - Mode dégradé : entrée (`degraded_mode_enter`), sortie (`degraded_mode_exit`), réinjection manuelle (`manual_entry_injected`)
  - Configuration : modification modes de paiement (`payment_method_config_changed`), modification permissions opérateurs (`operator_config_changed`)
- Le JET est lui-même une chaîne hashée (cf. § 2).
- Conservé 10 ans (cf. § 3).
- Restituable (cf. § 5).

---

## 6. RGPD — Protection des données personnelles dans le périmètre du registre

### Fondement légal de la conservation

La conservation des données d'encaissement pendant 10 ans repose sur deux bases légales cumulatives :

- **Article L.123-22 du Code de commerce** : obligation de conserver les pièces justificatives comptables pendant 10 ans à compter de la clôture de l'exercice.
- **Article 286 I 3°bis du CGI** : obligation de conservation des données d'encaissement en vue du contrôle de l'administration fiscale.

Au sens du RGPD (Règlement UE 2016/679), la base légale applicable est l'**article 6(1)(c) — obligation légale** à laquelle le responsable du traitement est soumis.

### Données personnelles stockées (minimisation — art. 5(1)(c) RGPD)

Le module `caisseia` applique le principe de minimisation. Les données enregistrées par encaissement sont :

| Champ | Personnel ? | Justification |
|-------|-------------|---------------|
| Montant (centimes) | Non | Donnée financière, pas personnelle |
| Mode de paiement (espèces, CB, virement, Stripe, chèque) | Non | Catégorie, pas d'identifiant |
| Horodatage (timestamp UTC) | Non | Donnée technique |
| Hash de chaînage (SHA-256) | Non | Donnée technique cryptographique |
| Identifiant opérateur (userId) | Oui (pseudonyme) | Nécessaire pour la traçabilité JET — identifiant interne, pas nom civil |

**Par défaut, aucun nom de client, adresse, email ou autre donnée directement identifiante n'est stocké dans le schéma du registre.** Si une app consommatrice ajoute des champs personnels dans les métadonnées d'encaissement, la responsabilité RGPD incombe à cette app, pas au registre.

### Mesures de sécurité (art. 32 RGPD)

- **Contrôle d'accès base de données** : Postgres avec `REVOKE ALL` sur le rôle applicatif pour `UPDATE` et `DELETE` sur les tables d'encaissement — seul l'`INSERT` est autorisé (append-only). Un trigger base de données bloque toute tentative de contournement.
- **Sauvegardes chiffrées** : à mettre en place par l'intégrateur (recommandé : chiffrement au repos).
- **Chaînage cryptographique** : toute altération de données est détectable par vérification du hash chain SHA-256.
- **Accès réseau** : base de données accessible uniquement via un réseau privé ou localhost, pas d'exposition publique (recommandation à l'intégrateur).
- **Séparation des responsabilités** : les apps consommatrices n'accèdent aux données du registre que via les fonctions exportées du package, jamais en accès direct à la base.

### Registre des traitements (art. 30 RGPD) — entrée type

| Rubrique | Contenu |
|----------|---------|
| **Responsable du traitement** | L'assujetti qui utilise le logiciel |
| **Finalité** | Conservation des données d'encaissement conformément à l'art. 286 I 3°bis CGI et L.123-22 C. com. |
| **Base légale** | Art. 6(1)(c) RGPD — obligation légale |
| **Catégories de personnes** | Opérateurs de caisse (userId pseudonymisé) |
| **Catégories de données** | Montants, modes de paiement, horodatages, identifiants opérateurs pseudonymisés, hashes cryptographiques |
| **Destinataires** | DGFIP (sur contrôle), expert-comptable (accès lecture), prestataire d'hébergement |
| **Transferts hors UE** | Selon l'hébergement choisi par l'intégrateur |
| **Durée de conservation** | 10 ans à compter de l'enregistrement |
| **Mesures de sécurité** | Cf. section ci-dessus |
| **DPO** | Non obligatoire (< 250 salariés, pas de traitement à grande échelle de données sensibles) |

---

## Procédure de revue de ce document

À chaque release majeure (1.x → 2.x), ce document doit être revu et mis à jour :

1. Lecture complète par le mainteneur (MONTPC)
2. Peer review par un dev externe ou expert-comptable
3. Mise à jour des numéros de version dans l'entête
4. Mise à jour de [`CHANGELOG.md`](./CHANGELOG.md)
5. Génération d'une nouvelle attestation v2.0.0 ([`ATTESTATION.md`](./ATTESTATION.md))
7. Archivage versions précédentes dans `attestations/`

Tant que cette procédure n'est pas exécutée, **les apps consommatrices doivent rester sur la dernière version majeure attestée**.
