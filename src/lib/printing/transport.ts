/*
 * Le transport : les octets jusqu'au port 9100. E5-01 — SPEC § 2.7.
 *
 * C'est le fichier qui justifie l'enveloppe Capacitor. Un navigateur n'ouvre
 * pas de socket TCP ; `nativeTransport()` rend donc `null` hors de
 * l'enveloppe, et tout l'écran en découle : l'impression thermique ne s'offre
 * pas plutôt que d'échouer (SPEC § 2.6 et § 2.7).
 *
 * Le plugin `capacitor-tcp-socket` est un transport nu — connecter, envoyer,
 * fermer — et c'est pour cela qu'il a été retenu : l'ESC/POS, la mise en page
 * et l'arabe restent ici, en TypeScript, où ils se testent. Un plugin qui
 * encoderait le ticket lui-même déciderait aussi de l'arabe, ce qu'aucun ne
 * sait faire.
 */

import { Capacitor } from '@capacitor/core'
import { DataEncoding, TcpSocket, type TcpSocketPlugin } from 'capacitor-tcp-socket'

import { toBase64 } from '@/lib/printing/escpos'

/** Ce que l'impression attend d'un transport, et rien de plus. */
export interface PrinterTransport {
  send(host: string, port: number, batches: Uint8Array[]): Promise<void>
}

/** La part du plugin que ce fichier emploie — ce qu'un doublon doit fournir. */
export type TcpSocketLike = Pick<TcpSocketPlugin, 'connect' | 'send' | 'disconnect'>

/**
 * Le délai d'ouverture du socket.
 *
 * Le plugin n'expose aucun délai sur `connect()`, et le socket Android attend
 * de lui-même plus d'une minute sur une adresse qui ne répond pas : le vendeur
 * resterait devant un bouton qui tourne. 15 secondes, parce qu'une imprimante
 * Wi-Fi en veille met plusieurs secondes à se réveiller (recherche § 6) — un
 * délai court la déclarerait absente alors qu'elle arrive.
 */
export const CONNECT_TIMEOUT_MS = 15_000

/**
 * La temporisation entre deux lots, et après le dernier.
 *
 * Une imprimante bon marché perd des octets quand on écrit plus vite qu'elle
 * n'imprime : le ticket sort brouillé ou s'arrête au milieu. Les valeurs sont
 * celles des bibliothèques qui marchent (recherche § 3) ; la pause finale
 * laisse la coupe s'achever avant que le socket ne se ferme.
 */
export const BATCH_PAUSE_MS = 50
export const FINISH_PAUSE_MS = 300

export type Pause = (ms: number) => Promise<void>

const realPause: Pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** « L'imprimante ne répond pas » plutôt qu'une attente sans fin. */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Un transport au-dessus d'un socket TCP.
 *
 * Le socket est ouvert pour un ticket et refermé après — pas de connexion
 * gardée : entre deux ventes, une imprimante qui s'endort ou un Wi-Fi qui
 * change d'IP laisseraient un socket mort dont rien ne dit qu'il l'est. Et le
 * `finally` ferme même quand l'écriture a échoué, sans quoi l'imprimante
 * refuserait la connexion suivante : elle n'en accepte qu'une.
 */
export function socketTransport(socket: TcpSocketLike, pause: Pause = realPause): PrinterTransport {
  return {
    async send(host, port, batches) {
      const { client } = await withTimeout(
        socket.connect({ ipAddress: host, port }),
        CONNECT_TIMEOUT_MS,
        "L'imprimante ne répond pas.",
      )

      try {
        for (const batch of batches) {
          await socket.send({
            client,
            data: toBase64(batch),
            encoding: DataEncoding.BASE64,
          })
          await pause(BATCH_PAUSE_MS)
        }
        await pause(FINISH_PAUSE_MS)
      } finally {
        await socket.disconnect({ client }).catch(() => undefined)
      }
    },
  }
}

/**
 * Le transport de l'appareil, ou `null` au navigateur.
 *
 * `null` n'est pas une panne : c'est l'absence de la donnée dont dépend
 * l'impression thermique — le socket. L'écran n'offre alors pas le bouton, et
 * le PDF A4 (E5-03) reste la voie de tout le monde.
 */
export function nativeTransport(): PrinterTransport | null {
  return Capacitor.isNativePlatform() ? socketTransport(TcpSocket) : null
}
