/*
 * Le détail d'un document. M3 — E4-07.
 *
 * Lignes, totaux, auteur, appareil, horodatage — et la filiation : le document
 * d'origine et tout ce qui en est issu, avec un lien vers chacun. **Un parent a
 * plusieurs enfants** (RÈGLE M3-4) : « Documents issus » est une liste, pas un
 * champ.
 *
 * Écran de détail (BRAND-UI § 13) : retour vers Documents, aucune barre. Les
 * actions sont dans le tiers bas (§ 7), dans l'ordre où on les cherche :
 *
 *   — « Imprimer le ticket » (E5-01), la réimpression : en tête, parce que
 *     c'est l'action pour laquelle on rouvre un document au comptoir. Elle
 *     n'apparaît que s'il y a une imprimante joignable — hors de l'enveloppe
 *     Android il n'y a pas de socket, et un commerce sans imprimante n'a pas
 *     d'adresse (SPEC § 2.6 et § 2.7). Elle n'apparaît pas non plus sur un
 *     brouillon (pas de numéro) ni sur un document annulé : un ticket d'allure
 *     valable pour une vente annulée est une preuve fausse ;
 *
 *   — « Envoyer en PDF » (E5-03), juste après : c'est le repli quand
 *     l'imprimante est absente ou en panne, et la seule voie au navigateur
 *     (SPEC § 2.7). Elle ne dépend d'aucun réglage, donc elle est là partout —
 *     seule la voie de partage change, sélecteur natif ou téléchargement. Même
 *     porte que le ticket pour ce qui s'exporte : un numéro, et pas annulé ;
 *
 *   — « Transformer » → `/sale/from/:documentId` (E4-05), seulement quand la
 *     chaîne le permet ;
 *   — « Retour » → `/sale/return/:documentId` (E4-06), seulement sur un bon de
 *     livraison vivant ;
 *   — l'annulation, réservée au patron : `useCan('cancel_document')` la masque,
 *     la base la refuse (`merx.require_cancel_capability()`). Masquer n'est pas
 *     interdire. Le motif est obligatoire des deux côtés, avec deux phrases :
 *     celle de l'écran avant l'envoi, celle de la base — affichée telle quelle —
 *     quand c'est elle qui refuse.
 *
 * **Un document annulé reste visible, et clairement marqué** : le mot, son
 * motif, le montant barré.
 *
 * Quatre états : chargement, introuvable (le vide de cet écran — un document
 * absent et un document interdit se répondent de la même façon), erreur,
 * contenu.
 */

import { useCallback, useEffect, useId, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { BackLink } from '@/components/BackLink'
import { Button } from '@/components/ui/button'
import { useCan } from '@/lib/auth'
import { formatDateTime } from '@/lib/dates'
import { moneyText, quantityText } from '@/lib/decimal'
import {
  DOCUMENT_MESSAGES,
  DOC_TYPE_LABELS,
  STATUS_LABELS,
  canCancel,
  canReturn,
  canTransform,
  cancelDocument,
  loadDocument,
  type DocStatus,
  type DocumentDetail,
} from '@/modules/sales/documents'
import { documentLineage, type DocumentLineage, type LinkedDocument } from '@/modules/sales/lineage'
import {
  PDF_MESSAGES,
  canExportPdf,
  exportDocumentPdf,
} from '@/modules/sales/pdf'
import {
  TICKET_MESSAGES,
  canPrint,
  documentTicket,
  loadTicketPrinter,
  printTicketOn,
  type TicketPrinter,
} from '@/modules/sales/printing'

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'missing' }
  | { status: 'loaded'; detail: DocumentDetail; lineage: DocumentLineage }

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement du document" className="flex flex-col gap-2">
      {[0, 1, 2].map((n) => (
        <div key={n} className="h-row rounded-card bg-paper-100" />
      ))}
    </div>
  )
}

function Linked({ document }: { document: LinkedDocument }) {
  return (
    <li className="border-b border-paper-200 last:border-b-0">
      <Link
        to={`/documents/${document.id}`}
        className="flex min-h-touch items-center justify-between gap-4 px-4 py-2 text-body text-paper-900"
      >
        <span className="tabular">{document.docNumber ?? 'Sans numéro'}</span>
        <span className="text-note text-paper-600">
          {DOC_TYPE_LABELS[document.docType]} · {STATUS_LABELS[document.status as DocStatus] ?? document.status}
        </span>
      </Link>
    </li>
  )
}

