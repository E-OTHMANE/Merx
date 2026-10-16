/*
 * La filiation d'un document — E4-05, côté appareil. RÈGLE M3-4.
 *
 * « Le lien de filiation est consultable dans les deux sens. » Deux questions,
 * donc deux lectures, et ce fichier mesure les deux — plus le cas qui porte
 * l'arbitrage de la story : **un parent, plusieurs enfants.** Une commande de
 * 100 livrée en deux camions fait deux bons, et aucune unicité ne l'empêche.
 *
 * L'affichage est E4-07, qui porte l'écran de détail d'un document : ce qui est
 * ici est la lecture, que la story doit.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { documentLineage } from '@/modules/sales'

interface Call {
  table: string
  columns: string
  filters: Array<[string, string, unknown]>
}

interface Response {
  data: unknown
  error: { code?: string; message: string } | null
}

const calls: Call[] = []
const respond = vi.fn<(call: Call) => Response>()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, columns: '', filters: [] }
      const builder = {
        select: (columns: string) => {
          call.columns = columns
          return builder
        },
        eq: (column: string, value: unknown) => {
          call.filters.push(['eq', column, value])
          return builder
        },
        order: () => builder,
        maybeSingle: () => builder,
        then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push(call)
          return Promise.resolve(respond(call)).then(resolve, reject)
        },
      }
      return builder
    },
  },
}))

const row = (
  id: string,
  docType: string,
  docNumber: string | null,
  status = 'confirmed',
): Record<string, unknown> => ({
  id,
  doc_type: docType,
  doc_number: docNumber,
  status,
})

/** Quelle lecture est quoi : la colonne demandée les distingue. */
const isOwn = (call: Call): boolean => call.columns === 'source_document_id'
const childrenCall = (call: Call): boolean =>
  call.filters.some(([kind, column]) => kind === 'eq' && column === 'source_document_id')

function answer(options: {
  sourceId?: string | null
  parent?: Record<string, unknown> | null
  children?: Array<Record<string, unknown>>
}): void {
  respond.mockImplementation((call) => {
    if (isOwn(call)) {
      return { data: { source_document_id: options.sourceId ?? null }, error: null }
    }
    if (childrenCall(call)) return { data: options.children ?? [], error: null }
    return { data: options.parent ?? null, error: null }
  })
}

beforeEach(() => {
  calls.length = 0
  respond.mockReset()
})

describe('la filiation', () => {
  it('se lit vers le haut : le document d’origine', async () => {
    answer({ sourceId: 'q-1', parent: row('q-1', 'quote', 'DV-A-26-00007') })

    const lineage = await documentLineage('o-1')

    expect(lineage.source).toEqual({
      id: 'q-1',
      docType: 'quote',
      docNumber: 'DV-A-26-00007',
      status: 'confirmed',
    })
    expect(lineage.children).toEqual([])
  })

  /*
   * La livraison en deux camions : l'arbitrage de la story. Aucune unicité ne
   * porte sur `source_document_id`, et `children` est donc une liste — ce n'est
   * pas une précaution, c'est le cas normal.
   */
  it('se lit vers le bas, et un parent a plusieurs enfants', async () => {
    answer({
      children: [
        row('b-1', 'delivery_note', 'BL-A-26-00010'),
        row('b-2', 'delivery_note', 'BL-A-26-00011'),
      ],
    })

    const lineage = await documentLineage('o-1')

    expect(lineage.source).toBeNull()
    expect(lineage.children.map((child) => child.docNumber)).toEqual([
      'BL-A-26-00010',
      'BL-A-26-00011',
    ])
  })

  it('rend les deux sens à la fois', async () => {
    answer({
      sourceId: 'q-1',
      parent: row('q-1', 'quote', 'DV-A-26-00007'),
      children: [row('b-1', 'delivery_note', 'BL-A-26-00010')],
    })

    const lineage = await documentLineage('o-1')

    expect(lineage.documentId).toBe('o-1')
    expect(lineage.source?.id).toBe('q-1')
    expect(lineage.children.map((child) => child.id)).toEqual(['b-1'])
  })

  it('ne lit aucun parent quand le document est né de la saisie', async () => {
    answer({ sourceId: null })

    const lineage = await documentLineage('d-1')

    expect(lineage.source).toBeNull()
    // Deux lectures, pas trois : rien à aller chercher en haut.
    expect(calls).toHaveLength(2)
  })

  it('retient un brouillon sans numéro parmi les enfants', async () => {
    answer({ children: [row('b-1', 'delivery_note', null, 'draft')] })

    const lineage = await documentLineage('o-1')

    expect(lineage.children[0]).toMatchObject({ docNumber: null, status: 'draft' })
  })

  it('relaie l’échec d’une lecture', async () => {
    respond.mockImplementation(() => ({ data: null, error: { message: 'Réseau indisponible' } }))

    await expect(documentLineage('o-1')).rejects.toThrow('Réseau indisponible')
  })
})
