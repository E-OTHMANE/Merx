/*
 * Les appareils du commerce. M8 — E1-03.
 *
 * L'écran répond à une question précise, et c'est elle qui décide de sa forme :
 * « ce bon porte BL-C-0001 — quelle tablette l'a fait, et quand a-t-elle parlé
 * au serveur pour la dernière fois ? » La lettre est donc le sujet, pas une
 * mention en bas de ligne.
 *
 * BRAND-UI § 8 : quatre états, pas un de moins — chargement, vide, erreur,
 * contenu. Le chargement montre la forme de ce qui arrive.
 * BRAND-UI § 6 : la lettre et l'horodatage sont des données, donc en chiffres
 * tabulaires.
 * BRAND-UI § 9 : propriétés logiques uniquement. Rien à reprendre en RTL (E11).
 *
 * Aucune action. E1-03 demande que le patron voie ses appareils, rien de plus :
 * renommer et retirer ne sont demandés par aucun critère, et un appareil retiré
 * ne rend pas sa lettre (migration E1-03) — c'est une décision qui mérite son
 * écran, le jour où une story la demandera.
 */

import { useCallback, useEffect, useState } from 'react'

import { formatDateTime } from '@/lib/dates'
import { listDevices, type Device } from '@/modules/admin/devices'

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; devices: Device[] }

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement des appareils" className="flex flex-col gap-2">
      {[0, 1, 2].map((n) => (
        <div key={n} className="h-row rounded-card bg-paper-100" />
      ))}
    </div>
  )
}

function DeviceRow({ device }: { device: Device }) {
  const seen = formatDateTime(device.lastSyncAt)

  return (
    <li className="flex min-h-row items-center gap-4 border-b border-paper-200 py-3">
      {/*
       * La lettre, en gros et en tabulaire : c'est par elle qu'on identifie
       * l'appareil sur un bon (`BL-C-0001`). BRAND-UI § 6, chiffre secondaire —
       * c'est bien un chiffre au sens du spec : une donnée qu'on lit dans une
       * colonne, pas un mot.
       */}
      <span
        aria-label={`Préfixe ${device.prefix}`}
        className="tabular flex h-touch w-touch shrink-0 items-center justify-center rounded-card border border-paper-200 text-amount-sm text-paper-900"
      >
        {device.prefix}
      </span>

      <div className="min-w-0">
        <p className="text-subtitle text-paper-900">{device.label}</p>
        <p className="text-note text-paper-600">
          Numérote en {device.prefix}
          {device.isActive ? '' : ' · Retiré'}
        </p>
        <p className="tabular text-note text-paper-600">
          {seen === null ? 'Jamais synchronisé' : `Synchronisé le ${seen}`}
        </p>
      </div>
    </li>
  )
}

export function DeviceListScreen() {
  const [state, setState] = useState<State>({ status: 'loading' })

  /*
   * `load` ne pose pas `loading` : l'état initial l'est déjà, et le faire ici
   * serait un `setState` synchrone dans l'effet. C'est `retry` qui remet
   * l'écran en chargement, puisque lui part d'un état d'erreur.
   */
  const load = useCallback(() => {
    listDevices()
      .then((devices) => setState({ status: 'loaded', devices }))
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

  return (
    <main className="min-h-dvh px-4 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div>
          <h1 className="text-title text-paper-900">Appareils</h1>
          <p className="mt-2 text-body text-paper-700">
            Chaque appareil numérote ses bons avec sa propre lettre : BL-A-0001, BL-B-0001.
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

        {/*
         * L'écran vide n'arrive en principe jamais — la création du commerce
         * pose l'appareil « A » (E1-01). Il existe pour le cas où le patron
         * consulte depuis un appareil qui ne s'est pas encore annoncé, faute de
         * réseau. BRAND-UI § 6 : il dit quoi faire.
         */}
        {state.status === 'loaded' && state.devices.length === 0 && (
          <div className="rounded-card border border-paper-200 bg-white p-6">
            <p className="text-body text-paper-700">
              Aucun appareil enregistré. Un appareil s’enregistre tout seul à sa première
              connexion.
            </p>
          </div>
        )}

        {state.status === 'loaded' && state.devices.length > 0 && (
          <ul className="flex flex-col">
            {state.devices.map((device) => (
              <DeviceRow key={device.id} device={device} />
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
