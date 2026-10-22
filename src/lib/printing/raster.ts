/*
 * De l'image du navigateur aux points de l'imprimante. E5-01.
 *
 * Une tête thermique n'a qu'un état par point : brûlé ou non. Il n'y a pas de
 * gris, donc pas de demi-teinte à négocier — chaque point tombe d'un côté ou de
 * l'autre d'un **seuil fixe**.
 *
 * **Pas de tramage**, et c'est la seule décision de ce fichier. Le tramage
 * (Floyd-Steinberg et compagnie) sert les photographies ; sur du texte de 24
 * points il ajoute du grain dans les contre-formes et rend les petits corps
 * illisibles (docs/research/E5-02-arabe-thermique.md § 3). Un ticket n'est que
 * du texte et des filets.
 */

import type { Raster } from '@/lib/printing/escpos'

/** La surface que lit `rasterize()` — le sous-ensemble d'`ImageData` utilisé. */
export interface Pixels {
  width: number
  height: number
  /** RGBA, quatre octets par point, ligne par ligne. */
  data: Uint8ClampedArray | Uint8Array
}

/**
 * Le seuil, en luminance 0–255 : en dessous, le point est noir.
 *
 * 160 et non 128 : les glyphes sortent du canvas avec des bords lissés, et un
 * seuil médian les amincit jusqu'à faire disparaître les traits fins d'une
 * lettre arabe à 203 points par pouce. Un seuil haut épaissit le texte, ce qui
 * est le bon défaut sur du papier thermique.
 *
 * **À juger sur du vrai papier** (docs/PENDING-CHECKS.md) : c'est le genre de
 * valeur qu'aucun écran ne permet de régler.
 */
export const BLACK_THRESHOLD = 160

/**
 * L'image en 1 bit, bit de poids fort à gauche, un bit à 1 pour un point noir.
 *
 * Les points transparents sont du papier : la composition se fait sur blanc,
 * sans quoi un canvas jamais rempli sortirait entièrement noir — l'erreur
 * coûte un rouleau.
 */
export function rasterize(pixels: Pixels, threshold = BLACK_THRESHOLD): Raster {
  const { width, height, data } = pixels

  if (width % 8 !== 0) {
    throw new Error(`Largeur de tête invalide : ${width} points n'est pas un multiple de 8.`)
  }
  if (data.length < width * height * 4) {
    throw new Error("L'image reçue est plus petite que ses dimensions.")
  }

  const stride = width / 8
  const dots = new Uint8Array(stride * height)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4
      const red = data[at] ?? 0
      const green = data[at + 1] ?? 0
      const blue = data[at + 2] ?? 0
      const alpha = (data[at + 3] ?? 0) / 255

      const ink = 0.299 * red + 0.587 * green + 0.114 * blue
      const onPaper = ink * alpha + 255 * (1 - alpha)

      if (onPaper < threshold) {
        const index = y * stride + (x >> 3)
        dots[index] = (dots[index] ?? 0) | (0x80 >> (x & 7))
      }
    }
  }

  return { width, height, dots }
}
