/*
 * L'historique des mouvements d'une variante. M2 — E3-02.
 *
 * Tout passe par `public.list_stock_movements()`, et il y a une raison précise
 * à cela : le critère de la story demande l'**auteur** de chaque mouvement, et
 * l'acteur de la story est le vendeur. `stock_movement.created_by` référence
 * `app_user`, que la policy restrictive `capability_restriction` réserve à
 * `manage_users` — au patron seul (E1-02, SPEC § 3.1). Aucune lecture par
 * PostgREST, jointure incorporée comprise, ne peut donc rendre ce nom à un
 * employé. La fonction est une exception § 2.1 **nommée**, inscrite à
 * `merx.rls_exception_registry`, et ses trois gardes sont éprouvés un par un.
 *
 * Rien ici n'écrit : un mouvement est en ajout seul (RÈGLE M2-2), et aucun type
 * n'est ouvert à l'écriture avant E3-03. La consultation ne crée rien.
 */

import { supabase } from '@/lib/supabase'

/** Les cinq types de `public.stock_movement_type`. */
export type MovementType = 'sale' | 'return' | 'receipt' | 'adjustment' | 'inventory'

/** Les trois valeurs de `public.stock_source_type`, telles que la base les nomme. */
export type SourceType = 'sale_document' | 'return_document' | 'goods_receipt'

/**
 * Ce que chaque type se dit en français, à l'écran.
 *
 * Exhaustive et typée par `MovementType` : un sixième type ajouté à l'enum sans
 * sa phrase casse la compilation, ce qui est le seul rappel qui marche. Même
 * procédé qu'`ACTION_LABELS` du journal d'audit (E1-04).
 */
export const MOVEMENT_LABELS: Readonly<Record<MovementType, string>> = {
  sale: 'Vente',
  return: 'Retour',
  receipt: 'Réception',
  adjustment: 'Ajustement',
  inventory: 'Inventaire',
}

/**
 * Le document d'origine, quand il y en a un.
 *
 * Aucune des trois tables visées n'existe avant E4 et E8 : le mouvement porte
 * un type et un identifiant, pas un numéro, et l'écran les nomme sans y mener.
 * Construire le lien maintenant serait bâtir en avance.
 */
export const SOURCE_LABELS: Readonly<Record<SourceType, string>> = {
  sale_document: 'Bon de vente',
  return_document: 'Retour',
  goods_receipt: 'Réception',
}

/** Une ligne de l'historique, telle que la fiche variante la montre. */
export interface StockMovement {
  id: string
  createdAt: string
  movementType: MovementType
  /** Décimale en chaîne, signée : négative en sortie. Jamais un flottant. */
  quantity: string
  sourceType: SourceType | null
  sourceId: string | null
  /** Le motif d'un ajustement (E3-03), ou rien. */
  note: string | null
  /** `null` si l'auteur a été supprimé de la fiche du commerce. */
  authorName: string | null
}

interface MovementRow {
  id: string
  created_at: string
  movement_type: MovementType
  quantity: string
  source_type: SourceType | null
  source_id: string | null
  note: string | null
  author_name: string | null
}

/*
 * Ce que la fonction rend au plus. Elle borne elle-même à 500 ; 100 est ce que
 * l'écran demande — un historique se lit par le haut, et une tablette bon
 * marché ne doit pas recevoir dix mille lignes pour en afficher trente.
 */
export const HISTORY_LIMIT = 100

/**
 * L'historique complet d'une variante, du plus récent au plus ancien.
 *
 * Une liste vide a deux causes que l'appelant n'a pas à distinguer : la
 * variante n'a aucun mouvement, ou elle n'appartient pas au commerce du jeton.
 * C'est voulu — répondre autrement confirmerait l'existence d'une ligne qu'on
 * n'a pas le droit de voir, ce qu'E1-02 et E1-03 refusent déjà de faire.
 */
export async function listStockMovements(variantId: string): Promise<StockMovement[]> {
  const { data, error } = await supabase.rpc('list_stock_movements', {
    p_variant_id: variantId,
    p_limit: HISTORY_LIMIT,
  })

  if (error !== null) throw new Error(error.message)

  return ((data ?? []) as MovementRow[]).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    movementType: row.movement_type,
    quantity: row.quantity,
    sourceType: row.source_type,
    sourceId: row.source_id,
    note: row.note,
    authorName: row.author_name,
  }))
}
