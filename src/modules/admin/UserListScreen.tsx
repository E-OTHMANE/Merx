/*
 * Les employés du commerce. M8 — E1-02.
 *
 * BRAND-UI § 8 : quatre états, pas un de moins — chargement, vide, erreur,
 * contenu. Le chargement montre la forme de ce qui arrive.
 *
 * BRAND-UI § 11 : « Les modales de confirmation sur les actions courantes.
 * Réservées à ce qui est irréversible. » Désactiver ne l'est pas — la fiche
 * reste et se réactive d'un appui. Le bouton agit donc directement, et l'écran
 * dit ce qui s'est passé.
 *
 * BRAND-UI § 9 : propriétés logiques uniquement. Rien à reprendre en RTL (E11).
 */

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { formatDateTime } from '@/lib/dates'
import { useAuth } from '@/lib/auth'
import { listUsers, setUserActive, type Employee } from '@/modules/admin/users'

/** SPEC § 3, dans les mots du commerce. */
const ROLE_LABELS: Record<Employee['role'], string> = {
  super_admin: 'Éditeur',
  owner: 'Patron',
  worker: 'Employé',
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; users: Employee[] }

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement des employés" className="flex flex-col gap-2">
      {[0, 1, 2].map((n) => (
        <div key={n} className="h-row rounded-card bg-paper-100" />
      ))}
    </div>
  )
}

interface RowProps {
  user: Employee
  /** L'appelant lui-même : sa propre ligne ne porte aucune action (E1-02). */
  isSelf: boolean
  busy: boolean
  onToggle: (user: Employee) => void
}

function UserRow({ user, isSelf, busy, onToggle }: RowProps) {
  const seen = formatDateTime(user.lastSeenAt)

  return (
    <li className="flex min-h-row items-center justify-between gap-4 border-b border-paper-200 py-3">
      <div className="min-w-0">
        <p className="text-subtitle text-paper-900">{user.fullName}</p>
        <p className="text-note text-paper-600">
          {ROLE_LABELS[user.role]}
          {user.isActive ? '' : ' · Désactivé'}
        </p>
        {/* Un numéro est une donnée : chiffres tabulaires (BRAND-UI § 6). */}
        {user.phone !== null && <p className="tabular text-note text-paper-600">{user.phone}</p>}
        <p className="tabular text-note text-paper-600">
          {seen === null ? 'Jamais connecté' : `Vu le ${seen}`}
        </p>
      </div>

      <div className="shrink-0">
        {isSelf ? (
          /*
           * E1-02 : « Le patron ne peut pas se retirer son propre rôle owner. »
           * L'action est absente, pas grisée : un bouton désactivé invite à
           * chercher comment l'activer. La base refuse de toute façon — le
           * trigger `app_user_protect_own_role` et `set_user_active()`.
           */
          <p className="text-note text-paper-600">Vous</p>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => onToggle(user)}
            className={
              user.isActive
                ? 'h-touch rounded-button border border-red-500 bg-white px-4 text-body text-red-600'
                : 'h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700'
            }
          >
            {user.isActive ? 'Désactiver' : 'Réactiver'}
          </button>
        )}
      </div>
    </li>
  )
}

export function UserListScreen() {
  const { user: current } = useAuth()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /*
   * `load` ne pose pas `loading` : l'état initial l'est déjà, et le faire ici
   * serait un `setState` synchrone dans l'effet. C'est `retry` qui remet
   * l'écran en chargement, puisque lui part d'un état d'erreur.
   */
  const load = useCallback(() => {
    listUsers()
      .then((users) => setState({ status: 'loaded', users }))
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

  const toggle = useCallback(
    (user: Employee) => {
      // Un second appui pendant l'appel rejouerait la même bascule à l'envers.
      if (busy !== null) return

      setBusy(user.id)
      setNotice(null)

      setUserActive(user.id, !user.isActive)
        .then(() => {
          /*
           * BRAND-UI § 6 : « Le même mot du début à la fin d'un parcours. » Le
           * bouton « Désactiver » produit « désactivé ».
           */
          setNotice(
            user.isActive
              ? `${user.fullName} est désactivé. Il ne peut plus se connecter.`
              : `${user.fullName} est réactivé.`,
          )
          load()
        })
        .catch((error: unknown) =>
          setNotice(error instanceof Error ? error.message : 'Modification impossible.'),
        )
        .finally(() => setBusy(null))
    },
    [busy, load],
  )

  return (
    <main className="min-h-dvh px-4 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div>
          <h1 className="text-title text-paper-900">Employés</h1>
          <p className="mt-2 text-body text-paper-700">
            Ils vendent et encaissent, sans voir vos prix d’achat.
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

        {notice !== null && (
          <p role="status" className="text-body text-paper-700">
            {notice}
          </p>
        )}

        {/*
         * L'écran vide n'arrive qu'au premier jour d'un commerce : le patron
         * s'y voit lui-même, seul. BRAND-UI § 6 : il invite à agir.
         */}
        {state.status === 'loaded' && state.users.length === 0 && (
          <div className="rounded-card border border-paper-200 bg-white p-6">
            <p className="text-body text-paper-700">
              Aucun employé. Créez un compte pour celui qui tient le comptoir.
            </p>
          </div>
        )}

        {state.status === 'loaded' && state.users.length > 0 && (
          <ul className="flex flex-col">
            {state.users.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                isSelf={user.authUserId !== null && user.authUserId === current?.id}
                busy={busy === user.id}
                onToggle={toggle}
              />
            ))}
          </ul>
        )}

        {/*
         * BRAND-UI § 7 : l'action principale est dans le tiers bas, atteignable
         * au pouce. Rendue après la liste, jamais dans un en-tête.
         */}
        <Link
          to="/users/new"
          className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
        >
          Créer un employé
        </Link>
      </div>
    </main>
  )
}
