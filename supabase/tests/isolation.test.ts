// @vitest-environment node

/*
 * E0-03 — un utilisateur du commerce A ne lit ni n'écrit aucune ligne du
 * commerce B, sur chaque table. SPEC § 2.1, § 2.7 (RÈGLE tests).
 *
 * C'est le critère central du backlog, et il ne se vérifie pas à l'œil : une
 * policy manquante ne casse rien de visible, la fuite se découvre chez un
 * client. Le test est donc autant le livrable que les policies.
 *
 * Il balaie `merx.convention_registry` — jamais une liste de tables écrite à
 * la main. Une table ajoutée en E2 sans policy est signalée sans que personne
 * ait pensé à l'inscrire quelque part. C'est la seule forme de test qui
 * continue de protéger le projet quand il grossit.
 *
 * Comme les tests de convention, il exige le stack local et échoue bruyamment
 * s'il est absent : `npx supabase start && npx supabase db reset`.
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { describe as describeViolations } from './conventions'
import {
  EMPTY_CLAIMS,
  ISOLATION_RULES,
  INSUFFICIENT_PRIVILEGE,
  actAs,
  appendOnlyTables,
  attempt,
  isolationViolations,
  registeredTables,
  seedTwoTenants,
  tokenFor,
  type IsolationRuleName,
  type Seeded,
  type WritePath,
} from './isolation'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

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

/*
 * La liste des tables est lue avant tout le reste : `describe.each` a besoin de
 * ses cas au moment où le fichier est collecté, pas quand les hooks tournent.
 * Le registre est donc interrogé sur une connexion à part, refermée aussitôt.
 */
const TABLES = await tablesUnderTest()

/*
 * Et, à la même heure et pour la même raison, le registre d'ajout seul (E1-04) :
 * il décide, table par table, du sens du contrôle positif. Aucune table n'est
 * nommée dans ce fichier — `stock_movement` (E3) et le grand livre (E6)
 * entreront dans le balayage en s'inscrivant.
 */
const APPEND_ONLY = await appendOnlyUnderTest()

async function tablesUnderTest(): Promise<string[]> {
  const client = await connect()
  try {
    const tables = await registeredTables(client)
    if (tables.length === 0) {
      throw new Error(
        'Registre de conventions vide : le balayage ne vérifierait rien.\n' +
          'Reconstruire la base : npx supabase db reset',
      )
    }
    return tables
  } finally {
    await client.end()
  }
}

async function appendOnlyUnderTest(): Promise<Map<string, WritePath>> {
  const client = await connect()
  try {
    return await appendOnlyTables(client)
  } finally {
    await client.end()
  }
}

/* ========================================================================== */
/* Ce que dit le catalogue                                                     */
/* ========================================================================== */

describe('la RLS est en place sur chaque table de public', () => {
  let client: Client

  beforeAll(async () => {
    client = await connect()
  })

  afterAll(async () => {
    await client?.end()
  })

  it('le registre n\'est pas vide — sans quoi le balayage ne prouverait rien', async () => {
    expect(await registeredTables(client)).not.toHaveLength(0)
  })

  for (const rule of Object.keys(ISOLATION_RULES) as IsolationRuleName[]) {
    it(`respecte la règle : ${rule}`, async () => {
      const found = await isolationViolations(client, rule)
      expect(describeViolations(found)).toBe('')
    })
  }
})

/*
 * Les règles savent-elles dire non ? Une table créée à la main, enregistrée de
 * force, sans RLS ni policy — dans une transaction annulée. Sans ce bloc, le
 * précédent ne dirait rien de plus que « il n'y a rien à signaler ».
 */
