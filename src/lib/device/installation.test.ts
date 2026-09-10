/*
 * L'identité de l'appareil — E1-03.
 *
 * Ce fichier tient une seule propriété, et c'est celle dont dépend tout le
 * reste : le même appareil garde le même identifiant. Sans elle,
 * `register_device()` a beau être idempotente côté base, chaque démarrage
 * présente un appareil neuf, consomme une lettre, et les 26 du commerce sont
 * brûlées en une semaine (SPEC § 2.5, RÈGLE numérotation).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEVICE_STORAGE_KEY, installationId } from '@/lib/device/installation'

beforeEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("l'identifiant d'installation", () => {
  it('est le même d’un appel à l’autre', () => {
    expect(installationId()).toBe(installationId())
  })

  it('survit à un redémarrage — il est écrit dans le stockage local', () => {
    const first = installationId()

    expect(window.localStorage.getItem(DEVICE_STORAGE_KEY)).toBe(first)
    expect(installationId()).toBe(first)
  })

  it('est un uuid, la forme que la base attend', () => {
    expect(installationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('diffère d’une installation à l’autre', () => {
    const first = installationId()
    window.localStorage.clear()

    expect(installationId()).not.toBe(first)
  })

  /*
   * Une valeur abîmée — édition manuelle, ancien format, stockage partagé avec
   * autre chose — serait refusée par la base en `22P02`, et l'appareil ne
   * s'enregistrerait plus jamais. Mieux vaut la remplacer.
   */
  it('remplace une valeur qui n’est pas un uuid', () => {
    window.localStorage.setItem(DEVICE_STORAGE_KEY, 'pas-un-uuid')

    const id = installationId()

    expect(id).not.toBe('pas-un-uuid')
    expect(window.localStorage.getItem(DEVICE_STORAGE_KEY)).toBe(id)
  })

  /*
   * `crypto.randomUUID()` n'existe pas sur les WebView anciennes ni hors
   * contexte sécurisé — et les tablettes du terrain sont exactement ce parc-là.
   * Le repli doit rendre la même forme, sinon la base refuse.
   */
  it('se replie sur getRandomValues quand randomUUID manque', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    })

    expect(installationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  /*
   * Navigation privée, quota saturé, réglage d'entreprise : `localStorage` lève
   * à la lecture comme à l'écriture. L'appareil doit démarrer quand même —
   * refuser de démarrer serait pire, et il n'y a rien à dire à l'utilisateur.
   */
  it('rend quand même un identifiant si le stockage est refusé', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('stockage refusé')
    })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('stockage refusé')
    })

    const id = installationId()

    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    // Le temps de l'onglet, au moins : l'appareil ne change pas d'identité entre
    // deux écrans de la même session.
    expect(installationId()).toBe(id)
  })
})
