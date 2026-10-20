// @vitest-environment node

/*
 * E4-07 — liste et consultation des documents de vente.
 * SPEC § 2.1 (exception nommée), § 3.1 (matrice), § 8 (RÈGLES M3-2, M3-3, M3-4).
 *
 * ÉCRIT SANS STACK, ET SANS ÊTRE LANCÉ : la session qui l'a produit n'avait ni
 * Docker ni Supabase. Aucune assertion ci-dessous n'a été vue verte ni rouge —
 * voir docs/PENDING-CHECKS.md, « E4-07 », pour ce qu'il faut rejouer et dans
 * quel ordre.
 *
 * `list_sale_documents()` est `security definer` : aucune policy ne s'y applique.
 * Ses deux gardes sont tout ce qui sépare la liste d'un commerce de celle du
 * voisin, et chacun a ici son test, avec une réponse qu'aucun autre ne donne
 * (CLAUDE.md) :
 *
 *   1. `merx.can('create_sale')` — `42501`, sa propre phrase ;
 *   2. le filtre sur `merx.current_tenant_id()` — SEUL GARDE D'ISOLATION de ce
 *      chemin. Son test met **le même numéro dans les deux commerces au même
 *      instant**, dans une seule transaction, et compte hors RLS : écrits dans
 *      deux transactions séparées, les deux documents ne se rencontreraient
 *      jamais et le garde pourrait disparaître sans qu'un test tombe.
 *
 * Sujets : les gardes ; l'isolation ; l'ordre et les brouillons ; chaque filtre ;
 * les trois formes de la recherche par numéro ; le nom de l'auteur rendu à un
 * employé ; la page bornée ; et, à la fin, **les plans** — 40 000 documents,
 * jeton d'un employé, session chaude, plusieurs passages.
 *
 * Ce qui n'est pas ici : le contenu des écrans (`src/modules/sales`), le statut
 * HTTP et l'auteur vus de PostgREST (`sale-document-api.test.ts`), le registre
 * des exceptions (`conventions.test.ts`), l'annulation elle-même
 * (`sale-document.test.ts`, E4-01).
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { INSUFFICIENT_PRIVILEGE, actAs, attempt, tokenFor, withoutTrigger } from './isolation'
import { indexesUsed, planOfStatement, seqScansOf } from './stock-plan'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

/* La phrase du premier garde : aucun autre garde de la fonction ne répond 42501. */
const NO_LIST_RIGHT = 'consulter les documents de vente'

let client: Client

/* -------------------------------------------------------------------------- */
/* Peuplement                                                                  */
/* -------------------------------------------------------------------------- */

type DocType = 'quote' | 'order' | 'delivery_note'
type DocStatus = 'draft' | 'confirmed' | 'delivered' | 'cancelled'

const CODES: Readonly<Record<DocType, string>> = { quote: 'DV', order: 'CM', delivery_note: 'BL' }

interface Shop {
  tenant: string
  warehouse: string
  owner: string
  /** Deux appareils : « A » (Comptoir) et « B » (Tablette). */
  deviceA: string
  deviceB: string
  /** Deux variantes, pour que les deux lignes d'un document diffèrent. */
  variants: [string, string]
}

const shops: { a: Shop; b: Shop } = {
  a: {
    tenant: '',
    warehouse: '',
    owner: '',
    deviceA: '',
    deviceB: '',
    variants: ['', ''],
  },
  b: {
    tenant: '',
    warehouse: '',
    owner: '',
    deviceA: '',
    deviceB: '',
    variants: ['', ''],
  },
}

async function one<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<T>(sql, values)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0]
}

async function makeShop(name: string): Promise<Shop> {
  const tenant = (
    await one<{ id: string }>(
      'insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), $1) returning id',
      [name],
    )
  ).id
  // Le dépôt naît avec le commerce (trigger `open_default_warehouse`, E3-02).
  const warehouse = (
    await one<{ id: string }>('select id from public.warehouse where tenant_id = $1 and is_default', [
      tenant,
    ])
  ).id
  const owner = (
    await one<{ id: string }>(
      'insert into public.app_user (tenant_id, full_name, role) values ($1, $2, $3) returning id',
      [tenant, `Patron de ${name}`, 'owner'],
    )
  ).id

  const devices: string[] = []
  for (const [prefix, label] of [
    ['A', 'Comptoir'],
    ['B', 'Tablette'],
  ] as const) {
    devices.push(
      (
        await one<{ id: string }>(
          'insert into public.device (tenant_id, label, prefix) values ($1, $2, $3) returning id',
          [tenant, `${label} ${name}`, prefix],
        )
      ).id,
    )
  }

  const variants: string[] = []
  for (const label of ['Savon 500 g', 'Crème hydratante']) {
    // La variante par défaut porte l'identifiant de son produit depuis E2-01.
    variants.push(
      (
        await one<{ id: string }>(
          'insert into public.product (tenant_id, name_fr, created_by) values ($1, $2, $3) returning id',
          [tenant, label, owner],
        )
      ).id,
    )
  }

  return {
    tenant,
    warehouse,
    owner,
    deviceA: devices[0]!,
    deviceB: devices[1]!,
    variants: [variants[0]!, variants[1]!],
  }
}

interface DocSpec {
  shop: Shop
  type: DocType
  device: 'A' | 'B'
  seq: number
  status: DocStatus
  /** Émission (UTC) d'un document numéroté ; création d'un brouillon. */
  at: string
  withLines?: boolean
  notes?: string
  reason?: string
}

