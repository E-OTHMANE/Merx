/*
 * Le SKU engendré — E2-06.
 *
 * Deux propriétés valent tout ce fichier, et elles disent la même chose de deux
 * côtés : **le compteur local n'est pas l'autorité.**
 *
 *   — un stockage vidé ne réattribue jamais un numéro déjà imprimé : le suivant
 *     repart au-dessus du plus grand connu du serveur ;
 *   — un numéro pris malgré tout se solde par un `23505` sur
 *     `variant_sku_per_tenant`, reconnu **au nom de la contrainte**, et on
 *     enjambe.
 *
 * Ce que la base refuse pour de bon est éprouvé par
 * `supabase/tests/barcodes.test.ts` ; ici, c'est ce que l'appareil envoie.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_SEQUENCE,
  SKU_MESSAGES,
  assignGeneratedSku,
  formatGeneratedSku,
  nextSequence,
  sequenceOf,
} from '@/modules/catalogue/sku'

interface Call {
  table: string
  op: 'select' | 'update'
  payload?: Record<string, unknown>
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
      const call: Call = { table, op: 'select', filters: [] }
      const builder = {
        select: () => builder,
        update: (payload: Record<string, unknown>) => {
          call.op = 'update'
          call.payload = payload
          return builder
        },
        eq: (column: string, value: unknown) => {
          call.filters.push(['eq', column, value])
          return builder
        },
        is: (column: string, value: unknown) => {
          call.filters.push(['is', column, value])
          return builder
        },
        like: (column: string, value: unknown) => {
          call.filters.push(['like', column, value])
          return builder
        },
        order: () => builder,
        limit: () => builder,
        then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push(call)
          return Promise.resolve(respond(call)).then(resolve, reject)
        },
      }
      return builder
    },
  },
}))

/** Le refus de l'index, tel que PostgREST le rend. */
const collision = {
  code: '23505',
  message:
    'duplicate key value violates unique constraint "variant_sku_per_tenant"',
}

const updates = () => calls.filter((call) => call.op === 'update')

beforeEach(() => {
  calls.length = 0
  window.localStorage.clear()
  respond.mockReset()
  respond.mockImplementation((call) =>
    call.op === 'update' ? { data: [{ id: 'v1' }], error: null } : { data: [], error: null },
  )
})

describe('la forme', () => {
  it('est la lettre de l’appareil et cinq chiffres', () => {
    expect(formatGeneratedSku('A', 1)).toBe('A-00001')
    expect(formatGeneratedSku('C', 42)).toBe('C-00042')
  })

  /*
   * La largeur fixe n'est pas une coquetterie : c'est ce qui fait que l'ordre
   * alphabétique des SKU est leur ordre numérique, donc que « le plus grand »
   * se demande au serveur en une ligne.
   */
  it('garde l’ordre du texte égal à l’ordre des nombres', () => {
    const sorted = [9, 10, 100].map((n) => formatGeneratedSku('A', n))
    expect([...sorted].sort()).toStrictEqual(sorted)
  })

  it('reconnaît un numéro de cet appareil, et lui seul', () => {
    expect(sequenceOf('A', 'A-00007')).toBe(7)
    expect(sequenceOf('A', 'B-00007')).toBeNull()
    expect(sequenceOf('A', 'EDT-50')).toBeNull()
    expect(sequenceOf('A', null)).toBeNull()
  })
})

