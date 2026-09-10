/*
 * « Un appareil s'enregistre à la première connexion. » E1-03.
 *
 * Le déclencheur est la session, pas un écran : l'appareil doit être connu même
 * si l'utilisateur n'ouvre jamais l'écran des appareils — c'est le vendeur qui
 * tient la tablette, et il n'a pas le droit d'y entrer.
 *
 * L'appel est émis une fois par commerce et par montage. Il n'a pas besoin
 * d'être compté ni retenu : `register_device()` est idempotente côté base, et
 * l'identifiant vient du stockage local. Le rejouer ne crée rien.
 *
 * Un échec ne dit rien à l'utilisateur, et c'est délibéré. Le cas normal est
 * l'absence de réseau — la situation ordinaire derrière un comptoir (SPEC
 * § 2.5) — et il n'y a rien à faire : ni geste à proposer, ni écran à bloquer.
 * L'appareil se représentera au prochain démarrage. Ce qui dépendra vraiment de
 * l'enregistrement, la numérotation locale, est E4-02 ; c'est là qu'un appareil
 * sans lettre devra se faire entendre, pas ici.
 */

import { useEffect, useRef } from 'react'

import { useAuth } from '@/lib/auth'
import { registerDevice } from '@/lib/device/register'

export function useDeviceRegistration(): void {
  const { status, user } = useAuth()
  const tenantId = user?.tenantId ?? null

  // Le commerce déjà présenté. En développement, React monte deux fois : sans
  // cette mémoire, l'appel partirait en double à chaque démarrage.
  const announced = useRef<string | null>(null)

  useEffect(() => {
    if (status !== 'signed-in' || tenantId === null) return
    if (announced.current === tenantId) return

    announced.current = tenantId
    void registerDevice().catch(() => {
      // Réseau absent, ou appareil retiré par le patron. Rien à dire ici : on
      // réessaiera au prochain démarrage.
      announced.current = null
    })
  }, [status, tenantId])
}
