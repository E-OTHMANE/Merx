// @vitest-environment node

/*
 * E4-02 — la numérotation locale des documents.
 * SPEC § 2.5 (RÈGLE numérotation), § 4 (clés composites, RÈGLE des refus en
 * 4xx), § 8 (RÈGLE M3-2).
 *
 * Le serveur n'attribue aucun numéro — c'est ce qui rend E9 possible. Il refuse
 * ce qui est faux, et ce fichier mesure ces refus, chacun par sa phrase ou par
 * le nom de sa contrainte :
 *
 *   `sale_document_number_per_tenant`      l'autorité : un numéro n'est porté
 *                                          qu'une fois par commerce. `23505`.
 *   `merx.require_document_number_shape`   le numéro dit la vérité sur sa ligne
 *                                          — type, appareil, année. Quatre
 *                                          branches, quatre phrases. `22023`.
 *   `sale_document_number_when_numbered`   nul tant que brouillon, posé dès la
 *   `sale_document_issued_at_when_numbered` confirmation. `23514`.
 *   `document_sequence` dérivée            la borne se constate, elle ne
 *                                          s'écrit pas. `PT422`.
 *
 * Deux propriétés portent la story, et elles ont leur cas :
 *
 *   — **deux appareils, 100 documents chacun, aucune collision** (critère
 *     d'acceptation). Les lettres les séparent, et c'est la branche « appareil »
 *     du garde de forme qui rend cette séparation vraie ;
 *   — **la borne ne recule pas**, donc un appareil dont le stockage local a été
 *     vidé repart au-dessus du dernier numéro connu du serveur, jamais à
 *     `00001` (même leçon que le SKU engendré, E2-06).
 *
 * Un cas d'unicité écrit les deux lignes dans **une seule** transaction et relit
 * le compte hors RLS : deux écritures dans des transactions annulées
 * séparément ne se rencontrent jamais, et une contrainte à qui manque
 * `tenant_id` passerait exactement comme une contrainte complète (CLAUDE.md,
 * éprouvé en E2-06).
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DERIVED_WRITE, attempt, tokenFor } from './isolation'
import { planOfStatement, seqScansOf } from './stock-plan'
import { DOC_TYPE_CODES } from '@/modules/sales/documentNumber'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const UNIQUE_VIOLATION = '23505'
const CHECK_VIOLATION = '23514'
const FOREIGN_KEY_VIOLATION = '23503'
const INVALID_PARAMETER = '22023'

/* Les phrases du garde de forme — chacune n'est dite que par sa branche. */
const MALFORMED = 'Numéro de document mal formé'
const WRONG_TYPE = 'n\'est pas celui du type'
const WRONG_DEVICE = 'n\'est pas celui de cet appareil'
const WRONG_YEAR = 'ne porte pas l\'année de sa date d\'émission'

let client: Client

const fixture = {
  tenant: '',
  warehouse: '',
  /** L'appareil « A » du commerce. */
  device: '',
  /** Un second appareil, « B » : le critère des deux appareils. */
  deviceB: '',
  worker: '',
  /** Un commerce voisin, pour l'unicité et les clés composites. */
  other: { tenant: '', warehouse: '', device: '' },
}

/** L'année du comptoir, celle que le garde recalcule depuis `issued_at`. */
let year = 0
let shortYear = ''

async function one<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<T>(sql, values)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0]
}

