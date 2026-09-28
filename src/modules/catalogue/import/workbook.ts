/*
 * Le fichier déposé, ramené à un tableau de texte. M1 — E2-05.
 *
 * BACKLOG E2-05 : « dépôt d'un fichier CSV ou XLSX ». Les deux finissent sous
 * la même forme — un tableau de chaînes, une ligne par ligne, une cellule par
 * colonne — et tout ce qui suit ne connaît que cette forme.
 *
 * **Le XLSX est lu en valeurs affichées**, celles que le commerçant voit dans
 * Excel, et non les valeurs internes : un nombre y est un flottant, et un
 * montant ne doit jamais passer par un flottant (CLAUDE.md). Le texte affiché
 * passe ensuite par le même analyseur de prix que le CSV ; ce qu'Excel a abîmé
 * lui-même — un EAN devenu « 6,11123E+12 » — est refusé et dit comme tel
 * (`values.ts`), parce que la valeur affichée ne porte plus le code.
 *
 * **SheetJS est chargé à la demande**, à l'ouverture d'un `.xlsx` seulement :
 * la bibliothèque pèse plus que le reste de l'écran, et un commerçant qui
 * n'importe jamais ne doit pas la télécharger. La version est épinglée et son
 * intégrité est inscrite dans `package-lock.json` ; le canal « dernière
 * version » n'est pas suivi — une montée de version silencieuse d'une
 * bibliothèque qui lit des fichiers venus de l'extérieur n'est pas une
 * amélioration.
 */

import { type Delimiter, detectDelimiter, parseCsv } from '@/modules/catalogue/import/csv'
import { type Encoding, decodeWith, detectEncoding } from '@/modules/catalogue/import/encoding'

export type FileKind = 'csv' | 'xlsx'

export interface LoadedFile {
  kind: FileKind
  table: string[][]
  /** Pour un CSV : ce qui a été reconnu, et qui se corrige à l'écran. */
  encoding?: Encoding
  delimiter?: Delimiter
}

export const ACCEPTED_EXTENSIONS = '.csv,.txt,.xlsx,.xls'

export function kindOf(name: string): FileKind {
  return /\.xlsx?$/i.test(name) ? 'xlsx' : 'csv'
}

/** Le tableau d'un CSV, dans l'encodage et avec le séparateur donnés. */
export function readCsv(
  bytes: Uint8Array,
  encoding?: Encoding,
  delimiter?: Delimiter,
): Required<Pick<LoadedFile, 'table' | 'encoding' | 'delimiter'>> {
  const chosen = encoding ?? detectEncoding(bytes)
  const text = decodeWith(bytes, chosen)
  const separator = delimiter ?? detectDelimiter(text)
  return { table: parseCsv(text, separator), encoding: chosen, delimiter: separator }
}

/** Le tableau de la première feuille d'un classeur. */
export async function readWorkbook(bytes: Uint8Array): Promise<string[][]> {
  const { read, utils } = await import('xlsx')
  const book = read(bytes, { type: 'array', cellText: true, cellDates: false, raw: false })

  const first = book.SheetNames[0]
  if (first === undefined) return []
  const sheet = book.Sheets[first]
  if (sheet === undefined) return []

  return utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true })
}

/** Le fichier déposé, quel qu'il soit. */
export async function readFile(file: File): Promise<LoadedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer())

  if (kindOf(file.name) === 'xlsx') {
    return { kind: 'xlsx', table: await readWorkbook(bytes) }
  }
  return { kind: 'csv', ...readCsv(bytes) }
}
