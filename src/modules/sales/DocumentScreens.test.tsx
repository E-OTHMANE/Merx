/*
 * La liste et le détail des documents — E4-07, côté interface.
 *
 * Ce que les écrans envoient et ce qu'ils disent. Que la base borne au
 * commerce, rende l'auteur à un employé ou refuse l'annulation à qui n'a pas
 * `cancel_document` ne dépend d'aucun de ces composants :
 * `supabase/tests/sale-document-list.test.ts` et `sale-document-api.test.ts`
 * l'éprouvent sur la base réelle. Ici, deux choses qu'aucun test de base ne
 * peut voir :
 *
 *   — **quatre états par écran** (BRAND-UI § 8) : chargement, vide, erreur,
 *     contenu ;
 *   — **deux gardes sur l'annulation, deux phrases** (CLAUDE.md) : le motif
 *     vide est refusé à l'écran avec la sienne, et la base, quand c'est elle
 *     qui refuse, parle avec la sienne — affichée telle quelle.
 *
 * ÉCRIT SANS STACK, ET SANS ÊTRE LANCÉ (docs/PENDING-CHECKS.md, « E4-07 »).
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

/*
 * L'impression (E5-01). Seules deux fonctions sont remplacées : « sommes-nous
 * dans l'enveloppe Android » — faux en jsdom, donc jamais de bouton sans le
 * dire ici — et l'envoi lui-même. Tout le reste est le vrai code : c'est lui
 * qui construit le ticket, et c'est le ticket qu'on veut voir.
 */
const printing = vi.hoisted(() => ({
  native: false,
  printTicket: vi.fn(),
  /*
   * Le PDF (E5-03). Deux remplacements, et pour une raison de plateforme : le
   * rendu demande un contexte 2D que jsdom n'a pas, et le partage n'irait nulle
   * part. Ce qui reste du vrai code est ce qui se verifie — la mise en page, le
   * nom du fichier, et la porte qui decide si l'action s'offre.
   */
  buildPdf: vi.fn(),
  share: vi.fn(),
}))

vi.mock('@/lib/printing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/printing')>()),
  thermalPrinting: () => printing.native,
  printTicket: printing.printTicket,
  buildDocumentPdf: printing.buildPdf,
  pdfSharing: () => ({ share: printing.share }),
}))

interface Call {
  table: string
  columns: string
  payload?: unknown
  filters: Array<[string, string, unknown]>
}

interface Response {
  data: unknown
  error: { code?: string; message: string } | null
}

/* Une réponse qui n'arrive jamais : tient l'état de chargement immobile. */
const PENDING = Symbol('réponse en attente')

const calls: Call[] = []
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
const respond = vi.fn<(call: Call) => Response>()
const respondRpc = vi.fn<(args: Record<string, unknown>) => Response | typeof PENDING>()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, columns: '', filters: [] }
      const filter = (op: string) => (column: string, value: unknown) => {
        call.filters.push([op, column, value])
        return builder
      }
      const builder = {
        select: (columns: string) => {
          call.columns = columns
          return builder
        },
        update: (payload: unknown) => {
          call.payload = payload
          return builder
        },
        eq: filter('eq'),
        is: filter('is'),
        order: () => builder,
        maybeSingle: () => builder,
        then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push(call)
          return Promise.resolve(respond(call)).then(resolve, reject)
        },
      }
      return builder
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      const answer = respondRpc(args)
      if (answer === PENDING) return new Promise(() => {})
      return Promise.resolve(answer)
    },
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

const NBSP = ' '

const summaryRow = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `d-${n}`,
  doc_type: 'delivery_note',
  doc_number: `BL-A-26-${String(n).padStart(5, '0')}`,
  status: 'confirmed',
  subtotal: '228.00',
  discount_total: '0.00',
  total: '228.00',
  notes: null,
  cancellation_reason: null,
  issued_at: '2026-10-06T08:00:00Z',
  created_at: '2026-10-06T07:59:00Z',
  sort_at: '2026-10-06T08:00:00Z',
  source_document_id: null,
  device_id: 'dev-a',
  device_label: 'Comptoir',
  device_prefix: 'A',
  author_name: 'Fatima',
  ...overrides,
})

beforeEach(() => {
  calls.length = 0
  rpcCalls.length = 0
  respond.mockReset()
  respondRpc.mockReset()
  respond.mockReturnValue({ data: [], error: null })
  printing.native = false
  printing.buildPdf.mockReset()
  printing.buildPdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]))
  printing.share.mockReset()
  printing.share.mockResolvedValue('shared')
  printing.printTicket.mockReset()
  printing.printTicket.mockResolvedValue(undefined)
})