async function tenantWith(
  name: string,
  prefixes: readonly string[],
): Promise<{ tenant: string; warehouse: string; devices: string[] }> {
  const tenant = (
    await one<{ id: string }>(
      'insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), $1) returning id',
      [name],
    )
  ).id
  const warehouse = (
    await one<{ id: string }>(
      'select id from public.warehouse where tenant_id = $1 and is_default',
      [tenant],
    )
  ).id
  const devices: string[] = []
  for (const prefix of prefixes) {
    devices.push(
      (
        await one<{ id: string }>(
          'insert into public.device (tenant_id, label, prefix)' +
            ' values ($1, $2, $3::public.device_prefix) returning id',
          [tenant, `Comptoir ${prefix}`, prefix],
        )
      ).id,
    )
  }
  return { tenant, warehouse, devices }
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
  await client.query('begin')

  const main = await tenantWith('Numérotation E4-02', ['A', 'B'])
  fixture.tenant = main.tenant
  fixture.warehouse = main.warehouse
  fixture.device = main.devices[0]!
  fixture.deviceB = main.devices[1]!

  fixture.worker = (
    await one<{ id: string }>(
      'insert into public.app_user (tenant_id, auth_user_id, full_name, role)' +
        " values ($1, null, 'Employé', 'worker') returning id",
      [fixture.tenant],
    )
  ).id

  const neighbour = await tenantWith('Voisin E4-02', ['A'])
  fixture.other = {
    tenant: neighbour.tenant,
    warehouse: neighbour.warehouse,
    device: neighbour.devices[0]!,
  }

  const now = await one<{ year: number }>('select merx.document_number_year(now()) as year')
  year = Number(now.year)
  shortYear = String(year % 100).padStart(2, '0')
}, 60_000)

afterAll(async () => {
  await client?.query('rollback')
  await client?.end()
})

/* -------------------------------------------------------------------------- */
/* Outillage                                                                   */
/* -------------------------------------------------------------------------- */

/** Un cas, dans son point de sauvegarde. */
async function inCase(body: () => Promise<void>): Promise<void> {
  await client.query('savepoint case_under_test')
  try {
    await body()
  } finally {
    await client.query('rollback to savepoint case_under_test')
    await client.query('reset role')
  }
}

interface DraftOptions {
  tenant?: string
  warehouse?: string
  device?: string
  docType?: string
}

/** Un brouillon, posé en `postgres`. Rend son identifiant. */
async function draft(options: DraftOptions = {}): Promise<string> {
  const doc = await one<{ id: string }>(
    'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id)' +
      ' values ($1, $2::public.sale_doc_type, $3, $4) returning id',
    [
      options.tenant ?? fixture.tenant,
      options.docType ?? 'delivery_note',
      options.warehouse ?? fixture.warehouse,
      options.device ?? fixture.device,
    ],
  )
  return doc.id
}

/** `BL-A-26-00001`, pour l'année du comptoir. */
function number(code: string, prefix: string, sequence: number, overrideYear = shortYear): string {
  return `${code}-${prefix}-${overrideYear}-${String(sequence).padStart(5, '0')}`
}

/** La confirmation telle que l'appareil l'écrit — numéro et date du même geste. */
function confirm(id: string, docNumber: string): string {
  return (
    "update public.sale_document set status = 'confirmed'," +
    ` doc_number = '${docNumber}', issued_at = now() where id = '${id}'`
  )
}

async function sequenceRow(
  tenant: string,
  device: string,
  docType = 'delivery_note',
): Promise<{ last_number: number } | null> {
  const { rows } = await client.query<{ last_number: number }>(
    'select last_number from public.document_sequence' +
      ' where tenant_id = $1 and device_id = $2 and doc_type = $3 and year = $4',
    [tenant, device, docType, year],
  )
  return rows[0] ?? null
}

/* -------------------------------------------------------------------------- */
/* Le format                                                                   */
/* -------------------------------------------------------------------------- */

