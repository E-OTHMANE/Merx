/*
 * Le décalage du Maroc, côté appareil — E0-06.
 *
 * Ce que ce fichier tient : les bords de Ramadan, le 31 décembre à 23 h 30, et
 * l'**horizon** de la table. Ce qu'il ne peut pas tenir : que la table dise la
 * vérité. Une table ne se vérifie pas contre elle-même — elle se mesure contre
 * Postgres, jour par jour, et c'est le travail de
 * `supabase/tests/timezone.test.ts`. Ici on mesure que l'application *lit* la
 * table, et qu'elle la lit aux bons instants.
 */

import { describe, expect, it } from 'vitest'

import {
  MOROCCO_STANDARD_OFFSET,
  RAMADAN_TABLE_HORIZON,
  RAMADAN_UTC_WINDOWS,
  casablancaOffsetLabel,
  casablancaOffsetMinutes,
  fileDate,
  formatDate,
  formatDateTime,
} from '@/lib/dates'

const at = (iso: string): Date => new Date(iso)

describe('le décalage du Maroc', () => {
  it('est UTC+1 hors Ramadan, en toute saison', () => {
    // Juin et décembre : le Maroc n'a plus de saison depuis 2018, et c'est la
    // moitié de la raison pour laquelle une table de treize fenêtres suffit.
    expect(casablancaOffsetMinutes(at('2026-06-15T12:00:00Z'))).toBe(MOROCCO_STANDARD_OFFSET)
    expect(casablancaOffsetMinutes(at('2026-12-15T12:00:00Z'))).toBe(MOROCCO_STANDARD_OFFSET)
  })

  it('repasse à UTC+0 pendant le Ramadan', () => {
    expect(casablancaOffsetMinutes(at('2026-03-01T12:00:00Z'))).toBe(0)
  })

  /*
   * L'instant mesuré le 2026-10-23 qui a ouvert la story : Node et Postgres
   * rendent 13:00, l'ICU de ce Chrome rend 12:00. Merx doit rendre ce que
   * Postgres rend, sur n'importe quel moteur — c'est tout l'objet du fichier.
   */
  it('rend UTC+1 là où l’ICU d’un navigateur en retard rend UTC+0', () => {
    expect(casablancaOffsetMinutes(at('2026-10-20T12:00:00Z'))).toBe(MOROCCO_STANDARD_OFFSET)
    expect(formatDateTime('2026-10-20T12:00:00Z')).toBe('20/10/2026 13:00')
  })

  it('bascule à la seconde, pas au jour', () => {
    // Première fenêtre de la table : la borne basse est incluse, la haute
    // exclue. Une seconde avant, une seconde après.
    expect(casablancaOffsetMinutes(at('2019-05-05T01:59:59Z'))).toBe(MOROCCO_STANDARD_OFFSET)
    expect(casablancaOffsetMinutes(at('2019-05-05T02:00:00Z'))).toBe(0)
    expect(casablancaOffsetMinutes(at('2019-06-09T01:59:59Z'))).toBe(0)
    expect(casablancaOffsetMinutes(at('2019-06-09T02:00:00Z'))).toBe(MOROCCO_STANDARD_OFFSET)
  })

  it('se dit `+01:00` ou `+00:00`', () => {
    expect(casablancaOffsetLabel(at('2026-10-20T12:00:00Z'))).toBe('+01:00')
    expect(casablancaOffsetLabel(at('2026-03-01T12:00:00Z'))).toBe('+00:00')
  })
})

