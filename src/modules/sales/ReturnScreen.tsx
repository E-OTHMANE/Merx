/*
 * L'écran de retour — E4-06. SPEC § 8 (écrans : « retour »), RÈGLE M3-9 ;
 * BRAND-UI § 6, § 7, § 13.
 *
 * **Un écran à part, et non un mode de l'écran de vente.** La vente cherche,
 * scanne, parcourt une grille photo, résout un prix, force un prix, incite au
 * palier suivant : un retour ne fait aucune de ces choses. Ses lignes viennent
 * du bon d'origine et de nulle part ailleurs — on ne rend pas un article qui
 * n'a pas été livré (RÈGLE M3-9) —, et son prix est celui du papier. Greffer un
 * mode sur `SaleScreen` aurait demandé de masquer presque tout l'écran ; un
 * écran court dit mieux ce qu'un retour est.
 *
 * C'est un écran de **détail** : un retour vers Vente, aucune barre d'onglets
 * (BRAND-UI § 13), l'action dans le tiers bas au pouce (§ 7), le total en
 * *Chiffre principal* en chiffres tabulaires (§ 6). Cibles de 48 px : le
 * comptoir se tient debout, au doigt.
 *
 * **Le motif est saisissable, jamais obligatoire** (critère de la story). Il
 * part dans `sale_document.notes` — la note libre du document, qui s'imprime
 * (E5-01) — et l'étiquette dit ce qu'il est.
 *
 * Ce que l'écran **ne** tient pas : le registre du bon. Il refuse tôt, sous les
 * doigts du vendeur, avec sa propre phrase ; `merx.require_returnable_quantity()`
 * refuse pour de bon, à la confirmation, sous un verrou qui empêche deux retours
 * du même bon de se croiser.
 */

