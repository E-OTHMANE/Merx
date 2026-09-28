/*
 * E2-05 — ce que l'appareil lit d'un fichier, et ce qu'il refuse d'en deviner.
 *
 * Point de rupture n° 1 (SPEC § 10). Les cas éprouvés ici sont ceux que
 * BACKLOG E2-05 nomme — « colonnes vides, doublons de référence, prix en texte
 * (« 15,00 DH »), accents cassés, espaces parasites » —, pris sur la forme que
 * prend un vrai fichier de grossiste : Excel français au point-virgule, Excel
 * arabe en `windows-1256`, EAN passé en notation scientifique.
 *
 * Chaque assertion négative a son contrôle positif à côté : un refus ne prouve
 * rien si la même voie ne laisse rien passer.
 */

import { describe, expect, it } from 'vitest'

import { detectDelimiter, parseCsv } from '@/modules/catalogue/import/csv'
import { proposeMapping } from '@/modules/catalogue/import/columns'
import { decodeFile, decodeWith, repairDoubleEncoding } from '@/modules/catalogue/import/encoding'
import { chunksOf, motifOf, rejectsCsv, CHUNK_SIZE } from '@/modules/catalogue/import/importer'
import { prepareRows } from '@/modules/catalogue/import/rows'
import { parseAmount, parseCount, parseReference, cleanText } from '@/modules/catalogue/import/values'

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

/* -------------------------------------------------------------------------- */
/* Le texte du fichier                                                         */
/* -------------------------------------------------------------------------- */

describe('encodage — BACKLOG E2-05 : « accents cassés »', () => {
  it('lit l’UTF-8, BOM retiré', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf('Crème;15,00')])
    const { text, encoding } = decodeFile(bytes)
    expect(encoding).toBe('utf-8')
    expect(text).toBe('Crème;15,00')
  })

  it('replie sur Windows arabe ce qui n’est pas de l’UTF-8', () => {
    // « شامبو » en windows-1256, tel qu'Excel réglé en arabe l'écrit.
    const bytes = new Uint8Array([0xd4, 0xc7, 0xe3, 0xc8, 0xe6])
    const { text, encoding } = decodeFile(bytes)
    expect(encoding).toBe('windows-1256')
    expect(text).toBe('شامبو')
  })

  it('lit les accents français dans ce même repli — contrôle', () => {
    // « Crème » en windows-1252 : è = 0xE8, les deux pages le placent là.
    const bytes = new Uint8Array([0x43, 0x72, 0xe8, 0x6d, 0x65])
    expect(decodeWith(bytes, 'windows-1256')).toBe('Crème')
  })

  it('répare un double encodage dans un fichier pourtant valide', () => {
    expect(repairDoubleEncoding('CrÃ¨me hydratante')).toBe('Crème hydratante')
    expect(repairDoubleEncoding('Ø´Ø§Ù…Ø¨Ùˆ')).toBe('شامبو')
  })

  it('ne touche pas à un texte qui n’a rien de cassé — contrôle', () => {
    expect(repairDoubleEncoding('Crème hydratante')).toBe('Crème hydratante')
    expect(repairDoubleEncoding('شامبو 200 ml')).toBe('شامبو 200 ml')
  })
})

