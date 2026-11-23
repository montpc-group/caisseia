# Tests — Suite de preuve de conformité (art. 286 I 3° bis CGI)

> **Ces tests ne sont pas du QA cosmétique.**
> Ils sont la PREUVE en cas de contrôle DGFIP que le module respecte
> effectivement les exigences de l'article 286 I 3°bis CGI.

## Pourquoi cette suite est critique

Le contrôle DGFIP peut, en théorie, demander une démonstration que le logiciel respecte les 4 exigences (inaltérabilité, sécurisation, conservation, archivage). En pratique, l'inspecteur ne lira pas votre code source. Il regardera :

1. L'attestation signée
2. Les rapports de tests passing
3. Le procès-verbal des derniers exports d'intégrité

Cette suite de tests est le squelette de la documentation que vous présenterez. Chaque test démontre une exigence légale précise. **Un test absent = une faille dans la défense en cas de contrôle.**

## Mapping tests → exigences légales

| Fichier test | Exigence art. 286 CGI | Document |
|---|---|---|
| `inalterabilite.test.ts` | Inaltérabilité (§ 80) | COMPLIANCE.md § 1 |
| `chainage.test.ts` | Sécurisation (§ 100) | COMPLIANCE.md § 2 |
| `conservation.test.ts` | Conservation (§ 180) | COMPLIANCE.md § 3 |
| `cloture.test.ts` | Archivage (§ 220) | COMPLIANCE.md § 4 |
| `restitution.test.ts` | Restitution / contrôle DGFIP | COMPLIANCE.md § 5 |
| `jet.test.ts` | Traçabilité (dérivée) | COMPLIANCE.md § JET |

## Process avant signature attestation

1. `pnpm test:compliance` — **TOUS les tests doivent PASS**
2. Capture du rapport de test (texte ou HTML)
3. Archivage du rapport avec l'attestation de la version
4. Référencement dans le PDF d'attestation signé
5. Conservation 10 ans

## Process à chaque release

- **PATCH/MINOR** : tous les tests existants doivent passer. Pas de régression.
- **MAJOR** : revue complète de la suite. Ajout/modification des tests si l'évolution du code touche aux exigences. Génération d'un nouveau rapport de tests + nouvelle attestation.

## Process avant un contrôle DGFIP

Si un inspecteur arrive :

1. Présenter l'attestation
2. Lancer `pnpm test:compliance` en live devant l'inspecteur si demandé
3. Présenter le rapport archivé pour la version en production
4. Présenter l'export d'intégrité du jour

## Outils

- **vitest** comme runner (rapide, moderne, support TypeScript natif)
- **Reporter HTML** pour archivage lisible

## À faire

- [ ] Implémenter chaque test (actuellement tous en `expect.fail('NOT_IMPLEMENTED')`)
- [ ] Configurer vitest avec reporter HTML pour archivage
- [ ] Ajouter `conservation.test.ts` (manquant pour l'instant)
- [ ] Ajouter `jet.test.ts` (manquant pour l'instant)
- [ ] Ajouter un workflow CI qui exécute la suite à chaque PR
- [ ] Bloquer les release MAJOR sur 100% PASS de la suite
