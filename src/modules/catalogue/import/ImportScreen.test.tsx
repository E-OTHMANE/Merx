/*
 * E2-05 — l'écran d'import, de bout en bout côté appareil.
 *
 * Ce qui se vérifie ici : le parcours qu'un commerçant fait une seule fois,
 * mais dont tout dépend (SPEC § 10, point de rupture n° 1) — déposer, relire
 * la correspondance proposée, voir l'aperçu, importer, et repartir avec le
 * fichier des lignes rejetées.
 *
 * Ce qui ne s'y vérifie pas, parce que rien ici n'en dépend : ce que la base
 * fait des lignes. `supabase/tests/product-import.test.ts` l'éprouve sur la
 * base réelle — atomicité par ligne, réimport, gardes.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'
import type { RowReport } from '@/modules/catalogue/import/importer'

interface RpcCall {
  fn: string
  rows: Array<Record<string, unknown>>
}

const calls: RpcCall[] = []
const respond = vi.fn<(call: RpcCall) => { data: unknown; error: unknown }>()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        order: () => builder,
        maybeSingle: () => builder,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      }
      return builder
    },
    storage: { from: () => ({ createSignedUrls: vi.fn() }) },
    rpc: (fn: string, args: { rows?: Array<Record<string, unknown>> }) => {
      const call: RpcCall = { fn, rows: args?.rows ?? [] }
      return {
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push(call)
          return Promise.resolve(respond(call)).then(resolve, reject)
        },
      }
    },
    functions: { invoke: vi.fn() },
  },
}))

function renderImport(role = 'owner') {
  render(
    <AuthProvider
      client={createFakeAuthClient({
        initialSession: fakeSession({ role, email: 'patron@merx.ma', userId: 'auth-patron' }),
      })}
    >
      <MemoryRouter initialEntries={['/products/import']}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  )
}

/* Un fichier de grossiste tel qu'il arrive : point-virgule, prix en texte. */
const FILE = [
  'Référence;Désignation;Marque;PV;Prix achat',
  'LOR-12;Crème hydratante;Nivea;15,00 DH;9,50',
  'LOR-13;Savon noir;Taous;8,50;5,00',
  'LOR-14;Shampooing;Dove;1.250;7,00',
  ';;;;',
].join('\r\n')

const csvFile = (text = FILE): File =>
  new File([text], 'catalogue.csv', { type: 'text/csv' })

/* Le sort que la base rend pour chaque ligne envoyée. */
const accepted = (rows: Array<Record<string, unknown>> | undefined): RowReport[] =>
  (rows ?? []).map((row) => ({ line: row.line as number, outcome: 'created', product_id: 'p' }))

beforeEach(() => {
  calls.length = 0
  respond.mockReset()
  respond.mockImplementation((call) => ({ data: accepted(call.rows), error: null }))
})

describe('l’écran d’import', () => {
  it('propose la correspondance, montre l’aperçu, et n’envoie que les lignes valides', async () => {
    const user = userEvent.setup()
    renderImport()

    await user.upload(await screen.findByLabelText('Fichier à importer'), csvFile())

    // Correspondance proposée sans rien demander.
    const name = await screen.findByLabelText(/Nom du produit/)
    expect((name as HTMLSelectElement).value).toBe('1')
    expect((screen.getByLabelText(/Référence/) as HTMLSelectElement).value).toBe('0')
    expect((screen.getByLabelText(/Prix de vente/) as HTMLSelectElement).value).toBe('3')
    expect((screen.getByLabelText(/Prix d’achat/) as HTMLSelectElement).value).toBe('4')

    // L'aperçu montre les lignes prêtes, le prix lu, et la ligne vide ignorée.
    const preview = screen.getByRole('table')
    expect(within(preview).getByText('Crème hydratante')).toBeInTheDocument()
    expect(within(preview).getByText('15.00')).toBeInTheDocument()

    // La ligne au prix ambigu est rejetée avant l'envoi, en citant sa valeur.
    expect(screen.getByText(/Ligne 4 —.*1\.250/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Importer 2 lignes/ }))

    await screen.findByText('Import terminé')
    // L'enregistrement de l'appareil passe par la même porte (E1-03) : on ne
    // regarde que les appels de l'import.
    const sent = calls.filter((call) => call.fn === 'import_products')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.rows.map((row) => row.code)).toEqual(['LOR-12', 'LOR-13'])
    expect(sent[0]!.rows[0]).toEqual({
      line: 2,
      name_fr: 'Crème hydratante',
      code: 'LOR-12',
      brand: 'Nivea',
      unit_price: '15.00',
      cost_price: '9.50',
    })
  })

  it('rend compte de ce qui est entré et de ce qui a été rejeté', async () => {
    const user = userEvent.setup()
    respond.mockImplementation((call) => ({
      data: [
        { line: call.rows[0]?.line as number, outcome: 'created', product_id: 'p1' },
        {
          line: call.rows[1]?.line as number,
          outcome: 'rejected',
          code: '23505',
          constraint: 'product_code_per_tenant',
          message: 'duplicate key',
        },
      ] satisfies RowReport[],
      error: null,
    }))
    renderImport()

    await user.upload(await screen.findByLabelText('Fichier à importer'), csvFile())
    await user.click(await screen.findByRole('button', { name: /Importer 2 lignes/ }))

    await screen.findByText('Import terminé')
    const report = screen.getByRole('region', { name: 'Import terminé' })
    // Une ligne créée, et deux rejets : celui de l'appareil, celui de la base.
    expect(within(report).getByText('Produits créés').nextSibling).toHaveTextContent('1')
    expect(within(report).getByText('Lignes rejetées').nextSibling).toHaveTextContent('2')
    expect(screen.getByText(/Référence déjà utilisée/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Télécharger les lignes rejetées' }),
    ).toBeInTheDocument()
  })

  it('dit d’un refus de la base qu’il vient du compte, sans perdre le fichier', async () => {
    const user = userEvent.setup()
    respond.mockImplementation(() => ({
      data: null,
      error: { code: '42501', message: 'permission denied' },
    }))
    renderImport()

    await user.upload(await screen.findByLabelText('Fichier à importer'), csvFile())
    await user.click(await screen.findByRole('button', { name: /Importer 2 lignes/ }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/ne peut pas importer le catalogue/),
    )
    // Le fichier reste chargé : on ne redemande pas ce qu'on a déjà.
    expect(screen.getByRole('button', { name: /Importer 2 lignes/ })).toBeInTheDocument()
  })

  it('n’offre pas le prix d’achat à un compte qui ne le lit pas (SPEC § 3)', async () => {
    const user = userEvent.setup()
    renderImport('worker')
    /*
     * Le garde de route renvoie l'employé ailleurs : `manage_product` lui
     * manque. L'écran n'existe donc pas pour lui — ce qui protège reste le
     * garde de `import_products()` et les policies (product-import.test.ts).
     */
    await waitFor(() => expect(screen.queryByText('Importer un fichier')).not.toBeInTheDocument())
    expect(screen.queryByLabelText(/Prix d’achat/)).not.toBeInTheDocument()
    await user.tab()
  })
})