describe('CSV', () => {
  it('reconnaît le point-virgule d’un Excel français, malgré les virgules décimales', () => {
    const text = 'Désignation;Prix\nCrème;15,00\nSavon;8,50\n'
    expect(detectDelimiter(text)).toBe(';')
    expect(parseCsv(text, ';')[1]).toEqual(['Crème', '15,00'])
  })

  it('reconnaît la virgule quand c’est elle qui sépare — contrôle', () => {
    expect(detectDelimiter('Designation,Price\nCream,15.00\nSoap,8.50\n')).toBe(',')
  })

  it('reconnaît la tabulation', () => {
    expect(detectDelimiter('Nom\tPrix\nCrème\t15,00\n')).toBe('\t')
  })

  it('tient les guillemets, le guillemet doublé et le retour à la ligne dans une cellule', () => {
    const rows = parseCsv('Nom;Note\n"Crème ""extra""";"deux\nlignes"\n', ';')
    expect(rows[1]).toEqual(['Crème "extra"', 'deux\nlignes'])
  })

  it('tient les fins de ligne Windows et une dernière ligne sans retour', () => {
    expect(parseCsv('a;b\r\nc;d', ';')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })
})

/* -------------------------------------------------------------------------- */
/* Les valeurs                                                                 */
/* -------------------------------------------------------------------------- */

describe('espaces parasites', () => {
  it('ramène les blancs exotiques à un espace et retire les bords', () => {
    // Espace insécable, espace fine, largeur nulle : ce qu'un copier-coller pose.
    const raw = ` Crème${String.fromCharCode(0xa0)}${String.fromCharCode(0x200b)} hydratante  `
    expect(cleanText(raw)).toBe('Crème hydratante')
  })
})

describe('prix en texte — BACKLOG E2-05 : « 15,00 DH »', () => {
  it.each([
    ['15,00 DH', '15.00'],
    ['15.00', '15.00'],
    ['  15,5  ', '15.50'],
    ['1 250,50 dh', '1250.50'],
    ['1.250,50', '1250.50'],
    ['1,250.50', '1250.50'],
    ['1.250.000', '1250000.00'],
    ['12', '12.00'],
    ['15,00 MAD', '15.00'],
    ['15,00 درهم', '15.00'],
  ])('« %s » vaut %s', (raw, sql) => {
    expect(parseAmount(raw)).toEqual({ status: 'amount', sql })
  })

  it('distingue la cellule vide du 0 saisi', () => {
    expect(parseAmount('')).toEqual({ status: 'empty' })
    expect(parseAmount('   ')).toEqual({ status: 'empty' })
    expect(parseAmount('0')).toEqual({ status: 'zero' })
    expect(parseAmount('0,00 DH')).toEqual({ status: 'zero' })
  })

  /*
   * Le refus de deviner. « 1.250 » vaut 1 250 DH ou 1,25 DH selon la
   * convention du fichier : un facteur mille sur un prix de vente.
   */
  it.each(['1.250', '1,250', '12.345'])('refuse de trancher « %s »', (raw) => {
    expect(parseAmount(raw).status).toBe('ambiguous')
  })

  it.each([
    ['-3,00', 'un prix ne peut pas être négatif'],
    ['6,11123E+12', 'Excel l’a écrit en notation scientifique'],
    ['abc', 'ce n’est pas un nombre'],
    ['15,5555', 'trop de décimales pour un prix'],
    ['99999999999,00', 'montant trop grand'],
  ])('refuse « %s » : %s', (raw, reason) => {
    const amount = parseAmount(raw)
    expect(amount.status).toBe('unreadable')
    expect(amount.status === 'unreadable' && amount.reason).toBe(reason)
  })
})

describe('pièces par carton', () => {
  it('lit un entier, milliers groupés compris', () => {
    expect(parseCount('12')).toEqual({ status: 'count', value: 12 })
    expect(parseCount('1 200')).toEqual({ status: 'count', value: 1200 })
    expect(parseCount('1.200')).toEqual({ status: 'count', value: 1200 })
  })

  it('refuse ce qui n’est pas un entier positif, plutôt que de tronquer', () => {
    expect(parseCount('12,5').status).toBe('unreadable')
    expect(parseCount('0').status).toBe('unreadable')
    expect(parseCount('')).toEqual({ status: 'empty' })
  })
})

describe('références et codes-barres', () => {
  it('refuse un EAN qu’Excel a mis en notation scientifique', () => {
    expect(parseReference('6,11123E+12').status).toBe('unreadable')
    // Contrôle positif : le même code, écrit en clair.
    expect(parseReference('6111234567890')).toEqual({ status: 'text', value: '6111234567890' })
  })
})

/* -------------------------------------------------------------------------- */
/* La correspondance des colonnes                                              */
/* -------------------------------------------------------------------------- */

describe('proposition automatique des colonnes', () => {
  it('reconnaît les en-têtes d’un fichier français', () => {
    const headers = ['Référence', 'Désignation', 'Marque', 'PCB', 'PV HT', 'Prix achat']
    expect(proposeMapping(headers)).toEqual({
      code: 0,
      name_fr: 1,
      brand: 2,
      pieces_per_carton: 3,
      unit_price: 4,
      cost_price: 5,
    })
  })

  it('ne confond pas le prix d’achat avec le prix de vente', () => {
    const mapping = proposeMapping(['Prix', 'Prix achat'])
    expect(mapping.unit_price).toBe(0)
    expect(mapping.cost_price).toBe(1)
  })

  it('n’offre pas le prix d’achat à qui ne le lit pas (SPEC § 3)', () => {
    expect(proposeMapping(['Nom', 'Prix achat'], [], false).cost_price).toBeUndefined()
    // Contrôle positif : au patron, il est proposé.
    expect(proposeMapping(['Nom', 'Prix achat'], [], true).cost_price).toBe(1)
  })

  it('reconnaît une colonne arabe à son contenu, faute d’en-tête', () => {
    const mapping = proposeMapping(
      ['Designation', 'Col2'],
      [
        ['Crème hydratante', 'كريم مرطب'],
        ['Savon noir', 'صابون بلدي'],
      ],
    )
    expect(mapping.name_fr).toBe(0)
    expect(mapping.name_ar).toBe(1)
  })

  it('reconnaît un en-tête arabe', () => {
    const mapping = proposeMapping(['الاسم', 'السعر'])
    expect(mapping.name_ar).toBe(0)
    expect(mapping.unit_price).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* La validation ligne par ligne                                               */
/* -------------------------------------------------------------------------- */

const HEADERS = ['Référence', 'Désignation', 'PV', 'Catégorie']
const mapping = { code: 0, name_fr: 1, unit_price: 2, category: 3 }

describe('validation — numéro de ligne et motif qui nomme la colonne', () => {
  it('prépare une ligne complète', () => {
    const { rows, counts } = prepareRows([HEADERS, ['LOR-12', ' Crème ', '15,00 DH', 'Soins']], mapping)
    expect(rows).toEqual([
      { line: 2, name_fr: 'Crème', code: 'LOR-12', unit_price: '15.00', category: 'Soins' },
    ])
    expect(counts.ready).toBe(1)
  })

  it('rejette la ligne entière sur un prix ambigu, en citant la colonne et la valeur', () => {
    const { rows, rejected } = prepareRows(
      [HEADERS, ['LOR-12', 'Crème', '1.250', 'Soins'], ['LOR-13', 'Savon', '8,50', 'Soins']],
      mapping,
    )
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.line).toBe(2)
    expect(rejected[0]!.motif).toContain('Prix de vente (colonne « PV »)')
    expect(rejected[0]!.motif).toContain('1.250')
    // Le critère de la story : la ligne valide part quand même.
    expect(rows.map((row) => row.code)).toEqual(['LOR-13'])
  })

  it('rejette une ligne sans nom, et garde les autres', () => {
    const { rows, rejected } = prepareRows(
      [HEADERS, ['LOR-12', '   ', '15,00', ''], ['LOR-13', 'Savon', '8,50', '']],
      mapping,
    )
    expect(rejected[0]!.motif).toContain('absent')
    expect(rows).toHaveLength(1)
  })

  it('importe la première occurrence d’une référence en double et nomme sa ligne', () => {
    const { rows, rejected } = prepareRows(
      [HEADERS, ['LOR-12', 'Crème', '15,00', ''], ['lor-12', 'Crème bis', '16,00', '']],
      mapping,
    )
    expect(rows.map((row) => row.line)).toEqual([2])
    expect(rejected[0]!.line).toBe(3)
    expect(rejected[0]!.motif).toContain('ligne 2')
  })

  it('compte séparément le prix vide et le prix à 0', () => {
    const { counts } = prepareRows(
      [HEADERS, ['A', 'Crème', '', ''], ['B', 'Savon', '0', ''], ['C', 'Gel', '9,00', '']],
      mapping,
    )
    expect(counts.priceMissing).toBe(1)
    expect(counts.priceZero).toBe(1)
    expect(counts.ready).toBe(3)
  })

  it('compte les lignes sans référence, et ignore les lignes vides', () => {
    const { counts, rows } = prepareRows(
      [HEADERS, ['', 'Crème', '15,00', ''], ['', '', '', ''], ['B', 'Savon', '8,00', '']],
      mapping,
    )
    expect(counts.withoutCode).toBe(1)
    expect(counts.ignored).toBe(1)
    expect(counts.total).toBe(2)
    expect(rows).toHaveLength(2)
  })

  it('n’envoie que les clés qui ont une valeur — une cellule vide n’efface rien', () => {
    const { rows } = prepareRows([HEADERS, ['LOR-12', 'Crème', '', '']], mapping)
    expect(Object.keys(rows[0]!).sort()).toEqual(['code', 'line', 'name_fr'])
  })
})

/* -------------------------------------------------------------------------- */
/* L'envoi et le rapport                                                       */
/* -------------------------------------------------------------------------- */

describe('envoi par blocs', () => {
  it('découpe en blocs de 50 lignes', () => {
    const rows = Array.from({ length: 120 }, (_, n) => n)
    const chunks = chunksOf(rows)
    expect(CHUNK_SIZE).toBe(50)
    expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 20])
    expect(chunks.flat()).toEqual(rows)
  })
})

describe('motif d’un refus de la base', () => {
  it('nomme la référence prise, quelle que soit l’unicité qui a refusé', () => {
    for (const name of ['product_code_per_tenant', 'variant_sku_per_tenant']) {
      const motif = motifOf({ line: 2, outcome: 'rejected', code: '23505', constraint: name })
      expect(motif).toContain('Référence déjà utilisée')
    }
  })

  it('nomme la table quand une policy refuse', () => {
    const motif = motifOf({ line: 2, outcome: 'rejected', code: '42501', table: 'variant_cost' })
    expect(motif).toContain('variant_cost')
  })

  it('rend le message de la base pour ce qu’il ne connaît pas — contrôle', () => {
    const motif = motifOf({ line: 2, outcome: 'rejected', code: '23514', message: 'refus' })
    expect(motif).toBe('refus')
  })
})

describe('rapport de rejets', () => {
  it('reprend les colonnes d’origine, précédées du numéro et du motif', () => {
    const csv = rejectsCsv(HEADERS, [
      { line: 3, motif: 'Prix ambigu', cells: ['LOR-12', 'Crème', '1.250', 'Soins'] },
    ])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.slice(1).trimEnd().split('\r\n')
    expect(lines[0]).toBe('"Ligne";"Motif";"Référence";"Désignation";"PV";"Catégorie"')
    expect(lines[1]).toBe('"3";"Prix ambigu";"LOR-12";"Crème";"1.250";"Soins"')
  })

  it('échappe les guillemets, pour rester réimportable', () => {
    const csv = rejectsCsv(['Nom'], [{ line: 2, motif: 'm', cells: ['Crème "extra"'] }])
    expect(csv).toContain('"Crème ""extra"""')
  })
})
