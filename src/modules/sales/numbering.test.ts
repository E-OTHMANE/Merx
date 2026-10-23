/*
 * La numérotation locale — E4-02, côté appareil.
 *
 * Trois propriétés valent ce fichier, et elles disent la même chose de trois
 * côtés : **l'appareil choisit, l'index tranche.**
 *
 *   — la borne vient du serveur, qui la *constate* dans `document_sequence` :
 *     un stockage local vidé repart au-dessus du dernier numéro connu, jamais
 *     à `00001` (même leçon que le SKU engendré, E2-06) ;
 *   — un numéro déjà pris se solde par un `23505` sur
 *     `sale_document_number_per_tenant`, reconnu **au nom de la contrainte**,
 *     et on enjambe — un trou, jamais un doublon ;
 *   — une borne illisible fait refuser la confirmation, au lieu de numéroter
 *     contre un historique qu'on n'a pas lu.
 *
 * Ce que la base refuse pour de bon est éprouvé par
 * `supabase/tests/document-numbering.test.ts` ; ici, c'est ce que l'appareil
 * envoie.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DOC_TYPE_CODES,
  MAX_SEQUENCE,
  NUMBERING_MESSAGES,
  confirmDocument,
  documentYear,
  formatDocumentNumber,
  parseDocumentNumber,
  sequenceBound,
} from '@/modules/sales'

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

/*
 * Le décalage du Maroc, interceptable — E0-06.
 *
 * `documentYear()` doit dériver de `casablancaOffsetMinutes()`, et non de la
 * table de fuseaux du moteur. Sur cette machine les deux s'accordent : l'ICU de
 * Node est juste, celle de ce Chrome ne l'est pas, et un test qui compare deux
 * lectures justes ne mesure rien. Remettre `documentYear()` sur `Intl` y
 * resterait vert.
 *
 * Donc on tient le décalage par la manche. `offset` nul laisse la vraie table
 * répondre — tous les autres cas du fichier sont intacts ; posé, il impose une
 * valeur qu'aucun moteur ne rendrait, et seule une fonction qui *lit* la table
 * la suit.
 */
const table = vi.hoisted(() => ({ offset: null as number | null }))

vi.mock('@/lib/dates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dates')>()
  return {
    ...actual,
    casablancaOffsetMinutes: (at: Date) =>
      table.offset ?? actual.casablancaOffsetMinutes(at),
  }
})

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

/** Le refus de l'index, tel que PostgREST le rend. */
const collision = {
  code: '23505',
  message:
    'duplicate key value violates unique constraint "sale_document_number_per_tenant"',
}

/** Le refus d'une *autre* unicité, qui ne doit pas déclencher l'enjambement. */
const otherCollision = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "variant_sku_per_tenant"',
}

const updates = (): Call[] => calls.filter((call) => call.op === 'update')
const numbers = (): unknown[] => updates().map((call) => call.payload?.['doc_number'])

/** Le 15 octobre 2026, 12 h UTC — une date sans ambiguïté de fuseau. */
const AT = new Date('2026-10-15T12:00:00.000Z')

function request(overrides: Partial<Parameters<typeof confirmDocument>[0]> = {}) {
  return {
    documentId: 'doc-1',
    docType: 'delivery_note' as const,
    deviceId: 'device-1',
    prefix: 'A',
    issuedAt: AT,
    ...overrides,
  }
}

/** La borne que le serveur rend, puis des confirmations qui passent. */
function bound(lastNumber: number | null): void {
  respond.mockImplementation((call) =>
    call.op === 'update'
      ? { data: [{ id: 'doc-1' }], error: null }
      : { data: lastNumber === null ? null : { last_number: lastNumber }, error: null },
  )
}

beforeEach(() => {
  calls.length = 0
  respond.mockReset()
  bound(0)
})