describe('le format', () => {
  /*
   * La matrice des codes a deux copies — `merx.doc_type_code()` et le
   * `DOC_TYPE_CODES` du front —, et c'est ce test qui les tient d'accord. Les
   * étiquettes sont **lues au catalogue** et non recopiées : un quatrième type
   * de document fait rougir ce cas-ci, au lieu de sortir un numéro muet.
   */
  it('a un code par type de document, le même en base et sur l’appareil', async () => {
    const { rows } = await client.query<{ label: string; code: string }>(
      'select e.enumlabel as label,' +
        ' merx.doc_type_code(e.enumlabel::public.sale_doc_type) as code' +
        ' from pg_enum e' +
        " where e.enumtypid = 'public.sale_doc_type'::regtype" +
        ' order by e.enumsortorder',
    )

    expect(rows.map((r) => r.label)).toStrictEqual([
      'quote',
      'order',
      'delivery_note',
      // Le quatrième, ajouté en E4-06 : `RT`, le bon de retour.
      'return',
    ])

    for (const { label, code } of rows) {
      expect(code, `le code de ${label} en base`).not.toBeNull()
      expect(code, `le code de ${label}`).toBe(DOC_TYPE_CODES[label as keyof typeof DOC_TYPE_CODES])
    }
    expect(Object.keys(DOC_TYPE_CODES)).toHaveLength(rows.length)
  })

  it('porte l’année du comptoir, pas celle d’UTC', async () => {
    /*
     * Le Maroc est à UTC+1 : l'instant qui suit est déjà le 1er janvier en UTC,
     * et encore le 31 décembre au comptoir. Le numéro suit le comptoir (§ 4),
     * et le garde de forme recalcule la même année — les deux lectures doivent
     * tomber d'accord, sans quoi un numéro juste serait refusé.
     */
    const { rows } = await client.query<{ year: number }>(
      "select merx.document_number_year('2026-12-31T23:30:00Z'::timestamptz) as year",
    )
    expect(Number(rows[0]!.year)).toBe(2027)

    const eve = await client.query<{ year: number }>(
      "select merx.document_number_year('2026-12-31T22:30:00Z'::timestamptz) as year",
    )
    expect(Number(eve.rows[0]!.year)).toBe(2026)
  })
})

/* -------------------------------------------------------------------------- */
/* Numéro et date : nuls tant que brouillon                                    */
/* -------------------------------------------------------------------------- */

