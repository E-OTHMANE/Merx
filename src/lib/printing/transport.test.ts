/*
 * Le transport. E5-01.
 *
 * Ce que ce fichier mesure est la **discipline** du socket : l'ordre des lots,
 * la temporisation entre deux, la fermeture même après un échec, et le délai
 * au-delà duquel une imprimante est déclarée absente. Le socket lui-même est
 * natif : il ne s'exécute que dans l'enveloppe Android, et il se vérifie en
 * branchant un vrai appareil sur l'imprimante de laboratoire
 * (`npm run printer:fake`) — niveau 4 du plan de test, docs/PENDING-CHECKS.md.
 *
 * La dernière assertion est celle qui tient la RÈGLE de SPEC § 2.7 : au
 * navigateur, il n'y a pas de transport. Pas « un transport qui échoue » — pas
 * de transport.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { toBase64 } from '@/lib/printing/escpos'
import {
  BATCH_PAUSE_MS,
  FINISH_PAUSE_MS,
  nativeTransport,
  socketTransport,
  type TcpSocketLike,
} from '@/lib/printing/transport'

interface Recorder {
  socket: TcpSocketLike
  connects: { ipAddress: string; port?: number }[]
  sent: string[]
  disconnects: number[]
  pauses: number[]
  pause: (ms: number) => Promise<void>
}

function recorder(overrides: Partial<TcpSocketLike> = {}): Recorder {
  const connects: { ipAddress: string; port?: number }[] = []
  const sent: string[] = []
  const disconnects: number[] = []
  const pauses: number[] = []

  const socket: TcpSocketLike = {
    connect: async (options) => {
      connects.push(options)
      return { client: 7 }
    },
    send: async ({ data }) => {
      sent.push(data)
    },
    disconnect: async ({ client }) => {
      disconnects.push(client)
      return { client }
    },
    ...overrides,
  }

  return {
    socket,
    connects,
    sent,
    disconnects,
    pauses,
    pause: async (ms) => {
      pauses.push(ms)
    },
  }
}

const BATCHES = [Uint8Array.of(0x1b, 0x40), Uint8Array.of(0x1d, 0x76, 0x30, 0x00)]

afterEach(() => {
  vi.useRealTimers()
})

describe('le socket', () => {
  it('ouvre sur l’adresse et le port donnés', async () => {
    const r = recorder()
    await socketTransport(r.socket, r.pause).send('192.168.1.50', 9100, BATCHES)

    expect(r.connects).toEqual([{ ipAddress: '192.168.1.50', port: 9100 }])
  })

  it('envoie chaque lot, dans l’ordre, en base64', async () => {
    const r = recorder()
    await socketTransport(r.socket, r.pause).send('10.0.0.9', 9100, BATCHES)

    expect(r.sent).toEqual(BATCHES.map(toBase64))
  })

  /*
   * Écrire plus vite que l'imprimante n'imprime lui fait perdre des octets : le
   * ticket sort brouillé ou s'arrête au milieu (recherche § 3). La pause finale
   * laisse la coupe s'achever avant que le socket ne se ferme.
   */
  it('temporise entre les lots, et après le dernier', async () => {
    const r = recorder()
    await socketTransport(r.socket, r.pause).send('10.0.0.9', 9100, BATCHES)

    expect(r.pauses).toEqual([BATCH_PAUSE_MS, BATCH_PAUSE_MS, FINISH_PAUSE_MS])
  })

  it('ferme le socket après le ticket', async () => {
    const r = recorder()
    await socketTransport(r.socket, r.pause).send('10.0.0.9', 9100, BATCHES)

    expect(r.disconnects).toEqual([7])
  })

  /*
   * Une imprimante thermique n'accepte **qu'une** connexion : un socket laissé
   * ouvert après un échec fait échouer toutes les impressions suivantes, et
   * l'imprimante passe pour cassée.
   */
  it('ferme le socket même quand l’écriture échoue', async () => {
    const r = recorder({
      send: async () => {
        throw new Error('Connexion perdue.')
      },
    })

    await expect(
      socketTransport(r.socket, r.pause).send('10.0.0.9', 9100, BATCHES),
    ).rejects.toThrow('Connexion perdue.')
    expect(r.disconnects).toEqual([7])
  })

  it('laisse passer l’échec d’ouverture tel quel', async () => {
    const r = recorder({
      connect: async () => {
        throw new Error('Connexion refusée.')
      },
    })

    await expect(
      socketTransport(r.socket, r.pause).send('10.0.0.9', 9100, BATCHES),
    ).rejects.toThrow('Connexion refusée.')
    expect(r.disconnects).toEqual([])
  })

  /*
   * Le plugin n'expose aucun délai sur `connect()`, et le socket Android attend
   * de lui-même plus d'une minute : le vendeur resterait devant un bouton qui
   * tourne, au comptoir, avec un client en face.
   */
  it('renonce quand l’imprimante ne répond pas', async () => {
    vi.useFakeTimers()
    const r = recorder({ connect: () => new Promise(() => undefined) })

    const printing = socketTransport(r.socket, r.pause).send('10.0.0.9', 9100, BATCHES)
    const assertion = expect(printing).rejects.toThrow(/ne répond pas/)

    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
    expect(r.sent).toEqual([])
  })
})

describe('hors de l’enveloppe', () => {
  /*
   * SPEC § 2.7 : au navigateur, il n'y a pas de socket TCP, donc pas de
   * transport — et l'écran n'offre pas le bouton plutôt que de proposer une
   * impression qui échouera. Les tests tournent en jsdom, c'est-à-dire
   * exactement ce cas.
   */
  it('ne rend aucun transport au navigateur', () => {
    expect(nativeTransport()).toBeNull()
  })
})