describe('la forme', () => {
  it('est le code du type, la lettre, l’année sur deux chiffres et cinq chiffres', () => {
    expect(formatDocumentNumber('delivery_note', 'A', 2026, 1)).toBe('BL-A-26-00001')
    expect(formatDocumentNumber('quote', 'C', 2027, 42)).toBe('DV-C-27-00042')
    expect(formatDocumentNumber('order', 'B', 2030, 12_345)).toBe('CM-B-30-12345')
  })

  /*
   * La largeur fixe est ce qui fait que l'ordre du texte est l'ordre des
   * nombres — la propriété sur laquelle repose la lecture du plus grand numéro
   * dans la base locale d'E9.
   */
  it('garde l’ordre du texte égal à l’ordre des nombres', () => {
    const sorted = [9, 10, 100, 9999, 10_000].map((n) =>
      formatDocumentNumber('delivery_note', 'A', 2026, n),
    )
    expect([...sorted].sort()).toStrictEqual(sorted)
  })

  it('reconnaît un numéro, et rien d’autre', () => {
    expect(parseDocumentNumber('BL-A-26-00001')).toStrictEqual({
      code: 'BL',
      prefix: 'A',
      year: 26,
      sequence: 1,
    })
    // L'ancienne forme, sans année : c'est ce que E4-02 a tranché.
    expect(parseDocumentNumber('BL-A-0001')).toBeNull()
    expect(parseDocumentNumber('XX-A-26-00001')).toBeNull()
    expect(parseDocumentNumber('BL-a-26-00001')).toBeNull()
    expect(parseDocumentNumber('BL-A-26-1')).toBeNull()
    expect(parseDocumentNumber('')).toBeNull()
  })

  /*
   * § 4 : l'affichage est en `Africa/Casablanca`. Un bon émis le 31 décembre à
   * 23 h 30 au comptoir porte l'année du comptoir — le Maroc est à UTC+1, donc
   * l'instant UTC est déjà le 1er janvier, et c'est exactement le cas qui
   * distingue les deux lectures. Le garde de la base recalcule la même.
   */
  it('prend l’année du comptoir, pas celle d’UTC', () => {
    expect(documentYear(new Date('2026-12-31T22:30:00.000Z'))).toBe(2026)
    expect(documentYear(new Date('2026-12-31T23:30:00.000Z'))).toBe(2027)
  })

  /*
   * Le 31 décembre à 23 h 30 au comptoir, de 2026 à 2030 — E0-06.
   *
   * L'instant UTC qui correspond n'est pas le même d'une année à l'autre, et
   * c'est tout l'intérêt du cas : **en 2029 et en 2030, le 31 décembre tombe
   * pendant le Ramadan**, donc à UTC+0, et 23 h 30 au comptoir est 23:30Z.
   * Les trois autres années, le Maroc est à UTC+1 et c'est 22:30Z. Un bord
   * qui revient deux fois en cinq ans n'est pas un bord théorique.
   *
   * `supabase/tests/timezone.test.ts` rejoue ces mêmes instants contre le
   * calcul du garde `merx.require_document_number_shape()` : ici on mesure ce
   * que l'appareil décide, là-bas qu'il décide la même chose que la base.
   */
  const NEW_YEAR_EVE: ReadonlyArray<readonly [number, string]> = [
    [2026, '2026-12-31T22:30:00.000Z'],
    [2027, '2027-12-31T22:30:00.000Z'],
    [2028, '2028-12-31T22:30:00.000Z'],
    [2029, '2029-12-31T23:30:00.000Z'],
    [2030, '2030-12-31T23:30:00.000Z'],
  ]

  it('lit le décalage de la table, et non celui du moteur', () => {
    // Un décalage que ni Node, ni Chrome, ni Postgres ne rendraient pour le
    // Maroc : seul ce qui lit la table peut le suivre.
    table.offset = -3 * 60
    try {
      // 01:00 UTC le 1er janvier, moins trois heures : on est encore en 2026
      // au comptoir imaginaire. `Intl` répondrait 2027.
      expect(documentYear(new Date('2027-01-01T01:00:00.000Z'))).toBe(2026)
    } finally {
      table.offset = null
    }
  })

  it('porte l’année du comptoir le 31 décembre à 23 h 30, de 2026 à 2030', () => {
    for (const [year, instant] of NEW_YEAR_EVE) {
      expect(documentYear(new Date(instant)), instant).toBe(year)
      // Une heure plus tard, le comptoir a changé d'année lui aussi.
      expect(
        documentYear(new Date(Date.parse(instant) + 60 * 60 * 1_000)),
        `${instant} + 1 h`,
      ).toBe(year + 1)
    }
  })
})

