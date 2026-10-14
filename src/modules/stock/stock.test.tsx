/*
 * La consultation du stock — E3-02, côté interface.
 *
 * Ce que les écrans envoient, et ce qu'ils disent. Que la base borne au
 * commerce, refuse l'employé sur `app_user` ou emprunte ses index partiels ne
 * dépend d'aucun de ces composants : `supabase/tests/stock-consultation.test.ts`
 * et `stock-api.test.ts` l'éprouvent sur la base réelle.
 *
 * Deux écrans sont mesurés ici, et le second appartient au catalogue : la
 * liste des produits porte désormais la quantité et les deux filtres. Les cas
 * vivent de ce côté-ci parce que c'est la story qui les a écrits — les
 * déplacer dans `catalogue.test.tsx` les séparerait de la règle qu'ils
 * tiennent.
 *
 * Trois choses valent d'être dites plutôt que seulement affirmées :
 *
 *   — **« Stock non saisi » n'est pas « 0 »** (SPEC § 2.5). Les deux lignes ont
 *     la même quantité en base ; seule `last_movement_at` les distingue, et
 *     l'écran doit porter cette distinction jusqu'au bout ;
 *   — **le négatif est un repère, pas une alerte** (RÈGLE M2-3). Le test
 *     vérifie la classe *et* l'absence de `role="alert"` : un grossiste vend ce
 *     qui est encore sur le camion, et rien ne doit l'arrêter ;
 *   — **une source par état.** Sous un filtre, la liste ne doit pas appeler
 *     `search_products` — c'est ce qui garantit que le filtre porte sur tout le
 *     catalogue et non sur 50 résultats.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

interface Call {
  table: string
  filters: Array<[string, string, unknown]>
  /** Ce qu'un `insert` envoie — l'ajustement d'E3-03 est la première écriture. */
  payload?: unknown
}

interface Response {
  data: unknown
  error: { code?: string; message: string } | null
}

/*
 * Une réponse qui n'arrive jamais : le seul moyen de tenir l'état de chargement
 * immobile le temps d'une assertion. Une réponse vide le traverse en quelques
 * millisecondes, et le test gagnait ou perdait la course selon ce qui tournait
 * avant lui — vert seul, rouge dans le fichier.
 */
const PENDING = Symbol('réponse en attente')

const calls: Call[] = []
const rpcCalls: Array<{ name: string; args: unknown }> = []
const respond = vi.fn<(call: Call) => Response | typeof PENDING>()
const respondRpc = vi.fn<(name: string, args: unknown) => Response>()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, filters: [] }
      const filter = (op: string) => (column: string, value: unknown) => {
        call.filters.push([op, column, value])
        return builder
      }
      const builder = {
        select: () => builder,
        insert: (payload: unknown) => {
          call.payload = payload
          return builder
        },
        eq: filter('eq'),
        is: filter('is'),
        lt: filter('lt'),
        in: filter('in'),
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => builder,
        then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push(call)
          const answer = respond(call)
          if (answer === PENDING) return new Promise(() => {})
          return Promise.resolve(answer).then(resolve, reject)
        },
      }
      return builder
    },
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args })
      return Promise.resolve(respondRpc(name, args))
    },
    storage: {
      from: () => ({ createSignedUrls: vi.fn(async () => ({ data: [], error: null })) }),
    },
    functions: { invoke: vi.fn() },
  },
}))

function renderAt(path: string, role: string) {
  render(
    <AuthProvider client={createFakeAuthClient({ initialSession: fakeSession({ role }) })}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  )
}

/* -------------------------------------------------------------------------- */
/* Les données, telles que PostgREST les rend — quantités en texte             */
/* -------------------------------------------------------------------------- */

const MOVEMENTS = [
  {
    id: 'm3',
    created_at: '2026-10-06T08:00:00Z',
    movement_type: 'sale',
    quantity: '-80.000',
    source_type: 'sale_document',
    source_id: 'd1',
    note: null,
    author_name: 'Rachid',
  },
  {
    id: 'm2',
    created_at: '2026-10-03T08:00:00Z',
    movement_type: 'adjustment',
    quantity: '-5.500',
    source_type: null,
    source_id: null,
    note: 'Casse',
    author_name: 'Fatima',
  },
  {
    id: 'm1',
    created_at: '2026-10-01T08:00:00Z',
    movement_type: 'receipt',
    quantity: '100.000',
    source_type: null,
    source_id: null,
    note: null,
    author_name: 'Fatima',
  },
]