/**
 * Un document dans le statut demandé, posé en `postgres`. Il passe par les
 * vraies transitions — brouillon, puis confirmation avec numéro et date — avec
 * un seul garde levé à la fois, nommément.
 *
 * L'année du numéro est `26` : tous les documents sont émis en 2026, et le garde
 * `merx.require_document_number_shape()` la recalcule depuis `issued_at`.
 */
async function makeDoc(spec: DocSpec): Promise<string> {
  const { shop } = spec
  await client.query('reset role')

  const lines: Array<[string, string, string]> = spec.withLines
    ? [
        [shop.variants[0], '24', '9.50'],
        [shop.variants[1], '3', '4.00'],
      ]
    : []
  // 24 × 9,50 + 3 × 4,00 = 240,00.
  const total = spec.withLines ? '240.00' : '0.00'

  const created = await one<{ id: string }>(
    'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id, created_by,' +
      ' subtotal, total, notes, created_at)' +
      ' values ($1, $2::public.sale_doc_type, $3, $4, $5, $6, $6, $7, $8::timestamptz) returning id',
    [
      shop.tenant,
      spec.type,
      shop.warehouse,
      spec.device === 'A' ? shop.deviceA : shop.deviceB,
      shop.owner,
      total,
      spec.notes ?? null,
      spec.at,
    ],
  )

  for (const [variant, quantity, price] of lines) {
    await client.query(
      'insert into public.sale_line (tenant_id, sale_document_id, variant_id, quantity, unit_price)' +
        ' values ($1, $2, $3, $4, $5)',
      [shop.tenant, created.id, variant, quantity, price],
    )
  }
  if (spec.status === 'draft') return created.id

  const number = `${CODES[spec.type]}-${spec.device}-26-${String(spec.seq).padStart(5, '0')}`
  await withoutTrigger(client, 'public.sale_document', 'write_sale_movements', async () => {
    await client.query(
      "update public.sale_document set status = 'confirmed', doc_number = $2," +
        ' issued_at = $3::timestamptz where id = $1',
      [created.id, number, spec.at],
    )
  })
  if (spec.status === 'delivered') {
    await client.query("update public.sale_document set status = 'delivered' where id = $1", [
      created.id,
    ])
  }
  if (spec.status === 'cancelled') {
    /*
     * L'annulation réelle exige le patron, un compte d'authentification pour le
     * journal et l'inversion des mouvements — mesurés dans
     * `sale-document.test.ts` (E4-01), qui en est le sujet. Ce fichier a besoin
     * d'une ligne **annulée**, pas d'une annulation : les trois gardes de la
     * transition sont levés nommément, et seulement ici.
     */
    await withoutTrigger(client, 'public.sale_document', 'require_cancel_capability', async () => {
      await withoutTrigger(client, 'public.sale_document', 'audit_row_change', async () => {
        await withoutTrigger(client, 'public.sale_document', 'reverse_sale_movements', async () => {
          await client.query(
            "update public.sale_document set status = 'cancelled', cancellation_reason = $2" +
              ' where id = $1',
            [created.id, spec.reason ?? 'erreur de saisie'],
          )
        })
      })
    })
  }
  return created.id
}

/** Les identifiants des documents de A, par nom court. */
const docs: Record<string, string> = {}
const neighbourDocs: Record<string, string> = {}

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING })
  try {
    await client.connect()
  } catch (cause) {
    throw new Error(
      `Base locale injoignable sur ${CONNECTION_STRING}.\n` +
        'Démarrer le stack : npx supabase start && npx supabase db reset',
      { cause },
    )
  }
  await client.query('begin')

  shops.a = await makeShop('Documents A')
  shops.b = await makeShop('Documents B')

  const a = shops.a
  docs['d1'] = await makeDoc({ shop: a, type: 'quote', device: 'A', seq: 1, status: 'confirmed', at: '2026-10-01T08:00:00Z', withLines: true })
  docs['d8'] = await makeDoc({ shop: a, type: 'quote', device: 'A', seq: 42, status: 'confirmed', at: '2026-10-01T09:00:00Z' })
  docs['d2'] = await makeDoc({ shop: a, type: 'order', device: 'A', seq: 2, status: 'confirmed', at: '2026-10-02T08:00:00Z' })
  docs['d3'] = await makeDoc({ shop: a, type: 'delivery_note', device: 'A', seq: 42, status: 'confirmed', at: '2026-10-03T08:00:00Z', withLines: true, notes: 'Livraison chantier' })
  docs['d4'] = await makeDoc({ shop: a, type: 'delivery_note', device: 'B', seq: 42, status: 'delivered', at: '2026-10-04T08:00:00Z' })
  docs['d5'] = await makeDoc({ shop: a, type: 'delivery_note', device: 'A', seq: 43, status: 'cancelled', at: '2026-10-05T08:00:00Z', reason: 'client absent' })
  docs['d6'] = await makeDoc({ shop: a, type: 'delivery_note', device: 'A', seq: 0, status: 'draft', at: '2026-10-06T08:00:00Z' })
  // 23 h 30 UTC le 7 : 00 h 30 le 8 à Casablanca (UTC+1).
  docs['d7'] = await makeDoc({ shop: a, type: 'delivery_note', device: 'B', seq: 100, status: 'confirmed', at: '2026-10-07T23:30:00Z' })

  // Le voisin porte **le même numéro** que d3 : BL-A-26-00042.
  const b = shops.b
  neighbourDocs['nb1'] = await makeDoc({ shop: b, type: 'delivery_note', device: 'A', seq: 42, status: 'confirmed', at: '2026-10-03T08:00:00Z' })
  neighbourDocs['nb2'] = await makeDoc({ shop: b, type: 'delivery_note', device: 'B', seq: 0, status: 'draft', at: '2026-10-08T08:00:00Z' })
}, 120_000)

