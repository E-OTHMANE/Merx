/*
 * La lecture d'un CSV. M1 — E2-05.
 *
 * Écrit ici plutôt que pris d'une bibliothèque : ce qu'il faut tient en un
 * automate, et le besoin est particulier. Un fichier de commerçant marocain
 * sort d'un Excel réglé en français, qui sépare au point-virgule parce que la
 * virgule est le séparateur décimal — « 15,00;Crème » . Une bibliothèque qui
 * suppose la virgule lit une colonne de plus une ligne sur deux, sans rien
 * dire.
 *
 * Ce que l'automate tient :
 *
 *   — le séparateur, reconnu sur le fichier (point-virgule, virgule,
 *     tabulation, barre verticale) plutôt que supposé ;
 *   — les guillemets, le guillemet doublé à l'intérieur, et le retour à la
 *     ligne dans une cellule — un nom de produit sur deux lignes existe ;
 *   — les fins de ligne Windows, Unix et Mac.
 *
 * Il ne tient volontairement pas : l'échappement par barre oblique inverse (ce
 * n'est pas du CSV), et les lignes de commentaire (rien n'en produit).
 */

export const DELIMITERS = [';', ',', '\t', '|'] as const
export type Delimiter = (typeof DELIMITERS)[number]

export const DELIMITER_LABELS: Readonly<Record<Delimiter, string>> = {
  ';': 'Point-virgule ( ; )',
  ',': 'Virgule ( , )',
  '\t': 'Tabulation',
  '|': 'Barre verticale ( | )',
}

const QUOTE = '"'

/**
 * Le séparateur du fichier : celui qui découpe le plus de colonnes, à nombre
 * de colonnes constant d'une ligne à l'autre. Compté hors guillemets, sur les
 * vingt premières lignes — « 15,00 DH » ne doit pas faire élire la virgule.
 *
 * À égalité, l'ordre de `DELIMITERS` tranche : le point-virgule d'abord, parce
 * que c'est ce qu'écrit un Excel français.
 */
export function detectDelimiter(text: string): Delimiter {
  let best: Delimiter = ';'
  let bestScore = -1

  for (const delimiter of DELIMITERS) {
    const rows = parseCsv(text, delimiter).slice(0, 20)
    if (rows.length === 0) continue

    const columns = rows[0]!.length
    if (columns < 2) continue
    const steady = rows.every((row) => row.length === columns)
    const score = (steady ? 1000 : 0) + columns

    if (score > bestScore) {
      bestScore = score
      best = delimiter
    }
  }
  return best
}

/** Le tableau d'un CSV : une ligne par ligne de fichier, une cellule par colonne. */
export function parseCsv(text: string, delimiter: Delimiter = ';'): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let started = false

  const endCell = (): void => {
    row.push(cell)
    cell = ''
  }
  const endRow = (): void => {
    endCell()
    rows.push(row)
    row = []
    started = false
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!

    if (quoted) {
      if (char !== QUOTE) {
        cell += char
      } else if (text[i + 1] === QUOTE) {
        cell += QUOTE
        i += 1
      } else {
        quoted = false
      }
      continue
    }

    if (char === QUOTE && cell === '') {
      quoted = true
      started = true
    } else if (char === delimiter) {
      endCell()
      started = true
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      endRow()
    } else {
      cell += char
      started = true
    }
  }

  // La dernière ligne, si le fichier ne se termine pas par un retour à la ligne.
  if (started || cell !== '' || row.length > 0) endRow()

  return rows
}
