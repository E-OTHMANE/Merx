// @vitest-environment node

/*
 * E2-06 — les codes-barres. SPEC § 6 M1 (RÈGLE M1-5), § 2.6, § 3.1, § 4.
 *
 * Trois gardes, et chacun a son test à son niveau (CLAUDE.md : un test par
 * niveau, chacun contournant les autres) :
 *
 *   1. **`variant_barcode_per_tenant`** — un code-barres désigne une variante,
 *      par commerce. Le test asserte **le nom de la contrainte**, pas le seul
 *      `23505` : `variant_sku_per_tenant` refuserait le même code, et c'est
 *      arrivé trois fois depuis E1-01 (CLAUDE.md, règle des unicités) ;
 *   2. **le garde de `sku_printed_at`** — la date ne s'efface pas, et le SKU
 *      qu'elle protège ne se modifie plus. Deux refus `2F004` distincts, chacun
 *      avec sa phrase, pour qu'un test puisse dire lequel a refusé ;
 *   3. **`follow_product_code()`** — le SKU imprimé ne suit plus la référence.
 *      Avec son contrôle positif : celui qui n'est pas imprimé la suit toujours.
 *
 * Et la conséquence assumée de l'arbitrage : **une référence libérée reste tenue
 * par le SKU figé**, et c'est `variant_sku_per_tenant` qui refuse, pas
 * `product_code_per_tenant`. L'application en tire son message.
 *
 * Ce qui n'est pas ici, parce que les balayages le tiennent pour toute table :
 * l'isolation entre commerces (`isolation.test.ts`) et le droit d'écrire par
 * rôle (`settings.test.ts`). L'écran est éprouvé par
 * `src/modules/catalogue/barcodes.test.tsx`, qui ne touche pas la base.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { actAs, attempt, tokenFor } from './isolation'
import { createAuthUser, deleteAuthUser, rest, sessionFor } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'mot-de-passe-de-test-0000'

const UNIQUE_VIOLATION = '23505'
/** `modifying_sql_data_not_permitted` — le garde de l'ajout seul (E1-04). */
const FROZEN = '2F004'

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: CONNECTION_STRING })
  try {
    await client.connect()
  } catch (cause) {
    throw new Error(
      `Base locale injoignable sur ${CONNECTION_STRING}.\n` +
        'Démarrer le stack : npx supabase start && npx supabase db reset',
      { cause },
    )
  }
  return client
}

let client: Client

const fixture = {
  a: { tenant: '', owner: '' },
  b: { tenant: '', owner: '' },
}
const authUsers = {} as Record<'owner' | 'worker', string>
const tokens = {} as Record<'owner' | 'worker', string>
const emails = {
  owner: `owner-${crypto.randomUUID()}@merx.test`,
  worker: `worker-${crypto.randomUUID()}@merx.test`,
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client.query(sql, params)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0] as T
}

async function seedTenant(side: 'a' | 'b'): Promise<void> {
  const target = fixture[side]
  target.tenant = (
    await one<{ id: string }>(
      'insert into public.tenant (business_name, tenant_id) values ($1, gen_random_uuid()) returning id',
      [`Codes ${side.toUpperCase()}`],
    )
  ).id
  target.owner = (
    await one<{ id: string }>(
      `insert into public.app_user (tenant_id, auth_user_id, full_name, role)
       values ($1, $2, 'Patron', 'owner') returning id`,
      [target.tenant, side === 'a' ? authUsers.owner : null],
    )
  ).id
}

beforeAll(async () => {
  client = await connect()

  authUsers.owner = await createAuthUser(emails.owner, PASSWORD)
  authUsers.worker = await createAuthUser(emails.worker, PASSWORD)

  await seedTenant('a')
  await seedTenant('b')

  await client.query(
    `insert into public.app_user (tenant_id, auth_user_id, full_name, role)
     values ($1, $2, 'Employé', 'worker')`,
    [fixture.a.tenant, authUsers.worker],
  )

  for (const role of ['owner', 'worker'] as const) {
    tokens[role] = (await sessionFor(emails[role], PASSWORD)).accessToken
  }
}, 60_000)

