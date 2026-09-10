/*
 * Surface publique du module Administration (M8). E1-01.
 *
 * CLAUDE.md : un module s'importe par son `index.ts`, jamais par ses
 * internes. Ce qui n'est pas ici n'existe pas pour le reste de l'application.
 */

export { TenantListScreen } from '@/modules/admin/TenantListScreen'
export { NewTenantScreen } from '@/modules/admin/NewTenantScreen'
export { createTenant, listTenants, type NewTenant, type TenantSummary } from '@/modules/admin/api'

/* Les employés du commerce. E1-02. */
export { UserListScreen } from '@/modules/admin/UserListScreen'
export { NewUserScreen } from '@/modules/admin/NewUserScreen'
export {
  createWorker,
  listUsers,
  setUserActive,
  type Employee,
  type NewWorker,
} from '@/modules/admin/users'

/* Les appareils du commerce, et leur lettre de numérotation. E1-03. */
export { DeviceListScreen } from '@/modules/admin/DeviceListScreen'
export { listDevices, type Device } from '@/modules/admin/devices'

/* Les réglages du commerce. E1-05. Aucune valeur par défaut ici : elles vivent
   en base, dans `merx.setting_default`. */
export { SettingsScreen } from '@/modules/admin/SettingsScreen'
export { loadSettings, saveSettings, type Settings } from '@/modules/admin/settings'
export {
  SETTING_KEYS,
  LANGUAGES,
  type SettingKey,
  type Language,
  type PrintHeaderValue,
} from '@/modules/admin/settingKeys'

/* Le journal d'audit. E1-04. */
export { AuditLogScreen } from '@/modules/admin/AuditLogScreen'
export {
  listAuditEntries,
  ACTION_LABELS,
  type AuditAction,
  type AuditEntry,
  type AuditFilter,
} from '@/modules/admin/audit'
