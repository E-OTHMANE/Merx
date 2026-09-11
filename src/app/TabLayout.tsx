/*
 * La barre d'onglets. E11-04 — BRAND-UI § 13.
 *
 * Mise en page des seuls écrans de premier niveau : la table des routes décide
 * quels écrans la portent, en les plaçant sous cette route. Un écran de détail
 * n'est pas dessous — il porte un retour à la place, et le tiers bas appartient
 * à son action (BRAND-UI § 7).
 *
 * Un onglet dont la capacité manque ne s'affiche pas. La question passe par
 * `useCan()`, donc par la matrice SPEC § 3.1, sans cas particulier de rôle.
 * Masquer n'est pas interdire : la route garde son `RequireCapability`.
 *
 * Un onglet n'entre dans `TABS` qu'avec son écran. Vente (E4-03), Clients
 * (E6-01) et Rapports (E10-01) viendront avec leur story, dans l'ordre de
 * BRAND-UI § 13 — cinq au plus.
 */

import { House, Package, type LucideIcon } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'

import { useCan, type Capability } from '@/lib/auth'

interface Tab {
  to: string
  label: string
  icon: LucideIcon
  /** Absente : l'onglet est offert à toute session — l'Accueil seul. */
  capability?: Capability
}

const TABS: readonly Tab[] = [
  { to: '/', label: 'Accueil', icon: House },
  { to: '/products', label: 'Produits', icon: Package, capability: 'view_catalogue' },
]

function TabLink({ tab }: { tab: Tab }) {
  const Icon = tab.icon

  return (
    <li className="flex-1">
      {/*
       * BRAND-UI § 13 : l'actif se lit par la couleur **et** le fond, en plein
       * soleil ; l'inactif est en papier 600, pas 400 (§ 5). `NavLink` pose
       * `aria-current="page"` sur l'actif.
       */}
      <NavLink
        to={tab.to}
        className={({ isActive }) =>
          `flex h-row flex-col items-center justify-center gap-1 text-label ${
            isActive ? 'bg-ink-100 text-ink-600' : 'text-paper-600'
          }`
        }
      >
        <Icon aria-hidden="true" className="size-6" />
        {tab.label}
      </NavLink>
    </li>
  )
}

/** Le hook ne s'appelle pas dans une boucle : un composant par onglet gardé. */
function GuardedTabLink({ tab, capability }: { tab: Tab; capability: Capability }) {
  const allowed = useCan(capability)
  return allowed ? <TabLink tab={tab} /> : null
}

function TabBar() {
  return (
    /*
     * Collée en bas, bordure et pas d'ombre (BRAND-UI § 5). La marge de sécurité
     * garde les onglets hors de la barre de gestes d'Android.
     */
    <nav
      aria-label="Navigation principale"
      className="sticky bottom-0 border-t border-paper-200 bg-white pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex w-full max-w-2xl">
        {TABS.map((tab) =>
          tab.capability === undefined ? (
            <TabLink key={tab.to} tab={tab} />
          ) : (
            <GuardedTabLink key={tab.to} tab={tab} capability={tab.capability} />
          ),
        )}
      </ul>
    </nav>
  )
}

/*
 * La colonne occupe tout l'écran et l'écran s'y étire : la barre est en bas
 * même sur un écran presque vide, et collée au bas de la vue quand il défile.
 * Collée plutôt que fixée : elle ne recouvre jamais la dernière ligne — « Ajouter
 * un produit » reste au-dessus d'elle, sans marge calculée à maintenir.
 */
export function TabLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex-1">
        <Outlet />
      </div>
      <TabBar />
    </div>
  )
}
