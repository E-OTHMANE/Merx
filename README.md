# Merx

**La gestion d'un commerce de gros, tenue sur une tablette au comptoir.**

Catalogue, stock, ventes, crédit client, achats, encaissements. Un seul outil, en arabe et en français, qui continue de fonctionner quand le réseau tombe.

---

## Pour qui

Les grossistes du Maroc, en commençant par la cosmétique de Derb Omar — parfumerie, soins, produits de beauté.

| | |
|---|---|
| **Le patron** | Veut savoir ce qu'il a en stock, ce qu'on lui doit, et ce qu'il a gagné aujourd'hui. Sur son téléphone, en arabe. |
| **L'employé** | Veut sortir un bon vite, avec un client debout devant lui. Recevoir la marchandise, compter le stock. |

Aujourd'hui, tout cela se tient au carnet ou sur Excel : le catalogue n'est pas à jour, les prix se donnent à l'oral, les ruptures se subissent, les créances se perdent, et personne ne connaît le chiffre de la journée.

---

## Ce que Merx promet

**Trente minutes pour l'adopter.** Pas de formation, pas de paramétrage préalable. Un vendeur qui sait utiliser WhatsApp sait utiliser Merx.

**Un seul champ obligatoire pour créer un produit : le nom.** Tout le reste est facultatif. Une fonctionnalité qui manque de données se désactive en silence — ni avertissement, ni champ en rouge, ni rappel. Un vendeur à qui l'outil réclame des informations retourne au carnet.

**Rien ne bloque une vente.** Ni un stock à zéro, ni une donnée manquante. Le système signale, il n'interdit pas. Un grossiste vend ce qui est encore sur le camion.

**Sept jours sans réseau.** Ce n'est pas un cache de dépannage : les données vivent sur l'appareil, les bons se numérotent localement, et la synchronisation rattrape au retour. Une coupure n'arrête pas le comptoir.

**Le prix d'achat ne sort jamais.** Il est filtré côté serveur et n'existe pas dans les réponses faites à un employé — pas masqué à l'écran, absent. Une seule fuite et l'outil sort du magasin.

**Arabe et français, de droite à gauche.** Pas une traduction posée après coup : l'interface, la recherche tolérante aux fautes de frappe arabes, et l'impression thermique.

---

## Ce qu'il fait

Le cycle complet, et rien à côté :

```
produit → entrée de stock → vente → reçu → inventaire → encaissement
```

| Module | Contenu |
|---|---|
| **Catalogue** | Produits, marques, catégories, photos. Prix par palier de quantité. Import d'un fichier Excel ou CSV existant. Recherche tolérante aux fautes. |
| **Codes-barres** | Scan de l'EAN du fabricant avec la caméra. Étiquettes Code 128 imprimées en planche A4 pour les produits qui n'en ont pas. |
| **Stock** | Chaque mouvement tracé et justifié. Ajustements, inventaire au scan, comptage en cartons. |
| **Ventes** | Devis, commandes, bons de livraison. Prix recalculé à chaque changement de quantité. Retours. |
| **Impression** | Ticket thermique 80 mm, arabe compris, et PDF A4. |
| **Clients** | Fiche, grand livre, solde, plafond de crédit, relevé de compte. |
| **Règlements** | Encaissement en espèces, ventilation sur les bons, clôture de caisse. |
| **Achats** | Fournisseurs, réception de marchandise, coût moyen pondéré. |
| **Rapports** | Chiffre de la journée : vendu, encaissé, crédit accordé. Marges, réservées au patron. |

**Hors périmètre, et c'est un choix.** Pas de facturation fiscale — le document de référence est le *bon*, qui atteste que X a pris telle liste chez Y à telle date. Pas de dates de péremption : les vendeurs ne les saisissent pas, et une fonctionnalité dont la donnée n'arrive jamais ne sert à rien. Pas de multi-dépôt, pas de comptabilité, pas de boutique en ligne.

---

## Où en est le produit

Construction par étapes, une à la fois, chacune livrée et éprouvée avant la suivante.

| Étape | Contenu | État |
|---|---|---|
| 1 | Commerces, comptes, rôles, appareils, journal, réglages | **Livrée** |
| 2 | Catalogue, tarifs par palier, recherche, import, codes-barres | **Livrée** |
| 3 | Stock et mouvements | En cours |
| 4 | Écran de vente | À venir |
| 5 | Impression thermique et PDF | À venir |
| | *Arrêt : trois commerçants réels essaient l'outil* | |
| 6 à 11 | Clients et crédit, encaissement, réception, inventaire, hors-ligne, rapports | Arbitrées par ce qu'ils diront |

Ce qui fonctionne aujourd'hui, de bout en bout : créer un commerce et ses employés, saisir ou importer un catalogue de 2 000 références en moins d'une heure, le chercher, fixer une grille de prix par palier, scanner un code-barres et imprimer des étiquettes.

**L'arrêt après l'étape 5 est délibéré.** Les six étapes suivantes seront décidées par des commerçants qui auront tenu l'outil en main, pas par un document.

---

## Ce qui tient le produit

Quelques décisions structurelles, prises tôt parce qu'elles ne se rattrapent pas.

**Les données d'un commerce ne sortent pas de son commerce.** L'isolation est tenue par la base de données elle-même, pas par le code de l'application : une requête mal écrite ne peut pas ramener les lignes du voisin. Un balayage automatique le vérifie sur chaque table, y compris celles qui n'existent pas encore.

**Les mouvements de stock et les écritures de compte ne s'effacent jamais.** Une correction est une écriture inverse, jamais une rature. C'est ce qui rend l'historique fiable — et ce qui rend la synchronisation hors-ligne possible.

**Les numéros de bons sont attribués par l'appareil**, avec sa propre lettre : `BL-A-0001`. Le serveur n'en attribue aucun. Sans cela, sept jours hors-ligne seraient impossibles.

**Chaque règle importante est éprouvée par un test qui la casse.** On retire le garde, on vérifie qu'un test rouge le dit, on le remet. Un garde dont la suppression ne fait rien tomber n'est pas protégé, quel que soit le nom des tests.

---

## Pour l'équipe technique

Application web installable (PWA) — React, TypeScript, PostgreSQL. Base locale sur l'appareil, synchronisée par PowerSync. Impression ESC/POS et PDF.

| Document | Rôle |
|---|---|
| [`docs/CAHIER-DES-CHARGES.md`](docs/CAHIER-DES-CHARGES.md) | Le contexte métier et le pourquoi du périmètre |
| [`docs/SPEC.md`](docs/SPEC.md) | La spécification, source de vérité |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | Les récits, leurs critères d'acceptation et leur ordre |
| [`docs/BRAND-UI.md`](docs/BRAND-UI.md) | La charte : couleurs, typographie, composants, RTL |
| [`CLAUDE.md`](CLAUDE.md) | Les conventions et les pièges de l'environnement |

```bash
npm install
npx supabase start     # base de données locale
npx supabase db reset  # schéma et jeu d'essai
npm run dev            # http://localhost:5173
npm run test           # la suite complète
```
