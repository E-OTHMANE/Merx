/*
 * Ce que l'utilisateur lit quand la connexion échoue. E0-04.
 *
 * BRAND-UI § 6 : « Une erreur explique ce qui s'est passé et comment le
 * réparer. Elle ne s'excuse pas. » Aucun message générique : derrière un
 * comptoir, « une erreur est survenue » se traduit par un appel téléphonique.
 *
 * Les messages sont ici, pas dans l'écran : l'écran de connexion n'est pas le
 * seul endroit qui peut les produire — une fiche désactivée pendant que
 * l'application tourne déconnecte l'utilisateur sans passer par le formulaire.
 */

export const AUTH_MESSAGES = {
  /**
   * Le compte existe et le mot de passe est bon, mais le jeton ne porte aucun
   * commerce : pas de fiche `app_user`, fiche désactivée, ou fiche supprimée
   * (cas traités par le hook `merx.custom_access_token()`, E0-03).
   *
   * Le message nomme la cause. Un « accès refusé » enverrait le commerçant au
   * téléphone sans qu'il sache quoi demander ; là, il sait quoi dire à son
   * responsable, et le responsable sait quoi corriger.
   */
  noTenant: "Votre compte n'est rattaché à aucun commerce. Contactez votre responsable.",

  /**
   * Le compte existe, le mot de passe est bon, et la fiche a été désactivée :
   * le hook `merx.custom_access_token()` refuse d'émettre le jeton (E1-02), et
   * Supabase Auth rend un 403.
   *
   * Distinct de `badCredentials`, et c'est tout l'intérêt : un employé coupé
   * par son patron qui lirait « mot de passe incorrect » retaperait son mot de
   * passe dix fois, puis appellerait pour signaler une panne. Là, il sait ce
   * qui s'est passé, et son patron sait quoi corriger.
   */
  deactivated: 'Ce compte a été désactivé. Contactez votre responsable.',

  /** Identifiants refusés. On ne dit pas lequel des deux est faux. */
  badCredentials: 'Numéro ou mot de passe incorrect. Vérifiez votre saisie.',

  /**
   * La saisie n'est ni un numéro marocain ni une adresse. E1-01 : le patron se
   * connecte avec son téléphone, dont l'identifiant Supabase Auth est dérivé.
   *
   * Distinct de `badCredentials`, et c'est le point : un numéro mal saisi n'est
   * pas un mot de passe faux. Les confondre enverrait le commerçant chercher
   * une erreur là où il n'y en a pas. Le message donne la forme attendue plutôt
   * que de la décrire — un exemple se recopie, une règle se relit deux fois.
   */
  badIdentifier: 'Numéro de téléphone invalide. Exemple : 06 12 34 56 78.',

  /** Le serveur n'a pas répondu. La connexion est le seul écran qui l'exige. */
  offline: 'Serveur injoignable. Vérifiez la connexion internet, puis réessayez.',

  /** Trop de tentatives — Supabase limite les tentatives par IP. */
  tooManyRequests: 'Trop de tentatives. Attendez une minute, puis réessayez.',

  /** Champs vides. Contrôlé avant l'appel réseau : inutile de le faire voyager. */
  missingFields: 'Saisissez votre numéro de téléphone et votre mot de passe.',
} as const
