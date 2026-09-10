# BRAND & UI — Spécification de style

**Produit :** Merx
**Version :** 1.1
**Documents associés :** `docs/SPEC.md`, `docs/BACKLOG.md`

---

## 1. Le brief

**Qui.** Un patron de 45 ans qui tient un magasin de cosmétique en gros à Derb Omar, et son employé de 25 ans.

**Où.** Debout derrière un comptoir. Lumière du jour qui rentre par la porte. Poussière. Une main tient le téléphone, l'autre la marchandise. Bruit.

**Quoi.** L'application affiche essentiellement des **chiffres** : des quantités, des prix, des soldes. Tout le reste est de la navigation autour de chiffres.

**Contre quoi on se bat.** Le carnet. Pas un concurrent logiciel — un cahier à 5 dirhams qui fonctionne sans batterie, sans réseau, et que le patron sait lire depuis vingt ans.

---

## 2. La direction visuelle

Le produit remplace le carnet. Il en hérite le langage visuel : **encre bleue de stylo bille, papier, dettes écrites en rouge.**

C'est un choix, pas un défaut d'ambition. Il donne trois choses :

- **Un bleu qui n'est pas le bleu SaaS.** Le bleu-violet saturé du Bic, pas le bleu corporate de tous les tableaux de bord.
- **Le rouge a déjà un sens** pour l'utilisateur : ce qu'on lui doit. On ne lui apprend rien.
- **Une continuité.** L'outil ressemble à ce qu'il remplace, il ne le renie pas.

**Ce qu'on ne fait pas :** ni zellige, ni terre cuite, ni palette « artisanat marocain ». C'est le Maroc des cartes postales, pas celui de Derb Omar — où le vrai décor est le carton, le scotch d'emballage et le néon.

---

## 3. Nom

### Le nom : **Merx**

Du latin *merx* — la marchandise. La racine de *commerce*, de *marchand*, de *mercantile*.

Quatre lettres, une syllabe, terminaison dure. Se dit à l'identique en français et en arabe. Aucun mot de darija à expliquer, aucune connotation régionale : c'est un nom de logiciel, pas un nom de quartier.

**Écriture.** `Merx` en latin, `ميركس` en arabe. Toujours capitale initiale, jamais tout en majuscules.

**Prononciation.** *merks*. À vérifier auprès de commerçants arabophones — le `x` final n'existe pas en arabe.

### À vérifier avant de s'engager

- [ ] **OMPIC** — recherche « Merx » dans les classes logiciel et services aux entreprises. C'est le seul point qui peut réellement bloquer.
- [ ] `merx.ma` disponible. Ne pas viser le `.com`, très probablement pris.
- [ ] Le dire au téléphone à trois commerçants : compris du premier coup, sans épeler ?

**Repli** si l'OMPIC est bloqué, dans le même registre : `Kontor`, `Arka`.

---

## 4. Logo

**Ce qu'il doit faire :** tenir dans un carré de 32 px sur une icône d'application, s'imprimer en noir sur un ticket thermique, et cohabiter avec de l'arabe.

**Direction.** Un monogramme construit sur le **X de Merx**, dessiné comme deux traits de stylo croisés : amorce épaisse, sortie fine, léger décalage comme une main qui trace vite. Le X est la lettre la plus reconnaissable du nom et la plus lisible à 32 px.

Lecture secondaire voulue : le X est aussi la marque que le commerçant pose à côté d'une ligne réglée dans son carnet.

**Le mot-symbole existe en deux versions**, jamais mélangées dans un même bloc : `Merx` en latin, `ميركس` en arabe. L'interface affiche celle de la langue active.

**Règles**
- Monochrome par défaut. Encre sur papier, ou blanc sur encre.
- Une seule couleur sur le ticket thermique — il n'imprime que du noir.
- Aucun dégradé, aucune ombre portée, aucun effet 3D.
- Zone de respiration : la hauteur du monogramme sur les quatre côtés.

**À éviter :** le panier, la caisse enregistreuse, le graphique en hausse, la planète connectée. Tout le monde les a déjà.

---

## 5. Couleur

### Encre — primaire

Le bleu du stylo bille. Actions principales, navigation active, identité.

| Ton | Hex | Usage |
|---|---|---|
| 950 | `#0E1440` | Texte sur fond clair, maximum de contraste |
| 900 | `#16205C` | Titres |
| 800 | `#1E2B75` | Bouton primaire, état pressé |
| 700 | `#24338A` | Bouton primaire, survol |
| **600** | **`#2B3C99`** | **Primaire. Boutons, liens, onglet actif** |
| 500 | `#3A4EB8` | Éléments interactifs secondaires |
| 400 | `#6274D1` | Icônes sur fond sombre |
| 300 | `#96A3E3` | Bordures accentuées |
| 200 | `#C4CBF0` | Fond de sélection |
| 100 | `#E3E7F9` | Fond de ligne active |
| 50 | `#F2F4FD` | Fond de section |

