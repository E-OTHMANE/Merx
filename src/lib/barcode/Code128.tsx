/*
 * Le dessin d'un Code 128. E2-06.
 *
 * Du SVG, pas du canvas : une planche A4 sort de l'imprimante à 300 ou 600 dpi,
 * et un canvas s'imprime à la résolution de l'écran — des barres de 0,33 mm en
 * ressortent floues, donc illisibles à la douchette. Le SVG, lui, est redessiné
 * par l'imprimante à sa propre résolution.
 *
 * Dimensions en millimètres, `viewBox` en modules : le composant reçoit la
 * largeur qu'on lui donne sur l'étiquette et répartit les modules dedans.
 * Aucun nombre magique en pixels — une étiquette se mesure en millimètres, et
 * c'est la seule unité qu'une imprimante respecte.
 */

import { code128Width, encodeCode128 } from '@/lib/barcode/encode'

interface Code128Props {
  /** La valeur à encoder — un SKU, un EAN. */
  value: string
  /** Largeur du dessin, en millimètres. */
  widthMm: number
  /** Hauteur des barres, en millimètres. */
  heightMm: number
}

/**
 * Rend le code, ou rien du tout si la valeur ne s'encode pas — vide, ou hors de
 * l'imprimable ASCII (SPEC § 2.6 : la fonctionnalité se désactive en silence).
 */
export function Code128({ value, widthMm, heightMm }: Code128Props) {
  const code = encodeCode128(value)
  if (code === null) return null

  const total = code128Width(code)

  /*
   * Les barres, une paire de modules à la fois. L'indice pair est une barre,
   * l'impair un espace : on n'en dessine que les barres, le fond de
   * l'étiquette faisant les espaces. Un rectangle par barre plutôt qu'un
   * chemin unique — c'est plus long à lire dans le DOM, et exactement aussi
   * juste à l'impression.
   */
  const bars: Array<{ x: number; width: number }> = []
  let x = 0
  code.modules.forEach((width, index) => {
    if (index % 2 === 0) bars.push({ x, width })
    x += width
  })

  return (
    <svg
      // `viewBox` en modules : la mise à l'échelle est affaire de l'imprimante.
      viewBox={`0 0 ${total} 1`}
      preserveAspectRatio="none"
      width={`${widthMm}mm`}
      height={`${heightMm}mm`}
      // Le code est déjà écrit en clair sous les barres, dans l'étiquette.
      aria-hidden="true"
      focusable="false"
      shapeRendering="crispEdges"
    >
      {bars.map((bar) => (
        <rect key={bar.x} x={bar.x} y={0} width={bar.width} height={1} fill="#000000" />
      ))}
    </svg>
  )
}