import { Minus, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

import { BackLink } from '@/components/BackLink'
import { moneyText } from '@/lib/decimal'
import { cachedDevicePrefix, installationId } from '@/lib/device'
import { documentTotals, lineTotalText } from '@/modules/sales/amounts'
import { removeLine, setQuantity, stepQuantity, type SaleLine } from '@/modules/sales/sale'
import {
  RETURN_DOC_TYPE,
  RETURN_MESSAGES,
  lineOverReturnable,
  loadForReturn,
  returnIsComplete,
} from '@/modules/sales/returns'
import { recordSale, type SaleProgress } from '@/modules/sales/saleWrite'

function ReturnLineRow({
  line,
  returnable,
  over,
  onQuantity,
  onStep,
  onRemove,
}: {
  line: SaleLine
  returnable: string | undefined
  over: boolean
  onQuantity: (raw: string) => void
  onStep: (delta: number) => void
  onRemove: () => void
}) {
  return (
    <li className="flex flex-col gap-2 border-b border-paper-200 py-3">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-subtitle text-paper-900">{line.name}</p>
          {line.reference !== null && (
            <p className="tabular truncate text-body text-paper-700">{line.reference}</p>
          )}
          {returnable !== undefined && (
            <p className="text-body text-paper-700">{`Livré, encore retournable : ${returnable}`}</p>
          )}
        </div>
        <output aria-label={`Total de la ligne — ${line.name}`} className="tabular text-body text-paper-900">
          {lineTotalText(line.quantity, line.unitPrice)}
        </output>
        <button
          type="button"
          aria-label={`Retirer du retour — ${line.name}`}
          onClick={onRemove}
          className="flex size-touch items-center justify-center rounded-button border border-paper-300 bg-white text-ink-700"
        >
          <Trash2 aria-hidden="true" className="size-5" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Une pièce de moins — ${line.name}`}
          onClick={() => onStep(-1)}
          className="flex size-touch items-center justify-center rounded-button border border-paper-300 bg-white text-ink-700"
        >
          <Minus aria-hidden="true" className="size-5" />
        </button>
        <input
          aria-label={`Quantité rendue — ${line.name}`}
          type="text"
          inputMode="decimal"
          value={line.quantity}
          onChange={(event) => onQuantity(event.target.value)}
          className="tabular h-field w-24 rounded-field border border-paper-300 bg-white px-3 text-center text-body text-paper-900 focus-visible:border-ink-600"
        />
        <button
          type="button"
          aria-label={`Une pièce de plus — ${line.name}`}
          onClick={() => onStep(1)}
          className="flex size-touch items-center justify-center rounded-button border border-paper-300 bg-white text-ink-700"
        >
          <Plus aria-hidden="true" className="size-5" />
        </button>
        {/* Le prix est celui du bon : il se lit, il ne se saisit pas. */}
        <output
          aria-label={`Prix du bon — ${line.name}`}
          className="tabular ms-auto text-body text-paper-700"
        >
          {moneyText(line.unitPrice)}
        </output>
      </div>

      {over && returnable !== undefined && (
        <p role="alert" className="text-body text-red-600">
          {RETURN_MESSAGES.overReturnable(returnable)}
        </p>
      )}
    </li>
  )
}

export function ReturnScreen() {
  const { documentId } = useParams<{ documentId: string }>()

  const [lines, setLines] = useState<SaleLine[]>([])
  const [returnable, setReturnable] = useState<Map<string, string>>(new Map())
  const [docNumber, setDocNumber] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [progress, setProgress] = useState<SaleProgress>({})
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [issued, setIssued] = useState<string | null>(null)

  /*
   * Les lignes entrent **une fois**, à l'arrivée : ensuite elles appartiennent
   * à la saisie, et une relecture les écraserait sous les doigts du vendeur
   * (même parti pris qu'en transformation, E4-05).
   */
  useEffect(() => {
    if (documentId === undefined) return
    let current = true
    loadForReturn(documentId)
      .then((source) => {
        if (!current) return
        setDocNumber(source.docNumber)
        setLines(source.lines)
        setReturnable(source.returnable)
      })
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : RETURN_MESSAGES.notFound),
      )
    return () => {
      current = false
    }
  }, [documentId])

  const totals = documentTotals(lines)
  const complete = returnIsComplete(lines, returnable)

  const save = async (): Promise<void> => {
    if (saving || !complete || documentId === undefined) return
    setFailure(null)
    setSaving(true)
    try {
      /*
       * `progress` retient ce qui a déjà abouti : un second appui après une
       * coupure réseau confirme **le même** brouillon, sans en créer un second
       * ni redoubler ses lignes (`saleWrite.ts`).
       */
      const carried: SaleProgress = { ...progress }
      const confirmed = await recordSale({
        lines,
        docType: RETURN_DOC_TYPE,
        sourceDocumentId: documentId,
        ...(reason.trim() === '' ? {} : { notes: reason.trim() }),
        deviceId: installationId(),
        prefix: cachedDevicePrefix(),
        progress: carried,
        onProgress: (next) => {
          Object.assign(carried, next)
          setProgress({ ...carried })
        },
      })
      setIssued(confirmed.docNumber)
      setLines([])
      setProgress({})
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : RETURN_MESSAGES.notSaved)
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="px-4 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <BackLink to="/sale" label="Vente" />
        <h1 className="text-title text-paper-900">
          {docNumber === null ? 'Retour' : `Retour du bon ${docNumber}`}
        </h1>

        {issued !== null && (
          <div className="rounded-card border border-paper-200 bg-white p-4">
            <p role="status" className="text-body text-paper-900">
              {`Retour ${issued} enregistré.`}
            </p>
          </div>
        )}

        {failure !== null && (
          <p role="alert" className="text-body text-red-600">
            {failure}
          </p>
        )}

        <section aria-label="Lignes du retour" className="flex flex-col gap-2">
          <h2 className="text-label text-paper-700">Ce qui revient</h2>
          {lines.length === 0 ? (
            <p className="text-body text-paper-700">
              Aucune ligne. Un retour reprend les articles du bon d’origine.
            </p>
          ) : (
            <ul className="flex flex-col">
              {lines.map((line) => (
                <ReturnLineRow
                  key={line.variantId}
                  line={line}
                  returnable={returnable.get(line.variantId)}
                  over={lineOverReturnable(line, returnable)}
                  onQuantity={(raw) =>
                    setLines((current) => setQuantity(current, line.variantId, raw))
                  }
                  onStep={(delta) =>
                    setLines((current) => stepQuantity(current, line.variantId, delta))
                  }
                  onRemove={() => setLines((current) => removeLine(current, line.variantId))}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Le motif : saisissable, jamais obligatoire (§ 2.6 — on ne barre pas
            la route d'un geste pour un champ). */}
        <div className="flex flex-col gap-2">
          <label htmlFor="return-reason" className="text-label text-paper-700">
            Motif du retour (facultatif)
          </label>
          <input
            id="return-reason"
            type="text"
            dir="auto"
            autoComplete="off"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="h-field rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900 focus-visible:border-ink-600"
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-label text-paper-700">Avoir</span>
            <output aria-label="Avoir" className="tabular text-amount text-paper-900">
              {moneyText(totals.total)}
            </output>
          </div>
          <button
            type="button"
            disabled={!complete || saving}
            onClick={() => void save()}
            className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white disabled:bg-paper-300 disabled:text-paper-700"
          >
            {saving ? 'Enregistrement…' : 'Enregistrer le retour'}
          </button>
        </div>
      </div>
    </main>
  )
}
