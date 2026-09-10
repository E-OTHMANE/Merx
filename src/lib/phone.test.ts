/*
 * Le numéro comme identité. E1-01.
 *
 * Ce test porte sur la seule fonction que deux exécutions partagent — la
 * fonction Edge, qui dérive l'adresse à la création du commerce, et le front,
 * qui la dérive à la connexion. Sa défaillance n'est pas une erreur visible :
 * c'est un patron qui saisit son propre numéro et à qui l'on répond « mot de
 * passe incorrect ». Rien dans les journaux, rien à l'écran.
 *
 * D'où la forme des cas : ce sont les écritures d'un même numéro, et l'on
 * vérifie qu'elles arrivent toutes à la même identité.
 */

import { describe, expect, it } from 'vitest'

import { accountIdentifier, authEmailFor, normalizePhone } from '@/lib/phone'

/* Toutes les façons d'écrire 0612345678, telles qu'on les voit vraiment. */
const SAME_NUMBER = [
  '0612345678',
  '06 12 34 56 78',
  '06-12-34-56-78',
  '06.12.34.56.78',
  '  0612345678  ',
  '+212612345678',
  '+212 6 12 34 56 78',
  '00212612345678',
  '212612345678',
  // Recopié sans son zéro, ce qui arrive quand on prend la partie qui suit
  // l'indicatif international.
  '612345678',
]

describe('normalizePhone', () => {
  it.each(SAME_NUMBER)('« %s » désigne le même compte', (written) => {
    expect(normalizePhone(written)).toBe('0612345678')
  })

  it('produit une seule identité pour toutes les écritures', () => {
    const identities = new Set(SAME_NUMBER.map((w) => accountIdentifier(w)))
    expect(identities).toEqual(new Set(['0612345678@merx.invalid']))
  })

  it('accepte les autres préfixes marocains', () => {
    expect(normalizePhone('0522334455')).toBe('0522334455')
    expect(normalizePhone('0712345678')).toBe('0712345678')
  })

  /*
   * Le refus compte autant que l'acceptation. Un numéro tronqué normalisé « au
   * mieux » créerait un compte auquel personne ne peut se connecter — et le
   * commerce serait installé, visible dans la liste, inutilisable.
   */
  it.each([
    ['vide', ''],
    ['espaces seuls', '   '],
    ['trop court', '061234567'],
    ['trop long', '06123456789'],
    ['sans zéro initial ni indicatif', '1612345678'],
    ['indicatif étranger', '+33612345678'],
    ['lettres', 'zéro six'],
  ])('refuse %s', (_label, written) => {
    expect(normalizePhone(written)).toBeNull()
  })
})

describe('authEmailFor', () => {
  it('dérive une adresse dans un domaine qui ne peut pas recevoir de courrier', () => {
    // RFC 2606 : `.invalid` n'est jamais délégué. Un domaine plausible
    // laisserait croire qu'un message y arrive un jour.
    expect(authEmailFor('0612345678')).toBe('0612345678@merx.invalid')
  })
})

describe('accountIdentifier', () => {
  it("laisse passer l'adresse de l'éditeur", () => {
    // Le compte super_admin n'est créé par aucun écran : il se connecte par une
    // vraie adresse, et rien ici ne doit la transformer.
    expect(accountIdentifier('editeur@merx.ma')).toBe('editeur@merx.ma')
    expect(accountIdentifier('  editeur@merx.ma  ')).toBe('editeur@merx.ma')
  })

  it('refuse ce qui n’est ni un numéro ni une adresse', () => {
    expect(accountIdentifier('patron')).toBeNull()
    expect(accountIdentifier('')).toBeNull()
  })
})
