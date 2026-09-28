/*
 * La planche d'étiquettes. M1 — E2-06.
 *
 * SPEC § 6, RÈGLE M1-5 : « Code 128 émis par le système, encodant
 * `variant.sku`, pour tout ce qui arrive sans code. » C'est cet écran qui
 * **rend le produit horizontal** — celui qui n'a pas d'EAN fabricant devient
 * scannable comme les autres, et le reste de l'application n'a plus deux cas.
 *
 * Trois choses s'y décident, et la deuxième est la plus lourde :
 *
 *   1. **ce que l'étiquette encode** : le code-barres fabricant s'il existe,
 *      sinon le SKU. L'EAN passe devant — il est déjà sur le carton, et une
 *      douchette doit rendre le même produit qu'on lise l'un ou l'autre ;
 *   2. **l'impression fige le SKU** (`sku_printed_at`). Une étiquette collée
 *      sur un carton doit continuer de désigner la même variante : le SKU cesse
 *      donc de suivre la référence du produit. Seuls les SKU réellement
 *      imprimés se figent — une planche d'EAN n'engage rien ;
 *   3. **un produit sans aucun code reçoit un SKU**, engendré par l'appareil
 *      (`sku.ts`), parce qu'il faut bien encoder quelque chose.
 *
 * SPEC § 2.6 partout : rien ne se réclame. Un produit qu'on ne peut pas
 * étiqueter — ni code, ni lettre d'appareil, ni valeur encodable — se dit en
 * une ligne grise et se laisse là.
 *
 * BRAND-UI : écran de détail, donc un retour vers la fiche produit et aucune
 * barre d'onglets (§ 13) ; l'action principale en bas, au pouce (§ 7) ; libellés
 * au-dessus des champs (§ 8) ; propriétés logiques (§ 9).
 */

import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { BackLink } from '@/components/BackLink'
import { Button } from '@/components/ui/button'
import { Code128, encodeCode128 } from '@/lib/barcode'
import { cachedDevicePrefix } from '@/lib/device'
import { getProduct } from '@/modules/catalogue/products'
import {
  LABELS_PER_SHEET,
  SHEET,
  buildLabels,
  encodedValue,
  sheetCount,
  skusToFreeze,
  type Label,
} from '@/modules/catalogue/labels'
import { assignGeneratedSku } from '@/modules/catalogue/sku'
import { listVariants, markSkuPrinted, type Variant } from '@/modules/catalogue/variants'

const SECONDARY =
  'flex h-button w-full items-center justify-center rounded-button border border-paper-300 bg-white text-body text-ink-700'

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'missing' }
  | { status: 'ready'; name: string; variants: Variant[] }

