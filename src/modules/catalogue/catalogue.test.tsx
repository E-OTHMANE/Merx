/*
 * Le catalogue — E2-02, côté interface.
 *
 * Le critère qui prime, SPEC § 2.6 : le seul champ obligatoire est le nom, et
 * aucun champ vide n'affiche d'avertissement, de rouge, ni de rappel. Il est
 * vérifié ici sur trois plans — ce que l'écran montre (ni alerte, ni
 * `aria-invalid`, ni `required`, ni rouge), ce que le bouton permet (le nom
 * seul suffit), et ce qui part vers la base (aucune clé pour un champ jamais
 * touché, pas même à `null`).
 *
 * Ce qui ne se vérifie pas ici — que la base accepte le nom seul, que le
 * commerce vienne du jeton, qu'un employé ne puisse rien écrire — ne dépend
 * d'aucun de ces composants : `supabase/tests/product-form.test.ts`,
 * `catalogue.test.ts` et `conventions.test.ts` l'éprouvent sur la base réelle.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { PRODUCT_MESSAGES } from '@/modules/catalogue/products'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

/*
 * Le doublon porte sur le client partagé : chaque requête est enregistrée telle
 * que l'écran la forme, et c'est elle qu'on assert — table, opération, charge,
 * filtres.
 */
interface Call {
  table: string
  op: 'select' | 'insert' | 'update'
  payload?: Record<string, unknown>
  filters: Array<[string, string, unknown]>
  single: boolean
}

interface Response {
  data: unknown
  error: { code?: string; message: string } | null
}

const calls: Call[] = []
const respond = vi.fn<(call: Call) => Response | Promise<Response>>()
const upload = vi.fn()
const remove = vi.fn()
const createSignedUrls = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, op: 'select', filters: [], single: false }
      const builder = {
        select: () => builder,
        insert: (payload: Record<string, unknown>) => {
          call.op = 'insert'
          call.payload = payload
          return builder
        },
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
        order: () => builder,
        maybeSingle: () => {
          call.single = true
          return builder
        },
        then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push(call)
          return Promise.resolve(respond(call)).then(resolve, reject)
        },
      }
      return builder
    },
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => upload(...args),
        remove: (...args: unknown[]) => remove(...args),
        createSignedUrls: (...args: unknown[]) => createSignedUrls(...args),
      }),
    },
    // La liste passe par la recherche (E2-04) : l'appel est enregistré comme
    // les autres, sous le nom de la fonction.
    rpc: (fn: string, args: Record<string, unknown>) => {
      const call: Call = { table: `rpc:${fn}`, op: 'select', payload: args, filters: [], single: false }
      return {
        then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push(call)
          return Promise.resolve(respond(call)).then(resolve, reject)
        },
      }
    },
    functions: { invoke: vi.fn() },
  },
}))

/* Le dessin sur canvas n'existe pas dans jsdom : la réduction rend un JPEG fictif. */
vi.mock('@/modules/catalogue/photo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/catalogue/photo')>()
  return {
    ...actual,
    resizePhoto: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
  }
})

function renderAt(path: string, role: string) {
  render(
    <AuthProvider
      client={createFakeAuthClient({
        initialSession: fakeSession({ role, email: 'patron@merx.ma', userId: 'auth-patron' }),
      })}
    >
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  )
}

/** Ce que PostgREST rend, tel quel — colonnes en `snake_case`. */
const PRODUCT = {
  id: 'p1',
  name_fr: 'Eau de toilette',
  code: 'EDT-50',
  name_ar: null,
  category_id: null,
  brand: null,
  photo_url: null,
  unit_label: null,
  pieces_per_carton: null,
}

let categories: Array<{ id: string; name_fr: string }> = []
let products: Array<Partial<typeof PRODUCT>> = []

const SEARCH = 'rpc:search_products'

/* Ce que `search_products()` rend pour un produit à une variante. */
const searchRowOf = (product: Partial<typeof PRODUCT>) => ({
  variant_id: product.id,
  product_id: product.id,
  name_fr: product.name_fr,
  name_ar: product.name_ar ?? null,
  code: product.code ?? null,
  sku: product.code ?? null,
  barcode: null,
  photo_url: product.photo_url ?? null,
})

function defaultRespond(call: Call): Response {
  if (call.table === 'category') return { data: categories, error: null }
  if (call.table === SEARCH) return { data: products.map(searchRowOf), error: null }
  // Toute route authentifiée enregistre l'appareil au montage (E1-03).
  if (call.table === 'rpc:register_device') {
    return { data: [{ id: 'd1', label: 'Appareil A', prefix: 'A', last_sync_at: null }], error: null }
  }
  if (call.op === 'select') {
    return call.single ? { data: PRODUCT, error: null } : { data: products, error: null }
  }
  if (call.op === 'update') return { data: [{ id: 'p1' }], error: null }
  return { data: null, error: null }
}

