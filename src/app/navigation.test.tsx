/*
 * La navigation. E11-04 — BRAND-UI § 13.
 *
 * Trois choses se vérifient ici, sur les vraies routes :
 *
 * 1. « Un onglet ou un retour, jamais les deux, jamais aucun. » Route par
 *    route — et la liste des routes est lue dans `routes.tsx` lui-même : une
 *    route ajoutée sans être classée ici fait tomber le test, au lieu de passer
 *    en silence comme une impasse de plus.
 * 2. La barre suit le rôle, par `useCan()`. Un seul cas peut aujourd'hui le
 *    démontrer : `owner` et `worker` ont tous deux `view_catalogue`, et seule une
 *    session sans rôle ne l'a pas. Les autres onglets arriveront avec leur
 *    capacité — Rapports (`view_reports`) sera le premier refusé à un `worker`.
 * 3. Deux gardes sur le même chemin, un test chacun, qui se distinguent
 *    (CLAUDE.md) : l'onglet masqué se voit à l'Accueil, sans passer par la
 *    route ; le garde de route se voit en tapant l'URL, sans passer par l'onglet.
 *
 * Aucune donnée n'est chargée : le client Supabase ne répond jamais. Ce qui se
 * mesure est la charpente de l'écran — l'en-tête et la barre — et elle ne
 * dépend pas de ce qui arrive.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import routesSource from '@/app/routes.tsx?raw'
import { AuthProvider } from '@/lib/auth'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

/*
 * Un client qui accepte toute chaîne d'appels et ne résout jamais : chaque
 * écran reste dans son état de chargement, quelle que soit la forme de sa
 * requête.
 */
vi.mock('@/lib/supabase', () => {
  const pending: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === 'then' ? () => {} : pending),
    apply: () => pending,
  })
  return { supabase: pending }
})

function renderAt(path: string, role: string | null) {
  render(
    <AuthProvider client={createFakeAuthClient({ initialSession: fakeSession({ role }) })}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  )
}

const tabBar = () => screen.queryByRole('navigation', { name: 'Navigation principale' })
const backLinks = () => screen.queryAllByRole('link', { name: /^Retour : / })

/** Les écrans de premier niveau : un onglet chacun, aucun retour. */
const TOP_LEVEL: readonly string[] = ['/', '/sale', '/products']

/** Les écrans de détail : leur retour, vers le parent désigné (BRAND-UI § 13). */
const DETAIL: Readonly<Record<string, { visit: string; parent: string; label: string }>> = {
  '/products/new': { visit: '/products/new', parent: '/products', label: 'Produits' },
  '/products/import': { visit: '/products/import', parent: '/products', label: 'Produits' },
  '/products/:id': { visit: '/products/p-1', parent: '/products', label: 'Produits' },
  '/products/:id/prices': {
    visit: '/products/p-1/prices',
    parent: '/products/p-1',
    label: 'Fiche produit',
  },
  '/products/:id/labels': {
    visit: '/products/p-1/labels',
    parent: '/products/p-1',
    label: 'Fiche produit',
  },
  /*
   * E3-02. Son parent est `/products`, et non la fiche produit comme ses
   * voisins : la fiche exige `manage_product`, que le vendeur n'a pas, et c'est
   * lui l'acteur de la story. Un retour vers un écran interdit est une impasse.
   */
  '/products/:id/stock': {
    visit: '/products/p-1/stock',
    parent: '/products',
    label: 'Produits',
  },
  /*
   * E4-05. Même écran que `/sale`, mais nourri d'un document d'origine : un
   * retour vers Vente, et aucune barre. Son parent est l'écran de vente, d'où
   * la transformation se poursuit.
   */
  '/sale/from/:documentId': { visit: '/sale/from/d-1', parent: '/sale', label: 'Vente' },
  '/users': { visit: '/users', parent: '/', label: 'Accueil' },
  '/users/new': { visit: '/users/new', parent: '/users', label: 'Employés' },
  '/devices': { visit: '/devices', parent: '/', label: 'Accueil' },
  '/audit': { visit: '/audit', parent: '/', label: 'Accueil' },
  '/settings': { visit: '/settings', parent: '/', label: 'Accueil' },
  '/admin/tenants': { visit: '/admin/tenants', parent: '/', label: 'Accueil' },
  '/admin/tenants/new': {
    visit: '/admin/tenants/new',
    parent: '/admin/tenants',
    label: 'Commerces',
  },
}

/** Hors navigation : la connexion, et l'URL inconnue qui renvoie à l'Accueil. */
const OUTSIDE: readonly string[] = ['/login', '*']

/* ========================================================================== */
/* Un onglet ou un retour                                                      */
/* ========================================================================== */