describe('la borne', () => {
  it('se lit dans document_sequence, par appareil, type et année', async () => {
    bound(17)
    expect(await sequenceBound({ docType: 'order', deviceId: 'device-9', year: 2026 })).toBe(17)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.table).toBe('document_sequence')
    expect(calls[0]!.filters).toStrictEqual([
      ['eq', 'device_id', 'device-9'],
      ['eq', 'doc_type', 'order'],
      ['eq', 'year', 2026],
    ])
  })

  it('vaut zéro quand l’appareil n’a rien numéroté cette année', async () => {
    bound(null)
    expect(await sequenceBound({ docType: 'quote', deviceId: 'device-1', year: 2026 })).toBe(0)
  })

  /*
   * Illisible ≠ zéro. Repartir de 1 contre un historique qu'on n'a pas pu lire,
   * c'est un refus de l'index par document déjà émis — et, le jour où
   * l'enjambement s'épuise, un papier sans numéro au comptoir.
   */
  it('refuse de valoir zéro quand la lecture échoue', async () => {
    respond.mockImplementation(() => ({ data: null, error: { message: 'réseau' } }))
    await expect(
      sequenceBound({ docType: 'quote', deviceId: 'device-1', year: 2026 }),
    ).rejects.toThrow(NUMBERING_MESSAGES.unknownBound)
  })
})

