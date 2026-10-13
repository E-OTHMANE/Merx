/*
 * Comment une quantité de stock se lit. M2 — E3-02.
 *
 * Sorti de l'écran pour une raison de forme et une de fond. De forme : un
 * fichier qui exporte un composant n'exporte rien d'autre, sinon le
 * rafraîchissement à chaud ne marche plus (`react-refresh/only-export-components`).
 * De fond : la liste des produits et la fiche variante lisent les mêmes
 * niveaux et doivent les dire des **mêmes mots** — deux formulations
 * divergeraient, et « 0 » finirait par s'afficher là où il faut lire « stock
 * non saisi ».
 *
 * **Pas `quantity.ts`**, bien que ce soit le nom juste : le composant d'à côté
 * est `Quantity.tsx`, et deux fichiers d'un même dossier qui ne diffèrent que
 * par la casse sont le *même* fichier pour Windows et macOS. L'import
 * `@/modules/stock/Quantity` se résolvait vers celui-ci, qui n'exporte aucun
 * composant, et React recevait `undefined` — douze tests rouges sur « Element
 * type is invalid », à l'exécution seulement : `tsc` et `eslint` ne voient
 * rien, et sur un CI Linux rien ne se serait produit.
 * `src/test/caseCollision.test.ts` refuse désormais la faute à la racine.
 */

import { quantityText } from '@/lib/decimal'

/** Ce qu'une quantité vaut à l'œil. */
export type QuantityTone = 'plain' | 'negative' | 'unknown'

/** Un niveau, réduit à ce dont la lecture a besoin. */
export interface ReadableLevel {
  quantity: string | null
  lastMovementAt: string | null
}

/**
 * Trois cas, et ils ne se confondent pas :
 *
 *   — **jamais saisi** : la ligne existe depuis la naissance de la variante,
 *     la quantité vaut zéro, et personne n'a compté. Écrire « 0 » présenterait
 *     comme certaine une valeur qui ne l'est pas (SPEC § 2.5) ;
 *   — **négatif** : un repère, jamais une alerte ni un blocage (RÈGLE M2-3) —
 *     un grossiste vend ce qui est encore sur le camion ;
 *   — **le reste** : un nombre.
 *
 * Le quatrième cas, `quantity === null`, ne doit pas arriver depuis E3-02. Il
 * est dit plutôt que maquillé en zéro : un état impossible qui s'affiche comme
 * un état normal ne se découvre jamais.
 */
export function readQuantity(level: ReadableLevel): { text: string; tone: QuantityTone } {
  if (level.quantity === null) return { text: 'Stock indisponible', tone: 'unknown' }
  if (level.lastMovementAt === null) return { text: 'Stock non saisi', tone: 'unknown' }

  const text = quantityText(level.quantity)
  return { text, tone: text.startsWith('-') ? 'negative' : 'plain' }
}

export const QUANTITY_TONE: Readonly<Record<QuantityTone, string>> = {
  plain: 'text-paper-900',
  /*
   * BRAND-UI § 5, « Attention » : #B45309 sur #FDF0DC. Le fond double la
   * couleur, pour que le repère se lise en plein soleil et sans distinguer les
   * teintes. Rien de plus : ni icône, ni `role="alert"`, ni modale (M2-3).
   */
  negative: 'rounded-field bg-amber-100 px-2 text-amber-700',
  unknown: 'text-paper-700',
}