afterAll(async () => {
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
  for (const role of ['owner', 'worker'] as const) {
    if (authUsers[role] !== undefined) await deleteAuthUser(authUsers[role])
  }
  await client?.end()
}, 60_000)

/** Sous le jeton d'un rôle, dans une transaction annulée. */
async function as(
  side: 'a' | 'b',
  role: 'owner' | 'worker',
  body: () => Promise<void>,
): Promise<void> {
  await client.query('begin')
  try {
    await actAs(client, tokenFor(fixture[side].tenant, role))
    await body()
  } finally {
    await client.query('rollback')
  }
}

/** Un produit et sa variante par défaut (même identifiant, E2-01). */
async function newProduct(side: 'a' | 'b', code: string | null = null): Promise<string> {
  return (
    await one<{ id: string }>(
      "insert into public.product (tenant_id, name_fr, code) values ($1, 'Produit', $2) returning id",
      [fixture[side].tenant, code],
    )
  ).id
}

async function variant(id: string): Promise<{ sku: string | null; barcode: string | null; sku_printed_at: string | null }> {
  return one('select sku, barcode, sku_printed_at from public.variant where id = $1', [id])
}

/* ========================================================================== */
/* Normalisation                                                              */
/* ========================================================================== */

describe('la normalisation du code-barres', () => {
  /*
   * Une douchette tape le code puis un retour chariot. Un code-barres avec un CR
   * invisible au bout n'est égal à rien : le scan suivant ne le retrouve pas, et
   * l'unicité ne le voit pas comme un doublon.
   */
  it('retire le retour chariot de la douchette', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a')
      await client.query('update public.variant set barcode = $1 where id = $2', [
        ' 6111234567890\r\n',
        product,
      ])

      expect((await variant(product)).barcode).toBe('6111234567890')
    })
  })

  it('ramène une chaîne vide à nul — « pas de code-barres » est une absence', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a')
      await client.query("update public.variant set barcode = '   ' where id = $1", [product])

      expect((await variant(product)).barcode).toBeNull()
    })
  })

  /*
   * Le corollaire, et la raison de la règle : sans le retour à nul, l'unicité
   * refuserait le deuxième produit sans code-barres.
   */
  it('accepte deux produits sans code-barres', async () => {
    await as('a', 'owner', async () => {
      await newProduct('a')
      const second = await newProduct('a')

      expect((await variant(second)).barcode).toBeNull()
    })
  })
})

/* ========================================================================== */
/* `variant_barcode_per_tenant`                                                */
/* ========================================================================== */