const writes = (op: 'insert' | 'update') =>
  calls.filter((call) => call.table === 'product' && call.op === op)

const saveButton = () => screen.getByRole('button', { name: 'Enregistrer le produit' })
const nameField = () => screen.getByLabelText('Nom du produit')

async function openNewProduct() {
  renderAt('/products/new', 'owner')
  await screen.findByRole('heading', { name: 'Nouveau produit' })
}

/**
 * Tout ce qui, dans l'écran, pourrait reprocher un champ vide. SPEC § 2.6 :
 * « ni avertissement, ni champ en rouge, ni rappel ».
 */
function reproaches(): string[] {
  const main = screen.getByRole('main')
  const found: string[] = []
  if (within(main).queryAllByRole('alert').length > 0) found.push('role="alert"')
  if (main.querySelector('[aria-invalid="true"]') !== null) found.push('aria-invalid')
  if (main.querySelector('[required], [aria-required="true"]') !== null) found.push('required')
  /*
   * Une classe rouge *appliquée* : sans préfixe de variante. `aria-invalid:
   * border-red-500`, posée par le composant `Input`, ne rougit que sous
   * `aria-invalid` — vérifié juste au-dessus — et n'est donc pas un reproche.
   */
  const red = [...main.querySelectorAll<HTMLElement>('[class]')].some((element) =>
    element.className
      .toString()
      .split(/\s+/)
      .some((token) => !token.includes(':') && token.includes('red-')),
  )
  if (red) found.push('classe rouge')
  if (within(main).queryByText(/obligatoire|requis|\*|facultatif|n’oubliez|manquant/i) !== null) {
    found.push('texte de rappel')
  }
  return found
}

/**
 * Tout le texte que le formulaire écrit de lui-même, hors libellés, boutons et
 * options. Un filtre de mots laisserait passer « Pensez à la référence » ; une
 * liste exacte, non : toute phrase ajoutée au formulaire fait échouer le test,
 * et doit être relue au regard de SPEC § 2.6 avant d'y entrer.
 */
function formTexts(): string[] {
  const form = screen.getByRole('main').querySelector('form')!
  const texts: string[] = []
  for (const element of form.querySelectorAll<HTMLElement>('*')) {
    if (['LABEL', 'BUTTON', 'OPTION'].includes(element.tagName)) continue
    if (element.closest('label, button') !== null) continue
    const own = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent?.trim() ?? '')
      .join(' ')
      .trim()
    if (own !== '') texts.push(own)
  }
  return texts
}

const UNIT_HINT = 'Exemple : pièce, flacon, boîte.'

beforeEach(() => {
  calls.length = 0
  categories = []
  products = [PRODUCT]
  respond.mockReset()
  respond.mockImplementation(defaultRespond)
  upload.mockReset()
  upload.mockResolvedValue({ data: { path: 'x' }, error: null })
  remove.mockReset()
  remove.mockResolvedValue({ data: [], error: null })
  createSignedUrls.mockReset()
  createSignedUrls.mockResolvedValue({ data: [], error: null })
  URL.createObjectURL = vi.fn(() => 'blob:apercu')
  URL.revokeObjectURL = vi.fn()
})

/* ========================================================================== */

