# Attestation individuelle — Modèle BOFIP

> Modèle conforme à BOI-LETTRE-000242 (mise à jour 25/03/2026).
> Source : https://bofip.impots.gouv.fr/bofip/10692-PGP.html
>
> **Ne pas signer tant que la version logicielle n'est pas figée.**

> **Portée de l'attestation.** Elle couvre uniquement la version publiée par
> MONTPC qui y est désignée (numéro de version **et** empreinte du paquet).
> Une version modifiée, ou compilée et distribuée par un tiers, n'est pas
> couverte : celui qui la modifie ou la distribue en est l'éditeur et doit
> fournir sa propre attestation ou son propre certificat. Le code source étant
> publié sous AGPL-3.0, cette règle s'applique à toute version dérivée.

---

## VOLET 1 — À remplir et signer par l'éditeur

### Attestation individuelle relative à l'utilisation d'un logiciel ou d'un système de caisse sécurisé

Je soussigné, **[NOM Prénom du dirigeant MONTPC]**, représentant légal de la société **MONTPC** (SAS / SASU au capital de [MONTANT] €, SIREN 993 766 369, dont le siège social est situé [ADRESSE_SIEGE_MONTPC]), éditeur du logiciel / système de caisse :

> **CAISSEIA**
> Registre inaltérable des encaissements (art. 286 I 3° bis CGI).

atteste que les fonctionnalités de caisse de ce logiciel, mis sur le marché à compter du **[DATE_FIRST_RELEASE]**, dans sa version n° **[VERSION_EXACTE — ex: 1.0.0]**, sous le numéro de licence **[LICENCE_OU_NA]**, satisfont aux conditions d'**inaltérabilité, de sécurisation, de conservation et d'archivage des données** en vue du contrôle de l'administration fiscale, prévues au **3° bis du I de l'article 286 du code général des impôts**.

J'atteste que la dernière version majeure de ce logiciel ou système est identifiée avec la racine suivante : **[X.0.0]** et que les versions mineures développées ultérieurement à cette version majeure sont ou seront identifiées par les subdivisions suivantes de cette racine : **[X.Y.Z]**.

Je m'engage à ce que ces subdivisions ne soient utilisées par MONTPC que pour l'identification des versions mineures ultérieures, à l'exclusion de toute version majeure. Les versions majeures et mineures du logiciel ou système s'entendent au sens du III-A § 340 du BOI-TVA-DECLA-30-10-30.

#### Périmètre couvert par cette attestation

Cette attestation couvre les fonctionnalités suivantes :

- Enregistrement des règlements clients (encaissements en espèces, par carte bancaire, par virement bancaire, par paiement Stripe, par chèque)
- Inaltérabilité des enregistrements via event-sourcing append-only
- Sécurisation par chaînage cryptographique SHA-256 des enregistrements
- Conservation des données sur 10 années glissantes minimum
- Archivage par clôtures journalière, mensuelle et annuelle scellées cryptographiquement
- Restitution sur demande au format CSV, JSON et PDF avec manifest d'intégrité
- Journal des Événements Techniques (JET) tracant les actions sensibles

#### Périmètre NON couvert par cette attestation

Les fonctionnalités suivantes ne sont **pas** couvertes par cette attestation :

