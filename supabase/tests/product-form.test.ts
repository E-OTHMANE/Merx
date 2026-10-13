// @vitest-environment node

/*
 * E2-02 — créer et modifier un produit, côté base. SPEC § 2.1, § 2.6, § 3.1,
 * § 6 M1.
 *
 * Ce que l'écran suppose de la base, et que l'écran ne peut pas vérifier :
 *
 *   — `tenant_id` vient du jeton : un POST sans lui aboutit, un POST avec le
 *     commerce du voisin est refusé ;
 *   — le nom suffit, par le chemin réel ;
 *   — le SKU de la variante par défaut suit la référence ;
 *   — un produit supprimé quitte la liste mais reste lisible par son
 *     identifiant — l'historique le retrouvera ;
 *   — les photos : compartiment privé, deux gardes, un test chacun.
 *
 * Chaque refus assert son code et l'absence de l'effet ; chaque refus a son
 * contrôle positif à côté.
 *
 * Ce qui n'est pas ici, parce qu'un balayage le tient déjà pour toute table :
 * « seul le nom est obligatoire » et « tenant_id par défaut du jeton » en tant
 * que propriétés du schéma (`conventions.test.ts`), l'écriture réservée à
 * `manage_product` (`settings.test.ts`), l'isolation des lignes
 * (`isolation.test.ts`).
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { INSUFFICIENT_PRIVILEGE, actAs, attempt, tokenFor } from './isolation'
import {
  ANON_KEY,
  API_URL,
  adminFetch,
  createAuthUser,
  deleteAuthUser,
  rest,
  sessionFor,
} from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'mot-de-passe-de-test-0000'
const BUCKET = 'product-photo'

const NOT_NULL_VIOLATION = '23502'

let client: Client

type Account = 'ownerA' | 'workerA' | 'ownerB'

const fixture = {
  a: { tenant: '', product: '' },
  b: { tenant: '', product: '' },
}
const authUsers = {} as Record<Account, string>
const tokens = {} as Record<Account, string>
const emails = {} as Record<Account, string>

/** Objets déposés par les tests, retirés à la fin quoi qu'il arrive. */
const uploaded = new Set<string>()

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client.query(sql, params)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0] as T
}

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

  for (const account of ['ownerA', 'workerA', 'ownerB'] as const) {
    emails[account] = `${account}-${crypto.randomUUID()}@merx.test`.toLowerCase()
    authUsers[account] = await createAuthUser(emails[account], PASSWORD)
  }

  for (const side of ['a', 'b'] as const) {
    fixture[side].tenant = (
      await one<{ id: string }>(
        "insert into public.tenant (business_name, tenant_id) values ($1, gen_random_uuid()) returning id",
        [`Fiche produit ${side.toUpperCase()}`],
      )
    ).id
    fixture[side].product = (
      await one<{ id: string }>(
        `insert into public.product (tenant_id, name_fr, code) values ($1, 'Eau de toilette', $2)
         returning id`,
        [fixture[side].tenant, `${side.toUpperCase()}-REF`],
      )
    ).id
  }

  const members: Array<[Account, 'a' | 'b', 'owner' | 'worker']> = [
    ['ownerA', 'a', 'owner'],
    ['workerA', 'a', 'worker'],
    ['ownerB', 'b', 'owner'],
  ]
  for (const [account, side, role] of members) {
    await client.query(
      `insert into public.app_user (tenant_id, auth_user_id, full_name, role)
       values ($1, $2, $3, $4)`,
      [fixture[side].tenant, authUsers[account], account, role],
    )
  }

  for (const account of ['ownerA', 'workerA', 'ownerB'] as const) {
    tokens[account] = (await sessionFor(emails[account], PASSWORD)).accessToken
  }
}, 60_000)

