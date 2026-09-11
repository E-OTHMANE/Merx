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

import { resolvePriceBreak, type PriceBreakLike } from '@/modules/catalogue/pricing'

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