describe('le balayage attrape une table sans isolation', () => {
  let client: Client

  beforeAll(async () => {
    client = await connect()
    await client.query('begin')
    await client.query(`
      create table public.rls_rogue_probe (
        id        uuid primary key default gen_random_uuid(),
        tenant_id uuid not null
      );
    `)
    // Volontairement pas inscrite au registre : c'est tout l'intérêt. Une table
    // qui n'est jamais passée par les conventions n'y figure pas, et doit être
    // signalée quand même.
  })

  afterAll(async () => {
    await client?.query('rollback')
    await client?.end()
  })

  it('signale la RLS absente', async () => {
    const found = await isolationViolations(client, 'RLS activée et forcée')
    expect(found.map((v) => v.table_name)).toContain('rls_rogue_probe')
  })

  it('signale les deux policies manquantes', async () => {
    const found = await isolationViolations(client, 'les policies attendues, exactement')
    const onProbe = found.filter((v) => v.table_name === 'rls_rogue_probe')
    expect(onProbe).toHaveLength(2)
    expect(describeViolations(onProbe)).toContain('tenant_isolation')
    expect(describeViolations(onProbe)).toContain('super_admin_all')
  })

  it('signale les privilèges laissés à anon', async () => {
    const found = await isolationViolations(client, 'aucun privilège pour anon')
    expect(found.map((v) => v.table_name)).toContain('rls_rogue_probe')
  })

  it('laisse passer une table créée par les conventions', async () => {
    await client.query(`
      create table public.rls_compliant_probe (id uuid primary key default gen_random_uuid());
      select merx.apply_business_conventions('public.rls_compliant_probe');
    `)

    for (const rule of Object.keys(ISOLATION_RULES) as IsolationRuleName[]) {
      const found = await isolationViolations(client, rule)
      const onProbe = found.filter((v) => v.table_name === 'rls_compliant_probe')
      expect(describeViolations(onProbe), `règle : ${rule}`).toBe('')
    }
  })
})

/* ========================================================================== */
/* Ce que la base laisse réellement faire                                      */
/* ========================================================================== */

/*
 * Une policy peut exister et être fausse. Deux commerces sont donc peuplés
 * pour de bon — une ligne par table métier de chaque côté — et les quatre
 * opérations sont tentées à travers la frontière, avec les claims d'un vrai
 * jeton et le rôle `authenticated`.
 *
 * Sur l'insertion, une seule assertion : celle qui vise le commerce d'en face
 * est refusée. Il n'y a pas d'assertion « insérer chez soi réussit », parce
 * qu'elle n'est pas universellement vraie — créer un `tenant` depuis
 * l'application est refusé, et à raison : les commerces sont créés par
 * l'éditeur (SPEC § 3). Le rôle de contrôle positif est tenu par le select,
 * l'update et le delete sur sa propre ligne, qui valent pour toute table : ils
 * établissent que les policies ne se contentent pas de tout refuser, ce qui
 * ferait passer les assertions négatives pour n'importe quelle raison.
 */
