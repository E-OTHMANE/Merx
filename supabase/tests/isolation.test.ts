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
  DERIVED_WRITE,
  EMPTY_CLAIMS,
  ISOLATION_RULES,
  INSUFFICIENT_PRIVILEGE,
  actAs,
  appendOnlyTables,
  attempt,
  auditedTables,
  derivedTables,
  isolationViolations,
  registeredTables,
  seedTwoTenants,
  tokenFor,
  withoutTriggers,
  type IsolationRuleName,
  type Seeded,
  type TenantRows,
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

/*
 * Et le registre d'audit (RÈGLE M8-1, addendum E2-03) : une table journalisée
 * refuse toute écriture sans auteur dans le jeton, et les claims de ce balayage
 * n'en portent pas. Voir le contrôle de suppression, en fin de fichier.
 */
const AUDITED = await auditedUnderTest()

/*
 * Et le registre des tables dérivées (RÈGLE M2-1, E3-01) : un agrégat n'est
 * écrit que par le trigger de sa table source, donc son `owner` ne modifie ni
 * ne supprime sa propre ligne. Là encore aucune table n'est nommée ici.
 */
const DERIVED = await derivedUnderTest()

async function auditedUnderTest(): Promise<Set<string>> {
  const client = await connect()
  try {
    return await auditedTables(client)
  } finally {
    await client.end()
  }
}

