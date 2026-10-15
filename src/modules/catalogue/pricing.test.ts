/*
 * RÈGLE M1-2 — le plus grand `min_qty` inférieur ou égal à la quantité.
 * BACKLOG E2-03 : « test unitaire de résolution couvrant les bornes exactes ».
 *
 * Les bornes sont là où la règle se trompe d'un cran : `<` au lieu de `<=`
 * décale 10 et 100 au palier inférieur ; le plus petit `min_qty` au lieu du
 * plus grand fige tout au prix à l'unité. Chaque cas est écrit pour tomber
 * sous l'un ou l'autre de ces sabotages.
 */

import { describe, expect, it } from 'vitest'

import { nextBreakNudge, resolvePriceBreak, type PriceBreakLike } from '@/modules/catalogue/pricing'

/* Telle que la base la rend : quantités à trois décimales, montants à deux. */
const GRID: PriceBreakLike[] = [
  { minQty: '1.000', unitPrice: '12.00' },
  { minQty: '10.000', unitPrice: '11.00' },
  { minQty: '100.000', unitPrice: '10.00' },
]

const priceAt = (quantity: string, grid: readonly PriceBreakLike[] = GRID) =>
  resolvePriceBreak(grid, quantity)?.unitPrice

describe('les bornes exactes', () => {
  it.each([
    ['1', '12.00'],
    ['9', '12.00'],
    ['10', '11.00'],
    ['99', '11.00'],
    ['100', '10.00'],
  ])('quantité %s → %s', (quantity, expected) => {
    expect(priceAt(quantity)).toBe(expected)
  })
})

describe('autour des bornes, à la précision d’une quantité', () => {
  it.each([
    ['9.999', '12.00'],
    ['10.000', '11.00'],
    ['10,001', '11.00'],
    ['99.999', '11.00'],
    ['100.000', '10.00'],
    ['1000', '10.00'],
    ['2,5', '12.00'],
  ])('quantité %s → %s', (quantity, expected) => {
    expect(priceAt(quantity)).toBe(expected)
  })
})

describe('en dessous de la ligne à l’unité', () => {
  // Arbitré en E2-03 : aucun prix automatique. La RÈGLE ne désigne aucune ligne.
  it.each(['0.999', '0,5', '0'])('quantité %s → aucun palier', (quantity) => {
    expect(resolvePriceBreak(GRID, quantity)).toBeNull()
  })
})

describe('la forme de la grille ne compte pas', () => {
  it('résout pareil une grille dans le désordre', () => {
    const shuffled = [GRID[2]!, GRID[0]!, GRID[1]!]
    expect(priceAt('9', shuffled)).toBe('12.00')
    expect(priceAt('10', shuffled)).toBe('11.00')
    expect(priceAt('100', shuffled)).toBe('10.00')
  })

  it('compare des quantités, pas des chaînes', () => {
    // En ordre de chaîne, « 9 » > « 10 » et « 100 » < « 20 ».
    const grid = [
      { minQty: '1', unitPrice: '5.00' },
      { minQty: '20', unitPrice: '4.00' },
      { minQty: '100', unitPrice: '3.00' },
    ]
    expect(priceAt('9', grid)).toBe('5.00')
    expect(priceAt('25', grid)).toBe('4.00')
    expect(priceAt('150', grid)).toBe('3.00')
  })

  it('rend le palier lui-même, pour que la vente sache d’où vient le prix', () => {
    expect(resolvePriceBreak(GRID, '50')).toBe(GRID[1])
  })
})

describe('le prix non renseigné', () => {
  it('rend le palier retenu, sans prix — il ne retombe pas sur un palier inférieur', () => {
    const grid = [
      { minQty: '1.000', unitPrice: '12.00' },
      { minQty: '10.000', unitPrice: null },
    ]
    const resolved = resolvePriceBreak(grid, '10')
    expect(resolved).toBe(grid[1])
    expect(resolved?.unitPrice).toBeNull()
  })

  it('rend la ligne à l’unité sans prix, telle que la base la crée', () => {
    expect(priceAt('3', [{ minQty: '1.000', unitPrice: null }])).toBeNull()
  })
})