### Rouge — dette et danger

Ce que le client doit. Le sens est déjà connu de l'utilisateur.

| Ton | Hex | Usage |
|---|---|---|
| 700 | `#9B1C15` | Texte de dette en souffrance |
| **600** | **`#C0271E`** | **Solde débiteur, erreur, suppression** |
| 500 | `#D9433A` | Bordure d'alerte |
| 100 | `#FBE5E3` | Fond d'alerte |

**Règle.** Le rouge ne sert qu'à deux choses : l'argent qu'on vous doit, et une action destructrice. Jamais décoratif.

### Papier — neutres

Volontairement légèrement froids. Un crème chaud ferait « papier ancien » ; on veut du papier de bureau, pas du parchemin.

| Ton | Hex | Usage |
|---|---|---|
| 950 | `#101216` | Texte principal |
| 900 | `#1C1F25` | Titres |
| 800 | `#2E323B` | Texte secondaire fort |
| 700 | `#434955` | Texte secondaire |
| 600 | `#5A6170` | Libellés |
| 500 | `#767E8E` | Texte désactivé — **jamais sur fond blanc en dessous de 14 px** |
| 400 | `#9BA3B2` | Icônes inactives |
| 300 | `#C3C9D4` | Bordures |
| 200 | `#DDE1E8` | Séparateurs |
| 100 | `#EDEFF3` | Fond de zone |
| 50 | `#F7F8FA` | Fond d'application |
| — | `#FFFFFF` | Surfaces, cartes, champs |

### Fonctionnels

| Rôle | Hex | Usage |
|---|---|---|
| Validé | `#107C4F` | Payé, synchronisé, confirmé |
| Validé, fond | `#E3F4EC` | — |
| Attention | `#B45309` | Hors-ligne, stock bas, plafond approché |
| Attention, fond | `#FDF0DC` | — |
| Synchronisation | `#3A4EB8` | En cours d'envoi |

### Règles de couleur

- **Six couleurs au total.** Encre, rouge, vert, ambre, neutres, blanc. Rien d'autre.
- **La couleur porte du sens, jamais de la décoration.** Un écran normal est en encre et en neutres. Le rouge et l'ambre sont des événements.
- **Aucun dégradé nulle part.** Ni en fond, ni sur un bouton, ni derrière un chiffre.
- **Une seule ombre portée**, celle des éléments flottants : `0 2px 8px rgba(16,18,22,0.12)`. Les cartes n'en ont pas — elles ont une bordure.
- **Contraste minimum 4.5:1** sur tout texte. L'écran est lu en plein soleil. Le gris clair sur blanc est interdit, quelle que soit l'élégance apparente.

---

## 6. Typographie

**IBM Plex Sans Arabic** et **IBM Plex Sans.** Une seule famille, deux écritures, dessinées ensemble : les montants en chiffres latins et le texte en arabe ne se contredisent pas sur la même ligne.

### Échelle

| Rôle | Taille / interligne | Graisse | Usage |
|---|---|---|---|
| Chiffre principal | 40 / 44 | 600 | Le total d'un bon, le solde d'un client |
| Chiffre secondaire | 28 / 32 | 600 | Sous-totaux, chiffre du jour |
| Titre | 22 / 28 | 600 | Titre d'écran |
| Sous-titre | 18 / 26 | 500 | Nom de produit dans une liste |
| Corps | 16 / 24 | 400 | Texte courant. **Plancher absolu pour toute donnée.** |
| Libellé | 14 / 20 | 500 | Étiquettes de champ |
| Mention | 13 / 18 | 400 | Horodatage, état de synchronisation |

**Rien en dessous de 13 px.** Rien de gris clair en dessous de 14 px.

### Les chiffres sont le sujet

**Tout montant et toute quantité s'affichent en chiffres tabulaires** — `font-variant-numeric: tabular-nums`. Sans cela, les colonnes de dirhams ne s'alignent pas et l'écran devient illisible.

**Chiffres latins partout**, y compris en arabe. C'est ce que les commerçants utilisent pour l'argent.

Format monétaire : `1 250,00 DH`. Espace insécable comme séparateur de milliers, virgule décimale, `DH` après le montant.

### Règles d'écriture

- Casse de phrase partout. Pas de MAJUSCULES ESPACÉES en étiquette.
- Un bouton dit ce qu'il fait : « Enregistrer le bon », pas « Valider ».
- Le même mot du début à la fin d'un parcours. Le bouton « Encaisser » produit le message « Encaissé ».
- Une erreur explique ce qui s'est passé et comment le réparer. Elle ne s'excuse pas.
- Un écran vide invite à agir : « Aucun produit. Importez votre catalogue » — pas « Aucune donnée disponible ».

