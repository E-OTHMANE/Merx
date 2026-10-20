/*
 * La liste des documents. M3 — E4-07.
 *
 * « Retrouver un bon, afin de régler un litige. » Un client rappelle, ou un
 * papier traîne : on cherche un numéro, ou un jour, ou « les bons annulés de la
 * semaine ». La forme en découle — la recherche par numéro est en tête, les
 * filtres sont visibles d'emblée et chacun relance la lecture sans bouton
 * « Filtrer » (chaque appui de moins est payé mille fois, SPEC § 10).
 *
 * Écran de **détail** au sens de BRAND-UI § 13 : on y arrive de l'Accueil, il
 * porte un retour et aucune barre d'onglets — la barre est pleine (cinq onglets
 * au plus, et Clients et Rapports ont leur place réservée).
 *
 * **Un document annulé reste dans la liste, marqué** — par le mot « Annulé »
 * dans un cadre, et le montant barré ; pas par la seule teinte (BRAND-UI § 5), et
 * pas en rouge : le rouge ne dit que la dette et l'action destructrice.
 *
 * **Le filtre par client n'existe pas** : `client_id` naît en E6-01.
 *
 * **L'appareil** ne se filtre que pour qui peut lire la liste des appareils
 * (`manage_devices`, le patron) : un employé n'a pas de liste d'où choisir, et la
 * recherche par fragment (« -B- ») retrouve les bons d'un appareil sans elle.
 *
 * BRAND-UI : quatre états (§ 8), lignes de 64 px (§ 8), montants en chiffres
 * tabulaires (§ 6), propriétés logiques (§ 9), cibles de 48 px (§ 7).
 */

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { BackLink } from '@/components/BackLink'
import { useCan } from '@/lib/auth'
import { formatDateTime } from '@/lib/dates'
import { moneyText } from '@/lib/decimal'
import { listDevices, type Device } from '@/modules/admin'
import type { SaleDocType } from '@/modules/sales/documentNumber'
import {
  DOC_TYPE_LABELS,
  LIST_LIMIT,
  STATUS_LABELS,
  listSaleDocuments,
  type DocStatus,
  type DocumentFilter,
  type DocumentPage,
  type SaleDocumentSummary,
} from '@/modules/sales/documents'

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; page: DocumentPage }

/* Laisse finir la frappe avant d'interroger : une tablette bon marché, un réseau de souk. */
const SEARCH_DELAY_MS = 250

const SELECT_CLASS =
  'h-touch rounded-button border border-paper-300 bg-white px-3 text-body text-ink-700'
const DATE_CLASS =
  'tabular h-touch rounded-button border border-paper-300 bg-white px-3 text-body text-ink-700'

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement des documents" className="flex flex-col gap-2">
      {[0, 1, 2].map((n) => (
        <div key={n} className="h-row rounded-card bg-paper-100" />
      ))}
    </div>
  )
}

function DocumentRow({ document }: { document: SaleDocumentSummary }) {
  const cancelled = document.status === 'cancelled'
  const when = formatDateTime(document.sortAt)

  return (
    <li className="border-b border-paper-200">
      <Link
        to={`/documents/${document.id}`}
        className="flex min-h-row items-center justify-between gap-4 py-3"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <p className="tabular truncate text-subtitle text-paper-900">
            {document.docNumber ?? 'Sans numéro'}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-note text-paper-600">
            <span>{DOC_TYPE_LABELS[document.docType]}</span>
            <span
              className={
                cancelled
                  ? 'rounded-field border border-paper-600 px-2 text-paper-900'
                  : 'text-paper-600'
              }
            >
              {STATUS_LABELS[document.status]}
            </span>
            <span className="tabular">{when ?? '—'}</span>
          </p>
        </div>
        <p className={`tabular shrink-0 text-body text-paper-900 ${cancelled ? 'line-through' : ''}`}>
          {moneyText(document.total)}
        </p>
      </Link>
    </li>
  )
}