describe('un code-barres désigne une variante, et une seule', () => {
  it('le même code sur deux variantes du commerce est refusé', async () => {
    await as('a', 'owner', async () => {
      const first = await newProduct('a')
      const second = await newProduct('a')
      await client.query('update public.variant set barcode = $1 where id = $2', [
        '6111234567890',
        first,
      ])

      const refused = await attempt(
        client,
        `update public.variant set barcode = '6111234567890' where id = '${second}'`,
      )

      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(UNIQUE_VIOLATION)
      /*
       * **Le nom de la contrainte, pas le code seul.** Trois index de `variant`
       * et `product` répondent `23505` ; celui qu'on croit mesurer n'est pas
       * toujours celui qui refuse (CLAUDE.md, règle des unicités — E2-01 s'est
       * fait prendre par `variant_sku_per_tenant`).
       */
      expect(refused.message).toContain('variant_barcode_per_tenant')
    })
  })

  it('sans égard à la casse — « 6111A » et « 6111a » se scannent pareil', async () => {
    await as('a', 'owner', async () => {
      const first = await newProduct('a')
      const second = await newProduct('a')
      await client.query("update public.variant set barcode = '6111A' where id = $1", [first])

      const refused = await attempt(
        client,
        `update public.variant set barcode = '6111a' where id = '${second}'`,
      )

      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.message).toContain('variant_barcode_per_tenant')
    })
  })

  it('une variante supprimée libère son code-barres', async () => {
    await as('a', 'owner', async () => {
      const first = await newProduct('a')
      const second = await newProduct('a')
      await client.query('update public.variant set barcode = $1 where id = $2', ['611', first])
      await client.query('update public.product set deleted_at = now() where id = $1', [first])

      const allowed = await attempt(
        client,
        `update public.variant set barcode = '611' where id = '${second}'`,
      )

      expect(allowed.ok).toBe(true)
    })
  })

  /*
   * L'isolation, ici, n'est pas une formalité : deux grossistes vendent le même
   * shampooing, donc portent le même EAN. Une unicité globale ferait échouer le
   * second import sans que personne puisse comprendre pourquoi — l'autre ligne
   * est invisible, elle est chez le voisin (SPEC § 2.1).
   */
  it('le même code-barres chez deux commerces est accepté', async () => {
    /*
     * **Les deux lignes doivent coexister dans la même transaction.** Écrite
     * autrement — le code posé chez A dans un premier bloc annulé, puis tenté
     * chez B — cette assertion ne mesure rien : au moment de l'écriture de B,
     * celle de A n'existe plus, et un index sans `tenant_id` passerait aussi.
     * Constaté au sabotage : l'unicité rendue globale laissait le test vert.
     *
     * Une unicité est vérifiée hors RLS, donc les deux écritures peuvent être
     * préparées en `postgres` ; seule la seconde passe sous le jeton de B, pour
     * que ce soit bien l'index qui réponde et non une policy.
     */
    await client.query('begin')
    try {
      await client.query('reset role')
      const mine = await newProduct('a')
      const theirs = await newProduct('b')
      await client.query('update public.variant set barcode = $1 where id = $2', [
        '6111234567890',
        mine,
      ])

      await actAs(client, tokenFor(fixture.b.tenant, 'owner'))
      const allowed = await attempt(
        client,
        `update public.variant set barcode = '6111234567890' where id = '${theirs}'`,
      )

      expect(allowed.ok).toBe(true)

      // Le compte se lit en `postgres` : sous le jeton de B, la RLS ne montre
      // que la ligne de B, et « 1 » ne dirait rien de la coexistence.
      await client.query('reset role')
      expect(
        (
          await one<{ n: string }>(
            "select count(*) as n from public.variant where barcode = '6111234567890'",
          )
        ).n,
      ).toBe('2')
    } finally {
      await client.query('rollback')
    }
  })

  /* Le chemin réel, celui de l'application. */
  it('par PostgREST, le refus porte le nom de la contrainte', async () => {
    const created = await rest('product', {
      token: tokens.owner,
      method: 'POST',
      body: { name_fr: 'Crème', code: `REF-${crypto.randomUUID().slice(0, 8)}` },
    })
    const first = created.rows[0]!.id!
    const second = (
      await rest('product', {
        token: tokens.owner,
        method: 'POST',
        body: { name_fr: 'Crème 2' },
      })
    ).rows[0]!.id!
    const code = `611${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')}`

    const ok = await rest(`variant?id=eq.${first}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: { barcode: code },
    })
    const refused = await rest(`variant?id=eq.${second}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: { barcode: code },
    })

    await client.query('delete from public.product where id = any($1)', [[first, second]])

    expect(ok.status).toBe(200)
    expect(refused.code).toBe(UNIQUE_VIOLATION)
    expect(refused.body).toContain('variant_barcode_per_tenant')
  })

  /*
   * Le droit d'écrire est balayé par table et par rôle dans `settings.test.ts`.
   * Ce test-ci vaut pour la colonne neuve : un employé ne pose pas de
   * code-barres.
   *
   * **Un UPDATE refusé ne lève pas**, et c'est le piège : la policy restrictive
   * porte `using (merx.can(...))`, donc la ligne n'est pas visible à
   * l'écriture — PostgREST rend `200` et un tableau vide, pas `42501`. On relit
   * donc la valeur (règle des gardes en écriture) : zéro ligne touchée, **et**
   * le code-barres toujours nul. Avec son contrôle positif : la même écriture,
   * faite par le patron, passe.
   */
  it('l’employé ne pose aucun code-barres', async () => {
    const product = await newProduct('a')

    const refused = await rest(`variant?id=eq.${product}`, {
      token: tokens.worker,
      method: 'PATCH',
      body: { barcode: '6119999999999' },
    })
    const after = await variant(product)

    const allowed = await rest(`variant?id=eq.${product}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: { barcode: '6119999999999' },
    })

    await client.query('delete from public.product where id = $1', [product])

    expect(refused.rows).toHaveLength(0)
    expect(after.barcode).toBeNull()
    expect(allowed.rows).toHaveLength(1)
  })
})

/* ========================================================================== */
/* L'impression fige le SKU                                                   */
/* ========================================================================== */

describe('l’impression fige le SKU', () => {
  it('le patron pose la date, une fois', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a', 'CRM-1')
      await client.query('update public.variant set sku_printed_at = now() where id = $1', [product])

      expect((await variant(product)).sku_printed_at).not.toBeNull()
    })
  })

  it('la date posée ne s’efface pas', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a', 'CRM-1')
      await client.query('update public.variant set sku_printed_at = now() where id = $1', [product])

      const refused = await attempt(
        client,
        `update public.variant set sku_printed_at = null where id = '${product}'`,
      )

      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(FROZEN)
      // Chaque refus a sa phrase : celle-ci parle de la date.
      expect(refused.message).toContain("date d'impression")
    })
  })

  it('la date posée ne recule pas', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a', 'CRM-1')
      await client.query('update public.variant set sku_printed_at = now() where id = $1', [product])

      const refused = await attempt(
        client,
        `update public.variant set sku_printed_at = now() - interval '1 day' where id = '${product}'`,
      )

      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.code).toBe(FROZEN)
    })
  })

  /*
   * **Le vrai trou**, celui que la condition de `follow_product_code()` ne
   * couvre pas : un appel direct à l'API qui change le SKU sans passer par la
   * référence. Sans ce garde, l'écran seul protégerait l'étiquette, et E1-01 a
   * mesuré ce que vaut un garde tenu par la seule porte d'entrée — 18 tests sur
   * 19 restaient verts.
   */
  it('le SKU imprimé ne se modifie plus, même directement', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a', 'CRM-1')
      await client.query('update public.variant set sku_printed_at = now() where id = $1', [product])

      const refused = await attempt(
        client,
        `update public.variant set sku = 'AUTRE' where id = '${product}'`,
      )

      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(FROZEN)
      // La phrase de ce refus-ci nomme le SKU, pas la date.
      expect(refused.message).toContain('CRM-1')
      expect((await variant(product)).sku).toBe('CRM-1')
    })
  })

  it('par PostgREST aussi', async () => {
    const product = await newProduct('a', `CRM-${crypto.randomUUID().slice(0, 6)}`)
    await client.query('update public.variant set sku_printed_at = now() where id = $1', [product])

    const refused = await rest(`variant?id=eq.${product}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: { sku: 'AUTRE' },
    })

    await client.query('delete from public.product where id = $1', [product])

    expect(refused.code).toBe(FROZEN)
  })

  /* Contrôle positif : rien n'est figé avant l'impression. */
  it('avant l’impression, le SKU se modifie', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a', 'CRM-1')

      const allowed = await attempt(
        client,
        `update public.variant set sku = 'AUTRE' where id = '${product}'`,
      )

      expect(allowed.ok).toBe(true)
    })
  })
})