export function DocumentDetailScreen() {
  const { documentId } = useParams<{ documentId: string }>()
  const canCancelRight = useCan('cancel_document')
  const reasonId = useId()

  const [state, setState] = useState<State>({ status: 'loading' })
  const [cancelling, setCancelling] = useState(false)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [printer, setPrinter] = useState<TicketPrinter | null>(null)
  const [printing, setPrinting] = useState(false)
  const [exporting, setExporting] = useState(false)
  /* Une seule zone d'état : imprimer puis partager ne cumule pas deux phrases. */
  const [notice, setNotice] = useState<string | null>(null)

  /*
   * L'imprimante est cherchée une fois, en arrière-plan. Un échec de lecture
   * des réglages ne dit rien à l'écran : il n'y a alors pas d'imprimante, donc
   * pas de bouton — c'est le même rendu qu'un commerce qui n'en a pas.
   */
  useEffect(() => {
    let current = true
    loadTicketPrinter()
      .then((found) => {
        if (current) setPrinter(found)
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [])

  const load = useCallback((): (() => void) => {
    let current = true
    // Une route sans identifiant n'existe pas ; si elle arrivait, ce serait un
    // document introuvable, dit de la même façon.
    const reading: Promise<{ detail: DocumentDetail; lineage: DocumentLineage } | null> =
      documentId === undefined
        ? Promise.resolve(null)
        : Promise.all([loadDocument(documentId), documentLineage(documentId)]).then(
            ([detail, lineage]) => (detail === null ? null : { detail, lineage }),
          )

    reading
      .then((result) => {
        if (!current) return
        setState(result === null ? { status: 'missing' } : { status: 'loaded', ...result })
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
  }, [documentId])

  useEffect(load, [load])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    load()
  }, [load])

  const confirmCancellation = async (): Promise<void> => {
    if (saving || documentId === undefined) return
    setFailure(null)

    // Le garde de l'écran : sa phrase n'est pas celle de la base.
    if (reason.trim() === '') {
      setFailure(DOCUMENT_MESSAGES.reasonRequired)
      return
    }

    setSaving(true)
    try {
      await cancelDocument(documentId, reason)
      setCancelling(false)
      setReason('')
      setState({ status: 'loading' })
      load()
    } catch (error: unknown) {
      // La phrase de la base, telle quelle : c'est elle qui dit pourquoi.
      setFailure(error instanceof Error ? error.message : DOCUMENT_MESSAGES.cancelNotSaved)
    } finally {
      setSaving(false)
    }
  }

  const print = async (detail: DocumentDetail): Promise<void> => {
    if (printing || printer === null) return
    setFailure(null)
    setNotice(null)
    setPrinting(true)
    try {
      await printTicketOn(documentTicket(detail, printer), printer)
      setNotice(TICKET_MESSAGES.printed)
    } catch {
      /*
       * La phrase est celle de la story : l'échec d'impression ne défait rien,
       * le document est là, le bouton aussi. Le message de la cause — socket
       * refusé, imprimante muette — n'apprendrait rien au vendeur.
       */
      setFailure(TICKET_MESSAGES.failed)
    } finally {
      setPrinting(false)
    }
  }

  /*
   * Le PDF. Il n'y a pas d'imprimante à trouver et rien à désactiver : la
   * RÈGLE de SPEC § 2.7 veut le PDF présent partout, et c'est la voie de
   * partage qui change — sélecteur natif dans l'enveloppe, téléchargement au
   * navigateur. L'écran dit seulement laquelle a servi.
   */
  const sendPdf = async (detail: DocumentDetail): Promise<void> => {
    if (exporting) return
    setFailure(null)
    setNotice(null)
    setExporting(true)
    try {
      const outcome = await exportDocumentPdf(detail)
      if (outcome === 'shared') setNotice(PDF_MESSAGES.shared)
      if (outcome === 'downloaded') setNotice(PDF_MESSAGES.downloaded)
      /* `cancelled` : refermer le sélecteur n'est pas un échec, et ne dit rien. */
    } catch {
      setFailure(PDF_MESSAGES.failed)
    } finally {
      setExporting(false)
    }
  }

  return (
    <main className="min-h-dvh px-4 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <BackLink to="/documents" label="Documents" />

        {state.status === 'loading' && (
          <>
            <h1 className="text-title text-paper-900">Document</h1>
            <Skeleton />
          </>
        )}

        {state.status === 'error' && (
          <>
            <h1 className="text-title text-paper-900">Document</h1>
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
          </>
        )}

        {state.status === 'missing' && (
          <>
            <h1 className="text-title text-paper-900">Document introuvable</h1>
            <div className="flex flex-col items-start gap-4 rounded-card border border-paper-200 bg-white p-6">
              <p className="text-body text-paper-700">{DOCUMENT_MESSAGES.notFound}</p>
              <Link
                to="/documents"
                className="flex h-touch items-center rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
              >
                Retour aux documents
              </Link>
            </div>
          </>
        )}

        {state.status === 'loaded' && (
          <Content
            detail={state.detail}
            lineage={state.lineage}
            canCancelRight={canCancelRight}
            cancelling={cancelling}
            onCancelling={setCancelling}
            reason={reason}
            onReason={setReason}
            reasonId={reasonId}
            saving={saving}
            failure={failure}
            onConfirm={() => void confirmCancellation()}
            printer={printer}
            printing={printing}
            notice={notice}
            onPrint={() => void print(state.detail)}
            exporting={exporting}
            onSendPdf={() => void sendPdf(state.detail)}
          />
        )}
      </div>
    </main>
  )
}

interface ContentProps {
  detail: DocumentDetail
  lineage: DocumentLineage
  canCancelRight: boolean
  cancelling: boolean
  onCancelling: (value: boolean) => void
  reason: string
  onReason: (value: string) => void
  reasonId: string
  saving: boolean
  failure: string | null
  onConfirm: () => void
  printer: TicketPrinter | null
  printing: boolean
  notice: string | null
  onPrint: () => void
  exporting: boolean
  onSendPdf: () => void
}

function Content({
  detail,
  lineage,
  canCancelRight,
  cancelling,
  onCancelling,
  reason,
  onReason,
  reasonId,
  saving,
  failure,
  onConfirm,
  printer,
  printing,
  notice,
  onPrint,
  exporting,
  onSendPdf,
}: ContentProps) {
  const { document, lines } = detail
  const cancelled = document.status === 'cancelled'
  const emitted = formatDateTime(document.issuedAt)
  const created = formatDateTime(document.createdAt)
  const transform = canTransform(document)
  const giveBack = canReturn(document)
  const mayCancel = canCancelRight && canCancel(document)
  const mayPrint = printer !== null && canPrint(document)
  const mayExport = canExportPdf(document)

  return (
    <>
      <div>
        <h1 className="tabular text-title text-paper-900">{document.docNumber ?? 'Sans numéro'}</h1>
        <p className="mt-1 text-body text-paper-700">
          {DOC_TYPE_LABELS[document.docType]} ·{' '}
          <span
            className={
              cancelled ? 'rounded-field border border-paper-600 px-2 text-paper-900' : ''
            }
          >
            {STATUS_LABELS[document.status]}
          </span>
        </p>
      </div>

      {cancelled && (
        <div className="rounded-card border border-paper-600 bg-paper-100 p-4">
          <p className="text-subtitle text-paper-900">Document annulé</p>
          <p className="mt-1 text-body text-paper-700">
            Motif : {document.cancellationReason ?? '—'}
          </p>
        </div>
      )}

      <dl className="flex flex-col gap-3">
        <div>
          <dt className="text-label text-paper-600">{emitted === null ? 'Créé le' : 'Émis le'}</dt>
          <dd className="tabular text-body text-paper-900">{emitted ?? created ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-label text-paper-600">Auteur</dt>
          <dd className="text-body text-paper-900">{document.authorName ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-label text-paper-600">Appareil</dt>
          <dd className="text-body text-paper-900">
            {document.deviceLabel === null
              ? '—'
              : `${document.devicePrefix ?? ''} — ${document.deviceLabel}`}
          </dd>
        </div>
        {document.notes !== null && document.notes !== '' && (
          <div>
            <dt className="text-label text-paper-600">
              {document.docType === 'return' ? 'Motif du retour' : 'Notes'}
            </dt>
            <dd dir="auto" className="text-body text-paper-900">
              {document.notes}
            </dd>
          </div>
        )}
      </dl>

      <section aria-label="Lignes du document" className="flex flex-col gap-2">
        <h2 className="text-subtitle text-paper-900">Lignes</h2>
        {lines.length === 0 ? (
          <p className="text-body text-paper-700">Ce document n’a aucune ligne.</p>
        ) : (
          <ul className="flex flex-col">
            {lines.map((line) => (
              <li
                key={line.id}
                className="flex min-h-row items-center justify-between gap-4 border-b border-paper-200 py-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="truncate text-subtitle text-paper-900">{line.name}</p>
                  <p className="tabular text-note text-paper-600">
                    {quantityText(line.quantity)} × {moneyText(line.unitPrice)}
                  </p>
                </div>
                <p className={`tabular shrink-0 text-body text-paper-900 ${cancelled ? 'line-through' : ''}`}>
                  {moneyText(line.lineTotal)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Totaux" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-label text-paper-700">Sous-total</span>
          <span className="tabular text-body text-paper-900">{moneyText(document.subtotal)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-label text-paper-700">Remise</span>
          <span className="tabular text-body text-paper-900">{moneyText(document.discountTotal)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-label text-paper-700">Total</span>
          <output
            aria-label="Total"
            className={`tabular text-amount text-paper-900 ${cancelled ? 'line-through' : ''}`}
          >
            {moneyText(document.total)}
          </output>
        </div>
      </section>

      {(lineage.source !== null || lineage.children.length > 0) && (
        <section aria-label="Filiation" className="flex flex-col gap-4">
          {lineage.source !== null && (
            <div className="flex flex-col gap-2">
              <h2 className="text-subtitle text-paper-900">Issu de</h2>
              <ul className="rounded-card border border-paper-200 bg-white">
                <Linked document={lineage.source} />
              </ul>
            </div>
          )}
          {lineage.children.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-subtitle text-paper-900">Documents issus</h2>
              <ul className="rounded-card border border-paper-200 bg-white">
                {lineage.children.map((child) => (
                  <Linked key={child.id} document={child} />
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {failure !== null && (
        <p role="alert" className="text-body text-red-600">
          {failure}
        </p>
      )}

      {notice !== null && (
        <p role="status" className="text-body text-paper-700">
          {notice}
        </p>
      )}

      {(mayPrint || mayExport || transform || giveBack || mayCancel) && (
        <div className="flex flex-col gap-2">
          {mayPrint && (
            <Button
              type="button"
              disabled={printing}
              onClick={onPrint}
              className="h-button w-full rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
            >
              {printing ? TICKET_MESSAGES.printing : 'Imprimer le ticket'}
            </Button>
          )}
          {mayExport && (
            <Button
              type="button"
              variant="outline"
              disabled={exporting}
              onClick={onSendPdf}
              className="h-button w-full rounded-button border border-paper-300 bg-white text-body text-ink-700"
            >
              {exporting ? PDF_MESSAGES.working : 'Envoyer en PDF'}
            </Button>
          )}
          {transform && (
            <Link
              to={`/sale/from/${document.id}`}
              className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white"
            >
              Transformer
            </Link>
          )}
          {giveBack && (
            <Link
              to={`/sale/return/${document.id}`}
              className="flex h-button items-center justify-center rounded-button border border-paper-300 bg-white text-body text-ink-700"
            >
              Retour
            </Link>
          )}

          {mayCancel && !cancelling && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onCancelling(true)}
              className="h-button w-full rounded-button border border-red-500 bg-white text-body text-red-600"
            >
              Annuler ce document
            </Button>
          )}

          {mayCancel && cancelling && (
            <div className="flex flex-col gap-2">
              <label htmlFor={reasonId} className="text-label text-paper-700">
                Motif de l’annulation
              </label>
              <input
                id={reasonId}
                type="text"
                dir="auto"
                autoComplete="off"
                value={reason}
                onChange={(event) => onReason(event.target.value)}
                className="h-field rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900 focus-visible:border-ink-600"
              />
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={onConfirm}
                className="h-button w-full rounded-button border border-red-500 bg-white text-body text-red-600"
              >
                {saving ? 'Annulation…' : 'Confirmer l’annulation'}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  )
}
