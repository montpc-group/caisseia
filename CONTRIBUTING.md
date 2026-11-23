# Contribuer

Merci de votre intérêt. Avant toute pull request :

1. **Lisez et acceptez le [CLA](./CLA.md).** Sans acceptation du CLA, une
   contribution ne peut pas être intégrée : MONTPC doit détenir les droits
   sur tout le code.
2. Les contrôles anti-fraude (inaltérabilité, chaînage, scellement des
   clôtures, journal) restent dans le cœur et restent testés. Une pull request
   qui les rend désactivables est refusée.
3. Tests : `pnpm test` (unitaires) et `pnpm test:postgres` (nécessite Docker)
   doivent passer ; toute correction de bug arrive avec le test qui la prouve.
4. Une version que vous modifiez et distribuez vous-même n'est pas couverte
   par l'attestation de MONTPC : vous en êtes l'éditeur (voir
   [ATTESTATION.md](./ATTESTATION.md)).

## Fusion (mainteneurs)

Une description de pull request peut être modifiée après coup ; la preuve
d'acceptation du CLA est donc le commit de fusion. Avant de fusionner, le
mainteneur recopie l'acceptation dans le commit de fusion, sous forme de
trailer :

```
CLA: v1.0 — Prénom Nom <e-mail> — PR #n
```

Pas de trailer `CLA:` = pas de fusion.

Sécurité : signalez une faille en privé à contact@montpc.com, jamais dans
une issue publique.
