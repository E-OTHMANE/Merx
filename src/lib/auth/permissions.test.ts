/*
 * E0-05 — la matrice § 3.1 côté interface.
 *
 * Ce fichier vérifie la lecture de la matrice, pas le contrôle d'accès : le
 * contrôle est côté base, et c'est `supabase/tests/permissions.test.ts` qui le
 * prouve sur une vraie réponse HTTP. Ici on s'assure seulement que l'interface
 * ne se trompe pas dans ce qu'elle cache — et surtout qu'elle ne prend jamais
 * l'absence de rôle pour une permission.
 */

import { describe, expect, it } from 'vitest'

import { CAPABILITIES, can, type Capability } from '@/lib/auth/permissions'

const OWNER_ONLY: readonly Capability[] = [
  'manage_product',
  'view_cost',
  'manage_price_list',
  'override_price_below_floor',
  'cancel_document',
  'set_credit_limit',
  'exceed_credit_limit',
  'approve_stock_variance',
  'adjust_stock',
  'view_reports',
  'manage_users',
  'manage_devices',
  'view_audit_log',
  'manage_settings',
]

const SHARED: readonly Capability[] = [
  'view_catalogue',
  'create_sale',
  'override_price',
  'manage_client',
  'collect_payment',
  'receive_goods',
  'count_stock',
]

describe('la matrice SPEC § 3.1', () => {
  it('couvre exactement les capacités du spec, sans doublon de classement', () => {
    expect([...OWNER_ONLY, ...SHARED].sort()).toEqual(Object.keys(CAPABILITIES).sort())
  })

  it.each(OWNER_ONLY)('%s : le patron seul', (capability) => {
    expect(can('owner', capability)).toBe(true)
    expect(can('worker', capability)).toBe(false)
  })

  it.each(SHARED)('%s : le patron et l’employé', (capability) => {
    expect(can('owner', capability)).toBe(true)
    expect(can('worker', capability)).toBe(true)
  })
})

describe('les cas où il n’y a pas de rôle', () => {
  /*
   * Le cas qui compte. Au premier rendu, la session n'est pas encore relue ;
   * pendant ce temps `role` est nul. Si `can()` répondait `true` par défaut,
   * l'interface montrerait les actions du patron à tout le monde le temps d'un
   * battement — assez pour qu'un employé voie ce qu'il ne doit pas voir.
   */
  it.each([null, undefined])('%s n’ouvre aucune capacité', (role) => {
    for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
      expect(can(role, capability)).toBe(false)
    }
  })
})

describe('l’éditeur', () => {
  it('passe partout, sans figurer dans la matrice', () => {
    for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
      expect(can('super_admin', capability)).toBe(true)
      expect(CAPABILITIES[capability]).not.toContain('super_admin')
    }
  })
})
