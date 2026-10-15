/*
 * Les montants d'un bon — E4-03.
 *
 * Deux choses se mesurent ici, et elles n'ont rien de décoratif : un total de
 * ligne tombe sur le centime que la base stockera, et rien ne passe par un
 * flottant. La règle d'arrondi est provisoire (E4-04 la tranchera, en SQL) ;
 * ce qui est tenu aujourd'hui est qu'elle soit **la même** des deux côtés —
 * demi loin de zéro, comme la conversion `numeric` de Postgres.
 */

import { describe, expect, it } from 'vitest'

import { documentTotals, lineTotalOf, lineTotalText } from '@/modules/sales/amounts'

describe('le total d’une ligne', () => {
  it('multiplie une quantité de grossiste par son prix', () => {
    expect(lineTotalText('24', '12.50')).toBe('300.00')
    expect(lineTotalText('48', '9.90')).toBe('475.20')
    expect(lineTotalText('120', '1.75')).toBe('210.00')
  })

  it('accepte la virgule du commerçant comme le point de la base', () => {
    expect(lineTotalText('2,5', '12,50')).toBe('31.25')
    expect(lineTotalText('2.500', '12.50')).toBe('31.25')
  })

  /*
   * Trois décimales de quantité par deux de prix font cinq décimales : c'est
   * exactement le cas que E4-04 doit trancher, et celui où une erreur d'arrondi
   * se voit au centime. 0,333 × 10,01 = 3,33333 → 3,33 ; 0,335 × 10 = 3,35.
   */
  it('revient à deux décimales, demi loin de zéro', () => {
    expect(lineTotalText('0,333', '10,01')).toBe('3.33')
    expect(lineTotalText('0,335', '10')).toBe('3.35')
    expect(lineTotalText('1,005', '1')).toBe('1.01')
    expect(lineTotalText('1,004', '1')).toBe('1.00')
  })

  it('ne rend rien pour une quantité ou un prix illisible', () => {
    expect(lineTotalOf('', '12.50')).toBeNull()
    expect(lineTotalOf('24', '')).toBeNull()
    expect(lineTotalOf('24', 'abc')).toBeNull()
  })

  /*
   * Le piège que `@/lib/decimal` existe pour éviter : 0,1 + 0,2 ≠ 0,3 en
   * flottant. 70,70 × 3 vaut exactement 212,10 — un calcul en `number` rend
   * 212,10000000000002, donc 212,10 par chance ici, mais 1 442,55 × 3 ne
   * pardonne pas. On vérifie la somme, où l'erreur s'accumule.
   */
  it('ne passe par aucun flottant, même sur cent lignes', () => {
    const lines = Array.from({ length: 100 }, () => ({ quantity: '3', unitPrice: '0.10' }))
    expect(documentTotals(lines).total).toBe('30.00')
  })
})

describe('les totaux du document', () => {
  it('somment les totaux de ligne, et aucune remise', () => {
    const totals = documentTotals([
      { quantity: '24', unitPrice: '12.50' },
      { quantity: '2', unitPrice: '7.25' },
    ])
    expect(totals).toEqual({ subtotal: '314.50', discountTotal: '0.00', total: '314.50' })
  })

  it('valent zéro sur un bon vide', () => {
    expect(documentTotals([])).toEqual({
      subtotal: '0.00',
      discountTotal: '0.00',
      total: '0.00',
    })
  })

  it('comptent une ligne illisible pour zéro, sans échouer', () => {
    expect(documentTotals([{ quantity: '24', unitPrice: '' }]).total).toBe('0.00')
  })
})
