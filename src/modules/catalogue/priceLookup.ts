/*
 * Les paliers d'une variante, pour la vente. M1 — E4-03.
 *
 * `price_break` est la **seule** source de prix du projet : `variant` n'en
 * porte pas, et chaque variante reçoit sa ligne `min_qty = 1` à la naissance
 * (RÈGLE M1-2, E2-03). Résoudre le prix d'une ligne de vente, c'est donc lire
 * ces paliers et appliquer `resolvePriceBreak()` — la fonction pure d'E2-03,
 * que personne ne réimplémente.
 *
 * `loadGrid()` ne convient pas ici : elle travaille par produit, lit le
 * plancher et le prix d'achat, et sert le formulaire de la grille. La vente
 * veut l'inverse — plusieurs variantes d'un coup, aucun coût, aucune colonne
 * confidentielle (SPEC § 3, point de rupture n° 5). Deux usages, deux lectures.
 *
 * Les montants et les quantités voyagent en texte (`@/lib/decimal`) : jamais de
 * flottant.
 *
 * Les paliers sont lus **à l'ajout de la ligne**, puis gardés : la résolution
 * se rejoue à chaque changement de quantité sans rien redemander au réseau. Un
 * bon de dix lignes coûte donc dix lectures, pas une par frappe — et aucune
 * hors ligne, le jour où la base locale les portera (E9).
 */

import { supabase } from '@/lib/supabase'
import type { PriceBreakLike } from '@/modules/catalogue/pricing'

export interface VariantBreaks extends PriceBreakLike {
  variantId: string
}

/**
 * De quoi tenir une ligne de vente : les paliers vivants de la variante et son
 * plancher.
 *
 * Le plancher est lu ici — E4-04 — parce que l'écran doit pouvoir refuser un
 * prix trop bas **avant** l'enregistrement, au moment où le vendeur le tape.
 * Il ne protège rien : ce qui protège est `merx.require_floor_price()`, en base
 * (SPEC § 3.1, astérisque du plancher). `variant.floor_price` est un prix de
 * vente minimum, lisible par tous les rôles — ce n'est pas un coût (SPEC § 6).
 */
export interface PriceBasis {
  breaks: PriceBreakLike[]
  /** `money_amount` en texte, ou `null` quand la variante n'en a pas. */
  floorPrice: string | null
}

/**
 * Les paliers vivants de ces variantes et leur plancher, par variante. Une
 * variante sans aucun palier rend une liste vide — la vente propose alors de
 * saisir le prix (SPEC § 2.6, rien ne bloque une vente).
 *
 * Deux requêtes pour une lecture : les paliers et les planchers vivent sur deux
 * tables, et la jointure ne se demande pas à PostgREST pour deux colonnes. Elles
 * partent ensemble, à l'ajout de la ligne, et rien n'est redemandé ensuite.
 */
export async function priceBasisFor(
  variantIds: readonly string[],
): Promise<Map<string, PriceBasis>> {
  const unique = [...new Set(variantIds)]
  const byVariant = new Map<string, PriceBasis>(
    unique.map((id) => [id, { breaks: [], floorPrice: null }]),
  )
  if (unique.length === 0) return byVariant

  // Les deux partent ensemble : au comptoir, l'ajout d'une ligne ne paie qu'un
  // aller-retour, pas deux à la file.
  const [{ data, error }, { data: floors, error: floorError }] = await Promise.all([
    supabase
      .from('price_break')
      .select('variant_id, min_qty::text, unit_price::text')
      .in('variant_id', unique)
      .is('deleted_at', null),
    supabase.from('variant').select('id, floor_price::text').in('id', unique),
  ])
  if (error !== null) throw new Error(error.message)
  if (floorError !== null) throw new Error(floorError.message)

  for (const row of data as Array<{
    variant_id: string
    min_qty: string
    unit_price: string | null
  }>) {
    byVariant
      .get(row.variant_id)
      ?.breaks.push({ minQty: row.min_qty, unitPrice: row.unit_price })
  }

  for (const row of floors as Array<{ id: string; floor_price: string | null }>) {
    const basis = byVariant.get(row.id)
    if (basis !== undefined) basis.floorPrice = row.floor_price
  }

  return byVariant
}