afterAll(async () => {
  await client?.query('rollback')
  await client?.end()
}, 60_000)

/* -------------------------------------------------------------------------- */
/* Outillage                                                                   */
/* -------------------------------------------------------------------------- */

interface Listed {
  id: string
  doc_type: string
  doc_number: string | null
  status: string
  subtotal: string
  discount_total: string
  total: string
  notes: string | null
  cancellation_reason: string | null
  issued_at: string | null
  sort_at: string
  device_label: string | null
  device_prefix: string | null
  author_name: string | null
}

const COLUMNS =
  'id, doc_type::text as doc_type, doc_number, status::text as status, subtotal::text as subtotal,' +
  ' discount_total::text as discount_total, total::text as total, notes, cancellation_reason,' +
  ' issued_at::text as issued_at, sort_at::text as sort_at, device_label, device_prefix::text as device_prefix,' +
  ' author_name'

/** Appelle la fonction avec des arguments nommés, sous la session courante. */
async function list(args: Record<string, unknown> = {}): Promise<Listed[]> {
  const names = Object.keys(args)
  const call = names.map((name, n) => `${name} => $${n + 1}`).join(', ')
  const { rows } = await client.query<Listed>(
    `select ${COLUMNS} from public.list_sale_documents(${call})`,
    names.map((name) => args[name]),
  )
  return rows
}

const numbers = (rows: Listed[]): Array<string | null> => rows.map((row) => row.doc_number)
const ids = (rows: Listed[]): string[] => rows.map((row) => row.id)

async function asA(role = 'worker'): Promise<void> {
  await actAs(client, tokenFor(shops.a.tenant, role))
}

async function inCase(body: () => Promise<void>): Promise<void> {
  await client.query('reset role')
  await client.query('savepoint case_under_test')
  try {
    await body()
  } finally {
    await client.query('reset role')
    await client.query('rollback to savepoint case_under_test')
  }
}

/* ========================================================================== */
/* Garde 1 — la capacité                                                       */
/* ========================================================================== */

describe('list_sale_documents — premier garde : la capacité', () => {
  /*
   * Doublé par `RequireCapability` sur la route : celui-ci est le seul qui compte
   * quand l'appel arrive sans passer par l'écran. Sa phrase n'est celle d'aucun
   * autre garde — le second ne refuse pas, il rend zéro ligne.
   */
  it('refuse une session sans create_sale, avec sa propre phrase', async () => {
    await inCase(async () => {
      await actAs(client, tokenFor(shops.a.tenant, 'nobody'))

      const called = await attempt(client, 'select * from public.list_sale_documents()')

      expect(called.ok, 'FUITE — la liste sort sans create_sale').toBe(false)
      if (called.ok) return
      expect(called.code, called.message).toBe(INSUFFICIENT_PRIVILEGE)
      expect(called.message).toContain(NO_LIST_RIGHT)
    })
  })

  it.each([['owner'], ['worker']])('et la rend à un %s — le contrôle positif', async (role) => {
    await inCase(async () => {
      await asA(role)

      expect(await list()).toHaveLength(8)
    })
  })

  /*
   * Le privilège d'exécution est un autre garde, qui répond autrement : un
   * refus de privilège, pas la phrase de la fonction. `anon` ne l'a pas.
   */
  it('refuse l’exécution à anon, par le privilège et non par la fonction', async () => {
    await inCase(async () => {
      await actAs(client, null, 'anon')

      const called = await attempt(client, 'select * from public.list_sale_documents()')

      expect(called.ok).toBe(false)
      if (called.ok) return
      expect(called.code, called.message).toBe(INSUFFICIENT_PRIVILEGE)
      expect(called.message).toContain('permission denied for function list_sale_documents')
      expect(called.message).not.toContain(NO_LIST_RIGHT)
    })
  })

  it('est une fonction definer stable, au plan personnalisé et au chemin vide', async () => {
    await client.query('reset role')
    const fn = await one<{ secdef: boolean; volatility: string; config: string[] }>(
      "select prosecdef as secdef, provolatile::text as volatility, proconfig as config" +
        " from pg_proc where oid = 'public.list_sale_documents(timestamptz, timestamptz," +
        " public.sale_doc_status, public.sale_doc_type, uuid, text, uuid, int)'::regprocedure",
    )

    expect(fn.secdef).toBe(true)
    expect(fn.volatility).toBe('s')
    expect(fn.config).toContain('search_path=""')
    // Sans lui, le plan générique prend le relais après cinq appels (E2-04, E3-02).
    expect(fn.config).toContain('plan_cache_mode=force_custom_plan')
  })
})

/* ========================================================================== */
/* Garde 2 — le filtre du commerce, seul garde d'isolation                     */
/* ========================================================================== */