afterAll(async () => {
  if (uploaded.size > 0) {
    await adminFetch(`/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      body: JSON.stringify({ prefixes: [...uploaded] }),
    })
  }
  if (client !== undefined) {
    await client.query('reset role')
    for (const side of ['a', 'b'] as const) {
      const tenant = fixture[side].tenant
      if (tenant === '') continue
      await client.query('delete from public.product where tenant_id = $1', [tenant])
      await client.query('delete from public.app_user where tenant_id = $1', [tenant])
      // Le dépôt avant le commerce : `warehouse_tenant_id_fkey` ne cascade pas.
      await client.query('delete from public.warehouse where tenant_id = $1', [tenant])
      await client.query('delete from public.tenant where id = $1', [tenant])
    }
  }
  for (const account of ['ownerA', 'workerA', 'ownerB'] as const) {
    if (authUsers[account] !== undefined) await deleteAuthUser(authUsers[account])
  }
  await client?.end()
}, 60_000)

/** Sous le jeton d'un rôle, dans une transaction annulée. */
async function as(side: 'a' | 'b', role: 'owner' | 'worker', body: () => Promise<void>) {
  await client.query('begin')
  try {
    await actAs(client, tokenFor(fixture[side].tenant, role))
    await body()
  } finally {
    await client.query('rollback')
  }
}

async function skuOf(variant: string): Promise<string | null> {
  return (await one<{ sku: string | null }>('select sku from public.variant where id = $1', [variant]))
    .sku
}

/* ========================================================================== */
/* tenant_id                                                                   */
/* ========================================================================== */

describe('tenant_id vient du jeton', () => {
  it('un POST sans tenant_id crée le produit dans le commerce du jeton, avec sa variante', async () => {
    const created = await rest('product', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name_fr: 'Savon au lait d’ânesse' },
    })

    expect(created.status, created.body).toBe(201)
    const row = created.rows[0] as { id: string; tenant_id: string }
    expect(row.tenant_id).toBe(fixture.a.tenant)

    const variants = await rest(`variant?product_id=eq.${row.id}&select=id,is_default`, {
      token: tokens.ownerA,
    })
    expect(variants.rows).toEqual([{ id: row.id, is_default: true }])
  })

  it('un tenant_id étranger envoyé explicitement reste refusé — le défaut n’ouvre rien', async () => {
    const name = `Chez le voisin ${crypto.randomUUID()}`
    const refused = await rest('product', {
      token: tokens.ownerA,
      method: 'POST',
      body: { tenant_id: fixture.b.tenant, name_fr: name },
    })

    expect(refused.ok).toBe(false)
    expect(refused.code).toBe(INSUFFICIENT_PRIVILEGE)
    const { rows } = await client.query('select 1 from public.product where name_fr = $1', [name])
    expect(rows, 'la ligne refusée existe quand même').toHaveLength(0)

    // Contrôle positif : son propre commerce, envoyé explicitement, passe —
    // c'est ce que fera la synchronisation (E9), qui renvoie la ligne entière.
    const own = await rest('product', {
      token: tokens.ownerA,
      method: 'POST',
      body: { tenant_id: fixture.a.tenant, name_fr: name },
    })
    expect(own.status, own.body).toBe(201)
  })
})

/* ========================================================================== */
/* SPEC § 2.6 — le nom suffit                                                  */
/* ========================================================================== */

describe('SPEC § 2.6 — le nom suffit, et il est le seul exigé', () => {
  it('product est inscrit au registre des formulaires, avec name_fr pour nom', async () => {
    // Sans cette ligne, la règle de conventions ne regarderait pas `product`.
    const { rows } = await client.query(
      "select name_column from merx.creation_form_registry where table_name = 'product'",
    )
    expect(rows).toEqual([{ name_column: 'name_fr' }])
  })

  it('sans nom, la base refuse — sur name_fr, et sur rien d’autre', async () => {
    const refused = await rest('product', {
      token: tokens.ownerA,
      method: 'POST',
      body: { code: `SANS-NOM-${crypto.randomUUID()}` },
    })

    expect(refused.ok).toBe(false)
    expect(refused.code).toBe(NOT_NULL_VIOLATION)
    expect((JSON.parse(refused.body) as { message: string }).message).toContain('"name_fr"')

    // Contrôle positif : le même envoi, avec un nom et rien d'autre.
    const created = await rest('product', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name_fr: 'Nom seul' },
    })
    expect(created.status, created.body).toBe(201)
  })
})

/* ========================================================================== */
/* Le SKU suit la référence                                                    */
/* ========================================================================== */

describe('le SKU de la variante par défaut suit la référence', () => {
  it('par le chemin réel : la référence corrigée, le SKU suit', async () => {
    const created = await rest('product', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name_fr: 'Lait corporel', code: `LC-${crypto.randomUUID()}` },
    })
    const product = created.rows[0]!.id!
    const next = `LC2-${crypto.randomUUID()}`

    const patched = await rest(`product?id=eq.${product}`, {
      token: tokens.ownerA,
      method: 'PATCH',
      body: { code: next },
    })
    expect(patched.status, patched.body).toBe(200)

    expect(await skuOf(product)).toBe(next)
  })

  it('libère l’ancienne référence : un nouveau produit peut la prendre', async () => {
    await as('a', 'owner', async () => {
      const first = (
        await one<{ id: string }>(
          "insert into public.product (name_fr, code) values ('Premier', 'REF-A') returning id",
        )
      ).id
      await client.query("update public.product set code = 'REF-B' where id = $1", [first])

      // Sans le trigger, le SKU de la première variante vaudrait encore REF-A,
      // et `variant_sku_per_tenant` refuserait ici.
      const second = await attempt(
        client,
        "insert into public.product (name_fr, code) values ('Second', 'REF-A')",
      )
      expect(second.ok, second.ok ? '' : `${second.code} ${second.message}`).toBe(true)
      expect(await skuOf(first)).toBe('REF-B')
    })
  })

  it('une référence ajoutée après coup devient le SKU ; effacée, elle le vide', async () => {
    await as('a', 'owner', async () => {
      const product = (
        await one<{ id: string }>("insert into public.product (name_fr) values ('Sans ref') returning id")
      ).id
      expect(await skuOf(product)).toBeNull()

      await client.query("update public.product set code = 'AJOUT-1' where id = $1", [product])
      expect(await skuOf(product)).toBe('AJOUT-1')

      await client.query("update public.product set code = '  ' where id = $1", [product])
      expect(await skuOf(product)).toBeNull()
    })
  })

  it('un SKU qui a divergé de la référence ne bouge pas', async () => {
    await as('a', 'owner', async () => {
      const product = (
        await one<{ id: string }>(
          "insert into public.product (name_fr, code) values ('Divergent', 'DIV-1') returning id",
        )
      ).id
      await client.query("update public.variant set sku = 'ETIQ-1' where id = $1", [product])
      await client.query("update public.product set code = 'DIV-2' where id = $1", [product])

      expect(await skuOf(product)).toBe('ETIQ-1')
    })
  })

  it('seule la variante par défaut suit', async () => {
    await as('a', 'owner', async () => {
      const product = (
        await one<{ id: string }>("insert into public.product (name_fr) values ('Deux') returning id")
      ).id
      // Une variante ordinaire, sans SKU comme la variante par défaut : les deux
      // valent l'ancienne référence (NULL). Seule la seconde doit suivre.
      const other = (
        await one<{ id: string }>(
          'insert into public.variant (product_id) values ($1) returning id',
          [product],
        )
      ).id
      await client.query("update public.product set code = 'DEUX-1' where id = $1", [product])

      expect(await skuOf(product)).toBe('DEUX-1')
      expect(await skuOf(other)).toBeNull()
    })
  })
})

/* ========================================================================== */
/* Suppression douce                                                           */
/* ========================================================================== */

describe('un produit supprimé quitte la liste et reste dans l’historique', () => {
  it('absent de la liste, lisible par son identifiant, variante comprise ; restauré, il revient', async () => {
    const created = await rest('product', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name_fr: 'À supprimer' },
    })
    const product = created.rows[0]!.id!
    const listed = async (): Promise<boolean> =>
      (await rest('product?deleted_at=is.null&select=id', { token: tokens.workerA })).rows.some(
        (row) => row.id === product,
      )

    expect(await listed(), 'contrôle positif : le produit est listé avant').toBe(true)

    const deleted = await rest(`product?id=eq.${product}`, {
      token: tokens.ownerA,
      method: 'PATCH',
      body: { deleted_at: new Date().toISOString() },
    })
    expect(deleted.rows).toHaveLength(1)

    expect(await listed()).toBe(false)
    // L'historique référencera le produit par son identifiant (E4) : il doit
    // rester lisible, variante comprise, par tout le commerce.
    const byId = await rest(`product?id=eq.${product}&select=id,name_fr`, { token: tokens.workerA })
    expect(byId.rows).toEqual([{ id: product, name_fr: 'À supprimer' }])
    const variant = await rest(`variant?id=eq.${product}&select=id`, { token: tokens.workerA })
    expect(variant.rows).toEqual([{ id: product }])

    await rest(`product?id=eq.${product}`, {
      token: tokens.ownerA,
      method: 'PATCH',
      body: { deleted_at: null },
    })
    expect(await listed()).toBe(true)
  })
})

/* ========================================================================== */
/* Photos                                                                      */
/* ========================================================================== */

interface StorageOutcome {
  status: number
  /** `statusCode` du corps de Storage — le code que l'on assert. */
  code: string | null
  body: string
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])

async function storage(
  path: string,
  init: RequestInit & { token: string },
): Promise<StorageOutcome> {
  const { token, headers, ...rest } = init
  const response = await fetch(`${API_URL}/storage/v1/${path}`, {
    ...rest,
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, ...headers },
  })
  const body = await response.text()
  let code: string | null = null
  try {
    const parsed = JSON.parse(body) as { statusCode?: unknown }
    if (parsed.statusCode !== undefined) code = String(parsed.statusCode)
  } catch {
    // Un téléchargement réussi rend l'image, pas du JSON.
  }
  return { status: response.status, code, body }
}

function upload(
  token: string,
  object: string,
  bytes: Uint8Array = JPEG,
  contentType = 'image/jpeg',
): Promise<StorageOutcome> {
  uploaded.add(object)
  return storage(`object/${BUCKET}/${object}`, {
    token,
    method: 'POST',
    headers: { 'Content-Type': contentType, 'x-upsert': 'false' },
    body: bytes,
  })
}

function download(token: string, object: string): Promise<StorageOutcome> {
  return storage(`object/authenticated/${BUCKET}/${object}`, { token })
}

function remove(token: string, object: string): Promise<StorageOutcome> {
  return storage(`object/${BUCKET}`, {
    token,
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [object] }),
  })
}

/** L'objet existe-t-il ? Demandé sous `service_role`, qui voit tout. */
async function exists(object: string): Promise<boolean> {
  const [folder, name] = object.split('/')
  const response = await adminFetch(`/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    body: JSON.stringify({ prefix: folder, search: name }),
  })
  const listed = (await response.json()) as Array<{ name: string }>
  return listed.some((entry) => entry.name === name)
}

const photoOf = (product: string): string => `${product}/${crypto.randomUUID()}.jpg`

/** Le refus d'une policy de `storage.objects`, tel que Storage le rend. */
const RLS_REFUSAL = '403'

describe('le compartiment des photos', () => {
  it('est privé, limité au JPEG et à 1 Mio', async () => {
    const response = await adminFetch(`/storage/v1/bucket/${BUCKET}`)
    const bucket = (await response.json()) as {
      public: boolean
      file_size_limit: number
      allowed_mime_types: string[]
    }

    expect(bucket.public).toBe(false)
    expect(bucket.file_size_limit).toBe(1048576)
    expect(bucket.allowed_mime_types).toEqual(['image/jpeg'])
  })

  it('refuse un autre format que le JPEG — sous son propre code', async () => {
    const png = photoOf(fixture.a.product).replace(/\.jpg$/, '.png')
    const refused = await upload(tokens.ownerA, png, JPEG, 'image/png')

    expect(refused.status, refused.body).not.toBe(200)
    expect(refused.code, refused.body).toBe('415')
    expect(await exists(png)).toBe(false)

    const accepted = photoOf(fixture.a.product)
    expect((await upload(tokens.ownerA, accepted)).status).toBe(200)
  })

  it('refuse un fichier de plus d’1 Mio — sous son propre code', async () => {
    const big = photoOf(fixture.a.product)
    const refused = await upload(tokens.ownerA, big, new Uint8Array(1_572_864))

    expect(refused.status, refused.body).not.toBe(200)
    expect(refused.code, refused.body).toBe('413')
    expect(await exists(big)).toBe(false)

    const small = photoOf(fixture.a.product)
    expect((await upload(tokens.ownerA, small, new Uint8Array(512_000))).status).toBe(200)
  })
})

/*
 * Deux gardes sur chaque écriture — le produit du dossier est visible, et
 * `merx.can('manage_product')` — et Storage rend le même refus pour les deux.
 * Chaque test est donc construit pour qu'un seul terme puisse refuser :
 *
 *   — l'employé de A, dans le dossier d'un produit de A : le produit est
 *     visible, seule la capacité manque ;
 *   — le patron de B, dans le dossier d'un produit de A : la capacité est là,
 *     seul le produit est invisible.
 *
 * Retirer un terme fait tomber son test, et le sien seulement — vérifié par
 * sabotage, terme par terme.
 */
describe('déposer une photo', () => {
  it('le patron dépose dans le dossier d’un produit de son commerce', async () => {
    const object = photoOf(fixture.a.product)
    const accepted = await upload(tokens.ownerA, object)

    expect(accepted.status, accepted.body).toBe(200)
    expect(await exists(object)).toBe(true)
  })

  it('garde de capacité — l’employé, produit visible, est refusé', async () => {
    const object = photoOf(fixture.a.product)
    const refused = await upload(tokens.workerA, object)

    expect(refused.status, refused.body).not.toBe(200)
    expect(refused.code, refused.body).toBe(RLS_REFUSAL)
    expect(await exists(object), 'FUITE — l’employé a déposé une photo').toBe(false)
  })

  it('garde d’isolation — le patron de B, capacité présente, est refusé dans le dossier de A', async () => {
    const object = photoOf(fixture.a.product)
    const refused = await upload(tokens.ownerB, object)

    expect(refused.status, refused.body).not.toBe(200)
    expect(refused.code, refused.body).toBe(RLS_REFUSAL)
    expect(await exists(object), 'FUITE — B a déposé chez A').toBe(false)

    // Contrôle positif : le même patron, dans le dossier de son propre produit.
    expect((await upload(tokens.ownerB, photoOf(fixture.b.product))).status).toBe(200)
  })

  it('un dossier qui ne nomme aucun produit est refusé', async () => {
    for (const object of [photoOf(crypto.randomUUID()), `pas-un-produit/${crypto.randomUUID()}.jpg`]) {
      const refused = await upload(tokens.ownerA, object)
      expect(refused.code, `${object} : ${refused.body}`).toBe(RLS_REFUSAL)
      expect(await exists(object)).toBe(false)
    }
  })
})

describe('lire une photo', () => {
  it('l’employé lit celles de son commerce ; le voisin, non', async () => {
    const object = photoOf(fixture.a.product)
    expect((await upload(tokens.ownerA, object)).status).toBe(200)

    const own = await download(tokens.workerA, object)
    expect(own.status, own.body).toBe(200)

    const foreign = await download(tokens.ownerB, object)
    expect(foreign.status, foreign.body).not.toBe(200)
    // Storage ne dit pas « interdit » pour un objet que la policy cache : il
    // dit qu'il n'existe pas. C'est ce qu'on veut — rien n'apprend au voisin
    // que la photo est là.
    expect(foreign.code, foreign.body).toBe('404')
  })
})

/*
 * DELETE refusé par une policy ne lève pas : Storage rend la liste des objets
 * effectivement retirés, vide. On assert donc la présence de l'objet après
 * coup, et le contrôle positif montre qu'il disparaît quand le droit est là.
 *
 * Le retrait n'a qu'un terme à lui, la capacité. L'isolation vient de la
 * policy de lecture : Postgres ne supprime que ce que SELECT laisse voir. Un
 * terme « produit visible » posé aussi sur DELETE ne pouvait jamais refuser
 * seul — retiré, aucun test ne bougeait — et il a été retiré de la migration.
 * Le test d'isolation ci-dessous tombe donc quand on retire le terme de
 * `product_photo_select`, et c'est ce qu'on veut qu'il mesure.
 */
describe('retirer une photo', () => {
  it('garde de capacité — l’employé ne retire rien', async () => {
    const object = photoOf(fixture.a.product)
    expect((await upload(tokens.ownerA, object)).status).toBe(200)

    await remove(tokens.workerA, object)
    expect(await exists(object), 'FUITE — l’employé a retiré une photo').toBe(true)

    await remove(tokens.ownerA, object)
    expect(await exists(object), 'contrôle positif : le patron la retire').toBe(false)
  })

  it('garde d’isolation — le patron de B ne retire rien chez A', async () => {
    const object = photoOf(fixture.a.product)
    expect((await upload(tokens.ownerA, object)).status).toBe(200)

    await remove(tokens.ownerB, object)
    expect(await exists(object), 'FUITE — B a retiré une photo de A').toBe(true)

    await remove(tokens.ownerA, object)
    expect(await exists(object)).toBe(false)
  })
})
