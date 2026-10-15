/*
 * Le bon en cours de saisie — E4-03, E4-04, hors écran.
 *
 * Ce qui décide d'une ligne, d'une quantité et d'un prix se mesure sans monter
 * React. L'écran en a son propre fichier (`SaleScreen.test.tsx`) : il y mesure
 * les gestes, pas ces règles.
 *
 * La résolution par palier elle-même appartient à E2-03 et a son test
 * (`pricing.test.ts`) : ici on mesure qu'elle est **rejouée**, jamais figée.
 */

import { describe, expect, it } from 'vitest'

import type { PriceBasis } from '@/modules/catalogue'
import {
  addArticle,
  forceUnitPrice,
  lineBelowFloor,
  releaseUnitPrice,
  removeLine,
  saleIsComplete,
  setQuantity,
  setUnitPrice,
  stepQuantity,
  type SaleLine,
} from '@/modules/sales/sale'

const CREME = {
  variantId: 'v1',
  productId: 'p1',
  name: 'Crème hydratante',
  reference: 'CRM-1',
  photoPath: null,
}

const SAVON = {
  variantId: 'v2',
  productId: 'p2',
  name: 'Savon noir',
  reference: 'SAV-1',
  photoPath: null,
}

/* Une grille de grossiste : 12 DH à l'unité, 11 dès 10, 9,50 dès 48. */
const BREAKS = [
  { minQty: '1.000', unitPrice: '12.00' },
  { minQty: '10.000', unitPrice: '11.00' },
  { minQty: '48.000', unitPrice: '9.50' },
]

/* Ce qu'une lecture rend pour une variante : ses paliers et son plancher. */
const basis = (
  breaks: PriceBasis['breaks'],
  floorPrice: string | null = null,
): PriceBasis => ({ breaks, floorPrice })

const GRID = basis(BREAKS)
const NO_GRID = basis([])

const line = (lines: readonly SaleLine[], variantId: string): SaleLine =>
  lines.find((candidate) => candidate.variantId === variantId)!

describe('l’ajout d’un article', () => {
  it('ouvre une ligne à une pièce, au prix de la grille', () => {
    const lines = addArticle([], CREME, GRID)

    expect(lines).toHaveLength(1)
    expect(line(lines, 'v1').quantity).toBe('1')
    expect(line(lines, 'v1').unitPrice).toBe('12,00')
    expect(line(lines, 'v1').priceSource).toBe('auto')
  })

  /*
   * Les trois entrées de la RÈGLE M3-6 aboutissent à la même ligne : le même
   * article ajouté deux fois ne fait pas deux lignes qui disent la même chose.
   */
  it('fusionne le même article, et ajoute une pièce', () => {
    const lines = addArticle(addArticle([], CREME, GRID), CREME, GRID)

    expect(lines).toHaveLength(1)
    expect(line(lines, 'v1').quantity).toBe('2')
  })

  it('garde l’ordre d’arrivée à la fusion', () => {
    let lines = addArticle([], CREME, GRID)
    lines = addArticle(lines, SAVON, GRID)
    lines = addArticle(lines, CREME, GRID)

    expect(lines.map((l) => l.variantId)).toEqual(['v1', 'v2'])
  })

  it('n’empêche rien quand la grille ne donne aucun prix', () => {
    const lines = addArticle([], CREME, NO_GRID)

    expect(lines).toHaveLength(1)
    expect(line(lines, 'v1').unitPrice).toBe('')
    expect(line(lines, 'v1').priceSource).toBe('manual')
    expect(saleIsComplete(lines)).toBe(false)
  })

  it('n’empêche rien quand le palier n’a pas de prix', () => {
    const lines = addArticle([], CREME, basis([{ minQty: '1.000', unitPrice: null }]))

    expect(line(lines, 'v1').unitPrice).toBe('')
    expect(line(lines, 'v1').priceSource).toBe('manual')
  })
})