describe('list_sale_documents — second garde : le commerce du jeton', () => {
  /*
   * Le contrôle qui rend les autres vrais : le voisin a des documents, lus hors
   * RLS, **en même temps** que ceux de A, dans la même transaction. Sans cela, un
   * voisin vide satisferait chaque cas ci-dessous.
   */
  it('le voisin a bien ses documents, vus hors RLS, en même temps que ceux de A', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ tenant_id: string; count: string }>(
      'select tenant_id, count(*)::text as count from public.sale_document' +
        ' where tenant_id = any($1) group by tenant_id',
      [[shops.a.tenant, shops.b.tenant]],
    )

    const byTenant = new Map(rows.map((row) => [row.tenant_id, Number(row.count)]))
    expect(byTenant.get(shops.a.tenant)).toBe(8)
    expect(byTenant.get(shops.b.tenant)).toBe(2)
  })

  it.each([['worker'], ['owner']])('ne rend aucun document du voisin, sous un %s', async (role) => {
    await inCase(async () => {
      await asA(role)

      const rows = await list()

      expect(rows).toHaveLength(8)
      const foreign = Object.values(neighbourDocs)
      expect(
        ids(rows).filter((id) => foreign.includes(id)),
        'FUITE — un document d’un autre commerce est listé',
      ).toEqual([])
    })
  })

  /*
   * Le cas qui n'a de sens qu'avec le **même numéro dans les deux commerces au
   * même instant** : BL-A-26-00042 existe chez A (d3) et chez B (nb1). Retirer le
   * filtre du commerce rend les deux.
   */
  it('à numéro égal, ne rend que celui de son commerce', async () => {
    await inCase(async () => {
      await asA()
      const own = await list({ p_search: 'BL-A-26-00042' })

      expect(ids(own), 'FUITE — le numéro du voisin est rendu aussi').toEqual([docs['d3']])

      await actAs(client, tokenFor(shops.b.tenant, 'worker'))
      const theirs = await list({ p_search: 'BL-A-26-00042' })
      expect(ids(theirs)).toEqual([neighbourDocs['nb1']])
    })
  })

  it('rend zéro ligne, et non une erreur, pour le détail d’un document du voisin', async () => {
    await inCase(async () => {
      await asA('owner')

      const detail = await list({ p_document_id: neighbourDocs['nb1'] })

      expect(detail, 'FUITE — le détail d’un document du voisin est lisible').toEqual([])
    })
  })

  it('ne rend rien non plus pour l’appareil du voisin', async () => {
    await inCase(async () => {
      await asA()

      expect(await list({ p_device_id: shops.b.deviceA })).toEqual([])
    })
  })
})

/* ========================================================================== */
/* L'ordre, les brouillons, la page                                            */
/* ========================================================================== */

describe('list_sale_documents — ordre et page', () => {
  it('trie du plus récent au plus ancien, sur la date d’émission ou de création', async () => {
    await inCase(async () => {
      await asA()

      const rows = await list()

      // d6 est un brouillon : sa date de création le place entre d7 et d5.
      expect(ids(rows)).toEqual([
        docs['d7'],
        docs['d6'],
        docs['d5'],
        docs['d4'],
        docs['d3'],
        docs['d2'],
        docs['d8'],
        docs['d1'],
      ])
    })
  })

  it('garde un brouillon atteignable : il n’a pas d’issued_at, il a un created_at', async () => {
    await inCase(async () => {
      await asA()

      const rows = await list({ p_status: 'draft' })

      expect(ids(rows)).toEqual([docs['d6']])
      expect(rows[0]!.doc_number).toBeNull()
      expect(rows[0]!.issued_at).toBeNull()
      expect(rows[0]!.sort_at).not.toBeNull()
    })
  })

  it('borne la page, et ne descend jamais sous une ligne', async () => {
    await inCase(async () => {
      await asA()

      expect(await list({ p_limit: 2 })).toHaveLength(2)
      expect(ids(await list({ p_limit: 2 }))).toEqual([docs['d7'], docs['d6']])
      expect(await list({ p_limit: 0 })).toHaveLength(1)
      expect(await list({ p_limit: -5 })).toHaveLength(1)
    })
  })
})

/* ========================================================================== */
/* Les filtres                                                                 */
/* ========================================================================== */

