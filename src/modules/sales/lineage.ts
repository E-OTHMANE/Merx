/*
 * La filiation d'un document — E4-05. RÈGLE M3-4.
 *
 * « Le lien de filiation est consultable dans les deux sens » : l'original
 * depuis l'enfant, les enfants depuis l'original. Deux lectures, parce que ce
 * sont deux questions — et la seconde emprunte l'index partiel
 * `sale_document_source` plutôt que de parcourir les documents du commerce.
 *
 * **Un parent, plusieurs enfants.** Aucune unicité ne porte sur
 * `source_document_id` : une commande de 100 livrée en deux camions fait deux
 * bons, un devis accepté à moitié fait deux commandes. `children` est donc une
 * liste, et ce n'est pas une précaution — c'est le cas normal.
 *
 * **Ce qui n'est pas ici : l'affichage.** L'écran de détail d'un document est
 * E4-07, qui porte le critère « détail affichant les lignes, les totaux,
 * l'auteur, l'appareil et l'horodatage » ; c'est là que la filiation se lira,
 * avec un lien vers le document voisin. La construire ici serait bâtir en
 * avance (CLAUDE.md, une story à la fois) ; la lire ici est ce que la story
 * doit, et c'est éprouvé.
 */

import { supabase } from '@/lib/supabase'
import type { SaleDocType } from '@/modules/sales/documentNumber'

/** Un document voisin, tel qu'une liste de filiation le montre. */
export interface LinkedDocument {
  id: string
  docType: SaleDocType
  /** Nul tant que le document est un brouillon (RÈGLE M3-2). */
  docNumber: string | null
  status: string
}

export interface DocumentLineage {
  documentId: string
  /** Le document d'origine, ou `null` — un document né de la saisie n'en a pas. */
  source: LinkedDocument | null
  /** Ce qui en est issu, du plus ancien au plus récent. */
  children: LinkedDocument[]
}

const COLUMNS = 'id, doc_type, doc_number, status'

interface DocumentRow {
  id: string
  doc_type: SaleDocType
  doc_number: string | null
  status: string
}

const linked = (row: DocumentRow): LinkedDocument => ({
  id: row.id,
  docType: row.doc_type,
  docNumber: row.doc_number,
  status: row.status,
})

/**
 * La filiation d'un document, dans les deux sens.
 *
 * Aucun `tenant_id` n'est filtré : la RLS borne la lecture (SPEC § 2.1), et un
 * document du voisin n'est de toute façon pas visible — c'est pourquoi un
 * document introuvable et un document interdit se répondent ici de la même
 * façon, par l'absence.
 */
export async function documentLineage(documentId: string): Promise<DocumentLineage> {
  const [own, descendants] = await Promise.all([
    supabase
      .from('sale_document')
      .select('source_document_id')
      .eq('id', documentId)
      .maybeSingle(),
    supabase
      .from('sale_document')
      .select(COLUMNS)
      .eq('source_document_id', documentId)
      .order('created_at', { ascending: true }),
  ])

  if (own.error !== null) throw new Error(own.error.message)
  if (descendants.error !== null) throw new Error(descendants.error.message)

  const children = ((descendants.data ?? []) as DocumentRow[]).map(linked)
  const sourceId = (own.data as { source_document_id: string | null } | null)?.source_document_id

  if (sourceId === undefined || sourceId === null) {
    return { documentId, source: null, children }
  }

  const { data, error } = await supabase
    .from('sale_document')
    .select(COLUMNS)
    .eq('id', sourceId)
    .maybeSingle()
  if (error !== null) throw new Error(error.message)

  return {
    documentId,
    source: data === null ? null : linked(data as DocumentRow),
    children,
  }
}