/* ========================================================================== */
/* La liste                                                                    */
/* ========================================================================== */

describe('la liste des documents', () => {
  it('montre sa forme pendant le chargement', async () => {
    respondRpc.mockReturnValue(PENDING)
    renderAt('/documents', 'worker')

    expect(await screen.findByLabelText('Chargement des documents')).toHaveAttribute('aria-busy', 'true')
  })

  it('invite à agir quand il n’y a aucun document', async () => {
    respondRpc.mockReturnValue({ data: [], error: null })
    renderAt('/documents', 'worker')

    expect(await screen.findByText(/Aucun document pour l’instant/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Faire une vente' })).toHaveAttribute('href', '/sale')
  })

  it('dit l’erreur et propose de réessayer', async () => {
    respondRpc.mockReturnValueOnce({ data: null, error: { message: 'Réseau indisponible.' } })
    respondRpc.mockReturnValue({ data: [summaryRow(1)], error: null })
    renderAt('/documents', 'worker')

    expect(await screen.findByRole('alert')).toHaveTextContent('Réseau indisponible.')
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))

    expect(await screen.findByText('BL-A-26-00001')).toBeInTheDocument()
  })

  it('liste les documents avec leur numéro, leur type, leur statut et leur total', async () => {
    respondRpc.mockReturnValue({
      data: [
        summaryRow(2, { total: '1250.50' }),
        summaryRow(1, { doc_type: 'quote', doc_number: 'DV-A-26-00001', status: 'confirmed' }),
      ],
      error: null,
    })
    renderAt('/documents', 'worker')

    const first = await screen.findByRole('link', { name: /BL-A-26-00002/ })
    expect(first).toHaveAttribute('href', '/documents/d-2')
    expect(first).toHaveTextContent('Bon de livraison')
    expect(first).toHaveTextContent(`1${NBSP}250,50${NBSP}DH`)
    expect(screen.getByRole('link', { name: /DV-A-26-00001/ })).toHaveTextContent('Devis')
  })

  it('un brouillon, qui n’a pas de numéro, reste atteignable et se dit brouillon', async () => {
    respondRpc.mockReturnValue({
      data: [summaryRow(3, { doc_number: null, status: 'draft', issued_at: null })],
      error: null,
    })
    renderAt('/documents', 'worker')

    const row = await screen.findByRole('link', { name: /Sans numéro/ })
    expect(row).toHaveTextContent('Brouillon')
  })

  it('garde un document annulé dans la liste, marqué par le mot et le montant barré', async () => {
    respondRpc.mockReturnValue({
      data: [summaryRow(4, { status: 'cancelled', cancellation_reason: 'Erreur' })],
      error: null,
    })
    renderAt('/documents', 'worker')

    const row = await screen.findByRole('link', { name: /BL-A-26-00004/ })
    expect(row).toHaveTextContent('Annulé')
    expect(within(row).getByText(`228,00${NBSP}DH`)).toHaveClass('line-through')
  })

  it('écrit « les 100 plus récents, affinez les filtres » quand la page est pleine', async () => {
    respondRpc.mockReturnValue({
      data: Array.from({ length: 101 }, (_, n) => summaryRow(n + 1)),
      error: null,
    })
    renderAt('/documents', 'worker')

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Les 100 plus récents sont affichés. Affinez les filtres',
    )
    expect(screen.getAllByRole('link', { name: /BL-A-26-/ })).toHaveLength(100)
  })

  it('n’écrit pas cette phrase sous la limite', async () => {
    respondRpc.mockReturnValue({ data: [summaryRow(1)], error: null })
    renderAt('/documents', 'worker')

    await screen.findByText('BL-A-26-00001')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('relance la lecture avec le numéro tapé', async () => {
    respondRpc.mockReturnValue({ data: [], error: null })
    renderAt('/documents', 'worker')

    await userEvent.type(await screen.findByLabelText(/^Numéro/), '42')

    await waitFor(() => expect(rpcCalls.at(-1)?.args['p_search']).toBe('42'))
  })

  it('relance la lecture avec le statut et le type choisis', async () => {
    respondRpc.mockReturnValue({ data: [], error: null })
    renderAt('/documents', 'worker')

    await userEvent.selectOptions(await screen.findByLabelText('Statut'), 'cancelled')
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'return')

    await waitFor(() => {
      const args = rpcCalls.at(-1)?.args
      expect(args?.['p_status']).toBe('cancelled')
      expect(args?.['p_doc_type']).toBe('return')
    })
  })

  it('dit qu’aucun document ne correspond, sous un filtre, plutôt que d’inviter à vendre', async () => {
    respondRpc.mockReturnValue({ data: [], error: null })
    renderAt('/documents', 'worker')

    await userEvent.selectOptions(await screen.findByLabelText('Statut'), 'delivered')

    expect(await screen.findByText(/Aucun document ne correspond à ces filtres/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Faire une vente' })).not.toBeInTheDocument()
  })

  it('traduit un jour en bornes de Casablanca', async () => {
    respondRpc.mockReturnValue({ data: [], error: null })
    renderAt('/documents', 'worker')

    const from = await screen.findByLabelText('Du')
    fireEvent.change(from, { target: { value: '2026-10-09' } })

    await waitFor(() => expect(rpcCalls.at(-1)?.args['p_from']).toBe('2026-10-09T00:00:00+01:00'))
  })

  /*
   * Le filtre par appareil est offert aux deux rôles, et pas de la même source :
   * le patron lit la liste des appareils (`manage_devices`) et voit « A —
   * Comptoir » ; l'employé, à qui `device` est fermée, voit les **lettres** que
   * les documents listés portent — et ne lit jamais `device`.
   */
  it('offre le filtre par appareil au patron, avec ses appareils', async () => {
    respondRpc.mockReturnValue({ data: [], error: null })
    respond.mockImplementation((call) =>
      call.table === 'device'
        ? {
            data: [
              { id: 'dev-a', label: 'Comptoir', prefix: 'A', last_sync_at: null, is_active: true },
              { id: 'dev-b', label: 'Tablette 2', prefix: 'B', last_sync_at: null, is_active: true },
            ],
            error: null,
          }
        : { data: [], error: null },
    )
    renderAt('/documents', 'owner')

    const select = await screen.findByLabelText('Appareil')
    await screen.findByRole('option', { name: 'B — Tablette 2' })
    await userEvent.selectOptions(select, 'dev-b')

    await waitFor(() => expect(rpcCalls.at(-1)?.args['p_device_id']).toBe('dev-b'))
  })

  it('l’offre à l’employé avec les seules lettres, sans jamais lire device', async () => {
    respondRpc.mockReturnValue({
      data: [
        summaryRow(1),
        summaryRow(2, { id: 'd-2', device_id: 'dev-b', device_prefix: 'B', device_label: 'Tablette 2' }),
      ],
      error: null,
    })
    renderAt('/documents', 'worker')

    const select = await screen.findByLabelText('Appareil')
    /* La lettre, et rien de l'appareil : ni libellé, ni « Tablette 2 ». */
    await screen.findByRole('option', { name: 'B' })
    expect(screen.queryByRole('option', { name: /Tablette 2/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Comptoir/ })).not.toBeInTheDocument()

    await userEvent.selectOptions(select, 'dev-b')

    /* Filtré par le même paramètre que le patron : la paire vient des lignes. */
    await waitFor(() => expect(rpcCalls.at(-1)?.args['p_device_id']).toBe('dev-b'))
    expect(
      calls.filter((call) => call.table === 'device'),
      'FUITE — l’employé lit le registre des appareils',
    ).toHaveLength(0)
  })

  /*
   * Une fois filtré sur « B », la page ne porte plus que des « B » : une liste
   * rebâtie à chaque chargement perdrait « A », donc le moyen d'en sortir.
   */
  it('garde les lettres déjà rencontrées quand la page filtrée n’en porte plus qu’une', async () => {
    respondRpc.mockImplementation((args: Record<string, unknown>) =>
      args['p_device_id'] === 'dev-b'
        ? {
            data: [
              summaryRow(2, { id: 'd-2', device_id: 'dev-b', device_prefix: 'B', device_label: 'Tablette 2' }),
            ],
            error: null,
          }
        : {
            data: [
              summaryRow(1),
              summaryRow(2, { id: 'd-2', device_id: 'dev-b', device_prefix: 'B', device_label: 'Tablette 2' }),
            ],
            error: null,
          },
    )
    renderAt('/documents', 'worker')

    const select = await screen.findByLabelText('Appareil')
    await screen.findByRole('option', { name: 'B' })
    await userEvent.selectOptions(select, 'dev-b')
    await waitFor(() => expect(rpcCalls.at(-1)?.args['p_device_id']).toBe('dev-b'))

    expect(screen.getByRole('option', { name: 'A' })).toBeInTheDocument()
    await userEvent.selectOptions(select, 'dev-a')
    await waitFor(() => expect(rpcCalls.at(-1)?.args['p_device_id']).toBe('dev-a'))
  })

  it('n’offre aucun filtre par client : la colonne naît en E6-01', async () => {
    respondRpc.mockReturnValue({ data: [], error: null })
    renderAt('/documents', 'owner')

    await screen.findByLabelText('Statut')
    expect(screen.queryByLabelText(/client/i)).not.toBeInTheDocument()
  })
})

/* ========================================================================== */
/* Le détail                                                                   */
/* ========================================================================== */

const LINE = {
  id: 'l-1',
  quantity: '24.000',
  unit_price: '9.50',
  line_discount: '0.00',
  line_total: '228.00',
  variant: { sku: 'SAV-1', product: { name_fr: 'Savon 500 g', code: 'SAV' } },
}

/** Les réglages d'un commerce qui a une imprimante (E1-05, E5-01). */
const SETTINGS = [
  {
    key: 'print_header',
    value: { business_name: 'Parfumerie Nour', phone: '+212612345678', address: 'Derb Omar' },
  },
  { key: 'default_language', value: 'fr' },
  { key: 'printer_address', value: '192.168.1.50:9100' },
  { key: 'printer_width', value: 576 },
]

interface Scenario {
  document?: Record<string, unknown> | null
  source?: Record<string, unknown> | null
  children?: Array<Record<string, unknown>>
  updateAnswer?: Response
  /** Les réglages que la base rend ; par défaut, un commerce sans imprimante. */
  settings?: Array<Record<string, unknown>>
}

/** Répond comme la base à chacune des quatre lectures du détail, et à l'annulation. */
function scenario({
  document = summaryRow(7),
  source = null,
  children = [],
  updateAnswer,
  settings = [],
}: Scenario = {}) {
  respondRpc.mockReturnValue({ data: document === null ? [] : [document], error: null })
  respond.mockImplementation((call) => {
    if (call.payload !== undefined) return updateAnswer ?? { data: [{ id: 'd-7' }], error: null }
    if (call.table === 'tenant_setting') return { data: settings, error: null }
    if (call.table === 'sale_line') return { data: [LINE], error: null }
    if (call.columns === 'source_document_id') {
      return { data: { source_document_id: source === null ? null : source['id'] }, error: null }
    }
    if (call.filters.some(([, column]) => column === 'source_document_id')) {
      return { data: children, error: null }
    }
    return { data: source, error: null }
  })
}

describe('le détail d’un document', () => {
  it('montre sa forme pendant le chargement', async () => {
    respondRpc.mockReturnValue(PENDING)
    respond.mockReturnValue({ data: [], error: null })
    renderAt('/documents/d-7', 'worker')

    expect(await screen.findByLabelText('Chargement du document')).toHaveAttribute('aria-busy', 'true')
  })

  it('dit que le document est introuvable, et propose de revenir à la liste', async () => {
    scenario({ document: null })
    renderAt('/documents/d-inconnu', 'worker')

    expect(await screen.findByRole('heading', { level: 1, name: 'Document introuvable' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Retour aux documents' })).toHaveAttribute('href', '/documents')
  })

  it('dit l’erreur et propose de réessayer', async () => {
    scenario()
    // Une seule fois : la première lecture échoue, la relecture réussit.
    respondRpc.mockReturnValueOnce({ data: null, error: { message: 'Réseau indisponible.' } })
    renderAt('/documents/d-7', 'worker')

    expect(await screen.findByRole('alert')).toHaveTextContent('Réseau indisponible.')
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'BL-A-26-00007' })).toBeInTheDocument()
  })

  /* Le critère : lignes, totaux, auteur, appareil, horodatage — lus par un employé. */
  it('affiche les lignes, les totaux, l’auteur, l’appareil et l’horodatage', async () => {
    scenario({
      document: summaryRow(7, { subtotal: '240.00', discount_total: '12.00', total: '228.00' }),
    })
    renderAt('/documents/d-7', 'worker')

    expect(await screen.findByRole('heading', { level: 1, name: 'BL-A-26-00007' })).toBeInTheDocument()

    const lines = screen.getByRole('region', { name: 'Lignes du document' })
    expect(within(lines).getByText('Savon 500 g')).toBeInTheDocument()
    expect(lines).toHaveTextContent(`24 × 9,50${NBSP}DH`)
    expect(lines).toHaveTextContent(`228,00${NBSP}DH`)

    const totals = screen.getByRole('region', { name: 'Totaux' })
    expect(totals).toHaveTextContent(`240,00${NBSP}DH`)
    expect(totals).toHaveTextContent(`12,00${NBSP}DH`)
    expect(screen.getByRole('status', { name: 'Total' })).toHaveTextContent(`228,00${NBSP}DH`)

    expect(screen.getByText('Fatima')).toBeInTheDocument()
    expect(screen.getByText('A — Comptoir')).toBeInTheDocument()
    // 06/10/2026 09:00 à Casablanca (UTC+1) pour 08:00 UTC.
    expect(screen.getByText('06/10/2026 09:00')).toBeInTheDocument()
  })

  it('marque un document annulé, avec son motif, et ne propose plus rien', async () => {
    scenario({
      document: summaryRow(7, { status: 'cancelled', cancellation_reason: 'Erreur de client' }),
    })
    renderAt('/documents/d-7', 'owner')

    expect(await screen.findByText('Document annulé')).toBeInTheDocument()
    expect(screen.getByText(/Motif : Erreur de client/)).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Total' })).toHaveClass('line-through')
    expect(screen.queryByRole('button', { name: 'Annuler ce document' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Transformer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Retour' })).not.toBeInTheDocument()
  })

  /* ---------------------------------------------------------------------- */
  /* La filiation, dans les deux sens                                         */
  /* ---------------------------------------------------------------------- */

  it('montre le document d’origine et tous ses enfants, avec un lien vers chacun', async () => {
    scenario({
      document: summaryRow(7, { doc_type: 'order', doc_number: 'CM-A-26-00007' }),
      source: { id: 'd-1', doc_type: 'quote', doc_number: 'DV-A-26-00001', status: 'confirmed' },
      children: [
        { id: 'd-8', doc_type: 'delivery_note', doc_number: 'BL-A-26-00008', status: 'confirmed' },
        { id: 'd-9', doc_type: 'delivery_note', doc_number: 'BL-A-26-00009', status: 'cancelled' },
      ],
    })
    renderAt('/documents/d-7', 'worker')

    const filiation = await screen.findByRole('region', { name: 'Filiation' })
    expect(within(filiation).getByRole('link', { name: /DV-A-26-00001/ })).toHaveAttribute(
      'href',
      '/documents/d-1',
    )
    // Un parent, plusieurs enfants (RÈGLE M3-4).
    expect(within(filiation).getByRole('link', { name: /BL-A-26-00008/ })).toHaveAttribute(
      'href',
      '/documents/d-8',
    )
    expect(within(filiation).getByRole('link', { name: /BL-A-26-00009/ })).toHaveTextContent('Annulé')
  })

  it('n’affiche pas de filiation à un document né de la saisie, sans enfant', async () => {
    scenario()
    renderAt('/documents/d-7', 'worker')

    await screen.findByRole('heading', { level: 1, name: 'BL-A-26-00007' })
    expect(screen.queryByRole('region', { name: 'Filiation' })).not.toBeInTheDocument()
  })

  /* ---------------------------------------------------------------------- */
  /* Transformer, Retour — seulement quand la chaîne l'autorise               */
  /* ---------------------------------------------------------------------- */

  it('offre « Transformer » sur un devis confirmé, vers la route d’E4-05', async () => {
    scenario({ document: summaryRow(7, { doc_type: 'quote', doc_number: 'DV-A-26-00007' }) })
    renderAt('/documents/d-7', 'worker')

    expect(await screen.findByRole('link', { name: 'Transformer' })).toHaveAttribute(
      'href',
      '/sale/from/d-7',
    )
    expect(screen.queryByRole('link', { name: 'Retour' })).not.toBeInTheDocument()
  })

  it('offre « Retour » sur un bon de livraison vivant, vers la route d’E4-06', async () => {
    scenario()
    renderAt('/documents/d-7', 'worker')

    expect(await screen.findByRole('link', { name: 'Retour' })).toHaveAttribute(
      'href',
      '/sale/return/d-7',
    )
    expect(screen.queryByRole('link', { name: 'Transformer' })).not.toBeInTheDocument()
  })

  it('n’offre ni l’un ni l’autre sur un retour, ni sur un brouillon', async () => {
    scenario({ document: summaryRow(7, { doc_type: 'return', doc_number: 'RT-A-26-00007' }) })
    renderAt('/documents/d-7', 'worker')

    await screen.findByRole('heading', { level: 1, name: 'RT-A-26-00007' })
    expect(screen.queryByRole('link', { name: 'Transformer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Retour' })).not.toBeInTheDocument()
  })

  /* ---------------------------------------------------------------------- */
  /* L'annulation                                                             */
  /* ---------------------------------------------------------------------- */

  it('masque l’annulation à un employé', async () => {
    scenario()
    renderAt('/documents/d-7', 'worker')

    await screen.findByRole('heading', { level: 1, name: 'BL-A-26-00007' })
    expect(screen.queryByRole('button', { name: 'Annuler ce document' })).not.toBeInTheDocument()
  })

  /* Le garde de l'écran, seul : sa phrase n'est pas celle de la base. */
  it('refuse un motif vide à l’écran, sans écrire', async () => {
    scenario()
    renderAt('/documents/d-7', 'owner')

    await userEvent.click(await screen.findByRole('button', { name: 'Annuler ce document' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Dites pourquoi vous annulez ce document : le motif est obligatoire.',
    )
    expect(calls.filter((call) => call.payload !== undefined)).toHaveLength(0)
  })

  it('annule avec le motif, puis relit le document', async () => {
    scenario()
    renderAt('/documents/d-7', 'owner')

    await userEvent.click(await screen.findByRole('button', { name: 'Annuler ce document' }))
    await userEvent.type(screen.getByLabelText('Motif de l’annulation'), 'Erreur de client')
    const rpcBefore = rpcCalls.length
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }))

    await waitFor(() => {
      const updates = calls.filter((call) => call.payload !== undefined)
      expect(updates).toHaveLength(1)
      expect(updates[0]!.payload).toEqual({
        status: 'cancelled',
        cancellation_reason: 'Erreur de client',
      })
    })
    await waitFor(() => expect(rpcCalls.length).toBeGreaterThan(rpcBefore))
  })

  /* Le garde de la base, seul : l'écran a laissé passer, la base refuse avec sa phrase. */
  it('affiche la phrase de la base quand c’est elle qui refuse', async () => {
    scenario({
      updateAnswer: {
        data: null,
        error: {
          code: 'PT409',
          message: 'Ce bon porte un retour qui n’est pas annulé : annulez d’abord RT-A-26-00002.',
        },
      },
    })
    renderAt('/documents/d-7', 'owner')

    await userEvent.click(await screen.findByRole('button', { name: 'Annuler ce document' }))
    await userEvent.type(screen.getByLabelText('Motif de l’annulation'), 'Erreur')
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('annulez d’abord RT-A-26-00002')
  })
})

/* ========================================================================== */
/* La réimpression du ticket — E5-01                                           */
/* ========================================================================== */

describe('l’impression du ticket, depuis le détail', () => {
  /*
   * SPEC § 2.7 : au navigateur, il n'y a pas de socket TCP. Le bouton n'est pas
   * grisé, il n'existe pas — et aucune lecture de réglages n'est faite pour
   * rien. C'est le cas par défaut de tout ce fichier.
   */
  it('n’offre pas l’impression hors de l’enveloppe Android', async () => {
    scenario({ settings: SETTINGS })
    renderAt('/documents/d-7', 'worker')

    await screen.findByRole('heading', { level: 1, name: 'BL-A-26-00007' })
    expect(screen.queryByRole('button', { name: 'Imprimer le ticket' })).not.toBeInTheDocument()
    expect(calls.some((call) => call.table === 'tenant_setting')).toBe(false)
  })

  /* Un commerce qui n'a pas d'imprimante : réglage vide, donc pas de bouton. */
  it('n’offre pas l’impression quand aucune imprimante n’est réglée', async () => {
    printing.native = true
    scenario({
      settings: SETTINGS.map((row) =>
        row.key === 'printer_address' ? { ...row, value: '' } : row,
      ),
    })
    renderAt('/documents/d-7', 'worker')

    await screen.findByRole('heading', { level: 1, name: 'BL-A-26-00007' })
    await waitFor(() => expect(calls.some((call) => call.table === 'tenant_setting')).toBe(true))
    expect(screen.queryByRole('button', { name: 'Imprimer le ticket' })).not.toBeInTheDocument()
  })

  /*
   * Le critère 5 de la story : « réimpression depuis le détail du document ».
   * Ce que le test lit est le **ticket** passé à l'impression : l'en-tête du
   * commerce, le numéro, la date, les lignes avec quantité et prix, le total —
   * c'est-à-dire le critère 3, sur le papier.
   */
  it('réimprime le ticket du document, avec tout ce que le critère exige', async () => {
    printing.native = true
    scenario({ settings: SETTINGS })
    renderAt('/documents/d-7', 'worker')

    await userEvent.click(await screen.findByRole('button', { name: 'Imprimer le ticket' }))

    await waitFor(() => expect(printing.printTicket).toHaveBeenCalledTimes(1))
    const [ticket, setup] = printing.printTicket.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ]

    expect(ticket).toMatchObject({
      businessName: 'Parfumerie Nour',
      phone: '+212612345678',
      address: 'Derb Omar',
      number: 'BL-A-26-00007',
      issuedAt: '2026-10-06T08:00:00Z',
      total: '228.00',
      lines: [{ label: 'Savon 500 g', quantity: '24.000', unitPrice: '9.50', lineTotal: '228.00' }],
    })
    expect(setup).toEqual({ host: '192.168.1.50', port: 9100, width: 576 })
    // `role="status"` est déjà porté par le total de l'écran : on lit la phrase.
    expect(await screen.findByText('Ticket imprimé.')).toBeInTheDocument()
  })

  /*
   * Critère 4 : « échec d'impression non bloquant ». Le document reste affiché,
   * la phrase dit que le bon est enregistré, et le bouton reste là.
   */
  it('ne défait rien quand l’impression échoue, et laisse réimprimer', async () => {
    printing.native = true
    printing.printTicket.mockRejectedValue(new Error('L’imprimante ne répond pas.'))
    scenario({ settings: SETTINGS })
    renderAt('/documents/d-7', 'worker')

    await userEvent.click(await screen.findByRole('button', { name: 'Imprimer le ticket' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Impression échouée. Le bon est enregistré, vous pouvez réimprimer.',
    )
    expect(screen.getByRole('heading', { level: 1, name: 'BL-A-26-00007' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Imprimer le ticket' })).toBeEnabled()
  })

  /*
   * Un ticket d'allure valable pour une vente annulée est une preuve fausse
   * entre les mains du client. Un brouillon, lui, n'a pas de numéro : il n'y a
   * rien à remettre.
   */
  it('n’imprime ni un document annulé ni un brouillon', async () => {
    printing.native = true
    scenario({
      document: summaryRow(7, { status: 'cancelled', cancellation_reason: 'Erreur' }),
      settings: SETTINGS,
    })
    renderAt('/documents/d-7', 'owner')

    await screen.findByText('Document annulé')
    expect(screen.queryByRole('button', { name: 'Imprimer le ticket' })).not.toBeInTheDocument()
  })

  it('n’imprime pas un brouillon, qui n’a pas de numéro', async () => {
    printing.native = true
    scenario({
      document: summaryRow(7, { doc_number: null, status: 'draft', issued_at: null }),
      settings: SETTINGS,
    })
    renderAt('/documents/d-7', 'owner')

    await screen.findByRole('heading', { level: 1, name: 'Sans numéro' })
    expect(screen.queryByRole('button', { name: 'Imprimer le ticket' })).not.toBeInTheDocument()
  })
})

/* ========================================================================== */
/* Le PDF A4 — E5-03                                                          */
/* ========================================================================== */

describe('le PDF A4, depuis le détail', () => {
  /*
   * La RÈGLE de SPEC § 2.7 : « dans un navigateur, l'impression thermique est
   * absente, le PDF A4 présent ». C'est toute la différence avec le bouton
   * ci-dessus, et c'est le repli quand l'imprimante manque ou tombe en panne.
   * `printing.native` est faux ici — le cas par défaut de tout ce fichier.
   */
  it('offre le PDF au navigateur, là où le ticket n’est pas offert', async () => {
    scenario({ settings: SETTINGS })
    renderAt('/documents/d-7', 'worker')

    expect(await screen.findByRole('button', { name: 'Envoyer en PDF' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Imprimer le ticket' })).not.toBeInTheDocument()
  })

  it('offre le PDF aussi dans l’enveloppe, à côté du ticket', async () => {
    printing.native = true
    scenario({ settings: SETTINGS })
    renderAt('/documents/d-7', 'worker')

    expect(await screen.findByRole('button', { name: 'Imprimer le ticket' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Envoyer en PDF' })).toBeEnabled()
  })

  /*
   * Les critères 1 à 4 de la story en un geste : la page porte l'en-tête du
   * commerce et le document, le fichier porte le numéro et la date, et c'est le
   * système de partage qui le reçoit.
   */
  it('engendre la page du document et la remet au partage, sous un nom explicite', async () => {
    scenario({ settings: SETTINGS })
    renderAt('/documents/d-7', 'worker')

    await userEvent.click(await screen.findByRole('button', { name: 'Envoyer en PDF' }))

    await waitFor(() => expect(printing.buildPdf).toHaveBeenCalledTimes(1))
    const [page] = printing.buildPdf.mock.calls[0] as [Record<string, unknown>]

    expect(page).toMatchObject({
      businessName: 'Parfumerie Nour',
      phone: '+212612345678',
      address: 'Derb Omar',
      title: 'Bon de livraison',
      number: 'BL-A-26-00007',
      issuedAt: '2026-10-06T08:00:00Z',
      total: '228.00',
      lines: [{ label: 'Savon 500 g', quantity: '24.000', unitPrice: '9.50', lineTotal: '228.00' }],
    })

    await waitFor(() => expect(printing.share).toHaveBeenCalledTimes(1))
    const [file] = printing.share.mock.calls[0] as [{ name: string; bytes: Uint8Array }]
    expect(file.name).toBe('BL-A-26-00007-2026-10-06.pdf')
    expect([...file.bytes]).toEqual([37, 80, 68, 70])

    expect(await screen.findByText('PDF envoyé.')).toBeInTheDocument()
  })

  /* Au navigateur de bureau, le fichier descend : la phrase le dit. */
  it('dit où le fichier est allé quand il est téléchargé', async () => {
    printing.share.mockResolvedValue('downloaded')
    scenario({ settings: SETTINGS })
    renderAt('/documents/d-7', 'worker')

    await userEvent.click(await screen.findByRole('button', { name: 'Envoyer en PDF' }))

    expect(await screen.findByText('PDF enregistré dans vos téléchargements.')).toBeInTheDocument()
  })

  /*
   * Refermer le sélecteur de partage est un geste ordinaire. Le signaler comme
   * une erreur apprendrait au vendeur à ne plus lire les messages.
   */
  it('ne dit rien quand l’utilisateur referme le sélecteur', async () => {
    printing.share.mockResolvedValue('cancelled')
    scenario({ settings: SETTINGS })
    renderAt('/documents/d-7', 'worker')

    await userEvent.click(await screen.findByRole('button', { name: 'Envoyer en PDF' }))

    await waitFor(() => expect(printing.share).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('PDF envoyé.')).not.toBeInTheDocument()
  })

  it('ne défait rien quand le PDF échoue, et laisse réessayer', async () => {
    printing.buildPdf.mockRejectedValue(new Error('canvas indisponible'))
    scenario({ settings: SETTINGS })
    renderAt('/documents/d-7', 'worker')

    await userEvent.click(await screen.findByRole('button', { name: 'Envoyer en PDF' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le PDF n’a pas pu être partagé. Le document est enregistré, réessayez.',
    )
    expect(screen.getByRole('heading', { level: 1, name: 'BL-A-26-00007' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Envoyer en PDF' })).toBeEnabled()
  })

  /*
   * Même porte que le ticket, et la raison est plus forte : un papier se perd,
   * un fichier se transmet encore des mois après. Un PDF d'allure valable pour
   * une vente annulée est une preuve fausse qui circule.
   */
  it('n’exporte pas un document annulé', async () => {
    scenario({
      document: summaryRow(7, { status: 'cancelled', cancellation_reason: 'Erreur' }),
      settings: SETTINGS,
    })
    renderAt('/documents/d-7', 'owner')

    await screen.findByText('Document annulé')
    expect(screen.queryByRole('button', { name: 'Envoyer en PDF' })).not.toBeInTheDocument()
  })

  it('n’exporte pas un brouillon, qui n’a pas de numéro', async () => {
    scenario({
      document: summaryRow(7, { doc_number: null, status: 'draft', issued_at: null }),
      settings: SETTINGS,
    })
    renderAt('/documents/d-7', 'owner')

    await screen.findByRole('heading', { level: 1, name: 'Sans numéro' })
    expect(screen.queryByRole('button', { name: 'Envoyer en PDF' })).not.toBeInTheDocument()
  })
})