/* ========================================================================== */
/* `follow_product_code()`                                                    */
/* ========================================================================== */

describe('le SKU suit la référence, sauf s’il est imprimé', () => {
  it('non imprimé : il la suit (E2-02, contrôle positif)', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a', 'CRM-1')
      await client.query("update public.product set code = 'CRM-2' where id = $1", [product])

      expect((await variant(product)).sku).toBe('CRM-2')
    })
  })

  it('imprimé : il reste où il est', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a', 'CRM-1')
      await client.query('update public.variant set sku_printed_at = now() where id = $1', [product])

      await client.query("update public.product set code = 'CRM-2' where id = $1", [product])

      expect((await variant(product)).sku).toBe('CRM-1')
    })
  })

  /*
   * Et la référence reste corrigeable : c'est tout l'intérêt de figer le SKU
   * plutôt que de refuser le changement de référence. Sans la condition dans
   * `follow_product_code()`, le trigger tenterait d'écraser un SKU figé, le
   * garde refuserait en `2F004`, et la correction de la référence échouerait.
   */
  it('et la référence, elle, change quand même', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a', 'CRM-1')
      await client.query('update public.variant set sku_printed_at = now() where id = $1', [product])

      const allowed = await attempt(
        client,
        `update public.product set code = 'CRM-2' where id = '${product}'`,
      )

      expect(allowed.ok).toBe(true)
      expect(
        (await one<{ code: string }>('select code from public.product where id = $1', [product]))
          .code,
      ).toBe('CRM-2')
    })
  })

  /*
   * La conséquence assumée de l'arbitrage, et la raison du message distinct
   * dans `products.ts` : la référence est libre sur `product`, et pourtant
   * prise — le SKU figé la tient. C'est `variant_sku_per_tenant` qui refuse.
   */
  it('une référence libérée reste tenue par le SKU figé, et c’est l’index des SKU qui le dit', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a', 'CRM-1')
      await client.query('update public.variant set sku_printed_at = now() where id = $1', [product])
      await client.query("update public.product set code = 'CRM-2' where id = $1", [product])

      const refused = await attempt(
        client,
        `insert into public.product (tenant_id, name_fr, code)
         values ('${fixture.a.tenant}', 'Autre', 'CRM-1')`,
      )

      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(UNIQUE_VIOLATION)
      expect(refused.message).toContain('variant_sku_per_tenant')
      expect(refused.message).not.toContain('product_code_per_tenant')
    })
  })
})

/* ========================================================================== */
/* La recherche interroge les deux sources                                    */
/* ========================================================================== */

describe('RÈGLE M1-5 — la recherche interroge les deux indifféremment', () => {
  async function search(q: string): Promise<Array<{ variant_id: string }>> {
    const { rows } = await client.query<{ variant_id: string }>(
      'select variant_id from public.search_products($1)',
      [q],
    )
    return rows
  }

  it('trouve par le code-barres du fabricant comme par le SKU', async () => {
    await as('a', 'owner', async () => {
      /*
       * Deux références sans ressemblance entre elles : la recherche tolère une
       * faute (§ 6, seuil 0,4), et « SKU-ONE » face à « SKU-TWO » rend les deux
       * — ce serait la tolérance qu'on mesurerait, pas les deux sources.
       */
      const scanned = await newProduct('a', 'ALPHA-1')
      const labelled = await newProduct('a', 'ZOULOU-9')
      await client.query('update public.variant set barcode = $1 where id = $2', [
        '6111234567890',
        scanned,
      ])

      expect((await search('6111234567890')).map((row) => row.variant_id)).toStrictEqual([scanned])
      expect((await search('ZOULOU-9')).map((row) => row.variant_id)).toStrictEqual([labelled])
    })
  })
})
