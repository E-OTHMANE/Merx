import * as React from 'react'

import { cn } from '@/lib/utils'

/*
 * Champ de saisie — BRAND-UI § 8.
 *
 * Hauteur 56 px, bordure neutre 300, encre 600 au focus. Le libellé est posé
 * par l'appelant, au-dessus du champ : un placeholder disparaît à la saisie et
 * l'utilisateur ne sait plus ce qu'il remplit.
 *
 * Texte à 16 px, jamais moins — c'est le plancher pour toute donnée (BRAND-UI
 * § 6), et c'est aussi ce qui empêche iOS de zoomer à chaque mise au point.
 */
function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-field w-full rounded-field border border-paper-300 bg-white px-4',
        'text-body text-paper-900 placeholder:text-paper-500',
        'focus-visible:border-ink-600',
        'disabled:bg-paper-100 disabled:text-paper-600',
        'aria-invalid:border-red-500',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
