/*
 * Les droits, côté interface. E0-05 — SPEC § 3.1.
 *
 * Ce fichier ne décide rien. Il tient une copie de la matrice pour savoir quoi
 * afficher ; ce qui protège les données est `merx.can()`, côté base, relu à
 * chaque requête depuis le jeton signé (SPEC § 3, RÈGLE de filtrage serveur).
 * Un utilisateur qui trafiquerait son stockage local se donnerait un bouton,
 * pas une ligne de données.
 *
 * La copie est prouvée conforme : `supabase/tests/permissions.test.ts` compare
 * `CAPABILITIES` à `merx.role_capability`, case par case. Une case ajoutée d'un
 * seul côté casse le build. C'est la seule raison pour laquelle il est
 * acceptable d'écrire la matrice deux fois — sans ce test, les deux
 * divergeraient, et la divergence s'afficherait comme un droit.
 *
 * Ce fichier reste sans dépendance à React : le test de conformité l'importe
 * depuis `supabase/tests`, qui compile hors navigateur. Le hook vit à côté,
 * dans `useCan.ts`.
 */

import type { UserRole } from '@/lib/auth/claims'

/** Les capacités de SPEC § 3.1. Le nom est celui de `merx.role_capability`. */
export type Capability =
  | 'view_catalogue'
  | 'manage_product'
  | 'view_cost'
  | 'manage_price_list'
  | 'create_sale'
  | 'override_price'
  | 'override_price_below_floor'
  | 'cancel_document'
  | 'manage_client'
  | 'set_credit_limit'
  | 'exceed_credit_limit'
  | 'collect_payment'
  | 'receive_goods'
  | 'adjust_stock'
  | 'count_stock'
  | 'approve_stock_variance'
  | 'view_reports'
  | 'manage_users'
  | 'manage_devices'
  | 'view_audit_log'
  | 'manage_settings'

/**
 * La matrice § 3.1, dans le même ordre que le tableau du spec pour qu'elle se
 * relise en regard.
 *
 * `super_admin` n'y figure pas : la matrice du spec n'a que deux colonnes.
 * L'éditeur est traité en amont par `can()`, comme il l'est côté base par
 * `merx.can()` et par la policy `super_admin_all`.
 */
export const CAPABILITIES: Readonly<Record<Capability, readonly UserRole[]>> = {
  view_catalogue: ['owner', 'worker'],
  manage_product: ['owner'],
  view_cost: ['owner'],
  manage_price_list: ['owner'],
  create_sale: ['owner', 'worker'],
  override_price: ['owner', 'worker'],
  /*
   * L'astérisque de § 3.1 : le `worker` force un prix, mais jamais sous le
   * `floor_price`. La comparaison au plancher appartient à M3 et suppose la
   * grille de prix (E2, E4) ; la règle de rôle, elle, est ici dès aujourd'hui.
   */
  override_price_below_floor: ['owner'],
  cancel_document: ['owner'],
  manage_client: ['owner', 'worker'],
  set_credit_limit: ['owner'],
  exceed_credit_limit: ['owner'],
  collect_payment: ['owner', 'worker'],
  receive_goods: ['owner', 'worker'],
  /*
   * E3-03. Corriger une quantité à la main, et c'est le patron seul : aucune
   * autre capacité de § 3.1 ne dit cela. `approve_stock_variance` est la
   * validation d'un écart d'inventaire (E3-04) — l'emprunter rendrait
   * impossible de retirer l'ajustement sans retirer l'inventaire. La RÈGLE M2-5
   * annonçait l'inverse ; c'est elle qui a été corrigée, pas la matrice.
   */
  adjust_stock: ['owner'],
  count_stock: ['owner', 'worker'],
  approve_stock_variance: ['owner'],
  view_reports: ['owner'],
  manage_users: ['owner'],
  /*
   * E1-03. La liste des appareils dit quelle tablette porte quelle lettre de
   * numérotation ; l'employé, lui, enregistre la sienne sans ce droit —
   * `register_device()` ne demande aucune capacité, la policy restrictive sur
   * `device` tient la lecture.
   */
  manage_devices: ['owner'],
  /*
   * E1-04. Le journal nomme des personnes ; il ne se confond pas avec les
   * rapports, qui agrègent une activité. Séparer les deux capacités coûte une
   * ligne aujourd'hui et évite une migration sur les droits le jour où un
   * commerce voudra un chef de rayon qui lit les rapports sans lire le journal.
   */
  view_audit_log: ['owner'],
  /*
   * E1-05. L'écriture des réglages seulement : la lecture n'exige aucune
   * capacité, parce que l'employé imprime le bon et travaille dans la langue
   * du commerce. Première capacité du projet qui ne garde que l'écriture —
   * posée par `merx.apply_write_capability_restriction()`.
   */
  manage_settings: ['owner'],
}

/**
 * Un rôle a-t-il une capacité ? Un rôle absent — jeton sans claim, session en
 * cours d'ouverture — n'a rien : l'absence de droit se lit comme un refus, pas
 * comme un cas à traiter chez l'appelant.
 */
export function can(role: UserRole | null | undefined, capability: Capability): boolean {
  if (role === null || role === undefined) return false
  if (role === 'super_admin') return true
  return CAPABILITIES[capability].includes(role)
}
