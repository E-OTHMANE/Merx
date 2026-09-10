# Cahier des charges — Merx

SaaS de gestion pour commerces de gros.

**Version :** 3.0
**Date :** 2 septembre 2026
**Métier cible V1 :** cosmétique, parfumerie, soins
**Document associé :** `docs/SPEC.md`

> Ce document répond au **pourquoi** et au **quoi**. Le **comment** est dans `SPEC.md`. Aucune table, aucun champ ici.

---

## 1. Contexte

Derb Omar, à Casablanca, concentre plusieurs centaines de commerces de gros sur un périmètre où l'on circule à pied. Ils approvisionnent des détaillants dans tout le Royaume. Cette densité est l'atout commercial du projet : la prospection à pied et la recommandation entre commerçants y fonctionnent mieux que partout ailleurs.

Le premier métier visé est la **cosmétique** : parfumerie, soins de la peau, produits de beauté. Le produit est conçu pour s'étendre à d'autres métiers, mais rien n'est construit pour eux tant que la cosmétique n'est pas maîtrisée.

### Ce qui ne va pas aujourd'hui

La gestion se fait au carnet ou sur Excel.

| Problème | Conséquence |
|---|---|
| Catalogue non structuré | Aucune offre à jour, prix communiqués oralement |
| Stock inconnu | Ruptures subies, surstock dormant |
| Inventaire manuel | Plusieurs jours perturbés, écarts inexpliqués |
| Crédit client au carnet | Créances perdues, encours total inconnu |
| Aucun chiffre de journée | Le patron ne sait pas ce qu'il a gagné |

### Positionnement

Outil de **gestion commerciale**. Il produit des devis, des bons et des reçus, suit le stock, les clients et les encaissements.

La facturation fiscale est **hors périmètre**. Le document de référence est le *bon* : il atteste que X a pris telle liste chez Y à telle date. Aucune obligation de forme, aucune surface réglementaire.

---

## 2. Objectifs

1. Remplacer le carnet par un outil adopté en moins de trente minutes.
2. Donner au patron son chiffre de journée : vendu, encaissé, crédit accordé.
3. Rendre l'entrée du catalogue assez rapide pour que le commerçant ne renonce pas avant d'avoir commencé.
4. Fonctionner plusieurs jours sans réseau.

### Critères de succès

| Indicateur | Cible |
|---|---|
| Import du catalogue initial | 2 000 références en moins d'1 h |
| Saisie d'un bon de 10 lignes | Moins de 90 secondes |
| Formation d'un vendeur | Moins de 30 minutes |
| Autonomie sans réseau | 7 jours, sans dégradation |
| Rétention à 3 mois | Supérieure à 70 % `[À VALIDER]` |

---

## 3. Périmètre V1

**Le cycle complet, rien à côté.**

produit → entrée de stock → vente → reçu → inventaire → encaissement

**Inclus :** catalogue et tarifs par palier, étiquettes code-barres, stock et inventaire, devis et bons, impression thermique et PDF, clients et crédit, réception fournisseur, encaissement en espèces, rapport de journée, fonctionnement hors-ligne, arabe et français.

**Exclus :** dates de péremption, packs métier, multi-dépôt, chèques et traites, frais annexes à la réception, comptabilité, facturation fiscale, boutique en ligne, WhatsApp API, champs personnalisés.

Trois exclusions méritent une justification.

**Les dates de péremption.** Les vendeurs ne les suivent pas. Une fonctionnalité dont la donnée n'est jamais saisie ne sert à rien, et réclamer cette saisie alourdit le travail au lieu de l'alléger. Reportée jusqu'à demande explicite.

**Le multi-dépôt.** Les commerces visés n'en ont pas. Aucun écran, aucun transfert, aucune notion de dépôt visible.

**Les champs personnalisés.** Un commerçant ne configurera jamais un schéma, et une recherche performante ne se construit pas sur des attributs arbitraires. Les besoins spécifiques passeront par un pack écrit par l'éditeur.

