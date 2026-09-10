/*
 * E0-04 — le front lit le jeton produit par le hook E0-03, et rien d'autre.
 *
 * Le cas qui compte n'est pas « il sait lire un tenant » : c'est chacune des
 * façons de ne pas en avoir. Un jeton sans commerce qui produirait autre chose
 * que `null` ferait entrer un utilisateur dans une application où la RLS ne lui
 * rendra jamais une ligne, et l'écran vide passerait pour une panne.
 */

import { describe, expect, it } from 'vitest'

import { claimsOf } from '@/lib/auth/claims'
import { fakeToken } from '@/test/fakeAuth'

describe('claimsOf', () => {
  it('lit le commerce et le rôle métier déposés par le hook', () => {
    const token = fakeToken({ tenant_id: 'tenant-a', role: 'owner' })

    expect(claimsOf(token)).toEqual({ tenantId: 'tenant-a', role: 'owner' })
  })

  it.each([
    ['aucun jeton', null],
    ['jeton vide', ''],
    ['jeton illisible', 'pas-un-jwt'],
    ['corps non-JSON', 'entete.$$$.signature'],
  ])('ne rend aucun commerce — %s', (_label, token) => {
    expect(claimsOf(token)).toEqual({ tenantId: null, role: null })
  })

  it.each([
    ['sans app_metadata', null],
    ['app_metadata vide', {}],
    ['tenant_id nul', { tenant_id: null, role: 'owner' }],
    ['tenant_id vide', { tenant_id: '', role: 'owner' }],
    ['rôle seul, sans commerce', { role: 'owner' }],
  ])('ne rend aucun commerce — %s', (_label, metadata) => {
    expect(claimsOf(fakeToken(metadata)).tenantId).toBeNull()
  })

  /*
   * Le `role` de premier niveau est le rôle Postgres. Le confondre avec le rôle
   * métier donnerait le super-admin à toute session authentifiée — c'est
   * exactement la confusion que la migration E0-03 prend soin d'écarter, et le
   * front ne doit pas la réintroduire de son côté.
   */
  it('ignore le rôle de premier niveau du jeton', () => {
    const token = fakeToken({ tenant_id: 'tenant-a' })

    expect(claimsOf(token).role).toBeNull()
  })

  it('ignore un rôle inconnu', () => {
    const token = fakeToken({ tenant_id: 'tenant-a', role: 'administrateur' })

    expect(claimsOf(token).role).toBeNull()
  })
})
