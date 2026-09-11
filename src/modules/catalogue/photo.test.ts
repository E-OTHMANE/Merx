/*
 * Le redimensionnement des photos — E2-02. La géométrie seule : le dessin sur
 * canvas n'existe pas dans jsdom, et il n'y a rien à y vérifier que le
 * navigateur ne fasse déjà.
 */

import { describe, expect, it } from 'vitest'

import { PHOTO_MAX_SIDE, fitWithin } from '@/modules/catalogue/photo'

describe('fitWithin', () => {
  it('ramène le plus grand côté à 800 px', () => {
    expect(PHOTO_MAX_SIDE).toBe(800)
    expect(fitWithin(4000, 3000)).toEqual({ width: 800, height: 600 })
  })

  it('en portrait aussi', () => {
    expect(fitWithin(3000, 4000)).toEqual({ width: 600, height: 800 })
  })

  it('laisse une image de 800 px exactement telle quelle', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it('bascule dès 801 px', () => {
    expect(fitWithin(801, 400)).toEqual({ width: 800, height: 400 })
  })

  it('n’agrandit jamais une petite image', () => {
    expect(fitWithin(320, 240)).toEqual({ width: 320, height: 240 })
  })

  it('ne rend jamais une dimension nulle', () => {
    expect(fitWithin(8000, 2)).toEqual({ width: 800, height: 1 })
  })
})
