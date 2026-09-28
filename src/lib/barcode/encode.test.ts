/*
 * Code 128 — E2-06.
 *
 * Un code-barres faux s'imprime sans erreur. Il ne se constate qu'au comptoir,
 * une douchette à la main, sur des étiquettes déjà collées. D'où deux sortes de
 * tests ici : l'invariant du tableau des motifs, qui attrape une faute de
 * frappe, et des vecteurs figés, qui attrapent une régression de l'encodage.
 */

import { describe, expect, it } from 'vitest'

import { CODE128_PATTERNS, code128Width, encodeCode128 } from '@/lib/barcode/encode'

/** Le motif d'arrêt, seul à faire sept éléments et treize modules. */
const STOP_PATTERN = '2331112'

describe('le tableau des motifs', () => {
  it('compte 107 motifs — 106 symboles et l’arrêt', () => {
    expect(CODE128_PATTERNS).toHaveLength(107)
  })

  it('donne six éléments et onze modules à chaque symbole', () => {
    const symbols = CODE128_PATTERNS.slice(0, 106)

    for (const [value, pattern] of symbols.entries()) {
      const widths = [...pattern].map(Number)
      expect(widths, `motif ${value}`).toHaveLength(6)
      expect(
        widths.reduce((total, width) => total + width, 0),
        `motif ${value}`,
      ).toBe(11)
    }
  })

  it('finit par un arrêt de sept éléments et treize modules', () => {
    expect(CODE128_PATTERNS[106]).toBe(STOP_PATTERN)
    expect([...STOP_PATTERN].map(Number).reduce((total, width) => total + width, 0)).toBe(13)
  })

  it('n’emploie que des largeurs de un à quatre modules', () => {
    for (const pattern of CODE128_PATTERNS) {
      expect(pattern).toMatch(/^[1-4]+$/)
    }
  })
})

describe('l’encodage', () => {
  /*
   * Vecteur figé, jeu C : « 123456 » — six chiffres, donc trois symboles au
   * lieu de six. Départ C (105), 12, 34, 56, somme de contrôle 44, arrêt.
   */
  it('encode une valeur numérique de longueur paire en jeu C', () => {
    const code = encodeCode128('123456')

    expect(code).not.toBeNull()
    expect(code!.modules.join('')).toBe('211232' + '112232' + '131123' + '331121' + '132131' + STOP_PATTERN)
  })

  /*
   * Vecteur figé, jeu B : « A ». Départ B (104), 'A' à la valeur 33, somme de
   * contrôle (104 + 33) mod 103 = 34, arrêt.
   */
  it('encode le texte en jeu B', () => {
    const code = encodeCode128('A')

    expect(code!.modules.join('')).toBe('211214' + '111323' + '131123' + STOP_PATTERN)
  })

  it('encode un SKU engendré, qui n’est pas tout en chiffres', () => {
    const code = encodeCode128('A-00001')

    expect(code).not.toBeNull()
    expect(code!.value).toBe('A-00001')
    // Départ, sept caractères, somme de contrôle, arrêt.
    expect(code!.modules).toHaveLength(6 * 9 + 7)
  })

  it('passe en jeu B pour un nombre de chiffres impair — le jeu C va par paires', () => {
    const odd = encodeCode128('12345')
    const even = encodeCode128('1234')

    expect(odd!.modules.length).toBeGreaterThan(even!.modules.length)
  })

  it('commence par une barre et finit par une barre', () => {
    const code = encodeCode128('6111234567890')

    // Les largeurs alternent barre, espace, … : un nombre impair d'éléments
    // place une barre au début et une barre à la fin.
    expect(code!.modules.length % 2).toBe(1)
  })

  it('rend la largeur totale en modules', () => {
    const code = encodeCode128('A')!

    // Départ, une donnée, somme de contrôle : trois symboles de onze, plus
    // treize pour l'arrêt.
    expect(code128Width(code)).toBe(3 * 11 + 13)
  })
})

describe('ce qui ne s’encode pas', () => {
  it('refuse une valeur vide', () => {
    expect(encodeCode128('')).toBeNull()
  })

  /*
   * SPEC § 2.6 : la fonctionnalité privée de sa donnée se désactive en silence.
   * Une référence en arabe n'a pas de symbole en Code 128 ; l'étiquette ne
   * s'offre pas pour cette variante, et rien ne réclame de la translittérer.
   */
  it('refuse une valeur hors de l’imprimable ASCII', () => {
    expect(encodeCode128('صابون')).toBeNull()
    expect(encodeCode128('CRÈME-1')).toBeNull()
  })

  it('refuse une valeur porteuse d’un caractère de contrôle', () => {
    expect(encodeCode128('A-0001\r')).toBeNull()
  })
})
