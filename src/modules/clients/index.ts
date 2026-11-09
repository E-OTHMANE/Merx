/*
 * Surface publique du module Clients (M4). E6-01.
 *
 * CLAUDE.md : un module s'importe par son `index.ts`, jamais par ses
 * internes. Ce qui n'est pas ici n'existe pas pour le reste de l'application.
 */

export { ClientListScreen, type ClientListNavigation } from '@/modules/clients/ClientListScreen'
export { ClientFormScreen } from '@/modules/clients/ClientFormScreen'
export { ClientPicker, type ClientPickerProps } from '@/modules/clients/ClientPicker'
export {
  CLIENT_SEARCH_LIMIT,
  EMPTY_DRAFT,
  canSave,
  changesBetween,
  createClient,
  createClientNamed,
  deleteClient,
  draftOf,
  getClient,
  phoneForStorage,
  restoreClient,
  searchClients,
  updateClient,
  type Client,
  type ClientChanges,
  type ClientDraft,
  type ClientHit,
} from '@/modules/clients/clients'
