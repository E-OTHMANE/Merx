/*
 * Le texte d'un fichier déposé. M1 — E2-05.
 *
 * BACKLOG E2-05 : « gère les cas réels : […] accents cassés ». Un fichier de
 * commerçant vient d'Excel, et Excel n'écrit pas d'UTF-8 quand il exporte en
 * CSV : il écrit la page de code du système. Au Maroc, c'est `windows-1256`
 * (arabe) ou `windows-1252` (latin) — et les deux placent à, â, ç, è, é, ê, î,
 * ï, ô, ù, û, ü aux mêmes positions. Décoder en 1256 lit donc l'arabe **et**
 * les accents français ; c'est le seul repli.
 *
 * Trois cas, dans cet ordre :
 *
 *   1. UTF-8 strict. C'est le cas normal, et le BOM est retiré ;
 *   2. sinon `windows-1256` ;
 *   3. le double encodage — « CrÃ¨me » —, qui est de l'UTF-8 déjà lu une fois
 *      comme du latin, puis réécrit. Il arrive dans des fichiers *valides* en
 *      UTF-8 : le cas 1 réussit, et le texte reste abîmé. Il se répare en
 *      relisant les octets latins comme de l'UTF-8.
 *
 * Le choix se corrige à la main à l'aperçu : la détection est une proposition,
 * pas un verdict.
 */

export type Encoding = 'utf-8' | 'windows-1256' | 'windows-1252'

export const ENCODING_LABELS: Readonly<Record<Encoding, string>> = {
  'utf-8': 'UTF-8 (le plus courant)',
  'windows-1256': 'Windows arabe (Excel en arabe)',
  'windows-1252': 'Windows latin (Excel en français)',
}

/** Le caractère que le BOM d'un fichier UTF-8 laisse en tête du texte. */
const BOM = 0xfeff

/*
 * Les vingt-sept caractères que `windows-1252` place entre 0x80 et 0x9F, là où
 * le latin-1 n'a que des contrôles : l'euro, les guillemets typographiques, le
 * tiret cadratin… Un octet d'UTF-8 tombé dans cette plage est donc devenu l'un
 * d'eux — « Ù… » est un 0xD9 suivi d'un 0x85 lu comme des points de suspension.
 * Sans cette table, la relecture reconstruit un octet faux et l'arabe reste
 * cassé (constaté par le test « répare un double encodage »).
 */
const WINDOWS_1252_HIGH = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
])

/** L'octet dont un caractère est né, en latin-1 ou en `windows-1252`. */
function byteOf(code: number): number {
  return WINDOWS_1252_HIGH.get(code) ?? code & 0xff
}

/** Les octets d'un texte, lus comme du latin — l'inverse d'un décodage latin. */
function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = byteOf(text.charCodeAt(i))
  return bytes
}

/*
 * Les traces du double encodage : un caractère d'en-tête d'UTF-8 lu comme du
 * latin — « Â », « Ã » pour les accents, « Ø » à « Û » pour l'arabe — suivi
 * d'un caractère de continuation.
 *
 * Compté à la main plutôt qu'avec une expression régulière : ce sont des
 * numéros de caractères, et un numéro se lit mieux qu'un caractère de contrôle
 * invisible dans une classe.
 */
const LEADS = [0xc2, 0xc3, 0xd8, 0xd9, 0xda, 0xdb]
const CONTINUATION_FIRST = 0x80
const CONTINUATION_LAST = 0xbf

function tracesOf(text: string): number {
  let traces = 0
  for (let i = 0; i + 1 < text.length; i++) {
    const next = byteOf(text.charCodeAt(i + 1))
    if (
      LEADS.includes(text.charCodeAt(i)) &&
      next >= CONTINUATION_FIRST &&
      next <= CONTINUATION_LAST
    ) {
      traces += 1
    }
  }
  return traces
}

/**
 * Répare un texte déjà décodé une fois de trop. Rend le texte inchangé si la
 * relecture échoue ou n'améliore rien : mieux vaut un accent cassé qu'un texte
 * remplacé par autre chose.
 */
export function repairDoubleEncoding(text: string): string {
  if (tracesOf(text) === 0) return text
  try {
    const repaired = new TextDecoder('utf-8', { fatal: true }).decode(latin1Bytes(text))
    return tracesOf(repaired) < tracesOf(text) ? repaired : text
  } catch {
    return text
  }
}

/** Décode des octets dans l'encodage demandé, BOM retiré, double encodage réparé. */
export function decodeWith(bytes: Uint8Array, encoding: Encoding): string {
  const text = new TextDecoder(encoding).decode(bytes)
  return repairDoubleEncoding(text.charCodeAt(0) === BOM ? text.slice(1) : text)
}

/** L'encodage proposé : UTF-8 s'il tient, `windows-1256` sinon. */
export function detectEncoding(bytes: Uint8Array): Encoding {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'utf-8'
  } catch {
    return 'windows-1256'
  }
}

/** Le texte d'un fichier, et l'encodage retenu. */
export function decodeFile(bytes: Uint8Array): { text: string; encoding: Encoding } {
  const encoding = detectEncoding(bytes)
  return { text: decodeWith(bytes, encoding), encoding }
}
