/*
 * La surface publique de l'impression. E5-01.
 *
 * Deux propriétés, et ce sont les deux RÈGLE de SPEC § 2.7 vues du code
 * appelant :
 *
 *   un réglage absent ou illisible ne rend **pas** d'imprimante — donc l'écran
 *   n'offre pas le bouton, au lieu de proposer une impression qui échouera
 *   (SPEC § 2.6) ;
 *
 *   au navigateur, l'impression thermique n'existe pas ; le PDF A4 reste la
 *   voie de tout le monde (E5-03).
 */

import { describe, expect, it, vi } from 'vitest'

import type { Raster } from '@/lib/printing/escpos'
import {
  DEFAULT_PRINTER_PORT,
  PRINT_MESSAGES,
  printTicket,
  printerSetup,
  thermalPrinting,
} from '@/lib/printing'
import type { Ticket } from '@/lib/printing/ticket'

const TICKET: Ticket = {
  businessName: 'Parfumerie Nour',
  phone: '',
  address: '',
  number: 'BL-A-26-00042',
  issuedAt: null,
  clientName: '',
  lines: [{ label: 'Savon', quantity: '1.000', unitPrice: '9.50', lineTotal: '9.50' }],
  total: '9.50',
}

function raster(height = 16): Raster {
  return { width: 576, height, dots: new Uint8Array(72 * height) }
}

describe('printerSetup()', () => {
  it('lit l’adresse et le port', () => {
    expect(printerSetup('192.168.1.50:9100', 576)).toEqual({
      host: '192.168.1.50',
      port: 9100,
      width: 576,
    })
  })

  it('prend le port ESC/POS par défaut quand l’adresse n’en dit rien', () => {
    expect(printerSetup('192.168.1.50', 512)).toEqual({
      host: '192.168.1.50',
      port: DEFAULT_PRINTER_PORT,
      width: 512,
    })
  })

  it('tolère les espaces autour de l’adresse', () => {
    expect(printerSetup('  192.168.1.50  ', 576)?.host).toBe('192.168.1.50')
  })

  /*
   * Le défaut d'un commerce qui n'a pas d'imprimante. Ce n'est pas une erreur à
   * annoncer : il n'y a pas d'imprimante, donc pas de bouton.
   */
  it('ne rend rien pour une adresse vide', () => {
    expect(printerSetup('', 576)).toBeNull()
    expect(printerSetup('   ', 576)).toBeNull()
  })

  it('ne rend rien pour une adresse ou un port impossibles', () => {
    expect(printerSetup('192.168.1.50:abc', 576)).toBeNull()
    expect(printerSetup('192.168.1.50:0', 576)).toBeNull()
    expect(printerSetup('192.168.1.50:70000', 576)).toBeNull()
    expect(printerSetup('192.168.1.50:9100:1', 576)).toBeNull()
    expect(printerSetup('imprimante du fond 9100', 576)).toBeNull()
    expect(printerSetup(':9100', 576)).toBeNull()
  })

  /*
   * Une largeur illisible — quelqu'un a écrit dans la ligne à la main — ne
   * devient pas 576 en douce : le ticket sortirait décalé sur une tête de 384.
   * Le réglage est illisible, donc la fonction se désactive.
   */
  it('ne rend rien pour une largeur qui n’est pas une largeur de tête', () => {
    expect(printerSetup('192.168.1.50:9100', '')).toBeNull()
    expect(printerSetup('192.168.1.50:9100', 0)).toBeNull()
    expect(printerSetup('192.168.1.50:9100', 570)).toBeNull()
    expect(printerSetup('192.168.1.50:9100', -576)).toBeNull()
    expect(printerSetup('192.168.1.50:9100', 576.5)).toBeNull()
  })

  it('accepte les trois largeurs du matériel', () => {
    for (const width of [576, 512, 384]) {
      expect(printerSetup('10.0.0.9', width)?.width).toBe(width)
    }
  })
})

describe('au navigateur', () => {
  it('n’annonce aucune impression thermique', () => {
    expect(thermalPrinting()).toBe(false)
  })

  it('refuse d’imprimer, avec une phrase qui dit pourquoi', async () => {
    await expect(
      printTicket(TICKET, { host: '10.0.0.9', port: 9100, width: 576 }, { transport: null }),
    ).rejects.toThrow(PRINT_MESSAGES.unavailable)
  })
})

describe('printTicket()', () => {
  it('dessine à la largeur de la tête et envoie le flux encodé', async () => {
    const render = vi.fn(async () => raster())
    const send = vi.fn(async () => undefined)

    await printTicket(
      TICKET,
      { host: '10.0.0.9', port: 9100, width: 512 },
      { render, transport: { send } },
    )

    expect(render).toHaveBeenCalledWith(TICKET, 512)
    expect(send).toHaveBeenCalledTimes(1)

    const [host, port, batches] = send.mock.calls[0] as unknown as [string, number, Uint8Array[]]
    expect(host).toBe('10.0.0.9')
    expect(port).toBe(9100)
    // Le flux commence par ESC @ et finit par la coupe.
    expect([...(batches[0]?.subarray(0, 2) ?? [])]).toEqual([0x1b, 0x40])
    expect([...(batches.at(-1)?.subarray(-4) ?? [])]).toEqual([0x1d, 0x56, 0x42, 0x00])
  })

  it('laisse remonter l’échec du dessin', async () => {
    const render = vi.fn(async () => {
      throw new Error('Ce navigateur ne sait pas dessiner le ticket.')
    })

    await expect(
      printTicket(
        TICKET,
        { host: '10.0.0.9', port: 9100, width: 576 },
        { render, transport: { send: vi.fn() } },
      ),
    ).rejects.toThrow(/dessiner le ticket/)
  })

  it('laisse remonter l’échec du transport', async () => {
    await expect(
      printTicket(
        TICKET,
        { host: '10.0.0.9', port: 9100, width: 576 },
        {
          render: async () => raster(),
          transport: {
            send: async () => {
              throw new Error("L'imprimante ne répond pas.")
            },
          },
        },
      ),
    ).rejects.toThrow(/ne répond pas/)
  })
})
