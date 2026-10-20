/*
 * Le retour d'un bon — E4-06. SPEC § 8, RÈGLES M3-9 et M3-2.
 *
 * « Enregistrer un retour, afin que le stock et le compte du client soient
 * justes. » Un retour est un document de vente comme un autre — quatrième
 * `doc_type`, même gel, même numérotation locale (`RT-A-26-00001`), même
 * filiation, même annulation —, et ce fichier tient les deux choses qui ne
 * sont qu'à lui : d'où viennent ses lignes, et jusqu'où elles peuvent aller.
 *
 * ----------------------------------------------------------------------------
 * **On ne rend pas plus que ce qui a été livré**, et ce n'est pas la même
 * chose que le reste à livrer d'E4-05.
 *
 * Là-bas, rien ne compare les quantités d'un enfant à celles de son parent : une
 * commande de 100 peut donner deux bons de 100, parce qu'un bon de trop est une
 * erreur de gestion qui se voit sur le papier. Ici l'excès **crée** deux choses
 * à partir de rien — du stock, et un avoir —, donc il est refusé.
 *
 * Le registre est tenu **par variante**, retours précédents déduits, et les
 * retours qui comptent sont ceux qui ont vécu : `confirmed` ou `delivered`. Pas
 * les brouillons — un retour abandonné bloquerait le bon pour toujours ; pas les
 * annulés — leur stock est reparti.
 *
 * Et l'écran n'est **pas** ce qui le tient : `merx.require_returnable_quantity()`
 * le tient, à la confirmation, sous un verrou qui empêche deux retours du même
 * bon de se croiser. Ce fichier-ci refuse **tôt**, sous les doigts du vendeur,
 * avec sa propre phrase — celle de la base ne se lit que lorsque quelque chose a
 * parlé à PostgREST sans passer par ici (CLAUDE.md, deux gardes sur le même
 * chemin).
 *
 * ----------------------------------------------------------------------------
 * **Le prix d'une ligne de retour est celui du bon, et la grille ne parle
 * jamais.**
 *
 * C'est ce que le client a payé, donc c'est ce qu'on lui rend : les lignes
 * entrent avec `breaks: []` et `floorPrice: null`, si bien qu'un changement de
 * quantité ne rejoue aucune résolution (`priced()` garde le prix d'une ligne
 * `manual`) et qu'aucun plancher ne s'y oppose. La base tient le même
 * arbitrage — `merx.require_floor_price()` sort tôt sur un retour (E4-06) : le
 * plancher est un garde de vente, pas un garde de remboursement.
 *
 * `priceSource` est `manual` avec `overriddenPrice` **nul** : le prix vient d'un
 * papier, pas de la grille, et ce n'est pas un forçage — donc aucune entrée
 * `price_override` au journal (RÈGLE M8-1), ce qui est juste, personne n'ayant
 * forcé quoi que ce soit. Même lecture que les lignes reprises d'une
 * transformation (`transform.ts`).
 *
 * **Une ligne par variante**, comme partout dans ce module. Un bon porte deux
 * lignes de la même variante seulement s'il a été écrit par l'API — l'écran de
 * vente fusionne (`addArticle`) — et dans ce cas la ligne de retour prend le
 * **plus bas** des prix : l'avoir ne dépasse alors jamais ce qui a été facturé,
 * donc la branche « avoir » du garde ne peut pas refuser un retour total
 * légitime. Limite écrite plutôt que tue : ce bon-là se rembourse au prix le
 * plus bas des deux.
 *
 * ----------------------------------------------------------------------------
 * **Ce qui n'est pas ici : l'écriture au crédit du client.** `client_ledger_entry`
 * naît en E6-02, qui porte déjà le critère mot pour mot, et
 * `sale_document.client_id` en E6-01 : un retour n'a aujourd'hui aucun client à
 * créditer. Même traitement que la sélection du client en E4-03.
 */

import { MONEY_SCALE, QUANTITY_SCALE, inputText, parseDecimal, toSqlDecimal } from '@/lib/decimal'
import { supabase } from '@/lib/supabase'
import type { SaleDocType } from '@/modules/sales/documentNumber'
import type { SaleLine } from '@/modules/sales/sale'

/** Le type de document qu'un retour produit — quatrième `doc_type`, E4-06. */
export const RETURN_DOC_TYPE: SaleDocType = 'return'

export const RETURN_MESSAGES = {
  notFound: 'Ce document n’existe plus, ou ce compte n’a pas le droit de le lire.',
  /*
   * Les quatre refus de l'écran. Aucun n'est la phrase de la base : celle du
   * `check` et celle du garde de chaîne ne se lisent que lorsqu'on a écrit sans
   * passer par ici.
   */
  notDeliveryNote: 'Seul un bon de livraison se retourne : un devis ou une commande n’a rien livré.',
  draft: 'Ce bon est encore un brouillon : rien n’a été livré.',
  cancelled: 'Ce bon est annulé : il n’y a rien à retourner.',
  nothingLeft: 'Tout ce que ce bon a livré a déjà été retourné.',
  /** Le refus d'une ligne, par le registre — la phrase de l'écran. */
  overReturnable: (left: string): string =>
    `Ce bon n’a livré que ${left} — on ne rend pas plus que ce qui est sorti.`,
  notSaved: 'Le retour n’a pas pu être enregistré.',
} as const

/** Le bon d'origine, tel que l'écran de retour le présente. */
export interface ReturnSource {
  documentId: string
  docNumber: string | null
  /** Une ligne par variante, à la quantité encore retournable. */
  lines: SaleLine[]
  /** Ce qui reste retournable par variante, en texte de champ. */
  returnable: Map<string, string>
}

