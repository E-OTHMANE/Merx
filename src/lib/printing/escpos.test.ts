/*
 * L'encodeur ESC/POS, octet par octet. E5-01.
 *
 * C'est le niveau de test qui n'a besoin de rien : ni canvas, ni réseau, ni
 * imprimante. Un flux ESC/POS est une suite d'octets, et une suite d'octets
 * s'asserte. Ce qui ne se vérifie pas ici — qu'une imprimante réelle accepte
 * `GS v 0`, et sur quelle largeur de tête — est dans docs/PENDING-CHECKS.md.
 */

import { describe, expect, it } from 'vitest'

import {
  INITIALIZE,
  MAX_BATCH_BYTES,
  encodeTicket,
  feedAndCut,
  rasterBand,
  ticketCommands,
  toBase64,
  type Raster,
} from '@/lib/printing/escpos'

/** Une image unie, dont chaque octet porte le numéro de sa ligne. */
function raster(width: number, height: number): Raster {
  const stride = width / 8
  const dots = new Uint8Array(stride * height)
  for (let row = 0; row < height; row += 1) {
    dots.fill(row & 0xff, row * stride, (row + 1) * stride)
  }
  return { width, height, dots }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const all = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return all
}

describe('les commandes', () => {
  it('réinitialise par ESC @', () => {
    expect([...INITIALIZE]).toEqual([0x1b, 0x40])
  })

  /*
   * `GS v 0 m xL xH yL yH` : `x` compte des **octets** par ligne, `y` des
   * lignes, chacun sur deux octets, poids faible d'abord. Une inversion des
   * deux octets passe inaperçue tant que la valeur tient sur un octet — d'où
   * les 300 lignes ci-dessous, qui débordent.
   */
  it('décrit la bande dans son en-tête, poids faible d’abord', () => {
    const band = rasterBand(raster(576, 300), 0, 300)

    expect([...band.subarray(0, 8)]).toEqual([
      0x1d,
      0x76,
      0x30,
      0x00,
      72, // 576 points = 72 octets par ligne
      0,
      300 & 0xff, // 44
      300 >> 8, // 1
    ])
    expect(band.length).toBe(8 + 72 * 300)
  })

  it('emporte exactement les lignes demandées, et dans l’ordre', () => {
    const band = rasterBand(raster(576, 400), 200, 200)
    const payload = band.subarray(8)

    expect(payload[0]).toBe(200)
    expect(payload[72]).toBe(201)
    expect(payload[payload.length - 1]).toBe(399 & 0xff)
  })

  it('refuse une bande hors de l’image plutôt que d’envoyer du vide', () => {
    expect(() => rasterBand(raster(576, 10), 5, 10)).toThrow(/hors de l/)
  })

  /* 576, 512 et 384 sont des multiples de 8 ; une tête fantaisiste ne l'est pas. */
  it('refuse une largeur qui n’est pas un multiple de 8', () => {
    expect(() => rasterBand(raster(576, 1), 0, 1)).not.toThrow()
    expect(() => rasterBand({ width: 570, height: 1, dots: new Uint8Array(72) }, 0, 1)).toThrow(
      /multiple de 8/,
    )
  })

  /*
   * L'avance avant la coupe : sans elle, la coupe tombe dans la dernière ligne
   * imprimée et le client reçoit son total tranché.
   */
  it('avance le papier avant de couper', () => {
    expect([...feedAndCut(4)]).toEqual([0x1b, 0x64, 4, 0x1d, 0x56, 0x42, 0x00])
  })
})

describe('le ticket', () => {
  it('se découpe en bandes d’au plus 200 lignes, dans l’ordre', () => {
    const commands = ticketCommands(raster(576, 450))

    // init + 3 bandes + coupe
    expect(commands.length).toBe(5)
    expect([...(commands[0] ?? [])]).toEqual([0x1b, 0x40])

    const heights = commands.slice(1, 4).map((band) => (band[6] ?? 0) + ((band[7] ?? 0) << 8))
    expect(heights).toEqual([200, 200, 50])

    expect([...(commands[4] ?? [])]).toEqual([0x1b, 0x64, 4, 0x1d, 0x56, 0x42, 0x00])
  })

  it('n’oublie aucune ligne, quelle que soit la hauteur', () => {
    for (const height of [1, 8, 199, 200, 201, 1000]) {
      const commands = ticketCommands(raster(576, height))
      const rows = commands
        .slice(1, -1)
        .reduce((sum, band) => sum + (band[6] ?? 0) + ((band[7] ?? 0) << 8), 0)
      expect(rows, `hauteur ${height}`).toBe(height)
    }
  })
})

describe('les lots', () => {
  /*
   * La propriété qui compte : une commande n'est **jamais** coupée en deux. Une
   * bande tronquée laisse l'imprimante attendre des points qui ne viendront
   * pas, et elle n'en sort qu'éteinte — l'incident se lit comme une imprimante
   * en panne, pas comme un lot mal calculé.
   */
  it('ne coupe jamais une commande en deux', () => {
    const image = raster(576, 8000)
    const batches = encodeTicket(image)

    expect(batches.length).toBeGreaterThan(1)

    // Chaque lot commence sur un début de commande connu.
    for (const batch of batches) {
      const head = [...batch.subarray(0, 3)]
      const starts =
        (head[0] === 0x1b && head[1] === 0x40) ||
        (head[0] === 0x1d && head[1] === 0x76 && head[2] === 0x30) ||
        (head[0] === 0x1b && head[1] === 0x64)
      expect(starts, `lot commençant par ${head.join(' ')}`).toBe(true)
    }
  })

  it('tient sous la taille maximale', () => {
    for (const batch of encodeTicket(raster(576, 8000))) {
      expect(batch.length).toBeLessThanOrEqual(MAX_BATCH_BYTES)
    }
  })

  it('transporte le flux entier, dans l’ordre', () => {
    const image = raster(576, 1000)
    expect([...concat(encodeTicket(image))]).toEqual([...concat(ticketCommands(image))])
  })

  it('tient un ticket court en un seul lot', () => {
    expect(encodeTicket(raster(576, 200)).length).toBe(1)
  })
})

describe('le passage en base64', () => {
  /*
   * Le plugin natif ne transporte que du texte : les octets passent en base64.
   * Au-delà de 32 768 octets, `String.fromCharCode(...bytes)` dépasse la pile
   * d'arguments — un ticket complet pèse davantage.
   */
  it('encode une image entière sans déborder la pile', () => {
    const bytes = new Uint8Array(100_000)
    for (let at = 0; at < bytes.length; at += 1) bytes[at] = at & 0xff

    const decoded = atob(toBase64(bytes))
    expect(decoded.length).toBe(bytes.length)
    expect(decoded.charCodeAt(0)).toBe(0)
    expect(decoded.charCodeAt(99_999)).toBe(99_999 & 0xff)
  })
})
