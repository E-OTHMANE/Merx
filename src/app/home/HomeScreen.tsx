/*
 * L'Accueil. E0-04, premier onglet depuis E11-04.
 *
 * BRAND-UI § 13 : tout ce qui n'est pas un onglet part d'ici. Les destinations
 * rares du patron sont dans le bloc « Gestion du commerce », en bas, au-dessus
 * de « Se déconnecter ». Le catalogue n'y est plus : c'est un onglet. Les
 * actions quotidiennes sans onglet — caisse, réception, inventaire — prendront
 * un bouton au-dessus du bloc, avec leur story.
 */

import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { useAuth, useCan, type UserRole } from '@/lib/auth'

/*
 * E0-05 — le rôle, dit dans les mots du commerce. Il n'ouvre rien ici : c'est
 * `merx.can()` qui décide, côté base. Il est affiché parce qu'un compte partagé
 * derrière un comptoir doit pouvoir répondre à « je suis connecté en quoi ? »
 * sans qu'on aille lire un jeton.
 */
const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: 'Éditeur',
  owner: 'Patron',
  worker: 'Employé',
}

interface Destination {
  to: string
  label: string
  visible: boolean
}

function DestinationRow({ to, label }: { to: string; label: string }) {
  return (
    <li className="border-b border-paper-200 last:border-b-0">
      <Link to={to} className="flex h-row items-center justify-between gap-4 px-4 text-body text-paper-900">
        {label}
        {/* Directionnel : il se retourne en RTL (BRAND-UI § 9). */}
        <ChevronRight aria-hidden="true" className="size-6 shrink-0 text-paper-600 rtl:-scale-x-100" />
      </Link>
    </li>
  )
}

export function HomeScreen() {
  const { user, signOut } = useAuth()
  const canManageUsers = useCan('manage_users')
  const canManageDevices = useCan('manage_devices')
  const canViewAuditLog = useCan('view_audit_log')
  const canManageSettings = useCan('manage_settings')

  /*
   * Chaque lien est masqué en plus du contrôle serveur, jamais à sa place : les
   * routes gardent leur `RequireCapability`, les tables leurs policies.
   * La question passe par la matrice § 3.1 (`useCan`), jamais par une
   * comparaison de rôle — sauf Commerces : administrer les commerces n'est pas
   * une case de § 3.1, et le lien suit le garde de son écran, `RequireSuperAdmin`
   * (E1-01).
   */
  const management: Destination[] = [
    { to: '/users', label: 'Employés', visible: canManageUsers },
    { to: '/devices', label: 'Appareils', visible: canManageDevices },
    { to: '/audit', label: 'Journal', visible: canViewAuditLog },
    { to: '/settings', label: 'Paramètres', visible: canManageSettings },
    { to: '/admin/tenants', label: 'Commerces', visible: user?.role === 'super_admin' },
  ].filter((destination) => destination.visible)

  return (
    <main className="px-4 py-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div>
          <h1 className="text-title text-paper-900">Merx</h1>
          <p className="mt-2 text-body text-paper-700">Vous êtes connecté.</p>
        </div>

        <dl className="flex flex-col gap-4">
          <div>
            <dt className="text-label text-paper-600">Compte</dt>
            <dd className="text-body text-paper-900">{user?.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-label text-paper-600">Rôle</dt>
            <dd className="text-body text-paper-900">
              {user?.role === undefined || user.role === null ? '—' : ROLE_LABELS[user.role]}
            </dd>
          </div>
          <div>
            <dt className="text-label text-paper-600">Commerce</dt>
            {/* Un identifiant est une donnée : chiffres tabulaires (BRAND-UI § 6). */}
            <dd className="tabular text-body text-paper-900">{user?.tenantId ?? '—'}</dd>
          </div>
        </dl>

        {/* Un employé n'a aucune de ces destinations : le bloc n'existe pas
            pour lui, plutôt qu'un titre au-dessus du vide. */}
        {management.length > 0 && (
          <section aria-labelledby="management-title" className="flex flex-col gap-2">
            <h2 id="management-title" className="text-subtitle text-paper-900">
              Gestion du commerce
            </h2>
            <ul className="rounded-card border border-paper-200 bg-white">
              {management.map((destination) => (
                <DestinationRow key={destination.to} to={destination.to} label={destination.label} />
              ))}
            </ul>
          </section>
        )}

        <Button
          type="button"
          onClick={() => void signOut()}
          className="h-button w-full rounded-button border border-paper-300 bg-white text-body text-ink-700"
          variant="outline"
        >
          Se déconnecter
        </Button>
      </div>
    </main>
  )
}
