/*
 * Les octets du PDF. E5-03 — critère 5 (« généré localement »).
 *
 * Un PDF écrit à la main n'a qu'une difficulté, et c'est celle qui ne se voit
 * pas : la table `xref` est une liste d'**offsets en octets**, et un offset
 * faux produit un fichier qu'aucun lecteur n'ouvre — sans message, et sans que
 * rien d'autre dans le fichier ne soit en cause. Ces tests relisent donc la
 * table et vérifient que chaque offset tombe bien sur « N 0 obj ».
 *
 * Le reste se lit comme une structure : un catalogue, autant de `/Page` que de
 * pages, et par page une image qui porte ses dimensions. Le flux comprimé est
 * décomprimé par `node:zlib` — jamais par le compresseur qui l'a produit, qui
 * annulerait ses propres erreurs (même raison que le décodeur de
 * `loopback.test.ts`, réécrit plutôt que repris de l'encodeur).
 */

import { inflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { PAGE_HEIGHT, PAGE_WIDTH } from '@/lib/printing/page'
import { browserCompressor, buildPdf } from '@/lib/printing/pdf'
import type { Gray } from '@/lib/printing/raster'

/** Une page grise de `w × h`, remplie d'un niveau. */
function page(width: number, height: number, level = 255): Gray {
  return { width, height, levels: new Uint8Array(width * height).fill(level) }
}

const latin1 = (bytes: Uint8Array): string => String.fromCharCode(...bytes)

const options = { width: PAGE_WIDTH, height: PAGE_HEIGHT, compress: null }

/** Les offsets de la table, dans l'ordre, l'entrée libre exclue. */
function xref(file: Uint8Array): number[] {
  const text = latin1(file)
  const start = Number(/startxref\n(\d+)/.exec(text)![1])
  const table = text.slice(start)

  const header = /^xref\n0 (\d+)\n/.exec(table)!
  const count = Number(header[1])
  const entries: number[] = []

  for (let index = 1; index < count; index += 1) {
    const at = header[0].length + index * 20
    const entry = table.slice(at, at + 20)
    expect(entry, `entrée ${index}`).toMatch(/^\d{10} 00000 n \n$/)
    entries.push(Number(entry.slice(0, 10)))
  }

  return entries
}

describe('la structure du fichier', () => {
  it('s’annonce comme un PDF, et comme un fichier binaire', async () => {
    const file = await buildPdf([page(8, 8)], options)

    expect(latin1(file.slice(0, 9))).toBe('%PDF-1.4\n')
    /* Le commentaire binaire : il dit aux outils de ne pas traiter le texte. */
    expect([...file.slice(9, 14)]).toEqual([0x25, 0xe2, 0xe3, 0xcf, 0xd3])
    expect(latin1(file).endsWith('%%EOF\n')).toBe(true)
  })

  it('porte un catalogue, un nœud de pages, et une page par image', async () => {
    const text = latin1(await buildPdf([page(8, 8), page(8, 8)], options))

    expect(text).toContain('/Type /Catalog /Pages 2 0 R')
    expect(text).toContain('/Type /Pages /Kids [3 0 R 6 0 R] /Count 2')
    expect(text.match(/\/Type \/Page /g)).toHaveLength(2)
    expect(text).toContain('/Root 1 0 R')
  })

  it('donne à chaque page la géométrie d’un A4', async () => {
    const text = latin1(await buildPdf([page(8, 8)], options))

    expect(text).toContain(`/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]`)
    /* L'image remplit la page : le carré unité est mis à l'échelle de la boîte. */
    expect(text).toContain(`q ${PAGE_WIDTH} 0 0 ${PAGE_HEIGHT} 0 0 cm /Im0 Do Q`)
  })

  it('déclare l’image en gris 8 bits, à ses dimensions', async () => {
    const text = latin1(await buildPdf([page(16, 24)], options))

    expect(text).toContain(
      '/Type /XObject /Subtype /Image /Width 16 /Height 24 /ColorSpace /DeviceGray /BitsPerComponent 8 ',
    )
  })

  it('refuse un PDF sans page plutôt que d’écrire un fichier vide', async () => {
    await expect(buildPdf([], options)).rejects.toThrow(/sans page/)
  })
})

describe('la table des références croisées', () => {
  /*
   * Le cœur du fichier. Un offset faux et aucun lecteur n'ouvre le PDF ; rien
   * dans le reste du fichier ne le dirait.
   */
  it('pointe chaque objet à son offset exact', async () => {
    const file = await buildPdf([page(8, 8), page(8, 8), page(8, 8)], options)
    const text = latin1(file)
    const offsets = xref(file)

    /* 1 catalogue + 1 nœud de pages + 3 objets par page. */
    expect(offsets).toHaveLength(2 + 3 * 3)

    offsets.forEach((offset, index) => {
      const id = index + 1
      expect(text.slice(offset, offset + `${id} 0 obj`.length), `objet ${id}`).toBe(`${id} 0 obj`)
    })
  })

  it('annonce autant d’entrées qu’il y a d’objets, l’entrée libre comprise', async () => {
    const text = latin1(await buildPdf([page(8, 8)], options))

    expect(text).toContain('xref\n0 6\n')
    expect(text).toContain('/Size 6')
    expect(text).toContain('0000000000 65535 f \n')
  })

  it('garde les offsets justes quand le flux est comprimé', async () => {
    const compress = browserCompressor()
    expect(compress, 'cette plateforme n’a pas CompressionStream').not.toBeNull()

    const file = await buildPdf([page(64, 64, 128), page(64, 64, 200)], {
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      compress,
    })
    const text = latin1(file)

    xref(file).forEach((offset, index) => {
      const id = index + 1
      expect(text.slice(offset, offset + `${id} 0 obj`.length), `objet ${id}`).toBe(`${id} 0 obj`)
    })
  })
})

describe('les octets de l’image', () => {
  it('écrit les niveaux tels quels quand il n’y a pas de filtre', async () => {
    const grey = page(4, 2, 77)
    const text = latin1(await buildPdf([grey], options))

    expect(text).not.toContain('/Filter')
    expect(text).toContain(`/Length ${grey.levels.length} >>\nstream\n`)
    expect(text).toContain(String.fromCharCode(77).repeat(8))
  })

  /*
   * `CompressionStream('deflate')` rend du zlib, qui est exactement ce que
   * `/FlateDecode` attend. Le flux est relu par `node:zlib` : si l'enveloppe
   * était du `deflate-raw`, le fichier s'écrirait sans erreur et aucun lecteur
   * ne l'ouvrirait.
   */
  it('comprime en zlib, et le flux se relit', async () => {
    const compress = browserCompressor()!
    const grey = page(32, 32, 42)
    const file = await buildPdf([grey], {
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      compress,
    })
    const text = latin1(file)

    expect(text).toContain('/Filter /FlateDecode ')

    const match = /\/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/.exec(text)!
    const start = match.index + match[0].length
    const length = Number(match[1])
    const stream = file.slice(start, start + length)

    expect([...inflateSync(stream)]).toEqual([...grey.levels])
  })

  it('allège le fichier plutôt que de l’alourdir', async () => {
    const grey = page(256, 256, 255)

    const plain = await buildPdf([grey], options)
    const packed = await buildPdf([grey], {
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      compress: browserCompressor(),
    })

    expect(packed.length).toBeLessThan(plain.length / 10)
  })
})
