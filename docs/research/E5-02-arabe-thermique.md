# E5-02 — Arabe sur imprimante thermique 80 mm : recherche

Recherche seule, aucun code. Date : 2026-10-20. Alimente E5-01 (bon thermique) et E5-02
(arabe sur ticket) du BACKLOG.

**Statut des preuves.** Rien ici n'a été mesuré sur une imprimante. Chaque affirmation est
étiquetée : **[source]** lue dans la page citée, **[forum]** témoignage isolé, **[inférence]**
déduction de ma part, **[à tester]** à trancher sur le matériel. Plusieurs hôtes
(`download4.epson.biz`, `qz.io`, MDN, forums App Inventor) étaient injoignables depuis la
session cloud : ce que j'en dis vient de l'extrait renvoyé par le moteur de recherche, pas de
la page lue en entier. C'est signalé là où ça compte.

## 1. Conclusion

1. **Le rendu en image est la voie à retenir, dès E5-01.** Le texte arabe ne se règle pas
   proprement par les jeux de caractères de l'imprimante : pas de liaison des lettres, pas de
   sens droite-à-gauche, et le résultat dépend du modèle précis. La note d'E5-02 du BACKLOG
   (« prévoir le rendu image dès le départ ») est confirmée.
2. **Le navigateur fait déjà le travail difficile** (liaison, bidi, mélange avec les chiffres
   latins) : on dessine le ticket entier dans un `canvas`, on le seuille en 1 bit, on l'envoie
   en `GS v 0`. Il n'y a pas de bibliothèque de façonnage à embarquer **[inférence]** — voir § 4
   pour ce qui reste à vérifier.
3. **Le vrai risque n'est pas l'arabe, c'est le transport.** Une PWA ne peut pas ouvrir un
   socket TCP vers le port 9100 d'une imprimante réseau. La SPEC § 2 (« ESC/POS 80 mm en réseau
   Wi-Fi ») suppose un chemin que le navigateur n'a pas. À décider avant E5-01 : § 6.
4. **Marché marocain : je n'ai rien de solide.** Pas de liste fiable des modèles vendus ni de
   leur prise en charge de l'arabe. § 7 dit ce qui est établi et ce qui ne l'est pas.

## 2. Option A — jeux de caractères natifs (`ESC t n`)

### Ce qui existe

- La commande `ESC t n` choisit une page de codes. Le référentiel générique d'Epson liste deux
  pages arabes : **page 37 = PC864**, **page 50 = WPC1256**. Epson précise que les pages et jeux
  pris en charge **diffèrent selon le modèle** et renvoie à la fiche de chaque modèle.
  [Epson, extrait de recherche — page non lue en entier](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/esc_lt.html)