---

## 7. Espacement et cibles tactiles

Base de **4 px**. Toutes les valeurs en sont des multiples : 4, 8, 12, 16, 24, 32, 48, 64.

| Élément | Minimum |
|---|---|
| Cible tactile | **48 × 48 px** |
| Bouton principal, hauteur | 56 px |
| Ligne de liste, hauteur | 64 px |
| Espace entre cibles | 8 px |
| Marge latérale d'écran | 16 px |

48 px, pas 44. L'utilisateur est debout, parfois avec les mains sales.

**Les actions principales sont dans le tiers bas de l'écran**, atteignables au pouce. Le haut est réservé à l'information.

**Rayon de bordure :** 8 px sur les champs et les cartes, 10 px sur les boutons, 0 sur les lignes de tableau. Une seule valeur partout est un défaut de conception, pas une cohérence.

---

## 8. Composants

**Boutons.** Trois seulement. Primaire — fond encre 600, texte blanc. Secondaire — fond blanc, bordure neutre 300, texte encre 700. Destructif — fond blanc, bordure rouge 500, texte rouge 600. Pas de quatrième variante.

**Champs.** Hauteur 56 px. Bordure neutre 300, encre 600 au focus, avec un contour visible de 2 px. Le libellé est au-dessus, jamais un simple placeholder — le placeholder disparaît à la saisie et l'utilisateur ne sait plus ce qu'il remplit.

**Cartes.** Fond blanc, bordure neutre 200, pas d'ombre. Une carte se distingue par sa bordure et son espacement.

**Lignes de liste.** 64 px de haut. Photo produit à gauche (à droite en RTL), nom au-dessus, référence et stock en dessous, prix aligné au bord opposé en chiffres tabulaires.

**États.** Chaque écran affichant des données en possède quatre : chargement, vide, erreur, contenu. Un écran de chargement montre la forme de ce qui arrive, pas un rond qui tourne au centre.

**Indicateur de synchronisation.** Toujours visible, jamais modal. Un point coloré et un mot : vert « à jour », bleu « envoi », ambre « hors ligne » avec le nombre de documents en attente.

---

## 9. Arabe et RTL

- Utiliser les propriétés logiques Tailwind : `ms-`, `me-`, `ps-`, `pe-`, `text-start`, `text-end`. **Jamais** `ml-`, `mr-`, `text-left`, `text-right`.
- Initialiser avec `shadcn init --rtl`, qui applique la conversion automatiquement.
- Les icônes directionnelles — flèches, chevrons — se retournent. Les autres jamais : une icône de poubelle retournée reste une poubelle mal dessinée.
- Les chiffres, les montants et les références restent en latin, sens inchangé, y compris dans une phrase arabe.
- Le retournement se teste sur un vrai écran, pas seulement dans l'inspecteur.

---

## 10. Mouvement

**Presque rien.**

Une animation répond à un geste de l'utilisateur et montre ce qui a changé : un panneau qui s'ouvre, une ligne qui s'ajoute, une confirmation. 150 ms, courbe standard.

Aucune animation d'entrée d'écran, aucun fondu au chargement, aucune transition au survol des cartes. Sur un Android d'entrée de gamme, ces effets ne décorent pas — ils ralentissent.

`prefers-reduced-motion` respecté partout.

---

## 11. Ce qu'on ne fait pas

- Les dégradés en fond ou sur les boutons.
- Le mode sombre en V1. Une chose de plus à tester, pour un usage en plein jour.
- Les illustrations d'écran vide. Une phrase et un bouton suffisent.
- Les graphiques décoratifs. Un graphique n'apparaît que si le chiffre seul ne suffit pas.
- Les modales de confirmation sur les actions courantes. Réservées à ce qui est irréversible.
- Les icônes sans texte. Le patron a 45 ans et n'a pas grandi avec ces conventions.
- Le gris clair sur blanc. Élégant à l'écran du concepteur, illisible derrière un comptoir.

---

## 12. Plancher de qualité

Chaque écran, sans exception :

- [ ] Contraste minimum 4,5:1 sur tout texte
- [ ] Cibles tactiles d'au moins 48 px
- [ ] Aucune donnée sous 16 px
- [ ] Chiffres tabulaires sur tout montant et toute quantité
- [ ] Fonctionne en arabe RTL
- [ ] Quatre états couverts : chargement, vide, erreur, contenu
- [ ] Focus clavier visible
- [ ] `prefers-reduced-motion` respecté
- [ ] Testé sur un Android d'entrée de gamme, pas seulement en simulateur
- [ ] Lisible en plein soleil

---

## 13. À trancher

1. `Merx` : vérification OMPIC et domaine `merx.ma`
2. Domaine et dépôt de marque
3. Le monogramme : dessiné par toi, ou confié à un illustrateur
4. Mode sombre : jamais, ou après la V1