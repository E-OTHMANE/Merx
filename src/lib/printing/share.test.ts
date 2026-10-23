/*
 * Le partage du PDF. E5-03 — critères 3 (« partage via l'API native ») et 4
 * (« nom de fichier explicite »).
 *
 * Les trois voies se mesurent avec des doublons, parce qu'aucune n'existe ici :
 * jsdom n'a pas de plugin Capacitor, n'implémente pas `navigator.share()`, et
 * son téléchargement ne va nulle part. Ce qui se vérifie est donc ce qui est
 * décidable sans appareil — quelle voie est choisie, ce qu'elle reçoit, et ce
 * qu'elle rend. Le sélecteur natif lui-même reste à voir sur un téléphone
 * (`docs/PENDING-CHECKS.md`).
 */

import { describe, expect, it, vi } from 'vitest'

import {
  downloadSharing,
  nativeSharing,
  pdfFileName,
  webSharing,
  type FilesystemLike,
  type ShareLike,
} from '@/lib/printing/share'

const FILE = { name: 'BL-A-26-00042-2026-09-04.pdf', bytes: new Uint8Array([1, 2, 3]) }

describe('le nom du fichier', () => {
  /*
   * Le critère de la story écrivait `BL-A-0042-2026-09-04.pdf`. Ce numéro
   * n'existe pas : E4-02 a arbitré `BL-A-26-00042` (RÈGLE M3-2). Le critère est
   * antérieur à l'arbitrage, et c'est lui qui a été corrigé.
   */
  it('porte le numéro du document et sa date d’émission', () => {
    expect(pdfFileName('BL-A-26-00042', '2026-09-04T10:15:00.000Z')).toBe(
      'BL-A-26-00042-2026-09-04.pdf',
    )
  })

  /*
   * La date est celle du comptoir, comme l'année du numéro (RÈGLE M3-2). Le
   * Maroc est à UTC+1 : les deux dates divergent quand il est entre minuit et
   * une heure à Casablanca, c'est-à-dire la veille en UTC. Un bon émis le
   * 1er janvier à 00 h 30 ne porte donc pas `2026-12-31`, qui est sa date UTC.
   */
  it('date en heure du comptoir, jamais en UTC', () => {
    expect(pdfFileName('BL-A-27-00001', '2026-12-31T23:30:00.000Z')).toBe(
      'BL-A-27-00001-2027-01-01.pdf',
    )
  })

  it('se contente du numéro quand il n’y a pas de date', () => {
    expect(pdfFileName('DV-A-26-00007', null)).toBe('DV-A-26-00007.pdf')
  })
})

describe('la voie de l’enveloppe Android', () => {
  function plugins() {
    const files: FilesystemLike = {
      writeFile: vi.fn().mockResolvedValue({ uri: 'file:///cache/bon.pdf' }),
    }
    const sharer: ShareLike = { share: vi.fn().mockResolvedValue(undefined) }
    return { files, sharer }
  }

  it('écrit dans le cache, puis ouvre le sélecteur natif sur ce fichier', async () => {
    const { files, sharer } = plugins()

    expect(await nativeSharing(files, sharer).share(FILE)).toBe('shared')

    expect(files.writeFile).toHaveBeenCalledWith({
      path: FILE.name,
      data: 'AQID',
      directory: 'CACHE',
      recursive: true,
    })
    expect(sharer.share).toHaveBeenCalledWith({
      title: FILE.name,
      files: ['file:///cache/bon.pdf'],
    })
  })

  /* Refermer le sélecteur est un geste ordinaire, pas une panne à annoncer. */
  it('ne traite pas une annulation comme un échec', async () => {
    const { files } = plugins()
    const sharer: ShareLike = { share: vi.fn().mockRejectedValue(new Error('Share canceled')) }

    expect(await nativeSharing(files, sharer).share(FILE)).toBe('cancelled')
  })

  it('laisse remonter un vrai échec', async () => {
    const { files } = plugins()
    const sharer: ShareLike = { share: vi.fn().mockRejectedValue(new Error('No app found')) }

    await expect(nativeSharing(files, sharer).share(FILE)).rejects.toThrow('No app found')
  })
})

describe('la voie d’un navigateur mobile', () => {
  it('n’existe pas quand le navigateur ne partage pas', () => {
    expect(webSharing({})).toBeNull()
    expect(webSharing({ share: vi.fn() })).toBeNull()
  })

  it('passe le PDF en fichier à l’API de partage', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const sharing = webSharing({ canShare: () => true, share })!

    expect(await sharing.share(FILE)).toBe('shared')

    const sent = share.mock.calls[0]![0] as { title: string; files: File[] }
    expect(sent.title).toBe(FILE.name)
    expect(sent.files[0]!.name).toBe(FILE.name)
    expect(sent.files[0]!.type).toBe('application/pdf')
  })

  /*
   * Certains navigateurs annoncent `share()` mais refusent les fichiers. Le
   * téléchargement prend alors la suite : l'utilisateur a son PDF, ce qui est
   * la fonctionnalité — pas le sélecteur, qui n'en est que la commodité.
   */
  it('retombe sur le téléchargement quand les fichiers sont refusés', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const share = vi.fn()
    const sharing = webSharing({ canShare: () => false, share })!

    try {
      expect(await sharing.share(FILE)).toBe('downloaded')
      expect(share).not.toHaveBeenCalled()
      expect(click).toHaveBeenCalledOnce()
    } finally {
      click.mockRestore()
    }
  })

  it('ne traite pas une annulation comme un échec', async () => {
    const share = vi.fn().mockRejectedValue(new Error('Share canceled'))
    const sharing = webSharing({ canShare: () => true, share })!

    expect(await sharing.share(FILE)).toBe('cancelled')
  })
})

describe('la voie du téléchargement', () => {
  it('descend le fichier sous son nom, et ne laisse rien dans la page', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:merx')

    try {
      expect(await downloadSharing().share(FILE)).toBe('downloaded')

      expect(click).toHaveBeenCalledOnce()
      expect(made).toHaveBeenCalledOnce()
      const anchor = click.mock.instances[0] as HTMLAnchorElement
      expect(anchor.download).toBe(FILE.name)
      expect(document.querySelectorAll('a')).toHaveLength(0)
    } finally {
      click.mockRestore()
      made.mockRestore()
    }
  })
})