/** Un produit à une variante, négative — le cas du camion. */
const PRODUCT_NEGATIVE = {
  id: 'p1',
  name_fr: 'Savon 500 g',
  name_ar: null,
  code: 'SAV-500',
  variant: [
    {
      id: 'p1',
      sku: 'SAV-500',
      is_default: true,
      deleted_at: null,
      stock_level: [
        { quantity: '-4.500', last_movement_at: '2026-10-06T08:00:00Z', warehouse_id: 'w1' },
      ],
    },
  ],
}

beforeEach(() => {
  calls.length = 0
  rpcCalls.length = 0
  respond.mockReset()
  respondRpc.mockReset()
  respond.mockImplementation(() => ({ data: [], error: null }))
  respondRpc.mockImplementation(() => ({ data: [], error: null }))
})

/* ========================================================================== */
/* La fiche variante                                                           */
/* ========================================================================== */

describe('la fiche stock d’une variante', () => {
  const withProduct = (product: unknown, movements: unknown = MOVEMENTS): void => {
    respond.mockImplementation((call) =>
      call.table === 'product' ? { data: product, error: null } : { data: [], error: null },
    )
    respondRpc.mockImplementation((name) =>
      name === 'list_stock_movements' ? { data: movements, error: null } : { data: [], error: null },
    )
  }

  it('montre l’historique complet, du plus récent au plus ancien', async () => {
    withProduct(PRODUCT_NEGATIVE)
    renderAt('/products/p1/stock', 'worker')

    await screen.findByText('Savon 500 g')

    const lines = await screen.findAllByRole('listitem')
    expect(lines).toHaveLength(3)
    // L'ordre vient de la base ; l'écran ne le retrie pas, et ne doit pas.
    expect(lines.map((line) => within(line).getByText(/Vente|Ajustement|Réception/).textContent))
      .toEqual(['Vente', 'Ajustement', 'Réception'])
  })

  it('chaque mouvement porte sa date, son type, sa quantité, son auteur et son document', async () => {
    withProduct(PRODUCT_NEGATIVE)
    renderAt('/products/p1/stock', 'worker')

    const first = (await screen.findAllByRole('listitem'))[0]!
    const line = within(first)

    expect(line.getByText('Vente')).toBeInTheDocument()
    expect(line.getByText('06/10/2026 09:00')).toBeInTheDocument()
    expect(line.getByText('-80')).toBeInTheDocument()
    // Auteur et document sur la même ligne : c'est ce qu'on cherche un soir où
    // une quantité ne tombe pas juste.
    expect(line.getByText(/Rachid · Bon de vente/)).toBeInTheDocument()
  })

  /*
   * Un ajustement n'a pas de document — la table n'existe pas avant E4, et
   * E3-03 n'en créera pas : son motif tient lieu de justification. La ligne
   * montre le motif plutôt qu'un tiret, sinon l'écran perdrait la seule chose
   * qui explique le mouvement.
   */
  it('à défaut de document, montre le motif de l’ajustement', async () => {
    withProduct(PRODUCT_NEGATIVE)
    renderAt('/products/p1/stock', 'worker')

    const lines = await screen.findAllByRole('listitem')
    expect(within(lines[1]!).getByText(/Fatima · Casse/)).toBeInTheDocument()
  })

  /*
   * BRAND-UI § 8 : quatre états, et un test chacun. Les réunir dans un seul cas
   * demandait trois rendus successifs dans la même monture — la première
   * version faisait cela, et les trois écrans se marchaient dessus.
   */
  it('état de chargement : montre la forme de ce qui arrive', async () => {
    respond.mockImplementation(() => PENDING)
    renderAt('/products/p1/stock', 'worker')

    // Pas un rond qui tourne au centre (BRAND-UI § 8).
    expect(await screen.findByLabelText('Chargement du stock')).toBeInTheDocument()
  })

  it('état d’erreur : dit ce qui s’est passé, et offre de réessayer', async () => {
    respond.mockImplementation(() => ({ data: null, error: { message: 'réseau coupé' } }))
    renderAt('/products/p1/stock', 'worker')

    expect(await screen.findByRole('alert')).toHaveTextContent('réseau coupé')
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })

  it('état vide : une variante sans aucun mouvement le dit', async () => {
    withProduct(PRODUCT_NEGATIVE, [])
    renderAt('/products/p1/stock', 'worker')

    expect(await screen.findByText(/Aucun mouvement sur cette variante/)).toBeInTheDocument()
  })

  it('produit introuvable : l’écran le dit plutôt que de rester vide', async () => {
    respond.mockImplementation(() => ({ data: null, error: null }))
    respondRpc.mockImplementation(() => ({ data: [], error: null }))
    renderAt('/products/inconnu/stock', 'worker')

    expect(await screen.findByText(/Ce produit n’existe pas, ou plus/)).toBeInTheDocument()
  })
})

