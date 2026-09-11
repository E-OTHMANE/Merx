/*
 * Créer et modifier un produit. M1 — E2-02. Le premier écran métier.
 *
 * SPEC § 2.6, RÈGLE — principe directeur, prime sur toute autre considération :
 * **le seul champ obligatoire est le nom.** L'écran est dessiné par cette phrase.
 *
 *   — Aucun champ ne se marque. Pas d'astérisque, pas de « facultatif », pas de
 *     rouge, pas d'`aria-invalid`, pas d'attribut `required` — le navigateur en
 *     ferait une bulle de reproche. Un champ vide est un champ vide.
 *   — Le nom vide ne se reproche pas non plus : le bouton reste simplement
 *     inactif, sans un mot. Le nom a le focus en arrivant ; le reste attend.
 *   — La catégorie n'apparaît que s'il en existe. Sinon, rien ne la réclame.
 *   — Un champ jamais rempli ne part pas, pas même à `null` (`products.ts`).
 *
 * « En quelques secondes » : après une création, le formulaire se vide et
 * redonne le focus au nom. Le patron qui saisit vingt produits d'affilée ne
 * repasse pas par la liste entre deux.
 *
 * La photo ne conditionne rien : le produit s'enregistre d'abord, la photo
 * suit. Si elle ne passe pas, le produit reste enregistré, et le message le dit.
 *
 * BRAND-UI : libellés au-dessus des champs (§ 8), cibles de 48 px et boutons de
 * 56 px (§ 7), l'action principale collée en bas de l'écran, au pouce (§ 7),
 * propriétés logiques et nom arabe saisi de droite à gauche (§ 9), aucune icône
 * sans texte (§ 11). Quatre états (§ 8) : chargement, erreur, « vide » — le
 * produit n'existe plus —, contenu.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { Field } from '@/components/Field'
import { Button } from '@/components/ui/button'
import { useCan } from '@/lib/auth'
import { listCategories, type Category } from '@/modules/catalogue/categories'
import {
  PHOTO_MESSAGES,
  removePhoto,
  resizePhoto,
  signedPhotoUrls,
  uploadPhoto,
} from '@/modules/catalogue/photo'
import type { ProductListNavigation } from '@/modules/catalogue/ProductListScreen'
import {
  EMPTY_DRAFT,
  canSave,
  changesBetween,
  createProduct,
  deleteProduct,
  digitsOnly,
  draftOf,
  getProduct,
  updateProduct,
  type ProductChanges,
  type ProductDraft,
} from '@/modules/catalogue/products'

type Photo =
  | { status: 'none' }
  | { status: 'stored'; path: string; url: string | null }
  | { status: 'new'; blob: Blob; preview: string }

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'missing' }
  | { status: 'ready'; saved: ProductDraft; storedPath: string | null }

const SECONDARY =
  'flex h-button w-full items-center justify-center rounded-button border border-paper-300 bg-white text-body text-ink-700'

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement du produit" className="flex flex-col gap-6">
      {[0, 1, 2, 3].map((n) => (
        <div key={n} className="h-field rounded-field bg-paper-100" />
      ))}
    </div>
  )
}

/**
 * La route. La clé force un formulaire neuf quand on passe d'une fiche à une
 * autre, ou d'une fiche à « nouveau » : sans elle, React garderait le brouillon
 * du produit précédent.
 */
export function ProductFormScreen() {
  const { id } = useParams<{ id: string }>()
  return <ProductForm key={id ?? 'new'} productId={id ?? null} />
}

