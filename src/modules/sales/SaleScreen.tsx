/*
 * L'écran de vente — E4-03. RÈGLE M3-6, point de rupture n° 2 (SPEC § 10).
 *
 * « Bon de 10 lignes en moins de 90 secondes », debout, au doigt, d'une seule
 * main. Chaque tap superflu est payé mille fois par jour, et c'est la seule
 * mesure qui compte ici : tout le reste de cet écran en découle.
 *
 * **Trois entrées, une seule ligne d'arrivée** (RÈGLE M3-6) :
 *
 *   — le **scan** : la caméra remplit le champ, et un code-barres qui désigne
 *     une seule variante ajoute la ligne sans un geste de plus ;
 *   — la **référence**, tapée : `public.search_products()` sert la recherche,
 *     tolérante aux fautes, en arabe comme en français, sur référence partielle
 *     (SPEC § 6) — l'écran n'en réimplémente rien ;
 *   — la **grille photo**, qu'on parcourt quand on ne sait pas écrire le nom.
 *
 * Pas d'écran scan-only : la marchandise n'est pas toujours à portée de main.
 *
 * **La quantité se tape.** Un grossiste vend 24, 48 ou 120 pièces : le champ
 * est au clavier numérique, prérempli à 1, et sélectionné au toucher pour que
 * la frappe le remplace. Les `−` / `+` restent pour l'ajustement d'une unité.
 *
 * **Le prix se résout tout seul** et suit la quantité (`sale.ts`). Un prix que
 * la grille ne donne pas se tape (SPEC § 2.6, rien ne bloque une vente) ; un
 * prix qu'elle donne se **force** d'un tap sur le prix lui-même — E4-04 —, et
 * le forçage survit alors au changement de quantité. Le retour au palier est un
 * bouton : un forçage qu'on ne sait pas défaire se répare en supprimant la
 * ligne, c'est-à-dire en la ressaisissant.
 *
 * **L'incitation au palier suivant** (RÈGLE M1-4, « +2 → 12,00 DH ») s'affiche
 * sous la ligne : c'est une fonction produit, pas une décoration, et elle se
 * lit là où le vendeur regarde déjà la quantité qu'il vient de taper.
 *
 * **Le plancher** se refuse ici *tôt*, sous les doigts : le bon ne peut pas
 * partir avec une ligne sous `floor_price` quand celui qui vend n'a pas
 * `override_price_below_floor`. Ce qui protège est `merx.require_floor_price()`,
 * en base — un écran se contourne d'une requête (E1-02).
 *
 * **Un stock à zéro n'empêche rien** (RÈGLE M2-3) : la quantité en stock est un
 * repère affiché à côté de l'article, jamais une condition.
 *
 * **Le client n'est pas ici** : la table `client` et `sale_document.client_id`
 * naissent en E6-01, qui porte déjà le critère « création possible depuis
 * l'écran de vente, sans le quitter ». Un bouton qui ne mènerait à rien
 * apprendrait un geste faux.
 *
 * **Trois types de document** (E4-05) : devis, commande, bon de livraison. Le
 * bon par défaut (RÈGLE M3-1), et le choix se fait avant d'enregistrer — c'est
 * la seule façon qu'un devis existe, et donc que la chaîne de la RÈGLE M3-4
 * commence quelque part. Seule la confirmation d'un **bon** décrémente le stock
 * (RÈGLE M3-5), et c'est la base qui le fait.
 *
 * **La transformation** (`/sale/from/:documentId`) reprend les lignes d'un
 * document confirmé dans ce même écran : elles s'y modifient comme celles qu'on
 * vient de taper, et l'original n'est pas touché — ce qui part est un document
 * neuf qui le désigne (`transform.ts`). Le prix repris n'est pas un forçage de
 * celui qui transforme : voir l'en-tête de `transform.ts`.
 *
 * Écran de premier niveau : il porte la barre d'onglets et aucun retour
 * (BRAND-UI § 13). En transformation, c'est un écran de détail : un retour vers
 * Vente, et aucune barre. Les actions sont dans le tiers bas, au pouce (§ 7) ;
 * le total est en *Chiffre principal*, en chiffres tabulaires (§ 6).
 */

