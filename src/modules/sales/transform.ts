/*
 * La transformation d'un document — E4-05. RÈGLES M3-4, M3-5.
 *
 * « Transformer un devis en bon, afin de ne pas ressaisir. » Ce fichier lit le
 * document d'origine et rend des lignes de saisie : à partir de là, c'est
 * l'écran de vente ordinaire qui s'en occupe, et les lignes se modifient comme
 * celles qu'on vient de taper (critère de la story).
 *
 * **Rien n'est muté.** La transformation ne touche pas à l'original : elle
 * **lit**, et l'écriture est celle d'un document neuf qui porte
 * `source_document_id` (`recordSale()`). La base le tient de toute façon —
 * l'original est figé dès sa confirmation (RÈGLE M3-3) — mais c'est ici que la
 * règle se voit.
 *
 * ----------------------------------------------------------------------------
 * **Le prix repris n'est pas un forçage, et c'est l'arbitrage du fichier.**
 *
 * Une ligne copiée porte le prix du document d'origine. La tentation est de
 * recalculer `overridden_price` contre la grille d'aujourd'hui, pour que la
 * ligne « dise » qu'elle s'écarte des paliers. Ce serait l'erreur de « qui »
 * qu'E4-04 a refusée pour la confirmation : le trigger d'audit écrit une entrée
 * `price_override` dès que `overridden_price` n'est pas nul, et
 * `merx.log_audit()` prend l'auteur dans le jeton de **celui qui écrit**
 * (E1-04). L'employé qui transforme un devis fait par le patron il y a un mois
 * se verrait attribuer un forçage qu'il n'a pas décidé — et le journal ne pose
 * qu'une question, « qui ».
 *
 * Donc : `overriddenPrice` est **nul** sur toute ligne copiée. Le journal
 * n'enregistre de cet employé que ce qu'il change lui-même, par
 * `forceUnitPrice()`, après coup et à son nom. Le forçage d'origine, lui, reste
 * écrit sur le document d'origine — que la filiation retrouve (`lineage.ts`).
 *
 * `priceSource` suit la même logique, et se **mesure** au lieu d'être copié :
 * si la grille d'aujourd'hui donne, pour cette quantité, exactement le prix
 * repris, la ligne est `auto` — ce prix *est* celui du palier ; sinon elle est
 * `manual`, ce qui est la vérité : le prix ne vient pas de la grille, il vient
 * d'un papier. Rien d'autre ne distingue ces deux états en base, et l'écran
 * n'affiche d'incitation au palier que sur le premier.
 *
 * **La grille reprend la parole dès que la quantité change** : `setQuantity()`
 * rejoue `resolvePriceBreak()` comme sur n'importe quelle ligne (E4-03). Une
 * nouvelle quantité est une nouvelle vente, pas la reprise d'un prix promis.
 *
 * **Le plancher d'aujourd'hui s'applique**, lu avec les paliers : une ligne
 * copiée d'un devis ancien, passée sous un plancher relevé depuis, est refusée
 * — à l'écran d'abord (`saleIsComplete`), par `merx.require_floor_price()`
 * ensuite. C'est voulu : le refus tombe au comptoir, devant quelqu'un qui peut
 * encore faire forcer le prix ou faire baisser le plancher. Le cas hors ligne,
 * où le même refus arriverait des jours après la vente, est une question
 * ouverte (BACKLOG E9-03).
 */

import { inputText } from '@/lib/decimal'
import { supabase } from '@/lib/supabase'
import { priceBasisFor } from '@/modules/catalogue'
import type { SaleDocType } from '@/modules/sales/documentNumber'
import { resolvedPrice, type PriceSource, type SaleLine } from '@/modules/sales/sale'

/**
 * Ce qu'une transformation produit, par type d'origine — la chaîne de
 * `merx.document_transformation`, côté écran.
 *
 * Le saut « devis → bon » existe en base (un client accepte un devis et on le
 * livre), mais l'écran propose **le pas suivant** : c'est le plus courant, et
 * le vendeur garde le choix du type avant d'enregistrer.
 */
export const TRANSFORM_TARGET: Readonly<Record<SaleDocType, SaleDocType | null>> = {
  quote: 'order',
  order: 'delivery_note',
  /*
   * Un bon ne se « transforme » pas : il se **retourne**, et le retour a sa
   * propre porte (`/sale/return/:documentId`, E4-06). Ce n'est pas le pas
   * suivant d'une chaîne de vente, c'est le geste inverse — la chaîne admise en
   * base (`merx.document_transformation`) le connaît, cet écran-ci ne le
   * propose pas.
   */
  delivery_note: null,
  return: null,
}