- Génération des factures (gérée par chaque application intégratrice — voir son attestation propre si applicable)
- Transmission des factures électroniques B2B vers les Plateformes Agréées (régime distinct de la réforme e-invoicing 2026/2027)
- Gestion comptable au sens de l'enregistrement comptable (relève d'un logiciel de comptabilité distinct)
- Tickets de caisse imprimés sur supports physiques (relève de l'app consommatrice et de son matériel)

---

#### Mention légale obligatoire

> Il est rappelé que l'établissement d'une fausse attestation est un délit pénal passible de **trois ans d'emprisonnement et de 45 000 € d'amende** (code pénal, art. 441-1). L'usage d'une fausse attestation est passible des mêmes peines.

---

**Fait à** : [VILLE]
**Le** : [DATE_SIGNATURE]

**Signature et tampon de la société éditrice :**

> [NOM Prénom du dirigeant]
> [QUALITÉ — Président de SAS / SASU, Gérant, etc.]
> MONTPC

---
---

## VOLET 2 — À compléter par l'entreprise utilisatrice

> Cette attestation n'a de valeur que si son volet 2 est dûment complété
> et signé par l'entreprise utilisatrice du logiciel.

Je soussigné, **[NOM Prénom du dirigeant utilisateur]**, représentant légal de la société / entreprise individuelle **[RAISON_SOCIALE_UTILISATEUR]**, **SIRET [SIRET_UTILISATEUR]**, certifie avoir acquis ou téléchargé le **[DATE_ACQUISITION]**, auprès de **MONTPC**, le logiciel / système de caisse mentionné au volet 1 de cette attestation.

J'atteste utiliser ce logiciel / système de caisse pour enregistrer les règlements de mes clients particuliers, conformément à la réglementation fiscale en vigueur, depuis le **[DATE_DEMARRAGE_UTILISATION]**.

Le logiciel est utilisé via l'application : **[NOM_APP_CONSOMMATRICE]**, version **[VERSION_APP]**.

#### Mention légale obligatoire

> Il est rappelé que l'établissement d'une fausse attestation est un délit pénal passible de trois ans d'emprisonnement et de 45 000 € d'amende (code pénal, art. 441-1). L'usage d'une fausse attestation est passible des mêmes peines.

---

**Fait à** : [VILLE_UTILISATEUR]
**Le** : [DATE_SIGNATURE_UTILISATEUR]

**Signature de l'utilisateur :**

> [NOM Prénom]
> [QUALITÉ — Président, Gérant, Auto-entrepreneur, etc.]

---

## Dépôt et conservation

Cette attestation n'est pas à déposer auprès d'une autorité. Elle est conservée par l'éditeur et l'utilisateur et présentée uniquement sur contrôle (art. L.80 O du Livre des Procédures Fiscales). Il n'existe aucune obligation d'enregistrement auprès de la DGFIP, de la CNIL (pour l'attestation elle-même), ni d'aucun ministère.

---

## Registre des attestations délivrées (GAP-7)

L'éditeur (MONTPC) tient un registre de toutes les attestations délivrées, permettant de répondre à la question « qui utilise votre logiciel ? » en cas de contrôle.

### Structure du registre

L'éditeur tient un registre des attestations délivrées (par exemple `register.json`) avec la structure suivante :

```json
{
  "editor": {
    "name": "MONTPC SASU",
    "siret": "993 766 369 00010"
  },
  "attestations": [
    {
      "userSiret": "XXX XXX XXX XXXXX",
      "userRaisonSociale": "Nom de l'entreprise utilisatrice",
      "app": "nom-de-l-application",
      "nf525Version": "1.0.0",
      "appVersion": "X.Y.Z",
      "dateDelivered": "2027-01-15",
      "dateSigned": "2027-01-20",
      "status": "active | superseded | revoked",
      "supersededBy": null,
      "pdfPath": "attestations/1.0.0/entreprise-slug.pdf",
      "notes": ""
    }
  ]
}
```

### Champs

| Champ | Type | Description |
|-------|------|-------------|
| `userSiret` | string | SIRET de l'entreprise utilisatrice |
| `userRaisonSociale` | string | Raison sociale de l'utilisateur |
| `app` | string | Application consommatrice |
| `nf525Version` | string | Version du module attestée |
| `appVersion` | string | Version de l'app au moment de la délivrance |
| `dateDelivered` | string (ISO date) | Date d'envoi de l'attestation |
| `dateSigned` | string (ISO date) | Date de signature par l'utilisateur |
| `status` | enum | `active` = en cours, `superseded` = remplacée par une nouvelle version, `revoked` = révoquée |
| `supersededBy` | string \| null | Référence à l'attestation qui la remplace (si `superseded`) |
| `pdfPath` | string | Chemin vers le PDF signé archivé |
| `notes` | string | Remarques libres |

### Règles de gestion

- À chaque major bump (v1.x → v2.x), toutes les attestations v1.x passent en `superseded` et de nouvelles attestations v2.x sont émises.
- Une attestation `revoked` signifie que l'utilisateur a cessé d'utiliser le logiciel ou que l'éditeur a retiré l'accès.
- Le registre est conservé 10 ans minimum, au même titre que les données d'encaissement.

---

## Notes de procédure

### Délivrance de l'attestation

- L'attestation est **individuelle et nominative**. Une attestation par utilisateur final.
- Volet 1 généré à la souscription, envoyé en PDF à l'utilisateur qui complète et signe le Volet 2.
- Si l'éditeur utilise lui-même le logiciel : il signe les volets 1 et 2 (éditeur ET utilisateur).

### Archivage

- Le PDF signé (volets 1 + 2) est archivé par l'éditeur, classé par version et par utilisateur
- Conservation 10 ans minimum

### Régénération à chaque major bump

À chaque passage majeur (v1.x → v2.x) :
1. Tous les utilisateurs reçoivent une **nouvelle attestation** à signer pour la nouvelle version
2. L'attestation v1.x reste juridiquement valide pour les périodes pendant lesquelles l'utilisateur était sur v1.x
3. La transition entre versions doit être documentée précisément (date de bascule par utilisateur)

### Génération par la CLI

`generateAttestation()` (et la CLI `caisseia-generate-attestation`) pré-remplit le Volet 1 avec la version du package et le Volet 2 avec les informations de l'utilisateur (raison sociale, SIRET, application, date de début), et produit le PDF à signer.
