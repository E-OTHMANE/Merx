/*
 * Le ticket traverse un vrai socket. E5-01 — niveau 3 du plan de test.
 *
 * Un serveur TCP est levé sur un port libre, le transport lui envoie un ticket
 * entier, et le test **redécode** ce qui est arrivé pour le comparer à l'image
 * de départ. Ce qui s'y vérifie et qui ne se vérifie nulle part ailleurs : le
 * flux survit au découpage en lots, au passage en base64 et à la traversée du
 * réseau, octet pour octet, sans rien perdre ni rien dupliquer.
 *
 * Ce que ce niveau **ne** prouve pas, et il faut le dire : le socket est ici
 * celui de Node, pas celui du plugin Android. L'adaptateur ci-dessous est du
 * code de test — il fait en TypeScript ce que le plugin fait en Java. Le
 * chemin natif ne se mesure qu'avec l'APK sur une tablette, branché sur
 * `npm run printer:fake` (niveau 4, docs/PENDING-CHECKS.md).
 *
 * Le décodeur est écrit ici, et non repris de `escpos.ts` : un décodeur bâti
 * sur l'encodeur annulerait ses propres erreurs.
 */

import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { encodeTicket, type Raster } from '@/lib/printing/escpos'
import { socketTransport, type TcpSocketLike } from '@/lib/printing/transport'

/** Ce que le plugin fait en natif : un socket TCP, ouvert, écrit, fermé. */
function nodeSocket(): TcpSocketLike {
  const sockets = new Map<number, Socket>()
  let next = 1

  return {
    connect: ({ ipAddress, port }) =>
      new Promise((resolve, reject) => {
        const socket = createConnection({ host: ipAddress, port: port ?? 9100 })
        socket.once('connect', () => {
          const client = next++
          sockets.set(client, socket)
          resolve({ client })
        })
        socket.once('error', reject)
      }),

    send: ({ client, data }) =>
      new Promise((resolve, reject) => {
        const socket = sockets.get(client)
        if (socket === undefined) {
          reject(new Error(`Client inconnu : ${client}.`))
          return
        }
        socket.write(Buffer.from(data, 'base64'), (error) =>
          error === undefined || error === null ? resolve() : reject(error),
        )
      }),

    disconnect: ({ client }) =>
      new Promise((resolve) => {
        const socket = sockets.get(client)
        sockets.delete(client)
        if (socket === undefined) {
          resolve({ client })
          return
        }
        socket.end(() => resolve({ client }))
      }),
  }
}

interface Printer {
  port: number
  server: Server
  received: Promise<Buffer>
}

/** Une imprimante qui ne fait qu'une chose : garder ce qu'on lui a envoyé. */
async function listen(): Promise<Printer> {
  const chunks: Buffer[] = []
  let resolveReceived: (bytes: Buffer) => void
  const received = new Promise<Buffer>((resolve) => {
    resolveReceived = resolve
  })

  const server = createServer((socket) => {
    socket.on('data', (data: Buffer) => chunks.push(data))
    socket.on('end', () => resolveReceived(Buffer.concat(chunks)))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Port introuvable.')

  return { port: address.port, server, received }
}

/** Le flux, relu : les bandes `GS v 0` remises bout à bout. */
function decode(bytes: Buffer): { stride: number; rows: number; dots: Uint8Array; cuts: number } {
  const bands: Uint8Array[] = []
  let stride = 0
  let rows = 0
  let cuts = 0
  let at = 0

  while (at < bytes.length) {
    if (bytes[at] === 0x1b && bytes[at + 1] === 0x40) {
      at += 2
    } else if (bytes[at] === 0x1b && bytes[at + 1] === 0x64) {
      at += 3
    } else if (bytes[at] === 0x1d && bytes[at + 1] === 0x56) {
      cuts += 1
      at += bytes[at + 2] === 0x42 ? 4 : 3
    } else if (bytes[at] === 0x1d && bytes[at + 1] === 0x76 && bytes[at + 2] === 0x30) {
      const bandStride = (bytes[at + 4] ?? 0) + (bytes[at + 5] ?? 0) * 256
      const bandRows = (bytes[at + 6] ?? 0) + (bytes[at + 7] ?? 0) * 256
      const start = at + 8
      const end = start + bandStride * bandRows

      expect(end, 'bande tronquée').toBeLessThanOrEqual(bytes.length)
      if (stride === 0) stride = bandStride
      expect(bandStride).toBe(stride)

      bands.push(bytes.subarray(start, end))
      rows += bandRows
      at = end
    } else {
      throw new Error(`Octet inattendu 0x${(bytes[at] ?? 0).toString(16)} en position ${at}.`)
    }
  }

  const dots = new Uint8Array(stride * rows)
  let offset = 0
  for (const band of bands) {
    dots.set(band, offset)
    offset += band.length
  }

  return { stride, rows, dots, cuts }
}

/** Une image reconnaissable : un seul point noir par ligne, qui se déplace. */
function diagonal(width: number, height: number): Raster {
  const stride = width / 8
  const dots = new Uint8Array(stride * height)
  for (let y = 0; y < height; y += 1) {
    const x = y % width
    const index = y * stride + (x >> 3)
    dots[index] = (dots[index] ?? 0) | (0x80 >> (x & 7))
  }
  return { width, height, dots }
}

const printers: Printer[] = []

afterEach(async () => {
  for (const printer of printers.splice(0)) {
    await new Promise<void>((resolve) => printer.server.close(() => resolve()))
  }
})

async function printer(): Promise<Printer> {
  const next = await listen()
  printers.push(next)
  return next
}

const noPause = async (): Promise<void> => undefined

describe('un ticket envoyé sur un socket', () => {
  it('arrive entier, et se redécode à l’identique', async () => {
    const source = diagonal(576, 450)
    const lab = await printer()

    await socketTransport(nodeSocket(), noPause).send('127.0.0.1', lab.port, encodeTicket(source))

    const { stride, rows, dots, cuts } = decode(await lab.received)

    expect(stride).toBe(72)
    expect(rows).toBe(450)
    expect(cuts).toBe(1)
    expect([...dots]).toEqual([...source.dots])
  })

  /*
   * Un ticket de 60 lignes dépasse le lot maximal : c'est le cas où le
   * découpage, la base64 et le réseau ont chacun une occasion de perdre
   * quelque chose, et où rien ne le dirait — l'imprimante s'arrêterait au
   * milieu du ticket.
   */
  it('survit à un ticket plus long qu’un lot', async () => {
    const source = diagonal(576, 5000)
    const batches = encodeTicket(source)
    expect(batches.length).toBeGreaterThan(1)

    const lab = await printer()
    await socketTransport(nodeSocket(), noPause).send('127.0.0.1', lab.port, batches)

    const { rows, dots } = decode(await lab.received)
    expect(rows).toBe(5000)
    expect([...dots]).toEqual([...source.dots])
  })

  /*
   * Une imprimante éteinte, une adresse fausse, un Wi-Fi qui a changé de
   * réseau : le refus est immédiat et porte un message. C'est l'échec que
   * l'écran transforme en « le bon est enregistré, vous pouvez réimprimer ».
   */
  it('refuse une adresse qui n’écoute pas, sans attendre', async () => {
    const lab = await printer()
    await new Promise<void>((resolve) => lab.server.close(() => resolve()))

    await expect(
      socketTransport(nodeSocket(), noPause).send('127.0.0.1', lab.port, [Uint8Array.of(0x1b)]),
    ).rejects.toThrow()
  })
})
