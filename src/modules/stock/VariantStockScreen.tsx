/*
 * Le stock d'un produit et l'historique de ses variantes. M2 — E3-02.
 *
 * Ouvert depuis la liste des produits, à `/products/:id/stock`. Un écran de
 * détail : un retour, aucune barre d'onglets (BRAND-UI § 13) — le stock se
 * consulte dans l'onglet Produits, sans onglet à lui.
 *
 * Le retour mène à `/products` pour tout le monde, et non à la fiche produit :
 * la fiche est réservée à `manage_product`, et l'acteur de cette story est le
 * vendeur, qui ne l'a pas. Un retour vers un écran interdit serait une impasse.
 *
 * Deux parties, parce que le critère en demande deux :
 *
 *   — les variantes du produit avec leur quantité. Un produit a toujours au
 *     moins une variante (CLAUDE.md) ; quand il n'en a qu'une, la liste ne
 *     propose rien à choisir, elle montre simplement la quantité ;
 *   — l'historique **complet** de la variante choisie, du plus récent au plus
 *     ancien, avec pour chaque mouvement sa date, son type, sa quantité, son
 *     auteur et son document.
 *
 * **Le stock négatif est un repère visuel, et rien d'autre** (RÈGLE M2-3) :
 * ambre sur fond ambre (BRAND-UI § 5), jamais un `role="alert"`, jamais une
 * modale, jamais un blocage. Un grossiste vend ce qui est encore sur le camion.
 *
 * **« Stock non saisi » n'est pas « 0 »** (SPEC § 2.5). Tant qu'aucun mouvement
 * n'a touché la variante, la quantité vaut zéro sans que personne ait compté :
 * l'écrire « 0 » serait présenter comme certaine une valeur qui ne l'est pas.
 *
 * BRAND-UI : quantités en chiffres tabulaires (§ 6), lignes de 64 px (§ 8),
 * quatre états (§ 8), propriétés logiques (§ 9), aucune icône sans texte (§ 11).
 */

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

import { BackLink } from '@/components/BackLink'
import { formatDateTime } from '@/lib/dates'
import { quantityText } from '@/lib/decimal'
import { Quantity } from '@/modules/stock/Quantity'
import { loadProductStock, type ProductStock, type VariantStock } from '@/modules/stock/levels'
import {
  MOVEMENT_LABELS,
  SOURCE_LABELS,
  listStockMovements,
  type StockMovement,
} from '@/modules/stock/movements'

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'missing' }
  | { status: 'loaded'; product: ProductStock }

type History =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; movements: StockMovement[] }

/* -------------------------------------------------------------------------- */
/* La quantité, et ce qu'elle veut dire                                        */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Les états de chargement                                                     */
/* -------------------------------------------------------------------------- */

function Skeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="flex flex-col">
      {Array.from({ length: rows }, (_, n) => (
        <div key={n} className="flex h-row items-center gap-4 border-b border-paper-200">
          <div className="h-4 flex-1 rounded-field bg-paper-100" />
          <div className="h-4 w-16 rounded-field bg-paper-100" />
        </div>
      ))}
    </div>
  )
}

function Failure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-card border border-red-500 bg-red-100 p-4">
      <p role="alert" className="text-body text-red-700">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
      >
        Réessayer
      </button>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* L'historique                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Le document d'origine. Les tables visées n'existent pas avant E4 et E8 : le
 * mouvement porte un type, pas un numéro, et la ligne le nomme sans y mener.
 * Un ajustement manuel (E3-03) n'a pas de document — son motif tient lieu de
 * justification, et c'est `note` qui le porte.
 */
function sourceOf(movement: StockMovement): string {
  if (movement.sourceType !== null) return SOURCE_LABELS[movement.sourceType]
  return movement.note ?? '—'
}

function MovementRow({ movement }: { movement: StockMovement }) {
  const when = formatDateTime(movement.createdAt)
  const sign = movement.quantity.trimStart().startsWith('-')

  return (
    <li className="flex min-h-row items-center gap-4 border-b border-paper-200 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-subtitle text-paper-900">
          {MOVEMENT_LABELS[movement.movementType]}
        </p>
        {/* La date est une donnée : chiffres tabulaires (BRAND-UI § 6). */}
        <p className="tabular truncate text-body text-paper-700">{when ?? '—'}</p>
        <p className="truncate text-body text-paper-700">
          {/* L'auteur, puis le document. C'est ce qu'on cherche un soir où une
              quantité ne tombe pas juste. */}
          {movement.authorName ?? 'Auteur inconnu'} · {sourceOf(movement)}
        </p>
      </div>
      {/*
       * La quantité du mouvement, alignée au bord opposé (BRAND-UI § 8). Elle
       * est signée, et son signe est l'information : une sortie n'est pas une
       * entrée. Pas de couleur ici — le négatif d'un mouvement est normal,
       * c'est le négatif d'un **niveau** qui est un repère (RÈGLE M2-3).
       */}
      <span className="tabular shrink-0 text-subtitle text-paper-900">
        {sign ? '' : '+'}
        {quantityText(movement.quantity)}
      </span>
    </li>
  )
}

