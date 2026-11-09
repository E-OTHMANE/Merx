/*
 * Accès aux clients. M4 — E6-01.
 *
 * SPEC § 2.6 gouverne la forme des écritures, exactement comme `products.ts` :
 * à la création, seules les colonnes qui ont une valeur partent ; à la
 * modification, seules celles qui ont changé. Ce fichier ne connaît aucun
 * `tenant_id` — la lecture est bornée par la RLS, l'écriture prend le commerce
 * du jeton par défaut.
 *
 * Le téléphone ne se normalise **pas** ici en une forme imposée : la saisie
 * passe par `normalizePhone()` (E1-01) quand elle en a la forme, et part telle
 * quelle sinon — un numéro étranger ou une faute de frappe n'empêche jamais la
 * création d'un client (SPEC § 2.6). `phone_digits`, la colonne engendrée qui
 * sert la recherche, est l'affaire de la base (`merx.phone_digits()`), jamais
 * de ce fichier.
 */

import { normalizePhone } from '@/lib/phone'
import { supabase } from '@/lib/supabase'

/** Un client, tel que la fiche et la vente le lisent. */
export interface Client {
  id: string
  name: string
  phone: string | null
  city: string | null
  address: string | null
  notes: string | null
}

/** Ce que le formulaire manipule : du texte, et rien d'autre. */
export interface ClientDraft {
  name: string
  phone: string
  city: string
  address: string
  notes: string
}

export const EMPTY_DRAFT: ClientDraft = { name: '', phone: '', city: '', address: '', notes: '' }

type Column = 'name' | 'phone' | 'city' | 'address' | 'notes'

export type ClientChanges = Partial<Record<Column, string | null>>

const FIELDS: ReadonlyArray<readonly [keyof ClientDraft, Column]> = [
  ['name', 'name'],
  ['phone', 'phone'],
  ['city', 'city'],
  ['address', 'address'],
  ['notes', 'notes'],
]

interface ClientRow {
  id: string
  name: string
  phone: string | null
  city: string | null
  address: string | null
  notes: string | null
}

const COLUMNS = 'id, name, phone, city, address, notes'

export const CLIENT_MESSAGES = {
  refused: 'Ce compte ne peut pas enregistrer de client : la base a refusé l’enregistrement.',
  notSaved: 'Client non enregistré : il n’existe plus, ou ce compte n’a pas le droit de le modifier.',
} as const

/** Le seul champ qui conditionne l'enregistrement (SPEC § 2.6). */
export function canSave(draft: ClientDraft): boolean {
  return draft.name.trim() !== ''
}

/**
 * Ce qu'un champ de téléphone envoie : la forme canonique quand la saisie en
 * a une (`normalizePhone()`, E1-01), la saisie elle-même sinon, bords
 * retirés. Jamais de refus — un numéro illisible part tel que tapé, et la
 * base ne fait pas mieux (`merx.normalize_client_phone()`, même raison).
 */
export function phoneForStorage(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  return normalizePhone(trimmed) ?? trimmed
}

function columnValue(field: keyof ClientDraft, raw: string): string | null {
  if (field === 'phone') return phoneForStorage(raw)
  const text = raw.trim()
  return text === '' ? null : text
}

export function draftOf(client: Client): ClientDraft {
  return {
    name: client.name,
    phone: client.phone ?? '',
    city: client.city ?? '',
    address: client.address ?? '',
    notes: client.notes ?? '',
  }
}

/** La charge d'une création : l'identifiant, puis les seules colonnes qui ont une valeur. */
export function creationPayload(id: string, draft: ClientDraft): Record<string, string> {
  const payload: Record<string, string> = { id }
  for (const [field, column] of FIELDS) {
    const value = columnValue(field, draft[field])
    if (value !== null) payload[column] = value
  }
  return payload
}

