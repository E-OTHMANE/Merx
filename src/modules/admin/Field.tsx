/*
 * Un champ de formulaire d'administration. E1-01, extrait en E1-02.
 *
 * BRAND-UI § 8 : « Le libellé est au-dessus, jamais un simple placeholder — le
 * placeholder disparaît à la saisie et l'utilisateur ne sait plus ce qu'il
 * remplit. » La règle est dans ce composant, pas répétée dans chaque écran :
 * les deux formulaires du module (nouveau commerce, nouvel employé) posent les
 * mêmes questions — un nom, un téléphone, un mot de passe — et doivent se
 * comporter à l'identique. Deux copies auraient divergé sur le premier détail
 * venu : l'autocapitalisation d'un mot de passe, l'`inputMode` d'un numéro.
 */

import { type ReactElement } from 'react'

import { Input } from '@/components/ui/input'

export interface FieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  inputMode?: 'text' | 'tel'
  autoComplete?: string
  /** Précision sous le champ, reliée par `aria-describedby`. */
  hint?: string
  className?: string
}

export function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  inputMode = 'text',
  autoComplete = 'off',
  hint,
  className,
}: FieldProps): ReactElement {
  const hintId = `${id}-hint`

  return (
    <div className="flex flex-col gap-2">
      <label className="text-label text-paper-700 text-start" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        name={id}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        autoCapitalize={type === 'password' ? 'none' : 'sentences'}
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
        {...(className === undefined ? {} : { className })}
      />
      {hint !== undefined && (
        <p id={hintId} className="text-note text-paper-600">
          {hint}
        </p>
      )}
    </div>
  )
}
