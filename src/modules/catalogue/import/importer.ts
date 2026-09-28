/*
 * L'envoi des lignes, et le rapport. M1 — E2-05.
 *
 * Tout passe par `public.import_products(rows)`, qui tient une
 * sous-transaction par ligne : les lignes valides entrent même si d'autres
 * échouent, et elle rend le sort de chacune. L'appareil ne fait ici que
 * découper, appeler, et traduire les refus de la base en motifs lisibles.
 *
 * **Par blocs de 50 lignes**, et les trois raisons sont écrites dans la
 * migration : le cache des sous-transactions de Postgres (64), le
 * `statement_timeout` d'`authenticated`, et la progression à l'écran. Un bloc
 * perdu par une coupure réseau n'est pas un import perdu : la référence est la
 * clé du réimport, et reprendre le fichier met à jour ce qui est déjà entré.
 */

import { supabase } from '@/lib/supabase'
import type { ImportRow, RejectedRow } from '@/modules/catalogue/import/rows'

export const CHUNK_SIZE = 50

export type Outcome = 'created' | 'updated' | 'unchanged' | 'rejected'

/** Le sort d'une ligne, tel que la base le rend. */
export interface RowReport {
  line: number
  outcome: Outcome
  product_id?: string | null
  code?: string | null
  constraint?: string | null
  table?: string | null
  message?: string | null
}

export interface ImportProgress {
  /** Lignes envoyées jusqu'ici, sur le total. */
  done: number
  total: number
}

export interface ImportResult {
  created: number
  updated: number
  unchanged: number
  /** Les lignes refusées par la base, motif déjà traduit. */
  rejected: RejectedRow[]
}

const INSUFFICIENT_PRIVILEGE = '42501'

export const IMPORT_MESSAGES = {
  refused:
    'Ce compte ne peut pas importer le catalogue : la base a refusé l’import.',
  duplicateCode:
    'Référence déjà utilisée par un autre produit de ce commerce, en dehors de ce fichier.',
  tooLarge: 'Montant trop grand pour la base.',
} as const

/*
 * Le motif d'un refus venu de la base. Le nom de contrainte est ce qui
 * distingue deux refus qui portent le même code (CLAUDE.md, E2-01) : les deux
 * unicités de référence répondent `23505`, et pour le commerçant c'est la même
 * chose — sa référence est prise.
 */
export function motifOf(report: RowReport): string {
  const constraint = report.constraint ?? ''
  const table = report.table ?? ''

  if (report.code === '23505') {
    if (constraint === 'product_code_per_tenant' || constraint === 'variant_sku_per_tenant') {
      return IMPORT_MESSAGES.duplicateCode
    }
  }
  if (report.code === INSUFFICIENT_PRIVILEGE) {
    return table === ''
      ? IMPORT_MESSAGES.refused
      : `${IMPORT_MESSAGES.refused} (table « ${table} »)`
  }
  if (report.code === '22003') return IMPORT_MESSAGES.tooLarge

  return report.message ?? 'La base a refusé cette ligne.'
}

/** Les blocs qu'un fichier devient. */
export function chunksOf<T>(rows: readonly T[], size = CHUNK_SIZE): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < rows.length; start += size) {
    chunks.push(rows.slice(start, start + size))
  }
  return chunks
}

interface PostgrestErrorLike {
  code?: string
  message: string
}

function failure(error: PostgrestErrorLike): Error {
  /*
   * Le garde de la fonction, en tête de son corps, répond `42501` avec sa
   * propre phrase et fait échouer l'appel entier — à la différence des
   * policies, qui refusent ligne par ligne et remplissent le rapport.
   */
  if (error.code === INSUFFICIENT_PRIVILEGE) return new Error(IMPORT_MESSAGES.refused)
  return new Error(error.message)
}

/**
 * Envoie les lignes, bloc par bloc, et rend le compte. `cells` retrouve les
 * cellules d'origine d'une ligne, pour que le rapport de rejets reste
 * réimportable.
 */
export async function importRows(
  rows: readonly ImportRow[],
  cells: (line: number) => readonly string[],
  onProgress: (progress: ImportProgress) => void = () => {},
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, unchanged: 0, rejected: [] }
  let done = 0

  for (const chunk of chunksOf(rows)) {
    const { data, error } = await supabase.rpc('import_products', { rows: chunk })
    if (error !== null) throw failure(error)

    for (const report of (data ?? []) as RowReport[]) {
      if (report.outcome === 'rejected') {
        result.rejected.push({ line: report.line, motif: motifOf(report), cells: cells(report.line) })
      } else {
        result[report.outcome] += 1
      }
    }

    done += chunk.length
    onProgress({ done, total: rows.length })
  }

  return result
}

/* -------------------------------------------------------------------------- */
/* Le rapport de rejets                                                        */
/* -------------------------------------------------------------------------- */

const csvCell = (value: string): string => `"${value.replace(/"/g, '""')}"`

/**
 * Le fichier des rejets : les colonnes d'origine, plus le numéro de ligne et
 * le motif. Point-virgule et BOM, pour qu'Excel l'ouvre sans rien demander —
 * c'est le fichier que le commerçant corrige et réimporte.
 */
export function rejectsCsv(
  headers: readonly string[],
  rejected: readonly RejectedRow[],
): string {
  const lines = [['Ligne', 'Motif', ...headers].map(csvCell).join(';')]

  for (const reject of [...rejected].sort((a, b) => a.line - b.line)) {
    lines.push(
      [String(reject.line), reject.motif, ...headers.map((_, column) => reject.cells[column] ?? '')]
        .map(csvCell)
        .join(';'),
    )
  }
  // BOM : sans lui, Excel lit l'UTF-8 comme du latin et casse les accents —
  // le défaut même que l'import sait réparer à la lecture (`encoding.ts`).
  return String.fromCharCode(0xfeff) + lines.join('\r\n') + '\r\n'
}