export function LabelSheetScreen() {
  const { id } = useParams<{ id: string }>()
  const productId = id ?? ''

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [labels, setLabels] = useState<Label[]>([])
  const [printing, setPrinting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // La lettre est retenue sur l'appareil : engendrer un SKU ne demande pas le
  // réseau (SPEC § 2.5). Absente, on n'en engendre aucun, et rien ne le réclame.
  const [prefix] = useState(cachedDevicePrefix)

  const load = useCallback(() => {
    getProduct(productId)
      .then(async (product) => {
        if (product === null) {
          setLoaded({ status: 'missing' })
          return
        }
        const variants = await listVariants(productId)
        setLoaded({ status: 'ready', name: product.name, variants })
        // Une étiquette par variante : le cas courant est un produit, une
        // planche de quelques étiquettes, et le patron corrige le nombre.
        setQuantities(Object.fromEntries(variants.map((variant) => [variant.id, '1'])))
      })
      .catch((error: unknown) =>
        setLoaded({
          status: 'error',
          message: error instanceof Error ? error.message : 'Chargement impossible.',
        }),
      )
  }, [productId])

  useEffect(load, [load])

  const retry = (): void => {
    setLoaded({ status: 'loading' })
    load()
  }

  const quantityOf = (variantId: string): number => {
    const parsed = Number.parseInt(quantities[variantId] ?? '', 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
  }

  const variants = loaded.status === 'ready' ? loaded.variants : []
  const name = loaded.status === 'ready' ? loaded.name : ''

  /*
   * Le compte annoncé avant d'imprimer. Une variante sans aucun code y figure :
   * elle en recevra un à l'impression, à condition que l'appareil ait sa lettre.
   */
  const printable = variants.filter(
    (variant) => encodedValue(variant) !== null || prefix !== null,
  )
  const total = printable.reduce((sum, variant) => sum + quantityOf(variant.id), 0)

  const print = async (): Promise<void> => {
    if (printing || total === 0) return

    setPrinting(true)
    setFailure(null)
    try {
      /*
       * D'abord attribuer les codes manquants : une planche ne s'imprime pas à
       * moitié. Puis figer, puis imprimer — dans cet ordre, parce qu'une
       * étiquette sortie de l'imprimante ne se rattrape pas, tandis qu'une
       * écriture refusée s'annonce avant d'avoir gâché du papier.
       */
      const prepared: Variant[] = []
      for (const variant of variants) {
        if (quantityOf(variant.id) < 1) {
          prepared.push(variant)
          continue
        }
        if (encodedValue(variant) !== null || prefix === null) {
          prepared.push(variant)
          continue
        }
        prepared.push({ ...variant, sku: await assignGeneratedSku(variant.id, prefix) })
      }

      const entries = prepared.map((variant) => ({
        variant,
        name,
        quantity: quantityOf(variant.id),
      }))

      await markSkuPrinted(skusToFreeze(entries))

      setLoaded((current) =>
        current.status === 'ready' ? { ...current, variants: prepared } : current,
      )
      setLabels(buildLabels(entries))
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Impression impossible.')
      setPrinting(false)
    }
  }

  /*
   * L'impression part quand la planche est dans le document, pas avant :
   * `window.print()` photographie la page telle qu'elle est à cet instant, et
   * appelé dans la foulée du clic il imprimerait la page d'avant.
   */
  useEffect(() => {
    if (labels.length === 0) return

    // Le délai zéro laisse le navigateur peindre la planche avant de la
    // photographier : `window.print()` bloque jusqu'à la fermeture du dialogue,
    // et appelé dans le corps de l'effet il imprimerait la page d'avant.
    const timer = window.setTimeout(() => {
      window.print()
      setPrinting(false)
    }, 0)

    return () => window.clearTimeout(timer)
  }, [labels])

  return (
    <>
      <main className="min-h-dvh px-4 pt-6 print:hidden">
        <div className="mx-auto flex w-full max-w-md flex-col gap-6 pb-6">
          <div>
            <BackLink to={`/products/${productId}`} label="Fiche produit" />
            <h1 className="text-title text-paper-900">Étiquettes</h1>
            {loaded.status === 'ready' && <p className="mt-2 text-body text-paper-700">{name}</p>}
          </div>

          {loaded.status === 'loading' && (
            <div aria-busy="true" aria-label="Chargement des étiquettes" className="flex flex-col gap-6">
              {[0, 1].map((n) => (
                <div key={n} className="h-field rounded-field bg-paper-100" />
              ))}
            </div>
          )}

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
              <p className="text-body text-paper-700">Ce produit n’existe plus.</p>
              <Link to="/products" className={SECONDARY}>
                Retour aux produits
              </Link>
            </div>
          )}

          {loaded.status === 'ready' && (
            <>
              <ul className="flex flex-col gap-4">
                {variants.map((variant) => (
                  <LabelRow
                    key={variant.id}
                    variant={variant}
                    prefix={prefix}
                    quantity={quantities[variant.id] ?? ''}
                    onQuantity={(value) => {
                      setFailure(null)
                      setQuantities((current) => ({
                        ...current,
                        [variant.id]: value.replace(/\D/g, '').slice(0, 4),
                      }))
                    }}
                  />
                ))}
              </ul>

              <p className="text-body text-paper-700" role="status">
                {total === 0
                  ? 'Aucune étiquette à imprimer.'
                  : `${total} étiquette${total > 1 ? 's' : ''}, ${sheetCount(total)} feuille${
                      sheetCount(total) > 1 ? 's' : ''
                    } A4 — ${LABELS_PER_SHEET} par feuille.`}
              </p>

              {failure !== null && (
                <p role="alert" className="text-body text-red-600">
                  {failure}
                </p>
              )}

              <div className="sticky bottom-0 -mx-4 border-t border-paper-200 bg-paper-50 px-4 py-4">
                <Button
                  type="button"
                  disabled={printing || total === 0}
                  onClick={() => void print()}
                  className="h-button w-full rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800 disabled:bg-paper-200 disabled:text-paper-700 disabled:opacity-100"
                >
                  {printing ? 'Préparation…' : 'Imprimer la planche'}
                </Button>
              </div>
            </>
          )}
        </div>
      </main>

      <Sheet labels={labels} />
    </>
  )
}

