/*
 * Les clés de réglage, côté interface. E1-05 — SPEC § 9 M8.
 *
 * Ce fichier ne contient **aucune valeur par défaut**, et c'est le point de la
 * story. Les défauts vivent en base, dans `merx.setting_default`, à un seul
 * endroit : deux sources de vérité pour un même défaut divergent, et la
 * divergence se lit comme un réglage qu'on n'a pas fait. Ce que le code
 * connaît, ce sont les clés et la forme de leurs valeurs — pas leur contenu
 * initial, qui est posé à la création du commerce et n'a jamais à être comblé
 * ici (`merx.seed_tenant_settings()`).
 *
 * La liste est comparée aux étiquettes de `public.setting_key` par
 * `supabase/tests/settings.test.ts`. Une clé ajoutée d'un seul côté casse le
 * build — même raison, même remède que `src/lib/auth/permissions.ts` pour la
 * matrice § 3.1.
 *
 * Le fichier reste sans dépendance — ni React, ni client Supabase : le test de
 * conformité l'importe depuis `supabase/tests`, qui compile hors navigateur.
 */

/** Les clés de `public.setting_key`, dans l'ordre de l'enum. */
export const SETTING_KEYS = ['print_header', 'default_language', 'printer_address'] as const

export type SettingKey = (typeof SETTING_KEYS)[number]

/**
 * L'en-tête imprimé en tête du bon (E5-01). Une seule clé et non trois : les
 * trois champs forment un bloc, s'éditent ensemble et s'impriment ensemble.
 *
 * Les noms de champs sont ceux du jsonb, en `snake_case` : c'est la forme
 * stockée, et `settings.ts` est le seul endroit qui la traduit.
 */
export interface PrintHeaderValue {
  business_name: string
  phone: string
  address: string
}

/** Les langues de SPEC § 2.8. La bascule elle-même est E11-01. */
export const LANGUAGES = ['fr', 'ar'] as const

export type Language = (typeof LANGUAGES)[number]

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}
