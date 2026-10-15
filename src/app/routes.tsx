/*
 * Les routes de l'application. E0-04.
 *
 * La connexion, un accueil placeholder derrière le garde, et les écrans de
 * l'éditeur (E1-01). Les écrans métier arrivent avec leurs étapes (SPEC § 11).
 *
 * Les chemins sont en anglais, comme tout identifiant du projet (CLAUDE.md) —
 * l'interface est en français, l'URL ne l'est pas.
 */

import { Navigate, Route, Routes } from 'react-router-dom'

import { RequireAuth } from '@/app/RequireAuth'
import { RequireCapability } from '@/app/RequireCapability'
import { RequireSuperAdmin } from '@/app/RequireSuperAdmin'
import { TabLayout } from '@/app/TabLayout'
import { HomeScreen } from '@/app/home/HomeScreen'
import { LoginScreen } from '@/app/login/LoginScreen'
import { useAuth } from '@/lib/auth'
import {
  AuditLogScreen,
  DeviceListScreen,
  NewTenantScreen,
  NewUserScreen,
  SettingsScreen,
  TenantListScreen,
  UserListScreen,
} from '@/modules/admin'
import {
  ImportScreen,
  LabelSheetScreen,
  PriceGridScreen,
  ProductFormScreen,
  ProductListScreen,
} from '@/modules/catalogue'
import { SaleScreen } from '@/modules/sales'
import { VariantStockScreen } from '@/modules/stock'

/**
 * Le pendant du garde : un utilisateur déjà connecté n'a rien à faire sur le
 * formulaire de connexion. Sans cela, revenir en arrière après connexion
 * réaffiche un écran qui ne sert plus à rien.
 */
