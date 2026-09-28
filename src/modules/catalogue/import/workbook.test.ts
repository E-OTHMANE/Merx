/*
 * E2-05 — la lecture d'un classeur Excel.
 *
 * Le classeur est fabriqué ici par la même bibliothèque qui le relit : ce
 * n'est donc pas un fichier de référence figé dans le dépôt, mais un aller et
 * retour. Ce qu'il éprouve est ce qui sépare un `.xlsx` d'un CSV :
 *
 *   — un nombre est un flottant dans le fichier, et un montant ne doit jamais
 *     passer par un flottant (CLAUDE.md) : on lit la valeur **affichée** ;
 *   — un EAN qu'Excel affiche en notation scientifique a perdu ses chiffres,
 *     et cela doit se voir jusqu'au motif de rejet.
 */

import { describe, expect, it } from 'vitest'

import { prepareRows } from '@/modules/catalogue/import/rows'
import { readWorkbook } from '@/modules/catalogue/import/workbook'

/** Un classeur d'une feuille, à partir d'un tableau de cellules. */
async function workbookOf(cells: unknown[][], scientificBarcode = false): Promise<Uint8Array> {
  const { utils, write } = await import('xlsx')
  const sheet = utils.aoa_to_sheet(cells)

  // La colonne des codes-barres, au format scientifique — ce qu'Excel fait
  // tout seul d'un nombre de treize chiffres dans une colonne étroite.
  const scientific = utils.encode_cell({ r: 1, c: 2 })
  if (scientificBarcode && sheet[scientific] !== undefined) sheet[scientific].z = '0.00E+00'

  const book = utils.book_new()
  utils.book_append_sheet(book, sheet, 'Catalogue')
  return new Uint8Array(write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}

describe('classeur Excel', () => {
  it('rend les valeurs affichées, pas les flottants du fichier', async () => {
    const bytes = await workbookOf([
      ['Référence', 'Désignation', 'Code-barres', 'PV'],
      ['LOR-12', 'Crème hydratante', 6111234567890, 15.5],
    ])
    const table = await readWorkbook(bytes)

    expect(table[0]).toEqual(['Référence', 'Désignation', 'Code-barres', 'PV'])
    expect(table[1]![0]).toBe('LOR-12')
    expect(table[1]![3]).toBe('15.5')

    // Sans la colonne des codes-barres : un nombre de treize chiffres s'affiche
    // en scientifique même au format « Standard », et c'est le cas suivant.
    const { rows } = prepareRows(table, { code: 0, name_fr: 1, unit_price: 3 })
    expect(rows[0]!.unit_price).toBe('15.50')
  })

  it('refuse un code-barres qu’Excel affiche en notation scientifique', async () => {
    const bytes = await workbookOf([
      ['Référence', 'Désignation', 'Code-barres', 'PV'],
      ['LOR-12', 'Crème hydratante', 6111234567890, 15.5],
    ], true)
    const table = await readWorkbook(bytes)
    expect(table[1]![2]).toMatch(/E\+/i)

    const { rows, rejected } = prepareRows(table, {
      code: 0,
      name_fr: 1,
      barcode: 2,
      unit_price: 3,
    })
    expect(rows).toHaveLength(0)
    expect(rejected[0]!.motif).toContain('Code-barres')
    expect(rejected[0]!.motif).toContain('notation scientifique')
  })

  it('laisse passer le même code-barres écrit en texte — contrôle', async () => {
    const bytes = await workbookOf([
      ['Référence', 'Désignation', 'Code-barres', 'PV'],
      ['LOR-12', 'Crème hydratante', '6111234567890', 15.5],
    ])
    const table = await readWorkbook(bytes)
    const { rows } = prepareRows(table, { code: 0, name_fr: 1, barcode: 2, unit_price: 3 })
    expect(rows[0]!.barcode).toBe('6111234567890')
  })
})