describe('la table elle-même', () => {
  it('est triée et sans chevauchement', () => {
    const bounds = RAMADAN_UTC_WINDOWS.flatMap(([from, to]) => [Date.parse(from), Date.parse(to)])
    expect(bounds.every((value) => Number.isFinite(value))).toBe(true)
    // Les bornes mises à plat sont strictement croissantes : chaque fenêtre
    // s'ouvre après la fermeture de la précédente, et se ferme après s'être
    // ouverte. Une faute de recopie d'une année se voit ici.
    for (let index = 1; index < bounds.length; index += 1) {
      expect(bounds[index]!).toBeGreaterThan(bounds[index - 1]!)
    }
  })

  it('bascule bien toutes ses fenêtres, aux deux bouts', () => {
    const second = 1_000
    for (const [from, to] of RAMADAN_UTC_WINDOWS) {
      const start = Date.parse(from)
      const end = Date.parse(to)
      expect(casablancaOffsetMinutes(new Date(start - second))).toBe(MOROCCO_STANDARD_OFFSET)
      expect(casablancaOffsetMinutes(new Date(start))).toBe(0)
      expect(casablancaOffsetMinutes(new Date(end - second))).toBe(0)
      expect(casablancaOffsetMinutes(new Date(end))).toBe(MOROCCO_STANDARD_OFFSET)
    }
  })

  /*
   * ------------------------------------------------------------------------
   * L'horizon. Ce test rougira, et c'est son métier.
   *
   * Une table écrite à la main a une fin. Passé le dernier instant qu'elle
   * décrit, `casablancaOffsetMinutes()` rend UTC+1 — juste onze mois sur
   * douze, faux pendant le Ramadan suivant, et faux en silence. Deux ans
   * d'avance, c'est le délai qu'il faut pour voir la ligne, régénérer la
   * table et publier un APK (les assets sont empaquetés, § 2.7).
   *
   * Pour la régénérer, contre la base — jamais à la main :
   *
   *   select ts,
   *          timezone('Africa/Casablanca', ts) - timezone('UTC', ts) as decalage
   *   from generate_series(
   *          '2019-01-01 00:00Z'::timestamptz,
   *          '2040-01-01 00:00Z'::timestamptz,
   *          '1 hour') ts
   *   where (timezone('Africa/Casablanca', ts) - timezone('UTC', ts))
   *      <> (timezone('Africa/Casablanca', ts - interval '1 hour')
   *          - timezone('UTC', ts - interval '1 hour'))
   *   order by ts;
   *
   * Chaque paire de lignes est une fenêtre. Puis `npm run test --
   * supabase/tests/timezone.test.ts`, qui la remesure jour par jour, et la
   * procédure annuelle de `docs/PENDING-CHECKS.md` — les dates de Ramadan de
   * `tzdata` sont des prévisions, le Maroc tranche à l'observation de la lune.
   * ------------------------------------------------------------------------
   */
  it('couvre encore deux ans devant', () => {
    const twoYears = 730 * 24 * 60 * 60 * 1_000
    const remaining = Date.parse(RAMADAN_TABLE_HORIZON) - Date.now()
    expect(
      remaining,
      `La table des bascules du Maroc s’arrête au ${RAMADAN_TABLE_HORIZON} : moins de deux ans devant. À régénérer contre Postgres — la requête est dans le commentaire de ce test — puis à republier dans un APK.`,
    ).toBeGreaterThan(twoYears)
  })
})

describe('les dates affichées', () => {
  it('montre la date du comptoir, pas celle d’UTC', () => {
    // 23 h 30 à Greenwich le 31 décembre, c'est le 1er janvier au comptoir.
    expect(formatDate('2026-12-31T23:30:00Z')).toBe('01/01/2027')
    expect(formatDateTime('2026-12-31T23:30:00Z')).toBe('01/01/2027 00:30')
    // Une demi-heure plus tôt, on est encore en 2026 des deux côtés du Maroc.
    expect(formatDateTime('2026-12-31T22:30:00Z')).toBe('31/12/2026 23:30')
  })

  it('montre la date du comptoir aussi pendant le Ramadan', () => {
    // À UTC+0, l'instant et son affichage coïncident : c'est le seul moment de
    // l'année où le Maroc est à l'heure de Greenwich.
    expect(formatDateTime('2026-03-01T23:30:00Z')).toBe('01/03/2026 23:30')
  })

  it('nomme un fichier avec la date du comptoir', () => {
    expect(fileDate('2026-12-31T23:30:00Z')).toBe('2027-01-01')
    expect(fileDate('2026-09-04T12:00:00Z')).toBe('2026-09-04')
  })

  it('rend `null` tel quel, et refuse une date illisible', () => {
    expect(formatDate(null)).toBeNull()
    expect(formatDateTime(null)).toBeNull()
    expect(fileDate(null)).toBeNull()
    expect(formatDate('pas une date')).toBeNull()
    expect(formatDateTime('pas une date')).toBeNull()
    expect(fileDate('pas une date')).toBeNull()
  })
})
