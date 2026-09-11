/*
 * Les catégories, en lecture seule. M1 — E2-02.
 *
 * La fiche produit propose les catégories qui existent ; elle n'en crée pas.
 * Aucun écran de catégories n'est prévu (SPEC § 6) : elles arriveront par
 * l'import (E2-05). D'ici là, un commerce n'en a aucune, et le champ ne
 * s'affiche pas — une fonctionnalité privée de sa donnée se désactive en
 * silence (SPEC § 2.6).
 */

import { supabase } from '@/lib/supabase'

export interface Category {
  id: string
  name: string
}

export async function listCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('category')
    .select('id, name_fr')
    .is('deleted_at', null)
    .order('sort_order')
    .order('name_fr')

  if (error !== null) throw new Error(error.message)
  return (data as Array<{ id: string; name_fr: string }>).map((row) => ({
    id: row.id,
    name: row.name_fr,
  }))
}