describe('list_sale_documents — chaque filtre', () => {
  it('filtre par statut', async () => {
    await inCase(async () => {
      await asA()

      expect(ids(await list({ p_status: 'cancelled' }))).toEqual([docs['d5']])
      expect(ids(await list({ p_status: 'delivered' }))).toEqual([docs['d4']])
      expect(ids(await list({ p_status: 'confirmed' }))).toEqual([
        docs['d7'],
        docs['d3'],
        docs['d2'],
        docs['d8'],
        docs['d1'],
      ])
    })
  })

  it('garde un document annulé dans la liste, avec son motif', async () => {
    await inCase(async () => {
      await asA()

      const row = (await list()).find((r) => r.id === docs['d5'])

      expect(row?.status).toBe('cancelled')
      expect(row?.cancellation_reason).toBe('client absent')
    })
  })

  it('filtre par type', async () => {
    await inCase(async () => {
      await asA()

      expect(ids(await list({ p_doc_type: 'quote' }))).toEqual([docs['d8'], docs['d1']])
      expect(ids(await list({ p_doc_type: 'order' }))).toEqual([docs['d2']])
      expect(await list({ p_doc_type: 'return' })).toEqual([])
    })
  })

  it('filtre par appareil', async () => {
    await inCase(async () => {
      await asA()

      expect(ids(await list({ p_device_id: shops.a.deviceB }))).toEqual([docs['d7'], docs['d4']])
    })
  })

  /*
   * Une journée de commerce se lit à Casablanca (SPEC § 4). d7 est émis le 7 à
   * 23 h 30 UTC, donc le **8** à 00 h 30 pour le comptoir : le filtre « le 7 » ne
   * doit pas le rendre, le filtre « le 8 » doit. Borne haute exclusive.
   */
  it('filtre par jour, aux bornes de Casablanca', async () => {
    await inCase(async () => {
      await asA()

      const dayOf = (day: string, next: string) => ({
        p_from: `${day}T00:00:00+01:00`,
        p_to: `${next}T00:00:00+01:00`,
      })

      expect(ids(await list(dayOf('2026-10-07', '2026-10-08')))).toEqual([])
      expect(ids(await list(dayOf('2026-10-08', '2026-10-09')))).toEqual([docs['d7']])
      // Un jour entier, deux documents le même jour (d8 et d1 le 1er).
      expect(ids(await list(dayOf('2026-10-01', '2026-10-02')))).toEqual([docs['d8'], docs['d1']])
    })
  })

  it('range un brouillon à sa date de création dans le filtre de jour', async () => {
    await inCase(async () => {
      await asA()

      const rows = await list({
        p_from: '2026-10-06T00:00:00+01:00',
        p_to: '2026-10-07T00:00:00+01:00',
      })

      expect(ids(rows)).toEqual([docs['d6']])
    })
  })

  it('compose les filtres', async () => {
    await inCase(async () => {
      await asA()

      const rows = await list({ p_doc_type: 'delivery_note', p_status: 'confirmed' })

      expect(ids(rows)).toEqual([docs['d7'], docs['d3']])
    })
  })
})

/* ========================================================================== */
/* La recherche par numéro — trois formes                                      */
/* ========================================================================== */

describe('list_sale_documents — recherche par numéro', () => {
  /* 1. Le numéro entier : normalisé, égalité. */
  it('trouve un numéro entier, quelle que soit la casse et les espaces de bord', async () => {
    await inCase(async () => {
      await asA()

      expect(numbers(await list({ p_search: 'BL-A-26-00042' }))).toEqual(['BL-A-26-00042'])
      expect(numbers(await list({ p_search: '  bl-a-26-00042  ' }))).toEqual(['BL-A-26-00042'])
      // Le même numéro d'un autre appareil n'est pas rendu : c'est une égalité.
      expect(numbers(await list({ p_search: 'BL-B-26-00042' }))).toEqual(['BL-B-26-00042'])
    })
  })

  /* 2. Les chiffres seuls : la séquence, tous types et tous appareils. */
  it('trouve par la séquence, tous types et tous appareils', async () => {
    await inCase(async () => {
      await asA()

      const expected = ['BL-B-26-00042', 'BL-A-26-00042', 'DV-A-26-00042']
      expect(numbers(await list({ p_search: '42' }))).toEqual(expected)
      // Avec ses zéros : la même séquence.
      expect(numbers(await list({ p_search: '00042' }))).toEqual(expected)
      // Six chiffres dont un zéro de tête : la même séquence aussi.
      expect(numbers(await list({ p_search: '000042' }))).toEqual(expected)
    })
  })

  /*
   * Les chiffres ne sont **pas** une sous-chaîne : « 4 » est la séquence 00004,
   * qui n'existe pas — il ne trouve pas 42, 43 ni 100. Un « like » sur les
   * chiffres les rendrait tous, et le commerçant lirait la mauvaise ligne.
   */
  it('ne prend pas des chiffres pour une sous-chaîne', async () => {
    await inCase(async () => {
      await asA()

      expect(await list({ p_search: '4' })).toEqual([])
      expect(numbers(await list({ p_search: '1' }))).toEqual(['DV-A-26-00001'])
      expect(numbers(await list({ p_search: '100' }))).toEqual(['BL-B-26-00100'])
    })
  })

  it('ne trouve rien au-delà de cinq chiffres significatifs, sans tronquer', async () => {
    await inCase(async () => {
      await asA()

      // `lpad` tronquerait « 1000042 » en « 10000 » : aucune séquence n'y répond.
      expect(await list({ p_search: '1000042' })).toEqual([])
    })
  })

  /* 3. Un autre fragment : sous-chaîne, sans métacaractère. */
  it('trouve un fragment, sans tenir compte de la casse', async () => {
    await inCase(async () => {
      await asA()

      expect(numbers(await list({ p_search: 'BL-B' }))).toEqual(['BL-B-26-00100', 'BL-B-26-00042'])
      expect(numbers(await list({ p_search: 'dv' }))).toEqual(['DV-A-26-00042', 'DV-A-26-00001'])
      expect(await list({ p_search: '-26-' })).toHaveLength(7)
    })
  })

  it('ne donne aucun sens à % ni à _ : strpos, pas like', async () => {
    await inCase(async () => {
      await asA()

      expect(await list({ p_search: '%' })).toEqual([])
      expect(await list({ p_search: '_' })).toEqual([])
    })
  })

  it('ne trouve jamais un brouillon par un numéro : il n’en a pas', async () => {
    await inCase(async () => {
      await asA()

      const everything = await list({ p_search: '-' })

      expect(ids(everything)).not.toContain(docs['d6'])
      expect(everything).toHaveLength(7)
    })
  })

  it('compose la recherche avec les autres filtres', async () => {
    await inCase(async () => {
      await asA()

      expect(numbers(await list({ p_search: '42', p_doc_type: 'delivery_note' }))).toEqual([
        'BL-B-26-00042',
        'BL-A-26-00042',
      ])
      expect(numbers(await list({ p_search: '42', p_device_id: shops.a.deviceB }))).toEqual([
        'BL-B-26-00042',
      ])
    })
  })

  it('traite une recherche vide ou blanche comme une absence de recherche', async () => {
    await inCase(async () => {
      await asA()

      expect(await list({ p_search: '' })).toHaveLength(8)
      expect(await list({ p_search: '   ' })).toHaveLength(8)
    })
  })
})