export function DocumentListScreen() {
  const canSeeDevices = useCan('manage_devices')

  const [state, setState] = useState<State>({ status: 'loading' })
  const [devices, setDevices] = useState<Device[]>([])

  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  const [docType, setDocType] = useState<SaleDocType | ''>('')
  const [status, setStatus] = useState<DocStatus | ''>('')
  const [deviceId, setDeviceId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [typed])

  /* La liste des appareils sert le filtre, rien d'autre : son échec ne l'emporte pas. */
  useEffect(() => {
    if (!canSeeDevices) return
    listDevices()
      .then(setDevices)
      .catch(() => setDevices([]))
  }, [canSeeDevices])

  const filtered = [search, docType, status, deviceId, from, to].some((value) => value !== '')

  const load = useCallback((): (() => void) => {
    let current = true
    const filter: DocumentFilter = { search, docType, status, deviceId, from, to }
    listSaleDocuments(filter)
      .then((page) => {
        if (current) setState({ status: 'loaded', page })
      })
      .catch((error: unknown) => {
        if (current) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Chargement impossible.',
          })
        }
      })
    return () => {
      current = false
    }
  }, [search, docType, status, deviceId, from, to])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    load()
  }, [load])

  useEffect(load, [load])

  return (
    <main className="min-h-dvh px-4 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div>
          <BackLink to="/" label="Accueil" />
          <h1 className="text-title text-paper-900">Documents</h1>
          <p className="mt-2 text-body text-paper-700">
            Devis, commandes, bons de livraison et retours — du plus récent au plus ancien.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-label text-paper-700">Numéro</span>
            <input
              type="search"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className="h-field rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900 focus-visible:border-ink-600"
            />
            <span className="text-note text-paper-600">
              Le numéro entier, ou seulement ses derniers chiffres : 42, BL-A, -26-.
            </span>
          </label>

          <div className="flex gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-note text-paper-600">Type</span>
              <select
                value={docType}
                onChange={(event) => setDocType(event.target.value as SaleDocType | '')}
                className={SELECT_CLASS}
              >
                <option value="">Tous</option>
                {(Object.keys(DOC_TYPE_LABELS) as SaleDocType[]).map((type) => (
                  <option key={type} value={type}>
                    {DOC_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-note text-paper-600">Statut</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as DocStatus | '')}
                className={SELECT_CLASS}
              >
                <option value="">Tous</option>
                {(Object.keys(STATUS_LABELS) as DocStatus[]).map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {canSeeDevices && (
            <label className="flex flex-col gap-1">
              <span className="text-note text-paper-600">Appareil</span>
              <select
                value={deviceId}
                onChange={(event) => setDeviceId(event.target.value)}
                className={SELECT_CLASS}
              >
                <option value="">Tous</option>
                {devices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {`${device.prefix} — ${device.label}`}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="flex gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-note text-paper-600">Du</span>
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className={DATE_CLASS}
              />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-note text-paper-600">Au</span>
              <input
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className={DATE_CLASS}
              />
            </label>
          </div>
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

        {state.status === 'loaded' && state.page.documents.length === 0 && (
          <div className="flex flex-col items-start gap-4 rounded-card border border-paper-200 bg-white p-6">
            <p className="text-body text-paper-700">
              {filtered
                ? 'Aucun document ne correspond à ces filtres. Élargissez la période ou videz la recherche.'
                : 'Aucun document pour l’instant. Un bon enregistré à la caisse apparaît ici.'}
            </p>
            {!filtered && (
              <Link
                to="/sale"
                className="flex h-touch items-center rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
              >
                Faire une vente
              </Link>
            )}
          </div>
        )}

        {state.status === 'loaded' && state.page.documents.length > 0 && (
          <>
            <ul className="flex flex-col">
              {state.page.documents.map((document) => (
                <DocumentRow key={document.id} document={document} />
              ))}
            </ul>
            {state.page.truncated && (
              <p role="status" className="text-body text-paper-700">
                {`Les ${LIST_LIMIT} plus récents sont affichés. Affinez les filtres pour voir les autres.`}
              </p>
            )}
          </>
        )}
      </div>
    </main>
  )
}