---

## 4. Principe directeur : alléger, jamais alourdir

Règle qui prime sur toute autre considération fonctionnelle.

- Un seul champ obligatoire pour créer un produit : le nom. Idem pour un client.
- Toute autre information est facultative. Une fonctionnalité privée de sa donnée se désactive en silence : aucun avertissement, aucun champ en rouge, aucun rappel.
- Rien ne bloque une vente. Ni un stock à zéro, ni une donnée manquante. Le système signale, il n'interdit pas.

Un vendeur à qui l'outil réclame des informations retourne au carnet.

---

## 5. Utilisateurs

Trois rôles. Droits détaillés dans `SPEC.md` § 3.

| Rôle | Qui | Ce qu'il attend |
|---|---|---|
| Super-admin | L'éditeur | Comptes, support, abonnements |
| Patron | 40-60 ans, arabophone | Stock, encours, marge, chiffre du jour. Sur son téléphone. |
| Employé | 20-35 ans, à l'aise sur mobile | Sortir un bon vite, client debout devant lui. Recevoir la marchandise, compter le stock. |

**Deux décisions issues de ces profils.**

Le prix d'achat n'est visible que du patron, par filtrage côté serveur. Une seule fuite vers un vendeur et l'outil sort du magasin.

L'employé peut négocier, mais jamais sous le prix plancher fixé par le patron. Sans cette limite, rien n'empêche de vendre à prix coûtant.

---

## 6. Hors-ligne

**Exigence : plusieurs jours sans réseau, pas quelques heures.**

L'application embarque une base locale qui fait autorité quand l'appareil est hors ligne. Le serveur réconcilie au retour du réseau. Ce n'est pas un cache.

Conséquences assumées :

- Les numéros de bons sont attribués localement, avec un préfixe d'appareil.
- Hors ligne, le stock et le solde client sont affichés avec leur date de dernière synchronisation. Ne jamais présenter une valeur périmée comme certaine.
- Le rapport de journée se calcule localement. Il fonctionne sans réseau.

`[À VALIDER]` **Un appareil par commerce en V1.** Hypothèse retenue pour garder la réconciliation simple. Deux tablettes hors ligne simultanément vendant le même stock est un problème réel, non traité en V1.

Le moteur de synchronisation n'est pas écrit sur mesure : une brique existante est utilisée. L'écrire soi-même coûterait des mois et les erreurs de cohérence ne se découvriraient que chez un client.

Note pratique : si l'électricité est coupée, la tablette et l'imprimante sont hors service de toute façon. Le scénario réellement couvert est la coupure d'internet, pas la coupure de courant.

---

## 7. Exigences non fonctionnelles

- Arabe et français, bascule instantanée, RTL complet
- Utilisable debout, au doigt, sur un écran de téléphone
- Photo produit systématique — ne jamais dépendre du seul texte
- Recherche tolérante aux fautes, sur référence partielle
- Recherche produit : moins de 300 ms sur 10 000 références
- Démarrage : moins de 3 secondes
- Téléphone et tablette Android d'entrée de gamme `[À VALIDER : configuration minimale]`
- Imprimante thermique 80 mm **en réseau Wi-Fi** — le Bluetooth depuis une application web n'est pas fiable
- Droits vérifiés côté serveur ; l'interface masque, elle ne protège pas
- Journal d'audit sur les actions sensibles
- Conformité loi 09-08 et formalités CNDP `[À VALIDER]`

---

## 8. Concurrence

Sont présents au Maroc : des éditeurs locaux (iGoodar, TIJARA, Gestipro, Devinstock, Tadbeery, Mahaal), des solutions de caisse (SystemeMaroc, MaCaisse), et des ERP déployés par intégrateurs (Odoo, Sage, EBP). Les tarifs vont de la gratuité à plusieurs dizaines de milliers de dirhams par an.

Une étude sectorielle avance que près de 78 % des grossistes marocains travaillent encore au cahier et sur Excel. `[À VALIDER — vérifier la source primaire avant tout usage commercial]`