describe('la confirmation', () => {
  it('pose le numéro suivant, la date, et le statut — sur le brouillon seul', async () => {
    bound(0)
    const confirmed = await confirmDocument(request())

    expect(confirmed.docNumber).toBe('BL-A-26-00001')
    expect(confirmed.issuedAt).toBe(AT.toISOString())

    expect(updates()).toHaveLength(1)
    expect(updates()[0]!.table).toBe('sale_document')
    expect(updates()[0]!.payload).toStrictEqual({
      status: 'confirmed',
      doc_number: 'BL-A-26-00001',
      issued_at: AT.toISOString(),
    })
    /*
     * `status = 'draft'` dans le filtre : c'est ce qui rend l'opération sûre à
     * retenter, et ce qui fait qu'un document déjà confirmé ne se renumérote
     * pas. La transition `draft → confirmed` est la seule que la table figée
     * laisse écrire librement (RÈGLE M3-3).
     */
    expect(updates()[0]!.filters).toStrictEqual([
      ['eq', 'id', 'doc-1'],
      ['eq', 'status', 'draft'],
    ])
  })

  it('n’attribue aucun numéro à un brouillon — la borne est lue avant d’écrire', async () => {
    bound(0)
    await confirmDocument(request())
    expect(calls.map((call) => call.op)).toStrictEqual(['select', 'update'])
  })

  /*
   * **La propriété de la story.** Le compteur du serveur est une borne
   * constatée : un appareil dont le stockage a été vidé — donc qui ne se
   * souvient de rien — repart au-dessus du dernier numéro qu'il a imprimé, pas
   * à 1. Rien ici ne lit `localStorage` : c'est le fond de l'arbitrage, et le
   * seul moyen que ce soit vrai.
   */
  it('repart au-dessus du dernier numéro connu du serveur, stockage vidé ou non', async () => {
    window.localStorage.clear()
    bound(128)

    const confirmed = await confirmDocument(request())

    expect(confirmed.docNumber).toBe('BL-A-26-00129')
  })

  it('enjambe un numéro déjà pris, et ne retente que sur sa contrainte', async () => {
    let attempt = 0
    respond.mockImplementation((call) => {
      if (call.op === 'select') return { data: { last_number: 6 }, error: null }
      attempt += 1
      return attempt === 1
        ? { data: null, error: collision }
        : { data: [{ id: 'doc-1' }], error: null }
    })

    const confirmed = await confirmDocument(request())

    expect(numbers()).toStrictEqual(['BL-A-26-00007', 'BL-A-26-00008'])
    expect(confirmed.docNumber).toBe('BL-A-26-00008')
  })

  /*
   * Un `23505` n'est pas l'autre : `variant_sku_per_tenant` et
   * `product_code_per_tenant` répondent le même code (CLAUDE.md, règle des
   * unicités). Enjamber sur celui du voisin ferait tourner la boucle sur un
   * refus que le numéro ne corrige pas.
   */
  it('ne prend pas l’unicité d’une autre table pour la sienne', async () => {
    respond.mockImplementation((call) =>
      call.op === 'select'
        ? { data: { last_number: 0 }, error: null }
        : { data: null, error: otherCollision },
    )

    await expect(confirmDocument(request())).rejects.toThrow('variant_sku_per_tenant')
    expect(updates()).toHaveLength(1)
  })

  it('abandonne après cinq numéros pris, sans boucler', async () => {
    respond.mockImplementation((call) =>
      call.op === 'select'
        ? { data: { last_number: 0 }, error: null }
        : { data: null, error: collision },
    )

    await expect(confirmDocument(request())).rejects.toThrow(NUMBERING_MESSAGES.exhausted)
    expect(updates()).toHaveLength(5)
  })

  it('refuse quand les numéros de l’année sont épuisés', async () => {
    bound(MAX_SEQUENCE)
    await expect(confirmDocument(request())).rejects.toThrow(NUMBERING_MESSAGES.exhausted)
    expect(updates()).toHaveLength(0)
  })

  /*
   * Un UPDATE refusé par la RLS ne lève pas, il ne trouve rien (E2-02). Sans ce
   * contrôle, un numéro s'imprimerait que la base n'a jamais accepté.
   */
  it('refuse quand rien n’a été écrit — document déjà confirmé, ou droit absent', async () => {
    respond.mockImplementation((call) =>
      call.op === 'select'
        ? { data: { last_number: 0 }, error: null }
        : { data: [], error: null },
    )

    await expect(confirmDocument(request())).rejects.toThrow(NUMBERING_MESSAGES.notDraft)
  })

  /*
   * Sans lettre, l'appareil ne peut pas numéroter — et il ne doit surtout pas
   * en inventer une : deux appareils qui partageraient une lettre fabriqueraient
   * deux papiers du même numéro, chacun légitime (E1-03).
   */
  it('refuse sans lettre d’appareil, avant toute lecture', async () => {
    await expect(confirmDocument(request({ prefix: null }))).rejects.toThrow(
      NUMBERING_MESSAGES.noDevice,
    )
    await expect(confirmDocument(request({ prefix: 'AB' }))).rejects.toThrow(
      NUMBERING_MESSAGES.noDevice,
    )
    expect(calls).toHaveLength(0)
  })
})

describe('les codes de type', () => {
  /*
   * `return` est le quatrième, ajouté en E4-06 : `RT`, et pas `BR` — « BL » et
   * « BR » ne diffèrent que d'une lettre sur un numéro qui se dicte au
   * téléphone (SPEC § 8, RÈGLE M3-2). L'accord avec `merx.doc_type_code()` se
   * mesure sur la vraie base, dans `supabase/tests/document-numbering.test.ts`,
   * sur les étiquettes lues au catalogue ; ce cas-ci tient la couverture.
   */
  it('couvrent les quatre types, et rien de plus', () => {
    expect(Object.keys(DOC_TYPE_CODES).sort()).toStrictEqual([
      'delivery_note',
      'order',
      'quote',
      'return',
    ])
    expect(Object.values(DOC_TYPE_CODES).sort()).toStrictEqual(['BL', 'CM', 'DV', 'RT'])
  })
})
