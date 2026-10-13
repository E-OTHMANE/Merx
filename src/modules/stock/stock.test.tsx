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
      stock_level: [{ quantity: '-4.500', last_movement_at: '2026-10-06T08:00:00Z' }],
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
        stock_level: [{ quantity: '0.000', last_movement_at: '2026-10-06T08:00:00Z' }],
      },
      {
        id: 'v-jamais',
        sku: 'B',
        is_default: false,
        deleted_at: null,
        stock_level: [{ quantity: '0.000', last_movement_at: null }],
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
