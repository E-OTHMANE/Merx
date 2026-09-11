/*
 * La grille de prix, sans écran ni base — E2-03.
 *
 * Ce que le formulaire laisse partir (`canSaveGrid`) et ce qu'il envoie
 * (`gridChanges`). Que la base accepte ou refuse ces écritures est éprouvé sur
 * la base réelle : `supabase/tests/price-grid.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import {
  canSaveGrid,
  draftOfGrid,
  gridChanges,
  hasChanges,
  newBreak,
  type GridDraft,
  type SavedGrid,
} from '@/modules/catalogue/priceGrid'

/** Une grille telle que la base la rend : dans le désordre, en texte. */
const SAVED: SavedGrid = {
  productId: 'p1',
  productName: 'Eau de toilette',
  variantId: 'p1',
  breaks: [
    { id: 'b10', minQty: '10.000', unitPrice: '11.00' },
    { id: 'p1', minQty: '1.000', unitPrice: '12.50' },
    { id: 'b100', minQty: '100.000', unitPrice: '10.00' },
  ],
  floorPrice: '9.00',
  costPrice: '7.25',
}

/** La même, pour un compte qui ne lit pas le coût : la clé est absente. */
const BLIND: SavedGrid = {
  productId: SAVED.productId,
  productName: SAVED.productName,
  variantId: SAVED.variantId,
  breaks: SAVED.breaks,
  floorPrice: SAVED.floorPrice,
}

let counter = 0
const newId = (): string => `new-${++counter}`

function edited(change: (draft: GridDraft) => void, saved: SavedGrid = SAVED): GridDraft {
  const draft = draftOfGrid(saved)
  change(draft)
  return draft
}

const row = (draft: GridDraft, id: string) => draft.breaks.find((b) => b.id === id)!

describe('draftOfGrid', () => {
  it('la ligne à l’unité d’abord, puis les paliers par quantité croissante', () => {
    expect(draftOfGrid(SAVED).breaks.map((b) => [b.id, b.base])).toEqual([
      ['p1', true],
      ['b10', false],
      ['b100', false],
    ])
  })

  it('des quantités sans zéros inutiles, des montants à deux décimales, en virgule', () => {
    const draft = draftOfGrid(SAVED)
    expect(row(draft, 'b10')).toMatchObject({ minQty: '10', unitPrice: '11,00' })
    expect(draft.floorPrice).toBe('9,00')
    expect(draft.costPrice).toBe('7,25')
  })

  it('un prix non renseigné donne un champ vide, pas 0', () => {
    const draft = draftOfGrid({
      ...BLIND,
      breaks: [{ id: 'p1', minQty: '1.000', unitPrice: null }],
      floorPrice: null,
    })
    expect(draft.breaks[0]!.unitPrice).toBe('')
    expect(draft.floorPrice).toBe('')
    expect(draft.costPrice).toBe('')
  })
})

describe('canSaveGrid', () => {
  it('la ligne à l’unité sans prix part — prix non renseigné, SPEC § 2.6', () => {
    expect(canSaveGrid(edited((d) => (row(d, 'p1').unitPrice = '')))).toBe(true)
  })

  it('un palier vide est ignoré', () => {
    expect(canSaveGrid(edited((d) => d.breaks.push(newBreak('k'))))).toBe(true)
  })

  it('un palier à moitié rempli retient l’enregistrement — dans un sens comme dans l’autre', () => {
    const quantityOnly = { ...newBreak('k'), minQty: '20' }
    const priceOnly = { ...newBreak('k'), unitPrice: '9,00' }
    expect(canSaveGrid(edited((d) => d.breaks.push(quantityOnly)))).toBe(false)
    expect(canSaveGrid(edited((d) => d.breaks.push(priceOnly)))).toBe(false)
  })

  it('un palier existant dont on efface le prix retient aussi', () => {
    expect(canSaveGrid(edited((d) => (row(d, 'b10').unitPrice = '')))).toBe(false)
  })

  it('une quantité nulle n’est pas un palier', () => {
    const zero = { ...newBreak('k'), minQty: '0', unitPrice: '9,00' }
    expect(canSaveGrid(edited((d) => d.breaks.push(zero)))).toBe(false)
  })

  it('deux paliers à la même quantité, écrite autrement, retiennent', () => {
    const twin = { ...newBreak('k'), minQty: '10,000', unitPrice: '9,00' }
    expect(canSaveGrid(edited((d) => d.breaks.push(twin)))).toBe(false)
  })

  it('un palier à 1 heurte la ligne à l’unité', () => {
    const one = { ...newBreak('k'), minQty: '1', unitPrice: '9,00' }
    expect(canSaveGrid(edited((d) => d.breaks.push(one)))).toBe(false)
  })

  it('un palier sous l’unité est un palier comme un autre', () => {
    const half = { ...newBreak('k'), minQty: '0,5', unitPrice: '13,00' }
    expect(canSaveGrid(edited((d) => d.breaks.push(half)))).toBe(true)
  })
})