describe('le brouillon ne consomme aucun numéro', () => {
  it('refuse un numéro sur un brouillon', async () => {
    await inCase(async () => {
      const id = await draft()
      const refused = await attempt(
        client,
        `update public.sale_document set doc_number = '${number('BL', 'A', 1)}' where id = '${id}'`,
      )

      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(CHECK_VIOLATION)
      // Le nom de la contrainte, jamais le seul code : deux `check` de la même
      // table répondent `23514` (CLAUDE.md, règle des unicités, même famille).
      expect(refused.message).toContain('sale_document_number_when_numbered')
    })
  })

  it('refuse une date d’émission sur un brouillon', async () => {
    await inCase(async () => {
      const id = await draft()
      const refused = await attempt(
        client,
        `update public.sale_document set issued_at = now() where id = '${id}'`,
      )

      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(CHECK_VIOLATION)
      expect(refused.message).toContain('sale_document_issued_at_when_numbered')
    })
  })

  it('refuse une confirmation sans numéro', async () => {
    await inCase(async () => {
      const id = await draft()
      const refused = await attempt(
        client,
        `update public.sale_document set status = 'confirmed', issued_at = now() where id = '${id}'`,
      )

      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(CHECK_VIOLATION)
      expect(refused.message).toContain('sale_document_number_when_numbered')
    })
  })

  it('refuse une confirmation sans date', async () => {
    await inCase(async () => {
      const id = await draft()
      const refused = await attempt(
        client,
        `update public.sale_document set status = 'confirmed', doc_number = '${number('BL', 'A', 1)}' where id = '${id}'`,
      )

      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(CHECK_VIOLATION)
      expect(refused.message).toContain('sale_document_issued_at_when_numbered')
    })
  })

  /* Le contrôle positif : la confirmation complète passe, et c'est ce que les
   * refus ci-dessus mesurent — pas une table qui refuserait tout. */
  it('accepte la confirmation qui porte les deux', async () => {
    await inCase(async () => {
      const id = await draft()
      const ok = await attempt(client, confirm(id, number('BL', 'A', 1)))

      expect(ok.ok, ok.ok ? '' : `${ok.code} ${ok.message}`).toBe(true)
      const row = await one<{ doc_number: string; issued_at: string }>(
        'select doc_number, issued_at from public.sale_document where id = $1',
        [id],
      )
      expect(row.doc_number).toBe(number('BL', 'A', 1))
      expect(row.issued_at).not.toBeNull()
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Le garde de forme — quatre branches, quatre phrases                         */
/* -------------------------------------------------------------------------- */

describe('le numéro dit la vérité sur sa ligne', () => {
  const cases: ReadonlyArray<{ label: string; docNumber: () => string; phrase: string }> = [
    {
      label: 'un texte qui n’est pas un numéro',
      docNumber: () => 'BL-A-0001',
      phrase: MALFORMED,
    },
    {
      label: 'le code d’un autre type',
      docNumber: () => number('CM', 'A', 1),
      phrase: WRONG_TYPE,
    },
    {
      label: 'la lettre d’un autre appareil',
      docNumber: () => number('BL', 'B', 1),
      phrase: WRONG_DEVICE,
    },
    {
      label: 'une autre année',
      docNumber: () => number('BL', 'A', 1, String((year + 1) % 100).padStart(2, '0')),
      phrase: WRONG_YEAR,
    },
  ]

  for (const { label, docNumber, phrase } of cases) {
    it(`refuse ${label}`, async () => {
      await inCase(async () => {
        const id = await draft()
        const refused = await attempt(client, confirm(id, docNumber()))

        expect(refused.ok).toBe(false)
        if (refused.ok) return
        expect(refused.code).toBe(INVALID_PARAMETER)
        /*
         * La phrase, et pas seulement le code : les quatre branches lèvent le
         * même `22023`, et une assertion sur le code seul tiendrait encore si
         * trois d'entre elles disparaissaient.
         */
        expect(refused.message).toContain(phrase)
      })
    })
  }

  /*
   * **Le critère des deux appareils, vu du garde.** La lettre est tout ce qui
   * sépare deux tablettes qui ne se parlent pas. Si « A » pouvait écrire un
   * numéro en « B », il prendrait un numéro que « B » imprimera légitimement
   * plus tard, et c'est « B » que l'unicité refuserait — sur un papier déjà
   * remis. Le même numéro, écrit par le bon appareil, passe.
   */
  it('accepte en « B » ce qu’il refuse en « A », et réciproquement', async () => {
    await inCase(async () => {
      const inB = await draft({ device: fixture.deviceB })
      const ok = await attempt(client, confirm(inB, number('BL', 'B', 1)))
      expect(ok.ok, ok.ok ? '' : `${ok.code} ${ok.message}`).toBe(true)

      const inA = await draft({ device: fixture.device })
      const refused = await attempt(client, confirm(inA, number('BL', 'B', 2)))
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.message).toContain(WRONG_DEVICE)
    })
  })

  /*
   * Le garde lit la lettre dans `public.device` ; la clé composite est ce qui
   * garantit que la ligne lue est celle du commerce. Sans `tenant_id` dans la
   * clé, un document pourrait se dire écrit par l'appareil du voisin — et le
   * garde comparerait sa lettre à celle d'une autre tablette (§ 4).
   */
  it('refuse un document rattaché à l’appareil du voisin', async () => {
    await inCase(async () => {
      const refused = await attempt(
        client,
        'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id)' +
          ` values ('${fixture.tenant}', 'delivery_note', '${fixture.warehouse}', '${fixture.other.device}')`,
      )

      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(FOREIGN_KEY_VIOLATION)
      expect(refused.message).toContain('sale_document_device_id_fkey')
    })
  })

  it('refuse un document sans appareil', async () => {
    await inCase(async () => {
      const refused = await attempt(
        client,
        'insert into public.sale_document (tenant_id, doc_type, warehouse_id)' +
          ` values ('${fixture.tenant}', 'delivery_note', '${fixture.warehouse}')`,
      )

      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.message).toContain('device_id')
    })
  })
})

/* -------------------------------------------------------------------------- */
/* L'autorité — l'unicité du numéro                                            */
/* -------------------------------------------------------------------------- */

describe('un numéro n’est porté qu’une fois par commerce', () => {
  it('refuse le second, au nom de l’index', async () => {
    await inCase(async () => {
      const first = await draft()
      await client.query(confirm(first, number('BL', 'A', 1)))

      const second = await draft()
      const refused = await attempt(client, confirm(second, number('BL', 'A', 1)))

      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(UNIQUE_VIOLATION)
      /*
       * Le nom de l'index, jamais le seul code : trois unicités du schéma
       * répondent `23505`, et celle qui refuse n'est pas toujours celle qu'on
       * croit mesurer (CLAUDE.md ; E2-01, E2-06).
       */
      expect(refused.message).toContain('sale_document_number_per_tenant')
    })
  })

  it('laisse les brouillons sans numéro coexister', async () => {
    await inCase(async () => {
      await draft()
      await draft()
      const { rows } = await client.query<{ n: string }>(
        'select count(*) as n from public.sale_document where tenant_id = $1 and doc_number is null',
        [fixture.tenant],
      )
      expect(Number(rows[0]!.n)).toBe(2)
    })
  })

  /*
   * **Deux commerces, le même numéro, une seule transaction.** La propriété est
   * que deux grossistes puissent porter `BL-A-26-00001` le même jour — ils ont
   * chacun leur appareil « A ». La mesurer exige que les deux lignes existent
   * **au même instant** : deux transactions annulées séparément ne se
   * rencontrent jamais, et un index à qui manque `tenant_id` passerait
   * exactement comme un index complet (CLAUDE.md, éprouvé en E2-06).
   *
   * Le compte est relu **hors RLS** : sous le jeton d'un commerce, la policy ne
   * montrerait qu'une ligne, que l'autre existe ou non — `1` ne dirait rien.
   */
  it('laisse deux commerces porter le même numéro', async () => {
    await inCase(async () => {
      const mine = await draft()
      await client.query(confirm(mine, number('BL', 'A', 1)))

      const theirs = await draft({
        tenant: fixture.other.tenant,
        warehouse: fixture.other.warehouse,
        device: fixture.other.device,
      })
      const ok = await attempt(client, confirm(theirs, number('BL', 'A', 1)))
      expect(ok.ok, ok.ok ? '' : `${ok.code} ${ok.message}`).toBe(true)

      await client.query('reset role')
      const { rows } = await client.query<{ n: string }>(
        'select count(*) as n from public.sale_document where doc_number = $1',
        [number('BL', 'A', 1)],
      )
      expect(Number(rows[0]!.n), 'les deux lignes au même instant').toBe(2)
    })
  })
})

/* -------------------------------------------------------------------------- */
/* La borne — constatée, jamais attribuée                                      */
/* -------------------------------------------------------------------------- */

describe('la borne se constate', () => {
  it('n’existe pas tant qu’aucun numéro n’est écrit', async () => {
    await inCase(async () => {
      await draft()
      expect(await sequenceRow(fixture.tenant, fixture.device)).toBeNull()
    })
  })

  it('suit le numéro écrit, par appareil, type et année', async () => {
    await inCase(async () => {
      const id = await draft()
      await client.query(confirm(id, number('BL', 'A', 7)))

      expect((await sequenceRow(fixture.tenant, fixture.device))?.last_number).toBe(7)
      // L'autre appareil et l'autre type ont leur propre compteur.
      expect(await sequenceRow(fixture.tenant, fixture.deviceB)).toBeNull()
      expect(await sequenceRow(fixture.tenant, fixture.device, 'quote')).toBeNull()
    })
  })

  /*
   * **Elle ne recule pas.** C'est la propriété qui tient le critère du stockage
   * vidé : l'appareil lit cette borne et repart au-dessus. Un document remonté
   * en retard — E9 rejoue une file hors ligne dans l'ordre qu'il veut — ne doit
   * pas la faire redescendre, sinon le numéro suivant serait déjà imprimé.
   */
  it('ne recule pas devant un numéro plus petit', async () => {
    await inCase(async () => {
      const high = await draft()
      await client.query(confirm(high, number('BL', 'A', 42)))

      const late = await draft()
      await client.query(confirm(late, number('BL', 'A', 3)))

      expect((await sequenceRow(fixture.tenant, fixture.device))?.last_number).toBe(42)
    })
  })

  it('se refuse à l’écriture à la main', async () => {
    await inCase(async () => {
      const id = await draft()
      await client.query(confirm(id, number('BL', 'A', 5)))

      const refused = await attempt(
        client,
        `update public.document_sequence set last_number = 1 where tenant_id = '${fixture.tenant}'`,
      )
      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(DERIVED_WRITE)
      expect(refused.message).toContain('document_sequence')

      const inserted = await attempt(
        client,
        'insert into public.document_sequence (tenant_id, device_id, doc_type, year, last_number)' +
          ` values ('${fixture.tenant}', '${fixture.deviceB}', 'quote', ${year}, 500)`,
      )
      expect(inserted.ok).toBe(false)
      if (!inserted.ok) expect(inserted.code).toBe(DERIVED_WRITE)
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Le critère : deux appareils, 100 documents chacun                           */
/* -------------------------------------------------------------------------- */

describe('deux appareils, 100 documents chacun', () => {
  /*
   * Le critère d'acceptation de la story. Les deux appareils numérotent **sans
   * se parler**, chacun à partir de sa propre borne — ce que fait
   * `confirmDocument()` sur l'appareil, reproduit ici en SQL : lire la borne,
   * poser le numéro suivant.
   *
   * Trois assertions, et la troisième est celle qui compte : 200 numéros
   * distincts. Les deux premières disent qu'aucune séquence n'a de trou, la
   * troisième qu'aucun numéro n'est porté deux fois.
   */
  it('ne produisent ni collision ni trou', async () => {
    await inCase(async () => {
      for (let n = 0; n < 100; n += 1) {
        for (const [device, prefix] of [
          [fixture.device, 'A'],
          [fixture.deviceB, 'B'],
        ] as const) {
          const bound = (await sequenceRow(fixture.tenant, device))?.last_number ?? 0
          const id = await draft({ device })
          await client.query(confirm(id, number('BL', prefix, bound + 1)))
        }
      }

      const { rows } = await client.query<{ prefix: string; n: string; distinct: string; max: number }>(
        'select substring(doc_number from 4 for 1) as prefix,' +
          ' count(*) as n, count(distinct doc_number) as distinct, max(merx.document_number_sequence(doc_number)) as max' +
          ' from public.sale_document' +
          ' where tenant_id = $1 and doc_number is not null' +
          ' group by 1 order by 1',
        [fixture.tenant],
      )

      expect(rows.map((r) => r.prefix)).toStrictEqual(['A', 'B'])
      for (const row of rows) {
        expect(Number(row.n), `les documents de l'appareil ${row.prefix}`).toBe(100)
        // Aucun trou : 100 documents, et le plus grand numéro vaut 100.
        expect(Number(row.max), `la séquence de l'appareil ${row.prefix}`).toBe(100)
      }

      const all = await client.query<{ n: string; distinct: string }>(
        'select count(*) as n, count(distinct doc_number) as distinct' +
          ' from public.sale_document where tenant_id = $1 and doc_number is not null',
        [fixture.tenant],
      )
      expect(Number(all.rows[0]!.n)).toBe(200)
      expect(Number(all.rows[0]!.distinct), 'aucune collision').toBe(200)
    })
  }, 120_000)
})

/* -------------------------------------------------------------------------- */
/* Le plan de la lecture de la borne                                           */
/* -------------------------------------------------------------------------- */

/*
 * Pourquoi l'appareil lit `document_sequence` et non `max(doc_number)` : sous la
 * paire de policies de § 2.1, une comparaison de texte sur `doc_number` ne peut
 * emprunter aucun index — `textlike` n'est pas `leakproof` (CLAUDE.md, mesuré en
 * E2-04) —, donc chaque confirmation parcourrait toute la table, tous commerces
 * confondus. Mesuré en écrivant cette story : 222 ms par appel sur 10 000
 * documents, 493 ms sur 20 000. La borne, elle, est une poignée de lignes par
 * commerce.
 *
 * Le plan est lu sur une **session chaude** (`planOfStatement`, huit chauffages)
 * : un plan générique remplace le plan personnalisé au bout de cinq exécutions,
 * et c'est ainsi que travaille une connexion du pool de PostgREST. Un plan jugé
 * sur le premier appel est resté vert à tort en E2-04.
 */
describe('la borne se lit sans parcourir les documents', () => {
  it('ne touche pas sale_document, sous le jeton d’un employé', async () => {
    const nodes = await planOfStatement(
      client,
      tokenFor(fixture.tenant, 'worker'),
      'select last_number from public.document_sequence' +
        ` where device_id = '${fixture.device}' and doc_type = 'delivery_note' and year = ${year}`,
      'document_sequence',
    )

    expect(seqScansOf(nodes, 'sale_document')).toStrictEqual([])
  }, 60_000)

  /*
   * Et la forme écartée, mesurée elle aussi — sans quoi « on a choisi la borne »
   * resterait une opinion.
   *
   * Ce qui est asserté n'est **pas** la forme du parcours : elle bascule avec le
   * volume, et c'est précisément pour cela que cette lecture a été écartée. Sur
   * les mesures de la story : Seq Scan à 10 000 documents, Index Only Scan à
   * 20 000, Index Only Scan sur une table presque vide comme ici — dans tous les
   * cas la comparaison est un **filtre**, appliqué ligne à ligne sur tout ce
   * qu'il y a.
   *
   * Ce qui ne bascule pas, c'est qu'aucun index ne sert de **condition** :
   * `textlike` n'est pas `leakproof`, donc Postgres refuse de l'évaluer dans une
   * condition d'index sous une policy de ligne, et `postgres` n'est pas
   * superutilisateur — rien ne peut être déclaré `leakproof` (CLAUDE.md, mesuré
   * en E2-04). Le jour où cela changerait, ce cas rougirait, et la décision se
   * rouvrirait avec une mesure sous la main.
   */
  it('là où max(doc_number) ne peut emprunter aucune condition d’index', async () => {
    const nodes = await planOfStatement(
      client,
      tokenFor(fixture.tenant, 'worker'),
      "select max(doc_number) from public.sale_document where doc_number like 'BL-A-%'",
      "like 'BL-A-%'",
    )

    const conditions = nodes
      .filter((node) => node['Relation Name'] === 'sale_document')
      .map((node) => node['Index Cond'] ?? '')
      .filter((cond) => cond !== '')

    expect(conditions, 'aucune condition d’index sur doc_number').toStrictEqual([])
    // La table est bien lue en entier, d'une façon ou d'une autre.
    expect(
      nodes.some(
        (node) =>
          node['Relation Name'] === 'sale_document' &&
          (node['Node Type'] === 'Seq Scan' || node['Node Type'].includes('Index')),
      ),
      'le parcours de sale_document',
    ).toBe(true)
  }, 60_000)
})
