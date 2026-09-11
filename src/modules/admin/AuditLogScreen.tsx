/*
 * Le journal d'audit. M8 — E1-04.
 *
 * L'écran répond à une question qu'on ne se pose pas tous les jours, et
 * toujours dans le même contexte : quelque chose ne tombe pas juste, et le
 * patron cherche qui a touché à quoi. La forme en découle — les deux filtres
 * que E1-04 demande sont visibles d'emblée, pas repliés derrière un bouton, et
 * chaque ligne se lit en une phrase : qui, quoi, quand.
 *
 * Aucune des six actions de la RÈGLE M8-1 n'est encore implémentée (E4, E6, E8,
 * E9). L'écran est donc vide chez tout le monde aujourd'hui, et c'est l'état
 * vide qui porte l'explication — un écran vide sans phrase se lit comme une
 * panne (BRAND-UI § 6, § 8).
 *
 * BRAND-UI § 8 : quatre états, pas un de moins.
 * BRAND-UI § 6 : dates et identifiants sont des données — chiffres tabulaires.
 * BRAND-UI § 9 : propriétés logiques uniquement. Rien à reprendre en RTL (E11).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { BackLink } from '@/components/BackLink'
import { formatDateTime } from '@/lib/dates'
import { ACTION_LABELS, listAuditEntries, type AuditEntry } from '@/modules/admin/audit'
import { listUsers, type Employee } from '@/modules/admin/users'

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; entries: AuditEntry[] }

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement du journal" className="flex flex-col gap-2">
      {[0, 1, 2].map((n) => (
        <div key={n} className="h-row rounded-card bg-paper-100" />
      ))}
    </div>
  )
}

function EntryRow({ entry, author }: { entry: AuditEntry; author: string }) {
  const when = formatDateTime(entry.createdAt)

  return (
    <li className="flex min-h-row flex-col gap-1 border-b border-paper-200 py-3">
      <p className="text-subtitle text-paper-900">{ACTION_LABELS[entry.action]}</p>
      <p className="text-note text-paper-600">
        {author} · {entry.entityType}
      </p>
      <p className="tabular text-note text-paper-600">{when ?? '—'}</p>
    </li>
  )
}

export function AuditLogScreen() {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [authors, setAuthors] = useState<Employee[]>([])
  const [userId, setUserId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  /*
   * Les auteurs servent à nommer les lignes autant qu'à filtrer : le journal
   * porte un `user_id`, et personne ne reconnaît un uuid. L'appel est sans
   * risque ici — l'écran est déjà réservé au patron, qui a `manage_users`.
   * Un échec de cette lecture-là ne doit pas emporter l'écran : on affiche
   * alors l'identifiant brut, ce qui reste lisible faute de mieux.
   */
  useEffect(() => {
    listUsers()
      .then(setAuthors)
      .catch(() => setAuthors([]))
  }, [])

  const nameOf = useMemo(() => {
    const byId = new Map(authors.map((author) => [author.id, author.fullName]))
    return (id: string): string => byId.get(id) ?? id
  }, [authors])

  const load = useCallback(() => {
    listAuditEntries({ userId, from, to })
      .then((entries) => setState({ status: 'loaded', entries }))
      .catch((error: unknown) =>
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Chargement impossible.',
        }),
      )
  }, [userId, from, to])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    load()
  }, [load])

  useEffect(load, [load])

  return (
    <main className="min-h-dvh px-4 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div>
          <BackLink to="/" label="Accueil" />
          <h1 className="text-title text-paper-900">Journal</h1>
          <p className="mt-2 text-body text-paper-700">
            Les actions qui engagent l’argent : prix forcés, documents annulés, plafonds dépassés,
            écarts validés.
          </p>
        </div>

        {/*
         * Les filtres de E1-04. Ils changent l'état, l'état relance la lecture :
         * pas de bouton « Filtrer » à taper en plus, chaque appui de moins est
         * payé mille fois (SPEC § 10).
         */}
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-note text-paper-600">Utilisateur</span>
            <select
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              className="h-touch rounded-button border border-paper-300 bg-white px-3 text-body text-ink-700"
            >
              <option value="">Tous</option>
              {authors.map((author) => (
                <option key={author.id} value={author.id}>
                  {author.fullName}
                </option>
              ))}
            </select>
          </label>

          <div className="flex gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-note text-paper-600">Du</span>
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="tabular h-touch rounded-button border border-paper-300 bg-white px-3 text-body text-ink-700"
              />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-note text-paper-600">Au</span>
              <input
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="tabular h-touch rounded-button border border-paper-300 bg-white px-3 text-body text-ink-700"
              />
            </label>
          </div>
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

        {state.status === 'loaded' && state.entries.length === 0 && (
          <div className="rounded-card border border-paper-200 bg-white p-6">
            <p className="text-body text-paper-700">
              Aucune action enregistrée sur cette période. Le journal se remplit tout seul, quand
              quelqu’un force un prix ou annule un bon.
            </p>
          </div>
        )}

        {state.status === 'loaded' && state.entries.length > 0 && (
          <ul className="flex flex-col">
            {state.entries.map((entry) => (
              <EntryRow key={entry.id} entry={entry} author={nameOf(entry.userId)} />
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
