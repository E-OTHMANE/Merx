/*
 * Les réglages du commerce. M8 — E1-05.
 *
 * L'écran est écrit en sachant qu'il ne sera peut-être jamais ouvert, et c'est
 * la contrainte qui le dessine : rien ici n'est un préalable à vendre. Un
 * commerce est créé avec des valeurs utilisables (`merx.seed_tenant_settings()`),
 * donc les champs arrivent **remplis**, et cet écran sert à corriger, pas à
 * renseigner. Aucun champ n'est obligatoire, aucun n'est marqué, aucun ne
 * réclame (SPEC § 2.6, E11-03).
 *
 * BRAND-UI § 8 : quatre états — chargement, vide, erreur, contenu. Le « vide »
 * n'existe pas ici : les lignes existent toujours ; s'il manquait quelque
 * chose, l'enregistrement le dirait plutôt que l'écran ne l'invente.
 * BRAND-UI § 6 : le bouton dit ce qu'il fait, et le message reprend son mot.
 * BRAND-UI § 7 : l'action principale est en bas, atteignable au pouce.
 * BRAND-UI § 9 : propriétés logiques uniquement. Rien à reprendre en RTL (E11).
 *
 * Ce que l'écran ne fait pas : basculer la langue de l'interface (E11-01) ni
 * parler à l'imprimante (E5-01). Il enregistre les réglages dont ces deux
 * étapes se serviront.
 */

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'

import { BackLink } from '@/components/BackLink'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/Field'
import { loadSettings, saveSettings, type Settings } from '@/modules/admin/settings'
import {
  LANGUAGES,
  PRINTER_WIDTHS,
  type Language,
  type PrinterWidth,
} from '@/modules/admin/settingKeys'

const LANGUAGE_LABELS: Record<Language, string> = {
  fr: 'Français',
  ar: 'العربية',
}

/*
 * La largeur se dit en millimètres de papier, parce que c'est ce que le
 * commerçant voit, et en points parce que c'est ce qui distingue deux 80 mm
 * (E5-01, docs/research/E5-02-arabe-thermique.md § 3).
 */
const PRINTER_WIDTH_LABELS: Record<PrinterWidth, string> = {
  576: '80 mm — 576 points',
  512: '80 mm — 512 points',
  384: '58 mm — 384 points',
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; saved: Settings; draft: Settings }

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement des réglages" className="flex flex-col gap-6">
      {[0, 1, 2, 3].map((n) => (
        <div key={n} className="h-field rounded-field bg-paper-100" />
      ))}
    </div>
  )
}