/** Une variante et son nombre d'étiquettes. */
function LabelRow({
  variant,
  prefix,
  quantity,
  onQuantity,
}: {
  variant: Variant
  prefix: string | null
  quantity: string
  onQuantity: (value: string) => void
}) {
  const encoded = encodedValue(variant)
  const inputId = `quantity-${variant.id}`

  /*
   * Ce que la ligne dit du code, sans jamais rien réclamer (SPEC § 2.6) :
   * l'EAN du fabricant, le SKU, celui qui sera attribué, ou le fait qu'il n'y
   * en aura pas — appareil sans lettre, ou valeur que le Code 128 n'encode pas
   * (une référence en arabe, une lettre accentuée).
   */
  const encodable = encoded !== null && encodeCode128(encoded.code) !== null
  const note =
    encoded === null
      ? prefix === null
        ? 'Aucun code. Cet appareil n’a pas encore sa lettre : rien ne sera imprimé pour cette ligne.'
        : 'Aucun code. Un code sera attribué à l’impression.'
      : !encodable
        ? 'Ce code ne s’imprime pas en Code 128.'
        : encoded.isSku
          ? variant.skuPrintedAt === null
            ? `${encoded.code} — ce code sera figé par l’impression.`
            : `${encoded.code} — déjà imprimé.`
          : `${encoded.code} — code-barres du fabricant.`

  return (
    <li className="flex flex-col gap-2 rounded-card border border-paper-200 bg-white p-4">
      <label className="text-label text-paper-700 text-start" htmlFor={inputId}>
        Nombre d’étiquettes
      </label>
      <input
        id={inputId}
        value={quantity}
        inputMode="numeric"
        autoComplete="off"
        onChange={(event) => onQuantity(event.target.value)}
        className="tabular h-field w-full rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900 focus-visible:border-ink-600"
      />
      <p className="text-note text-paper-600">{note}</p>
    </li>
  )
}

/*
 * La planche imprimée.
 *
 * Elle n'existe à l'écran que le temps de l'impression, et seul le média
 * `print` la montre : l'écran garde le formulaire. `@page` met la feuille en A4
 * sans marge — les 3 × 70 mm et 8 × 37 mm de `SHEET` occupent la feuille
 * exactement, et une marge d'imprimante décalerait toutes les étiquettes.
 */
function Sheet({ labels }: { labels: readonly Label[] }) {
  if (labels.length === 0) return null

  return (
    <div className="hidden print:block">
      <style>{`@page { size: A4; margin: 0; }`}</style>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${SHEET.columns}, ${SHEET.labelWidthMm}mm)`,
          gridAutoRows: `${SHEET.labelHeightMm}mm`,
        }}
      >
        {labels.map((label, index) => (
          <div
            // Une même variante paraît plusieurs fois : l'indice fait la clé.
            key={`${label.variantId}-${index}`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '1mm',
              overflow: 'hidden',
              padding: '2mm',
              breakInside: 'avoid',
            }}
          >
            <span
              style={{
                fontSize: '3mm',
                lineHeight: 1.2,
                maxHeight: '7mm',
                overflow: 'hidden',
                textAlign: 'center',
              }}
            >
              {label.name}
            </span>
            <Code128 value={label.code} widthMm={60} heightMm={16} />
            {/* Le code en clair : une douchette en panne, un code abîmé, et il
                reste lisible à l'œil. Chiffres latins (BRAND-UI § 9). */}
            <span style={{ fontSize: '3mm', letterSpacing: '0.2mm' }} dir="ltr">
              {label.code}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
