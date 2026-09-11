/*
 * La forme des écritures — E2-02, SPEC § 2.6.
 *
 * Un `null` envoyé et une clé absente ne se distinguent pas à l'écran ; ils se
 * distinguent en base, où l'absence laisse jouer le défaut de la colonne. La
 * création ne porte donc que ce qui a une valeur, et la modification que ce
 * qui a changé.
 */

import { describe, expect, it } from 'vitest'

import {
  EMPTY_DRAFT,
  canSave,
  changesBetween,
  creationPayload,
  digitsOnly,
} from '@/modules/catalogue/products'

describe('creationPayload', () => {
  it('le nom seul : l’identifiant et le nom, aucune autre clé', () => {
    const payload = creationPayload('p1', { ...EMPTY_DRAFT, name: '  Crème de nuit ' })
    expect(payload).toStrictEqual({ id: 'p1', name_fr: 'Crème de nuit' })
  })

  it('n’envoie jamais tenant_id', () => {
    expect(Object.keys(creationPayload('p1', { ...EMPTY_DRAFT, name: 'X' }))).not.toContain(
      'tenant_id',
    )
  })

  it('un champ blanc n’est pas envoyé', () => {
    const payload = creationPayload('p1', { ...EMPTY_DRAFT, name: 'X', code: '   ', brand: '' })
    expect(payload).toStrictEqual({ id: 'p1', name_fr: 'X' })
  })

  it('tous les champs remplis partent sous leur colonne', () => {
    const payload = creationPayload('p1', {
      name: 'Eau de toilette',
      code: 'EDT-50',
      nameAr: 'ماء العطر',
      categoryId: 'c1',
      brand: 'Nivea',
      unitLabel: 'flacon',
      piecesPerCarton: '24',
    })
    expect(payload).toStrictEqual({
      id: 'p1',
      name_fr: 'Eau de toilette',
      code: 'EDT-50',
      name_ar: 'ماء العطر',
      category_id: 'c1',
      brand: 'Nivea',
      unit_label: 'flacon',
      pieces_per_carton: 24,
    })
  })

  it('zéro pièce par carton n’est pas une valeur — la contrainte > 0 ne sert jamais de reproche', () => {
    const payload = creationPayload('p1', { ...EMPTY_DRAFT, name: 'X', piecesPerCarton: '0' })
    expect(payload).toStrictEqual({ id: 'p1', name_fr: 'X' })
  })
})

describe('changesBetween', () => {
  const saved = { ...EMPTY_DRAFT, name: 'Eau de toilette', code: 'EDT-50' }

  it('rien de changé, rien à envoyer', () => {
    expect(changesBetween(saved, { ...saved })).toStrictEqual({})
  })

  it('seule la colonne changée part', () => {
    expect(changesBetween(saved, { ...saved, brand: 'Nivea' })).toStrictEqual({ brand: 'Nivea' })
  })

  it('un champ vidé part à null — c’est ce que le patron a fait', () => {
    expect(changesBetween(saved, { ...saved, code: '' })).toStrictEqual({ code: null })
  })

  it('des espaces ajoutés ne sont pas un changement', () => {
    expect(changesBetween(saved, { ...saved, name: ' Eau de toilette ' })).toStrictEqual({})
  })
})

describe('le reste', () => {
  it('le nom seul décide si l’on peut enregistrer', () => {
    expect(canSave(EMPTY_DRAFT)).toBe(false)
    expect(canSave({ ...EMPTY_DRAFT, name: '   ' })).toBe(false)
    expect(canSave({ ...EMPTY_DRAFT, name: 'X' })).toBe(true)
  })

  it('le champ des pièces ne laisse entrer que des chiffres', () => {
    expect(digitsOnly('12a -3')).toBe('123')
  })
})