/* ========================================================================== */
/* L'auteur, l'appareil et le détail — rendus à un employé                     */
/* ========================================================================== */

describe('list_sale_documents — l’auteur et l’appareil', () => {
  /*
   * La raison d'être de la fonction : `app_user` et `device` sont fermés à
   * l'employé (policies restrictives, E1-02 et E1-03), et le critère demande
   * l'auteur et l'appareil.
   */
  it('rend à un employé le nom de l’auteur et l’appareil', async () => {
    await inCase(async () => {
      await asA('worker')

      const [row] = await list({ p_document_id: docs['d3'] })

      expect(row?.author_name).toBe('Patron de Documents A')
      expect(row?.device_label).toBe('Comptoir Documents A')
      expect(row?.device_prefix).toBe('A')
    })
  })

  it('et le même employé ne lit ni app_user ni device directement', async () => {
    await inCase(async () => {
      await asA('worker')

      const users = await client.query('select full_name from public.app_user')
      const devices = await client.query('select label from public.device')

      expect(users.rows, 'FUITE — un employé lit le registre des employés').toHaveLength(0)
      expect(devices.rows, 'FUITE — un employé lit le registre des appareils').toHaveLength(0)
    })
  })

  it('rend le détail d’un document : totaux, notes et statut', async () => {
    await inCase(async () => {
      await asA('worker')

      const detail = await list({ p_document_id: docs['d3'] })

      expect(detail).toHaveLength(1)
      expect(detail[0]).toMatchObject({
        doc_number: 'BL-A-26-00042',
        status: 'confirmed',
        subtotal: '240.00',
        discount_total: '0.00',
        total: '240.00',
        notes: 'Livraison chantier',
      })
    })
  })

  it('rend un auteur nul plutôt que de perdre le document', async () => {
    await inCase(async () => {
      await client.query('reset role')
      // La clé vers `app_user` est composite : on détache l'auteur en `postgres`.
      await client.query('set session_replication_role = replica')
      await client.query('update public.sale_document set created_by = null where id = $1', [
        docs['d3'],
      ])
      await client.query('set session_replication_role = origin')
      await asA('worker')

      const [row] = await list({ p_document_id: docs['d3'] })

      expect(row?.doc_number).toBe('BL-A-26-00042')
      expect(row?.author_name).toBeNull()
    })
  })
})

/* ========================================================================== */
/* Les plans                                                                   */
/* ========================================================================== */

/*
 * 40 000 documents sur quatre commerces, le jeton d'un employé, une session
 * chaude (huit préchauffages, `stock-plan.ts`), plusieurs passages — un plan qui
 * ne tient qu'au premier passage ne prouve rien (CLAUDE.md, E2-04).
 *
 * **Quatre plans** :
 *
 *   1. la liste, par la fonction ;
 *   2. le détail — l'en-tête par la fonction, **et** les lignes lues sous RLS ;
 *   3. les deux lectures de `documentLineage()`, sous RLS ;
 *   4. la liste telle qu'un `select` PostgREST direct l'émettrait, qui **doit**
 *      être en parcours séquentiel : sans quoi l'exception § 2.1 ne se justifie
 *      pas, et il faut la retirer.
 *
 * **Décision en attente, écrite avant d'avoir mesuré** : si les lignes ou la
 * filiation sortent en Seq Scan, le correctif prévu est un index sur la colonne
 * de l'égalité (`sale_line (sale_document_id)`, `sale_document (source_document_id)`)
 * — **pas une seconde fonction `security definer`**. Il n'est posé nulle part ici ;
 * les messages d'échec le disent. Voir docs/PENDING-CHECKS.md, « E4-07 ».
 *
 * La mesure n'a pas pu être prise (session sans Docker). Les seuils ci-dessous
 * sont des **attentes**, pas des résultats.
 */
