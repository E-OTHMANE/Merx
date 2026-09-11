/*
 * Les photos de produit. M1 — E2-02.
 *
 * BACKLOG E2-02 : « photo prise directement depuis l'appareil, redimensionnée
 * avant envoi ». L'appareil photo d'une tablette d'entrée de gamme produit des
 * images de plusieurs mégaoctets ; envoyées telles quelles, elles coûtent le
 * forfait du commerçant et une minute d'attente au comptoir. Elles partent donc
 * réduites à 800 px au plus grand côté, en JPEG de qualité 0,8 — quelques
 * dizaines de kilo-octets, largement assez pour une vignette de liste et une
 * fiche sur téléphone.
 *
 * Le compartiment est privé (migration `product_form`) : une photo s'affiche
 * par une URL signée, jamais par une URL publique. Le chemin stocké sur le
 * produit, `{product_id}/{uuid}.jpg`, ne nomme aucun commerce — c'est le
 * produit, et sa RLS, qui décident qui lit et qui écrit.
 *
 * Hors-ligne, rien de ceci ne fonctionne encore : l'envoi exige le réseau.
 * La file d'attente des photos appartient à l'étape 10 (E9).
 */

import { supabase } from '@/lib/supabase'

export const PHOTO_BUCKET = 'product-photo'
export const PHOTO_MAX_SIDE = 800
export const PHOTO_QUALITY = 0.8

/* Une heure : le temps d'une session de travail sur la liste. */
const SIGNED_URL_SECONDS = 3600

export const PHOTO_MESSAGES = {
  unreadable: 'Cette photo n’a pas pu être lue. Reprenez-la.',
  notSent: 'La photo n’a pas pu être envoyée.',
} as const

/**
 * Les dimensions d'une image ramenée dans un carré de `max` pixels, proportions
 * gardées. Une image plus petite n'est jamais agrandie : ce serait du poids en
 * plus sans un détail de plus.
 */
export function fitWithin(
  width: number,
  height: number,
  max: number = PHOTO_MAX_SIDE,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= max) return { width, height }

  const ratio = max / longest
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  }
}

/** Réduit une photo et la réencode en JPEG. L'orientation de l'appareil est respectée. */
export async function resizePhoto(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d')
    if (context === null) throw new Error(PHOTO_MESSAGES.unreadable)
    context.drawImage(bitmap, 0, 0, width, height)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob === null ? reject(new Error(PHOTO_MESSAGES.unreadable)) : resolve(blob)),
        'image/jpeg',
        PHOTO_QUALITY,
      )
    })
  } finally {
    bitmap.close()
  }
}

/**
 * Envoie une photo et rend son chemin. Un nom neuf à chaque fois : remplacer
 * une photo n'écrase rien, et aucun cache ne confond l'ancienne et la nouvelle.
 */
export async function uploadPhoto(productId: string, photo: Blob): Promise<string> {
  const path = `${productId}/${crypto.randomUUID()}.jpg`
  const { error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(path, photo, { contentType: 'image/jpeg', upsert: false })

  if (error !== null) throw new Error(PHOTO_MESSAGES.notSent)
  return path
}

/*
 * Retire une photo devenue inutile. Au mieux : un échec laisse un fichier
 * orphelin dans le compartiment, jamais un produit qui pointe dans le vide.
 */
export async function removePhoto(path: string): Promise<void> {
  try {
    await supabase.storage.from(PHOTO_BUCKET).remove([path])
  } catch {
    // Voir plus haut : l'orphelin est le résidu le moins nuisible.
  }
}

/**
 * Des URL signées pour des chemins. Ne lève jamais : une photo qui ne
 * s'affiche pas laisse sa place à la vignette de remplacement, en silence —
 * la liste reste utilisable sans elles (SPEC § 2.6).
 */
export async function signedPhotoUrls(paths: readonly string[]): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map()
  try {
    const { data, error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrls([...paths], SIGNED_URL_SECONDS)

    if (error !== null || data === null) return new Map()
    const urls = new Map<string, string>()
    for (const entry of data) {
      if (entry.error === null && entry.path !== null && entry.signedUrl) {
        urls.set(entry.path, entry.signedUrl)
      }
    }
    return urls
  } catch {
    return new Map()
  }
}
