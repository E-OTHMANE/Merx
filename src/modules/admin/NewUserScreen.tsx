/*
 * Création d'un employé. M8 — E1-02.
 *
 * Les trois champs de la story — nom, téléphone, mot de passe. Il n'y a pas
 * d'email : l'identifiant Supabase Auth est dérivé du numéro (`@/lib/phone`),
 * comme pour le patron en E1-01.
 *
 * Il n'y a pas non plus de choix de rôle, et ce n'est pas un oubli : cet écran
 * crée un `worker`, et `create_worker()` écrit le rôle elle-même. Un sélecteur
 * ici supposerait un rôle transmis au serveur, c'est-à-dire une surface
 * d'escalade à garder fermée à chaque évolution.
 *
 * BRAND-UI § 6 : « un bouton dit ce qu'il fait » — « Créer l'employé ».
 */

import { useId, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { normalizePhone } from '@/lib/phone'
import { Field } from '@/components/Field'
import { createWorker } from '@/modules/admin/users'

export function NewUserScreen() {
  const navigate = useNavigate()

  const nameId = useId()
  const phoneId = useId()
  const passwordId = useId()
  const errorId = useId()

  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    // Un second appui pendant l'appel créerait un second compte
    // d'authentification, et une seconde fiche.
    if (submitting) return

    setMessage(null)

    /*
     * Contrôlé avant l'appel réseau, avec la fonction même qui servira à dériver
     * l'identifiant. Le serveur revérifie — c'est lui qui décide — mais un
     * numéro manifestement faux n'a pas à faire l'aller-retour, ni à créer un
     * compte qu'il faudrait ensuite supprimer.
     */
    if (normalizePhone(phone) === null) {
      setMessage('Numéro de téléphone invalide. Exemple : 06 12 34 56 78.')
      return
    }

    setSubmitting(true)
    try {
      const created = await createWorker({ fullName, phone, password })
      // Le numéro canonique, pas celui qui a été tapé : c'est celui que
      // l'employé devra saisir pour se connecter.
      navigate('/users', { replace: true, state: { created: created.phone } })
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'Création impossible.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-dvh px-4 py-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div>
          <h1 className="text-title text-paper-900">Nouvel employé</h1>
          <p className="mt-2 text-body text-paper-700">
            Il se connectera avec son numéro et ce mot de passe. Il ne verra ni vos prix d’achat ni
            vos marges.
          </p>
        </div>

        <form className="flex flex-col gap-6" onSubmit={onSubmit} noValidate>
          <Field
            id={nameId}
            label="Nom de l’employé"
            value={fullName}
            onChange={setFullName}
            autoComplete="name"
          />

          <Field
            id={phoneId}
            label="Téléphone de l’employé"
            value={phone}
            onChange={setPhone}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className="tabular"
            hint="Sert d’identifiant de connexion. Exemple : 06 12 34 56 78."
          />

          <Field
            id={passwordId}
            label="Mot de passe de l’employé"
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete="new-password"
            hint="Au moins 6 caractères. À transmettre à l’employé."
          />

          {message !== null && (
            <p id={errorId} role="alert" className="text-body text-red-600">
              {message}
            </p>
          )}

          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              disabled={submitting}
              className="h-button w-full rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
            >
              {submitting ? 'Création…' : 'Créer l’employé'}
            </Button>

            <Link
              to="/users"
              className="flex h-button items-center justify-center rounded-button border border-paper-300 bg-white text-body text-ink-700"
            >
              Annuler
            </Link>
          </div>
        </form>
      </div>
    </main>
  )
}