export const TRANSFORM_MESSAGES = {
  notFound:
    'Ce document n’existe plus, ou ce compte n’a pas le droit de le lire.',
  /*
   * La phrase de l'écran, et elle n'est pas celle de la base : celle du garde
   * (`merx.require_transformation_shape()`) ne se lit que lorsqu'on a parlé à
   * PostgREST sans passer par ici (CLAUDE.md, deux gardes sur le même chemin).
   */
  draft: 'Ce document est encore un brouillon : il n’y a rien à transformer.',
  cancelled: 'Ce document est annulé : il ne se transforme pas.',
  terminal: 'Un bon de livraison est la fin du cycle : il ne se transforme pas.',
  empty: 'Ce document n’a aucune ligne à reprendre.',
} as const

/** Le document d'origine, tel que l'écran de transformation le présente. */
export interface TransformationSource {
  documentId: string
  docType: SaleDocType
  docNumber: string | null
  /** Le type que l'écran propose — `null` si rien ne part de ce document. */
  target: SaleDocType | null
  lines: SaleLine[]
}

interface LineRow {
  variant_id: string
  quantity: string
  unit_price: string
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

/**
 * Lit le document d'origine et rend les lignes de saisie qui le reprennent.
 *
 * Deux lectures seulement : le document avec ses lignes, puis les paliers et
 * les planchers **vivants** des variantes concernées — en un appel pour toutes
 * (`priceBasisFor`), comme l'ajout d'une ligne au comptoir.
 */
export async function loadForTransformation(
  documentId: string,
): Promise<TransformationSource> {
  const { data, error } = await supabase
    .from('sale_document')
    .select(
      'id, doc_type, doc_number, status,' +
        ' sale_line(variant_id, quantity::text, unit_price::text,' +
        ' variant!inner(sku, product!inner(id, name_fr, code, photo_url)))',
    )
    .eq('id', documentId)
    .maybeSingle()

  if (error !== null) throw new Error(error.message)
  if (data === null) throw new Error(TRANSFORM_MESSAGES.notFound)

  const document = data as unknown as {
    id: string
    doc_type: SaleDocType
    doc_number: string | null
    status: string
    sale_line: LineRow[]
  }

  if (document.status === 'draft') throw new Error(TRANSFORM_MESSAGES.draft)
  if (document.status === 'cancelled') throw new Error(TRANSFORM_MESSAGES.cancelled)

  const target = TRANSFORM_TARGET[document.doc_type]
  if (target === null) throw new Error(TRANSFORM_MESSAGES.terminal)

  const rows = document.sale_line ?? []
  if (rows.length === 0) throw new Error(TRANSFORM_MESSAGES.empty)

  const basis = await priceBasisFor(rows.map((row) => row.variant_id))

  const lines = rows.flatMap((row): SaleLine[] => {
    const product = row.variant?.product
    if (product === null || product === undefined) return []

    const quantity = inputText(row.quantity, 'quantity')
    const unitPrice = inputText(row.unit_price, 'money')
    const live = basis.get(row.variant_id) ?? { breaks: [], floorPrice: null }

    /*
     * Le prix repris est-il celui du palier d'aujourd'hui ? La comparaison
     * porte sur le texte de champ, que `resolvedPrice()` et `inputText()`
     * produisent tous deux de la même façon : deux écritures du même montant
     * ne peuvent pas différer.
     */
    const automatic = resolvedPrice(live.breaks, quantity)
    const priceSource: PriceSource = automatic === unitPrice ? 'auto' : 'manual'

    return [
      {
        variantId: row.variant_id,
        productId: product.id,
        name: product.name_fr,
        reference: product.code ?? row.variant?.sku ?? null,
        photoPath: product.photo_url,
        quantity,
        unitPrice,
        priceSource,
        // Jamais un forçage : voir l'en-tête de ce fichier.
        overriddenPrice: null,
        breaks: live.breaks,
        floorPrice: live.floorPrice,
      },
    ]
  })

  return {
    documentId: document.id,
    docType: document.doc_type,
    docNumber: document.doc_number,
    target,
    lines,
  }
}
