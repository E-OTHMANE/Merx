import { describe, expect, it } from 'vitest'

import {
  MONEY_SCALE,
  QUANTITY_SCALE,
  decimalInput,
  inputText,
  moneyText,
  parseDecimal,
  quantityText,
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

/*
 * Les quantités signées. E3-02 — RÈGLE M2-3 : le stock peut passer sous zéro,
 * et il se lit. `parseDecimal()` refuse le signe, par choix : aucun champ de
 * saisie ne l'accepte. Une quantité lue, elle, le porte.
 */
describe('quantityText', () => {
  it.each([
    ['0.000', '0'],
    ['10.000', '10'],
    ['2.500', '2,5'],
    ['-7.500', '-7,5'],
    ['-0.001', '-0,001'],
    // Un zéro n'a pas de signe : « -0 » ne veut rien dire au comptoir.
    ['-0.000', '0'],
  ])('rend %s « %s »', (stored, shown) => {
    expect(quantityText(stored)).toBe(shown)
  })
})

/*
 * L'affichage d'un montant. E4-03 — BRAND-UI § 6 : « 1 250,00 DH », espace
 * insécable comme séparateur de milliers, virgule décimale, `DH` après le
 * montant, et deux décimales toujours. L'espace insécable est vérifié pour
 * lui-même : une espace ordinaire couperait un total en fin de ligne, et
 * « 1 250,00 » lu sur deux lignes est un autre nombre.
 */
describe('moneyText', () => {
  const NBSP = ' '

  it.each([
    ['0.00', `0,00${NBSP}DH`],
    ['12.50', `12,50${NBSP}DH`],
    ['300.00', `300,00${NBSP}DH`],
    ['1250.00', `1${NBSP}250,00${NBSP}DH`],
    ['999999.99', `999${NBSP}999,99${NBSP}DH`],
    // Deux décimales toujours : une colonne de dirhams s'aligne ou ne sert à rien.
    ['12', `12,00${NBSP}DH`],
    ['12,5', `12,50${NBSP}DH`],
  ])('rend %s « %s »', (stored, shown) => {
    expect(moneyText(stored)).toBe(shown)
  })

  it('traite le signe, et n’en met pas sur un zéro', () => {
    expect(moneyText('-12.50')).toBe(`-12,50${NBSP}DH`)
    expect(moneyText('-0.00')).toBe(`0,00${NBSP}DH`)
  })

  it('rend le texte tel quel s’il n’est pas un montant', () => {
    expect(moneyText('abc')).toBe('abc')
  })
})
