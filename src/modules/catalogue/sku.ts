/*
 * Le SKU engendré — E2-06.
 *
 * SPEC § 6, RÈGLE M1-5 : le Code 128 encode `variant.sku`. Un produit créé sans
 * référence n'en a pas — `sku` dérive de `product.code`, et le code est
 * facultatif (SPEC § 2.6). Il n'y a alors rien à encoder, et c'est exactement le
 * cas que la règle vise : « pour tout ce qui arrive sans code ».
 *
 * **Engendré par l'appareil, jamais par le serveur.** Une étiquette s'imprime au
 * comptoir, parfois sans réseau (SPEC § 2.5, sept jours hors ligne) : un numéro
 * qu'il faudrait demander au serveur ne s'obtiendrait pas. Même raisonnement que
 * la numérotation des documents (RÈGLE M3-2), sans en emprunter le mécanisme —
 * `document_sequence` appartient à E4-02, et on ne construit pas devant.
 *
 * La forme est `A-00001` : la lettre de l'appareil (E1-03, unique par commerce
 * et jamais recyclée), un tiret, cinq chiffres. Deux appareils n'entrent donc
 * jamais en conflit sans se parler. Cinq chiffres et non quatre : la largeur est
 * fixe, donc l'ordre alphabétique des SKU est leur ordre numérique — c'est ce
 * qui permet de demander le plus grand au serveur en une ligne.
 *
 * **Le compteur local n'est pas l'autorité — `variant_sku_per_tenant` l'est.**
 * Le compteur est une commodité ; l'index est ce qui garantit l'unicité. D'où
 * deux propriétés, toutes deux éprouvées :
 *
 *   — un stockage local vidé ne réattribue jamais un SKU déjà imprimé : le
 *     prochain numéro repart **au-dessus du plus grand connu du serveur** ;
 *   — un `23505` sur `variant_sku_per_tenant` — un employé a pu taper `A-00007`
 *     à la main dans la référence — fait passer au numéro suivant et retenter.
 *     Le refus est reconnu **au nom de la contrainte**, jamais au seul code :
 *     `product_code_per_tenant` et `variant_barcode_per_tenant` répondent le
 *     même `23505` (CLAUDE.md, règle des unicités).
 */

import { supabase } from '@/lib/supabase'

/** Cinq chiffres : la largeur est fixe pour que l'ordre du texte soit celui des nombres. */
const DIGITS = 5

/** Le plus grand numéro qu'une lettre d'appareil peut porter. */
export const MAX_SEQUENCE = 10 ** DIGITS - 1

/** Combien de numéros déjà pris on enjambe avant d'abandonner. */
const MAX_ATTEMPTS = 5

const COUNTER_PREFIX = 'merx.sku-counter.'

export const SKU_MESSAGES = {
  exhausted:
    'Impossible d’attribuer un code à ce produit : les numéros de cet appareil sont pris. Saisissez une référence à la main.',
  notSaved:
    'Code non attribué : le produit n’existe plus, ou ce compte n’a pas le droit de le modifier.',
} as const

/** `A-00001`. */
export function formatGeneratedSku(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(DIGITS, '0')}`
}

/** Le numéro d'un SKU engendré par cet appareil, ou `null` si ce n'en est pas un. */
export function sequenceOf(prefix: string, sku: string | null): number | null {
  if (sku === null) return null
  const match = new RegExp(`^${prefix}-([0-9]{${DIGITS}})$`).exec(sku)
  return match === null ? null : Number(match[1])
}

function counterKey(prefix: string): string {
  return `${COUNTER_PREFIX}${prefix}`
}

/** Le compteur local, ou 0 s'il n'y en a pas — stockage vidé, appareil neuf. */
function localCounter(prefix: string): number {
  const stored = Number(window.localStorage.getItem(counterKey(prefix)))
  return Number.isInteger(stored) && stored > 0 ? stored : 0
}

function rememberCounter(prefix: string, sequence: number): void {
  window.localStorage.setItem(counterKey(prefix), String(sequence))
}

/*
 * Le plus grand SKU de cet appareil que le serveur connaisse.
 *
 * **Les variantes supprimées comptent.** Un produit supprimé dont l'étiquette
 * est encore collée sur un carton du dépôt tient son numéro : le réattribuer
 * ferait pointer deux étiquettes identiques sur deux produits différents, ce qui
 * est précisément ce que cette story existe pour empêcher. La suppression est
 * douce (SPEC § 4), la ligne est là, et l'index l'ignore — c'est donc ici qu'il
 * faut la voir.
 *
 * Hors réseau, la requête échoue : on rend `null`, et le compteur local prend le
 * relais. L'index tranchera au moment de l'écriture.
 */
async function serverMaximum(prefix: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('variant')
    .select('sku')
    .like('sku', `${prefix}-%`)
    .order('sku', { ascending: false })
    .limit(1)

  if (error !== null) return null

  const rows = (data ?? []) as Array<{ sku: string | null }>
  return sequenceOf(prefix, rows[0]?.sku ?? null) ?? 0
}

/**
 * Le prochain numéro libre, au mieux de ce qu'on sait.
 *
 * Le plus grand des deux sources : le compteur local, et ce que le serveur
 * connaît. C'est la seconde qui tient la propriété demandée — stockage vidé, le
 * numéro suivant repart au-dessus du dernier imprimé, pas à 1.
 */
export async function nextSequence(prefix: string): Promise<number> {
  const known = await serverMaximum(prefix)
  return Math.max(localCounter(prefix), known ?? 0) + 1
}

interface PostgrestErrorLike {
  code?: string
  message: string
}

function isSkuCollision(error: PostgrestErrorLike): boolean {
  return error.code === '23505' && error.message.includes('variant_sku_per_tenant')
}

/**
 * Attribue un SKU engendré à une variante qui n'en a pas, et le rend.
 *
 * L'écriture exige d'avoir touché la ligne : un UPDATE refusé par la RLS ne lève
 * pas, il ne trouve rien (même garde que `updateProduct`, E2-02). Sans ce
 * contrôle, une étiquette s'imprimerait avec un code que la base n'a jamais
 * accepté.
 */
export async function assignGeneratedSku(variantId: string, prefix: string): Promise<string> {
  let sequence = await nextSequence(prefix)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (sequence > MAX_SEQUENCE) throw new Error(SKU_MESSAGES.exhausted)

    const sku = formatGeneratedSku(prefix, sequence)
    const { data, error } = await supabase
      .from('variant')
      .update({ sku })
      .eq('id', variantId)
      .is('sku', null)
      .select('id')

    if (error === null) {
      if ((data as unknown[] | null)?.length !== 1) throw new Error(SKU_MESSAGES.notSaved)
      rememberCounter(prefix, sequence)
      return sku
    }

    if (!isSkuCollision(error)) throw new Error(error.message)

    // Le numéro est pris — par une saisie à la main, ou par un compteur local
    // en retard. On enjambe, et l'index tranche à nouveau.
    sequence += 1
  }

  throw new Error(SKU_MESSAGES.exhausted)
}