function SignedOutOnly() {
  const { status } = useAuth()

  if (status === 'signed-in') return <Navigate to="/" replace />
  return <LoginScreen />
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<SignedOutOnly />} />

      <Route element={<RequireAuth />}>
        {/* Les écrans de premier niveau, et eux seuls, sous la barre d'onglets.
            E11-04 — BRAND-UI § 13 : un onglet ou un retour, jamais les deux.
            Toute autre route est un écran de détail et porte un retour ;
            `src/app/navigation.test.tsx` classe chaque chemin de ce fichier. */}
        <Route element={<TabLayout />}>
          <Route path="/" element={<HomeScreen />} />
          {/* L'écran de vente. E4-03, point de rupture n° 2. Onglet en
              position 2 (BRAND-UI § 13), sous `create_sale` — les deux rôles
              l'ont (§ 3.1). Le garde de route masque l'écran ; ce qui protège
              l'écriture sont les policies de `sale_document` et de `sale_line`,
              et les gardes de la table figée (E4-01). */}
          <Route element={<RequireCapability capability="create_sale" />}>
            <Route path="/sale" element={<SaleScreen />} />
          </Route>
          <Route element={<RequireCapability capability="view_catalogue" />}>
            <Route path="/products" element={<ProductListScreen />} />
          </Route>
        </Route>

        {/* Les écrans de l'éditeur. E1-01. Deux gardes emboîtés : le premier
            exige une session, le second le rôle. */}
        <Route element={<RequireSuperAdmin />}>
          <Route path="/admin/tenants" element={<TenantListScreen />} />
          <Route path="/admin/tenants/new" element={<NewTenantScreen />} />
        </Route>

        {/* Les employés du commerce. E1-02 — premier écran interdit à un
            `worker`, et premier garde par capacité : la matrice § 3.1 décide,
            pas une comparaison de rôle écrite ici. */}
        <Route element={<RequireCapability capability="manage_users" />}>
          <Route path="/users" element={<UserListScreen />} />
          <Route path="/users/new" element={<NewUserScreen />} />
        </Route>

        {/* Les appareils du commerce. E1-03. L'écran est réservé au patron
            (`manage_devices`, § 3.1) ; l'enregistrement, lui, ne l'est pas —
            c'est l'employé qui tient la tablette, et il passe par
            `register_device()`, hors de cette route. */}
        <Route element={<RequireCapability capability="manage_devices" />}>
          <Route path="/devices" element={<DeviceListScreen />} />
        </Route>

        {/* Le journal d'audit. E1-04. Le garde de route masque l'écran ; ce qui
            protège les lignes est la policy restrictive sur `audit_log`, qui
            exige `view_audit_log` — un écran masqué se contourne en s'adressant
            à PostgREST (constaté en E1-02). */}
        <Route element={<RequireCapability capability="view_audit_log" />}>
          <Route path="/audit" element={<AuditLogScreen />} />
        </Route>

        {/* Les réglages du commerce. E1-05. Le garde de route masque l'écran ;
            ce qui protège l'écriture sont les trois policies restrictives de
            `tenant_setting`, qui exigent `manage_settings`. La lecture, elle,
            reste ouverte à l'employé hors de cette route — il imprime le bon et
            travaille dans la langue du commerce. */}
        <Route element={<RequireCapability capability="manage_settings" />}>
          <Route path="/settings" element={<SettingsScreen />} />
        </Route>

        {/* Le catalogue. E2-02. La liste se lit par tout le commerce
            (`view_catalogue`) — elle est un onglet, plus haut ; la fiche s'ouvre
            au seul `manage_product`. Le garde de route masque l'écran ; ce qui
            protège l'écriture sont les policies de `product`, de `variant` et
            du compartiment des photos. */}
        <Route element={<RequireCapability capability="manage_product" />}>
          {/* L'import du catalogue. E2-05, point de rupture n° 1 (SPEC § 10).
              Chemin statique avant la fiche : `/products/import` n'est pas un
              identifiant de produit. Le garde de route masque l'écran ; ce qui
              protège sont le garde de `import_products()` et, ligne par ligne,
              les policies d'écriture du catalogue. */}
          <Route path="/products/import" element={<ImportScreen />} />
          <Route path="/products/new" element={<ProductFormScreen />} />
          <Route path="/products/:id" element={<ProductFormScreen />} />
          {/* Les étiquettes. E2-06, RÈGLE M1-5. Sous `manage_product` et non
              sous `view_catalogue` : imprimer peut attribuer un SKU au produit
              et le figer — c'est une modification du catalogue, pas une
              consultation. */}
          <Route path="/products/:id/labels" element={<LabelSheetScreen />} />
        </Route>

        {/* Le stock d'un produit et l'historique de ses variantes. E3-02.
            Sous `view_catalogue` et non `manage_product` : l'acteur de la story
            est le vendeur, et consulter n'écrit rien — aucun type de mouvement
            n'est ouvert à l'écriture avant E3-03. C'est aussi pourquoi son
            retour mène à `/products` et non à la fiche produit, que le vendeur
            ne peut pas ouvrir : un retour vers un écran interdit est une
            impasse. Le garde de route masque l'écran ; ce qui protège sont les
            policies de `stock_level` et les trois gardes de
            `list_stock_movements()`. */}
        <Route element={<RequireCapability capability="view_catalogue" />}>
          <Route path="/products/:id/stock" element={<VariantStockScreen />} />
        </Route>

        {/* La grille de prix. E2-03. « Modifier la grille de prix »
            (`manage_price_list`, § 3.1). Le garde de route masque l'écran ; ce
            qui protège sont les policies de `price_break`, de `variant` pour le
            plancher, et la policy restrictive `view_cost` de `variant_cost`. */}
        <Route element={<RequireCapability capability="manage_price_list" />}>
          <Route path="/products/:id/prices" element={<PriceGridScreen />} />
        </Route>
      </Route>

      {/* Une URL inconnue mène à l'accueil, donc au garde, donc à la connexion
          si la session manque. Aucun écran « page introuvable » à maintenir. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
