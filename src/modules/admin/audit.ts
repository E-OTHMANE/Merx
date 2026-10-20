/*
 * Accès au journal d'audit. M8 — E1-04.
 *
 * Lecture seule, et c'est structurel, pas une omission : `authenticated` n'a
 * aucun privilège d'écriture sur `audit_log` (SPEC RÈGLE M8-2). Le seul
 * écrivain est `merx.log_audit()`, appelée par les fonctions serveur qui
 * portent les actions de la RÈGLE M8-1 — aucune n'existe encore, elles arrivent
 * avec leurs modules. Rien à écrire ici, donc, ni aujourd'hui ni plus tard.
 *
 * Aucun filtre de commerce n'est écrit : la policy `tenant_isolation` borne au
 * commerce, la policy restrictive `capability_restriction` exige
 * `view_audit_log`. Un `where` sur le tenant serait un filtre applicatif, ce
 * que SPEC § 2.1 refuse.
 *
 * Les deux filtres que E1-04 demande — l'utilisateur, la date — sont bien des
 * `where`, eux : ce sont des questions du patron, pas des règles de sécurité.
 * Ils s'appliquent *sous* les policies, et ne peuvent donc rien faire
 * apparaître.
 */

import { endOfDay, startOfDay } from '@/lib/day'
import { supabase } from '@/lib/supabase'

/** Les six actions de la RÈGLE M8-1, telles que l'enum les nomme. */
export type AuditAction =
  | 'price_override'
  | 'document_cancellation'
  | 'credit_limit_override'
  | 'stock_variance_approval'
  | 'role_change'
  | 'purchase_price_change'

/**
 * Ce que chaque action se dit en français, à l'écran.
 *
 * Le journal se lit un soir où quelque chose ne tombe pas juste : il doit se
 * lire en une phrase, pas en identifiants (BRAND-UI § 6). La table est
 * exhaustive et typée par `AuditAction` — une septième action ajoutée à l'enum
 * sans sa phrase casse la compilation, ce qui est le seul rappel qui marche.
 */
export const ACTION_LABELS: Readonly<Record<AuditAction, string>> = {
  price_override: 'Prix forcé',
  document_cancellation: 'Document annulé',
  credit_limit_override: 'Plafond dépassé',
  stock_variance_approval: 'Écart d’inventaire validé',
  role_change: 'Rôle modifié',
  purchase_price_change: 'Prix d’achat modifié',
}

/** Une ligne du journal, telle que l'écran du patron la montre. */
export interface AuditEntry {
  id: string
  action: AuditAction
  /** La table visée. Le libellé reste technique : E2 et E4 la peupleront. */
  entityType: string
  entityId: string
  userId: string
  createdAt: string
  before: unknown
  after: unknown
}

interface AuditRow {
  id: string
  action: AuditAction
  entity_type: string
  entity_id: string
  user_id: string
  created_at: string
  before: unknown
  after: unknown
}

export interface AuditFilter {
  /** Un auteur, ou tous. */
  userId?: string | undefined
  /** Bornes de l'intervalle, en date locale `AAAA-MM-JJ`. */
  from?: string | undefined
  to?: string | undefined
}

/**
 * Les lignes du journal, de la plus récente à la plus ancienne.
 *
 * L'ordre est celui de la lecture : on cherche ce qui vient de se passer. La
 * page est bornée — un journal grossit sans fin, et une tablette bon marché ne
 * doit jamais recevoir dix mille lignes pour en afficher trente.
 */
export async function listAuditEntries(
  filter: AuditFilter = {},
  limit = 100,
): Promise<AuditEntry[]> {
  let query = supabase
    .from('audit_log')
    .select('id, action, entity_type, entity_id, user_id, created_at, before, after')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (filter.userId !== undefined && filter.userId !== '') {
    query = query.eq('user_id', filter.userId)
  }
  if (filter.from !== undefined && filter.from !== '') {
    query = query.gte('created_at', startOfDay(filter.from))
  }
  if (filter.to !== undefined && filter.to !== '') {
    query = query.lt('created_at', endOfDay(filter.to))
  }

  const { data, error } = await query

  if (error !== null) throw new Error(error.message)

  return (data as AuditRow[]).map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    userId: row.user_id,
    createdAt: row.created_at,
    before: row.before,
    after: row.after,
  }))
}