- Le manuel d'une autre marque (Diebold Nixdorf P1200) numérote séparément PC720, PC864 et
  WPC1256 : les numéros ne sont pas ceux d'Epson.
  [Diebold Nixdorf P1200, manuel](https://www.dieboldnixdorf.com/-/media/diebold/files/retail/peripherals-en/printers/p1200-prog-manual.pdf)
- Windows-1256 est l'encodage que le projet utilise déjà à l'import (SPEC § 5, repli
  `windows-1256`), mais c'est l'encodage d'un *fichier* ; ce que l'imprimante sait faire d'un
  octet 1256 est une autre question.
  [Windows-1256](https://en.wikipedia.org/wiki/Windows-1256)

### Ce qui manque, et ça ne se contourne pas

- **Pas de liaison, pas de bidi.** L'auteur d'EscPosEncoder (bibliothèque ESC/POS JS), 2018 :
  « Things like right-to-left support and glyph shaping is simply not supported » — on imprime
  les caractères que la page de codes fournit, et c'est tout ; il conseille de « create a
  bitmap, draw a text string and print that ». **[source, lue]**
  [EscPosEncoder #4](https://github.com/NielsLeenheer/EscPosEncoder/issues/4)
- Les octets d'une page de codes sont des **caractères isolés**, non des formes contextuelles :
  une chaîne arabe envoyée telle quelle sort lettres détachées et dans l'ordre logique, donc
  **inversée** sur un support qui écrit de gauche à droite **[inférence, cohérente avec les
  témoignages ci-dessous]**.
- Contournement classique : refaçonner et réordonner **côté hôte** (reshaper + algorithme bidi),
  puis envoyer des *formes de présentation* si la page de codes les contient (PC864 en contient,
  1256 non). Fragile : dépend du modèle, de la police interne, et reste en chasse fixe. Un
  fil de forum Python/ESC/POS note que PIL ne façonne pas et qu'il a fallu un autre moteur, et
  fixe la page sur **cp720** plutôt que cp864 **[forum]**.
  [python-forum.io](https://python-forum.io/post-22634.html),
  [arabic-reshaper](https://pypi.org/project/arabic-reshaper/)
- **Police à chasse fixe** : un commentateur fait remarquer que l'imprimante ne peut pas
  reproduire une phrase arabe proportionnelle **[forum]**.
  [b4x](https://www.b4x.com/android/forum/threads/esc-pos-thermal-printers-showing-incorrect-arabic-characters.144258/)
- **Les déclarations de support sont peu fiables.** QZ rapporte que la doc de programmation de
  l'Epson TM-T20 annonce Cp1252 alors que l'imprimante fait en réalité Cp850 **[source, extrait
  de recherche]** — une déclaration de page de codes ne remplace pas un ticket de test.
  [QZ — Raw Encoding](https://qz.io/docs/Raw-Encoding)
- **Le mode par défaut casse tout.** Envoyer de l'UTF-8 sans choisir de page fait sortir l'arabe
  en glyphes d'allure chinoise (Sunmi V2 ; Xprinter XP-P810), alors que le latin et les chiffres
  sortent juste. **[source, lue ; forum]**
  [athar #96](https://github.com/abdallahelficky-wq/athar/pull/96),
  [App Inventor, XP-P810](https://community.appinventor.mit.edu/t/unable-to-print-in-arabic-on-xprinter-xp-p810/96322)
- **Annonces commerciales vagues.** Des fiches Xprinter (XP-N160II, XP-C300H) listent « Arabic »
  sans numéro de page ; c'est du marketing, pas une garantie. **[source, extrait de recherche]**
  [allo.ua, XP-N160II](https://allo.ua/ua/pos-terminal/pos-printer-xprinter-xp-n160ii-lan_1.html)

**Verdict A.** Au mieux : arabe en chasse fixe, formes isolées ou à moitié liées, selon le
modèle, avec un risque d'inversion. Incompatible avec « lisible, liaison et sens respectés »
(E5-02, critère 1) sur un parc d'imprimantes hétérogène. À garder, au plus, comme **repli
sans arabe** : lignes latines (références, montants, totaux) en texte natif.

## 3. Option B — ticket rendu en image, imprimé en mode graphique

### Principe

Dessiner le ticket dans un `canvas` à la largeur exacte de la tête, convertir en 1 bit, envoyer
en bandes `GS v 0`. Le moteur de texte du navigateur applique la liaison, le bidi et le choix de
chasse ; l'imprimante ne voit que des points. Le même mécanisme sert déjà au logo et au QR.

### Ce que les sources établissent

- **Corrige exactement le défaut décrit** : un projet Sunmi V2 passe d'un texte arabe en
  « mojibake » à un ticket dessiné dans un canvas « using the browser's own RTL and Arabic
  shaping », seuillé en 1 bit, envoyé en `GS v 0`. **[source, lue]**
  [athar #96](https://github.com/abdallahelficky-wq/athar/pull/96)
- **Largeur** : 80 mm = **576 points** (58 mm = 384). Le même projet note qu'une largeur par
  défaut de 80 mm déborde sur une tête de 58 mm : la largeur est un **réglage**, pas une
  constante. **[source, lue]** Le TM-T20 d'Epson est lui aussi un 80 mm ; je n'ai pas lu sa
  largeur de zone imprimable — **[à tester]** (certains modèles 80 mm sont à 512 points).
- **Seuil fixe, pas de tramage** pour le petit texte : le tramage ajoute du grain et dégrade
  les glyphes. **[source, lue]** La bibliothèque `escpos-web-print` tramé au contraire par
  défaut (adapté aux logos, pas au texte). **[source, lue]**
  [escpos-web-print](https://github.com/hamzaabamboo/escpos-web-print)
- **Découpage** : bandes d'au plus 200 points de haut, lots d'au plus 256 Ko, une commande
  jamais coupée en deux ; un ticket complet fait environ 44 Ko. Cap du canvas à 4 000 px
  signalé en revue comme risque de **troncature des tickets longs**. **[source, lue]**
  [athar #96](https://github.com/abdallahelficky-wq/athar/pull/96)
- **Cadence** : `escpos-web-print` temporise (40 ms entre écritures, 50 ms entre bandes,
  300 ms à la fin) et conseille de réduire la taille de paquet si le ticket sort brouillé ou
  s'arrête à mi-chemin. **[source, lue]**
- **Toutes les imprimantes n'ont pas `GS v 0`** : un modèle NP-3511 ne l'a pas et demande
  `ESC b` ; la spécification Star le marque invalide dans l'un de ses modes. **[source, extrait
  de recherche]** [DEV — Georgian receipt](https://dev.to/azeem_ullah/printing-a-receipt-with-a-logo-and-georgian-text-from-a-net-windows-service-without-systemdrawing-3b5h),
  [Star ESC/POS spec](https://www.starmicronics.com/support/Mannualfolder/escpos_cm_en.pdf)

### Coûts connus de B

| Point | Effet | Mitigation |
|---|---|---|
| Vitesse | une image est plus lourde et plus lente que du texte ; un ticket entier se compte en dizaines de Ko | 44 Ko mesuré sur un ticket complet (athar) ; `GS v 0` par bandes. Débit réel **[à tester]** sur Wi-Fi |
| Netteté | 203 dpi, 1 bit : petits corps illisibles | police sans empattement, ≥ 22–24 points de tête, seuil fixe ; **[à tester]** avec IBM Plex Sans Arabic, la police de BRAND-UI § 5 |
| Papier | image = plus de noir, donc plus de chauffe | aplats évités ; une seule couleur déjà exigée (BRAND-UI) |
| Police | doit être **embarquée** (hors ligne) et chargée avant le dessin | `document.fonts.load()` avant `fillText` **[inférence]** ; la PWA est hors ligne 7 jours |
| Hors ligne | rien ne dépend du réseau pour le rendu | favorable : tout est local |

**Verdict B.** Seule option qui tient les trois critères textuels d'E5-02 (liaison, sens,
mélange avec chiffres latins) sans dépendre du modèle. Les chiffres latins dans une phrase
arabe sont réordonnés par l'algorithme bidi du navigateur ; BRAND-UI § 9 les veut en latin,
sens inchangé : **[à tester]** sur un ticket réel avec montant, référence et nom arabe sur la
même ligne.

## 4. Liaison, bidi, chiffres : ce qui reste à vérifier

- Le façonnage du canvas dépend du moteur de texte du navigateur (Chrome Android sur les
  tablettes visées) ; `canvas.direction = 'rtl'` existe. Je n'ai pas pu lire la page MDN
  (hôte injoignable) : **[à tester]** que `fillText` lie bien les lettres avec la police
  embarquée, sur une vraie tablette bon marché.
- Les polices doivent porter les glyphes arabes **et** les formes contextuelles ; vérifié pour
  les bibliothèques Python (PIL ne façonne pas seul), pas pour le canvas navigateur.
- Alignement : une ligne arabe se justifie à droite, une ligne « libellé … montant » inverse
  l'ordre des colonnes. Le dessin du ticket (colonnes, tabulations, montants alignés) est de
  la mise en page à la main, pas du texte qui coule — à prévoir en E5-01.

## 5. Comparaison

| Critère E5-02 | A. Page de codes | B. Image |
|---|---|---|
| Liaison des lettres | non (formes isolées ou presentation forms selon page) | oui, par le navigateur |
| Sens droite-à-gauche | non, à inverser à la main | oui |
| Arabe + chiffres latins | à reconstruire à la main | bidi du navigateur |
| Dépend du modèle | **oui**, et la doc peut mentir | peu : `GS v 0` presque universel, hors exceptions |
| Vitesse | rapide | plus lent (dizaines de Ko) |
| Netteté | police interne | à régler (seuil, corps) |
| Recommandation | repli latin seulement | **retenue** |

## 6. Point de blocage hors arabe : le transport depuis une PWA

La SPEC § 2 retient « ESC/POS 80 mm en réseau Wi-Fi ». Les sources convergent :

- **Un navigateur n'ouvre pas de socket TCP brut** vers un port 9100. Une bibliothèque Flutter
  le dit en toutes lettres et contourne par extension de navigateur + hôte natif ; sa page note
  aussi qu'il faut un délai plus long pour réveiller une imprimante Wi-Fi en veille. **[source,
  lue en extrait]** [flutter_esc_pos_network_universal](https://pub.dev/documentation/flutter_esc_pos_network_universal/1.0.5/)
- Pistes recensées : (1) **relais HTTP/WebSocket** sur le réseau local qui transmet l'ESC/POS au
  port 9100 (image Docker `escpos-printer-rest-api`, base64 → 9100, CORS, jeton optionnel) ;
  (2) **agent sortant** sur un PC/Raspberry du commerce qui se connecte au cloud, sans
  ouverture de port (`print-proxy`) ; (3) **serveur web intégré** des imprimantes Epson (ePOS-Print)
  et Star (WebPRNT), cité comme seule voie navigateur sans composant installé — **à vérifier
  modèle par modèle**, absent des modèles d'entrée de gamme ; (4) **WebUSB / Web Bluetooth**,
  réels sur Chrome Android mais **hors périmètre** réseau (SPEC § 2 : le Bluetooth « n'est pas
  fiable »). **[source, extraits de recherche]**
  [escpos-printer-rest-api](https://hub.docker.com/r/alhafoudh/escpos-printer-rest-api),
  [print-proxy](https://hub.docker.com/r/drinklist/print-proxy),
  [WCPOS — Printer Setup](https://docs.wcpos.com/hardware/printers.md),
  [Openbravo — WebBluetooth/WebUSB](https://www.openbravo.com/blog/?p=63804)
- **Non couvert par mes recherches** : contenu mixte (une PWA en HTTPS qui appelle un relais en
  `http://` sur le LAN), et la règle récente de Chrome sur l'accès au réseau local. À lire
  dans la documentation de Chrome avant de choisir.

**Conséquence.** « Imprimante réseau » ne suffit pas à définir E5-01 : il faut décider *qui
ouvre le socket*. C'est une décision d'architecture (et la SPEC § 2 dit qu'un pilote qui impose
autre chose « déclenche un wrapper Capacitor, pas une réécriture »). Je ne tranche pas ici.

## 7. Imprimantes bon marché au Maroc : ce qui est établi

**Établi (annonces, non vérifiées au-delà de la page) :**

- Epson TM-T20X **version réseau** (Ethernet) annoncée **1 299 DH** à Rabat — Ethernet, pas
  Wi-Fi. [Avito](https://www.avito.ma/fr/yacoub_el_mansour/imprimantes/Imprimante_Tickets_Epson_TM_T20X_Réseau_58392320.htm)
- Imprimantes 80 mm d'occasion ou d'entrée de gamme entre **550 et 700 DH** (ZKTeco, PRINTLY,
  WDLINK chez Marjane Mall), ports USB ; rien n'indique LAN ou Wi-Fi.
  [Avito — imprimante ticket](https://www.avito.ma/sp/misc/imprimante-ticket),
  [Marjane Mall — WDLINK](https://www.marjanemall.ma/p/wdlink-imprimante-ticket-thermique-haut-qualite-80mm-aaaqz22919)
- Modèles génériques Wi-Fi + LAN + USB existent (MJ8330, Eightt EPOS-81W) mais **sans prix
  marocain trouvé**.

**Non établi — ne pas le déduire :**

- Quelles marques dominent chez les revendeurs (Xprinter, Hoin, Rongta, Epson, Star) : **aucun
  résultat** pour ces marques sur des sites marocains.
- Si ces modèles ont une page arabe, laquelle, et si elle est fiable. Aucune source ne le dit ;
  pour les Xprinter, seulement des fiches commerciales vagues et un témoignage d'échec (XP-P810,
  arabe sorti en caractères chinois).
- Une imprimante **Wi-Fi intégrée** est rare à ce prix : l'entrée de gamme est USB, puis
  Ethernet. Un module Wi-Fi ou un pont Ethernet-Wi-Fi est un coût à ajouter **[inférence]**.

**Ce que cela implique pour le choix du matériel (inférence, non mesurée) :** le rendu image
dispense de se préoccuper des pages de codes ; il suffit que le modèle accepte `GS v 0` et ait
une tête de 576 points. C'est précisément ce qui rend l'option B robuste face à un parc
hétérogène et mal documenté.

## 8. Plan de test physique proposé pour E5-02 (critère 4 : « pas seulement en émulation »)

Aucun émulateur ne remplace ce test : les émulateurs ESC/POS interprètent les commandes, ils ne
reproduisent ni le mode par défaut, ni la tête, ni la cadence.

1. **Ticket de test** : nom arabe long, nom arabe avec chiffre latin, ligne « libellé ... montant
   » en arabe, référence latine dans une phrase arabe, montant à 2 décimales, ticket de 60
   lignes (test de la troncature).
2. **Matériel** : au moins deux imprimantes de marques différentes, dont la moins chère
   trouvée au souk ; noter la largeur de tête mesurée (576 ou 512 ?) et si `GS v 0` passe.
3. **Mesures** : liaison correcte des lettres, ordre, alignement, netteté au corps choisi,
   temps d'impression d'un ticket de 60 lignes sur Wi-Fi.
4. **Repli** : si `GS v 0` échoue sur un modèle, tester `ESC *` / `ESC b` avant de renoncer à
   l'image.

## 9. Décisions à prendre (par l'utilisateur)

1. **Transport** (§ 6) : relais LAN, agent sortant, serveur web intégré, ou wrapper Capacitor ?
2. **Largeur de tête** : réglage par imprimante (recommandé), ou 576 par défaut.
3. **Hors arabe** : le ticket reste-t-il tout en image, ou lignes latines en texte natif pour
   gagner en vitesse ? (Ma recommandation : tout en image, une seule voie à tester.)
4. **Police du ticket** : IBM Plex Sans Arabic est la police de BRAND-UI § 5 ; à valider au
   corps d'impression.

## Sources

- [EscPosEncoder #4, Unable to print arabic](https://github.com/NielsLeenheer/EscPosEncoder/issues/4)
- [athar #96, bitmap Arabic receipt (Sunmi V2)](https://github.com/abdallahelficky-wq/athar/pull/96)
- [escpos-web-print](https://github.com/hamzaabamboo/escpos-web-print)
- [Epson ESC/POS reference, ESC t](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/esc_lt.html) *(extrait)*
- [Diebold Nixdorf P1200 programming manual](https://www.dieboldnixdorf.com/-/media/diebold/files/retail/peripherals-en/printers/p1200-prog-manual.pdf) *(extrait)*
- [Star Micronics ESC/POS command spec](https://www.starmicronics.com/support/Mannualfolder/escpos_cm_en.pdf) *(extrait)*
- [QZ — Raw Encoding](https://qz.io/docs/Raw-Encoding) *(extrait)*
- [b4x, ESC/POS printers showing incorrect Arabic](https://www.b4x.com/android/forum/threads/esc-pos-thermal-printers-showing-incorrect-arabic-characters.144258/) *(extrait)*
- [App Inventor, Xprinter XP-P810](https://community.appinventor.mit.edu/t/unable-to-print-in-arabic-on-xprinter-xp-p810/96322) *(extrait)*
- [python-forum.io, Arabic on ESC/POS](https://python-forum.io/post-22634.html) *(extrait)*
- [arabic-reshaper](https://pypi.org/project/arabic-reshaper/) *(extrait)*
- [flutter_esc_pos_network_universal](https://pub.dev/documentation/flutter_esc_pos_network_universal/1.0.5/) *(extrait)*
- [escpos-printer-rest-api](https://hub.docker.com/r/alhafoudh/escpos-printer-rest-api), [print-proxy](https://hub.docker.com/r/drinklist/print-proxy) *(extraits)*
- [WCPOS printers](https://docs.wcpos.com/hardware/printers.md), [Openbravo WebBluetooth/WebUSB](https://www.openbravo.com/blog/?p=63804) *(extraits)*
- [DEV, receipt with Georgian text](https://dev.to/azeem_ullah/printing-a-receipt-with-a-logo-and-georgian-text-from-a-net-windows-service-without-systemdrawing-3b5h) *(extrait)*
- [Avito, Epson TM-T20X réseau](https://www.avito.ma/fr/yacoub_el_mansour/imprimantes/Imprimante_Tickets_Epson_TM_T20X_Réseau_58392320.htm), [Avito, imprimante ticket](https://www.avito.ma/sp/misc/imprimante-ticket), [Marjane Mall, WDLINK](https://www.marjanemall.ma/p/wdlink-imprimante-ticket-thermique-haut-qualite-80mm-aaaqz22919) *(extraits)*
- [allo.ua, Xprinter XP-N160II LAN](https://allo.ua/ua/pos-terminal/pos-printer-xprinter-xp-n160ii-lan_1.html) *(extrait)*

*(extrait) = lu seulement à travers le résumé du moteur de recherche, page non ouverte.*
