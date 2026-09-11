/*
 * La grille de prix d'un produit. M1 — E2-03, RÈGLE M1-2.
 *
 * Un écran à part, ouvert depuis la fiche (`/products/:id/prices`) : la fiche
 * reste celle du « nom suffit » (SPEC § 2.6), et les prix se posent quand le
 * patron le veut. Arbitré en E2-03.
 *
 *   — La ligne à l'unité est toujours là, quantité figée à 1, jamais retirée :
 *     la base la crée et la garde (RÈGLE M1-2). Son prix peut rester vide —
 *     « prix non renseigné » ; la vente le fera saisir, rien ne bloque.
 *   — Les autres paliers s'ajoutent et se retirent librement. Un palier vide
 *     est ignoré ; un palier à moitié rempli retient le bouton, sans un mot.
 *   — Le plancher n'apparaît qu'au compte qui a `manage_product`, le prix
 *     d'achat qu'au compte qui a `view_cost`. Les masquer est un confort : ce
 *     qui protège, ce sont les policies (`priceGrid.ts`).
 *
 * Les champs filtrent la frappe (`decimalInput`) : ils ne peuvent pas contenir
 * ce que la base refuserait, et n'ont donc jamais à le reprocher.
 *
 * BRAND-UI : libellés au-dessus des champs (§ 8), montants et quantités en
 * chiffres tabulaires (§ 6), `DH` après le montant (§ 6), cibles de 48 px et
 * action principale collée en bas, au pouce (§ 7), propriétés logiques (§ 9),
 * aucune icône sans texte (§ 11). Quatre états (§ 8).
 */

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'

import { BackLink } from '@/components/BackLink'
import { Field } from '@/components/Field'
import { Button } from '@/components/ui/button'
import { useCan } from '@/lib/auth'
import { MONEY_SCALE, QUANTITY_SCALE, decimalInput } from '@/lib/decimal'
import {
  canSaveGrid,
  draftOfGrid,
  gridChanges,
  hasChanges,
  loadGrid,
  newBreak,
  saveGrid,
  type BreakDraft,
  type GridDraft,
  type SavedGrid,
} from '@/modules/catalogue/priceGrid'

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'missing' }
  | { status: 'ready'; saved: SavedGrid }

const SECONDARY =
  'flex h-button w-full items-center justify-center rounded-button border border-paper-300 bg-white text-body text-ink-700'

const SMALL_BUTTON =
  'h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700'

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement de la grille" className="flex flex-col gap-6">
      {[0, 1, 2].map((n) => (
        <div key={n} className="h-field rounded-field bg-paper-100" />
      ))}
    </div>
  )
}

/** La route. La clé force un écran neuf d'un produit à l'autre. */
export function PriceGridScreen() {
  const { id } = useParams<{ id: string }>()
  return <PriceGrid key={id} productId={id!} />
}