describe('une quantité illisible', () => {
  it.each(['', 'abc', '-5'])('« %s » → aucun palier', (quantity) => {
    expect(resolvePriceBreak(GRID, quantity)).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* RÈGLE M1-4 — l'incitation au palier suivant, E4-04                          */
/* -------------------------------------------------------------------------- */

/*
 * « Si la quantité est à moins de 20 % du palier suivant, afficher
 * « +2 → 12,00 DH ». » Le seuil se mesure **sur le palier visé** (arbitré en
 * E4-04) : l'écart doit valoir au plus 20 % de son `min_qty`. Les deux côtés de
 * l'exemple du spec tombent juste — un palier à 12 incite depuis 10, pas
 * depuis 8.
 */
describe('l’incitation au palier suivant', () => {
  const CARTON: PriceBreakLike[] = [
    { minQty: '1.000', unitPrice: '13.00' },
    { minQty: '12.000', unitPrice: '12.00' },
  ]

  it('annonce ce qu’il manque et ce que ça donne', () => {
    expect(nextBreakNudge(CARTON, '10', '13.00')).toEqual({
      missing: '2.000',
      minQty: '12.000',
      unitPrice: '12.00',
    })
  })

  it('se tait trop loin du palier', () => {
    expect(nextBreakNudge(CARTON, '8', '13.00')).toBeNull()
  })

  /* 20 % de 12 valent 2,4 : l'écart de 2,4 passe, 2,5 non. */
  it('tient la borne des 20 % au millième', () => {
    expect(nextBreakNudge(CARTON, '9.6', '13.00')).not.toBeNull()
    expect(nextBreakNudge(CARTON, '9.5', '13.00')).toBeNull()
  })

  it('se tait sur le palier lui-même, et au-delà', () => {
    expect(nextBreakNudge(CARTON, '12', '12.00')).toBeNull()
    expect(nextBreakNudge(CARTON, '48', '12.00')).toBeNull()
  })

  it('vise le plus proche des paliers suivants', () => {
    const grid: PriceBreakLike[] = [
      { minQty: '1.000', unitPrice: '13.00' },
      { minQty: '12.000', unitPrice: '12.00' },
      { minQty: '13.000', unitPrice: '11.00' },
    ]

    expect(nextBreakNudge(grid, '11', '13.00')?.minQty).toBe('12.000')
  })

  /* « Prix non renseigné » (E2-03) n'incite à rien : il n'annonce aucun prix. */
  it('ignore un palier sans prix, et passe au suivant qui en a', () => {
    const grid: PriceBreakLike[] = [
      { minQty: '1.000', unitPrice: '13.00' },
      { minQty: '12.000', unitPrice: null },
      { minQty: '13.000', unitPrice: '11.00' },
    ]

    expect(nextBreakNudge(grid, '12.5', '13.00')?.minQty).toBe('13.000')
    // Depuis 11, c'est encore 13 qu'on annonce — 12 ne dit aucun prix, et
    // l'écart de 2 vaut moins que les 20 % de 13.
    expect(nextBreakNudge(grid, '11', '13.00')?.minQty).toBe('13.000')
  })

  /*
   * Une fonction produit, pas une décoration : on n'invite pas quelqu'un à
   * payer davantage. Vaut aussi pour une ligne forcée en dessous du palier.
   */
  it('se tait quand le palier suivant ne vaut pas mieux', () => {
    const rising: PriceBreakLike[] = [
      { minQty: '1.000', unitPrice: '10.00' },
      { minQty: '12.000', unitPrice: '12.00' },
    ]

    expect(nextBreakNudge(rising, '10', '10.00')).toBeNull()
    expect(nextBreakNudge(CARTON, '10', '9.00')).toBeNull()
  })

  it('annonce quand la ligne n’a aucun prix', () => {
    expect(nextBreakNudge(CARTON, '10', null)?.unitPrice).toBe('12.00')
  })

  it('se tait sur une quantité illisible', () => {
    expect(nextBreakNudge(CARTON, '', '13.00')).toBeNull()
  })
})