describe('le prochain numéro', () => {
  it('part de 1 sur un commerce neuf', async () => {
    await expect(nextSequence('A')).resolves.toBe(1)
  })

  it('demande au serveur le plus grand SKU de cet appareil', async () => {
    respond.mockImplementation(() => ({ data: [{ sku: 'A-00012' }], error: null }))

    await expect(nextSequence('A')).resolves.toBe(13)
    expect(calls[0]?.filters).toContainEqual(['like', 'sku', 'A-%'])
  })

  /*
   * La propriété demandée : **un stockage local vidé ne réattribue jamais un
   * SKU déjà imprimé.** Le compteur est à zéro, le serveur dit 12, le suivant
   * est 13 — pas 1.
   */
  it('repart au-dessus du serveur quand le compteur local a été vidé', async () => {
    respond.mockImplementation(() => ({ data: [{ sku: 'A-00012' }], error: null }))
    window.localStorage.clear()

    await expect(nextSequence('A')).resolves.toBe(13)
  })

  /*
   * L'inverse aussi : hors réseau, le serveur ne répond pas, et c'est le
   * compteur local qui tient. Une étiquette s'imprime au comptoir (SPEC § 2.5).
   */
  it('tient sur le compteur local quand le serveur ne répond pas', async () => {
    respond.mockImplementation((call) =>
      call.op === 'select'
        ? { data: null, error: { message: 'Failed to fetch' } }
        : { data: [{ id: 'v1' }], error: null },
    )
    await assignGeneratedSku('v1', 'A')
    calls.length = 0

    await expect(nextSequence('A')).resolves.toBe(2)
  })

  it('ne redescend jamais sous le compteur local, même si le serveur est en retard', async () => {
    respond.mockImplementation((call) =>
      call.op === 'select'
        ? { data: [{ sku: 'A-00002' }], error: null }
        : { data: [{ id: 'v1' }], error: null },
    )
    await assignGeneratedSku('v1', 'A') // le serveur connaît 2, on écrit 3
    calls.length = 0
    respond.mockImplementation(() => ({ data: [], error: null })) // serveur amnésique

    await expect(nextSequence('A')).resolves.toBe(4)
  })
})

describe('l’attribution', () => {
  it('écrit le SKU sur la variante, et seulement si elle n’en a pas', async () => {
    await expect(assignGeneratedSku('v1', 'A')).resolves.toBe('A-00001')

    const write = updates()[0]
    expect(write?.payload).toStrictEqual({ sku: 'A-00001' })
    expect(write?.filters).toContainEqual(['eq', 'id', 'v1'])
    expect(write?.filters).toContainEqual(['is', 'sku', null])
  })

  it('n’envoie aucun tenant_id — la RLS s’en charge', async () => {
    await assignGeneratedSku('v1', 'A')

    expect(Object.keys(updates()[0]?.payload ?? {})).not.toContain('tenant_id')
  })

  /*
   * Le compteur local n'est pas l'autorité : `variant_sku_per_tenant` l'est. Un
   * employé a pu taper « A-00001 » à la main dans la référence d'un produit.
   */
  it('enjambe un numéro déjà pris, et le reconnaît au nom de la contrainte', async () => {
    let attempts = 0
    respond.mockImplementation((call) => {
      if (call.op === 'select') return { data: [], error: null }
      attempts += 1
      return attempts === 1
        ? { data: null, error: collision }
        : { data: [{ id: 'v1' }], error: null }
    })

    await expect(assignGeneratedSku('v1', 'A')).resolves.toBe('A-00002')
    expect(updates()).toHaveLength(2)
  })

  it('ne prend pas une autre unicité pour la sienne', async () => {
    respond.mockImplementation((call) =>
      call.op === 'select'
        ? { data: [], error: null }
        : {
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "variant_barcode_per_tenant"',
            },
          },
    )

    await expect(assignGeneratedSku('v1', 'A')).rejects.toThrow(/variant_barcode_per_tenant/)
    expect(updates()).toHaveLength(1)
  })

  it('abandonne après quelques numéros pris, en disant quoi faire', async () => {
    respond.mockImplementation((call) =>
      call.op === 'select' ? { data: [], error: null } : { data: null, error: collision },
    )

    await expect(assignGeneratedSku('v1', 'A')).rejects.toThrow(SKU_MESSAGES.exhausted)
  })

  /*
   * Un UPDATE refusé par la RLS ne lève pas : il ne trouve rien. Sans ce
   * contrôle, une étiquette sortirait avec un code que la base n'a jamais
   * accepté (même garde que `updateProduct`, E2-02).
   */
  it('refuse d’imprimer un code que la base n’a pas pris', async () => {
    respond.mockImplementation((call) =>
      call.op === 'select' ? { data: [], error: null } : { data: [], error: null },
    )

    await expect(assignGeneratedSku('v1', 'A')).rejects.toThrow(SKU_MESSAGES.notSaved)
  })

  it('s’arrête quand la lettre est épuisée plutôt que de déborder sur six chiffres', async () => {
    respond.mockImplementation((call) =>
      call.op === 'select'
        ? { data: [{ sku: formatGeneratedSku('A', MAX_SEQUENCE) }], error: null }
        : { data: [{ id: 'v1' }], error: null },
    )

    await expect(assignGeneratedSku('v1', 'A')).rejects.toThrow(SKU_MESSAGES.exhausted)
  })
})