describe('les quatre opérations, à travers la frontière', () => {
  let client: Client
  let seeded: Seeded

  beforeAll(async () => {
    client = await connect()
    await client.query('begin')
    seeded = await seedTwoTenants(client)
  })

  afterAll(async () => {
    await client?.query('rollback')
    await client?.end()
  })

  it('peuple deux commerces complets', () => {
    expect(seeded.tenants.a).not.toBe(seeded.tenants.b)
    expect([...seeded.rows.a.keys()].sort()).toEqual(seeded.order.slice().sort())
    expect([...seeded.rows.b.keys()].sort()).toEqual(seeded.order.slice().sort())
  })

  /*
   * Une entrée par table du registre, construite à l'exécution. La liste des
   * `it` grandit toute seule avec le schéma.
   */
  describe.each(TABLES)('%s', (table) => {
    const own = (): string => required(seeded.rows.a.get(table), table)
    const foreign = (): string => required(seeded.rows.b.get(table), table)

    const asOwnerOfA = async (): Promise<void> => {
      await actAs(client, tokenFor(seeded.tenants.a, 'owner'))
    }

    /*
     * E1-04. Sur une table en ajout seul, les assertions d'écriture s'inversent
     * — elles ne disparaissent pas. Une table dont plus rien n'est attendu
     * cesse d'être vérifiée : « modifier échoue » est satisfait aussi bien par
     * l'ajout seul que par une policy cassée qui refuse tout.
     *
     * Le contrôle positif se déplace donc, et le registre dit où :
     *
     *   'application' — l'insertion réussit chez soi. C'est elle qui prouve que
     *                   la table vit encore.
     *   'helper'      — l'insertion est refusée à `authenticated` elle aussi
     *                   (le seul écrivain est une fonction `security definer`).
     *                   Le contrôle positif reste le `select` ci-dessous, qui
     *                   n'est pas moins un contrôle : il échoue si la policy
     *                   restrictive de la table refuse son propre `owner`.
     */
    const appendOnly = APPEND_ONLY.get(table)

    it('select — voit sa ligne, ignore celle du voisin', async () => {
      await asOwnerOfA()

      const mine = await client.query(`select id from public."${table}" where id = $1`, [own()])
      expect(mine.rowCount, 'sa propre ligne est invisible').toBe(1)

      const theirs = await client.query(`select id from public."${table}" where id = $1`, [
        foreign(),
      ])
      expect(theirs.rowCount, 'FUITE — la ligne du commerce B est lisible').toBe(0)
    })

    const touch = (id: string): string =>
      `update public."${table}" set updated_at = updated_at where id = '${id}'::uuid`

    const erase = (id: string): string => `delete from public."${table}" where id = '${id}'::uuid`

    if (appendOnly === undefined) {
      it('update — ne touche pas la ligne du voisin, touche la sienne', async () => {
        await asOwnerOfA()

        const theirs = await client.query(
          `update public."${table}" set updated_at = updated_at where id = $1`,
          [foreign()],
        )
        expect(theirs.rowCount, 'FUITE — la ligne du commerce B est modifiable').toBe(0)

        const mine = await client.query(
          `update public."${table}" set updated_at = updated_at where id = $1`,
          [own()],
        )
        expect(mine.rowCount, 'la policy refuse aussi les écritures légitimes').toBe(1)
      })

      it('delete — ne supprime pas la ligne du voisin', async () => {
        await asOwnerOfA()

        const theirs = await client.query(`delete from public."${table}" where id = $1`, [foreign()])
        expect(theirs.rowCount, 'FUITE — la ligne du commerce B est supprimable').toBe(0)
      })
    } else {
      /*
       * En ajout seul, le refus vient du privilège retiré, avant même que la
       * RLS ait à choisir une ligne : `42501`, sur celle du voisin comme sur la
       * sienne. Le second garde — le trigger, qui arrête ce que le privilège
       * ne voit pas — est éprouvé à part, dans `audit.test.ts`, et il répond
       * `2F004`. Deux codes, deux tests, aucun ne peut passer pour l'autre.
       */
      it('update — refusée, même sur sa propre ligne (ajout seul)', async () => {
        await asOwnerOfA()

        for (const [label, id] of [
          ['la ligne du commerce B', foreign()],
          ['sa propre ligne', own()],
        ] as const) {
          const changed = await attempt(client, touch(id))
          expect(changed.ok, `RATURE — ${label} a été modifiée`).toBe(false)
          if (changed.ok) continue
          expect(changed.code, `refusée, mais pas par le privilège : ${changed.message}`).toBe(
            INSUFFICIENT_PRIVILEGE,
          )
        }
      })

      it('delete — refusée, même sur sa propre ligne (ajout seul)', async () => {
        await asOwnerOfA()

        for (const [label, id] of [
          ['la ligne du commerce B', foreign()],
          ['sa propre ligne', own()],
        ] as const) {
          const removed = await attempt(client, erase(id))
          expect(removed.ok, `RATURE — ${label} a été supprimée`).toBe(false)
          if (removed.ok) continue
          expect(removed.code, `refusée, mais pas par le privilège : ${removed.message}`).toBe(
            INSUFFICIENT_PRIVILEGE,
          )
        }
      })

      /* Le contrôle positif déplacé, dans le sens que le registre indique. */
      it(`insert — chez soi, ${appendOnly === 'application' ? 'acceptée' : 'réservée au helper'}`, async () => {
        await asOwnerOfA()

        const written = await attempt(
          client,
          seeded.insertSql(table, seeded.tenants.a, seeded.rows.a),
        )

        if (appendOnly === 'application') {
          expect(
            written.ok,
            `ajout seul, mais on n'ajoute plus : ${written.ok ? '' : `${written.code} ${written.message}`}`,
          ).toBe(true)
          return
        }

        expect(written.ok, 'FUITE — une ligne a été écrite hors du helper').toBe(false)
        if (written.ok) return
        expect(written.code, `refusée, mais pas par le privilège : ${written.message}`).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
      })
    }

    it('insert — refuse une ligne destinée au commerce du voisin', async () => {
      await asOwnerOfA()

      const written = await attempt(
        client,
        seeded.insertSql(table, seeded.tenants.b, seeded.rows.b),
      )

      expect(written.ok, 'FUITE — une ligne a été écrite dans le commerce B').toBe(false)
      if (written.ok) return
      expect(written.code, `refusée, mais pas par la RLS : ${written.message}`).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })

    it('super_admin — voit les deux commerces', async () => {
      await actAs(client, tokenFor(seeded.tenants.a, 'super_admin'))

      const both = await client.query(`select id from public."${table}" where id = any($1)`, [
        [own(), foreign()],
      ])
      expect(both.rowCount).toBe(2)
    })

    /*
     * Un jeton sans tenant est le mode de défaillance qui compte le plus. Une
     * policy retirée se voit dans le catalogue ; une policy présente dont
     * l'expression s'évalue à vrai quand le claim est absent ne se voit nulle
     * part, et ouvre la base entière à toute session authentifiée.
     *
     * Les quatre opérations, pas seulement la lecture : `using` et `with check`
     * sont deux expressions distinctes, et rien ne garantit qu'une erreur faite
     * sur l'une l'ait été sur l'autre.
     */
    it.each(EMPTY_CLAIMS)('jeton sans tenant ($label) — ne peut rien faire', async ({ claims }) => {
      await actAs(client, claims)

      const read = await client.query(`select id from public."${table}"`)
      expect(read.rowCount, 'FUITE — un jeton sans tenant lit des lignes').toBe(0)

      /*
       * Sur une table en ajout seul, le privilège manque : la requête est
       * refusée au lieu de ne toucher aucune ligne. Les deux disent « rien n'a
       * bougé » ; on les distingue plutôt que de les confondre, sinon un jour
       * un `rowCount` de 0 obtenu pour une raison qui n'est pas la bonne
       * passerait inaperçu.
       */
      const updated = await attempt(client, touch(own()))
      const deleted = await attempt(client, erase(own()))

      if (appendOnly === undefined) {
        expect(updated.ok && updated.rowCount === 0, 'FUITE — un jeton sans tenant modifie').toBe(
          true,
        )
        expect(deleted.ok && deleted.rowCount === 0, 'FUITE — un jeton sans tenant supprime').toBe(
          true,
        )
      } else {
        expect(updated.ok, 'FUITE — un jeton sans tenant modifie').toBe(false)
        expect(deleted.ok, 'FUITE — un jeton sans tenant supprime').toBe(false)
      }

      const written = await attempt(client, seeded.insertSql(table, seeded.tenants.a, seeded.rows.a))
      expect(written.ok, 'FUITE — un jeton sans tenant écrit des lignes').toBe(false)
      if (written.ok) return
      expect(written.code, `refusée, mais pas par la RLS : ${written.message}`).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })

    it('anon — n\'a même pas le privilège de lire', async () => {
      await actAs(client, null, 'anon')

      const read = await attempt(client, `select id from public."${table}"`)
      expect(read.ok, 'FUITE — anon lit une table métier').toBe(false)
      if (read.ok) return
      expect(read.code).toBe(INSUFFICIENT_PRIVILEGE)
    })
  })

  /*
   * Le delete sur sa propre ligne est groupé ici, et en dernier : il faut le
   * faire dans l'ordre inverse des dépendances, sinon c'est une clé étrangère
   * qui refuse, pas une policy — et le test mesurerait autre chose.
   */
  it('un utilisateur peut supprimer dans son propre commerce', async () => {
    await actAs(client, tokenFor(seeded.tenants.a, 'owner'))
    await client.query('savepoint delete_own')

    for (const table of seeded.order.slice().reverse()) {
      const id = required(seeded.rows.a.get(table), table)

      /*
       * Une table en ajout seul n'a rien à faire dans ce contrôle : son refus
       * est la propriété testée plus haut. Sa ligne est pourtant ôtée ici, en
       * tant que `postgres` et garde levé le temps de la requête, parce qu'elle
       * tient des clés étrangères sur les tables que la boucle va suivre —
       * `app_user`, pour `audit_log`. Sans cela, la suppression suivante
       * buterait sur une contrainte, et le test mesurerait un schéma là où il
       * croit mesurer une policy.
       *
       * Le garde est levé sans être nommé (`session_replication_role`) : ce
       * bloc ne doit pas dépendre de la façon dont l'ajout seul est posé,
       * sinon retirer le garde ferait rougir ce test-ci — qui parle d'autre
       * chose — au lieu du sien.
       */
      if (APPEND_ONLY.has(table)) {
        await client.query('reset role')
        await client.query('set session_replication_role = replica')
        await client.query(`delete from public."${table}" where id = $1`, [id])
        await client.query('set session_replication_role = origin')
        await actAs(client, tokenFor(seeded.tenants.a, 'owner'))
        continue
      }

      const mine = await attempt(client, `delete from public."${table}" where id = '${id}'::uuid`)

      expect(
        mine.ok,
        `${table} : la suppression a échoué — ${mine.ok ? '' : `${mine.code} ${mine.message}`}`,
      ).toBe(true)
      if (!mine.ok) continue
      expect(mine.rowCount, `${table} : la policy refuse une suppression légitime`).toBe(1)
    }

    await client.query('rollback to savepoint delete_own')
  })
})

function required(id: string | undefined, table: string): string {
  if (id === undefined) throw new Error(`${table} : aucune ligne peuplée`)
  return id
}
