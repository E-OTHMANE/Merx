/*
 * Les bornes d'une journée de commerce — déplacées d'`audit.ts` en E4-07.
 *
 * Une seule copie, mesurée une fois : le journal d'audit et la liste des
 * documents en dépendent tous deux, et un écart d'une heure fait sortir les
 * ventes du matin ou entrer celles de la veille au soir.
 */

import { describe, expect, it } from 'vitest'

import { endOfDay, startOfDay } from '@/lib/day'

describe('les bornes d’un jour à Casablanca', () => {
  it('commence le jour à minuit, heure du comptoir', () => {
    expect(startOfDay('2026-10-09')).toBe('2026-10-09T00:00:00+01:00')
  })

  it('finit le jour au début du suivant, borne exclusive', () => {
    expect(endOfDay('2026-10-09')).toBe('2026-10-10T00:00:00+01:00')
  })

  it('passe la fin de mois sans casser', () => {
    expect(endOfDay('2026-10-31')).toBe('2026-11-01T00:00:00+01:00')
    expect(endOfDay('2026-12-31')).toBe('2027-01-01T00:00:00+01:00')
  })

  /*
   * Le Maroc repasse à UTC+0 pendant le Ramadan (2026 : mi-février à mi-mars).
   * Le décalage est demandé au navigateur pour la date concernée, jamais une
   * constante : le 1er mars 2026 est à +00:00, le 9 octobre à +01:00.
   */
  it('demande le décalage à la date, pas à une constante', () => {
    expect(startOfDay('2026-03-01')).toBe('2026-03-01T00:00:00+00:00')
  })
})