describe('list_sale_documents — les plans', () => {
  const PER_SHOP = 10_000
  const RUNS = 3
  const MARKER = 'left join public.device'

  const planShops: Shop[] = []
  /** Un document « du milieu » du premier commerce, lignes et enfants compris. */
  let target = ''
  let targetNumber = ''

  beforeAll(async () => {
    await client.query('reset role')

    for (let n = 1; n <= 4; n += 1) {
      planShops.push(await makeShop(`Plan ${n}`))
    }

    // Triggers suspendus pour le lest : ce sont des lignes pour le planificateur,
    // pas des documents dont on lit le résultat (même parti que E3-02).
    await client.query('set session_replication_role = replica')
    for (const shop of planShops) {
      await client.query(
        `insert into public.sale_document
           (tenant_id, doc_type, doc_number, warehouse_id, device_id, created_by, status,
            subtotal, discount_total, total, issued_at, created_at, cancellation_reason)
         select $1::uuid, s.doc_type::public.sale_doc_type,
                case when s.draft then null
                     else s.code || '-' || s.letter || '-26-' || lpad(s.n::text, 5, '0') end,
                $2::uuid,
                case when s.letter = 'A' then $3::uuid else $4::uuid end,
                $5::uuid,
                (case when s.draft then 'draft'
                      when s.cancelled then 'cancelled'
                      when s.n % 7 = 0 then 'delivered'
                      else 'confirmed' end)::public.sale_doc_status,
                240, 0, 240,
                case when s.draft then null else s.at end,
                s.at,
                case when s.cancelled then 'erreur de saisie' end
         from (
           select n,
                  (array['quote','order','delivery_note','delivery_note','delivery_note'])[1 + n % 5] as doc_type,
                  (array['DV','CM','BL','BL','BL'])[1 + n % 5] as code,
                  case when n % 2 = 0 then 'A' else 'B' end as letter,
                  n % 100 = 0 as draft,
                  n % 50 = 0 and n % 100 <> 0 as cancelled,
                  timestamptz '2026-01-01 08:00+00' + (n * interval '50 minutes') as at
           from generate_series(1, $6::int) n
         ) s`,
        [shop.tenant, shop.warehouse, shop.deviceA, shop.deviceB, shop.owner, PER_SHOP],
      )
      // Deux lignes par document, sur deux variantes.
      await client.query(
        `insert into public.sale_line (tenant_id, sale_document_id, variant_id, quantity, unit_price)
         select d.tenant_id, d.id, v.variant, 24, 9.50
         from public.sale_document d
         cross join (values ($2::uuid), ($3::uuid)) v(variant)
         where d.tenant_id = $1`,
        [shop.tenant, shop.variants[0], shop.variants[1]],
      )
    }

    const first = planShops[0]!
    const row = await one<{ id: string; doc_number: string }>(
      `select id, doc_number from public.sale_document
       where tenant_id = $1 and doc_number = 'BL-A-26-04242'`,
      [first.tenant],
    )
    target = row.id
    targetNumber = row.doc_number

    // Deux enfants, comme une commande livrée en deux camions (RÈGLE M3-4) : peu
    // de lignes filiées, comme en production — l'index partiel n'en porte que
    // quelques-unes.
    await client.query(
      `update public.sale_document set source_document_id = $2
       where tenant_id = $1 and doc_number in ('BL-B-26-04243', 'BL-A-26-04244')`,
      [first.tenant, target],
    )
    await client.query('set session_replication_role = origin')

    await client.query('analyze public.sale_document')
    await client.query('analyze public.sale_line')
  }, 600_000)

  const worker = () => tokenFor(planShops[0]!.tenant, 'worker')

  /** Le même plan lu `RUNS` fois : une borderline qui flotte se voit au troisième. */
  async function plans(sql: string, marker: string) {
    const runs = []
    for (let run = 0; run < RUNS; run += 1) {
      runs.push(await planOfStatement(client, worker(), sql, marker))
    }
    return runs
  }

  it('sait où il en est : quatre commerces, 40 000 documents, 80 000 lignes', async () => {
    await client.query('reset role')
    const count = await one<{ documents: string; lines: string }>(
      `select (select count(*) from public.sale_document where tenant_id = any($1))::text as documents,
              (select count(*) from public.sale_line where tenant_id = any($1))::text as lines`,
      [planShops.map((shop) => shop.tenant)],
    )

    expect(count.documents).toBe(String(4 * PER_SHOP))
    expect(count.lines).toBe(String(8 * PER_SHOP))
  })

  it('porte l’index du tri sur la même expression que la fonction', async () => {
    await client.query('reset role')
    const index = await one<{ definition: string }>(
      "select pg_get_indexdef('public.sale_document_tenant_recent'::regclass) as definition",
    )

    expect(index.definition).toContain('tenant_id')
    expect(index.definition).toContain('COALESCE(issued_at, created_at) DESC')
  })

  /* 1. La liste, par la fonction. */
  it('liste les plus récents par l’index du tri, sans parcours séquentiel', async () => {
    for (const nodes of await plans('select * from public.list_sale_documents()', MARKER)) {
      expect(
        seqScansOf(nodes, 'sale_document').length,
        'parcours séquentiel de sale_document — tous les commerces sont lus',
      ).toBe(0)
      expect(indexesUsed(nodes)).toContain('sale_document_tenant_recent')
    }
  })

  it('cherche un numéro entier par l’index unique du commerce', async () => {
    const sql = `select * from public.list_sale_documents(p_search => '${targetNumber}')`
    for (const nodes of await plans(sql, MARKER)) {
      expect(seqScansOf(nodes, 'sale_document').length).toBe(0)
      expect(indexesUsed(nodes)).toContain('sale_document_number_per_tenant')
    }
  })

  it('cherche des chiffres sans lire les autres commerces', async () => {
    const sql = "select * from public.list_sale_documents(p_search => '4242')"
    for (const nodes of await plans(sql, MARKER)) {
      // Pas d'index sur `right(doc_number, 5)` : le commerce borne la lecture, et
      // c'est tout ce qui est demandé ici. Un Seq Scan lirait les quatre.
      expect(
        seqScansOf(nodes, 'sale_document').length,
        'parcours séquentiel de sale_document — tous les commerces sont lus',
      ).toBe(0)
    }
  })

  it('cherche un fragment sans lire les autres commerces', async () => {
    const sql = "select * from public.list_sale_documents(p_search => 'BL-B')"
    for (const nodes of await plans(sql, MARKER)) {
      expect(seqScansOf(nodes, 'sale_document').length).toBe(0)
    }
  })

  /* 2. Le détail — l'en-tête par la fonction, les lignes sous RLS. */
  /*
   * Mesuré le 2026-10-20 : le planificateur sert cette lecture par
   * `sale_document_pkey`, pas par `sale_document_tenant_id_id_key` — `id` est
   * unique à lui seul, l'égalité sur `tenant_id` ne restant qu'un filtre. Les
   * deux index sont équivalents ici, et la propriété mesurée est celle qui
   * compte : un seul document est touché, pas les 40 000 des quatre commerces.
   */
  it('lit l’en-tête d’un document par un index unique, sans parcours séquentiel', async () => {
    const sql = `select * from public.list_sale_documents(p_document_id => '${target}'::uuid)`
    for (const nodes of await plans(sql, MARKER)) {
      expect(seqScansOf(nodes, 'sale_document').length).toBe(0)
      expect(indexesUsed(nodes)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^sale_document_(pkey|tenant_id_id_key)$/),
        ]),
      )
    }
  })

  it('lit les lignes d’un document sous RLS par leur index, sans parcours séquentiel', async () => {
    const sql =
      'select id, quantity::text, unit_price::text, line_total::text from public.sale_line' +
      ` where sale_document_id = '${target}' order by created_at, id`
    for (const nodes of await plans(sql, 'from public.sale_line')) {
      expect(
        seqScansOf(nodes, 'sale_line').length,
        'DÉCISION EN ATTENTE (docs/PENDING-CHECKS.md, E4-07) — les lignes sortent en parcours ' +
          'séquentiel sous RLS : le correctif prévu est un index sur sale_line (sale_document_id), ' +
          'pas une seconde fonction security definer. Non posé.',
      ).toBe(0)
    }
  })

  /* 3. La filiation, deux lectures. */
  it('lit le parent d’un document sous RLS, sans parcours séquentiel', async () => {
    const sql = `select source_document_id from public.sale_document where id = '${target}'`
    for (const nodes of await plans(sql, 'from public.sale_document')) {
      expect(
        seqScansOf(nodes, 'sale_document').length,
        'DÉCISION EN ATTENTE (docs/PENDING-CHECKS.md, E4-07) — la lecture du parent sort en ' +
          'parcours séquentiel : index sur la colonne de l’égalité, pas une seconde fonction.',
      ).toBe(0)
    }
  })

  it('lit les enfants d’un document sous RLS, sans parcours séquentiel', async () => {
    const sql =
      'select id, doc_type, doc_number, status from public.sale_document' +
      ` where source_document_id = '${target}' order by created_at asc`
    for (const nodes of await plans(sql, 'where source_document_id')) {
      expect(
        seqScansOf(nodes, 'sale_document').length,
        'DÉCISION EN ATTENTE (docs/PENDING-CHECKS.md, E4-07) — la lecture des enfants sort en ' +
          'parcours séquentiel : l’index partiel sale_document_source commence par tenant_id, que ' +
          'la policy OR merx.is_super_admin() ne laisse pas servir de condition. Le correctif prévu ' +
          'est un index sur (source_document_id), pas une seconde fonction.',
      ).toBe(0)
    }
  })

  /* 4. La preuve que l'exception se justifie. */
  it('la liste directe, telle que PostgREST l’émet, parcourt la table : l’exception se justifie', async () => {
    const direct =
      'select id, doc_type, doc_number, status, total, issued_at, created_at' +
      ' from public.sale_document order by issued_at desc nulls last, created_at desc limit 101'
    for (const nodes of await plans(direct, 'from public.sale_document')) {
      expect(
        seqScansOf(nodes, 'sale_document').length,
        'la lecture directe n’est plus en parcours séquentiel : list_sale_documents() ne se ' +
          'justifie plus par le plan (SPEC § 2.1) — à retirer du registre, ou à rejustifier',
      ).toBeGreaterThan(0)
    }
  }, 300_000)

  /*
   * Mesuré le 2026-10-20, et contraire à ce que cette story attendait :
   * l'égalité sur `doc_number` **sert** `sale_document_number_per_tenant` sous
   * RLS, en Index Scan sur les trois passages. `texteq` est leakproof — c'est
   * l'égalité sur une colonne stockée de CLAUDE.md —, donc la policy ne
   * l'empêche pas de servir de condition d'index, et le `OR
   * merx.is_super_admin()` ne reste qu'un filtre sur l'unique ligne touchée.
   *
   * Le plan ne justifie donc l'exception que pour **la liste** (le cas
   * ci-dessus, en Seq Scan), jamais pour cette forme-là. Ce qui tient ici est
   * l'inverse de ce qui était écrit, et vaut d'être gardé : la recherche d'un
   * numéro entier est bornée à une ligne, dans la fonction comme hors d'elle.
   */
  it('la recherche directe d’un numéro, elle, sert son index : le plan ne justifie l’exception que pour la liste', async () => {
    const direct =
      `select id from public.sale_document where doc_number = '${targetNumber}'`
    for (const nodes of await plans(direct, 'where doc_number')) {
      expect(seqScansOf(nodes, 'sale_document').length).toBe(0)
      expect(indexesUsed(nodes)).toContain('sale_document_number_per_tenant')
    }
  }, 300_000)

  /* Le plafond de la page, qu'aucun petit peuplement ne peut mesurer. */
  it('plafonne la page à 500, quoi qu’on demande', async () => {
    await client.query('reset role')
    await actAs(client, worker())

    const asked = await client.query('select id from public.list_sale_documents(p_limit => 100000)')

    expect(asked.rows).toHaveLength(500)
  })
})
