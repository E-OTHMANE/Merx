/*
 * Le seuillage en 1 bit (E5-01) et les niveaux de gris (E5-03).
 *
 * Deux choses s'y jouent, et chacune coûte un rouleau de papier quand elle est
 * fausse : l'ordre des bits — un bit inversé imprime le négatif de la ligne —
 * et le sort des points transparents, qui sont du papier et non de l'encre.
 *
 * Le second vaut pour les deux chemins, et c'est le pire des deux qu'il tient :
 * un canvas jamais rempli sortirait une page **entièrement noire**. Sur le
 * rouleau cela gâche du papier ; dans un PDF cela part chez le client.
 */

import { describe, expect, it } from 'vitest'

import { BLACK_THRESHOLD, grayscale, rasterize, type Pixels } from '@/lib/printing/raster'

/** Une image RGBA uniforme, puis retouchée point par point par le test. */
function pixels(width: number, height: number, fill: [number, number, number, number]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let at = 0; at < data.length; at += 4) {
    data[at] = fill[0]
    data[at + 1] = fill[1]
    data[at + 2] = fill[2]
    data[at + 3] = fill[3]
  }
  return { width, height, data }
}

function set(image: Pixels, x: number, y: number, grey: number): void {
  const at = (y * image.width + x) * 4
  image.data[at] = grey
  image.data[at + 1] = grey
  image.data[at + 2] = grey
  image.data[at + 3] = 255
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255]
const BLACK: [number, number, number, number] = [0, 0, 0, 255]

describe('le seuillage', () => {
  it('ne pose aucun point sur du papier blanc', () => {
    const { dots } = rasterize(pixels(16, 2, WHITE))
    expect([...dots]).toEqual([0, 0, 0, 0])
  })

  it('noircit tout sur du noir', () => {
    const { dots } = rasterize(pixels(16, 2, BLACK))
    expect([...dots]).toEqual([0xff, 0xff, 0xff, 0xff])
  })

  /*
   * Bit de poids fort à gauche : c'est ce que `GS v 0` attend. Inverser l'ordre
   * imprime chaque octet en miroir — huit points à la fois, ce qui ressemble à
   * une police cassée plutôt qu'à un encodage inversé.
   */
  it('met le premier point dans le bit de poids fort', () => {
    const image = pixels(16, 1, WHITE)
    set(image, 0, 0, 0)
    set(image, 7, 0, 0)
    set(image, 8, 0, 0)

    const { dots } = rasterize(image)
    expect(dots[0]).toBe(0x80 | 0x01)
    expect(dots[1]).toBe(0x80)
  })

  it('range les lignes les unes après les autres', () => {
    const image = pixels(16, 3, WHITE)
    set(image, 0, 2, 0)

    const { dots } = rasterize(image)
    expect([...dots]).toEqual([0, 0, 0, 0, 0x80, 0])
  })

  /* Le seuil est fixe, et c'est la décision : pas de tramage sur du texte. */
  it('tranche au seuil, sans demi-teinte', () => {
    const image = pixels(8, 1, WHITE)
    set(image, 0, 0, BLACK_THRESHOLD - 1)
    set(image, 1, 0, BLACK_THRESHOLD)
    set(image, 2, 0, BLACK_THRESHOLD + 1)

    const { dots } = rasterize(image)
    expect(dots[0]).toBe(0x80)
  })

  /*
   * Un canvas neuf est transparent. Sans composition sur blanc, une image
   * jamais remplie sortirait **entièrement noire** — le ticket de 60 lignes
   * qu'on imprime en aplat, et le rouleau qui part avec.
   */
  it('traite le transparent comme du papier', () => {
    const { dots } = rasterize(pixels(16, 2, [0, 0, 0, 0]))
    expect([...dots]).toEqual([0, 0, 0, 0])
  })

  it('compose un noir à moitié transparent sur le blanc', () => {
    const image = pixels(8, 1, WHITE)
    const at = 0
    image.data[at] = 0
    image.data[at + 1] = 0
    image.data[at + 2] = 0
    image.data[at + 3] = 128 // 0 × 0,5 + 255 × 0,5 = 127,5 < 160

    expect(rasterize(image).dots[0]).toBe(0x80)
  })

  it('refuse une largeur qui n’est pas une largeur de tête', () => {
    expect(() => rasterize(pixels(10, 1, WHITE))).toThrow(/multiple de 8/)
  })

  it('refuse une image plus petite que ses dimensions', () => {
    expect(() => rasterize({ width: 16, height: 4, data: new Uint8ClampedArray(16) })).toThrow(
      /plus petite/,
    )
  })

  it('rend la largeur et la hauteur reçues', () => {
    const image = rasterize(pixels(576, 32, WHITE))
    expect(image.width).toBe(576)
    expect(image.height).toBe(32)
    expect(image.dots.length).toBe(72 * 32)
  })
})

describe('les niveaux de gris du PDF', () => {
  /*
   * Pourquoi un second chemin plutôt que `rasterize()` : un écran a des gris,
   * une tête thermique non. Un corps de 24 points seuillé en 1 bit sort crénelé
   * sur un téléphone, là où l'anticrénelage est précisément ce qui le rend
   * lisible sans zoomer.
   */
  it('garde les demi-teintes que le seuil écraserait', () => {
    const image = pixels(4, 1, WHITE)
    set(image, 0, 0, 0)
    set(image, 1, 0, 100)
    set(image, 2, 0, 200)

    expect([...grayscale(image).levels]).toEqual([0, 100, 200, 255])
    /* Le seuil, lui, ne connaît que deux états : 100 et 200 tombent de part et d'autre. */
    expect([...rasterize(pixels(8, 1, WHITE)).dots]).toEqual([0])
  })

  it('pèse la luminance comme l’œil, non comme la moyenne', () => {
    const image = pixels(1, 1, [0, 255, 0, 255])
    /* 0,587 × 255 = 149,7 : le vert est clair, le bleu presque noir. */
    expect(grayscale(image).levels[0]).toBe(150)

    expect(grayscale(pixels(1, 1, [0, 0, 255, 255])).levels[0]).toBe(29)
  })

  /*
   * **Le garde qui compte.** Un canvas neuf est transparent, et un point
   * transparent n'a pas de luminance : sans composition sur blanc, toute la
   * page basculerait à 0 — un A4 noir envoyé à un client, et un fichier
   * beaucoup plus lourd par-dessus.
   */
  it('traite le transparent comme du papier', () => {
    const empty = pixels(8, 4, [0, 0, 0, 0])
    expect([...grayscale(empty).levels]).toEqual(Array.from({ length: 32 }, () => 255))
  })

  it('compose un noir à moitié transparent sur le blanc', () => {
    /* 255 × (1 − 128/255) = 127 : l'opacité se lit sur 255, pas sur 256. */
    const image = pixels(1, 1, [0, 0, 0, 128])
    expect(grayscale(image).levels[0]).toBe(127)
  })

  it('rend un octet par point, aux dimensions reçues', () => {
    const grey = grayscale(pixels(32, 8, WHITE))
    expect([grey.width, grey.height, grey.levels.length]).toEqual([32, 8, 256])
  })

  /* Pas de contrainte de multiple de 8 ici : ce n'est pas une tête d'imprimante. */
  it('accepte une largeur quelconque', () => {
    expect(grayscale(pixels(595, 2, WHITE)).levels.length).toBe(1190)
  })

  it('refuse une image plus petite que ses dimensions', () => {
    expect(() => grayscale({ width: 16, height: 4, data: new Uint8ClampedArray(16) })).toThrow(
      /plus petite/,
    )
  })
})
