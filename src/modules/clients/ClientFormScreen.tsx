/*
 * Créer et modifier un client. M4 — E6-01.
 *
 * SPEC § 2.6, même principe que la fiche produit (E2-02) : **le seul champ
 * obligatoire est le nom.** Aucun champ ne se marque, le bouton reste
 * simplement inactif sans nom, le nom a le focus en arrivant.
 *
 * `ice` n'a pas de champ : SPEC § 9 M4 le dit masqué et inutilisé en V1.
 * `credit_limit` non plus — E6-03 le pose avec son garde `owner` seul.
 */

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { BackLink } from '@/components/BackLink'
import { Field } from '@/components/Field'
import { Button } from '@/components/ui/button'
import type { ClientListNavigation } from '@/modules/clients/ClientListScreen'
import {
  EMPTY_DRAFT,
  canSave,
  changesBetween,
  createClient,
  deleteClient,
  draftOf,
  getClient,
  updateClient,
  type ClientChanges,
  type ClientDraft,
} from '@/modules/clients/clients'

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'missing' }
  | { status: 'ready'; saved: ClientDraft }

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement du client" className="flex flex-col gap-6">
      {[0, 1, 2].map((n) => (
        <div key={n} className="h-field rounded-field bg-paper-100" />
      ))}
    </div>
  )
}

export function ClientFormScreen() {
  const { id } = useParams<{ id: string }>()
  return <ClientForm key={id ?? 'new'} clientId={id ?? null} />
}

function ClientForm({ clientId }: { clientId: string | null }) {
  const navigate = useNavigate()
  const creating = clientId === null

  const nameId = useId()
  const phoneId = useId()
  const cityId = useId()
  const addressId = useId()
  const notesId = useId()

  const [loaded, setLoaded] = useState<Loaded>(
    creating ? { status: 'ready', saved: EMPTY_DRAFT } : { status: 'loading' },
  )
  const [draft, setDraft] = useState<ClientDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const load = useCallback(() => {
    if (clientId === null) return
    getClient(clientId)
      .then((client) => {
        if (client === null) {
          setLoaded({ status: 'missing' })
          return
        }
        const saved = draftOf(client)
        setDraft(saved)
        setLoaded({ status: 'ready', saved })
      })
      .catch((error: unknown) =>
        setLoaded({
          status: 'error',
          message: error instanceof Error ? error.message : 'Chargement impossible.',
        }),
      )
  }, [clientId])

  const retry = useCallback(() => {
    setLoaded({ status: 'loading' })
    load()
  }, [load])

  useEffect(load, [load])

  const edit =
    (field: keyof ClientDraft) =>
    (value: string): void => {
      setMessage(null)
      setDraft((current) => ({ ...current, [field]: value }))
    }

  const create = async (): Promise<void> => {
    const created = await createClient(draft)
    setDraft(EMPTY_DRAFT)
    setMessage(`« ${created.name} » enregistré.`)
    document.getElementById(nameId)?.focus()
  }

  const save = async (id: string, saved: ClientDraft): Promise<void> => {
    const changes: ClientChanges = changesBetween(saved, draft)
    if (Object.keys(changes).length > 0) await updateClient(id, changes)
    const state: ClientListNavigation = { saved: draft.name.trim() }
    navigate('/clients', { replace: true, state })
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (loaded.status !== 'ready' || saving || !canSave(draft)) return

    setSaving(true)
    setFailure(null)
    setMessage(null)
    try {
      if (clientId === null) await create()
      else await save(clientId, loaded.saved)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Enregistrement impossible.')
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async (): Promise<void> => {
    if (clientId === null || loaded.status !== 'ready' || saving) return

    setSaving(true)
    setFailure(null)
    try {
      await deleteClient(clientId)
      const state: ClientListNavigation = { deleted: { id: clientId, name: loaded.saved.name } }
      navigate('/clients', { replace: true, state })
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Suppression impossible.')
      setSaving(false)
    }
  }

  return (
    <main className="min-h-dvh px-4 pt-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 pb-6">
        <div>
          <BackLink to="/clients" label="Clients" />
          <h1 className="text-title text-paper-900">{creating ? 'Nouveau client' : 'Fiche client'}</h1>
          {creating && (
            <p className="mt-2 text-body text-paper-700">
              Le nom suffit. Le reste se complète quand vous voulez.
            </p>
          )}
        </div>

        {loaded.status === 'loading' && <Skeleton />}

        {loaded.status === 'error' && (
          <div className="flex flex-col items-start gap-4 rounded-card border border-red-500 bg-red-100 p-4">
            <p role="alert" className="text-body text-red-700">
              {loaded.message}
            </p>
            <button
              type="button"
              onClick={retry}
              className="h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
            >
              Réessayer
            </button>
          </div>
        )}

        {loaded.status === 'missing' && (
          <div className="flex flex-col gap-4 rounded-card border border-paper-200 bg-white p-6">
            <p className="text-body text-paper-700">Ce client n’existe plus. Il a peut-être été supprimé.</p>
            <Link
              to="/clients"
              className="flex h-button w-full items-center justify-center rounded-button border border-paper-300 bg-white text-body text-ink-700"
            >
              Retour aux clients
            </Link>
          </div>
        )}

        {loaded.status === 'ready' && (
          <>
            <form className="flex flex-col gap-6" onSubmit={onSubmit} noValidate>
              <Field id={nameId} label="Nom du client" value={draft.name} onChange={edit('name')} autoFocus={creating} />
              <Field id={phoneId} label="Téléphone" value={draft.phone} onChange={edit('phone')} inputMode="tel" className="tabular" />
              <Field id={cityId} label="Ville" value={draft.city} onChange={edit('city')} />
              <Field id={addressId} label="Adresse" value={draft.address} onChange={edit('address')} />
              <Field id={notesId} label="Notes" value={draft.notes} onChange={edit('notes')} />

              {failure !== null && (
                <p role="alert" className="text-body text-red-600">
                  {failure}
                </p>
              )}
              {message !== null && (
                <p role="status" className="text-body text-paper-700">
                  {message}
                </p>
              )}

              <div className="sticky bottom-0 -mx-4 border-t border-paper-200 bg-paper-50 px-4 py-4">
                <Button
                  type="submit"
                  disabled={saving || !canSave(draft)}
                  className="h-button w-full rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800 disabled:bg-paper-200 disabled:text-paper-700 disabled:opacity-100"
                >
                  {saving ? 'Enregistrement…' : 'Enregistrer le client'}
                </Button>
              </div>
            </form>

            {!creating && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void onDelete()}
                className="h-button w-full rounded-button border border-red-500 bg-white text-body text-red-600"
              >
                Supprimer le client
              </button>
            )}
          </>
        )}
      </div>
    </main>
  )
}
