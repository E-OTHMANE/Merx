/*
 * Le PDF jusqu'à WhatsApp. E5-03 — SPEC § 2.7.
 *
 * Trois voies, et aucune n'est un repli honteux : c'est le même fichier, remis
 * par le moyen que la plateforme a.
 *
 *   1. **l'enveloppe Android** — le fichier est écrit dans le cache de
 *      l'application, puis le sélecteur natif s'ouvre. C'est le critère de la
 *      story : « partage via l'API native de partage de l'appareil » ;
 *   2. **un navigateur mobile** — `navigator.share()` avec un fichier, quand
 *      `canShare()` l'accepte. La WebView d'Android, elle, n'implémente pas la
 *      Web Share API : c'est précisément pourquoi la voie 1 passe par un
 *      plugin et non par `navigator` ;
 *   3. **sinon** — un téléchargement. Chrome de bureau est la cible du
 *      développement et du dépannage (SPEC § 2.7), et un fichier dans le
 *      dossier des téléchargements se joint à un courriel comme un autre.
 *
 * Contrairement à l'impression thermique, **le bouton ne disparaît jamais** :
 * la RÈGLE de § 2.7 dit que le PDF est présent partout, enveloppe comprise.
 * C'est la voie qui change, pas la fonctionnalité.
 */

import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

import { toBase64 } from '@/lib/printing/escpos'
import { fileDate } from '@/lib/dates'

export interface PdfFile {
  /** `BL-A-26-00042-2026-09-04.pdf`. */
  name: string
  bytes: Uint8Array<ArrayBuffer>
}

/**
 * Ce qu'il est advenu du fichier — l'écran n'en dit pas la même chose.
 *
 * `cancelled` n'est pas un échec : refermer le sélecteur de partage est un
 * geste ordinaire, et le signaler comme une erreur apprendrait au vendeur à ne
 * plus lire les messages.
 */
export type ShareOutcome = 'shared' | 'cancelled' | 'downloaded'

export interface PdfSharing {
  share(file: PdfFile): Promise<ShareOutcome>
}

export const SHARE_MESSAGES = {
  shared: 'PDF envoyé.',
  downloaded: 'PDF enregistré dans vos téléchargements.',
  failed: 'Le PDF n’a pas pu être partagé. Le document est enregistré, réessayez.',
  working: 'Préparation du PDF…',
} as const

/**
 * Le nom du fichier : le numéro du document, puis la date d'émission.
 *
 * *Écart au critère, assumé.* Le BACKLOG écrivait `BL-A-0042-2026-09-04.pdf` ;
 * ce numéro n'existe pas. E4-02 a arbitré `BL-A-26-00042` (RÈGLE M3-2 : le code
 * du type, la lettre de l'appareil, l'année sur deux chiffres, la séquence sur
 * cinq), et le critère est antérieur à cet arbitrage. Inventer un second format
 * de numéro pour un nom de fichier serait pire que corriger le critère — ce qui
 * est fait.
 *
 * Sans date — ce qu'un document numéroté n'est jamais, le `check`
 * `sale_document_issued_at_when_numbered` l'interdit — le numéro suffit : il est
 * déjà unique par commerce.
 */
export function pdfFileName(number: string, issuedAt: string | null): string {
  const day = fileDate(issuedAt)
  return day === null ? `${number}.pdf` : `${number}-${day}.pdf`
}

/** La part des plugins que ce fichier emploie — ce qu'un doublon doit fournir. */
export interface FilesystemLike {
  writeFile(options: {
    path: string
    data: string
    directory: Directory
    recursive: boolean
  }): Promise<{ uri: string }>
}

export interface ShareLike {
  share(options: { title: string; files: string[] }): Promise<unknown>
}

/**
 * Vrai quand l'utilisateur a refermé le sélecteur.
 *
 * Le plugin ne distingue pas l'annulation autrement que par sa phrase — « Share
 * canceled » —, et il n'y a pas d'autre prise. Si une version future changeait
 * ce mot, le pire serait un message d'échec sur un geste volontaire : rien
 * n'est perdu, le document est enregistré depuis longtemps.
 */
function cancelled(error: unknown): boolean {
  return error instanceof Error && /cancel/i.test(error.message)
}

/**
 * La voie de l'enveloppe : écrire dans le cache, puis ouvrir le sélecteur.
 *
 * Le **cache** et non `Documents` : un PDF partagé est un fichier de passage,
 * que le système peut reprendre quand la place manque. Le document lui-même est
 * en base, et le bouton le régénère à l'identique.
 */
export function nativeSharing(files: FilesystemLike, sharer: ShareLike): PdfSharing {
  return {
    async share(file) {
      const { uri } = await files.writeFile({
        path: file.name,
        data: toBase64(file.bytes),
        directory: Directory.Cache,
        recursive: true,
      })

      try {
        await sharer.share({ title: file.name, files: [uri] })
      } catch (error: unknown) {
        if (cancelled(error)) return 'cancelled'
        throw error
      }

      return 'shared'
    },
  }
}

/** La part de `navigator` employée ici. */
export interface NavigatorShareLike {
  canShare?: (data: { files: File[] }) => boolean
  share?: (data: { title: string; files: File[] }) => Promise<void>
}

/** La voie d'un navigateur mobile, ou `null` s'il ne partage pas de fichiers. */
export function webSharing(nav: NavigatorShareLike): PdfSharing | null {
  const { canShare, share } = nav
  if (canShare === undefined || share === undefined) return null

  return {
    async share(file) {
      const handle = new File([file.bytes], file.name, { type: 'application/pdf' })
      if (!canShare({ files: [handle] })) return downloadSharing().share(file)

      try {
        await share({ title: file.name, files: [handle] })
      } catch (error: unknown) {
        if (cancelled(error)) return 'cancelled'
        throw error
      }

      return 'shared'
    },
  }
}

/** La voie de tout le monde : le fichier descend dans les téléchargements. */
export function downloadSharing(page: Document = document): PdfSharing {
  return {
    async share(file) {
      const url = URL.createObjectURL(new Blob([file.bytes], { type: 'application/pdf' }))
      const anchor = page.createElement('a')
      anchor.href = url
      anchor.download = file.name
      page.body.append(anchor)
      anchor.click()
      anchor.remove()
      /*
       * L'URL est révoquée au tour suivant : la révoquer tout de suite coupe le
       * téléchargement que le clic vient de lancer sur certains navigateurs.
       */
      setTimeout(() => URL.revokeObjectURL(url), 0)
      return 'downloaded'
    },
  }
}

/** La voie de cette plateforme-ci. Il y en a toujours une. */
export function pdfSharing(): PdfSharing {
  if (Capacitor.isNativePlatform()) return nativeSharing(Filesystem, Share)
  return webSharing(navigator) ?? downloadSharing()
}