**Ne peuvent pas différencier :** le prix seul, ni « un Odoo plus simple ».

**Axes défendables :**

1. **L'entrée du catalogue.** Personne ne résout l'import de 2 000 références non structurées.
2. **Le hors-ligne réel**, sur plusieurs jours, traité comme une exigence et non comme une option.
3. **L'arabe du métier**, pas une traduction littéraire.
4. **La légèreté de saisie**, quand les concurrents multiplient les champs obligatoires.

---

## 9. Contraintes projet

Une personne, assistée d'outils d'IA pour le code.

Le code n'est plus le goulot d'étranglement. Le sont :

- **Le support.** Un commerçant n'achète pas sans un numéro qui répond. Un vendeur bloqué un samedi à 11 h est une urgence.
- **L'onboarding.** La saisie du catalogue des premiers clients sera longue. La budgéter en temps, ou la facturer.
- **La discipline de périmètre.** Avec un assistant qui code vite, la tentation est de tout construire. Le lotissement existe pour l'empêcher.

---

## 10. Risques

| Risque | Gravité | Traitement |
|---|---|---|
| Le catalogue ne rentre pas assez vite → abandon | Critique | Traité en étape 2, avant tout le reste |
| La synchronisation perd une vente | Critique | Brique existante, mouvements en ajout seul |
| Le support devient impossible au-delà de N clients | Élevée | Plafonner le nombre de pilotes |
| Fuite du prix d'achat vers un vendeur | Élevée | Filtrage serveur, pas masquage d'interface |
| Deux appareils hors ligne divergent | Moyenne | Un appareil par commerce en V1 |
| Un client final exige un document fiscal | Moyenne | Décision commerciale, pas technique |
| Concurrent local gratuit | Moyenne | Différencier sur la profondeur métier |

---

## 11. Lotissement

Détail par étape dans `SPEC.md` § 11.

| Lot | Contenu | Fin de lot |
|---|---|---|
| **Lot 0** | Fondations : schéma, isolation, auth, administration | Créer un commerce, inviter un utilisateur |
| **Lot 1** | Catalogue et import | 2 000 références en moins d'1 h |
| **Lot 2** | Stock, ventes, impression | Un bon sort sur une vraie imprimante |
| **Lot 3** | Clients, crédit, encaissement, réception, inventaire | Le cycle complet tourne |
| **Lot 4** | Hors-ligne | 7 jours en mode avion |
| **Lot 5** | Rapports | Chiffre de journée, hors ligne |

**Arrêt obligatoire à la fin du Lot 2.** Aller voir trois commerçants réels. Les lots suivants sont arbitrés par ce qu'ils diront, pas par ce document.

`[À VALIDER]` Aucune durée n'est chiffrée. Les estimer après le Lot 1, sur du réalisé.

**Après la V1**, dans cet ordre et uniquement sur demande client : déclinaisons (teintes, contenances), chèques et traites, frais annexes à la réception, multi-dépôt.

---

## 12. Modèle économique `[À VALIDER]`

- Abonnement mensuel par commerce, palier selon utilisateurs ou nombre de références
- Frais d'onboarding facturés — couvre le coût réel de la saisie et qualifie le prospect

Repères marché : de la gratuité (iGoodar, Odoo Community) à environ 350 MAD/mois pour une solution locale de caisse, jusqu'à plusieurs dizaines de milliers de dirhams par an pour un ERP.

Le support étant le vrai coût, une offre gratuite est probablement plus dangereuse ici qu'ailleurs.

---

## 13. Questions ouvertes

1. Un ou plusieurs appareils par commerce ?
2. L'onboarding du catalogue est-il facturé, offert, ou vendu comme prestation ?
3. Combien de pilotes avant l'ouverture commerciale ? Recommandation : trois.
4. Structure juridique et encaissement des abonnements ?
5. Qui répond au téléphone quand un vendeur est bloqué un samedi à 11 h ?