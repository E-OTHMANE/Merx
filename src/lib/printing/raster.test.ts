/*
 * Le seuillage en 1 bit. E5-01.
 *
 * Deux choses s'y jouent, et chacune coûte un rouleau de papier quand elle est
 * fausse : l'ordre des bits — un bit inversé imprime le négatif de la ligne —
 * et le sort des points transparents, qui sont du papier et non de l'encre.
 */

import { describe, expect, it } from 'vitest'

import { BLACK_THRESHOLD, rasterize, type Pixels } from '@/lib/printing/raster'

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
