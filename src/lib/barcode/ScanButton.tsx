/*
 * Le bouton « Scanner » et sa vue caméra. E2-06.
 *
 * **SPEC § 2.6 dessine ce composant.** Il ne rend rien du tout quand la caméra
 * n'est pas une voie possible : pas de bouton grisé, pas d'explication, pas de
 * « activez la caméra ». Un vendeur à qui l'outil réclame quelque chose retourne
 * au carnet.
 *
 *   — API absente, origine en clair, aucune caméra : rien ne s'affiche ;
 *   — accès refusé au moment de l'appui : la vue se ferme et le bouton disparaît
 *     pour la session. Rien ne redemande, rien ne s'excuse ;
 *   — `getUserMedia` n'est appelé que sur appui : aucune invite système ne
 *     surgit à l'ouverture d'un écran.
 *
 * BRAND-UI : cible de 48 px (§ 7), icône **et** texte (§ 11), propriétés
 * logiques (§ 9), aucune animation (§ 10).
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { cameraScanningAvailable, startScanning, type ScanSession } from '@/lib/barcode/scanner'

/** Entre deux lectures. Assez court pour être immédiat, assez long pour un téléphone lent. */
const INTERVAL_MS = 250

interface ScanButtonProps {
  /** Appelé avec le code lu. La vue se ferme juste avant. */
  onScan: (code: string) => void
  /** Le texte du bouton — « Scanner », « Scanner le code-barres ». */
  label?: string
}

export function ScanButton({ onScan, label = 'Scanner' }: ScanButtonProps) {
  // Décidé une fois : la réponse ne change pas en cours de session, sauf quand
  // un refus la fait passer à faux, et alors elle n'y revient pas.
  const [available, setAvailable] = useState(cameraScanningAvailable)
  const [session, setSession] = useState<ScanSession | null>(null)
  const video = useRef<HTMLVideoElement>(null)

  const close = useCallback(() => {
    setSession((current) => {
      if (current?.status === 'scanning') current.stop()
      return null
    })
  }, [])

  const open = useCallback(async () => {
    const opened = await startScanning()
    if (opened.status === 'unavailable') {
      // Refus, caméra occupée, matériel absent : la même chose des trois, et
      // pas un mot de plus (§ 2.6).
      setAvailable(false)
      return
    }
    setSession(opened)
  }, [])

  // La caméra s'éteint quand l'écran est quitté — sinon la diode reste allumée.
  useEffect(() => close, [close])

  useEffect(() => {
    if (session?.status !== 'scanning') return

    const element = video.current
    if (element === null) return

    element.srcObject = session.stream
    void element.play?.()

    let stopped = false
    const timer = window.setInterval(() => {
      void session.read(element).then((code) => {
        if (stopped || code === null) return
        stopped = true
        close()
        onScan(code)
      })
    }, INTERVAL_MS)

    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [session, close, onScan])

  if (!available) return null

  return (
    <>
      <button
        type="button"
        onClick={() => void open()}
        className="h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
      >
        {label}
      </button>

      {session?.status === 'scanning' && (
        <div
          role="dialog"
          aria-label="Scanner un code-barres"
          className="fixed inset-0 z-50 flex flex-col bg-black"
        >
          <video
            ref={video}
            playsInline
            muted
            aria-label="Vue de la caméra"
            className="min-h-0 flex-1 object-cover"
          />
          <div className="p-4">
            <button
              type="button"
              onClick={close}
              className="h-button w-full rounded-button border border-paper-300 bg-white text-body text-ink-700"
            >
              Annuler
            </button>
          </div>
        </div>
      )}
    </>
  )
}
