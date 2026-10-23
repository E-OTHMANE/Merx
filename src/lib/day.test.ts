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
   * Le décalage est pris à la date concernée, jamais une constante : le 1er
   * mars 2026 est à +00:00, le 9 octobre à +01:00. Depuis E0-06 il vient de la
   * table de `dates.ts`, et non de l'ICU du navigateur — celle de ce Chrome
   * laisse le Maroc à UTC+0 après février 2026, ce qui décalerait toutes les
   * journées de l'année d'une heure.
   */
  it('prend le décalage à la date, pas à une constante', () => {
    expect(startOfDay('2026-03-01')).toBe('2026-03-01T00:00:00+00:00')
    expect(startOfDay('2026-10-20')).toBe('2026-10-20T00:00:00+01:00')
  })

  /*
   * -------------------------------------------------------------------------
   * Les deux jours de bascule de l'année — E0-06, et le défaut qu'ils tenaient.
   *
   * Les bascules tombent à 02:00 UTC. Le décalage était lu à **midi UTC**,
   * donc du mauvais côté de la bascule les deux jours où cela compte :
   *
   *   — le 2026-02-15, retour à UTC+0 : midi UTC est déjà à +00:00, alors que
   *     minuit local (2026-02-14 23:00Z) est encore à +01:00. La journée
   *     commençait une heure trop tard, et les ventes de minuit à 1 h en
   *     sortaient ;
   *   — le 2026-03-22, retour à UTC+1 : midi UTC est à +01:00, minuit local
   *     (00:00Z le même jour) à +00:00. La journée commençait une heure trop
   *     tôt, donc la veille à 23 h, et avalait les dernières ventes du 21.
   *
   * Le décalage se prend donc à **minuit local**. Une heure de journée mal
   * placée ne se lit pas comme un bogue de fuseau : elle se lit comme une
   * vente disparue.
   * -------------------------------------------------------------------------
   */
  it('commence le jour du retour à UTC+0 à minuit, heure d’avant la bascule', () => {
    expect(startOfDay('2026-02-15')).toBe('2026-02-15T00:00:00+01:00')
    expect(endOfDay('2026-02-14')).toBe('2026-02-15T00:00:00+01:00')
  })

  it('commence le jour du retour à UTC+1 à minuit, heure d’avant la bascule', () => {
    expect(startOfDay('2026-03-22')).toBe('2026-03-22T00:00:00+00:00')
    expect(endOfDay('2026-03-21')).toBe('2026-03-22T00:00:00+00:00')
  })

  /*
   * Le 31 décembre 2029 tombe pendant le Ramadan — la fenêtre s'ouvre le
   * 2029-12-30. La journée du commerçant y est à UTC+0, et la bascule ne
   * change pas de camp au milieu d'une année civile sans que rien ne le dise.
   */
  it('tient le 31 décembre pris dans une fenêtre de Ramadan', () => {
    expect(startOfDay('2029-12-31')).toBe('2029-12-31T00:00:00+00:00')
    expect(endOfDay('2029-12-31')).toBe('2030-01-01T00:00:00+00:00')
  })
})
