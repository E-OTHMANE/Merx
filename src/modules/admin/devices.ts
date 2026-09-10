/*
 * Accès aux données des appareils. M8 — E1-03.
 *
 * Une seule lecture, et elle va droit à PostgREST. Aucun filtre n'est écrit
 * ici : la policy `tenant_isolation` borne au commerce, la policy restrictive
 * `capability_restriction` exige `manage_devices`. Un `where` sur le tenant
 * serait un filtre applicatif, ce que SPEC § 2.1 refuse.
 *
 * Rien n'écrit dans ce fichier. L'enregistrement passe par `src/lib/device` —
 * il est fait par l'appareil lui-même, pas par cet écran — et E1-03 ne demande
 * ni de renommer ni de retirer un appareil.
 */

import { supabase } from '@/lib/supabase'

/** Un appareil, tel que l'écran du patron le montre. E1-03. */
export interface Device {
  id: string
  label: string
  /** La lettre de numérotation : `BL-C-0001` (SPEC § 2.5, E4-02). */
  prefix: string
  lastSyncAt: string | null
  isActive: boolean
}

interface DeviceRow {
  id: string
  label: string
  prefix: string
  last_sync_at: string | null
  is_active: boolean
}

/**
 * Les appareils du commerce, dans l'ordre des lettres.
 *
 * L'ordre est celui du préfixe, et pas celui du nom ni de la création : c'est
 * par la lettre que le patron arrive ici. Il a un bon `BL-C-0001` sous les yeux
 * et cherche quelle tablette l'a produit.
 */
export async function listDevices(): Promise<Device[]> {
  const { data, error } = await supabase
    .from('device')
    .select('id, label, prefix, last_sync_at, is_active')
    .is('deleted_at', null)
    .order('prefix', { ascending: true })

  if (error !== null) throw new Error(error.message)

  return (data as DeviceRow[]).map((row) => ({
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    lastSyncAt: row.last_sync_at,
    isActive: row.is_active,
  }))
}