import { Minus, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'

import { BackLink } from '@/components/BackLink'
import { useCan } from '@/lib/auth/useCan'
import { ScanButton } from '@/lib/barcode'
import { moneyText, quantityText } from '@/lib/decimal'
import { cachedDevicePrefix, installationId } from '@/lib/device'
import {
  SEARCH_DELAY_MS,
  SEARCH_LIMIT,
  latestOnly,
  nextBreakNudge,
  priceBasisFor,
  searchProducts,
  signedPhotoUrls,
  type SearchHit,
} from '@/modules/catalogue'
import { documentTotals, lineTotalText } from '@/modules/sales/amounts'
import type { SaleDocType } from '@/modules/sales/documentNumber'
import {
  PRICE_MESSAGES,
  addArticle,
  forceUnitPrice,
  lineBelowFloor,
  releaseUnitPrice,
  removeLine,
  saleIsComplete,
  setQuantity,
  setUnitPrice,
  stepQuantity,
  type SaleLine,
} from '@/modules/sales/sale'
import { SALE_MESSAGES, SALE_DOC_TYPE, recordSale, type SaleProgress } from '@/modules/sales/saleWrite'
import { loadForTransformation } from '@/modules/sales/transform'
import { Quantity, stockLevelsFor, type StockLevel } from '@/modules/stock'

type View = 'list' | 'grid'

/* Le choix de présentation appartient à l'appareil, pas au compte (E2-04). */
export const SALE_VIEW_STORAGE_KEY = 'merx.sale.view'

function storedView(): View {
  try {
    return window.localStorage.getItem(SALE_VIEW_STORAGE_KEY) === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

function storeView(view: View): void {
  try {
    window.localStorage.setItem(SALE_VIEW_STORAGE_KEY, view)
  } catch {
    // Un stockage refusé ne coûte que le souvenir du choix.
  }
}

type Results =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; query: string; hits: SearchHit[] }

/* La référence qu'on lit sous le nom : celle du produit, ou à défaut le SKU. */
const referenceOf = (hit: SearchHit): string | null => hit.code ?? hit.sku

function Thumbnail({
  url,
  name,
  size,
}: {
  url: string | undefined
  name: string
  size: 'row' | 'card'
}) {
  const box = size === 'row' ? 'size-12 shrink-0' : 'aspect-square w-full'
  if (url !== undefined) {
    return (
      <img
        src={url}
        alt=""
        className={`${box} rounded-field border border-paper-200 object-cover`}
      />
    )
  }
  return (
    <div
      aria-hidden="true"
      className={`${box} flex items-center justify-center rounded-field bg-paper-100 text-paper-700 ${
        size === 'row' ? 'text-subtitle' : 'text-title'
      }`}
    >
      {name.trim().charAt(0).toUpperCase()}
    </div>
  )
}

/*
 * Ce que chaque type de document s'appelle à l'écran. Le genre change la phrase
 * de confirmation — « commande enregistrée », « bon enregistré » —, donc elle
 * est écrite en entier plutôt que recomposée : une phrase fausse se lit, et
 * personne ne relit un gabarit.
 */
const DOC_TYPE_LABELS: Readonly<
  Record<SaleDocType, { short: string; save: string; saved: (docNumber: string) => string }>
> = {
  quote: {
    short: 'Devis',
    save: 'Enregistrer le devis',
    saved: (docNumber) => `Devis ${docNumber} enregistré.`,
  },
  order: {
    short: 'Commande',
    save: 'Enregistrer la commande',
    saved: (docNumber) => `Commande ${docNumber} enregistrée.`,
  },
  delivery_note: {
    short: 'Bon',
    save: 'Enregistrer le bon',
    saved: (docNumber) => `Bon ${docNumber} enregistré.`,
  },
  /*
   * Le retour n'est pas un choix de cet écran-ci — il se prend sur le bon
   * d'origine (`ReturnScreen`, E4-06) et `DocTypeSwitch` n'en propose que
   * trois. L'étiquette est là parce que le type en a quatre, et elle dit la
   * vérité si quelque chose amenait un retour jusqu'ici.
   */
  return: {
    short: 'Retour',
    save: 'Enregistrer le retour',
    saved: (docNumber) => `Retour ${docNumber} enregistré.`,
  },
}

/*
 * Le choix du type, sur le patron de `ViewSwitch` : BRAND-UI § 8 ne connaît que
 * trois variantes de bouton, et aucune ne dit « choix segmenté ». Un groupe de
 * boutons primaire/secondaire, dont l'état se lit par `aria-pressed`, est ce que
 * l'écran emploie déjà pour la présentation des produits.
 */
function DocTypeSwitch({
  docType,
  onChange,
}: {
  docType: SaleDocType
  onChange: (docType: SaleDocType) => void
}) {
  const options: readonly SaleDocType[] = ['quote', 'order', 'delivery_note']
  return (
    <div role="group" aria-label="Type de document" className="flex gap-2">
      {options.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={docType === value}
          onClick={() => onChange(value)}
          className={
            docType === value
              ? 'h-touch flex-1 rounded-button bg-ink-600 px-4 text-body text-white'
              : 'h-touch flex-1 rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700'
          }
        >
          {DOC_TYPE_LABELS[value].short}
        </button>
      ))}
    </div>
  )
}

