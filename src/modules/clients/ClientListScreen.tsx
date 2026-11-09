/*
 * La liste des clients, et leur recherche. M4 — E6-01.
 *
 * Une seule source : `public.search_clients()` — nom à une faute près, arabe
 * compris, téléphone en sous-chaîne (SPEC § 9 M4). Requête vide : les 50
 * premiers par ordre alphabétique.
 *
 * `manage_client` est accordée aux deux rôles (SPEC § 3.1) : contrairement au
 * catalogue, rien ici ne se masque selon le rôle — tout le monde crée et
 * modifie un client.
 *
 * BRAND-UI § 8 : quatre états, ligne de 64 px, libellé au-dessus des champs.
 * BRAND-UI § 7 : l'ajout en bas, au pouce.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { latestOnly } from '@/modules/catalogue'
import { restoreClient, searchClients, type ClientHit } from '@/modules/clients/clients'

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; query: string; hits: ClientHit[] }

export interface ClientListNavigation {
  saved?: string
  deleted?: { id: string; name: string }
}

interface Notice {
  text: string
  undo?: { id: string; name: string }
}

function noticeOf(navigation: ClientListNavigation | null): Notice | null {
  if (navigation?.deleted !== undefined) {
    return { text: `« ${navigation.deleted.name} » supprimé.`, undo: navigation.deleted }
  }
  if (navigation?.saved !== undefined) return { text: `« ${navigation.saved} » enregistré.` }
  return null
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement des clients" className="flex flex-col">
      {[0, 1, 2, 3].map((n) => (
        <div key={n} className="flex h-row items-center gap-4 border-b border-paper-200">
          <div className="h-4 flex-1 rounded-field bg-paper-100" />
        </div>
      ))}
    </div>
  )
}

export function ClientListScreen() {
  const location = useLocation()
  const [query, setQuery] = useState('')
  const [state, setState] = useState<State>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(() =>
    noticeOf(location.state as ClientListNavigation | null),
  )
  const [failure, setFailure] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  const search = useMemo(() => latestOnly(searchClients), [])

  useEffect(() => {
    const delay = query.trim() === '' ? 0 : 200
    const timer = window.setTimeout(() => {
      search(query)
        .then((outcome) => {
          if (!outcome.current) return
          setState({ status: 'loaded', query: query.trim(), hits: outcome.value })
        })
        .catch((error: unknown) =>
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Chargement impossible.',
          }),
        )
    }, delay)
    return () => window.clearTimeout(timer)
  }, [query, attempt, search])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  const undo = async (clientRef: { id: string; name: string }): Promise<void> => {
    if (restoring) return
    setFailure(null)
    setRestoring(true)
    try {
      await restoreClient(clientRef.id)
      setNotice({ text: `« ${clientRef.name} » rétabli.` })
      retry()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Rétablissement impossible.')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <main className="px-4 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <h1 className="text-title text-paper-900">Clients</h1>

        {notice !== null && (
          <div className="flex flex-col items-start gap-2">
            <p role="status" className="text-body text-paper-700">
              {notice.text}
            </p>
            {notice.undo !== undefined && (
              <button
                type="button"
                disabled={restoring}
                onClick={() => void undo(notice.undo!)}
                className="h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
              >
                Annuler la suppression
              </button>
            )}
          </div>
        )}

        {failure !== null && (
          <p role="alert" className="text-body text-red-600">
            {failure}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <label htmlFor="client-search" className="text-label text-paper-700">
            Rechercher un client
          </label>
          <input
            id="client-search"
            type="search"
            dir="auto"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-field rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900 focus-visible:border-ink-600"
          />
        </div>

        {state.status === 'loading' && <Skeleton />}

        {state.status === 'error' && (
          <div className="flex flex-col items-start gap-4 rounded-card border border-red-500 bg-red-100 p-4">
            <p role="alert" className="text-body text-red-700">
              {state.message}
            </p>
            <button
              type="button"
              onClick={retry}
              className="h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
            >
              Réessayer
            </button>
          </div>
        )}

        {state.status === 'loaded' && state.hits.length === 0 && (
          <div className="rounded-card border border-paper-200 bg-white p-6">
            <p className="text-body text-paper-700">
              {state.query !== '' ? `Aucun client ne correspond à « ${state.query} ».` : 'Aucun client. Ajoutez le premier.'}
            </p>
          </div>
        )}

        {state.status === 'loaded' && state.hits.length > 0 && (
          <ul className="flex flex-col">
            {state.hits.map((hit) => (
              <li key={hit.id} className="border-b border-paper-200">
                <Link to={`/clients/${hit.id}`} className="flex min-h-row flex-col justify-center py-2">
                  <span className="text-subtitle text-paper-900">{hit.name}</span>
                  {hit.phone !== null && <span className="tabular text-body text-paper-700">{hit.phone}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}

        <Link
          to="/clients/new"
          className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
        >
          Ajouter un client
        </Link>
      </div>
    </main>
  )
}
