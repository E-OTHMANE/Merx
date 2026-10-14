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
 * **E3-03 — l'ajustement manuel.** L'écran gagne une troisième partie, et une
 * seule écriture : corriger la quantité de la variante choisie. Elle n'apparaît
 * qu'au patron (`adjust_stock`, § 3.1) et se place sous la quantité qu'elle
 * corrige, pas en bas de l'écran : § 7 de BRAND-UI place l'action principale
 * dans le tiers bas, et l'action principale de cet écran-ci reste la
 * consultation — l'ajustement agit sur le nombre qui est juste au-dessus de
 * lui, et l'historique qui suit montre ce qu'il a produit.
 *
 * Masquer n'est pas interdire : ce qui réserve l'ajustement au patron est la
 * policy `column_capability_insert`, et ce qui rend le motif obligatoire est la
 * contrainte `stock_movement_adjustment_reason`. Le champ requis ici évite un
 * aller-retour, il ne garde rien.
 *
 * BRAND-UI : quantités en chiffres tabulaires (§ 6), lignes de 64 px (§ 8),
 * quatre états (§ 8), propriétés logiques (§ 9), aucune icône sans texte (§ 11),
 * champs de 56 px au libellé au-dessus (§ 8).
 */

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'

import { BackLink } from '@/components/BackLink'
import { Field } from '@/components/Field'
import { Button } from '@/components/ui/button'
import { useCan } from '@/lib/auth'
import { formatDateTime } from '@/lib/dates'
import { QUANTITY_SCALE, decimalInput, quantityText } from '@/lib/decimal'
import { Quantity } from '@/modules/stock/Quantity'
import {
  ADJUSTMENT_MESSAGES,
  adjustStock,
  adjustmentDelta,
  deltaText,
} from '@/modules/stock/adjustment'
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
/* L'ajustement manuel — E3-03                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Corriger la quantité d'une variante.
 *
 * Le patron saisit ce qu'il a devant lui ; ce qui part en base est la
 * différence, en un mouvement `adjustment` (RÈGLE M2-1). La différence est
 * affichée avant validation : c'est elle qui sera écrite dans l'historique, et
 * la lire évite de corriger deux fois le même écart.
 *
 * Le motif est le seul champ obligatoire, et l'écran le dit en l'annonçant,
 * jamais en rougissant un champ (SPEC § 2.6 pour la manière, E3-03 pour
 * l'obligation elle-même).
 */
function AdjustmentForm({
  variant,
  onAdjusted,
}: {
  variant: VariantStock
  onAdjusted: () => void
}) {
  const idPrefix = useId()
  // Extraits avant le garde : deux constantes se laissent affiner par TypeScript
  // jusque dans le gestionnaire de soumission, un champ d'objet non.
  const { quantity, warehouseId } = variant
  const [corrected, setCorrected] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const delta = useMemo(
    () => (corrected === '' ? null : adjustmentDelta(quantity ?? '0', corrected)),
    [quantity, corrected],
  )

  /*
   * Rien à corriger si la quantité actuelle est inconnue : la ligne de niveau
   * naît avec la variante depuis E3-02, donc ce cas ne doit pas exister. Il est
   * dit plutôt que maquillé en zéro — un ajustement calculé sur une base
   * inventée écrirait un mouvement faux.
   */
  if (quantity === null || warehouseId === null) {
    return (
      <p className="text-body text-paper-700">
        La quantité de cette variante est indisponible : elle ne peut pas être corrigée.
      </p>
    )
  }

  const ready = delta !== null && delta !== 0n && reason.trim() !== ''

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    if (!ready || saving) return

    setSaving(true)
    setFailure(null)
    setMessage(null)

    adjustStock({
      variantId: variant.variantId,
      warehouseId,
      currentQuantity: quantity,
      correctedQuantity: corrected,
      reason,
    })
      .then((written) => {
        setCorrected('')
        setReason('')
        setMessage(`Stock corrigé de ${deltaText(written)}.`)
        // Le niveau et l'historique sont relus : ce que l'écran montre après
        // l'écriture vient de la base, jamais d'un calcul local.
        onAdjusted()
      })
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : ADJUSTMENT_MESSAGES.refused),
      )
      .finally(() => setSaving(false))
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
      <Field
        id={`${idPrefix}-quantity`}
        label="Quantité corrigée"
        inputMode="decimal"
        value={corrected}
        onChange={(raw) => {
          setMessage(null)
          setCorrected(decimalInput(raw, QUANTITY_SCALE))
        }}
        hint="Ce qui est réellement en stock. La différence est enregistrée."
      />

      <Field
        id={`${idPrefix}-reason`}
        label="Motif (obligatoire)"
        value={reason}
        onChange={(raw) => {
          setMessage(null)
          setReason(raw)
        }}
        maxLength={200}
      />

      {delta !== null && (
        <p className="text-body text-paper-700">
          Différence : <span className="tabular text-paper-900">{deltaText(delta)}</span>
        </p>
      )}

      {failure !== null && (
        <p role="alert" className="text-body text-red-700">
          {failure}
        </p>
      )}

      {message !== null && (
        <p role="status" className="text-body text-paper-700">
          {message}
        </p>
      )}

      {/* Inactif tant qu'il manque un motif ou une différence : un bouton qui
          part pour échouer est une promesse rompue. */}
      <Button
        type="submit"
        disabled={saving || !ready}
        className="h-button w-full rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800 disabled:bg-paper-200 disabled:text-paper-700 disabled:opacity-100"
      >
        {saving ? 'Enregistrement…' : 'Enregistrer l’ajustement'}
      </Button>
    </form>
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
  const canAdjust = useCan('adjust_stock')
  const [state, setState] = useState<State>({ status: 'loading' })
  const [chosen, setChosen] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  /*
   * Relu après un ajustement : il relance la lecture du produit — donc du
   * niveau — et, par la clé de l'historique, celle des mouvements. Séparé
   * d'`attempt`, qui est le bouton « Réessayer » : le second remet l'écran en
   * chargement, le premier doit laisser la quantité affichée le temps de la
   * relecture, sans faire clignoter l'écran après chaque correction.
   */
  const [written, setWritten] = useState(0)

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
  }, [productId, attempt, written])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  const chosenVariant =
    state.status === 'loaded'
      ? state.product.variants.find((variant) => variant.variantId === chosen)
      : undefined

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

            {/*
              * L'ajustement, au patron seul. Sous la quantité qu'il corrige, et
              * au-dessus de l'historique qui montrera son effet.
              */}
            {canAdjust && chosenVariant !== undefined && (
              <section className="flex flex-col gap-4 rounded-card border border-paper-200 bg-white p-4">
                <h2 className="text-subtitle text-paper-900">Ajuster la quantité</h2>
                <AdjustmentForm
                  key={chosenVariant.variantId}
                  variant={chosenVariant}
                  onAdjusted={() => setWritten((n) => n + 1)}
                />
              </section>
            )}

            <section className="flex flex-col gap-2">
              <h2 className="text-subtitle text-paper-900">Mouvements</h2>
              {chosen !== null && (
                <VariantHistory key={`${chosen}:${written}`} variantId={chosen} />
              )}
            </section>
          </>
        )}
      </div>
    </main>
  )
}