export function SettingsScreen() {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const nameId = useId()
  const phoneId = useId()
  const addressId = useId()
  const printerId = useId()

  const load = useCallback(() => {
    loadSettings()
      .then((settings) => setState({ status: 'loaded', saved: settings, draft: settings }))
      .catch((error: unknown) =>
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Chargement impossible.',
        }),
      )
  }, [])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    load()
  }, [load])

  useEffect(load, [load])

  const edit = (change: (draft: Settings) => Settings): void => {
    setMessage(null)
    setState((current) =>
      current.status === 'loaded' ? { ...current, draft: change(current.draft) } : current,
    )
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (state.status !== 'loaded' || saving) return

    setMessage(null)
    setFailure(null)
    setSaving(true)
    try {
      await saveSettings(state.saved, state.draft)
      // Le brouillon devient l'état enregistré : un second envoi ne réécrit
      // rien, et le diff repart d'une base juste.
      setState({ status: 'loaded', saved: state.draft, draft: state.draft })
      setMessage('Réglages enregistrés.')
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Enregistrement impossible.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="min-h-dvh px-4 py-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div>
          <BackLink to="/" label="Accueil" />
          <h1 className="text-title text-paper-900">Paramètres</h1>
          <p className="mt-2 text-body text-paper-700">
            Déjà réglés à l’ouverture du commerce. À corriger quand quelque chose a changé.
          </p>
        </div>

        {state.status === 'loading' && <Skeleton />}

        {state.status === 'error' && (
          <div className="flex flex-col items-start gap-4 rounded-card border border-red-500 bg-red-100 p-4">
            <p role="alert" className="text-body text-red-700">
              {state.message}
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

        {state.status === 'loaded' && (
          <form className="flex flex-col gap-6" onSubmit={onSubmit} noValidate>
            <fieldset className="flex flex-col gap-6">
              <legend className="text-label text-paper-600">Ce qui s’imprime sur le bon</legend>

              <Field
                id={nameId}
                label="Nom du commerce"
                value={state.draft.printHeader.businessName}
                onChange={(businessName) =>
                  edit((draft) => ({
                    ...draft,
                    printHeader: { ...draft.printHeader, businessName },
                  }))
                }
                autoComplete="organization"
              />

              <Field
                id={phoneId}
                label="Téléphone"
                value={state.draft.printHeader.phone}
                onChange={(phone) =>
                  edit((draft) => ({ ...draft, printHeader: { ...draft.printHeader, phone } }))
                }
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                className="tabular"
              />

              <Field
                id={addressId}
                label="Adresse"
                value={state.draft.printHeader.address}
                onChange={(address) =>
                  edit((draft) => ({ ...draft, printHeader: { ...draft.printHeader, address } }))
                }
                autoComplete="street-address"
              />
            </fieldset>

            {/*
             * La langue du commerce. Deux choix, donc deux boutons radio et
             * non une liste déroulante : on voit les deux d'un coup et on
             * touche une cible pleine hauteur (BRAND-UI § 7).
             */}
            <fieldset className="flex flex-col gap-2">
              <legend className="text-label text-paper-700">Langue</legend>
              <div className="flex gap-2">
                {LANGUAGES.map((language) => (
                  <label
                    key={language}
                    className={`flex h-touch flex-1 items-center justify-center gap-2 rounded-button border text-body has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ink-600 ${
                      state.draft.language === language
                        ? 'border-ink-600 bg-ink-100 text-ink-700'
                        : 'border-paper-300 bg-white text-paper-700'
                    }`}
                  >
                    <input
                      type="radio"
                      name="language"
                      value={language}
                      checked={state.draft.language === language}
                      onChange={() => edit((draft) => ({ ...draft, language }))}
                      className="sr-only"
                    />
                    {LANGUAGE_LABELS[language]}
                  </label>
                ))}
              </div>
            </fieldset>

            <Field
              id={printerId}
              label="Imprimante réseau"
              value={state.draft.printerAddress}
              onChange={(printerAddress) => edit((draft) => ({ ...draft, printerAddress }))}
              className="tabular"
              hint="Adresse de l’imprimante sur le Wi-Fi du magasin. Exemple : 192.168.1.50:9100. Laissée vide, l’impression thermique ne s’offre pas."
            />

            {/*
             * La largeur de la tête d'impression. Trois valeurs de matériel, pas
             * un nombre à saisir : un ticket rendu en image à la mauvaise
             * largeur sort décalé ou coupé, et aucune autre valeur n'existe
             * (BRAND-UI § 7 — une cible pleine hauteur plutôt qu'un clavier).
             *
             * Réglée à 576 à l'ouverture du commerce : le patron n'a rien à
             * faire ici tant que son ticket sort juste (SPEC § 2.6).
             */}
            <fieldset className="flex flex-col gap-2">
              <legend className="text-label text-paper-700">Largeur du ticket</legend>
              <div className="flex flex-col gap-2">
                {PRINTER_WIDTHS.map((width) => (
                  <label
                    key={width}
                    className={`flex h-touch items-center justify-center gap-2 rounded-button border text-body has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ink-600 ${
                      state.draft.printerWidth === width
                        ? 'border-ink-600 bg-ink-100 text-ink-700'
                        : 'border-paper-300 bg-white text-paper-700'
                    }`}
                  >
                    <input
                      type="radio"
                      name="printerWidth"
                      value={width}
                      checked={state.draft.printerWidth === width}
                      onChange={() => edit((draft) => ({ ...draft, printerWidth: width }))}
                      className="sr-only"
                    />
                    {PRINTER_WIDTH_LABELS[width]}
                  </label>
                ))}
              </div>
              <p className="text-note text-paper-600">
                Presque toutes les 80 mm sont à 576 points. Si le ticket sort décalé ou coupé sur
                un bord, essayez 512.
              </p>
            </fieldset>

            {failure !== null && (
              <p role="alert" className="text-body text-red-600">
                {failure}
              </p>
            )}

            {/* BRAND-UI § 6 : « Enregistrer » produit « Enregistrés ». */}
            {message !== null && (
              <p role="status" className="text-body text-paper-700">
                {message}
              </p>
            )}

            <Button
              type="submit"
              disabled={saving}
              className="h-button w-full rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
            >
              {saving ? 'Enregistrement…' : 'Enregistrer les réglages'}
            </Button>
          </form>
        )}
      </div>
    </main>
  )
}
