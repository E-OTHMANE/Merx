/*
 * L'imprimante de laboratoire. E5-01 — niveau 3 et 4 du plan de test.
 *
 * Un serveur TCP sur le port 9100 qui se comporte comme une imprimante
 * thermique : il écoute, accepte le flux ESC/POS, le décode, et **écrit le
 * ticket en PNG**. On voit le ticket sans papier, sans rouleau, sans matériel.
 *
 * Deux usages :
 *
 *   `npm run printer:fake` sur cette machine, puis l'application dans le
 *   navigateur — non, justement : au navigateur il n'y a pas de socket. C'est
 *   donc l'APK sur une vraie tablette, `printer_address` réglé sur
 *   `<IP du PC>:9100`. C'est le seul test qui traverse le plugin, le socket
 *   Android et le Wi-Fi sans posséder d'imprimante.
 *
 *   Et pendant le développement, pour regarder la mise en page changer.
 *
 * **Le décodage est réécrit ici, exprès.** Il ne partage pas une ligne avec
 * `src/lib/printing/escpos.ts` : un décodeur bâti sur l'encodeur annulerait ses
 * propres erreurs — en-tête inversé encodé, en-tête inversé décodé, image juste
 * à l'écran et de travers sur le papier. Deux implémentations indépendantes,
 * c'est le seul moyen pour que le PNG prouve quelque chose.
 */

import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const PORT = Number(process.env.MERX_PRINTER_PORT ?? 9100)
const OUT_DIR = process.env.MERX_TICKET_DIR ?? join(tmpdir(), 'merx-tickets')
/* Un ticket qui n'arrive plus depuis 1,5 s est un ticket fini. */
const IDLE_MS = 1500

/* -------------------------------------------------------------------------- */
/* Décodage ESC/POS                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Lit le flux et rend les bandes trouvées, plus ce qui n'a pas été reconnu.
 * Tout ce qui n'est pas une commande connue est signalé : une imprimante
 * l'imprimerait comme du texte, et c'est précisément ce qu'on ne veut plus.
 */
function decode(bytes) {
  const bands = []
  const unknown = []
  let at = 0
  let resets = 0
  let cuts = 0
  let feeds = 0

  while (at < bytes.length) {
    const byte = bytes[at]

    if (byte === 0x1b && bytes[at + 1] === 0x40) {
      resets += 1
      at += 2
      continue
    }

    if (byte === 0x1b && bytes[at + 1] === 0x64) {
      feeds += bytes[at + 2] ?? 0
      at += 3
      continue
    }

    if (byte === 0x1d && bytes[at + 1] === 0x56) {
      cuts += 1
      // `GS V 66 n` fait quatre octets ; `GS V m` en fait trois.
      at += bytes[at + 2] === 0x42 ? 4 : 3
      continue
    }

    if (byte === 0x1d && bytes[at + 1] === 0x76 && bytes[at + 2] === 0x30) {
      const stride = bytes[at + 4] + bytes[at + 5] * 256
      const rows = bytes[at + 6] + bytes[at + 7] * 256
      const start = at + 8
      const end = start + stride * rows

      if (end > bytes.length) {
        unknown.push(`bande tronquée : ${bytes.length - start} octets sur ${stride * rows}`)
        break
      }

      bands.push({ stride, rows, dots: bytes.subarray(start, end) })
      at = end
      continue
    }

    unknown.push(`octet inattendu 0x${byte.toString(16)} en position ${at}`)
    at += 1
  }

  return { bands, unknown, resets, cuts, feeds }
}

/** Les bandes, mises bout à bout, en niveaux de gris (0 noir, 255 blanc). */
function toGreyscale(bands) {
  const stride = bands[0]?.stride ?? 0
  const height = bands.reduce((sum, band) => sum + band.rows, 0)
  const width = stride * 8
  const grey = new Uint8Array(width * height)
  grey.fill(255)

  let y = 0
  for (const band of bands) {
    if (band.stride !== stride) {
      throw new Error(`Deux largeurs dans un même ticket : ${stride} puis ${band.stride}.`)
    }
    for (let row = 0; row < band.rows; row += 1, y += 1) {
      for (let x = 0; x < width; x += 1) {
        const bit = band.dots[row * stride + (x >> 3)] & (0x80 >> (x & 7))
        if (bit !== 0) grey[y * width + x] = 0
      }
    }
  }

  return { width, height, grey }
}

/* -------------------------------------------------------------------------- */
/* PNG — en gris 8 bits, sans dépendance                                       */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0)
  return Buffer.concat([head, data, crc])
}

function png({ width, height, grey }) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // profondeur
  header[9] = 0 // gris
  // 10, 11, 12 : compression, filtre, entrelacement — tous à 0.

  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0 // aucun filtre sur la ligne
    Buffer.from(grey.subarray(y * width, (y + 1) * width)).copy(raw, y * (width + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* -------------------------------------------------------------------------- */
/* Le serveur                                                                  */
/* -------------------------------------------------------------------------- */

mkdirSync(OUT_DIR, { recursive: true })

let tickets = 0

const server = createServer((socket) => {
  const chunks = []
  let timer

  const finish = () => {
    clearTimeout(timer)
    if (chunks.length === 0) return

    const bytes = Buffer.concat(chunks)
    chunks.length = 0

    const { bands, unknown, resets, cuts, feeds } = decode(bytes)
    tickets += 1

    if (bands.length === 0) {
      console.log(`[${tickets}] ${bytes.length} octets, aucune bande reconnue.`)
      for (const problem of unknown) console.log(`    ${problem}`)
      return
    }

    const image = toGreyscale(bands)
    const file = join(OUT_DIR, `ticket-${String(tickets).padStart(3, '0')}.png`)
    writeFileSync(file, png(image))

    console.log(
      `[${tickets}] ${bytes.length} octets · ${bands.length} bande(s) · ` +
        `${image.width}×${image.height} points · init ${resets} · avance ${feeds} · coupe ${cuts}`,
    )
    console.log(`    ${file}`)
    for (const problem of unknown) console.log(`    ⚠ ${problem}`)
  }

  const idle = () => {
    clearTimeout(timer)
    timer = setTimeout(finish, IDLE_MS)
  }

  socket.on('data', (data) => {
    chunks.push(data)
    idle()
  })
  socket.on('end', finish)
  socket.on('error', (error) => console.log(`    ⚠ ${error.message}`))
})

server.listen(PORT, () => {
  console.log(`Imprimante de laboratoire sur le port ${PORT}.`)
  console.log(`Tickets écrits dans ${OUT_DIR}`)
  console.log("Règle `printer_address` sur <IP de cette machine>:" + PORT + ' depuis la tablette.')
})
