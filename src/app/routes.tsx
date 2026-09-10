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
        <Route path="/" element={<HomeScreen />} />

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
      </Route>

      {/* Une URL inconnue mène à l'accueil, donc au garde, donc à la connexion
          si la session manque. Aucun écran « page introuvable » à maintenir. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
