/*
 * Liste des commerces. M8 — E1-01, dernier critère.
 *
 * BRAND-UI § 8 : quatre états, pas un de moins — chargement, vide, erreur,
 * contenu. Le chargement montre la forme de ce qui arrive, pas un rond qui
 * tourne. L'écran vide invite à agir plutôt que d'annoncer une absence.
 *
 * BRAND-UI § 9 : propriétés logiques uniquement. Rien à reprendre en RTL (E11).
 */

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { BackLink } from '@/components/BackLink'
import { formatDate, formatDateTime } from '@/lib/dates'
import { listTenants, type TenantSummary } from '@/modules/admin/api'

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; tenants: TenantSummary[] }

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement des commerces" className="flex flex-col gap-2">
      {[0, 1, 2].map((n) => (
        <div key={n} className="h-row rounded-card bg-paper-100" />
      ))}
    </div>
  )
}

function TenantRow({ tenant }: { tenant: TenantSummary }) {
  const activity = formatDateTime(tenant.lastActivityAt)

  return (
    <li className="flex min-h-row items-center justify-between gap-4 border-b border-paper-200 py-3">
      <div className="min-w-0">
        <p className="text-subtitle text-paper-900">{tenant.businessName}</p>
        <p className="text-note text-paper-600">
          {[tenant.ownerName, tenant.city].filter((v) => v !== null && v !== '').join(' · ') || '—'}
        </p>
        {/* Un numéro est une donnée : chiffres tabulaires (BRAND-UI § 6). */}
        {tenant.phone !== null && (
          <p className="tabular text-note text-paper-600">{tenant.phone}</p>
        )}
      </div>

      <div className="shrink-0 text-end">
        <p className="tabular text-note text-paper-700">Créé le {formatDate(tenant.createdAt)}</p>
        <p className="tabular text-note text-paper-600">
          {/*
           * Un commerce créé mais où personne ne s'est encore connecté. Le dire
           * plutôt qu'afficher un tiret : c'est l'information que l'éditeur
           * cherche — l'installation a-t-elle été prise en main ?
           */}
          {activity === null ? 'Jamais connecté' : `Vu le ${activity}`}
        </p>
      </div>
    </li>
  )
}

export function TenantListScreen() {
  const [state, setState] = useState<State>({ status: 'loading' })

  /*
   * `load` ne pose pas `loading` : l'état initial l'est déjà, et le faire ici
   * serait un `setState` synchrone dans l'effet — un rendu en cascade dès
   * l'ouverture de l'écran. C'est `retry` qui remet l'écran en chargement,
   * puisque lui part d'un état d'erreur.
   */
  const load = useCallback(() => {
    listTenants()
      .then((tenants) => setState({ status: 'loaded', tenants }))
      .catch((error: unknown) =>
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Chargement impossible.',
        }),
      )
  }, [])

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
          <h1 className="text-title text-paper-900">Commerces</h1>
          <p className="mt-2 text-body text-paper-700">
            {state.status === 'loaded' && state.tenants.length > 0
              ? `${state.tenants.length} commerce${state.tenants.length > 1 ? 's' : ''} installé${state.tenants.length > 1 ? 's' : ''}.`
              : 'Les commerces installés par l’éditeur.'}
          </p>
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

        {state.status === 'loaded' && state.tenants.length === 0 && (
          <div className="rounded-card border border-paper-200 bg-white p-6">
            <p className="text-body text-paper-700">
              Aucun commerce. Créez le premier pour installer un client.
            </p>
          </div>
        )}

        {state.status === 'loaded' && state.tenants.length > 0 && (
          <ul className="flex flex-col">
            {state.tenants.map((tenant) => (
              <TenantRow key={tenant.id} tenant={tenant} />
            ))}
          </ul>
        )}

        {/*
         * BRAND-UI § 7 : l'action principale est dans le tiers bas, atteignable
         * au pouce. Elle est rendue en dernier, après la liste, et non dans un
         * en-tête où le pouce ne va pas.
         */}
        <Link
          to="/admin/tenants/new"
          className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
        >
          Créer un commerce
        </Link>
      </div>
    </main>
  )
}
