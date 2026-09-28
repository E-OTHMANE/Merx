/*
 * La planche — E2-06.
 *
 * Deux propriétés portent tout l'arbitrage de la story, et elles sont ici :
 * l'EAN du fabricant passe devant le SKU, et **seuls les SKU réellement
 * imprimés se figent**. Le garde en base (`2F004`) et l'unicité sont éprouvés
 * par `supabase/tests/barcodes.test.ts`, sur la base réelle.
 */

import { describe, expect, it } from 'vitest'

import {
  LABELS_PER_SHEET,
  buildLabels,
  encodedValue,
  sheetCount,
  skusToFreeze,
  type LabelVariant,
} from '@/modules/catalogue/labels'

function variant(overrides: Partial<LabelVariant> = {}): LabelVariant {
  return { id: 'v1', sku: null, barcode: null, skuPrintedAt: null, ...overrides }
}

describe('ce qu’une étiquette encode', () => {
  it('le code-barres du fabricant quand il existe — il est déjà sur le carton', () => {
    expect(encodedValue(variant({ barcode: '6111234567890', sku: 'EDT-50' }))).toStrictEqual({
      code: '6111234567890',
      isSku: false,
    })
  })

  it('le SKU à défaut', () => {
    expect(encodedValue(variant({ sku: 'EDT-50' }))).toStrictEqual({
      code: 'EDT-50',
      isSku: true,
    })
  })

  it('rien du tout sans l’un ni l’autre', () => {
    expect(encodedValue(variant())).toBeNull()
  })
})

describe('la planche', () => {
  it('répète chaque variante autant de fois que demandé', () => {
    const labels = buildLabels([
      { variant: variant({ id: 'v1', sku: 'A' }), name: 'Crème', quantity: 3 },
      { variant: variant({ id: 'v2', barcode: '611' }), name: 'Savon', quantity: 2 },
    ])

    expect(labels).toHaveLength(5)
    expect(labels.filter((label) => label.variantId === 'v1')).toHaveLength(3)
    expect(labels[3]?.code).toBe('611')
  })

  it('ignore une quantité nulle — c’est ainsi qu’on retire une ligne, sans reproche', () => {
    expect(buildLabels([{ variant: variant({ sku: 'A' }), name: 'X', quantity: 0 }])).toHaveLength(0)
  })

  it('ignore une variante sans aucun code', () => {
    expect(buildLabels([{ variant: variant(), name: 'X', quantity: 4 }])).toHaveLength(0)
  })

  it('compte les feuilles A4', () => {
    expect(LABELS_PER_SHEET).toBe(24)
    expect(sheetCount(1)).toBe(1)
    expect(sheetCount(24)).toBe(1)
    expect(sheetCount(25)).toBe(2)
  })
})

describe('ce que l’impression fige', () => {
  it('le SKU qu’elle imprime', () => {
    expect(skusToFreeze([{ variant: variant({ id: 'v1', sku: 'A-00001' }), quantity: 1 }])).toStrictEqual([
      'v1',
    ])
  })

  /*
   * Le point de l'arbitrage : une planche d'EAN fabricant n'engage rien. Le
   * code imprimé vient du carton, le système n'en répond pas, et la référence
   * interne de ce produit reste librement corrigeable.
   */
  it('rien quand c’est le code-barres du fabricant qui est imprimé', () => {
    expect(
      skusToFreeze([{ variant: variant({ sku: 'EDT-50', barcode: '611' }), quantity: 8 }]),
    ).toStrictEqual([])
  })

  it('rien quand la variante est déjà étiquetée — la date est celle de la première fois', () => {
    expect(
      skusToFreeze([
        { variant: variant({ sku: 'A-00001', skuPrintedAt: '2026-09-01T10:00:00Z' }), quantity: 3 },
      ]),
    ).toStrictEqual([])
  })

  it('rien pour une ligne qu’on n’imprime pas', () => {
    expect(skusToFreeze([{ variant: variant({ sku: 'A-00001' }), quantity: 0 }])).toStrictEqual([])
  })

  it('une seule fois par variante, même répétée douze fois sur la planche', () => {
    expect(skusToFreeze([{ variant: variant({ sku: 'A-00001' }), quantity: 12 }])).toStrictEqual([
      'v1',
    ])
  })
})