describe('la quantité', () => {
  it('se tape, et remplace le 1 d’origine', () => {
    const lines = setQuantity(addArticle([], CREME, GRID), 'v1', '120')

    expect(line(lines, 'v1').quantity).toBe('120')
  })

  it('refuse ce que la base refuserait, à la frappe', () => {
    const lines = setQuantity(addArticle([], CREME, GRID), 'v1', '12a,5005')

    // Trois décimales au plus (`quantity`), et pas de lettre.
    expect(line(lines, 'v1').quantity).toBe('12,500')
  })

  it('se laisse vider, sans qu’un 1 revienne sous les doigts', () => {
    const lines = setQuantity(addArticle([], CREME, GRID), 'v1', '')

    expect(line(lines, 'v1').quantity).toBe('')
    expect(saleIsComplete(lines)).toBe(false)
  })

  it('monte et descend d’une pièce par les boutons, sans passer sous 1', () => {
    let lines = stepQuantity(addArticle([], CREME, GRID), 'v1', 1)
    expect(line(lines, 'v1').quantity).toBe('2')

    lines = stepQuantity(lines, 'v1', -1)
    expect(line(lines, 'v1').quantity).toBe('1')

    lines = stepQuantity(lines, 'v1', -1)
    expect(line(lines, 'v1').quantity).toBe('1')
  })

  it('ne touche pas aux autres lignes', () => {
    let lines = addArticle(addArticle([], CREME, GRID), SAVON, GRID)
    lines = setQuantity(lines, 'v1', '24')

    expect(line(lines, 'v2').quantity).toBe('1')
  })
})

describe('le prix suit la quantité, jamais figé', () => {
  it('bascule toute la ligne au palier supérieur', () => {
    const lines = setQuantity(addArticle([], CREME, GRID), 'v1', '12')

    expect(line(lines, 'v1').unitPrice).toBe('11,00')
    expect(line(lines, 'v1').priceSource).toBe('auto')
  })

  it('redescend quand la quantité redescend', () => {
    let lines = setQuantity(addArticle([], CREME, GRID), 'v1', '48')
    expect(line(lines, 'v1').unitPrice).toBe('9,50')

    lines = setQuantity(lines, 'v1', '8')
    expect(line(lines, 'v1').unitPrice).toBe('12,00')
  })

  it('suit aussi les boutons d’ajustement', () => {
    let lines = setQuantity(addArticle([], CREME, GRID), 'v1', '9')
    expect(line(lines, 'v1').unitPrice).toBe('12,00')

    lines = stepQuantity(lines, 'v1', 1)
    expect(line(lines, 'v1').unitPrice).toBe('11,00')
  })

  /*
   * Une grille qui ne commence qu'à 10 ne dit rien de 5 pièces (E2-03 : on
   * n'étend pas la ligne du bas, ce serait réinterpréter la RÈGLE M1-2). Le
   * vendeur saisit alors le prix — et il reparaît automatique dès que la
   * quantité retombe dans la grille.
   */
  it('laisse saisir là où la grille ne répond pas, puis reprend la main', () => {
    const wholesale = basis([{ minQty: '10.000', unitPrice: '11.00' }])
    let lines = addArticle([], CREME, wholesale)
    expect(line(lines, 'v1').priceSource).toBe('manual')

    lines = setUnitPrice(lines, 'v1', '13,40')
    expect(line(lines, 'v1').unitPrice).toBe('13,40')
    expect(saleIsComplete(lines)).toBe(true)

    lines = setQuantity(lines, 'v1', '10')
    expect(line(lines, 'v1').unitPrice).toBe('11,00')
    expect(line(lines, 'v1').priceSource).toBe('auto')
  })

  it('oublie le prix de la grille dès qu’elle ne répond plus', () => {
    const wholesale = basis([{ minQty: '10.000', unitPrice: '11.00' }])
    let lines = setQuantity(addArticle([], CREME, wholesale), 'v1', '10')
    expect(line(lines, 'v1').unitPrice).toBe('11,00')

    lines = setQuantity(lines, 'v1', '5')
    expect(line(lines, 'v1').unitPrice).toBe('')
    expect(line(lines, 'v1').priceSource).toBe('manual')
  })
})

