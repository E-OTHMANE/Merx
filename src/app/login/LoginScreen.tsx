/*
 * Écran de connexion. E0-04.
 *
 * BRAND-UI § 7 : les actions principales sont dans le tiers bas de l'écran,
 * atteignables au pouce ; le haut porte l'information. La carte est donc
 * poussée vers le bas sur téléphone (`justify-end`), et centrée quand la
 * hauteur le permet.
 *
 * BRAND-UI § 9 : propriétés logiques uniquement — `text-start`, `ms-`, `pe-`.
 * Rien à reprendre le jour où l'arabe arrive (E11).
 */

import { useId, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/lib/auth'

export function LoginScreen() {
  const { signIn, message } = useAuth()

  const identifierId = useId()
  const passwordId = useId()
  const errorId = useId()

  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    // Deux appuis sur un bouton lent, c'est deux tentatives comptées par la
    // limite de débit de Supabase — et l'utilisateur se retrouve bloqué.
    if (submitting) return

    setSubmitting(true)
    try {
      await signIn(identifier, password)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-dvh flex-col justify-end px-4 py-6 sm:justify-center">
      <div className="mx-auto w-full max-w-md">
        <h1 className="text-title text-paper-900">Merx</h1>
        <p className="mt-2 text-body text-paper-700">Connectez-vous à votre commerce.</p>

        <form className="mt-8 flex flex-col gap-6" onSubmit={onSubmit} noValidate>
          <div className="flex flex-col gap-2">
            {/*
              * E1-01 : l'identifiant est le numéro de téléphone. L'adresse
              * Supabase Auth en est dérivée (`@/lib/phone`) et n'apparaît
              * jamais — un commerçant de Derb Omar n'a pas forcément d'email,
              * mais il a toujours son numéro.
              *
              * `type="tel"` et `inputMode="tel"` ouvrent le pavé numérique sur
              * une tablette : c'est un clavier de moins à changer, mille fois
              * par an. `type="text"` en dessous serait un `type="tel"` sans le
              * clavier — l'éditeur, qui saisit une adresse, n'est pas gêné :
              * le pavé numérique des tablettes bascule en un appui, et lui se
              * connecte une fois par mois, pas une fois par jour.
              */}
            <label className="text-label text-paper-700 text-start" htmlFor={identifierId}>
              Téléphone
            </label>
            <Input
              id={identifierId}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="tabular"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              {...(message === null ? {} : { 'aria-describedby': errorId })}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-label text-paper-700 text-start" htmlFor={passwordId}>
              Mot de passe
            </label>
            <Input
              id={passwordId}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              {...(message === null ? {} : { 'aria-describedby': errorId })}
            />
          </div>

          {/*
           * `role="alert"` : le message est annoncé, pas seulement affiché.
           * Il est rendu au-dessus du bouton, là où le regard revient après
           * l'appui — pas en haut de l'écran, hors du champ de vision.
           */}
          {message !== null && (
            <p id={errorId} role="alert" className="text-body text-red-600">
              {message}
            </p>
          )}

          <Button
            type="submit"
            disabled={submitting}
            className="h-button w-full rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
          >
            {submitting ? 'Connexion…' : 'Se connecter'}
          </Button>
        </form>
      </div>
    </main>
  )
}