describe('un onglet ou un retour, jamais les deux, jamais aucun', () => {
  it('classe chaque route déclarée dans routes.tsx', () => {
    const declared = [...routesSource.matchAll(/path="([^"]+)"/g)].map((match) => match[1])
    const classified = [...TOP_LEVEL, ...Object.keys(DETAIL), ...OUTSIDE]

    expect([...declared].sort()).toEqual([...classified].sort())
  })

  /*
   * Le `super_admin` passe tous les gardes — `can()` lui répond oui, et
   * `RequireSuperAdmin` le laisse entrer : chaque écran s'ouvre, et ce qui se
   * mesure est sa charpente, pas un droit.
   */
  it.each(TOP_LEVEL)('%s porte la barre et aucun retour', async (path) => {
    renderAt(path, 'super_admin')

    await screen.findByRole('heading', { level: 1 })
    expect(tabBar()).toBeInTheDocument()
    expect(backLinks()).toHaveLength(0)
  })

  it.each(Object.entries(DETAIL))(
    '%s porte un retour vers son parent et aucune barre',
    async (_route, { visit, parent, label }) => {
      renderAt(visit, 'super_admin')

      await screen.findByRole('heading', { level: 1 })
      expect(tabBar()).not.toBeInTheDocument()
      expect(backLinks()).toHaveLength(1)
      const back = screen.getByRole('link', { name: `Retour : ${label}` })
      expect(back).toHaveAttribute('href', parent)
      // Le mot est à l'écran, pas seulement dans le nom accessible (BRAND-UI § 11).
      expect(back).toHaveTextContent(label)
    },
  )

  /*
   * BRAND-UI § 9 : le chevron est directionnel, il se retourne en RTL. jsdom ne
   * dessine rien — ce test tient la classe ; le retournement lui-même se
   * vérifie à l'œil, sur un vrai écran.
   */
  it('le chevron du retour se retourne en RTL', async () => {
    renderAt('/users', 'owner')

    const back = await screen.findByRole('link', { name: 'Retour : Accueil' })
    expect(back.querySelector('svg')).toHaveClass('rtl:-scale-x-100')
  })
})

/* ========================================================================== */
/* La barre suit le rôle                                                       */
/* ========================================================================== */

describe('la barre suit le rôle', () => {
  const tabs = () =>
    within(tabBar()!)
      .getAllByRole('link')
      .map((link) => link.textContent)

  /*
   * E4-03 : Vente entre en position 2, avant Produits (BRAND-UI § 13). Les deux
   * rôles ont `create_sale` comme ils ont `view_catalogue` (§ 3.1) ; c'est
   * Rapports (`view_reports`, E10-01) qui sera le premier onglet refusé à un
   * employé.
   */
  it.each([['owner'], ['worker']])(
    'offre Accueil, Vente et Produits à un %s',
    async (role) => {
      renderAt('/', role)

      await waitFor(() => expect(tabBar()).toBeInTheDocument())
      expect(tabs()).toEqual(['Accueil', 'Vente', 'Produits'])
    },
  )

  /*
   * Le garde de l'onglet, seul : on reste à l'Accueil, la route de `/products`
   * n'est jamais visitée. Retirer le filtre de la barre fait tomber ce test, et
   * lui seul.
   */
  it('ne montre pas un onglet dont la capacité manque', async () => {
    renderAt('/', null)

    await waitFor(() => expect(tabBar()).toBeInTheDocument())
    expect(tabs()).toEqual(['Accueil'])
  })

  /*
   * Le garde de route, seul : l'URL tapée à la main, sans passer par l'onglet.
   * Il répond autrement — une redirection vers l'Accueil, pas un lien absent.
   */
  it('renvoie à l’Accueil qui tape l’URL d’un onglet interdit', async () => {
    renderAt('/products', null)

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Merx' })).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Produits' })).not.toBeInTheDocument()
  })

  it('marque l’onglet actif, et lui seul', async () => {
    renderAt('/products', 'worker')

    await waitFor(() => expect(tabBar()).toBeInTheDocument())
    const bar = within(tabBar()!)
    const products = bar.getByRole('link', { name: 'Produits' })
    const home = bar.getByRole('link', { name: 'Accueil' })

    expect(products).toHaveAttribute('aria-current', 'page')
    expect(home).not.toHaveAttribute('aria-current')
    // BRAND-UI § 13 : l'état se lit par le fond, pas seulement par la teinte.
    expect(products).toHaveClass('bg-ink-100', 'text-ink-600')
    expect(home).not.toHaveClass('bg-ink-100')
    // BRAND-UI § 5 : l'inactif en papier 600, jamais 400.
    expect(home).toHaveClass('text-paper-600')
  })
})

/* ========================================================================== */
/* Le bloc « Gestion du commerce »                                             */
/* ========================================================================== */

describe('le bloc « Gestion du commerce »', () => {
  const management = () => screen.queryByRole('region', { name: 'Gestion du commerce' })

  it('rassemble les destinations rares du patron', async () => {
    renderAt('/', 'owner')

    const block = await screen.findByRole('region', { name: 'Gestion du commerce' })
    expect(
      within(block)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Employés', 'Appareils', 'Journal', 'Paramètres'])
  })

  it('n’existe pas pour un employé', async () => {
    renderAt('/', 'worker')

    await waitFor(() => expect(tabBar()).toBeInTheDocument())
    expect(management()).not.toBeInTheDocument()
  })

  it('ses chevrons se retournent en RTL', async () => {
    renderAt('/', 'owner')

    const link = await screen.findByRole('link', { name: 'Employés' })
    expect(link.querySelector('svg')).toHaveClass('rtl:-scale-x-100')
  })
})