describe('le garde de route', () => {
  it('l’employé ne peut pas ouvrir le formulaire — renvoyé à l’accueil', async () => {
    renderAt('/products/new', 'worker')

    expect(await screen.findByRole('button', { name: 'Se déconnecter' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Nouveau produit' })).toBeNull()
  })

  it('le patron l’ouvre', async () => {
    await openNewProduct()
    expect(nameField()).toBeInTheDocument()
  })

  it('l’employé lit la liste, sans lien vers les fiches ni bouton d’ajout', async () => {
    renderAt('/products', 'worker')

    expect(await screen.findByText('Eau de toilette')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Eau de toilette/ })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Ajouter un produit' })).toBeNull()
  })

  it('le patron, lui, a les deux', async () => {
    renderAt('/products', 'owner')

    expect(await screen.findByRole('link', { name: /Eau de toilette/ })).toHaveAttribute(
      'href',
      '/products/p1',
    )
    expect(screen.getByRole('link', { name: 'Ajouter un produit' })).toBeInTheDocument()
  })
})

/* ========================================================================== */
/* SPEC § 2.6 — le critère qui prime                                           */
/* ========================================================================== */

describe('SPEC § 2.6 — le nom suffit, et rien ne réclame le reste', () => {
  it('le formulaire vide ne reproche rien, et le nom a le focus', async () => {
    await openNewProduct()

    expect(reproaches()).toEqual([])
    expect(formTexts()).toEqual(['Photo', UNIT_HINT])
    expect(nameField()).toHaveFocus()
  })

  it('sans nom, le bouton reste inactif — sans un mot', async () => {
    await openNewProduct()

    expect(saveButton()).toBeDisabled()
    await userEvent.type(nameField(), '   ')
    expect(saveButton()).toBeDisabled()
    expect(reproaches()).toEqual([])
  })

  it('enregistrer avec le seul nom : la charge ne porte que l’identifiant et le nom', async () => {
    await openNewProduct()

    await userEvent.type(nameField(), 'Crème de nuit')
    await userEvent.click(saveButton())

    await screen.findByText('« Crème de nuit » enregistré.')
    const [insert] = writes('insert')
    expect(Object.keys(insert!.payload!).sort()).toEqual(['id', 'name_fr'])
    expect(insert!.payload!['name_fr']).toBe('Crème de nuit')
    expect(insert!.payload!['id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('après l’enregistrement, toujours aucun reproche — et le formulaire est prêt pour le suivant', async () => {
    await openNewProduct()

    await userEvent.type(nameField(), 'Crème de nuit')
    await userEvent.click(saveButton())
    await screen.findByText('« Crème de nuit » enregistré.')

    expect(reproaches()).toEqual([])
    expect(formTexts()).toEqual(['Photo', UNIT_HINT, '« Crème de nuit » enregistré.'])
    expect(nameField()).toHaveValue('')
    expect(nameField()).toHaveFocus()
  })

  it('un champ rempli puis vidé ne part pas non plus — pas même à null', async () => {
    await openNewProduct()

    await userEvent.type(nameField(), 'Savon')
    await userEvent.type(screen.getByLabelText('Référence'), 'SAV-1')
    await userEvent.clear(screen.getByLabelText('Référence'))
    await userEvent.type(screen.getByLabelText('Marque'), '  ')
    await userEvent.click(saveButton())

    await screen.findByText('« Savon » enregistré.')
    const [insert] = writes('insert')
    expect(Object.keys(insert!.payload!).sort()).toEqual(['id', 'name_fr'])
    expect(Object.values(insert!.payload!)).not.toContain(null)
  })

  it('aucune requête ne porte de tenant_id — la base le prend dans le jeton', async () => {
    await openNewProduct()
    await userEvent.type(nameField(), 'Savon')
    await userEvent.click(saveButton())
    await screen.findByText('« Savon » enregistré.')

    for (const call of calls) {
      expect(Object.keys(call.payload ?? {})).not.toContain('tenant_id')
      expect(call.filters.map(([, column]) => column)).not.toContain('tenant_id')
    }
  })
})

/* ========================================================================== */

describe('les champs facultatifs', () => {
  it('tous remplis, ils partent sous leurs colonnes', async () => {
    categories = [{ id: 'c1', name_fr: 'Parfums' }]
    await openNewProduct()

    await userEvent.type(nameField(), 'Eau de toilette')
    await userEvent.type(screen.getByLabelText('Référence'), 'EDT-50')
    await userEvent.type(screen.getByLabelText('Nom en arabe'), 'ماء العطر')
    await userEvent.selectOptions(await screen.findByLabelText('Catégorie'), 'c1')
    await userEvent.type(screen.getByLabelText('Marque'), 'Nivea')
    await userEvent.type(screen.getByLabelText('Unité de vente'), 'flacon')
    await userEvent.type(screen.getByLabelText('Pièces par carton'), '24')
    await userEvent.click(saveButton())

    await screen.findByText('« Eau de toilette » enregistré.')
    const { id, ...columns } = writes('insert')[0]!.payload!
    expect(id).toBeDefined()
    expect(columns).toStrictEqual({
      name_fr: 'Eau de toilette',
      code: 'EDT-50',
      name_ar: 'ماء العطر',
      category_id: 'c1',
      brand: 'Nivea',
      unit_label: 'flacon',
      pieces_per_carton: 24,
    })
  })

  it('sans catégorie en base, le champ n’existe pas — en silence', async () => {
    await openNewProduct()
    // Contrôle : la lecture des catégories a bien eu lieu, et n'a rien rendu.
    await waitFor(() => expect(calls.some((call) => call.table === 'category')).toBe(true))
    expect(screen.queryByLabelText('Catégorie')).toBeNull()
    expect(reproaches()).toEqual([])
  })

  it('le nom arabe se saisit de droite à gauche', async () => {
    await openNewProduct()
    expect(screen.getByLabelText('Nom en arabe')).toHaveAttribute('dir', 'rtl')
    expect(screen.getByLabelText('Nom en arabe')).toHaveAttribute('lang', 'ar')
  })

  it('pièces par carton : des chiffres seuls, au clavier numérique', async () => {
    await openNewProduct()
    const pieces = screen.getByLabelText('Pièces par carton')

    expect(pieces).toHaveAttribute('inputmode', 'numeric')
    await userEvent.type(pieces, '1a2')
    expect(pieces).toHaveValue('12')
  })
})

/* ========================================================================== */

describe('les refus de la base, chacun sous ses mots', () => {
  it('référence déjà prise', async () => {
    respond.mockImplementation((call) =>
      call.op === 'insert'
        ? {
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "product_code_per_tenant"',
            },
          }
        : defaultRespond(call),
    )
    await openNewProduct()
    await userEvent.type(nameField(), 'Savon')
    await userEvent.type(screen.getByLabelText('Référence'), 'SAV-1')
    await userEvent.click(saveButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(PRODUCT_MESSAGES.duplicateCode)
    // Rien n'est perdu : le brouillon reste là pour être corrigé.
    expect(nameField()).toHaveValue('Savon')
  })

  it('policy de product — 42501', async () => {
    respond.mockImplementation((call) =>
      call.op === 'insert'
        ? { data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "product"' } }
        : defaultRespond(call),
    )
    await openNewProduct()
    await userEvent.type(nameField(), 'Savon')
    await userEvent.click(saveButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(PRODUCT_MESSAGES.refused)
  })

  it('modification qui ne touche aucune ligne — ni succès, ni le message de la policy', async () => {
    respond.mockImplementation((call) =>
      call.op === 'update' ? { data: [], error: null } : defaultRespond(call),
    )
    renderAt('/products/p1', 'owner')
    await userEvent.type(await screen.findByLabelText('Marque'), 'Nivea')
    await userEvent.click(saveButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(PRODUCT_MESSAGES.notSaved)
    expect(PRODUCT_MESSAGES.notSaved).not.toBe(PRODUCT_MESSAGES.refused)
  })
})

/* ========================================================================== */

describe('modifier un produit', () => {
  it('la fiche arrive remplie, et seule la colonne changée part', async () => {
    renderAt('/products/p1', 'owner')

    expect(await screen.findByLabelText('Nom du produit')).toHaveValue('Eau de toilette')
    expect(screen.getByLabelText('Référence')).toHaveValue('EDT-50')

    await userEvent.type(screen.getByLabelText('Marque'), 'Nivea')
    await userEvent.click(saveButton())

    expect(await screen.findByText('« Eau de toilette » enregistré.')).toBeInTheDocument()
    const [update] = writes('update')
    expect(update!.payload).toStrictEqual({ brand: 'Nivea' })
    expect(update!.filters).toContainEqual(['eq', 'id', 'p1'])
  })

  it('une référence effacée part à null', async () => {
    renderAt('/products/p1', 'owner')
    await userEvent.clear(await screen.findByLabelText('Référence'))
    await userEvent.click(saveButton())

    await screen.findByText('« Eau de toilette » enregistré.')
    expect(writes('update')[0]!.payload).toStrictEqual({ code: null })
  })

  it('un produit qui n’existe plus le dit, et renvoie à la liste', async () => {
    respond.mockImplementation((call) =>
      call.op === 'select' && call.single ? { data: null, error: null } : defaultRespond(call),
    )
    renderAt('/products/p1', 'owner')

    expect(await screen.findByText(/Ce produit n’existe plus/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Retour aux produits' })).toHaveAttribute('href', '/products')
  })

  it('la fiche ne lit que les produits non supprimés', async () => {
    renderAt('/products/p1', 'owner')
    await screen.findByLabelText('Nom du produit')

    const read = calls.find((call) => call.table === 'product' && call.single)
    expect(read!.filters).toContainEqual(['is', 'deleted_at', null])
  })
})

describe('supprimer un produit', () => {
  it('suppression douce, sans modale ; la liste l’annonce et sait l’annuler', async () => {
    renderAt('/products/p1', 'owner')
    await userEvent.click(await screen.findByRole('button', { name: 'Supprimer le produit' }))

    expect(await screen.findByText('« Eau de toilette » supprimé.')).toBeInTheDocument()
    const [deletion] = writes('update')
    expect(Object.keys(deletion!.payload!)).toEqual(['deleted_at'])
    expect(typeof deletion!.payload!['deleted_at']).toBe('string')

    await userEvent.click(screen.getByRole('button', { name: 'Annuler la suppression' }))

    expect(await screen.findByText('« Eau de toilette » rétabli.')).toBeInTheDocument()
    expect(writes('update')[1]!.payload).toStrictEqual({ deleted_at: null })
  })
})

/* ========================================================================== */

describe('la liste — quatre états', () => {
  it('chargement : la forme des lignes, puis le contenu', async () => {
    // La lecture est retenue le temps de voir l'écran de chargement.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    respond.mockImplementation(async (call) => {
      if (call.table === SEARCH) await held
      return defaultRespond(call)
    })
    renderAt('/products', 'owner')

    expect(await screen.findByLabelText('Chargement des produits')).toBeInTheDocument()
    expect(screen.queryByText('Eau de toilette')).toBeNull()
    release()
    expect(await screen.findByText('Eau de toilette')).toBeInTheDocument()
    expect(screen.getByText('EDT-50')).toBeInTheDocument()
  })

  it('vide : une phrase qui invite à agir', async () => {
    products = []
    renderAt('/products', 'owner')
    expect(await screen.findByText('Aucun produit. Ajoutez le premier.')).toBeInTheDocument()
  })

  it('erreur : le message, et de quoi réessayer', async () => {
    respond.mockImplementation((call) =>
      call.table === SEARCH
        ? { data: null, error: { message: 'Réseau indisponible.' } }
        : defaultRespond(call),
    )
    renderAt('/products', 'owner')

    expect(await screen.findByRole('alert')).toHaveTextContent('Réseau indisponible.')
    respond.mockImplementation(defaultRespond)
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByText('Eau de toilette')).toBeInTheDocument()
  })

  /*
   * E2-04 : la liste est la recherche, requête vide. Écarter les produits
   * supprimés n'est plus un filtre de l'écran — c'est la base qui s'en charge,
   * dans `search_products()`, et `supabase/tests/product-search.test.ts`
   * l'éprouve (suppression douce, produit et variante, avec son contrôle
   * positif).
   */
  it('passe par la recherche, requête vide, sans jamais lire la table', async () => {
    renderAt('/products', 'owner')
    await screen.findByText('Eau de toilette')

    expect(calls.filter((call) => call.table === SEARCH).map((call) => call.payload)).toEqual([{ q: '' }])
    expect(calls.some((call) => call.table === 'product' && call.op === 'select')).toBe(false)
  })
})

/* ========================================================================== */

describe('la photo', () => {
  const photoInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!

  it('ouvre l’appareil photo arrière', async () => {
    await openNewProduct()
    expect(photoInput()).toHaveAttribute('capture', 'environment')
    expect(photoInput()).toHaveAttribute('accept', 'image/*')
    expect(screen.getByRole('button', { name: 'Prendre une photo' })).toBeInTheDocument()
  })

  it('le produit d’abord, la photo ensuite, rangée sous son identifiant', async () => {
    await openNewProduct()
    await userEvent.type(nameField(), 'Savon')
    await userEvent.upload(photoInput(), new File(['brut'], 'photo.jpg', { type: 'image/jpeg' }))
    expect(await screen.findByRole('img', { name: 'Photo de Savon' })).toHaveAttribute(
      'src',
      'blob:apercu',
    )
    await userEvent.click(saveButton())

    await screen.findByText('« Savon » enregistré.')
    const id = writes('insert')[0]!.payload!['id'] as string
    const [path, blob, options] = upload.mock.calls[0]!
    expect(path).toMatch(new RegExp(`^${id}/[0-9a-f-]{36}\\.jpg$`))
    expect((blob as Blob).type).toBe('image/jpeg')
    expect(options).toMatchObject({ contentType: 'image/jpeg', upsert: false })
    expect(writes('update')[0]!.payload).toStrictEqual({ photo_url: path })
  })

  it('une photo qui ne part pas ne fait pas perdre le produit', async () => {
    upload.mockResolvedValue({ data: null, error: { message: 'réseau' } })
    await openNewProduct()
    await userEvent.type(nameField(), 'Savon')
    await userEvent.upload(photoInput(), new File(['brut'], 'photo.jpg', { type: 'image/jpeg' }))
    await userEvent.click(saveButton())

    expect(await screen.findByText(/« Savon » enregistré, sans sa photo/)).toBeInTheDocument()
    expect(writes('insert')).toHaveLength(1)
    expect(writes('update')).toHaveLength(0)
  })
})
