/*
 * La liste des produits. M1 — E2-02.
 *
 * Le chemin vers la fiche d'un produit, et rien de plus : la recherche est
 * E2-04, les prix E2-03, le stock E3. La liste montre les produits non
 * supprimés ; un produit supprimé la quitte, et la suppression s'annule d'ici.
 *
 * Lisible par tout le commerce (`view_catalogue`, les deux rôles, SPEC § 3.1).
 * La fiche et l'ajout sont réservés à `manage_product` : pour l'employé, les
 * lignes ne mènent nulle part et le bouton d'ajout n'existe pas. Le masquer est
 * un confort ; ce qui protège, ce sont les policies d'écriture de `product`.
 *
 * BRAND-UI § 8 : quatre états. Ligne de 64 px, photo au début de la ligne
 * (à droite en RTL, par les propriétés logiques), nom au-dessus, référence en
 * dessous. BRAND-UI § 7 : l'action principale en bas, au pouce.
 */

import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { useCan } from '@/lib/auth'
import { signedPhotoUrls } from '@/modules/catalogue/photo'
import { listProducts, restoreProduct, type ProductSummary } from '@/modules/catalogue/products'

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; products: ProductSummary[]; photos: Map<string, string> }

/** Ce que la fiche transmet en revenant à la liste. */
export interface ProductListNavigation {
  saved?: string
  deleted?: { id: string; name: string }
}

interface Notice {
  text: string
  /** Le produit qu'« Annuler la suppression » rétablit. */
  undo?: { id: string; name: string }
}

function noticeOf(navigation: ProductListNavigation | null): Notice | null {
  if (navigation?.deleted !== undefined) {
    return { text: `« ${navigation.deleted.name} » supprimé.`, undo: navigation.deleted }
  }
  if (navigation?.saved !== undefined) return { text: `« ${navigation.saved} » enregistré.` }
  return null
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement des produits" className="flex flex-col">
      {[0, 1, 2, 3].map((n) => (
        <div key={n} className="flex h-row items-center gap-4 border-b border-paper-200">
          <div className="size-12 shrink-0 rounded-field bg-paper-100" />
          <div className="h-4 flex-1 rounded-field bg-paper-100" />
        </div>
      ))}
    </div>
  )
}

/*
 * E11-02 : « photo produit systématique — ne jamais dépendre du seul texte ».
 * Sans photo, l'initiale tient la place : la colonne reste alignée, et la
 * ligne ne réclame rien.
 */
function Thumbnail({ url, name }: { url: string | undefined; name: string }) {
  if (url !== undefined) {
    return (
      <img
        src={url}
        alt=""
        className="size-12 shrink-0 rounded-field border border-paper-200 object-cover"
      />
    )
  }
  return (
    <div
      aria-hidden="true"
      className="flex size-12 shrink-0 items-center justify-center rounded-field bg-paper-100 text-subtitle text-paper-700"
    >
      {name.trim().charAt(0).toUpperCase()}
    </div>
  )
}

function ProductRow({
  product,
  photoUrl,
  editable,
}: {
  product: ProductSummary
  photoUrl: string | undefined
  editable: boolean
}) {
  const content = (
    <>
      <Thumbnail url={photoUrl} name={product.name} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-subtitle text-paper-900">{product.name}</p>
        {/* Une référence est une donnée : 16 px, chiffres tabulaires (BRAND-UI § 6). */}
        {product.code !== null && (
          <p className="tabular truncate text-body text-paper-700">{product.code}</p>
        )}
      </div>
    </>
  )

  return (
    <li className="border-b border-paper-200">
      {editable ? (
        <Link to={`/products/${product.id}`} className="flex min-h-row items-center gap-4 py-2">
          {content}
        </Link>
      ) : (
        <div className="flex min-h-row items-center gap-4 py-2">{content}</div>
      )}
    </li>
  )
}

export function ProductListScreen() {
  const location = useLocation()
  const canManage = useCan('manage_product')

  const [state, setState] = useState<State>({ status: 'loading' })
  const [notice, setNotice] = useState<Notice | null>(() =>
    noticeOf(location.state as ProductListNavigation | null),
  )
  const [failure, setFailure] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  const load = useCallback(() => {
    listProducts()
      .then(async (products) => {
        setState({ status: 'loaded', products, photos: new Map() })
        const photos = await signedPhotoUrls(
          products.map((p) => p.photoPath).filter((p): p is string => p !== null),
        )
        setState((current) =>
          current.status === 'loaded' && current.products === products
            ? { ...current, photos }
            : current,
        )
      })
      .catch((error: unknown) =>
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Chargement impossible.',
        }),
      )
  }, [])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    load()
  }, [load])

  useEffect(load, [load])

  const undo = async (product: { id: string; name: string }): Promise<void> => {
    if (restoring) return
    setFailure(null)
    setRestoring(true)
    try {
      await restoreProduct(product.id)
      setNotice({ text: `« ${product.name} » rétabli.` })
      retry()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Rétablissement impossible.')
    } finally {
      setRestoring(false)
    }
  }

  const count = state.status === 'loaded' ? state.products.length : 0

  return (
    <main className="min-h-dvh px-4 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div>
          <h1 className="text-title text-paper-900">Produits</h1>
          {count > 0 && (
            <p className="tabular mt-2 text-body text-paper-700">
              {count} produit{count > 1 ? 's' : ''}
            </p>
          )}
        </div>

        {notice !== null && (
          <div className="flex flex-col items-start gap-2">
            <p role="status" className="text-body text-paper-700">
              {notice.text}
            </p>
            {notice.undo !== undefined && (
              <button
                type="button"
                disabled={restoring}
                onClick={() => void undo(notice.undo!)}
                className="h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
              >
                Annuler la suppression
              </button>
            )}
          </div>
        )}

        {failure !== null && (
          <p role="alert" className="text-body text-red-600">
            {failure}
          </p>
        )}

        {state.status === 'loading' && <Skeleton />}

        {state.status === 'error' && (
          <div className="flex flex-col items-start gap-4 rounded-card border border-red-500 bg-red-100 p-4">
            <p role="alert" className="text-body text-red-700">
              {state.message}
            </p>
            <button
              type="button"
              onClick={retry}
              className="h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
            >
              Réessayer
            </button>
          </div>
        )}

        {state.status === 'loaded' && state.products.length === 0 && (
          <div className="rounded-card border border-paper-200 bg-white p-6">
            <p className="text-body text-paper-700">
              {canManage ? 'Aucun produit. Ajoutez le premier.' : 'Aucun produit pour l’instant.'}
            </p>
          </div>
        )}

        {state.status === 'loaded' && state.products.length > 0 && (
          <ul className="flex flex-col">
            {state.products.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                photoUrl={product.photoPath === null ? undefined : state.photos.get(product.photoPath)}
                editable={canManage}
              />
            ))}
          </ul>
        )}

        {canManage && (
          <Link
            to="/products/new"
            className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
          >
            Ajouter un produit
          </Link>
        )}
      </div>
    </main>
  )
}