interface LineRow {
  variant_id: string
  quantity: string
  unit_price: string
  line_total: string
  variant: {
    sku: string | null
    product: {
      id: string
      name_fr: string
      code: string | null
      photo_url: string | null
    } | null
  } | null
}

const LINE_COLUMNS =
  'sale_line(variant_id, quantity::text, unit_price::text, line_total::text,' +
  ' variant!inner(sku, product!inner(id, name_fr, code, photo_url)))'

/** Les quantités d'une liste de lignes, additionnées par variante. */
function sumByVariant(rows: readonly { variant_id: string; quantity: string }[]): Map<string, bigint> {
  const totals = new Map<string, bigint>()
  for (const row of rows) {
    const quantity = parseDecimal(row.quantity, QUANTITY_SCALE)
    if (quantity === null) continue
    totals.set(row.variant_id, (totals.get(row.variant_id) ?? 0n) + quantity)
  }
  return totals
}

/**
 * Lit le bon d'origine et rend les lignes du retour, à la quantité encore
 * retournable.
 *
 * Deux lectures : le bon avec ses lignes, puis les retours déjà enregistrés sur
 * lui. Aucune lecture de la grille de prix — elle n'a pas la parole ici.
 */
export async function loadForReturn(documentId: string): Promise<ReturnSource> {
  const [origin, previous] = await Promise.all([
    supabase
      .from('sale_document')
      .select(`id, doc_type, doc_number, status, ${LINE_COLUMNS}`)
      .eq('id', documentId)
      .maybeSingle(),
    supabase
      .from('sale_document')
      .select('id, status, sale_line(variant_id, quantity::text)')
      .eq('source_document_id', documentId)
      .eq('doc_type', RETURN_DOC_TYPE)
      .in('status', ['confirmed', 'delivered']),
  ])

  if (origin.error !== null) throw new Error(origin.error.message)
  if (previous.error !== null) throw new Error(previous.error.message)
  if (origin.data === null) throw new Error(RETURN_MESSAGES.notFound)

  const document = origin.data as unknown as {
    id: string
    doc_type: SaleDocType
    doc_number: string | null
    status: string
    sale_line: LineRow[]
  }

  if (document.doc_type !== 'delivery_note') throw new Error(RETURN_MESSAGES.notDeliveryNote)
  if (document.status === 'draft') throw new Error(RETURN_MESSAGES.draft)
  if (document.status === 'cancelled') throw new Error(RETURN_MESSAGES.cancelled)

  const returned = sumByVariant(
    (previous.data as unknown as { sale_line: { variant_id: string; quantity: string }[] }[] | null)
      ?.flatMap((row) => row.sale_line ?? []) ?? [],
  )

  const delivered = sumByVariant(document.sale_line ?? [])
  const returnable = new Map<string, string>()
  const lines: SaleLine[] = []

  for (const [variantId, total] of delivered) {
    const left = total - (returned.get(variantId) ?? 0n)
    if (left <= 0n) continue

    // Le plus bas prix de cette variante sur le bon : l'avoir ne dépasse alors
    // jamais ce qui a été facturé. Voir l'en-tête.
    const rows = (document.sale_line ?? []).filter((row) => row.variant_id === variantId)
    const prices = rows
      .map((row) => parseDecimal(row.unit_price, MONEY_SCALE))
      .filter((price): price is bigint => price !== null)
    const product = rows
      .map((row) => row.variant?.product)
      .find((candidate) => candidate !== null && candidate !== undefined)
    if (product === null || product === undefined || prices.length === 0) continue

    const quantity = inputText(toSqlDecimal(left, QUANTITY_SCALE), 'quantity')
    returnable.set(variantId, quantity)

    lines.push({
      variantId,
      productId: product.id,
      name: product.name_fr,
      reference: product.code ?? rows[0]?.variant?.sku ?? null,
      photoPath: product.photo_url,
      quantity,
      unitPrice: inputText(
        toSqlDecimal(prices.reduce((low, price) => (price < low ? price : low)), MONEY_SCALE),
        'money',
      ),
      // Le prix vient du papier : ni palier, ni plancher, ni forçage.
      priceSource: 'manual',
      overriddenPrice: null,
      breaks: [],
      floorPrice: null,
    })
  }

  if (lines.length === 0) throw new Error(RETURN_MESSAGES.nothingLeft)

  return {
    documentId: document.id,
    docNumber: document.doc_number,
    lines,
    returnable,
  }
}

/** La ligne rend-elle plus que le bon n'a livré ? */
export function lineOverReturnable(line: SaleLine, returnable: ReadonlyMap<string, string>): boolean {
  const left = parseDecimal(returnable.get(line.variantId) ?? '', QUANTITY_SCALE)
  const asked = parseDecimal(line.quantity, QUANTITY_SCALE)
  return left !== null && asked !== null && asked > left
}

/**
 * Le retour peut-il partir ? Au moins une ligne, aucune incomplète, aucune
 * au-delà du registre du bon.
 */
export function returnIsComplete(
  lines: readonly SaleLine[],
  returnable: ReadonlyMap<string, string>,
): boolean {
  if (lines.length === 0) return false
  return lines.every((line) => {
    const asked = parseDecimal(line.quantity, QUANTITY_SCALE)
    return (
      asked !== null &&
      asked > 0n &&
      parseDecimal(line.unitPrice, MONEY_SCALE) !== null &&
      !lineOverReturnable(line, returnable)
    )
  })
}