/** Les colonnes qui ont changé entre l'état enregistré et le brouillon. */
export function changesBetween(saved: ClientDraft, draft: ClientDraft): ClientChanges {
  const changes: ClientChanges = {}
  for (const [field, column] of FIELDS) {
    const before = columnValue(field, saved[field])
    const after = columnValue(field, draft[field])
    if (before !== after) changes[column] = after
  }
  return changes
}

interface PostgrestErrorLike {
  code?: string
  message: string
}

function failure(error: PostgrestErrorLike): Error {
  if (error.code === '42501') return new Error(CLIENT_MESSAGES.refused)
  return new Error(error.message)
}

function clientOf(row: ClientRow): Client {
  return { id: row.id, name: row.name, phone: row.phone, city: row.city, address: row.address, notes: row.notes }
}

export async function getClient(id: string): Promise<Client | null> {
  const { data, error } = await supabase
    .from('client')
    .select(COLUMNS)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()

  if (error !== null) throw new Error(error.message)
  return data === null ? null : clientOf(data as ClientRow)
}

/**
 * Crée un client, et rend sa fiche. L'identifiant est engendré ici, par
 * l'appareil — comme celui d'un produit (E2-02) ou d'un appareil (E1-03) :
 * c'est ce que fera la tablette hors-ligne (E9).
 */
export async function createClient(draft: ClientDraft): Promise<Client> {
  const id = crypto.randomUUID()
  const { error } = await supabase.from('client').insert(creationPayload(id, draft))
  if (error !== null) throw failure(error)
  return { id, name: draft.name.trim(), phone: phoneForStorage(draft.phone), city: columnValue('city', draft.city), address: columnValue('address', draft.address), notes: columnValue('notes', draft.notes) }
}

/**
 * Crée un client à partir d'un seul nom — le geste de l'écran de vente :
 * « Créer « <saisie> » », sans ouvrir de formulaire. Si la saisie a la forme
 * d'un numéro, elle part comme téléphone plutôt que comme nom : un vendeur qui
 * tape un numéro au comptoir n'a pas tapé un nom.
 */
export async function createClientNamed(text: string): Promise<Client> {
  const trimmed = text.trim()
  const asPhone = normalizePhone(trimmed)
  return createClient(asPhone === null ? { ...EMPTY_DRAFT, name: trimmed } : { ...EMPTY_DRAFT, name: trimmed, phone: trimmed })
}

/**
 * Modifie un client, et exige d'avoir touché sa ligne — même garde que
 * `updateProduct()` : un UPDATE refusé par la RLS ne lève pas, il ne trouve
 * rien.
 */
export async function updateClient(id: string, changes: ClientChanges | { deleted_at: string | null }): Promise<void> {
  const { data, error } = await supabase.from('client').update(changes).eq('id', id).select('id')

  if (error !== null) throw failure(error)
  if ((data as unknown[] | null)?.length !== 1) throw new Error(CLIENT_MESSAGES.notSaved)
}

export async function deleteClient(id: string): Promise<void> {
  await updateClient(id, { deleted_at: new Date().toISOString() })
}

export async function restoreClient(id: string): Promise<void> {
  await updateClient(id, { deleted_at: null })
}

/* -------------------------------------------------------------------------- */
/* Recherche — public.search_clients()                                        */
/* -------------------------------------------------------------------------- */

/** Un client trouvé, tel que le sélecteur de la vente le montre. */
export interface ClientHit {
  id: string
  name: string
  phone: string | null
  city: string | null
}

interface SearchRow {
  id: string
  name: string
  phone: string | null
  city: string | null
}

/* Ce que la base rend au plus : `limit 50` dans `public.search_clients()`. */
export const CLIENT_SEARCH_LIMIT = 50

export async function searchClients(query: string): Promise<ClientHit[]> {
  const { data, error } = await supabase.rpc('search_clients', { q: query.trim() })
  if (error !== null) throw new Error(error.message)
  return (data as SearchRow[]).map((row) => ({ id: row.id, name: row.name, phone: row.phone, city: row.city }))
}
