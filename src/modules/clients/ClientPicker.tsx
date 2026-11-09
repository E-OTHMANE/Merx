/*
 * Sélectionner ou créer un client, sans quitter l'écran d'où on l'appelle.
 * E6-01 — le critère d'E4-03 : « sélection ou création d'un client sans
 * quitter l'écran de vente ».
 *
 * Un panneau, pas une route : ouvert d'un tap sur « Client : aucun », il
 * remplace la ligne par un champ de recherche et se referme dès qu'un client
 * est choisi ou créé. Rien ici ne touche à la navigation — c'est tout l'esprit
 * du critère, et c'est pour cela que l'écran de vente n'ajoute aucun geste
 * quand le vendeur ne l'ouvre pas.
 *
 * Réutilisé par le filtre client de la liste des documents (E4-07) : même
 * panneau, `allowCreate={false}` — un filtre ne crée pas de fiche.
 */

import { useEffect, useMemo, useState } from 'react'

import { latestOnly } from '@/modules/catalogue'
import { createClientNamed, searchClients, type ClientHit } from '@/modules/clients/clients'

const SEARCH_DELAY_MS = 200

export interface ClientPickerProps {
  /** Le client déjà choisi, ou `null` — « aucun ». */
  value: { id: string; name: string } | null
  onSelect: (client: { id: string; name: string }) => void
  onClear: () => void
  /** `false` pour le filtre de la liste des documents : pas de création. */
  allowCreate?: boolean
  /** Le libellé du bouton fermé, avant tout choix. */
  noneLabel?: string
}

export function ClientPicker({
  value,
  onSelect,
  onClear,
  allowCreate = true,
  noneLabel = 'Aucun',
}: ClientPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ClientHit[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const search = useMemo(() => latestOnly(searchClients), [])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      setLoading(true)
      search(query)
        .then((outcome) => {
          if (!outcome.current) return
          setHits(outcome.value)
          setLoading(false)
        })
        .catch(() => setLoading(false))
    }, SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [open, query, search])

  const close = (): void => {
    setOpen(false)
    setQuery('')
    setFailure(null)
  }

  const choose = (client: { id: string; name: string }): void => {
    onSelect(client)
    close()
  }

  const create = async (): Promise<void> => {
    const name = query.trim()
    if (name === '' || creating) return
    setCreating(true)
    setFailure(null)
    try {
      const created = await createClientNamed(name)
      choose({ id: created.id, name: created.name })
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Client non créé.')
    } finally {
      setCreating(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-touch items-center justify-between rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900"
      >
        <span className="text-label text-paper-700">Client</span>
        <span className="tabular">{value?.name ?? noneLabel}</span>
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-card border border-paper-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="client-picker-search" className="text-label text-paper-700">
          Rechercher un client
        </label>
        <button type="button" onClick={close} className="text-body text-ink-700">
          Fermer
        </button>
      </div>
      <input
        id="client-picker-search"
        type="search"
        dir="auto"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="h-field rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900 focus-visible:border-ink-600"
      />

      {value !== null && (
        <button
          type="button"
          onClick={() => {
            onClear()
            close()
          }}
          className="h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
        >
          Retirer le client
        </button>
      )}

      {failure !== null && (
        <p role="alert" className="text-body text-red-600">
          {failure}
        </p>
      )}

      {loading && <p className="text-body text-paper-700">Recherche…</p>}

      {!loading && (
        <ul className="flex max-h-64 flex-col overflow-y-auto">
          {hits.map((hit) => (
            <li key={hit.id} className="border-b border-paper-200">
              <button
                type="button"
                onClick={() => choose({ id: hit.id, name: hit.name })}
                className="flex min-h-row w-full flex-col items-start justify-center py-2 text-start"
              >
                <span className="text-body text-paper-900">{hit.name}</span>
                {hit.phone !== null && <span className="tabular text-note text-paper-700">{hit.phone}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loading && allowCreate && query.trim() !== '' && (
        <button
          type="button"
          disabled={creating}
          onClick={() => void create()}
          className="h-touch rounded-button border border-dashed border-paper-300 bg-white px-4 text-body text-ink-700"
        >
          {creating ? 'Création…' : `Créer « ${query.trim()} »`}
        </button>
      )}
    </div>
  )
}