async function derivedUnderTest(): Promise<Set<string>> {
  const client = await connect()
  try {
    return await derivedTables(client)
  } finally {
    await client.end()
  }
}

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

  /*
   * Chaque requête du balayage passe par `attempt()`, donc par un point de
   * sauvegarde, et rend le nombre de lignes touchées — ou, si elle lève, son
   * code et son message, que l'assertion affiche.
   *
   * Le balayage tourne dans une seule transaction. Sans ce point, la première
   * erreur l'avortait, et toutes les tables suivantes tombaient sur « current
   * transaction is aborted » : `warehouse` rouge à cause de `variant_cost`.
   * Mesuré en E2-04 : un garde du journal retiré faisait tomber 27 tests, dont
   * 25 en cascade — un décompte qui ne nommait plus la bonne table, et que
   * chaque table ajoutée aurait grossi. Un garde retiré, un test tombe, sur sa
   * table (BACKLOG E0-03).
   */
  const rowsTouched = async (sql: string): Promise<number | string> => {
    const result = await attempt(client, sql)
    return result.ok ? result.rowCount : `${result.code} ${result.message}`
  }

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
     * Toute tentative d'insertion passe par un point de sauvegarde, relâché
     * dans tous les cas — succès compris.
     *
     * Une insertion qui réussit alors qu'elle devait être refusée laisse une
     * ligne derrière elle, et sur une table source elle en engendre d'autres
     * par trigger : la ligne d'agrégat de `stock_level`, demain les écritures
     * de E4. Les cas suivants tombent alors sur un état qu'ils n'ont pas
     * produit, et le décompte ne nomme plus la bonne cause. Mesuré sur le
     * sabotage « garde du fermé par défaut retiré » : 8 tests rouges dont 1 en
     * cascade, 7 après ce point de sauvegarde (BACKLOG E0-03).
     */
    const tryInsert = async (
      tenant: string,
      rows: TenantRows,
    ): ReturnType<typeof attempt> => {
      await client.query('savepoint insert_attempt')
      const outcome = await attempt(client, seeded.insertSql(table, tenant, rows))
      await client.query('rollback to savepoint insert_attempt')
      return outcome
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

    /*
     * E3-01. Une table dérivée n'a aucun écrivain applicatif : son `owner` ne
     * modifie ni ne supprime sa propre ligne, et n'en insère pas non plus. Le
     * contrôle positif se déplace là encore sur le `select`.
     *
     * Elle ne se confond pas avec l'ajout seul, et la différence est ce que ces
     * tests mesurent : le privilège d'écriture reste accordé — le trigger
     * d'agrégat en a besoin — donc une ligne du voisin, qui n'est pas visible,
     * ne fait tomber aucun garde. Les assertions de fuite sont donc les mêmes
     * que sur une table ordinaire, et seule l'écriture chez soi diffère : elle
     * est refusée, en `55000`, par le garde de ligne.
     */
    const derived = DERIVED.has(table)

    it('select — voit sa ligne, ignore celle du voisin', async () => {
      await asOwnerOfA()

      const read = (id: string): string =>
        `select id from public."${table}" where id = '${id}'::uuid`

      expect(await rowsTouched(read(own())), 'sa propre ligne est invisible').toBe(1)
      expect(await rowsTouched(read(foreign())), 'FUITE — la ligne du commerce B est lisible').toBe(0)
    })

    const touch = (id: string): string =>
      `update public."${table}" set updated_at = updated_at where id = '${id}'::uuid`

    const erase = (id: string): string => `delete from public."${table}" where id = '${id}'::uuid`

    if (derived) {
      it('update — ne touche pas la ligne du voisin, refusée sur la sienne (agrégat)', async () => {
        await asOwnerOfA()

        expect(
          await rowsTouched(touch(foreign())),
          'FUITE — la ligne du commerce B est modifiable',
        ).toBe(0)

        const changed = await attempt(client, touch(own()))
        expect(changed.ok, 'RATURE — un agrégat a été modifié à la main').toBe(false)
        if (changed.ok) return
        expect(changed.code, `refusée, mais pas par le garde d'agrégat : ${changed.message}`).toBe(
          DERIVED_WRITE,
        )
      })

      it('delete — ne supprime ni la ligne du voisin ni la sienne (agrégat)', async () => {
        await asOwnerOfA()

        expect(
          await rowsTouched(erase(foreign())),
          'FUITE — la ligne du commerce B est supprimable',
        ).toBe(0)

        /*
         * Point de sauvegarde relâché dans tous les cas, succès compris : si le
         * garde manquait, la ligne partirait pour de bon, et les cas suivants
         * tomberaient en cascade sur une ligne absente — un décompte qui ne
         * nomme plus la bonne cause (BACKLOG E0-03).
         */
        await client.query('savepoint derived_delete')
        const removed = await attempt(client, erase(own()))
        await client.query('rollback to savepoint derived_delete')

        expect(removed.ok, 'RATURE — un agrégat a été supprimé à la main').toBe(false)
        if (removed.ok) return
        expect(removed.code, `refusée, mais pas par le garde d'agrégat : ${removed.message}`).toBe(
          DERIVED_WRITE,
        )
      })

      /*
       * Pas d'assertion « insert chez soi refusée » ici, et c'est une décision.
       * Le générateur réutilise les lignes parentes qu'il a semées, donc la
       * ligne qu'il fabriquerait vise la paire que la ligne d'agrégat déjà
       * semée occupe : l'unicité refuse (`23505`) avant que le garde ait à se
       * prononcer. L'assertion passerait au vert sur le refus du voisin, et le
       * garde pourrait disparaître sans la faire tomber (CLAUDE.md).
       *
       * Le refus d'insertion du garde est donc mesuré là où une paire vierge
       * est disponible : `stock-movements.test.ts`. Ici, l'inversion du
       * contrôle positif tient aux deux cas ci-dessus et au `select`.
       */
    } else if (appendOnly === undefined) {
      it('update — ne touche pas la ligne du voisin, touche la sienne', async () => {
        await asOwnerOfA()

        expect(
          await rowsTouched(touch(foreign())),
          'FUITE — la ligne du commerce B est modifiable',
        ).toBe(0)
        expect(
          await rowsTouched(touch(own())),
          'la policy refuse aussi les écritures légitimes',
        ).toBe(1)
      })

      it('delete — ne supprime pas la ligne du voisin', async () => {
        await asOwnerOfA()

        expect(
          await rowsTouched(erase(foreign())),
          'FUITE — la ligne du commerce B est supprimable',
        ).toBe(0)
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
      it(`insert — chez soi, ${appendOnly === 'application' ? 'acceptée' : `refusée (${appendOnly})`}`, async () => {
        await asOwnerOfA()

        const written = await tryInsert(seeded.tenants.a, seeded.rows.a)

        if (appendOnly === 'application') {
          expect(
            written.ok,
            `ajout seul, mais on n'ajoute plus : ${written.ok ? '' : `${written.code} ${written.message}`}`,
          ).toBe(true)
          return
        }

        expect(
          written.ok,
          appendOnly === 'helper'
            ? 'FUITE — une ligne a été écrite hors du helper'
            : 'FUITE — une ligne a été écrite sans que sa colonne qualifiante soit ouverte',
        ).toBe(false)
        if (written.ok) return
        expect(written.code, `refusée, mais pas pour défaut de droit : ${written.message}`).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
      })
    }

    it('insert — refuse une ligne destinée au commerce du voisin', async () => {
      await asOwnerOfA()

      const written = await tryInsert(seeded.tenants.b, seeded.rows.b)

      expect(written.ok, 'FUITE — une ligne a été écrite dans le commerce B').toBe(false)
      if (written.ok) return
      expect(written.code, `refusée, mais pas par la RLS : ${written.message}`).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })

    it('super_admin — voit les deux commerces', async () => {
      await actAs(client, tokenFor(seeded.tenants.a, 'super_admin'))

      expect(
        await rowsTouched(
          `select id from public."${table}" where id in ('${own()}'::uuid, '${foreign()}'::uuid)`,
        ),
        'l’éditeur ne voit pas les deux commerces',
      ).toBe(2)
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

      expect(
        await rowsTouched(`select id from public."${table}"`),
        'FUITE — un jeton sans tenant lit des lignes',
      ).toBe(0)

      /*
       * Sur une table en ajout seul, le privilège manque : la requête est
       * refusée au lieu de ne toucher aucune ligne. Les deux disent « rien n'a
       * bougé » ; on les distingue plutôt que de les confondre, sinon un jour
       * un `rowCount` de 0 obtenu pour une raison qui n'est pas la bonne
       * passerait inaperçu.
       *
       * Sur une table dérivée, en revanche, le privilège est intact et la ligne
       * n'est pas visible : aucune ligne n'est touchée, aucun garde ne
       * s'exécute, et les attentes sont celles d'une table ordinaire.
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

      const written = await tryInsert(seeded.tenants.a, seeded.rows.a)
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
      /*
       * Une table dérivée refuse la suppression pour une autre raison — le
       * garde d'agrégat, et non le privilège (RÈGLE M2-1) — mais la conclusion
       * est la même : sa ligne n'a rien à faire dans ce contrôle positif, et
       * elle est ôtée garde levé pour que la boucle puisse continuer.
       */
      if (APPEND_ONLY.has(table) || DERIVED.has(table)) {
        await client.query('reset role')
        await client.query('set session_replication_role = replica')
        const removed = await rowsTouched(`delete from public."${table}" where id = '${id}'::uuid`)
        await client.query('set session_replication_role = origin')
        expect(removed, `${table} : ménage de la ligne gardée impossible`).toBe(1)
        await actAs(client, tokenFor(seeded.tenants.a, 'owner'))
        continue
      }

      /*
       * Une table journalisée refuse toute écriture sans auteur (RÈGLE M8-1),
       * et ces claims n'en portent pas : la suppression tomberait sur le
       * journal (`23502`), pas sur une policy. Elle est donc faite sous les
       * mêmes claims — la policy reste ce qui décide — mais triggers suspendus.
       * Le journal lui-même est éprouvé sur le chemin réel, dans
       * `purchase-price-audit.test.ts`.
       */
      if (AUDITED.has(table)) {
        await client.query('reset role')
        await withoutTriggers(client, async () => {
          await actAs(client, tokenFor(seeded.tenants.a, 'owner'))
          const mine = await attempt(client, `delete from public."${table}" where id = '${id}'::uuid`)
          expect(
            mine.ok && mine.rowCount === 1,
            `${table} : la policy refuse une suppression légitime — ${mine.ok ? mine.rowCount : `${mine.code} ${mine.message}`}`,
          ).toBe(true)
          await client.query('reset role')
        })
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