/* ========================================================================== */
/* RÈGLE M2-3 — le négatif est un repère, jamais un blocage                    */
/* ========================================================================== */

describe('RÈGLE M2-3 — le stock négatif', () => {
  it('se marque par la couleur et le fond, sans alerte ni blocage', async () => {
    respond.mockImplementation((call) =>
      call.table === 'product' ? { data: PRODUCT_NEGATIVE, error: null } : { data: [], error: null },
    )
    respondRpc.mockImplementation(() => ({ data: [], error: null }))
    renderAt('/products/p1/stock', 'worker')

    const marker = await screen.findByText('-4,5')
    // BRAND-UI § 5, « Attention » : la teinte **et** le fond, pour le plein soleil.
    expect(marker).toHaveClass('text-amber-700', 'bg-amber-100')
    // Un repère, pas un événement : rien qui interpelle, rien qui bloque.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

/* ========================================================================== */
/* SPEC § 2.5 — « 0 compté » et « jamais saisi » ne se lisent pas pareil        */
/* ========================================================================== */

describe('un zéro compté ne se lit pas comme un stock jamais saisi', () => {
  const twoKindsOfZero = {
    id: 'p2',
    name_fr: 'Crème',
    name_ar: null,
    code: null,
    variant: [
      {
        id: 'v-compte',
        sku: 'A',
        is_default: true,
        deleted_at: null,
        stock_level: [
          { quantity: '0.000', last_movement_at: '2026-10-06T08:00:00Z', warehouse_id: 'w1' },
        ],
      },
      {
        id: 'v-jamais',
        sku: 'B',
        is_default: false,
        deleted_at: null,
        stock_level: [{ quantity: '0.000', last_movement_at: null, warehouse_id: 'w1' }],
      },
    ],
  }

  it('écrit « 0 » pour l’un et « Stock non saisi » pour l’autre', async () => {
    respond.mockImplementation((call) =>
      call.table === 'product' ? { data: twoKindsOfZero, error: null } : { data: [], error: null },
    )
    renderAt('/products/p2/stock', 'worker')

    const variants = await screen.findByRole('group', { name: 'Variantes' })
    const rows = within(variants).getAllByRole('button')

    expect(within(rows[0]!).getByText('0')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Stock non saisi')).toBeInTheDocument()
    // La même quantité en base, deux lectures : c'est tout l'objet de § 2.5.
    expect(within(rows[1]!).queryByText('0')).not.toBeInTheDocument()
  })
})

/* ========================================================================== */
/* La liste des produits : quantité et filtres                                 */
/* ========================================================================== */

describe('la liste des produits porte le stock', () => {
  const HIT = {
    variant_id: 'v1',
    product_id: 'p1',
    name_fr: 'Savon 500 g',
    name_ar: null,
    code: 'SAV-500',
    sku: 'SAV-500',
    barcode: null,
    photo_url: null,
  }

  const searchFinds = (hits: unknown[], levels: unknown[]): void => {
    respondRpc.mockImplementation((name) =>
      name === 'search_products' ? { data: hits, error: null } : { data: [], error: null },
    )
    respond.mockImplementation((call) =>
      call.table === 'stock_level' ? { data: levels, error: null } : { data: [], error: null },
    )
  }

  /*
   * Portée au contenu de l'écran : la barre d'onglets est elle aussi une liste,
   * et ses `li` répondent à `listitem`. Interroger la page entière confondrait
   * les deux.
   */
  /*
   * Les lignes de la liste, et elles seules : la barre d'onglets est elle aussi
   * une liste, et ses `li` répondent à `listitem`.
   *
   * L'attente porte sur un texte attendu plutôt que sur le rôle. La liste tient
   * deux allers-retours — la recherche, puis les niveaux — et une attente sur
   * « au moins un listitem » serait satisfaite par la barre d'onglets, qui est
   * là dès le premier rendu : le test lirait une liste vide et conclurait que
   * l'écran est cassé.
   */
  const productRows = async (name = 'Savon 500 g') => {
    await screen.findByText(name)
    return within(screen.getByRole('main')).getAllByRole('listitem')
  }

  it('montre la quantité de chaque ligne', async () => {
    searchFinds([HIT], [{ variant_id: 'v1', quantity: '12.000', last_movement_at: '2026-10-06T08:00:00Z' }])
    renderAt('/products', 'worker')

    const rows = await productRows()
    expect(rows).toHaveLength(1)
    expect(within(rows[0]!).getByText('12')).toBeInTheDocument()
  })

  /*
   * Une source par état. Sous un filtre, `search_products` ne doit **pas** être
   * appelée : c'est ce qui garantit que « stock négatif » porte sur tout le
   * catalogue et non sur les 50 résultats d'une recherche.
   */
  it('sous un filtre, interroge stock_level et non la recherche', async () => {
    searchFinds([HIT], [])
    renderAt('/products', 'worker')
    await productRows()

    rpcCalls.length = 0
    calls.length = 0
    respond.mockImplementation(() => ({
      data: [
        {
          variant_id: 'v9',
          quantity: '-3.000',
          last_movement_at: '2026-10-06T08:00:00Z',
          variant: {
            sku: 'NEG',
            product: { id: 'p9', name_fr: 'Produit négatif', name_ar: null, code: 'NEG', photo_url: null },
          },
        },
      ],
      error: null,
    }))

    await userEvent.click(screen.getByRole('button', { name: 'Stock négatif' }))

    await screen.findByText('Produit négatif')
    expect(rpcCalls.filter((c) => c.name === 'search_products')).toHaveLength(0)
    const read = calls.find((c) => c.table === 'stock_level')
    expect(read?.filters).toContainEqual(['lt', 'quantity', 0])
  })

  it('le champ de recherche disparaît sous un filtre, et revient avec « Tous les produits »', async () => {
    searchFinds([HIT], [])
    renderAt('/products', 'worker')
    await productRows()

    expect(screen.getByLabelText('Rechercher un produit')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Stock à zéro' }))
    await waitFor(() =>
      expect(screen.queryByLabelText('Rechercher un produit')).not.toBeInTheDocument(),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Tous les produits' }))
    await waitFor(() => expect(screen.getByLabelText('Rechercher un produit')).toBeInTheDocument())
  })

  it('un filtre sans résultat est une bonne nouvelle, pas un catalogue vide', async () => {
    searchFinds([HIT], [])
    renderAt('/products', 'worker')
    await productRows()

    respond.mockImplementation(() => ({ data: [], error: null }))
    await userEvent.click(screen.getByRole('button', { name: 'Stock négatif' }))

    expect(await screen.findByText('Aucun stock négatif.')).toBeInTheDocument()
  })

  /*
   * Où mène une ligne, selon le rôle. Jusqu'ici la ligne ne menait nulle part
   * pour le vendeur — il ne peut pas ouvrir la fiche produit. C'est le seul
   * chemin par lequel il atteint le stock.
   */
  it.each([
    ['worker', '/products/p1/stock'],
    ['owner', '/products/p1'],
  ])('pour un %s, la ligne mène à %s', async (role, destination) => {
    searchFinds([HIT], [])
    renderAt('/products', role)

    const rows = await productRows()
    expect(within(rows[0]!).getByRole('link')).toHaveAttribute('href', destination)
  })
})

/* ========================================================================== */
/* E3-03 — l'ajustement manuel                                                 */
/* ========================================================================== */

/*
 * Ce qui est mesuré ici est l'écran : qui voit la section, ce qu'elle envoie, et
 * ce qu'elle refuse d'envoyer. Ce qui *protège* est ailleurs et s'éprouve sur la
 * base réelle (`supabase/tests/stock-adjustment.test.ts`) : la policy
 * `column_capability_insert` pour le rôle, la contrainte
 * `stock_movement_adjustment_reason` pour le motif, le trigger d'audit pour la
 * trace. Masquer n'est pas interdire.
 */
describe('l’ajustement d’une quantité', () => {
  const SECTION = 'Ajuster la quantité'

  const withProduct = (movements: unknown = []): void => {
    respond.mockImplementation((call) =>
      call.table === 'product' ? { data: PRODUCT_NEGATIVE, error: null } : { data: [], error: null },
    )
    respondRpc.mockImplementation(() => ({ data: movements, error: null }))
  }

  const fill = async (quantity: string, reason: string): Promise<void> => {
    await userEvent.type(screen.getByLabelText('Quantité corrigée'), quantity)
    if (reason !== '') await userEvent.type(screen.getByLabelText('Motif (obligatoire)'), reason)
  }

  const submit = (): HTMLElement =>
    screen.getByRole('button', { name: 'Enregistrer l’ajustement' })

  it('n’est pas offert au vendeur', async () => {
    withProduct()
    renderAt('/products/p1/stock', 'worker')

    await screen.findByText('Savon 500 g')
    expect(screen.queryByText(SECTION)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Quantité corrigée')).not.toBeInTheDocument()
  })

  it('est offert au patron', async () => {
    withProduct()
    renderAt('/products/p1/stock', 'owner')

    expect(await screen.findByText(SECTION)).toBeInTheDocument()
  })

  /*
   * Le critère : ce qui part en base est la **différence**, pas la quantité
   * saisie. Le stock vaut -4,5 ; corrigé à 12, l'ajustement est de +16,5 — et
   * il est écrit en texte, à trois décimales, jamais en flottant (CLAUDE.md).
   */
  it('envoie un mouvement adjustment de la différence, motif compris', async () => {
    withProduct()
    renderAt('/products/p1/stock', 'owner')
    await screen.findByText(SECTION)

    await fill('12', 'Carton retrouvé en réserve')
    expect(screen.getByText('+16,5')).toBeInTheDocument()

    await userEvent.click(submit())

    const written = await waitFor(() => {
      const call = calls.find((c) => c.table === 'stock_movement')
      expect(call, 'aucune écriture de mouvement').toBeDefined()
      return call!
    })

    expect(written.payload).toEqual({
      variant_id: 'p1',
      warehouse_id: 'w1',
      movement_type: 'adjustment',
      quantity: '16.500',
      note: 'Carton retrouvé en réserve',
    })
  })

  /*
   * Ni `tenant_id` ni `created_by` : le commerce et l'auteur viennent du jeton,
   * par les défauts de la colonne (SPEC § 4 ; E3-03 pour l'auteur). Les envoyer
   * serait laisser l'appareil signer à la place du jeton — et la trace ne
   * prouverait plus rien.
   */
  it('ne signe pas l’écriture lui-même', async () => {
    withProduct()
    renderAt('/products/p1/stock', 'owner')
    await screen.findByText(SECTION)

    await fill('12', 'Carton retrouvé')
    await userEvent.click(submit())

    const written = await waitFor(() => calls.find((c) => c.table === 'stock_movement')!)
    expect(Object.keys(written.payload as object).sort()).toEqual([
      'movement_type',
      'note',
      'quantity',
      'variant_id',
      'warehouse_id',
    ])
  })

  it('sans motif, le bouton reste inerte et rien n’est envoyé', async () => {
    withProduct()
    renderAt('/products/p1/stock', 'owner')
    await screen.findByText(SECTION)

    await fill('12', '')
    expect(submit()).toBeDisabled()

    await userEvent.click(submit())
    expect(calls.find((c) => c.table === 'stock_movement')).toBeUndefined()
  })

  /*
   * La différence se calcule depuis un niveau **négatif** sans que le signe se
   * perde : le stock vaut -4,5, et compter 4,5 sur l'étagère est un ajustement
   * de +9, pas de 0. C'est l'erreur que `quantityText()` et `adjustmentDelta()`
   * traitent chacun de leur côté, et celle qui ferait écrire un mouvement faux.
   */
  it('calcule la différence depuis un niveau négatif', async () => {
    withProduct()
    renderAt('/products/p1/stock', 'owner')
    await screen.findByText(SECTION)

    await fill('4,5', 'Vérifié')
    expect(screen.getByText('+9')).toBeInTheDocument()
    expect(submit()).toBeEnabled()
  })

  /*
   * Une quantité déjà juste n'est pas une erreur de saisie, et elle n'écrit
   * rien : `stock_movement` refuse une quantité de zéro depuis E3-01, et un
   * mouvement qui ne dit rien encombrerait l'historique qu'on relit pour
   * comprendre un écart.
   */
  it('une quantité identique au stock n’envoie rien', async () => {
    const counted = {
      ...PRODUCT_NEGATIVE,
      variant: [
        {
          ...PRODUCT_NEGATIVE.variant[0]!,
          stock_level: [
            { quantity: '12.000', last_movement_at: '2026-10-06T08:00:00Z', warehouse_id: 'w1' },
          ],
        },
      ],
    }
    respond.mockImplementation((call) =>
      call.table === 'product' ? { data: counted, error: null } : { data: [], error: null },
    )
    respondRpc.mockImplementation(() => ({ data: [], error: null }))
    renderAt('/products/p1/stock', 'owner')
    await screen.findByText(SECTION)

    await fill('12', 'Vérifié')
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(submit()).toBeDisabled()

    await userEvent.click(submit())
    expect(calls.find((c) => c.table === 'stock_movement')).toBeUndefined()
  })

  /*
   * Après l'écriture, le niveau et l'historique sont **relus**. Un écran qui
   * ajouterait la ligne localement afficherait une quantité qu'aucune base n'a
   * confirmée — exactement ce que SPEC § 2.5 refuse.
   */
  it('relit le stock et l’historique après l’écriture', async () => {
    withProduct()
    renderAt('/products/p1/stock', 'owner')
    await screen.findByText(SECTION)

    const readsBefore = calls.filter((c) => c.table === 'product').length
    const historyBefore = rpcCalls.filter((c) => c.name === 'list_stock_movements').length

    await fill('12', 'Carton retrouvé')
    await userEvent.click(submit())

    await waitFor(() => {
      expect(calls.filter((c) => c.table === 'product').length).toBeGreaterThan(readsBefore)
      expect(rpcCalls.filter((c) => c.name === 'list_stock_movements').length).toBeGreaterThan(
        historyBefore,
      )
    })
  })

  /*
   * Le refus du serveur se dit en une phrase, sous le formulaire. L'employé n'a
   * pas la section ; cette phrase est donc pour le patron dont le jeton ne porte
   * pas ce qu'il croit — un rôle changé pendant sa session, par exemple.
   */
  it('dit le refus du serveur sans perdre la saisie', async () => {
    withProduct()
    respond.mockImplementation((call) => {
      if (call.table === 'product') return { data: PRODUCT_NEGATIVE, error: null }
      if (call.table === 'stock_movement') {
        return { data: null, error: { code: '42501', message: 'new row violates row-level…' } }
      }
      return { data: [], error: null }
    })
    renderAt('/products/p1/stock', 'owner')
    await screen.findByText(SECTION)

    await fill('12', 'Carton retrouvé')
    await userEvent.click(submit())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Seul le patron peut ajuster une quantité.',
    )
    // La saisie reste : la refaire après un refus est le meilleur moyen de la
    // retaper autrement.
    expect(screen.getByLabelText('Motif (obligatoire)')).toHaveValue('Carton retrouvé')
  })
})
