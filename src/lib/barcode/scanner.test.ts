/*
 * La lecture par la caméra — E2-06.
 *
 * Ce qui est éprouvé ici est **le silence**, pas le décodage : le décodage
 * appartient au navigateur. SPEC § 2.6 — API absente, caméra absente, accès
 * refusé : la fonctionnalité se retire, elle ne réclame rien, et surtout elle
 * ne demande aucune permission avant qu'on ait appuyé.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cameraScanningAvailable, startScanning } from '@/lib/barcode/scanner'

/**
 * Un `BarcodeDetector` de comédie. `detector()` rend un constructeur qui note
 * les formats demandés et rend ce qu'on lui dit de rendre — une classe et un
 * héritage coûteraient un `override` par méthode, pour la même chose.
 */
function detector(detect: () => Promise<Array<{ rawValue: string }>>) {
  const built: Array<{ formats?: readonly string[] }> = []
  const Constructor = function (this: unknown, options?: { formats?: readonly string[] }) {
    built.push(options ?? {})
    return { detect }
  } as unknown as new (options?: { formats?: readonly string[] }) => { detect: typeof detect }

  return { Constructor, built }
}

const found = async () => [{ rawValue: '6111234567890' }]

function fakeStream() {
  const track = { stop: vi.fn() }
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track }
}

function installCamera(getUserMedia: () => Promise<MediaStream>) {
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
}

beforeEach(() => {
  vi.stubGlobal('BarcodeDetector', detector(found).Constructor)
  vi.stubGlobal('isSecureContext', true)
  installCamera(async () => fakeStream().stream)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('la disponibilité', () => {
  it('est vraie quand l’API, le contexte sécurisé et la caméra sont là', () => {
    expect(cameraScanningAvailable()).toBe(true)
  })

  it('est fausse sans BarcodeDetector — le bouton ne s’affiche pas', () => {
    vi.stubGlobal('BarcodeDetector', undefined)

    expect(cameraScanningAvailable()).toBe(false)
  })

  /*
   * En test sur le LAN (CLAUDE.md, « tester sur un vrai téléphone »), l'origine
   * est en clair : `getUserMedia` n'existe pas. Le bouton disparaît, et aucune
   * phrase n'explique pourquoi.
   */
  it('est fausse hors contexte sécurisé', () => {
    vi.stubGlobal('isSecureContext', false)

    expect(cameraScanningAvailable()).toBe(false)
  })

  it('est fausse sans mediaDevices', () => {
    vi.stubGlobal('navigator', {})

    expect(cameraScanningAvailable()).toBe(false)
  })

  it('ne demande aucune permission pour répondre', () => {
    const getUserMedia = vi.fn(async () => fakeStream().stream)
    installCamera(getUserMedia)

    cameraScanningAvailable()

    expect(getUserMedia).not.toHaveBeenCalled()
  })
})

describe('l’ouverture de la caméra', () => {
  it('n’a lieu que sur appui, et rend de quoi lire', async () => {
    const session = await startScanning()

    expect(session.status).toBe('scanning')
  })

  it('demande la caméra arrière — celle qui regarde le carton', async () => {
    const getUserMedia = vi.fn(async () => fakeStream().stream)
    installCamera(getUserMedia)

    await startScanning()

    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: 'environment' } } })
  })

  it('rend « indisponible » quand l’accès est refusé, sans lever', async () => {
    installCamera(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError')
    })

    const session = await startScanning()

    expect(session.status).toBe('unavailable')
  })

  it('rend « indisponible » quand l’API manque, sans toucher à la caméra', async () => {
    vi.stubGlobal('BarcodeDetector', undefined)
    const getUserMedia = vi.fn(async () => fakeStream().stream)
    installCamera(getUserMedia)

    const session = await startScanning()

    expect(session.status).toBe('unavailable')
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('ne lit que les formats des deux sources de la RÈGLE M1-5', async () => {
    const { Constructor, built } = detector(found)
    vi.stubGlobal('BarcodeDetector', Constructor)

    await startScanning()

    expect(built[0]?.formats).toContain('ean_13')
    expect(built[0]?.formats).toContain('code_128')
  })
})

describe('la lecture', () => {
  const video = {} as CanvasImageSource

  it('rend le code trouvé', async () => {
    const session = await startScanning()

    if (session.status !== 'scanning') throw new Error('caméra attendue')
    expect(await session.read(video)).toBe('6111234567890')
  })

  it('rend null sur une image sans code', async () => {
    vi.stubGlobal('BarcodeDetector', detector(async () => []).Constructor)
    const session = await startScanning()

    if (session.status !== 'scanning') throw new Error('caméra attendue')
    expect(await session.read(video)).toBeNull()
  })

  /*
   * Une image floue lève parfois plutôt que de rendre une liste vide. Ce n'est
   * pas une panne : c'est l'image suivante qui répondra.
   */
  it('rend null sur une image que le décodeur refuse', async () => {
    vi.stubGlobal(
      'BarcodeDetector',
      detector(async () => {
        throw new Error('source non décodable')
      }).Constructor,
    )
    const session = await startScanning()

    if (session.status !== 'scanning') throw new Error('caméra attendue')
    expect(await session.read(video)).toBeNull()
  })

  it('éteint la caméra à l’arrêt — sinon la diode reste allumée', async () => {
    const { stream, track } = fakeStream()
    installCamera(async () => stream)

    const session = await startScanning()
    if (session.status !== 'scanning') throw new Error('caméra attendue')
    session.stop()

    expect(track.stop).toHaveBeenCalled()
  })
})
