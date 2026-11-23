# Obligations de l'utilisateur — Logiciel d'encaissement (art. 286 I 3° bis CGI)

> Document à remettre à chaque utilisateur du logiciel d'encaissement
> intégrant le module `caisseia`.
>
> **Éditeur** : MONTPC SASU — SIRET 993 766 369 00010
> **Base légale** : Article 286 I 3°bis du Code Général des Impôts
> **Référence BOFIP** : BOI-TVA-DECLA-30-10-30 §300

---

## 1. Réaliser les clôtures quotidiennes

Vous devez vous assurer qu'une **clôture journalière (Z journalier)** est réalisée chaque jour d'activité. Cette clôture scelle les encaissements de la journée et garantit leur intégrité.

- Si votre application est configurée pour déclencher elle-même les clôtures (planification) : vérifiez régulièrement dans l'interface que les clôtures sont bien générées (section « Conformité > Clôtures »).
- Si les clôtures sont manuelles : déclenchez-les chaque soir avant fermeture.

Les clôtures mensuelles et annuelles sont déclenchées par votre logiciel de caisse (`closeMonth` / `closeYear`).

**Ne jamais sauter une clôture.** Une interruption dans la chaîne de clôtures compromet la traçabilité exigée par l'administration fiscale.

---

## 2. Enregistrer TOUS les encaissements dans le système

**Aucun paiement client ne doit être enregistré en dehors du logiciel.** Qu'il s'agisse d'un paiement en espèces, par carte bancaire, par chèque, par virement ou via Stripe, chaque encaissement doit transiter par le système conforme.

- Ne pas tenir de registre parallèle (cahier, tableur, autre logiciel) pour les encaissements courants.
- En cas d'indisponibilité du système (panne), utiliser le registre manuel de mode dégradé fourni par MONTPC et réinjecter les encaissements dès la reprise (cf. procédure mode dégradé dans la documentation technique).

---

## 3. Ne pas modifier les données d'encaissement

Les données enregistrées sont **inaltérables** par conception. Vous ne pouvez pas modifier ni supprimer un encaissement passé.

- Pour corriger une erreur : utilisez la fonction **correction** du logiciel, qui crée un nouvel enregistrement référençant l'original. L'original reste intact.
- Toute tentative de modification directe est bloquée par le système et tracée dans le Journal des Événements Techniques (JET).

---

## 4. Conserver et présenter l'attestation individuelle

MONTPC vous a remis une **attestation individuelle** (volets 1 et 2) correspondant à la version du logiciel que vous utilisez.

Vous devez :

- **Conserver cette attestation** pendant toute la durée d'utilisation du logiciel et 10 ans après.
- **La présenter sur demande** lors d'un contrôle de l'administration fiscale (DGFIP). L'inspecteur peut se présenter sans préavis.
- **Vérifier la concordance** entre la version attestée et la version installée. En cas de doute, consultez la section « À propos » ou « Conformité » de votre application.

> **Attention** : le défaut de présentation de l'attestation est sanctionné par une amende de **7 500 € par système d'encaissement** (art. 1770 duodecies CGI), renouvelable tous les 60 jours après mise en demeure.

---

## 5. Informer MONTPC de tout changement

Vous devez notifier MONTPC si :

- Vous **changez votre mode d'encaissement** (ajout d'un nouveau mode de paiement, passage à un autre prestataire, etc.).
- Vous **cessez d'utiliser le logiciel** pour enregistrer vos encaissements.
- Vous **modifiez votre statut fiscal** (changement de régime TVA, cessation d'activité, passage en franchise en base).
- Vous constatez un **dysfonctionnement** affectant l'enregistrement ou l'intégrité des encaissements.

Contact : `contact@montpc.com` (ou via votre espace dans l'application).

---

## 6. Mettre à jour le logiciel sur demande de l'éditeur

Lorsque MONTPC publie une **mise à jour de compliance obligatoire** (correction d'un défaut affectant la conformité), vous disposez d'un délai raisonnable pour l'appliquer.

- Les mises à jour mineures (même version majeure) ne nécessitent pas de nouvelle attestation.
- Les mises à jour majeures (changement de version majeure) seront accompagnées d'une **nouvelle attestation** à signer.

---

## 7. Ce que le logiciel NE couvre PAS

Le module `caisseia` couvre **uniquement** l'enregistrement sécurisé des encaissements. Il ne couvre pas :

- La **génération des factures** (mentions obligatoires, numérotation, envoi) — relève de votre application ou d'un autre outil.
- La **facturation électronique B2B** (réforme e-invoicing 2026-2027) — régime distinct.
- La **comptabilité générale** (écritures, FEC, bilan) — relève de votre expert-comptable et de son logiciel.
- Les **obligations déclaratives TVA** — relèvent de votre expert-comptable.

---

## Rappel des sanctions

| Infraction | Sanction | Base légale |
|------------|----------|-------------|
| Logiciel non conforme | 7 500 € / système, renouvelable /60j après mise en demeure | Art. 1770 duodecies CGI |
| Défaut de présentation de l'attestation | 7 500 € | Art. 1770 duodecies CGI |
| Fausse attestation | 3 ans d'emprisonnement + 45 000 € | Art. 441-1 Code pénal |

---

## Acceptation

En utilisant le logiciel d'encaissement intégrant `caisseia`, vous reconnaissez avoir pris connaissance de ces obligations et vous engagez à les respecter.

**Date** : _______________
**Nom et prénom** : _______________
**Raison sociale** : _______________
**SIRET** : _______________
**Signature** : _______________