function VariantHistory({ variantId }: { variantId: string }) {
  const [history, setHistory] = useState<History>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  /*
   * Aucun `setState` dans le corps de l'effet : il déclenche une cascade de
   * rendus (`react-hooks/set-state-in-effect`). L'état part à « chargement »,
   * et le composant est remonté par sa `key` quand la variante change — c'est
   * le même effet, sans le rendu supplémentaire. Le bouton « Réessayer » remet
   * l'état lui-même, puisqu'il est déjà dans un gestionnaire.
   */
  useEffect(() => {
    let current = true

    listStockMovements(variantId)
      .then((movements) => {
        if (current) setHistory({ status: 'loaded', movements })
      })
      .catch((error: unknown) => {
        if (!current) return
        setHistory({
          status: 'error',
          message: error instanceof Error ? error.message : 'Chargement impossible.',
        })
      })

    return () => {
      current = false
    }
  }, [variantId, attempt])

  if (history.status === 'loading') {
    return <Skeleton rows={3} label="Chargement des mouvements" />
  }

  if (history.status === 'error') {
    return (
      <Failure
        message={history.message}
        onRetry={() => {
          setHistory({ status: 'loading' })
          setAttempt((n) => n + 1)
        }}
      />
    )
  }

  if (history.movements.length === 0) {
    return (
      <div className="rounded-card border border-paper-200 bg-white p-6">
        <p className="text-body text-paper-700">
          Aucun mouvement sur cette variante. Son stock n’a jamais été saisi.
        </p>
      </div>
    )
  }

  return (
    <ul className="flex flex-col">
      {history.movements.map((movement) => (
        <MovementRow key={movement.id} movement={movement} />
      ))}
    </ul>
  )
}

/* -------------------------------------------------------------------------- */
/* Le choix de la variante                                                     */
/* -------------------------------------------------------------------------- */

function VariantChoice({
  variants,
  chosen,
  onChoose,
}: {
  variants: readonly VariantStock[]
  chosen: string
  onChoose: (variantId: string) => void
}) {
  return (
    <div role="group" aria-label="Variantes" className="flex flex-col">
      {variants.map((variant) => {
        const active = variant.variantId === chosen
        return (
          <button
            key={variant.variantId}
            type="button"
            aria-pressed={active}
            onClick={() => onChoose(variant.variantId)}
            className={`flex min-h-row items-center justify-between gap-4 border-b border-paper-200 px-2 py-2 text-start ${
              active ? 'bg-ink-100' : ''
            }`}
          >
            <span className="tabular min-w-0 flex-1 truncate text-body text-paper-900">
              {variant.sku ?? 'Sans référence'}
            </span>
            <Quantity level={variant} size="subtitle" />
          </button>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* L'écran                                                                     */
/* -------------------------------------------------------------------------- */

export function VariantStockScreen() {
  const { id: productId } = useParams<{ id: string }>()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [chosen, setChosen] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (productId === undefined) return
    let current = true

    loadProductStock(productId)
      .then((product) => {
        if (!current) return
        if (product === null) {
          setState({ status: 'missing' })
          return
        }
        setState({ status: 'loaded', product })
        // La variante par défaut est en tête, et c'est celle qu'on ouvre : dans
        // un commerce sans le pack `variants`, c'est la seule.
        setChosen(product.variants[0]?.variantId ?? null)
      })
      .catch((error: unknown) => {
        if (!current) return
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Chargement impossible.',
        })
      })

    return () => {
      current = false
    }
  }, [productId, attempt])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  return (
    <main className="min-h-dvh px-4 pt-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 pb-6">
        <div className="flex flex-col gap-2">
          <BackLink to="/products" label="Produits" />
          <h1 className="text-title text-paper-900">Stock</h1>
        </div>

        {state.status === 'loading' && <Skeleton rows={4} label="Chargement du stock" />}

        {state.status === 'error' && <Failure message={state.message} onRetry={retry} />}

        {state.status === 'missing' && (
          <div className="rounded-card border border-paper-200 bg-white p-6">
            <p className="text-body text-paper-700">Ce produit n’existe pas, ou plus.</p>
          </div>
        )}

        {state.status === 'loaded' && (
          <>
            <div className="flex flex-col gap-1">
              <p className="text-subtitle text-paper-900">{state.product.name}</p>
              {state.product.nameAr !== null && (
                /* Le nom arabe suit son écriture, quelle que soit celle de l'interface. */
                <p dir="rtl" className="text-body text-paper-700">
                  {state.product.nameAr}
                </p>
              )}
              {state.product.code !== null && (
                <p className="tabular text-body text-paper-700">{state.product.code}</p>
              )}
            </div>

            <section className="flex flex-col gap-2">
              <h2 className="text-subtitle text-paper-900">
                {state.product.variants.length > 1 ? 'Variantes' : 'Quantité'}
              </h2>
              {chosen !== null && (
                <VariantChoice
                  variants={state.product.variants}
                  chosen={chosen}
                  onChoose={setChosen}
                />
              )}
            </section>

            <section className="flex flex-col gap-2">
              <h2 className="text-subtitle text-paper-900">Mouvements</h2>
              {chosen !== null && <VariantHistory key={chosen} variantId={chosen} />}
            </section>
          </>
        )}
      </div>
    </main>
  )
}
