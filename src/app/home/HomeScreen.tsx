/*
 * Écran d'accueil — placeholder. E0-04.
 *
 * Il existe pour qu'il y ait quelque chose derrière le garde de route : sans
 * lui, « session persistante » et « déconnexion » ne se vérifient pas. M8 (E1)
 * le remplacera par le véritable accueil. Rien d'autre ne s'y ajoute d'ici là.
 */

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

export function HomeScreen() {
  const { user, signOut } = useAuth()
  const canManageUsers = useCan('manage_users')
  const canManageDevices = useCan('manage_devices')
  const canViewAuditLog = useCan('view_audit_log')
  const canManageSettings = useCan('manage_settings')

  return (
    <main className="min-h-dvh px-4 py-6">
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

        {/* E1-01 : l'éditeur a un écran, les autres rôles n'en ont pas. Le lien
            est masqué en plus du contrôle serveur, jamais à sa place. */}
        {user?.role === 'super_admin' && (
          <Link
            to="/admin/tenants"
            className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
          >
            Commerces
          </Link>
        )}

        {/* E1-02 : le patron gère ses employés, l'employé ne voit pas le lien.
            La question passe par la matrice § 3.1, jamais par une comparaison
            de rôle écrite ici. */}
        {canManageUsers && (
          <Link
            to="/users"
            className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
          >
            Employés
          </Link>
        )}

        {/* E1-03 : le patron voit ses appareils et leur dernière
            synchronisation. Le lien est masqué en plus de la policy
            restrictive sur `device`, jamais à sa place. */}
        {canManageDevices && (
          <Link
            to="/devices"
            className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
          >
            Appareils
          </Link>
        )}

        {/* E1-04 : le journal nomme qui a fait quoi. Le lien est masqué en
            plus de la policy restrictive sur `audit_log`, jamais à sa place. */}
        {canViewAuditLog && (
          <Link
            to="/audit"
            className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
          >
            Journal
          </Link>
        )}

        {/* E1-05 : les réglages du commerce. Rien n'oblige à les ouvrir — un
            commerce naît réglé. Le lien est masqué en plus des policies
            d'écriture sur `tenant_setting`, jamais à leur place. */}
        {canManageSettings && (
          <Link
            to="/settings"
            className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
          >
            Paramètres
          </Link>
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
