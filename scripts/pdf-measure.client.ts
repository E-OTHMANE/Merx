/*
 * La page qui mesure le PDF. E5-03 — outil de développement, pas du code livré.
 *
 * Pourquoi une page et non un test : la taille du fichier dépend des **pixels**
 * que le navigateur dessine — l'anticrénelage des glyphes est ce que `deflate`
 * comprime —, et jsdom n'a pas de contexte 2D. Un chiffre obtenu autrement
 * serait une estimation présentée comme une mesure.
 *
 * `scripts/pdf-measure.mjs` sert cette page à un Chrome sans fenêtre, lit
 * `window.__merxPdf` et écrit les PDF sur le disque — qui servent aussi à la
 * vérification à l'œil, sur un téléphone (`docs/PENDING-CHECKS.md`).
 */

import {
  PAGE_FONT_SPECS,
  PAGE_SCALE,
  buildDocumentPdf,
  layoutDocumentPages,
  loadFonts,
  paint,
  type PageDocument,
  type PageLine,
} from '@/lib/printing'

const line = (n: number): PageLine => ({
  label: `Savon de Marseille 500 g — lot ${n}`,
  quantity: '24.000',
  unitPrice: '9.50',
  lineTotal: '228.00',
})

/** Un bon réaliste : en-tête rempli, noms longs, montants à quatre chiffres. */
function bon(lines: number): PageDocument {
  return {
    businessName: 'Parfumerie Nour',
    phone: '+212 6 12 34 56 78',
    address: '14, rue de Derb Omar, Casablanca',
    title: 'Bon de livraison',
    number: 'BL-A-26-00042',
    issuedAt: '2026-10-20T13:42:00.000Z',
    clientName: 'Hassan Alami',
    lines: Array.from({ length: lines }, (_, index) => line(index + 1)),
    subtotal: `${lines * 228}.00`,
    discountTotal: '0.00',
    total: `${lines * 228}.00`,
    notes: '',
  }
}

/** Le même en arabe : les glyphes liés portent plus d'encre, donc plus d'octets. */
function arabe(lines: number): PageDocument {
  return {
    ...bon(lines),
    businessName: 'عطور نور',
    address: 'درب عمر، الدار البيضاء',
    clientName: 'حسن العلمي',
    lines: Array.from({ length: lines }, (_, index) => ({
      ...line(index + 1),
      label: `صابون مرسيليا 500 غرام — دفعة ${index + 1}`,
    })),
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Le nombre de pages, relu dans le fichier produit. */
function countPages(bytes: Uint8Array): number {
  let text = ''
  for (const byte of bytes.slice(0, 2048)) text += String.fromCharCode(byte)
  return Number(/\/Count (\d+)/.exec(text)?.[1] ?? 0)
}

export interface Measurement {
  name: string
  scale: number
  lines: number
  pages: number
  bytes: number
  base64: string
}

export interface Preview {
  name: string
  width: number
  height: number
  /** La page en PNG, pour la regarder — un PDF ne se regarde pas en console. */
  png: string
}

/**
 * Un apercu PNG de la premiere page.
 *
 * Le dessin est refait ici plutot que repris de `renderDocumentPages()`, qui
 * rend des niveaux de gris : un PNG se sort du canvas, pas d'un tableau
 * d'octets. C'est le seul endroit du depot qui duplique les trois lignes de
 * mise a l'echelle, et c'est un outil, pas du code livre.
 */
async function preview(name: string, doc: PageDocument): Promise<Preview> {
  const ruler = document.createElement('canvas')
  const measuring = ruler.getContext('2d')!

  const layout = layoutDocumentPages(doc, {
    measure: (text, font) => {
      measuring.font = font
      return measuring.measureText(text).width
    },
  })

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(layout.width * PAGE_SCALE)
  canvas.height = Math.round(layout.height * PAGE_SCALE)

  const context = canvas.getContext('2d')!
  context.scale(PAGE_SCALE, PAGE_SCALE)
  paint(context, {
    width: layout.width,
    height: layout.height,
    direction: layout.direction,
    ops: layout.pages[0] ?? [],
  })

  return {
    name,
    width: canvas.width,
    height: canvas.height,
    png: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''),
  }
}

const CASES: Array<[string, (lines: number) => PageDocument, number]> = [
  ['une-page', bon, 5],
  ['deux-pages', bon, 10],
  ['arabe', arabe, 5],
]

async function measure(): Promise<{ measured: Measurement[]; previews: Preview[] }> {
  /*
   * Sans cette attente, le premier rendu mesurerait une police de repli : donc
   * d'autres pixels, donc une autre taille, et des largeurs fausses.
   */
  await document.fonts.ready
  await loadFonts(PAGE_FONT_SPECS)

  const results: Measurement[] = []

  for (const scale of [1, 1.5, 2, 3]) {
    for (const [name, build, lines] of CASES) {
      const bytes = await buildDocumentPdf(build(lines), { scale })
      results.push({
        name,
        scale,
        lines,
        pages: countPages(bytes),
        bytes: bytes.length,
        base64: toBase64(bytes),
      })
    }
  }

  const previews = [await preview('une-page', bon(5)), await preview('arabe', arabe(5))]

  return { measured: results, previews }
}

declare global {
  interface Window {
    __merxPdf?: { measured: Measurement[]; previews: Preview[] } | { error: string }
  }
}

measure().then(
  (results) => {
    window.__merxPdf = results
  },
  (error: unknown) => {
    window.__merxPdf = { error: error instanceof Error ? error.message : String(error) }
  },
)
