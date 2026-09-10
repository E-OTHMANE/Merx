/*
 * L'enregistrement de l'appareil. E1-03.
 *
 * Un seul appel, `register_device()`, et il est idempotent : appelé avec un
 * identifiant déjà connu du commerce, il ne crée rien et se contente
 * d'estampiller la dernière synchronisation. On peut donc l'émettre à chaque
 * ouverture de session sans rien compter ni se souvenir de rien.
 *
 * Il passe par une RPC et non par un `POST` sur `device` : la lettre de
 * numérotation ne se choisit pas côté client (SPEC § 2.5), et la relation est
 * fermée à l'employé (capacité `manage_devices`), qui doit pourtant pouvoir
 * enregistrer sa propre tablette.
 */

import { supabase } from '@/lib/supabase'
import { installationId } from '@/lib/device/installation'

/** L'appareil, tel que le serveur le rend une fois enregistré. */
export interface RegisteredDevice {
  id: string
  label: string
  /** La lettre de numérotation : `BL-C-0001` (SPEC § 2.5, E4-02). */
  prefix: string
  lastSyncAt: string | null
}

interface DeviceRow {
  id: string
  label: string
  prefix: string
  last_sync_at: string | null
}

/**
 * Présente cet appareil à son commerce, et rend ce que le serveur en sait.
 *
 * Aucun commerce n'est transmis : il vient du jeton signé (SPEC § 2.1). Aucune
 * lettre non plus — c'est la base qui l'attribue, sous verrou, et elle ne la
 * donne qu'une fois.
 */
export async function registerDevice(): Promise<RegisteredDevice> {
  const { data, error } = await supabase.rpc('register_device', {
    device_key: installationId(),
  })

  // Les refus de la base sont écrits pour être lus (« Cet appareil a été
  // retiré. Demandez à votre patron de le réactiver. »). Les reformuler ici,
  // c'est deux formulations à tenir d'accord.
  if (error !== null) throw new Error(error.message)

  /*
   * La fonction est un `returns table` : PostgREST rend un tableau. Une réponse
   * vide voudrait dire que la fonction a rendu zéro ligne, ce qu'aucun de ses
   * chemins ne fait — le dire plutôt que de laisser un `undefined` filer.
   */
  const row = (data as DeviceRow[] | null)?.[0]
  if (row === undefined) throw new Error('Réponse inattendue du serveur.')

  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    lastSyncAt: row.last_sync_at,
  }
}
