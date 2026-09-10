// Génère les icônes PWA : carré encre 600 (#2B3C99), X blanc.
// Le monogramme définitif est un point ouvert de BRAND-UI § 13 ; ceci est un
// placeholder tenu par le code plutôt que par un binaire opaque dans le dépôt.
//
//   node scripts/generate-icons.mjs

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const INK_600 = [0x2b, 0x3c, 0x99]
const WHITE = [0xff, 0xff, 0xff]

/** Distance d'un point à un segment. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

/** Couverture du X en (x, y), suréchantillonnée 4×4 pour un bord propre. */
function coverage(x, y, size) {
  const margin = size * 0.28
  const near = size - margin
  const halfStroke = size * 0.075
  const samples = 4
  let hits = 0

  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + 0.5) / samples
      const py = y + (sy + 0.5) / samples
      const d = Math.min(
        distanceToSegment(px, py, margin, margin, near, near),
        distanceToSegment(px, py, near, margin, margin, near),
      )
      if (d <= halfStroke) hits++
    }
  }

  return hits / (samples * samples)
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  let offset = 0
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0 // filtre « None »
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(x, y)
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 8 bits par canal
  ihdr[9] = 2 // couleur vraie, sans alpha
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function iconPixels(size) {
  return (x, y) => {
    const a = coverage(x, y, size)
    if (a === 0) return INK_600
    if (a === 1) return WHITE
    return INK_600.map((c, i) => Math.round(c + (WHITE[i] - c) * a))
  }
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

for (const size of [192, 512]) {
  const file = join(publicDir, `pwa-${size}.png`)
  writeFileSync(file, encodePng(size, iconPixels(size)))
  console.log(`écrit ${file}`)
}
