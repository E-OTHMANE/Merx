/*
 * Création d'un commerce. M8 — E1-01.
 *
 * Les quatre champs de la story — nom du commerce, nom du patron, téléphone,
 * ville — plus le mot de passe du patron. Il n'y a pas d'email : l'identifiant
 * Supabase Auth est dérivé du numéro (`@/lib/phone`), et le mot de passe est le
 * seul secret que l'éditeur ait à transmettre.
 *
 * BRAND-UI § 8 : libellé au-dessus du champ, jamais un placeholder seul.
 * BRAND-UI § 6 : « un bouton dit ce qu'il fait » — « Créer le commerce ».
 */

import { useId, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { BackLink } from '@/components/BackLink'
import { Button } from '@/components/ui/button'
import { normalizePhone } from '@/lib/phone'
import { Field } from '@/components/Field'
import { createTenant } from '@/modules/admin/api'

export function NewTenantScreen() {
  const navigate = useNavigate()

  const businessId = useId()
  const ownerId = useId()
  const phoneId = useId()
  const cityId = useId()
  const passwordId = useId()
  const errorId = useId()

  const [businessName, setBusinessName] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [phone, setPhone] = useState('')
  const [city, setCity] = useState('')
  const [password, setPassword] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    // Un second appui pendant l'appel créerait un second commerce, et un second
    // compte d'authentification que rien ne rattacherait.
    if (submitting) return

    setMessage(null)

    /*
     * Contrôlé avant l'appel réseau, avec la fonction même qui servira à
     * dériver l'identifiant. Le serveur revérifie — c'est lui qui décide — mais
     * un numéro manifestement faux n'a pas à faire l'aller-retour, ni à créer
     * un compte qu'il faudrait ensuite supprimer.
     */
    if (normalizePhone(phone) === null) {
      setMessage('Numéro de téléphone invalide. Exemple : 06 12 34 56 78.')
      return
    }

    setSubmitting(true)
    try {
      const created = await createTenant({ businessName, ownerName, phone, city, password })
      // Le numéro canonique, pas celui qui a été tapé : c'est celui que le
      // patron devra saisir pour se connecter.
      navigate('/admin/tenants', { replace: true, state: { created: created.phone } })
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
          <BackLink to="/admin/tenants" label="Commerces" />
          <h1 className="text-title text-paper-900">Nouveau commerce</h1>
          <p className="mt-2 text-body text-paper-700">
            Le patron pourra se connecter avec son numéro et ce mot de passe.
          </p>
        </div>

        <form className="flex flex-col gap-6" onSubmit={onSubmit} noValidate>
          <Field
            id={businessId}
            label="Nom du commerce"
            value={businessName}
            onChange={setBusinessName}
            autoComplete="organization"
          />

          <Field
            id={ownerId}
            label="Nom du patron"
            value={ownerName}
            onChange={setOwnerName}
            autoComplete="name"
          />

          <Field
            id={phoneId}
            label="Téléphone du patron"
            value={phone}
            onChange={setPhone}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className="tabular"
            hint="Sert d’identifiant de connexion. Exemple : 06 12 34 56 78."
          />

          {/* SPEC § 2.6 : le reste est facultatif, et cela se dit. */}
          <Field
            id={cityId}
            label="Ville (facultatif)"
            value={city}
            onChange={setCity}
            autoComplete="address-level2"
          />

          <Field
            id={passwordId}
            label="Mot de passe du patron"
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete="new-password"
            hint="Au moins 6 caractères. À transmettre au patron."
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
              {submitting ? 'Création…' : 'Créer le commerce'}
            </Button>

            <Link
              to="/admin/tenants"
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
