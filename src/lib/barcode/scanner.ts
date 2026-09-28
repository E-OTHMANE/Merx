/*
 * La lecture d'un code-barres par la caméra. E2-06.
 *
 * `BarcodeDetector` — l'API Shape Detection du navigateur — plus
 * `getUserMedia`. Aucune dépendance : le décodage est celui de l'appareil,
 * matériel quand il existe. C'est ce qui tient sur un téléphone d'entrée de
 * gamme en boutique, là où un décodeur wasm de 300 Ko coûte le temps qu'on
 * cherche à gagner.
 *
 * **SPEC § 2.6 gouverne tout ce fichier.** La fonctionnalité privée de sa
 * donnée — ici, de sa caméra — se désactive en silence : ni avertissement, ni
 * champ en rouge, ni rappel.
 *
 *   — API absente, contexte non sécurisé, aucune caméra : le bouton « Scanner »
 *     ne s'affiche pas. Le champ reste saisissable à la main, ce qui couvre
 *     aussi la douchette du comptoir — elle tape comme un clavier ;
 *   — accès refusé : la caméra se ferme, `unavailable` est rendu, et l'écran
 *     retire le bouton pour la session. Rien ne redemande ;
 *   — `getUserMedia` n'est **jamais** appelé au chargement d'un écran, seulement
 *     sur appui : aucune invite système ne surgit sans qu'on l'ait demandée.
 *
 * BACKLOG E2-06 porte le critère à vérifier à la main : l'API est une hypothèse
 * sur le matériel, pas une certitude. Si elle manque sur un Android d'entrée de
 * gamme, un repli wasm s'ajoutera à ce moment-là, pas avant.
 */

/** Les formats lus : l'EAN du fabricant, et le Code 128 que le système émet. */
export const SCANNED_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] as const

interface DetectedBarcode {
  rawValue: string
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike
  getSupportedFormats?(): Promise<string[]>
}

function detectorConstructor(): BarcodeDetectorConstructor | null {
  const candidate = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
  return typeof candidate === 'function' ? candidate : null
}

/**
 * La caméra est-elle une voie possible sur cet appareil ?
 *
 * Trois conditions, et aucune n'est une permission : on ne demande rien pour
 * savoir si le bouton s'affiche. `isSecureContext` parce que `getUserMedia`
 * n'existe qu'en HTTPS ou sur `localhost` — sur le LAN en test (CLAUDE.md),
 * la caméra ne s'ouvre pas, et c'est le bouton qui disparaît, pas un message
 * qui l'explique.
 */
export function cameraScanningAvailable(): boolean {
  return (
    detectorConstructor() !== null &&
    globalThis.isSecureContext === true &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  )
}

/** Ce qu'une session de scan rend : la caméra vivante, ou son absence. */
export type ScanSession =
  | { status: 'unavailable' }
  | {
      status: 'scanning'
      stream: MediaStream
      /** Lit une image de la vidéo et rend le premier code trouvé, ou `null`. */
      read(video: CanvasImageSource): Promise<string | null>
      /** Éteint la caméra. Toujours appelé, y compris en cas d'erreur. */
      stop(): void
    }

/**
 * Ouvre la caméra arrière et rend de quoi lire des images.
 *
 * `facingMode: 'environment'` : sur une tablette, la caméra frontale regarde le
 * vendeur, pas le carton. Ce n'est pas une contrainte dure (`ideal`) — un
 * appareil sans caméra arrière ouvre celle qu'il a plutôt que de refuser.
 *
 * Tout échec — refus, caméra occupée, matériel absent — rend `unavailable`, sans
 * distinguer lequel : l'écran fait la même chose des trois, et une phrase de
 * plus serait la réclamation que § 2.6 interdit.
 */
export async function startScanning(): Promise<ScanSession> {
  const Detector = detectorConstructor()
  if (Detector === null || !cameraScanningAvailable()) return { status: 'unavailable' }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
    })
  } catch {
    return { status: 'unavailable' }
  }

  const detector = new Detector({ formats: [...SCANNED_FORMATS] })

  return {
    status: 'scanning',
    stream,
    async read(video) {
      try {
        const found = await detector.detect(video)
        const value = found[0]?.rawValue?.trim()
        return value === undefined || value === '' ? null : value
      } catch {
        /*
         * Une image illisible — flou, mouvement, cadrage — lève parfois plutôt
         * que de rendre une liste vide. Ce n'est pas une panne : c'est l'image
         * suivante qui répondra.
         */
        return null
      }
    },
    stop() {
      for (const track of stream.getTracks()) track.stop()
    },
  }
}
