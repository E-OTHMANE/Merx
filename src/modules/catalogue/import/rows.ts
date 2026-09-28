/*
 * Du tableau du fichier aux lignes que la base recevra. M1 — E2-05.
 *
 * BACKLOG E2-05 : « validation ligne par ligne, avec numéro de ligne et motif
 * d'erreur ». Deux exigences se suivent :
 *
 *   — **le numéro est celui du fichier**, en-tête comprise, pas celui d'une
 *     numérotation interne : le patron ouvre son fichier, va à la ligne 148, et
 *     voit la ligne dont on lui parle ;
 *   — **le motif nomme la colonne et cite la valeur.** « Prix de vente
 *     illisible : « 1.250 » » et jamais « ligne invalide » : avec douze champs
 *     possibles, un motif qui ne nomme rien oblige à deviner lequel a fauté.
 *
 * Une ligne fautive est rejetée **entière**. C'est ce qui tient l'atomicité par
 * ligne de bout en bout : ce qui part est bon, ce qui ne part pas revient dans
 * le rapport de rejets, que le commerçant corrige et réimporte — la référence
 * servant de clé, le réimport met à jour au lieu de dupliquer.
 */

import {
  FIELD_LABELS,
  type Field,
  type Mapping,
} from '@/modules/catalogue/import/columns'
import { cleanText, parseAmount, parseCount, parseReference } from '@/modules/catalogue/import/values'

/** Une ligne prête à partir : seules les clés qui ont une valeur y figurent. */
export interface ImportRow {
  line: number
  name_fr: string
  name_ar?: string
  code?: string
  barcode?: string
  category?: string
  brand?: string
  unit_label?: string
  pieces_per_carton?: number
  unit_price?: string
  cost_price?: string
}

export interface RejectedRow {
  line: number
  motif: string
  /** Les cellules d'origine, pour le rapport téléchargeable. */
  cells: readonly string[]
}

export interface PreparedCounts {
  /** Lignes de données lues, hors en-tête et hors lignes vides. */
  total: number
  ready: number
  rejected: number
  /** Sans référence : un second import du même fichier les créera à nouveau. */
  withoutCode: number
  /** Prix de vente : cellule vide — une absence. */
  priceMissing: number
  /** Prix de vente : un 0 saisi — une saisie, comptée à part. */
  priceZero: number
  /** Lignes entièrement vides, ignorées sans rien dire. */
  ignored: number
}

export interface Prepared {
  rows: ImportRow[]
  rejected: RejectedRow[]
  counts: PreparedCounts
}

const cell = (cells: readonly string[], mapping: Mapping, field: Field): string => {
  const column = mapping[field]
  return column === undefined ? '' : (cells[column] ?? '')
}

const named = (field: Field, headers: readonly string[], mapping: Mapping): string => {
  const column = mapping[field]
  const header = column === undefined ? '' : cleanText(headers[column] ?? '')
  return header === '' ? FIELD_LABELS[field] : `${FIELD_LABELS[field]} (colonne « ${header} »)`
}

/**
 * Les lignes du fichier, validées. `headerRow` est l'indice, dans `table`, de
 * la ligne d'en-tête ; les données commencent juste après.
 */
export function prepareRows(
  table: readonly (readonly string[])[],
  mapping: Mapping,
  headerRow = 0,
): Prepared {
  const headers = table[headerRow] ?? []
  const rows: ImportRow[] = []
  const rejected: RejectedRow[] = []
  const counts: PreparedCounts = {
    total: 0,
    ready: 0,
    rejected: 0,
    withoutCode: 0,
    priceMissing: 0,
    priceZero: 0,
    ignored: 0,
  }

  /** La première ligne où chaque référence a été vue, pour nommer le doublon. */
  const seenCodes = new Map<string, number>()

  for (let index = headerRow + 1; index < table.length; index++) {
    const cells = table[index] ?? []
    const line = index + 1

    if (cells.every((value) => cleanText(value) === '')) {
      counts.ignored += 1
      continue
    }
    counts.total += 1

    const reject = (motif: string): void => {
      rejected.push({ line, motif, cells })
      counts.rejected += 1
    }

    const name = cleanText(cell(cells, mapping, 'name_fr'))
    if (name === '') {
      reject(`${named('name_fr', headers, mapping)} absent : une ligne sans nom n’est pas un produit.`)
      continue
    }

    const row: ImportRow = { line, name_fr: name }
    let refused = false

    /* Les champs de texte libre : ils n'ont rien à refuser. */
    for (const field of ['name_ar', 'category', 'brand', 'unit_label'] as const) {
      const value = cleanText(cell(cells, mapping, field))
      if (value !== '') row[field] = value
    }

    /* Référence et code-barres : Excel sait les abîmer, et on ne devine pas. */
    for (const field of ['code', 'barcode'] as const) {
      const parsed = parseReference(cell(cells, mapping, field))
      if (parsed.status === 'unreadable') {
        reject(
          `${named(field, headers, mapping)} illisible : « ${parsed.value} » — ${parsed.reason}. ` +
            'Mettre la colonne au format Texte dans Excel, puis réenregistrer.',
        )
        refused = true
        break
      }
      if (parsed.status === 'text') row[field] = parsed.value
    }
    if (refused) continue

    const pieces = parseCount(cell(cells, mapping, 'pieces_per_carton'))
    if (pieces.status === 'unreadable') {
      reject(
        `${named('pieces_per_carton', headers, mapping)} illisible : « ${pieces.value} » — ${pieces.reason}.`,
      )
      continue
    }
    if (pieces.status === 'count') row.pieces_per_carton = pieces.value

    for (const field of ['unit_price', 'cost_price'] as const) {
      const amount = parseAmount(cell(cells, mapping, field))

      if (amount.status === 'ambiguous') {
        /*
         * Le refus de deviner, dit au commerçant dans ses termes. Un facteur
         * mille sur un prix de vente ne se rattrape pas au comptoir.
         */
        reject(
          `${named(field, headers, mapping)} ambigu : « ${amount.value} » — 1 250 ou 1,25 ? ` +
            'Écrire le montant voulu, avec une virgule pour les centimes.',
        )
        refused = true
        break
      }
      if (amount.status === 'unreadable') {
        reject(
          `${named(field, headers, mapping)} illisible : « ${amount.value} » — ${amount.reason}.`,
        )
        refused = true
        break
      }
      if (amount.status === 'amount') row[field] = amount.sql

      /*
       * Vide et 0 aboutissent tous deux à « prix non renseigné » (E2-03 : jamais
       * 0 par défaut), mais ils ne se comptent pas ensemble : un commerçant qui
       * a vraiment tapé 0 partout doit comprendre pourquoi rien n'a de prix.
       */
      if (field === 'unit_price') {
        if (amount.status === 'empty') counts.priceMissing += 1
        if (amount.status === 'zero') counts.priceZero += 1
      }
    }
    if (refused) continue

    if (row.code === undefined) {
      counts.withoutCode += 1
    } else {
      const key = row.code.toLowerCase()
      const first = seenCodes.get(key)
      if (first !== undefined) {
        /*
         * La première occurrence est importée, les suivantes rejetées en
         * nommant sa ligne. Rejeter les deux punirait le commerçant deux fois
         * pour une faute de frappe.
         */
        reject(
          `Référence « ${row.code} » déjà présente à la ligne ${first} de ce fichier. ` +
            'La première ligne est importée, celle-ci ne l’est pas.',
        )
        continue
      }
      seenCodes.set(key, line)
    }

    rows.push(row)
    counts.ready += 1
  }

  return { rows, rejected, counts }
}