function ViewSwitch({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const options: ReadonlyArray<readonly [View, string]> = [
    ['list', 'Liste'],
    ['grid', 'Grille photo'],
  ]
  return (
    <div role="group" aria-label="Présentation des produits" className="flex gap-2">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onChange(value)}
          className={
            view === value
              ? 'h-touch flex-1 rounded-button bg-ink-600 px-4 text-body text-white'
              : 'h-touch flex-1 rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700'
          }
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Les lignes du bon                                                           */
/* -------------------------------------------------------------------------- */

interface LineProps {
  line: SaleLine
  level: StockLevel | undefined
  photoUrl: string | undefined
  /** `override_price` — § 3.1. Sans elle, le prix du palier ne se touche pas. */
  canForce: boolean
  /** `override_price_below_floor`, pour dire pourquoi le bon ne part pas. */
  canGoBelowFloor: boolean
  onQuantity: (raw: string) => void
  onStep: (delta: number) => void
  onPrice: (raw: string) => void
  onForce: (raw: string) => void
  onRelease: () => void
  onRemove: () => void
}

function SaleLineRow({
  line,
  level,
  photoUrl,
  canForce,
  canGoBelowFloor,
  onQuantity,
  onStep,
  onPrice,
  onForce,
  onRelease,
  onRemove,
}: LineProps) {
  const total = lineTotalText(line.quantity, line.unitPrice)
  const quantityId = `qty-${line.variantId}`
  const priceId = `price-${line.variantId}`

  /*
   * Le champ de forçage s'ouvre au tap sur le prix et reste ouvert tant que la
   * ligne vit : le refermer sous les doigts de quelqu'un qui corrige sa frappe
   * lui coûterait un tap de plus pour le rouvrir.
   */
  const [forcing, setForcing] = useState(false)
  const typed = line.priceSource === 'manual' || forcing
  const forced = line.overriddenPrice !== null
  const nudge = nextBreakNudge(
    line.breaks,
    line.quantity.replace(',', '.'),
    line.unitPrice === '' ? null : line.unitPrice.replace(',', '.'),
  )
  const belowFloor = lineBelowFloor(line)

  return (
    <li className="flex flex-col gap-2 border-b border-paper-200 py-3">
      <div className="flex items-center gap-4">
        <Thumbnail url={photoUrl} name={line.name} size="row" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-subtitle text-paper-900">{line.name}</p>
          {line.reference !== null && (
            <p className="tabular truncate text-body text-paper-700">{line.reference}</p>
          )}
        </div>
        {/* Un stock à zéro, ou négatif, est un repère — jamais un blocage. */}
        {level !== undefined && (
          <span className="shrink-0">
            <Quantity level={level} />
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex items-end gap-2">
          <button
            type="button"
            aria-label={`Une pièce de moins — ${line.name}`}
            onClick={() => onStep(-1)}
            className="flex size-touch items-center justify-center rounded-button border border-paper-300 bg-white text-ink-700"
          >
            <Minus aria-hidden="true" className="size-6" />
          </button>
          <div className="flex flex-col gap-1">
            <label htmlFor={quantityId} className="text-label text-paper-700">
              Quantité
            </label>
            {/*
             * `inputMode="decimal"` : le clavier numérique s'ouvre sans que le
             * vendeur le cherche. `onFocus` sélectionne tout — taper « 120 »
             * remplace le « 1 » au lieu de produire « 1120 ».
             */}
            <input
              id={quantityId}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={line.quantity}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => onQuantity(event.target.value)}
              className="tabular h-field w-24 rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900 focus-visible:border-ink-600"
            />
          </div>
          <button
            type="button"
            aria-label={`Une pièce de plus — ${line.name}`}
            onClick={() => onStep(1)}
            className="flex size-touch items-center justify-center rounded-button border border-paper-300 bg-white text-ink-700"
          >
            <Plus aria-hidden="true" className="size-6" />
          </button>
        </div>

        {/*
         * Trois états d'un même emplacement : le prix du palier, qu'un tap force
         * (E4-04) ; le champ, quand il est forcé ou que la grille n'a rien donné
         * (E4-03, SPEC § 2.6) ; et le prix nu, pour qui n'a pas `override_price`
         * — la capacité est à § 3.1 pour les deux rôles, donc ce dernier cas ne
         * se rencontre qu'avec un jeton sans rôle.
         */}
        {!typed ? (
          canForce ? (
            <div className="flex flex-col gap-1">
              <span className="text-label text-paper-700">Prix unitaire</span>
              <button
                type="button"
                aria-label={`Forcer le prix — ${line.name}`}
                onClick={() => setForcing(true)}
                className="tabular flex h-field items-center rounded-field border border-dashed border-paper-300 bg-white px-4 text-body text-paper-900"
              >
                {moneyText(line.unitPrice.replace(',', '.'))}
              </button>
            </div>
          ) : (
            <p className="flex flex-col gap-1">
              <span className="text-label text-paper-700">Prix unitaire</span>
              <span className="tabular flex h-field items-center px-4 text-body text-paper-900">
                {moneyText(line.unitPrice.replace(',', '.'))}
              </span>
            </p>
          )
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor={priceId} className="text-label text-paper-700">
              Prix unitaire (DH)
            </label>
            <input
              id={priceId}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={line.unitPrice}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => (forcing ? onForce : onPrice)(event.target.value)}
              className="tabular h-field w-28 rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900 focus-visible:border-ink-600"
            />
          </div>
        )}

        <p className="tabular ms-auto text-subtitle text-paper-900">
          {total === null ? '—' : moneyText(total)}
        </p>

        <button
          type="button"
          aria-label={`Retirer du bon — ${line.name}`}
          onClick={onRemove}
          className="flex size-touch items-center justify-center rounded-button border border-red-500 bg-white text-red-600"
        >
          <Trash2 aria-hidden="true" className="size-6" />
        </button>
      </div>

      {/*
       * RÈGLE M1-4. « +2 → 12,00 DH » : ce qu'il manque, et ce que ça donne.
       * Sous la ligne, là où le vendeur regarde la quantité qu'il vient de
       * taper.
       */}
      {nudge !== null && (
        <p className="tabular text-body text-ink-700">
          +{quantityText(nudge.missing)} → {moneyText(nudge.unitPrice)}
        </p>
      )}

      {forced && line.overriddenPrice !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-body text-paper-700">
            Prix forcé — palier à{' '}
            <span className="tabular">{moneyText(line.overriddenPrice)}</span>.
          </p>
          <button
            type="button"
            aria-label={`Rétablir le prix du palier — ${line.name}`}
            onClick={() => {
              setForcing(false)
              onRelease()
            }}
            className="h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
          >
            Rétablir le palier
          </button>
        </div>
      )}

      {/*
       * Le plancher. Celui qui a le droit d'y descendre ne lit rien : ce serait
       * un avertissement sur une vente légitime (SPEC § 2.6).
       */}
      {belowFloor && !canGoBelowFloor && (
        <p role="alert" className="text-body text-red-600">
          {PRICE_MESSAGES.belowFloor}
        </p>
      )}
    </li>
  )
}

/* -------------------------------------------------------------------------- */
/* L'écran                                                                     */
/* -------------------------------------------------------------------------- */

export function SaleScreen() {
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>(storedView)
  const [results, setResults] = useState<Results>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [photos, setPhotos] = useState<Map<string, string>>(new Map())
  const [levels, setLevels] = useState<Map<string, StockLevel>>(new Map())

  const canForce = useCan('override_price')
  const canGoBelowFloor = useCan('override_price_below_floor')

  const [lines, setLines] = useState<SaleLine[]>([])
  const [progress, setProgress] = useState<SaleProgress>({})
  const [docType, setDocType] = useState<SaleDocType>(SALE_DOC_TYPE)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [issued, setIssued] = useState<string | null>(null)

  /*
   * La transformation. `documentId` vient de la route `/sale/from/:documentId` :
   * absent, cet écran est l'écran de vente ordinaire et rien ici ne part.
   *
   * Les lignes reprises entrent **une fois**, à l'arrivée : ensuite elles
   * appartiennent à la saisie, et une relecture les écraserait sous les doigts
   * du vendeur. Une lecture en échec laisse l'écran utilisable — il dit ce qui
   * n'a pas marché, et le vendeur peut saisir le bon à la main plutôt que de
   * rester devant une impasse (SPEC § 2.6).
   */
  const { documentId } = useParams<{ documentId: string }>()
  const [source, setSource] = useState<{ documentId: string; docNumber: string | null } | null>(
    null,
  )

  useEffect(() => {
    if (documentId === undefined) return
    let current = true
    loadForTransformation(documentId)
      .then((loaded) => {
        if (!current) return
        setSource({ documentId: loaded.documentId, docNumber: loaded.docNumber })
        setDocType(loaded.target ?? SALE_DOC_TYPE)
        setLines(loaded.lines)
      })
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : SALE_MESSAGES.notSaved),
      )
    return () => {
      current = false
    }
  }, [documentId])

  const search = useMemo(() => latestOnly(searchProducts), [])

  /*
   * Une recherche par saisie, après SEARCH_DELAY_MS sans frappe — les résultats
   * précédents restent affichés pendant la frappe (E2-04). Les photos et les
   * quantités en stock viennent après coup : elles ne retiennent pas la liste,
   * et le vendeur peut déjà toucher la ligne qu'il cherchait.
   */
  useEffect(() => {
    const delay = query.trim() === '' ? 0 : SEARCH_DELAY_MS
    const timer = window.setTimeout(() => {
      search(query)
        .then(async (outcome) => {
          if (!outcome.current) return
          const hits = outcome.value
          setResults({ status: 'loaded', query: query.trim(), hits })

          const paths = [
            ...new Set(hits.map((hit) => hit.photoPath).filter((path): path is string => path !== null)),
          ]
          const [signed, read] = await Promise.all([
            signedPhotoUrls(paths),
            stockLevelsFor(hits.map((hit) => hit.variantId)),
          ])
          setPhotos((current) => new Map([...current, ...signed]))
          setLevels((current) => new Map([...current, ...read]))
        })
        .catch((error: unknown) =>
          setResults({
            status: 'error',
            message: error instanceof Error ? error.message : 'Recherche impossible.',
          }),
        )
    }, delay)

    return () => window.clearTimeout(timer)
  }, [query, attempt, search])

  const retry = useCallback(() => {
    setResults({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  const chooseView = (next: View): void => {
    setView(next)
    storeView(next)
  }

  /*
   * L'ajout d'une ligne, par n'importe laquelle des trois entrées. Les paliers
   * de la variante et son plancher sont lus ici, une fois : la résolution du
   * prix se rejoue ensuite sans rien redemander au réseau.
   *
   * Une lecture des paliers en échec n'empêche pas la vente : la ligne entre
   * sans prix automatique, et le vendeur le saisit (SPEC § 2.6). Elle entre
   * alors **sans plancher connu** — l'écran ne peut plus refuser tôt, et c'est
   * `merx.require_floor_price()` qui tranchera à l'enregistrement. Un écran qui
   * bloquerait une vente faute d'avoir pu lire une colonne serait l'inverse de
   * § 2.6.
   */
  const addHit = useCallback(async (hit: SearchHit): Promise<void> => {
    setFailure(null)
    setIssued(null)
    const article = {
      variantId: hit.variantId,
      productId: hit.productId,
      name: hit.name,
      reference: referenceOf(hit),
      photoPath: hit.photoPath,
    }

    let basis: Awaited<ReturnType<typeof priceBasisFor>> | null = null
    try {
      basis = await priceBasisFor([hit.variantId])
    } catch {
      setFailure('Les prix de cet article n’ont pas pu être lus. Saisissez le prix de la ligne.')
    }

    setLines((current) =>
      addArticle(
        current,
        article,
        basis?.get(hit.variantId) ?? { breaks: [], floorPrice: null },
      ),
    )
    setQuery('')
  }, [])

  /*
   * Le scan : un code-barres qui désigne une seule variante entre au bon sans
   * un geste de plus — c'est ce que le comptoir attend. Sinon le code reste
   * dans le champ, et la recherche prend la suite comme pour une saisie.
   */
  const onScan = useCallback(
    async (code: string): Promise<void> => {
      setQuery(code)
      try {
        const hits = await searchProducts(code)
        const exact = hits.filter((hit) => hit.barcode === code)
        if (exact.length === 1) await addHit(exact[0]!)
      } catch {
        // La recherche du champ dira l'échec : rien à ajouter ici.
      }
    },
    [addHit],
  )

  const totals = documentTotals(lines)
  const complete = saleIsComplete(lines, canGoBelowFloor)

  const save = async (): Promise<void> => {
    if (saving || !complete) return
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
        docType,
        ...(source === null ? {} : { sourceDocumentId: source.documentId }),
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
      setFailure(error instanceof Error ? error.message : SALE_MESSAGES.notSaved)
    } finally {
      setSaving(false)
    }
  }

  const newSale = (): void => {
    setIssued(null)
    setFailure(null)
    setQuery('')
  }

  return (
    <main className="px-4 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        {/* En transformation, c'est un écran de détail : un retour, pas
            d'onglet (BRAND-UI § 13). Le titre nomme le document d'origine dès
            qu'il est lu — avant, il dit ce que l'écran est en train de faire,
            plutôt que de laisser un titre vide le temps du réseau. */}
        {documentId !== undefined && <BackLink to="/sale" label="Vente" />}
        <h1 className="text-title text-paper-900">
          {documentId === undefined
            ? 'Vente'
            : source?.docNumber === null || source === null
              ? 'Transformer un document'
              : `Transformer ${source.docNumber}`}
        </h1>

        {issued !== null && (
          <div className="flex flex-col items-start gap-2 rounded-card border border-paper-200 bg-white p-4">
            <p role="status" className="text-body text-paper-900">
              {DOC_TYPE_LABELS[docType].saved(issued)}
            </p>
            <button
              type="button"
              onClick={newSale}
              className="h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
            >
              Nouveau bon
            </button>
          </div>
        )}

        {failure !== null && (
          <p role="alert" className="text-body text-red-600">
            {failure}
          </p>
        )}

        {/* Le type de document, avant tout le reste : c'est lui qui décide ce
            que « Enregistrer » veut dire, et seul le bon fera bouger le stock
            (RÈGLE M3-5). */}
        <DocTypeSwitch docType={docType} onChange={setDocType} />

        {/* Les trois entrées. Le champ et le scan nourrissent la même liste. */}
        <div className="flex flex-col gap-2">
          <label htmlFor="sale-search" className="text-label text-paper-700">
            Rechercher ou scanner un produit
          </label>
          <input
            id="sale-search"
            type="search"
            dir="auto"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-field rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900 focus-visible:border-ink-600"
          />
          <ScanButton label="Scanner un code-barres" onScan={(code) => void onScan(code)} />
        </div>

        <ViewSwitch view={view} onChange={chooseView} />

        {results.status === 'loading' && (
          <div aria-busy="true" aria-label="Chargement des produits" className="flex flex-col">
            {[0, 1, 2].map((n) => (
              <div key={n} className="flex h-row items-center gap-4 border-b border-paper-200">
                <div className="size-12 shrink-0 rounded-field bg-paper-100" />
                <div className="h-4 flex-1 rounded-field bg-paper-100" />
              </div>
            ))}
          </div>
        )}

        {results.status === 'error' && (
          <div className="flex flex-col items-start gap-4 rounded-card border border-red-500 bg-red-100 p-4">
            <p role="alert" className="text-body text-red-700">
              {results.message}
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

        {results.status === 'loaded' && results.hits.length === 0 && (
          <div className="rounded-card border border-paper-200 bg-white p-6">
            <p className="text-body text-paper-700">
              {results.query !== ''
                ? `Aucun produit ne correspond à « ${results.query} ».`
                : 'Aucun produit. Importez votre catalogue depuis l’onglet Produits.'}
            </p>
          </div>
        )}

        {results.status === 'loaded' && results.hits.length > 0 && (
          <>
            <h2 className="text-label text-paper-700">Ajouter au bon</h2>
            {view === 'list' ? (
              <ul className="flex flex-col">
                {results.hits.map((hit) => (
                  <li key={hit.variantId} className="border-b border-paper-200">
                    <button
                      type="button"
                      aria-label={`Ajouter au bon — ${hit.name}`}
                      onClick={() => void addHit(hit)}
                      className="flex min-h-row w-full items-center gap-4 py-2 text-start"
                    >
                      <Thumbnail
                        url={hit.photoPath === null ? undefined : photos.get(hit.photoPath)}
                        name={hit.name}
                        size="row"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-subtitle text-paper-900">
                          {hit.name}
                        </span>
                        {referenceOf(hit) !== null && (
                          <span className="tabular block truncate text-body text-paper-700">
                            {referenceOf(hit)}
                          </span>
                        )}
                      </span>
                      {levels.get(hit.variantId) !== undefined && (
                        <span className="shrink-0">
                          <Quantity level={levels.get(hit.variantId)!} />
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {results.hits.map((hit) => (
                  <li key={hit.variantId} className="rounded-card border border-paper-200 bg-white">
                    <button
                      type="button"
                      aria-label={`Ajouter au bon — ${hit.name}`}
                      onClick={() => void addHit(hit)}
                      className="flex h-full w-full flex-col gap-2 p-2 text-start"
                    >
                      <Thumbnail
                        url={hit.photoPath === null ? undefined : photos.get(hit.photoPath)}
                        name={hit.name}
                        size="card"
                      />
                      <span className="line-clamp-2 text-body text-paper-900">{hit.name}</span>
                      {levels.get(hit.variantId) !== undefined && (
                        <Quantity level={levels.get(hit.variantId)!} />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {results.hits.length === SEARCH_LIMIT && (
              <p className="text-body text-paper-700">
                {results.query === ''
                  ? `Les ${SEARCH_LIMIT} premiers produits, par ordre alphabétique. Tapez ou scannez pour trouver.`
                  : `Les ${SEARCH_LIMIT} meilleurs résultats. Précisez la recherche pour affiner.`}
              </p>
            )}
          </>
        )}

        {/* Le bon lui-même. Vide, il dit par où commencer (BRAND-UI § 6). */}
        <section aria-label="Lignes du bon" className="flex flex-col gap-2">
          <h2 className="text-label text-paper-700">Le bon</h2>
          {lines.length === 0 ? (
            <p className="text-body text-paper-700">
              Aucune ligne. Scannez un article, tapez sa référence, ou touchez-le dans la grille.
            </p>
          ) : (
            <ul className="flex flex-col">
              {lines.map((line) => (
                <SaleLineRow
                  key={line.variantId}
                  line={line}
                  level={levels.get(line.variantId)}
                  photoUrl={line.photoPath === null ? undefined : photos.get(line.photoPath)}
                  canForce={canForce}
                  canGoBelowFloor={canGoBelowFloor}
                  onQuantity={(raw) =>
                    setLines((current) => setQuantity(current, line.variantId, raw))
                  }
                  onStep={(delta) =>
                    setLines((current) => stepQuantity(current, line.variantId, delta))
                  }
                  onPrice={(raw) => setLines((current) => setUnitPrice(current, line.variantId, raw))}
                  onForce={(raw) =>
                    setLines((current) => forceUnitPrice(current, line.variantId, raw))
                  }
                  onRelease={() =>
                    setLines((current) => releaseUnitPrice(current, line.variantId))
                  }
                  onRemove={() => setLines((current) => removeLine(current, line.variantId))}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Le tiers bas : le total, puis l'action (BRAND-UI § 7). */}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-label text-paper-700">Total</span>
            <output aria-label="Total" className="tabular text-amount text-paper-900">
              {moneyText(totals.total)}
            </output>
          </div>
          <button
            type="button"
            disabled={!complete || saving}
            onClick={() => void save()}
            className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white disabled:bg-paper-300 disabled:text-paper-700"
          >
            {saving ? 'Enregistrement…' : DOC_TYPE_LABELS[docType].save}
          </button>
        </div>
      </div>
    </main>
  )
}