describe('la suppression et l’état du bon', () => {
  it('retire la ligne désignée, et elle seule', () => {
    const lines = removeLine(addArticle(addArticle([], CREME, GRID), SAVON, GRID), 'v1')

    expect(lines.map((candidate) => candidate.variantId)).toEqual(['v2'])
  })

  it('un bon vide ne part pas', () => {
    expect(saleIsComplete([])).toBe(false)
  })

  it('un bon dont chaque ligne a sa quantité et son prix part', () => {
    const lines = setQuantity(addArticle(addArticle([], CREME, GRID), SAVON, GRID), 'v1', '24')

    expect(saleIsComplete(lines)).toBe(true)
  })

  it('une quantité à zéro ne part pas — la base la refuse', () => {
    const lines = setQuantity(addArticle([], CREME, GRID), 'v1', '0')

    expect(saleIsComplete(lines)).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* E4-04                                                                       */
/* -------------------------------------------------------------------------- */

describe('le forçage d’un prix qui existe', () => {
  it('remplace le prix du palier, et retient ce qu’il remplace', () => {
    const lines = forceUnitPrice(addArticle([], CREME, GRID), 'v1', '10,50')

    expect(line(lines, 'v1').unitPrice).toBe('10,50')
    expect(line(lines, 'v1').priceSource).toBe('manual')
    // L'« avant » de l'entrée price_override, et ce qui fait un forçage.
    expect(line(lines, 'v1').overriddenPrice).toBe('12.00')
  })

  /*
   * L'inverse exact de la règle d'E4-03 : un prix saisi faute de palier ne
   * survit pas à l'arrivée d'une réponse de la grille, un prix **forcé** y
   * survit. Sans cela, le forçage ne serait qu'une suggestion.
   */
  it('survit au changement de quantité, et le palier remplacé suit', () => {
    let lines = forceUnitPrice(addArticle([], CREME, GRID), 'v1', '10,50')

    lines = setQuantity(lines, 'v1', '12')
    expect(line(lines, 'v1').unitPrice).toBe('10,50')
    expect(line(lines, 'v1').priceSource).toBe('manual')
    expect(line(lines, 'v1').overriddenPrice).toBe('11.00')

    lines = stepQuantity(lines, 'v1', 1)
    expect(line(lines, 'v1').unitPrice).toBe('10,50')
    expect(line(lines, 'v1').overriddenPrice).toBe('11.00')
  })

  /*
   * `sale_line_override_shape` refuse un prix remplacé égal au prix retenu : un
   * prix que la grille rejoint n'est plus un forçage.
   */
  it('se dissout quand la grille rejoint le prix forcé', () => {
    let lines = forceUnitPrice(addArticle([], CREME, GRID), 'v1', '11,00')
    expect(line(lines, 'v1').overriddenPrice).toBe('12.00')
    expect(line(lines, 'v1').priceSource).toBe('manual')

    lines = setQuantity(lines, 'v1', '10')
    expect(line(lines, 'v1').unitPrice).toBe('11,00')
    expect(line(lines, 'v1').priceSource).toBe('auto')
    expect(line(lines, 'v1').overriddenPrice).toBeNull()
  })

  it('forcer au prix du palier ne force rien', () => {
    const lines = forceUnitPrice(addArticle([], CREME, GRID), 'v1', '12,00')

    expect(line(lines, 'v1').priceSource).toBe('auto')
    expect(line(lines, 'v1').overriddenPrice).toBeNull()
  })

  /*
   * Le forçage d'une ligne dont la grille se tait n'est pas un forçage : il n'y
   * a rien à remplacer. C'est la saisie d'E4-03, et la base dirait la même
   * chose — overridden_price nul, donc aucune entrée au journal.
   */
  it('n’est pas un forçage là où aucun prix n’existe', () => {
    const lines = forceUnitPrice(addArticle([], CREME, NO_GRID), 'v1', '13,00')

    expect(line(lines, 'v1').priceSource).toBe('manual')
    expect(line(lines, 'v1').overriddenPrice).toBeNull()
  })

  it('devient une ligne sans prix quand la grille cesse de répondre', () => {
    const wholesale = basis([{ minQty: '10.000', unitPrice: '11.00' }])
    let lines = setQuantity(addArticle([], CREME, wholesale), 'v1', '10')
    lines = forceUnitPrice(lines, 'v1', '9,00')
    expect(line(lines, 'v1').overriddenPrice).toBe('11.00')

    lines = setQuantity(lines, 'v1', '5')
    expect(line(lines, 'v1').unitPrice).toBe('9,00')
    expect(line(lines, 'v1').overriddenPrice).toBeNull()
  })

  it('se rend d’un geste, et le palier revient', () => {
    let lines = forceUnitPrice(addArticle([], CREME, GRID), 'v1', '10,50')
    lines = releaseUnitPrice(lines, 'v1')

    expect(line(lines, 'v1').unitPrice).toBe('12,00')
    expect(line(lines, 'v1').priceSource).toBe('auto')
    expect(line(lines, 'v1').overriddenPrice).toBeNull()
  })

  it('ne touche pas aux autres lignes', () => {
    let lines = addArticle(addArticle([], CREME, GRID), SAVON, GRID)
    lines = forceUnitPrice(lines, 'v1', '10,50')

    expect(line(lines, 'v2').unitPrice).toBe('12,00')
    expect(line(lines, 'v2').overriddenPrice).toBeNull()
  })
})

describe('le plancher, refusé tôt', () => {
  const FLOORED = basis(BREAKS, '11.50')

  it('ne voit rien là où il n’y a pas de plancher', () => {
    const lines = forceUnitPrice(addArticle([], CREME, GRID), 'v1', '0,50')

    expect(lineBelowFloor(line(lines, 'v1'))).toBe(false)
    expect(saleIsComplete(lines, false)).toBe(true)
  })

  it('retient le bon de l’employé sous le plancher', () => {
    const lines = forceUnitPrice(addArticle([], CREME, FLOORED), 'v1', '10,00')

    expect(lineBelowFloor(line(lines, 'v1'))).toBe(true)
    expect(saleIsComplete(lines, false)).toBe(false)
    // Le patron passe — c'est `override_price_below_floor` (§ 3.1).
    expect(saleIsComplete(lines, true)).toBe(true)
  })

  it('laisse passer le prix exactement égal au plancher', () => {
    const lines = forceUnitPrice(addArticle([], CREME, FLOORED), 'v1', '11,50')

    expect(lineBelowFloor(line(lines, 'v1'))).toBe(false)
    expect(saleIsComplete(lines, false)).toBe(true)
  })

  /*
   * Le plancher ne regarde pas d'où vient le prix : un palier réglé sous le
   * plancher est une contradiction de la grille, et l'employé ne peut pas la
   * vendre. La base dit la même chose, et pour la même raison — sinon le
   * contrôle se contournerait en posant `auto` (migration E4-04).
   */
  it('vaut aussi pour un prix de palier sous le plancher', () => {
    const contradictory = basis([{ minQty: '1.000', unitPrice: '9.00' }], '11.50')
    const lines = addArticle([], CREME, contradictory)

    expect(line(lines, 'v1').priceSource).toBe('auto')
    expect(lineBelowFloor(line(lines, 'v1'))).toBe(true)
    expect(saleIsComplete(lines, false)).toBe(false)
  })
})