describe('gridChanges — seul ce qui a changé part', () => {
  it('rien de changé, rien à envoyer', () => {
    const changes = gridChanges(SAVED, draftOfGrid(SAVED), newId)
    expect(changes).toEqual({ retired: [], repriced: [], added: [] })
    expect(hasChanges(changes)).toBe(false)
  })

  it('un prix changé part en texte décimal, à la ligne près', () => {
    const changes = gridChanges(SAVED, edited((d) => (row(d, 'p1').unitPrice = '13,5')), newId)
    expect(changes).toEqual({
      retired: [],
      repriced: [{ id: 'p1', unitPrice: '13.50' }],
      added: [],
    })
  })

  it('le prix à l’unité effacé part à null — jamais à 0', () => {
    const changes = gridChanges(SAVED, edited((d) => (row(d, 'p1').unitPrice = '')), newId)
    expect(changes.repriced).toEqual([{ id: 'p1', unitPrice: null }])
  })

  it('la même valeur écrite autrement n’est pas un changement', () => {
    const changes = gridChanges(SAVED, edited((d) => (row(d, 'b10').unitPrice = '11')), newId)
    expect(hasChanges(changes)).toBe(false)
  })

  it('un palier retiré de la grille, ou vidé, est retiré', () => {
    const removed = edited((d) => (d.breaks = d.breaks.filter((b) => b.id !== 'b100')))
    expect(gridChanges(SAVED, removed, newId).retired).toEqual(['b100'])

    const emptied = edited((d) => Object.assign(row(d, 'b10'), { minQty: '', unitPrice: '' }))
    expect(gridChanges(SAVED, emptied, newId).retired).toEqual(['b10'])
  })

  it('la ligne à l’unité n’est jamais retirée, même absente du formulaire', () => {
    const withoutBase = edited((d) => (d.breaks = d.breaks.filter((b) => !b.base)))
    expect(gridChanges(SAVED, withoutBase, newId).retired).toEqual([])
  })

  it('un palier déplacé est retiré puis recréé, avec son prix', () => {
    counter = 0
    const changes = gridChanges(SAVED, edited((d) => (row(d, 'b10').minQty = '12')), newId)
    expect(changes).toEqual({
      retired: ['b10'],
      repriced: [],
      added: [{ id: 'new-1', minQty: '12.000', unitPrice: '11.00' }],
    })
  })

  it('un palier ajouté part complet ; un palier vide ne part pas', () => {
    counter = 0
    const added = { ...newBreak('k'), minQty: '50', unitPrice: '10,5' }
    const changes = gridChanges(
      SAVED,
      edited((d) => d.breaks.push(added, newBreak('vide'))),
      newId,
    )
    expect(changes.added).toEqual([{ id: 'new-1', minQty: '50.000', unitPrice: '10.50' }])
  })

  it('le plancher : changé, il part ; effacé, il part à null', () => {
    expect(gridChanges(SAVED, edited((d) => (d.floorPrice = '9,5')), newId).floorPrice).toBe(
      '9.50',
    )
    const cleared = gridChanges(SAVED, edited((d) => (d.floorPrice = '')), newId)
    expect('floorPrice' in cleared && cleared.floorPrice).toBeNull()
  })

  it('le prix d’achat : changé, il part ; effacé, il part à null', () => {
    expect(gridChanges(SAVED, edited((d) => (d.costPrice = '8')), newId).costPrice).toBe('8.00')
    const cleared = gridChanges(SAVED, edited((d) => (d.costPrice = '')), newId)
    expect('costPrice' in cleared && cleared.costPrice).toBeNull()
  })

  it('un compte qui ne lit pas le coût n’en envoie jamais — pas même à null', () => {
    const changes = gridChanges(BLIND, edited((d) => (d.costPrice = '8'), BLIND), newId)
    expect('costPrice' in changes).toBe(false)
  })
})
