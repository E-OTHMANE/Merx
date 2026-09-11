import { describe, expect, it } from 'vitest'

import {
  MONEY_SCALE,
  QUANTITY_SCALE,
  decimalInput,
  inputText,
  parseDecimal,
  toSqlDecimal,
} from '@/lib/decimal'

describe('parseDecimal', () => {
  it.each([
    ['12', MONEY_SCALE, 1200n],
    ['12,5', MONEY_SCALE, 1250n],
    ['12.50', MONEY_SCALE, 1250n],
    ['0,05', MONEY_SCALE, 5n],
    ['10.000', QUANTITY_SCALE, 10000n],
    ['9.999', QUANTITY_SCALE, 9999n],
    ['12.500', MONEY_SCALE, 1250n],
    [' 7 ', QUANTITY_SCALE, 7000n],
    ['12,', MONEY_SCALE, 1200n],
  ])('%s à l’échelle %i vaut %s', (text, scale, expected) => {
    expect(parseDecimal(text, scale)).toBe(expected)
  })

  it.each([
    ['', MONEY_SCALE],
    ['abc', MONEY_SCALE],
    ['-1', MONEY_SCALE],
    ['1e3', MONEY_SCALE],
    [',5', MONEY_SCALE],
    ['1,2,3', MONEY_SCALE],
    // Une précision que la colonne ne tiendrait pas.
    ['12,505', MONEY_SCALE],
    ['1,0001', QUANTITY_SCALE],
  ])('refuse « %s » à l’échelle %i', (text, scale) => {
    expect(parseDecimal(text, scale)).toBeNull()
  })

  it('reste exact là où le flottant se trompe', () => {
    // 0,1 + 0,2 : 0.30000000000000004 en flottant.
    const sum = parseDecimal('0,1', MONEY_SCALE)! + parseDecimal('0,2', MONEY_SCALE)!
    expect(sum).toBe(parseDecimal('0,3', MONEY_SCALE))
  })
})

describe('toSqlDecimal', () => {
  it.each([
    [1250n, MONEY_SCALE, '12.50'],
    [5n, MONEY_SCALE, '0.05'],
    [0n, MONEY_SCALE, '0.00'],
    [10000n, QUANTITY_SCALE, '10.000'],
    [7n, 0, '7'],
  ])('%s à l’échelle %i s’écrit %s', (value, scale, expected) => {
    expect(toSqlDecimal(value, scale)).toBe(expected)
  })
})

describe('inputText', () => {
  it('garde les deux décimales d’un montant, en virgule', () => {
    expect(inputText('12.50', 'money')).toBe('12,50')
    expect(inputText('12', 'money')).toBe('12,00')
  })

  it('retire les zéros inutiles d’une quantité', () => {
    expect(inputText('10.000', 'quantity')).toBe('10')
    expect(inputText('2.500', 'quantity')).toBe('2,5')
    expect(inputText('100.000', 'quantity')).toBe('100')
  })

  it('rend un champ vide pour une valeur absente', () => {
    expect(inputText(null, 'money')).toBe('')
  })
})

describe('decimalInput', () => {
  it.each([
    ['12.5', MONEY_SCALE, '12,5'],
    ['12,555', MONEY_SCALE, '12,55'],
    ['1a2b', MONEY_SCALE, '12'],
    ['1,2,3', MONEY_SCALE, '1,23'],
    [',5', MONEY_SCALE, '0,5'],
    ['-3', MONEY_SCALE, '3'],
    ['2,5', 0, '25'],
  ])('« %s » à l’échelle %i devient « %s »', (raw, scale, expected) => {
    expect(decimalInput(raw, scale)).toBe(expected)
  })
})
