/*
 * Le retour d'un écran de détail. E11-04 — BRAND-UI § 13.
 *
 * Il mène au parent désigné, jamais à l'historique : une PWA lancée sur une URL
 * a un historique vide, et `history(-1)` n'y mènerait nulle part. Le bouton
 * retour d'Android, lui, reste l'historique du navigateur.
 *
 * Chevron **et** nom du parent : BRAND-UI § 11 interdit l'icône seule, et le mot
 * dit où l'on va. Le chevron est directionnel — il se retourne en RTL (§ 9).
 */

import { ChevronLeft } from 'lucide-react'
import { Link } from 'react-router-dom'

interface BackLinkProps {
  /** Le chemin de l'écran parent. */
  to: string
  /** Son nom, tel que l'utilisateur le connaît : « Produits », « Accueil ». */
  label: string
}

export function BackLink({ to, label }: BackLinkProps) {
  return (
    <Link
      to={to}
      aria-label={`Retour : ${label}`}
      className="-ms-2 flex h-touch w-fit items-center gap-1 rounded-button pe-3 text-body text-ink-600"
    >
      <ChevronLeft aria-hidden="true" className="size-6 shrink-0 rtl:-scale-x-100" />
      {label}
    </Link>
  )
}
