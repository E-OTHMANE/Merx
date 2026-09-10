/*
 * Le numéro de téléphone comme identité, côté front. E1-01.
 *
 * Ce fichier ne fait que réexporter. L'implémentation vit dans
 * `supabase/functions/_shared/phone.ts`, seul emplacement que Deno et Vite
 * atteignent tous les deux — la fonction Edge dérive l'adresse à la création du
 * commerce, le front la dérive à la connexion, et les deux doivent produire le
 * même résultat au caractère près. Une seconde copie serait une divergence en
 * attente, dont la conséquence serait un patron qui ne peut plus entrer.
 *
 * Le chemin naturel reste donc `@/lib/phone` pour tout le front ; l'inversion
 * s'arrête ici.
 */

export {
  accountIdentifier,
  authEmailFor,
  normalizePhone,
  DERIVED_EMAIL_DOMAIN,
} from '../../supabase/functions/_shared/phone'
