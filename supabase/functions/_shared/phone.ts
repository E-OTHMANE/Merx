/*
 * Le numéro de téléphone comme identité. E1-01.
 *
 * SPEC § 9 M8 donne au `tenant` et à l'`app_user` un `phone`, et E1-01 énumère
 * quatre champs — nom du commerce, nom du patron, téléphone, ville — sans
 * email. Or le patron doit pouvoir se connecter immédiatement, et Supabase Auth
 * réclame un identifiant. C'est donc le téléphone, et l'email n'apparaît jamais
 * à l'écran : il est dérivé.
 *
 * Le même numéro s'écrit de six façons — « 06 12 34 56 78 », « 0612345678 »,
 * « +212 612 345 678 », « 00212612345678 ». Sans forme canonique, le patron qui
 * tape son numéro autrement qu'à l'inscription se voit refuser sa connexion, et
 * la cause est invisible : le mot de passe est bon, le compte existe, seule
 * l'adresse dérivée diffère d'un caractère. Un deuxième commerce créé avec le
 * même numéro autrement ponctué passerait aussi, et deux comptes existeraient
 * pour une seule personne.
 *
 * ─── Pourquoi ce fichier est ici plutôt que dans `src/lib` ───
 *
 * Deux exécutions ont besoin de cette fonction, et elles doivent produire le
 * même résultat au caractère près : la fonction Edge, qui dérive l'adresse à la
 * création du commerce, et le front, qui la dérive à la connexion. Une seconde
 * copie serait une divergence en attente — et sa conséquence serait un patron
 * qui ne peut plus entrer.
 *
 * `supabase/functions/_shared/` est le seul emplacement que les deux atteignent
 * : Deno le résout en relatif à la fonction, Vite l'atteint depuis
 * `src/lib/phone.ts`, qui le réexporte pour que le front garde un chemin
 * naturel. L'inversion est assumée — mieux vaut un fichier rangé ailleurs qu'on
 * s'explique qu'une copie qu'on oublie.
 *
 * Aucune dépendance, aucun import : ce fichier doit se charger tel quel sous
 * Deno comme sous Vite.
 */

/**
 * Le domaine des adresses dérivées. `.invalid` est réservé par la RFC 2606 et
 * ne sera jamais délégué : l'adresse ne peut pas recevoir de courrier, et c'est
 * exactement ce qu'on veut dire. Un domaine plausible laisserait croire qu'un
 * message y arrive un jour.
 */
export const DERIVED_EMAIL_DOMAIN = 'merx.invalid'

/**
 * La forme canonique d'un numéro marocain : dix chiffres, commençant par zéro.
 * `null` quand l'entrée n'en est pas un — jamais une valeur approchée, qui
 * produirait un compte auquel personne ne pourrait se connecter.
 *
 * Les quatre écritures reconnues :
 *
 *   0612345678        national, déjà canonique
 *   06 12 34 56 78    national, ponctué — espaces, points, tirets, parenthèses
 *   +212612345678     international
 *   00212612345678    international, préfixe de sortie
 *
 * Et le cas du numéro donné sans son zéro initial — « 612345678 » — que l'on
 * voit quand quelqu'un recopie la partie qui suit l'indicatif.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '')

  // L'ordre compte : « 00212… » commence aussi par « 0 ». Tester le préfixe le
  // plus long d'abord, sans quoi il serait pris pour un numéro national.
  let national = digits
  if (digits.startsWith('00212')) {
    national = `0${digits.slice(5)}`
  } else if (digits.startsWith('212') && digits.length === 12) {
    national = `0${digits.slice(3)}`
  } else if (digits.length === 9 && !digits.startsWith('0')) {
    national = `0${digits}`
  }

  return /^0\d{9}$/.test(national) ? national : null
}

/**
 * L'adresse Supabase Auth d'un numéro. À n'appeler qu'avec une forme déjà
 * canonique : la signature l'exige plutôt que de normaliser à nouveau, pour que
 * l'appelant ne puisse pas dériver une adresse d'une entrée qu'il n'a pas
 * validée.
 */
export function authEmailFor(normalizedPhone: string): string {
  return `${normalizedPhone}@${DERIVED_EMAIL_DOMAIN}`
}

/**
 * Ce que l'utilisateur a saisi, traduit en identifiant Supabase Auth.
 *
 * Une entrée contenant « @ » est prise pour ce qu'elle est. L'éditeur se
 * connecte par une vraie adresse — son compte n'est créé par aucun de ces
 * écrans — et le jour où un compte se rattache à un email réel, il fonctionne
 * sans qu'on touche à ce fichier.
 *
 * `null` quand l'entrée n'est ni l'un ni l'autre : l'appelant le dit à
 * l'utilisateur avant tout appel réseau, plutôt que de lui laisser croire à un
 * mot de passe faux.
 */
export function accountIdentifier(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  if (trimmed.includes('@')) return trimmed

  const normalized = normalizePhone(trimmed)
  return normalized === null ? null : authEmailFor(normalized)
}