function PriceGrid({ productId }: { productId: string }) {
  const withCost = useCan('view_cost')
  const canEditFloor = useCan('manage_product')
  const idPrefix = useId()

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [draft, setDraft] = useState<GridDraft>({ breaks: [], floorPrice: '', costPrice: '' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const load = useCallback(() => {
    loadGrid(productId, withCost)
      .then((saved) => {
        if (saved === null) {
          setLoaded({ status: 'missing' })
          return
        }
        setDraft(draftOfGrid(saved))
        setLoaded({ status: 'ready', saved })
      })
      .catch((error: unknown) =>
        setLoaded({
          status: 'error',
          message: error instanceof Error ? error.message : 'Chargement impossible.',
        }),
      )
  }, [productId, withCost])

  const retry = useCallback(() => {
    setLoaded({ status: 'loading' })
    load()
  }, [load])

  useEffect(load, [load])

  const editBreak = (key: string, field: 'minQty' | 'unitPrice', raw: string): void => {
    const value = decimalInput(raw, field === 'minQty' ? QUANTITY_SCALE : MONEY_SCALE)
    setMessage(null)
    setDraft((current) => ({
      ...current,
      breaks: current.breaks.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    }))
  }

  const editAmount =
    (field: 'floorPrice' | 'costPrice') =>
    (raw: string): void => {
      setMessage(null)
      setDraft((current) => ({ ...current, [field]: decimalInput(raw, MONEY_SCALE) }))
    }

  const addBreak = (): void => {
    setMessage(null)
    setDraft((current) => ({
      ...current,
      breaks: [...current.breaks, newBreak(crypto.randomUUID())],
    }))
  }

  const removeBreak = (key: string): void => {
    setMessage(null)
    setDraft((current) => ({
      ...current,
      breaks: current.breaks.filter((row) => row.key !== key),
    }))
  }

  const changes =
    loaded.status === 'ready' && canSaveGrid(draft)
      ? gridChanges(loaded.saved, draft, () => crypto.randomUUID())
      : null
  const savable = changes !== null && hasChanges(changes)

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (loaded.status !== 'ready' || saving || changes === null || !hasChanges(changes)) return

    setSaving(true)
    setFailure(null)
    setMessage(null)
    try {
      await saveGrid(loaded.saved, changes)
      const saved = await loadGrid(productId, withCost)
      if (saved === null) {
        setLoaded({ status: 'missing' })
        return
      }
      setDraft(draftOfGrid(saved))
      setLoaded({ status: 'ready', saved })
      setMessage('Grille enregistrée.')
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Enregistrement impossible.')
    } finally {
      setSaving(false)
    }
  }

  const fieldId = (row: BreakDraft, field: string): string => `${idPrefix}-${row.key}-${field}`
  /** Le numéro affiché d'un palier : la ligne à l'unité est le palier 1. */
  const tierOf = (index: number): number =>
    draft.breaks.slice(0, index).filter((row) => !row.base).length + 2

  return (
    <main className="min-h-dvh px-4 pt-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 pb-6">
        <div>
          <BackLink to={`/products/${productId}`} label="Fiche produit" />
          <h1 className="text-title text-paper-900">Grille de prix</h1>
          {loaded.status === 'ready' && (
            <p className="mt-2 text-body text-paper-700">{loaded.saved.productName}</p>
          )}
        </div>

        {loaded.status === 'loading' && <Skeleton />}

        {loaded.status === 'error' && (
          <div className="flex flex-col items-start gap-4 rounded-card border border-red-500 bg-red-100 p-4">
            <p role="alert" className="text-body text-red-700">
              {loaded.message}
            </p>
            <button type="button" onClick={retry} className={SMALL_BUTTON}>
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
              {draft.breaks.map((row, index) => {
                if (row.base) {
                  return (
                    <fieldset key={row.key} className="flex flex-col gap-2">
                      <legend className="text-label text-paper-900 text-start">
                        Prix à l’unité
                      </legend>
                      <Field
                        id={fieldId(row, 'price')}
                        label="Prix unitaire (DH), dès 1"
                        value={row.unitPrice}
                        onChange={(value) => editBreak(row.key, 'unitPrice', value)}
                        inputMode="decimal"
                        className="tabular"
                      />
                    </fieldset>
                  )
                }

                const tier = tierOf(index)
                return (
                  <fieldset
                    key={row.key}
                    className="flex flex-col gap-4 border-t border-paper-200 pt-4"
                  >
                    <legend className="text-label text-paper-900 text-start">Palier {tier}</legend>
                    <Field
                      id={fieldId(row, 'qty')}
                      label="À partir de (quantité)"
                      value={row.minQty}
                      onChange={(value) => editBreak(row.key, 'minQty', value)}
                      inputMode="decimal"
                      className="tabular"
                    />
                    <Field
                      id={fieldId(row, 'price')}
                      label="Prix unitaire (DH)"
                      value={row.unitPrice}
                      onChange={(value) => editBreak(row.key, 'unitPrice', value)}
                      inputMode="decimal"
                      className="tabular"
                    />
                    <button
                      type="button"
                      onClick={() => removeBreak(row.key)}
                      className={`${SMALL_BUTTON} self-start`}
                    >
                      Retirer le palier {tier}
                    </button>
                  </fieldset>
                )
              })}

              <button type="button" onClick={addBreak} className={SECONDARY}>
                Ajouter un palier
              </button>

              {canEditFloor && (
                <Field
                  id={`${idPrefix}-floor`}
                  label="Prix plancher (DH)"
                  value={draft.floorPrice}
                  onChange={editAmount('floorPrice')}
                  inputMode="decimal"
                  className="tabular"
                  hint="Un employé ne vend pas en dessous."
                />
              )}

              {withCost && (
                <Field
                  id={`${idPrefix}-cost`}
                  label="Prix d’achat (DH)"
                  value={draft.costPrice}
                  onChange={editAmount('costPrice')}
                  inputMode="decimal"
                  className="tabular"
                />
              )}

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

              {/* Même bouton que la fiche : inactif sans un mot, gris à 4,5:1. */}
              <div className="sticky bottom-0 -mx-4 border-t border-paper-200 bg-paper-50 px-4 py-4">
                <Button
                  type="submit"
                  disabled={saving || !savable}
                  className="h-button w-full rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800 disabled:bg-paper-200 disabled:text-paper-700 disabled:opacity-100"
                >
                  {saving ? 'Enregistrement…' : 'Enregistrer la grille'}
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
    </main>
  )
}
