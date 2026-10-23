/*
 * Les octets du PDF. E5-03 — SPEC § 2.7.
 *
 * Un PDF dont chaque page est une image est une structure courte et stable :
 * un catalogue, un nœud de pages, et par page un objet `/Page`, son flux de
 * contenu de trente octets et son image. C'est tout ce qu'il y a ici, et c'est
 * pour cela qu'il n'y a pas de dépendance : `jspdf` et `pdf-lib` pèsent une
 * centaine de kilo-octets empaquetés dans l'APK et **ne résolvent rien** du
 * problème qui a décidé de la forme — aucune des deux ne façonne l'arabe
 * (voir `page.ts`). Il n'y aurait donc eu qu'à leur confier ce fichier-ci.
 *
 * Ce qui se vérifie, et qui est la seule chose délicate du format : la table
 * `xref` est une liste d'**offsets en octets**, et un offset faux produit un
 * fichier qu'aucun lecteur n'ouvre. Les tests relisent la table et vérifient
 * que chaque offset tombe sur « N 0 obj ».
 *
 * **La compression est injectée.** `CompressionStream('deflate')` rend du
 * zlib, qui est exactement `/FlateDecode` ; elle existe dans Chrome depuis la
 * version 80, donc partout où l'application tourne, enveloppe comprise. Elle
 * est passée en paramètre pour deux raisons : un test de structure veut des
 * octets qu'il peut relire sans rien décompresser, et une mesure de taille veut
 * pouvoir comparer les deux.
 */

import type { Gray } from '@/lib/printing/raster'

/** Comprime en zlib — ce que `/FlateDecode` attend. */
export type Compressor = (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array<ArrayBuffer>>

/**
 * Le compresseur du navigateur. `null` quand la plateforme ne l'a pas : le PDF
 * sort alors sans filtre, plus lourd mais valide — jamais d'échec sur ce point.
 */
export function browserCompressor(): Compressor | null {
  if (typeof CompressionStream === 'undefined') return null

  /*
   * Les octets sont poussés dans le flux et les morceaux relus un par un, sans
   * passer par `Blob` ni `Response` : jsdom n'implémente pas `Blob.stream()`,
   * et une fonction qui ne s'exécute que dans le navigateur ne se mesure pas.
   */
  return async (bytes) => {
    const packer = new CompressionStream('deflate')
    const writer = packer.writable.getWriter()
    void writer.write(bytes).then(() => writer.close())

    const reader = packer.readable.getReader()
    const parts: Array<Uint8Array<ArrayBuffer>> = []
    let length = 0

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      length += value.length
    }

    const packed = new Uint8Array(length)
    let at = 0
    for (const part of parts) {
      packed.set(part, at)
      at += part.length
    }
    return packed
  }
}

const ascii = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff)

export interface PdfOptions {
  /** `undefined` prend celui du navigateur ; `null` écrit sans filtre. */
  compress?: Compressor | null
  /** La géométrie de la page, en points PDF. */
  width: number
  height: number
}

/**
 * Le fichier, pages dans l'ordre.
 *
 * Chaque image remplit sa page : le carré unité du PDF est mis à l'échelle de
 * la `MediaBox`, et la première ligne de l'image est le haut de la page.
 */
export async function buildPdf(
  pages: readonly Gray[],
  options: PdfOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  if (pages.length === 0) throw new Error('Un PDF sans page ne veut rien dire.')

  const compress = options.compress === undefined ? browserCompressor() : options.compress
  const { width, height } = options

  const chunks: Array<Uint8Array<ArrayBuffer>> = []
  let length = 0
  const put = (chunk: Uint8Array<ArrayBuffer> | string): void => {
    const bytes = typeof chunk === 'string' ? ascii(chunk) : chunk
    chunks.push(bytes)
    length += bytes.length
  }

  /* Le commentaire binaire : il dit aux outils de ne pas traiter le fichier en texte. */
  put('%PDF-1.4\n')
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))

  /* 1 catalogue, 2 nœud de pages, puis trois objets par page. */
  const pageObject = (index: number): number => 3 + index * 3
  const count = 2 + pages.length * 3
  const offsets = new Array<number>(count + 1).fill(0)

  const object = (
    id: number,
    body: Uint8Array<ArrayBuffer> | string,
    stream?: Uint8Array<ArrayBuffer>,
  ): void => {
    offsets[id] = length
    put(`${id} 0 obj\n`)
    put(body)
    if (stream !== undefined) {
      put('\nstream\n')
      put(stream)
      put('\nendstream')
    }
    put('\nendobj\n')
  }

  const kids = pages.map((_, index) => `${pageObject(index)} 0 R`).join(' ')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)

  for (const [index, page] of pages.entries()) {
    const id = pageObject(index)
    const contentId = id + 1
    const imageId = id + 2

    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    )

    const content = ascii(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`)
    object(contentId, `<< /Length ${content.length} >>`, content)

    const raw = page.levels
    const data = compress === null ? raw : await compress(raw)
    const filter = compress === null ? '' : '/Filter /FlateDecode '
    object(
      imageId,
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
        `/ColorSpace /DeviceGray /BitsPerComponent 8 ${filter}/Length ${data.length} >>`,
      data,
    )
  }

  /*
   * La table des références croisées. Vingt octets par entrée, largeurs fixes :
   * un lecteur s'y déplace par calcul, pas en lisant.
   */
  const startxref = length
  put(`xref\n0 ${count + 1}\n`)
  put('0000000000 65535 f \n')
  for (let id = 1; id <= count; id += 1) {
    put(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)
  }
  put(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`)

  const file = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    file.set(chunk, at)
    at += chunk.length
  }
  return file
}