function ProductForm({ productId }: { productId: string | null }) {
  const navigate = useNavigate()
  const creating = productId === null
  // E2-03 : la grille de prix est un écran à part, ouvert depuis la fiche.
  const canEditPrices = useCan('manage_price_list')

  const nameId = useId()
  const codeId = useId()
  const nameArId = useId()
  const categoryId = useId()
  const brandId = useId()
  const unitId = useId()
  const piecesId = useId()

  const [loaded, setLoaded] = useState<Loaded>(
    creating ? { status: 'ready', saved: EMPTY_DRAFT, storedPath: null } : { status: 'loading' },
  )
  const [draft, setDraft] = useState<ProductDraft>(EMPTY_DRAFT)
  const [photo, setPhoto] = useState<Photo>({ status: 'none' })
  const [categories, setCategories] = useState<Category[]>([])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  /*
   * Les catégories, en silence : un échec de lecture ne se signale pas plus
   * qu'une liste vide. Le champ n'apparaît simplement pas, et le produit
   * s'enregistre sans (SPEC § 2.6).
   */
  useEffect(() => {
    let active = true
    listCategories()
      .then((list) => {
        if (active) setCategories(list)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const load = useCallback(() => {
    if (productId === null) return
    getProduct(productId)
      .then(async (product) => {
        if (product === null) {
          setLoaded({ status: 'missing' })
          return
        }
        const saved = draftOf(product)
        setDraft(saved)
        setLoaded({ status: 'ready', saved, storedPath: product.photoPath })

        const path = product.photoPath
        if (path === null) return
        setPhoto({ status: 'stored', path, url: null })
        const urls = await signedPhotoUrls([path])
        setPhoto((current) =>
          current.status === 'stored' && current.path === path
            ? { ...current, url: urls.get(path) ?? null }
            : current,
        )
      })
      .catch((error: unknown) =>
        setLoaded({
          status: 'error',
          message: error instanceof Error ? error.message : 'Chargement impossible.',
        }),
      )
  }, [productId])

  const retry = useCallback(() => {
    setLoaded({ status: 'loading' })
    load()
  }, [load])

  useEffect(load, [load])

  // L'aperçu d'une photo neuve est une URL locale : la libérer quand elle change.
  useEffect(() => {
    if (photo.status !== 'new') return
    return () => URL.revokeObjectURL(photo.preview)
  }, [photo])

  const edit =
    (field: keyof ProductDraft) =>
    (value: string): void => {
      setMessage(null)
      setDraft((current) => ({ ...current, [field]: value }))
    }

  const onPhoto = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    // Vidé pour que reprendre la même photo redéclenche la sélection.
    event.target.value = ''
    if (file === undefined) return

    setFailure(null)
    setMessage(null)
    try {
      const blob = await resizePhoto(file)
      setPhoto({ status: 'new', blob, preview: URL.createObjectURL(blob) })
    } catch {
      setFailure(PHOTO_MESSAGES.unreadable)
    }
  }

  const create = async (): Promise<void> => {
    const id = crypto.randomUUID()
    const name = draft.name.trim()
    await createProduct(id, draft)

    let notice = `« ${name} » enregistré.`
    if (photo.status === 'new') {
      let path: string | null = null
      try {
        path = await uploadPhoto(id, photo.blob)
        await updateProduct(id, { photo_url: path })
      } catch {
        if (path !== null) void removePhoto(path)
        notice = `« ${name} » enregistré, sans sa photo : elle n’a pas pu être envoyée. Reprenez-la depuis la liste des produits.`
      }
    }

    setDraft(EMPTY_DRAFT)
    setPhoto({ status: 'none' })
    setMessage(notice)
    document.getElementById(nameId)?.focus()
  }

  const save = async (id: string, saved: ProductDraft, storedPath: string | null): Promise<void> => {
    const changes: ProductChanges = changesBetween(saved, draft)

    let uploadedPath: string | null = null
    if (photo.status === 'new') {
      uploadedPath = await uploadPhoto(id, photo.blob)
      changes.photo_url = uploadedPath
    } else if (photo.status === 'none' && storedPath !== null) {
      changes.photo_url = null
    }

    try {
      if (Object.keys(changes).length > 0) await updateProduct(id, changes)
    } catch (error) {
      if (uploadedPath !== null) void removePhoto(uploadedPath)
      throw error
    }
    if ('photo_url' in changes && storedPath !== null) void removePhoto(storedPath)

    const state: ProductListNavigation = { saved: draft.name.trim() }
    navigate('/products', { replace: true, state })
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (loaded.status !== 'ready' || saving || !canSave(draft)) return

    setSaving(true)
    setFailure(null)
    setMessage(null)
    try {
      if (productId === null) await create()
      else await save(productId, loaded.saved, loaded.storedPath)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Enregistrement impossible.')
    } finally {
      setSaving(false)
    }
  }

  /*
   * Supprimer, sans modale : la suppression est douce et s'annule depuis la
   * liste. BRAND-UI § 11 réserve les confirmations à l'irréversible.
   */
  const onDelete = async (): Promise<void> => {
    if (productId === null || loaded.status !== 'ready' || saving) return

    setSaving(true)
    setFailure(null)
    try {
      await deleteProduct(productId)
      const state: ProductListNavigation = { deleted: { id: productId, name: loaded.saved.name } }
      navigate('/products', { replace: true, state })
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Suppression impossible.')
      setSaving(false)
    }
  }

  const photoUrl =
    photo.status === 'new' ? photo.preview : photo.status === 'stored' ? photo.url : null
  const hasPhoto = photo.status !== 'none'

  return (
    <main className="min-h-dvh px-4 pt-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 pb-6">
        <div>
          <h1 className="text-title text-paper-900">{creating ? 'Nouveau produit' : 'Fiche produit'}</h1>
          {creating && (
            <p className="mt-2 text-body text-paper-700">
              Le nom suffit. Le reste se complète quand vous voulez.
            </p>
          )}
        </div>

        {loaded.status === 'loading' && <Skeleton />}

        {loaded.status === 'error' && (
          <div className="flex flex-col items-start gap-4 rounded-card border border-red-500 bg-red-100 p-4">
            <p role="alert" className="text-body text-red-700">
              {loaded.message}
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

        {loaded.status === 'missing' && (
          <div className="flex flex-col gap-4 rounded-card border border-paper-200 bg-white p-6">
            <p className="text-body text-paper-700">
              Ce produit n’existe plus. Il a peut-être été supprimé.
            </p>
            <Link to="/products" className={SECONDARY}>
              Retour aux produits
            </Link>
          </div>
        )}

        {loaded.status === 'ready' && (
          <>
            <form className="flex flex-col gap-6" onSubmit={onSubmit} noValidate>
              <Field
                id={nameId}
                label="Nom du produit"
                value={draft.name}
                onChange={edit('name')}
                autoFocus={creating}
              />

              <div className="flex flex-col gap-2">
                <span className="text-label text-paper-700 text-start">Photo</span>
                {photoUrl !== null && (
                  <img
                    src={photoUrl}
                    alt={draft.name.trim() === '' ? 'Photo du produit' : `Photo de ${draft.name.trim()}`}
                    className="size-40 rounded-card border border-paper-200 object-cover"
                  />
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    className="h-touch flex-1 rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
                  >
                    {hasPhoto ? 'Reprendre la photo' : 'Prendre une photo'}
                  </button>
                  {hasPhoto && (
                    <button
                      type="button"
                      onClick={() => setPhoto({ status: 'none' })}
                      className="h-touch flex-1 rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
                    >
                      Retirer la photo
                    </button>
                  )}
                </div>
                {/* `capture` : l'appareil photo arrière, directement (BACKLOG E2-02). */}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  tabIndex={-1}
                  aria-hidden="true"
                  className="sr-only"
                  onChange={(event) => void onPhoto(event)}
                />
              </div>

              <Field
                id={codeId}
                label="Référence"
                value={draft.code}
                onChange={edit('code')}
                className="tabular"
              />

              <Field
                id={nameArId}
                label="Nom en arabe"
                value={draft.nameAr}
                onChange={edit('nameAr')}
                dir="rtl"
                lang="ar"
              />

              {categories.length > 0 && (
                <div className="flex flex-col gap-2">
                  <label className="text-label text-paper-700 text-start" htmlFor={categoryId}>
                    Catégorie
                  </label>
                  <select
                    id={categoryId}
                    value={draft.categoryId}
                    onChange={(event) => edit('categoryId')(event.target.value)}
                    className="h-field w-full rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900 focus-visible:border-ink-600"
                  >
                    <option value="">Aucune</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <Field id={brandId} label="Marque" value={draft.brand} onChange={edit('brand')} />

              <Field
                id={unitId}
                label="Unité de vente"
                value={draft.unitLabel}
                onChange={edit('unitLabel')}
                hint="Exemple : pièce, flacon, boîte."
              />

              <Field
                id={piecesId}
                label="Pièces par carton"
                value={draft.piecesPerCarton}
                onChange={(value) => edit('piecesPerCarton')(digitsOnly(value))}
                inputMode="numeric"
                maxLength={6}
                className="tabular"
              />

              {failure !== null && (
                <p role="alert" className="text-body text-red-600">
                  {failure}
                </p>
              )}

              {message !== null && (
                <p role="status" className="text-body text-paper-700">
                  {message}
                </p>
              )}

              {/*
               * BRAND-UI § 7 : l'action principale reste au pouce, collée au bas
               * de l'écran pendant que le formulaire défile. Inactive sans nom —
               * sans un mot : un bouton gris n'est pas un reproche. Le gris est
               * choisi pour tenir 4,5:1 (BRAND-UI § 5), ce que l'opacité réduite
               * par défaut du composant ne tient pas.
               */}
              <div className="sticky bottom-0 -mx-4 border-t border-paper-200 bg-paper-50 px-4 py-4">
                <Button
                  type="submit"
                  disabled={saving || !canSave(draft)}
                  className="h-button w-full rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800 disabled:bg-paper-200 disabled:text-paper-700 disabled:opacity-100"
                >
                  {saving ? 'Enregistrement…' : 'Enregistrer le produit'}
                </Button>
              </div>
            </form>

            {!creating && canEditPrices && (
              <Link to={`/products/${productId}/prices`} className={SECONDARY}>
                Grille de prix
              </Link>
            )}

            <Link to="/products" className={SECONDARY}>
              {creating ? 'Voir les produits' : 'Retour aux produits'}
            </Link>

            {!creating && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void onDelete()}
                className="h-button w-full rounded-button border border-red-500 bg-white text-body text-red-600"
              >
                Supprimer le produit
              </button>
            )}
          </>
        )}
      </div>
    </main>
  )
}
