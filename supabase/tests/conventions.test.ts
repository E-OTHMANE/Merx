// @vitest-environment node

/*
 * E0-02 — les conventions de schéma, vérifiées sur la base réelle.
 *
 * Ces tests demandent le stack local : `npx supabase start`, puis
 * `npx supabase db reset`. Ils échouent bruyamment si la base est absente.
 * Un test de convention qui se saute tout seul laisserait la suite passer au
 * vert sans avoir rien vérifié — SPEC § 2.7, RÈGLE tests.
 *
 * Aujourd'hui `public` ne contient aucune table : les balayages sont vides.
 * Le dernier bloc le compense en soumettant aux mêmes règles une table
 * conforme et une table fautive, dans une transaction annulée. Sans lui, on
 * n'aurait que la promesse d'un contrôle.
 */

import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  RULES,
  describe as describeViolations,
  violations,
  type RuleName,
  type Violation,
} from './conventions'

/*
 * Les tests d'auto-contrôle ne parlent que de leur propre table. Sans ce
 * filtre, une infraction réelle ailleurs dans `public` les ferait échouer eux
 * aussi, et le rapport désignerait le mauvais coupable : c'est au bloc
 * « schéma public » de signaler le schéma réel.
 */
function onProbe(found: readonly Violation[], table: string): Violation[] {
  return found.filter((v) => v.table_name === table)
}

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url))

let client: Client

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
})

afterAll(async () => {
  await client?.end()
})

/*
 * E0-02 demandait « une seule migration initiale, relisible » : les conventions
 * arrivent d'un bloc, pas en douze fragments qu'il faudrait recoudre pour
 * comprendre le schéma. Les migrations suivantes s'ajoutent normalement — elles
 * sont en ajout seul, comme tout le reste du projet (SPEC § 2.5).
 */
describe('migrations', () => {
  it('partent d\'une migration initiale unique', () => {
    const migrations = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()

    expect(migrations[0]).toMatch(/^\d{14}_init\.sql$/)
    expect(migrations.filter((file) => file.endsWith('_init.sql'))).toHaveLength(1)
  })

  it('sont horodatées, donc ordonnées sans ambiguïté', () => {
    const migrations = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'))

    for (const migration of migrations) {
      expect(migration).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/)
    }
  })
})

describe('domaines numériques', () => {
  it('money_amount est numeric(12,2) et quantity numeric(12,3)', async () => {
    const { rows } = await client.query<{ typname: string; base: string }>(`
      select t.typname, format_type(t.typbasetype, t.typtypmod) as base
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
      where t.typtype = 'd' and t.typname in ('money_amount', 'quantity')
      order by 1
    `)

    expect(rows).toEqual([
      { typname: 'money_amount', base: 'numeric(12,2)' },
      { typname: 'quantity', base: 'numeric(12,3)' },
    ])
  })
})

describe('schéma public', () => {
  for (const rule of Object.keys(RULES) as RuleName[]) {
    it(`respecte la règle : ${rule}`, async () => {
      const found = await violations(client, rule)
      expect(describeViolations(found)).toBe('')
    })
  }
})

/*
 * Les règles savent-elles dire non ? On les confronte à deux tables créées
 * puis annulées : l'une passée par les fonctions de convention, l'autre écrite
 * comme on écrirait sans les lire.
 */
describe('les règles attrapent une table fautive', () => {
  afterEach(async () => {
    await client.query('rollback')
  })

  it('laisse passer une table conforme', async () => {
    await client.query('begin')
    await client.query(`
      create table public.compliant_probe (id uuid primary key default gen_random_uuid());
      select merx.apply_reference_conventions('public.compliant_probe');
      alter table public.compliant_probe
        add column unit_price money_amount,
        add column on_hand    quantity;
    `)

    for (const rule of Object.keys(RULES) as RuleName[]) {
      const found = await violations(client, rule)
      expect(describeViolations(onProbe(found, 'compliant_probe')), `règle : ${rule}`).toBe('')
    }
  })

  it('signale chaque écart d\'une table écrite sans les conventions', async () => {
    await client.query('begin')
    await client.query(`
      create table public.rogue_probe (
        id         bigserial primary key,
        unit_price numeric(12, 2),
        ratio      double precision,
        counted_at timestamp
      );
    `)

    // Hors registre : la première règle suffit à la voir. On ne regarde que
    // notre propre sonde — c'est au bloc « schéma public » de signaler les
    // autres infractions, et ce test ne doit pas dépendre de leur absence.
    expect(onProbe(await violations(client, 'table non enregistrée'), 'rogue_probe')).toHaveLength(1)

    // On l'enregistre de force, pour soumettre la table aux règles suivantes.
    await client.query(
      "insert into merx.convention_registry (table_name, kind) values ('rogue_probe', 'reference')",
    )

    const expected: RuleName[] = [
      'clé primaire uuid générée',
      'colonnes standard',
      'trigger updated_at',
      'deleted_at sur les tables de référence',
      'aucun flottant',
      'aucun numeric nu',
      'aucune date sans fuseau',
      'tenant_id par défaut du jeton',
    ]

    for (const rule of expected) {
      const found = onProbe(await violations(client, rule), 'rogue_probe')
      expect(found.length, `règle non déclenchée : ${rule}`).toBeGreaterThan(0)
    }
  })

  /*
   * E2-01, SPEC § 4. La même table témoin porte une clé fautive et une clé
   * conforme vers la même cible : la règle doit désigner la première, et
   * seulement elle. Sans le second volet, une règle qui signalerait toute clé
   * étrangère passerait ce test aussi.
   */
  it('signale une clé étrangère entre tables métier qui ne porte pas tenant_id', async () => {
    await client.query('begin')
    await client.query(`
      create table public.fk_probe (id uuid primary key default gen_random_uuid());
      select merx.apply_reference_conventions('public.fk_probe');
      alter table public.fk_probe
        add column loose_user  uuid constraint fk_probe_loose_user  references public.app_user (id),
        add column scoped_user uuid,
        add constraint fk_probe_scoped_user
          foreign key (tenant_id, scoped_user) references public.app_user (tenant_id, id);
    `)

    const found = onProbe(await violations(client, 'clés étrangères composites sur tenant_id'), 'fk_probe')
    expect(describeViolations(found)).toContain('fk_probe_loose_user')
    expect(describeViolations(found)).not.toContain('fk_probe_scoped_user')
    // `created_by`, posé par les conventions, est conforme lui aussi.
    expect(found).toHaveLength(1)
  })

  /*
   * E2-01, SPEC § 2.3. Les deux formes de référence au produit : la clé
   * étrangère, et la colonne nue qui échappe à tout contrôle de contrainte. Le
   * contrôle positif est la table qui fait ce que la RÈGLE demande — pointer
   * sur la variante.
   */
  it('signale toute référence au produit hors de variant, et laisse passer variant_id', async () => {
    await client.query('begin')
    await client.query(`
      create table public.stock_probe (id uuid primary key default gen_random_uuid());
      select merx.apply_business_conventions('public.stock_probe');
      alter table public.stock_probe
        add column product_id uuid,
        add constraint stock_probe_product_fkey
          foreign key (tenant_id, product_id) references public.product (tenant_id, id);

      create table public.bare_probe (id uuid primary key default gen_random_uuid(), product_id uuid);
      select merx.apply_business_conventions('public.bare_probe');

      create table public.line_probe (id uuid primary key default gen_random_uuid());
      select merx.apply_business_conventions('public.line_probe');
      alter table public.line_probe
        add column variant_id uuid,
        add constraint line_probe_variant_fkey
          foreign key (tenant_id, variant_id) references public.variant (tenant_id, id);
    `)

    const found = await violations(client, 'aucune référence à product hors de variant')

    expect(describeViolations(onProbe(found, 'stock_probe'))).toContain('stock_probe_product_fkey')
    expect(describeViolations(onProbe(found, 'stock_probe'))).toContain('colonne product_id')
    expect(describeViolations(onProbe(found, 'bare_probe'))).toContain('colonne product_id')
    expect(onProbe(found, 'line_probe')).toEqual([])
  })

  /*
   * E2-03, SPEC § 3 — RÈGLE de placement des coûts. `variant_cost` est la
   * relation du prix d'achat, passée à `merx.apply_capability_restriction(...,
   * 'view_cost')` ; le jour où un `cost_price` apparaît sur `variant` — la table
   * que tout le commerce lit —, le balayage le nomme. Le contrôle positif est
   * l'état réel du schéma : aucune infraction, `variant_cost` comprise.
   */
  it('tient variant_cost pour la relation du coût, et signale un cost_price posé sur variant', async () => {
    const { rows } = await client.query<{ capability: string }>(
      "select capability from merx.confidential_registry where table_name = 'variant_cost'",
    )
    expect(rows).toEqual([{ capability: 'view_cost' }])

    const rule: RuleName = 'coûts et marges sur relation restreinte'
    expect(describeViolations(await violations(client, rule))).toBe('')

    await client.query('begin')
    await client.query('alter table public.variant add column cost_price public.money_amount')
    const found = onProbe(await violations(client, rule), 'variant')
    expect(describeViolations(found)).toContain('cost_price')
  })

  /*
   * E2-02. Le contrôle positif est la table que les conventions fabriquent ;
   * le négatif, la même privée de son défaut.
   */
  it('signale une table dont tenant_id ne vient plus du jeton', async () => {
    await client.query('begin')
    await client.query(`
      create table public.tenant_default_probe (id uuid primary key default gen_random_uuid());
      select merx.apply_business_conventions('public.tenant_default_probe');
    `)

    const rule: RuleName = 'tenant_id par défaut du jeton'
    expect(onProbe(await violations(client, rule), 'tenant_default_probe')).toEqual([])

    await client.query('alter table public.tenant_default_probe alter column tenant_id drop default')
    const found = onProbe(await violations(client, rule), 'tenant_default_probe')
    expect(describeViolations(found)).toContain('défaut (aucun)')
  })

  /*
   * E3-01, SPEC RÈGLE M2-1. `stock_level` est la première table dérivée, et le
   * contrôle positif est l'état réel du schéma : le registre la connaît, et
   * aucun de ses gardes ne manque.
   *
   * Le négatif porte sur une sonde, et sur le **moment** du garde d'INSERT. Le
   * remplacer par un BEFORE n'en retire rien d'apparent — la ligne est refusée
   * dans les deux cas — mais en BEFORE il refuse avant la RLS, donc il tient
   * lieu d'isolation et retirer `tenant_isolation` ne se verrait plus
   * (CLAUDE.md). Une règle qui ne vérifierait que la présence passerait ce
   * test ; celle-ci doit nommer l'écart.
   */
  describe('gardes des tables dérivées', () => {
    const rule: RuleName = 'gardes des tables dérivées'

    const createDerivedProbe = async (): Promise<void> => {
      await client.query('begin')
      await client.query(`
        create table public.derived_probe (id uuid primary key default gen_random_uuid());
        select merx.apply_business_conventions('public.derived_probe');

        create function merx.write_derived_probe()
        returns trigger language plpgsql as $probe$ begin return null; end; $probe$;

        select merx.apply_derived_from(
          'public.derived_probe', 'stock_movement', 'write_derived_probe');

        -- L'écrivain déclaré doit être branché : une table dérivée dont
        -- personne n'appelle l'écrivain ne se remplit plus (E3-02).
        create trigger write_derived_probe
          after insert on public.stock_movement
          for each row execute function merx.write_derived_probe();
      `)
    }

    it('connaît stock_level et ses gardes', async () => {
      const { rows } = await client.query<{ source_table: string; writer_function: string }>(
        'select source_table, writer_function from merx.derived_registry' +
          " where table_name = 'stock_level'",
      )
      expect(rows).toEqual([
        { source_table: 'stock_movement', writer_function: 'maintain_stock_level' },
      ])

      expect(describeViolations(await violations(client, rule))).toBe('')
    })

    it('laisse passer une table posée par le helper', async () => {
      await createDerivedProbe()
      expect(onProbe(await violations(client, rule), 'derived_probe')).toEqual([])
    })

    /*
     * Le registre nomme la fonction, pas ses triggers. Sans ces deux cas,
     * `maintain_stock_level` pouvait être débranché ou éteint sans qu'aucune
     * règle ne bouge — et les lignes de stock cessaient de s'ouvrir en
     * silence. Débranché n'est pas éteint, et les deux messages le disent :
     * on ne répare pas l'un comme l'autre.
     */
    it('signale un écrivain déclaré que plus aucun trigger n’appelle', async () => {
      await createDerivedProbe()
      await client.query('drop trigger write_derived_probe on public.stock_movement')

      const found = onProbe(await violations(client, rule), 'derived_probe')
      expect(describeViolations(found)).toContain('branché à aucun trigger')
    })

    it('signale un trigger d’écrivain désactivé, en le nommant', async () => {
      await createDerivedProbe()
      await client.query(
        'alter table public.stock_movement disable trigger write_derived_probe',
      )

      const found = onProbe(await violations(client, rule), 'derived_probe')
      const detail = describeViolations(found)
      expect(detail).toContain('write_derived_probe')
      expect(detail).toContain('stock_movement')
      expect(detail).toContain('désactivé')
      expect(detail).not.toContain('branché à aucun trigger')
    })

    it('signale un garde d\'INSERT posé en BEFORE au lieu d\'AFTER', async () => {
      await createDerivedProbe()
      await client.query('drop trigger reject_derived_insert on public.derived_probe')
      await client.query(`
        create trigger reject_derived_insert before insert on public.derived_probe
          for each row execute function merx.reject_derived_write()
      `)

      const found = onProbe(await violations(client, rule), 'derived_probe')
      expect(describeViolations(found)).toContain('AFTER INSERT')
    })

    it('signale le garde de TRUNCATE manquant', async () => {
      await createDerivedProbe()
      await client.query('drop trigger reject_derived_truncate on public.derived_probe')

      const found = onProbe(await violations(client, rule), 'derived_probe')
      expect(describeViolations(found)).toContain('BEFORE TRUNCATE')
    })

    it('signale TRUNCATE laissé à authenticated', async () => {
      await createDerivedProbe()
      await client.query('grant truncate on public.derived_probe to authenticated')

      const found = onProbe(await violations(client, rule), 'derived_probe')
      expect(describeViolations(found)).toContain('TRUNCATE')
    })

    it('signale un écrivain déclaré introuvable', async () => {
      await createDerivedProbe()
      await client.query(
        "update merx.derived_registry set writer_function = 'absente'" +
          " where table_name = 'derived_probe'",
      )

      const found = onProbe(await violations(client, rule), 'derived_probe')
      expect(describeViolations(found)).toContain('merx.absente()')
    })
  })

  /*
   * L'inverse. Le registre n'est pas une étiquette : `isolation.test.ts` le lit
   * pour savoir qu'il doit inverser son contrôle positif sur cette table-là.
   * Une table rendue dérivée à la main y échapperait, et le désaccord se lirait
   * comme une régression de policy. Même raisonnement qu'en E1-04.
   */
  it('signale une table gardée comme dérivée sans inscription au registre', async () => {
    await client.query('begin')
    await client.query(`
      create table public.rogue_derived_probe (id uuid primary key default gen_random_uuid());
      select merx.apply_business_conventions('public.rogue_derived_probe');
      create trigger reject_derived_write before update or delete on public.rogue_derived_probe
        for each row execute function merx.reject_derived_write();
    `)

    const found = onProbe(
      await violations(client, 'aucune table dérivée hors registre'),
      'rogue_derived_probe',
    )
    expect(describeViolations(found)).toContain('merx.apply_derived_from()')
  })

  /*
   * E3-01, SPEC RÈGLE M2-1. `pg_trigger_depth()` dit « écrit par un trigger »,
   * pas « écrit par le trigger d'agrégat » : une seconde fonction qui écrirait
   * dans `stock_level` depuis un trigger — sur `sale_line` en E4, sur
   * `goods_receipt_line` en E8 — passerait le garde, et deux endroits
   * décideraient de la valeur d'un agrégat. C'est ce balayage qui le refuse.
   *
   * Le contrôle positif est l'état réel du schéma : l'écrivain déclaré écrit
   * dans `stock_level` et n'est pas signalé.
   */
  it('signale une autre fonction que l\'écrivain déclaré qui écrit dans un agrégat', async () => {
    const rule: RuleName = 'aucun autre écrivain d\'une table dérivée'
    expect(describeViolations(await violations(client, rule))).toBe('')

    await client.query('begin')
    await client.query(`
      create function merx.rogue_stock_writer(level_id uuid)
      returns void language sql as $probe$
        update public.stock_level set quantity = 0 where id = level_id
      $probe$;
    `)

    const found = await violations(client, rule)
    expect(describeViolations(found)).toContain('merx.rogue_stock_writer')
    expect(describeViolations(found)).toContain('merx.maintain_stock_level()')
  })

  /*
   * E4-01, SPEC RÈGLE M3-3. Même limite, un étage plus bas :
   * `merx.require_cancellation_origin()` sait qu'un trigger écrit, pas lequel.
   * Une seconde fonction qui insérerait un `sale_cancellation` depuis un
   * trigger passerait son garde, et le stock se corrigerait sans entrée de
   * journal. Le contrôle positif est l'état réel du schéma : l'inversion
   * déclarée insère ce type et n'est pas signalée.
   */
  it("signale une autre fonction que l'inversion qui insère un sale_cancellation", async () => {
    const rule: RuleName = "aucun autre écrivain d'un mouvement d'annulation"
    expect(describeViolations(await violations(client, rule))).toBe('')

    await client.query('begin')
    await client.query(`
      create function merx.rogue_cancellation_writer(variant uuid, depot uuid)
      returns void language sql as $probe$
        insert into public.stock_movement
          (tenant_id, variant_id, warehouse_id, movement_type, quantity)
        values (merx.current_tenant_id(), variant, depot, 'sale_cancellation', 1)
      $probe$;
    `)

    const found = await violations(client, rule)
    expect(describeViolations(found)).toContain('merx.rogue_cancellation_writer')
    expect(describeViolations(found)).toContain('merx.reverse_sale_movements()')
  })

  /*
   * E4-05, SPEC RÈGLE M2-5. La règle d'E4-01 ci-dessus tient parce que
   * `sale_cancellation` est un mot distinctif : `sale` ne l'est pas, et un
   * balayage qui chercherait le littéral *transtypé* se contournerait **en
   * écrivant moins** — `movement_type = 'sale'` sans transtypage, que Postgres
   * accepte. Le témoin insère donc un `'sale'` **nu**, et c'est le registre
   * `merx.movement_writer`, non le littéral, qui doit le nommer.
   *
   * Le second témoin est le registre périmé, dans l'autre sens : un écrivain
   * déclaré introuvable fait nommer la vraie fonction par le premier volet sans
   * que rien ne dise pourquoi.
   *
   * Le contrôle positif est l'état réel du schéma : les deux écrivains déclarés
   * insèrent dans `stock_movement` et ne sont pas signalés.
   */
  it('signale une fonction non déclarée qui insère un mouvement, littéral nu compris', async () => {
    const rule: RuleName = 'aucun écrivain de mouvement non déclaré'
    expect(describeViolations(await violations(client, rule))).toBe('')

    await client.query('begin')
    await client.query(`
      create function merx.rogue_sale_writer(variant uuid, depot uuid)
      returns void language sql as $probe$
        insert into public.stock_movement
          (tenant_id, variant_id, warehouse_id, movement_type, quantity)
        values (merx.current_tenant_id(), variant, depot, 'sale', -1)
      $probe$;
    `)

    const found = await violations(client, rule)
    expect(describeViolations(found)).toContain('merx.rogue_sale_writer')
    expect(describeViolations(found)).toContain('merx.movement_writer')
  })

  it('signale un écrivain déclaré introuvable', async () => {
    const rule: RuleName = 'aucun écrivain de mouvement non déclaré'

    await client.query('begin')
    await client.query(
      "insert into merx.movement_writer (function_name, movement_type)" +
        " values ('write_phantom_movements', 'sale')",
    )

    const found = await violations(client, rule)
    expect(describeViolations(found)).toContain('write_phantom_movements')
    expect(describeViolations(found)).toContain('le registre est périmé')
  })

  /*
   * SPEC § 4, RÈGLE des refus en 4xx. Un garde qui lève un code inconnu de
   * PostgREST sort en `500`, et PowerSync rejouerait l'écriture sans fin (E9).
   * La fonction témoin lève `55000` — le code que les tables dérivées
   * levaient avant la correction, et dont le `500` a été mesuré.
   *
   * Le contrôle positif est l'état réel du schéma : plus aucun garde du projet
   * n'est signalé.
   */
  it("signale un garde qui lève un SQLSTATE rendu en 5xx", async () => {
    const rule: RuleName = 'aucun refus rendu en 5xx'
    expect(describeViolations(await violations(client, rule))).toBe('')

    await client.query('begin')
    await client.query(`
      create function merx.rogue_5xx_guard()
      returns void language plpgsql as $probe$
      begin
        raise exception 'refus qui se fera rejouer sans fin' using errcode = '55000';
      end;
      $probe$;
    `)

    const found = await violations(client, rule)
    expect(describeViolations(found)).toContain('merx.rogue_5xx_guard')
    expect(describeViolations(found)).toContain('55000')
  })

  /*
   * E2-02, SPEC § 2.6. Une table de formulaire conforme, puis chacune des trois
   * façons de rendre obligatoire autre chose que le nom — chacune doit être
   * nommée, et une colonne NOT NULL pourvue d'un vrai défaut ne doit pas
   * l'être.
   */
  describe('seul le nom est obligatoire à la création', () => {
    const rule: RuleName = 'seul le nom est obligatoire à la création'

    const createFormProbe = async (): Promise<void> => {
      await client.query('begin')
      await client.query(`
        create table public.form_probe (
          id        uuid    primary key default gen_random_uuid(),
          label     text    not null,
          note      text,
          is_active boolean not null default true
        );
        select merx.apply_reference_conventions('public.form_probe');
        select merx.register_creation_form('public.form_probe', 'label');
      `)
    }

    it('laisse passer une table dont seul le nom est obligatoire', async () => {
      await createFormProbe()
      expect(describeViolations(onProbe(await violations(client, rule), 'form_probe'))).toBe('')
    })

    it('signale une colonne NOT NULL sans défaut', async () => {
      await createFormProbe()
      await client.query('alter table public.form_probe add column brand text not null')

      const found = onProbe(await violations(client, rule), 'form_probe')
      expect(describeViolations(found)).toContain('brand : obligatoire sans défaut')
      expect(found).toHaveLength(1)
    })

    it('signale une colonne NOT NULL dont le défaut est NULL', async () => {
      await createFormProbe()
      await client.query('alter table public.form_probe add column unit text not null default null')

      const found = onProbe(await violations(client, rule), 'form_probe')
      expect(describeViolations(found)).toContain('unit : obligatoire sans défaut')
    })

    it('signale une contrainte check qui exige une valeur', async () => {
      await createFormProbe()
      await client.query(`
        alter table public.form_probe
          add constraint form_probe_note_required check (note is not null)
      `)

      const found = onProbe(await violations(client, rule), 'form_probe')
      expect(describeViolations(found)).toContain('form_probe_note_required')
    })

    it('signale un tenant_id privé de son défaut — la base le réclamerait', async () => {
      await createFormProbe()
      await client.query('alter table public.form_probe alter column tenant_id drop default')

      const found = onProbe(await violations(client, rule), 'form_probe')
      expect(describeViolations(found)).toContain('tenant_id : obligatoire sans défaut')
    })

    it('signale une colonne de nom devenue facultative', async () => {
      await createFormProbe()
      await client.query('alter table public.form_probe alter column label drop not null')

      const found = onProbe(await violations(client, rule), 'form_probe')
      expect(describeViolations(found)).toContain('colonne de nom label absente ou nullable')
    })

    it('refuse d’inscrire une colonne de nom qui n’existe pas', async () => {
      await createFormProbe()
      await expect(
        client.query("select merx.register_creation_form('public.form_probe', 'nom')"),
      ).rejects.toThrow('Colonne de nom inconnue : form_probe.nom')
    })
  })

  /*
   * E2-04, SPEC § 2.1 — l'exception nommée, et le registre qui l'empêche de
   * devenir une habitude. Chaque volet de la règle a sa fonction témoin, et
   * chaque témoin fautif son jumeau conforme : une règle qui signalerait toute
   * fonction `security definer` passerait les tests négatifs aussi.
   *
   * **`merx` y entre en E4-06**, avec trois formes de garde de plus. Le
   * balayage ne lisait que `public` — les seules fonctions que PostgREST expose
   * —, ce qui confondait « inappelable » et « inoffensive » : un garde de
   * trigger de `merx` tourne sous `postgres` comme le reste, et celui qui
   * oublierait son filtre lirait chez le voisin sans que rien ne le nomme. Le
   * témoin du bas est exactement cette fonction-là.
   */
  describe('fonctions security definer et registre des exceptions RLS', () => {
    const rule: RuleName = 'security definer inscrite et gardée'
    const onFunction = (found: readonly Violation[], name: string, schema = 'public') =>
      found.filter((v) => v.table_name === `${schema}.${name}`)

    /*
     * Liste exacte, et dans les deux schémas : une entrée de plus doit se lire
     * ici, pas s'ajouter en silence. Les six de `public` sont celles d'E2-04 à
     * E3-02 ; les douze de `merx` sont celles que la règle étendue a nommées en
     * E4-06 — six gardes de trigger, deux fonctions bornées par leur argument,
     * deux qui précèdent le commerce, et le journal.
     */
    it('inscrit exactement les dix-huit fonctions connues, chacune justifiée', async () => {
      const { rows } = await client.query<{
        schema_name: string
        function_name: string
        guard: string
        justified: boolean
      }>(`
        select schema_name, function_name, guard::text, btrim(justification) <> '' as justified
        from merx.rls_exception_registry order by schema_name, function_name
      `)

      const entry = (schema: string, name: string, guard: string) => ({
        schema_name: schema,
        function_name: name,
        guard,
        justified: true,
      })

      expect(rows).toEqual([
        entry('merx', 'current_app_user', 'auth_identity'),
        entry('merx', 'custom_access_token', 'auth_identity'),
        entry('merx', 'log_audit', 'current_tenant'),
        entry('merx', 'next_device_prefix', 'argument_tenant'),
        entry('merx', 'open_default_warehouse', 'row_tenant'),
        entry('merx', 'require_consistent_totals', 'row_tenant'),
        entry('merx', 'require_document_number_shape', 'row_tenant'),
        entry('merx', 'require_floor_price', 'row_tenant'),
        entry('merx', 'require_no_active_return', 'row_tenant'),
        entry('merx', 'require_returnable_quantity', 'row_tenant'),
        entry('merx', 'require_transformation_shape', 'row_tenant'),
        entry('merx', 'seed_tenant_settings', 'argument_tenant'),
        entry('public', 'create_tenant', 'super_admin'),
        entry('public', 'create_worker', 'current_tenant'),
        entry('public', 'list_stock_movements', 'current_tenant'),
        entry('public', 'register_device', 'current_tenant'),
        entry('public', 'search_products', 'current_tenant'),
        entry('public', 'set_user_active', 'current_tenant'),
      ])
    })

    /*
     * Le témoin demandé par l'arbitrage d'E4-06 : une fonction de **`merx`**,
     * `security definer`, qui lit une table métier **sans filtre de commerce**.
     * Avant l'extension, la règle ne la voyait pas — le balayage s'arrêtait à
     * `public`. Son jumeau conforme lit la même table en se bornant au
     * commerce du jeton, et n'est pas signalé : une règle qui nommerait toute
     * fonction definer de `merx` passerait ce test-ci aussi.
     */
    it('nomme une fonction definer de merx qui lit une table métier sans filtre de commerce', async () => {
      await client.query('begin')
      await client.query(`
        create function merx.rogue_merx_probe() returns bigint
        language sql security definer set search_path = ''
        as $probe$ select count(*) from public.product $probe$;

        create function merx.scoped_merx_probe() returns bigint
        language sql security definer set search_path = ''
        as $probe$
          select count(*) from public.product where tenant_id = merx.current_tenant_id()
        $probe$;
        select merx.register_rls_exception('merx.scoped_merx_probe()', 'current_tenant',
          'Témoin conforme de conventions.test.ts.');
      `)

      const found = await violations(client, rule)
      expect(describeViolations(onFunction(found, 'rogue_merx_probe', 'merx'))).toContain(
        'security definer, touche product hors RLS, absente de merx.rls_exception_registry',
      )
      // Le jumeau conforme, inscrit et filtré, ne dit rien.
      expect(onFunction(found, 'scoped_merx_probe', 'merx')).toEqual([])
    })

    /*
     * `row_tenant` est la forme des gardes de trigger : ils se bornent à la
     * **ligne écrite**, et non au commerce du jeton — qui est nul dans une
     * migration ou un peuplement. Le témoin fautif se dit `row_tenant` sans
     * rien borner ; son jumeau lit la même table par `new.tenant_id`.
     */
    it('nomme une fonction inscrite en row_tenant qui ne borne rien à new.tenant_id', async () => {
      await client.query('begin')
      await client.query(`
        create function merx.loose_row_probe() returns trigger
        language plpgsql security definer set search_path = ''
        as $probe$
        begin
          perform count(*) from public.product;
          return new;
        end;
        $probe$;
        select merx.register_rls_exception('merx.loose_row_probe()', 'row_tenant',
          'Témoin de conventions.test.ts : se dit borné à sa ligne, sans l''être.');

        create function merx.scoped_row_probe() returns trigger
        language plpgsql security definer set search_path = ''
        as $probe$
        begin
          perform count(*) from public.product p where p.tenant_id = new.tenant_id;
          return new;
        end;
        $probe$;
        select merx.register_rls_exception('merx.scoped_row_probe()', 'row_tenant',
          'Témoin conforme de conventions.test.ts.');
      `)

      const found = await violations(client, rule)
      expect(describeViolations(onFunction(found, 'loose_row_probe', 'merx'))).toContain(
        'inscrite en row_tenant, mais son corps ne borne rien à new.tenant_id',
      )
      expect(onFunction(found, 'scoped_row_probe', 'merx')).toEqual([])
    })

    /*
     * `new.id` ne vaut que pour un trigger posé sur `tenant`, dont la ligne
     * **est** le commerce — et c'est le catalogue qui le dit, pas la fonction
     * qui le prétend. Le témoin lit `new.id` sans être attaché à `tenant` : il
     * est nommé. Le contrôle positif est l'état réel du schéma,
     * `merx.open_default_warehouse()`, qui l'est.
     */
    it('n’admet new.id que pour un trigger posé sur tenant', async () => {
      await client.query('begin')
      await client.query(`
        create function merx.row_id_probe() returns trigger
        language plpgsql security definer set search_path = ''
        as $probe$
        begin
          perform count(*) from public.product p where p.id = new.id;
          return new;
        end;
        $probe$;
        select merx.register_rls_exception('merx.row_id_probe()', 'row_tenant',
          'Témoin de conventions.test.ts : new.id sans être posé sur tenant.');
      `)

      const found = await violations(client, rule)
      expect(describeViolations(onFunction(found, 'row_id_probe', 'merx'))).toContain(
        'inscrite en row_tenant, mais son corps ne borne rien',
      )
      // Le vrai trigger de `tenant`, lui, passe.
      expect(onFunction(found, 'open_default_warehouse', 'merx')).toEqual([])
    })

    /*
     * `argument_tenant` : le commerce arrive en argument, et le corps doit le
     * nommer. Une fonction qui reçoit le commerce et lit la table sans s'en
     * servir est exactement la faute que la forme doit attraper.
     */
    it('nomme une fonction inscrite en argument_tenant qui n’emploie pas son argument', async () => {
      await client.query('begin')
      await client.query(`
        create function merx.loose_arg_probe(target_tenant uuid) returns bigint
        language sql security definer set search_path = ''
        as $probe$ select count(*) from public.product $probe$;
        select merx.register_rls_exception('merx.loose_arg_probe(uuid)', 'argument_tenant',
          'Témoin de conventions.test.ts : reçoit le commerce et ne s''en sert pas.');

        create function merx.scoped_arg_probe(target_tenant uuid) returns bigint
        language sql security definer set search_path = ''
        as $probe$
          select count(*) from public.product where tenant_id = target_tenant
        $probe$;
        select merx.register_rls_exception('merx.scoped_arg_probe(uuid)', 'argument_tenant',
          'Témoin conforme de conventions.test.ts.');
      `)

      const found = await violations(client, rule)
      expect(describeViolations(onFunction(found, 'loose_arg_probe', 'merx'))).toContain(
        'inscrite en argument_tenant',
      )
      expect(onFunction(found, 'scoped_arg_probe', 'merx')).toEqual([])
    })

    /*
     * `auth_identity` : les deux fonctions qui *trouvent* le commerce ne
     * peuvent pas s'y borner — un filtre sur le commerce du jeton y serait
     * circulaire. Ce qui les borne est l'identité authentifiée, et la forme le
     * vérifie.
     */
    it('nomme une fonction inscrite en auth_identity qui ne borne rien à l’identité', async () => {
      await client.query('begin')
      await client.query(`
        create function merx.loose_identity_probe() returns bigint
        language sql security definer set search_path = ''
        as $probe$ select count(*) from public.app_user $probe$;
        select merx.register_rls_exception('merx.loose_identity_probe()', 'auth_identity',
          'Témoin de conventions.test.ts : aucune identité ne la borne.');

        create function merx.scoped_identity_probe() returns bigint
        language sql security definer set search_path = ''
        as $probe$ select count(*) from public.app_user where auth_user_id = auth.uid() $probe$;
        select merx.register_rls_exception('merx.scoped_identity_probe()', 'auth_identity',
          'Témoin conforme de conventions.test.ts.');
      `)

      const found = await violations(client, rule)
      expect(describeViolations(onFunction(found, 'loose_identity_probe', 'merx'))).toContain(
        'inscrite en auth_identity',
      )
      expect(onFunction(found, 'scoped_identity_probe', 'merx')).toEqual([])
    })

    /*
     * Et le registre ne connaît que `public` et `merx` : une table métier ne
     * vit pas ailleurs (SPEC § 4), donc une fonction d'un troisième schéma est
     * une faute de rangement avant d'être une exception RLS.
     */
    it('refuse d’inscrire une fonction hors de public et de merx', async () => {
      await client.query('begin')
      await client.query(`
        create schema probe_schema;
        create function probe_schema.stray_probe() returns bigint
        language sql security definer set search_path = ''
        as $probe$ select count(*) from public.product $probe$;
      `)

      await expect(
        client.query("select merx.register_rls_exception('probe_schema.stray_probe()', 'current_tenant', 'Témoin.')"),
      ).rejects.toThrow('ne connaît que public et merx')
    })

    it('nomme une fonction definer qui touche une table métier sans être inscrite', async () => {
      await client.query('begin')
      await client.query(`
        create function public.definer_probe() returns bigint
        language sql security definer set search_path = ''
        as $$ select count(*) from public.product where tenant_id = merx.current_tenant_id() $$;

        create function public.harmless_definer_probe() returns boolean
        language sql security definer set search_path = ''
        as $$ select merx.is_super_admin() $$;
      `)

      const found = await violations(client, rule)
      expect(describeViolations(onFunction(found, 'definer_probe'))).toContain(
        'security definer, touche product hors RLS, absente de merx.rls_exception_registry',
      )
      // Contrôle positif : une fonction definer qui ne touche aucune table métier.
      expect(onFunction(found, 'harmless_definer_probe')).toEqual([])

      // Et la même, inscrite avec son garde, n'est plus signalée.
      await client.query(`
        select merx.register_rls_exception('public.definer_probe()', 'current_tenant',
          'Témoin de conventions.test.ts.')
      `)
      expect(onFunction(await violations(client, rule), 'definer_probe')).toEqual([])
    })

    it('nomme une fonction inscrite en current_tenant dont le corps ne filtre pas le commerce', async () => {
      await client.query('begin')
      await client.query(`
        create function public.unfiltered_probe() returns bigint
        language sql security definer set search_path = ''
        as $$ select count(*) from public.product $$;
        select merx.register_rls_exception('public.unfiltered_probe()', 'current_tenant',
          'Témoin de conventions.test.ts.');
      `)

      const found = onFunction(await violations(client, rule), 'unfiltered_probe')
      expect(describeViolations(found)).toContain(
        'inscrite en current_tenant, mais son corps n\'appelle pas merx.current_tenant_id()',
      )
      expect(found).toHaveLength(1)
    })

    it('nomme une fonction inscrite en super_admin qui n’appelle pas merx.is_super_admin()', async () => {
      await client.query('begin')
      await client.query(`
        create function public.unguarded_admin_probe() returns bigint
        language sql security definer set search_path = ''
        as $$ select count(*) from public.tenant $$;
        select merx.register_rls_exception('public.unguarded_admin_probe()', 'super_admin',
          'Témoin de conventions.test.ts : se dit réservée à l''éditeur, sans le vérifier.');

        create function public.guarded_admin_probe() returns bigint
        language sql security definer set search_path = ''
        as $$ select count(*) from public.tenant where merx.is_super_admin() $$;
        select merx.register_rls_exception('public.guarded_admin_probe()', 'super_admin',
          'Témoin de conventions.test.ts.');
      `)

      const found = await violations(client, rule)
      expect(describeViolations(onFunction(found, 'unguarded_admin_probe'))).toContain(
        'inscrite en super_admin, mais son corps n\'appelle pas merx.is_super_admin()',
      )
      // Contrôle positif : la même inscription, avec le garde dans le corps.
      expect(onFunction(found, 'guarded_admin_probe')).toEqual([])
    })

    it('refuse une justification vide — contrainte rls_exception_justified', async () => {
      await client.query('begin')
      await client.query(`
        create function public.silent_probe() returns bigint
        language sql security definer set search_path = ''
        as $$ select count(*) from public.product where tenant_id = merx.current_tenant_id() $$;
      `)
      await client.query('savepoint justification')

      const refused = await client
        .query("select merx.register_rls_exception('public.silent_probe()', 'current_tenant', '   ')")
        .then(
          () => null,
          (error: { code?: string; constraint?: string }) => error,
        )
      expect(refused?.code).toBe('23514')
      expect(refused?.constraint).toBe('rls_exception_justified')
      await client.query('rollback to savepoint justification')

      // Contrôle positif : la même inscription, justifiée, passe.
      await client.query(
        "select merx.register_rls_exception('public.silent_probe()', 'current_tenant', 'Témoin.')",
      )
    })

    it('signale une justification vide que la contrainte ne tiendrait plus', async () => {
      await client.query('begin')
      await client.query(`
        alter table merx.rls_exception_registry drop constraint rls_exception_justified;
        update merx.rls_exception_registry set justification = ' ' where function_name = 'search_products';
      `)

      const found = await violations(client, 'registre des exceptions RLS tenu')
      expect(describeViolations(found)).toBe(
        'public.search_products — justification vide au registre des exceptions RLS — SPEC § 2.1',
      )
    })

    it('signale une inscription dont la fonction n’existe plus', async () => {
      await client.query('begin')
      await client.query(`
        insert into merx.rls_exception_registry (schema_name, function_name, guard, justification)
        values ('public', 'ghost_function_probe', 'current_tenant', 'Témoin.'),
               ('merx', 'ghost_merx_probe', 'row_tenant', 'Témoin.')
      `)

      // Les deux schémas, et chacun nommé par le sien : une entrée de `merx`
      // dont la fonction a disparu masquerait la prochaine du même nom.
      const found = await violations(client, 'registre des exceptions RLS tenu')
      expect(found.map((v) => v.table_name)).toEqual([
        'merx.ghost_merx_probe',
        'public.ghost_function_probe',
      ])
    })
  })

  /*
   * RÈGLE M8-1, addendum E2-03. Chaque volet a son témoin fautif et son
   * jumeau conforme, dans une transaction annulée.
   */
  describe('le journal du prix d’achat — tables auditées', () => {
    it('signale une table auditée dont le trigger a disparu, et laisse passer la table gardée', async () => {
      await client.query('begin')
      await client.query(`
        create table public.audited_probe (id uuid primary key default gen_random_uuid());
        select merx.apply_reference_conventions('public.audited_probe');
        alter table public.audited_probe add column unit_cost public.money_amount;
        select merx.apply_audit('public.audited_probe', 'purchase_price_change', array['unit_cost']);
      `)

      const rule: RuleName = 'tables auditées gardées'
      expect(onProbe(await violations(client, rule), 'audited_probe')).toEqual([])

      await client.query('drop trigger audit_row_change on public.audited_probe')
      const found = onProbe(await violations(client, rule), 'audited_probe')
      expect(describeViolations(found)).toContain('sans trigger merx.audit_row_change()')
      expect(found).toHaveLength(1)
    })

    it('refuse d’auditer une colonne qui n’existe pas', async () => {
      await client.query('begin')
      await client.query(`
        create table public.audited_probe (id uuid primary key default gen_random_uuid());
        select merx.apply_reference_conventions('public.audited_probe');
      `)
      await expect(
        client.query(
          "select merx.apply_audit('public.audited_probe', 'purchase_price_change', array['unit_cost'])",
        ),
      ).rejects.toThrow('Colonne auditée inconnue sur audited_probe : unit_cost')
    })

    it('signale une relation restreinte par view_cost dont le prix n’est pas journalisé', async () => {
      await client.query('begin')
      await client.query(`
        create table public.cost_probe (id uuid primary key default gen_random_uuid());
        select merx.apply_reference_conventions('public.cost_probe');
        alter table public.cost_probe add column unit_cost public.money_amount;
        select merx.apply_capability_restriction('public.cost_probe', 'view_cost');
      `)

      const rule: RuleName = 'prix d\'achat journalisés'
      expect(describeViolations(onProbe(await violations(client, rule), 'cost_probe'))).toContain(
        'dont le prix d\'achat n\'est pas journalisé',
      )

      // Contrôle positif : la même relation, journalisée, n'est plus nommée.
      await client.query(
        "select merx.apply_audit('public.cost_probe', 'purchase_price_change', array['unit_cost'])",
      )
      expect(onProbe(await violations(client, rule), 'cost_probe')).toEqual([])
    })
  })

  /*
   * E4-01, RÈGLE M8-1 — les événements d'audit sont inscrits au registre, et la
   * règle les compare au trigger réel. `sale_document` ne journalise que
   * l'UPDATE ; un trigger retouché à la main pour y ajouter l'INSERT, ou pour
   * en retirer l'UPDATE, doit être nommé.
   */
  describe('le journal — événements explicites', () => {
    const createProbe = async (): Promise<void> => {
      await client.query('begin')
      await client.query(`
        create table public.events_probe (id uuid primary key default gen_random_uuid());
        select merx.apply_reference_conventions('public.events_probe');
        alter table public.events_probe add column state text, add column unit_cost public.money_amount;
        select merx.apply_audit(
          'public.events_probe', 'document_cancellation', array['state'],
          $$new.state = 'done'$$, array['update']);
      `)
    }

    it('inscrit l\'événement posé, et laisse passer la table gardée', async () => {
      await createProbe()
      const { rows } = await client.query<{ events: string }>(
        "select events from merx.audited_registry where table_name = 'events_probe'",
      )
      expect(rows).toEqual([{ events: 'update' }])
      expect(
        onProbe(await violations(client, 'tables auditées gardées'), 'events_probe'),
      ).toEqual([])
    })

    it('signale un trigger auquel on a ajouté un événement que le registre ne connaît pas', async () => {
      await createProbe()
      await client.query('drop trigger audit_row_change on public.events_probe')
      await client.query(`
        create trigger audit_row_change after insert or update on public.events_probe
          for each row when (new.state = 'done')
          execute function merx.audit_row_change('document_cancellation', 'state')
      `)

      const found = onProbe(await violations(client, 'tables auditées gardées'), 'events_probe')
      expect(describeViolations(found)).toContain('attendu UPDATE')
    })

    it('signale un trigger qui a perdu l\'événement que le registre annonce', async () => {
      await createProbe()
      await client.query('drop trigger audit_row_change on public.events_probe')
      await client.query(`
        create trigger audit_row_change after delete on public.events_probe
          for each row execute function merx.audit_row_change('document_cancellation', 'state')
      `)

      const found = describeViolations(
        onProbe(await violations(client, 'tables auditées gardées'), 'events_probe'),
      )
      expect(found).toContain('attendu UPDATE')
      expect(found).toContain('posé sur DELETE')
    })

    it('refuse une condition de ligne sur une table dont les événements incluent delete', async () => {
      await client.query('begin')
      await client.query(`
        create table public.events_probe (id uuid primary key default gen_random_uuid());
        select merx.apply_reference_conventions('public.events_probe');
        alter table public.events_probe add column state text;
      `)
      await expect(
        client.query(
          `select merx.apply_audit('public.events_probe', 'document_cancellation', array['state'], $$new.state = 'done'$$)`,
        ),
      ).rejects.toThrow('dont les événements incluent delete')
    })

    it('refuse un événement inconnu, et un UPDATE sur une table en ajout seul', async () => {
      await client.query('begin')
      await client.query(`
        create table public.events_probe (id uuid primary key default gen_random_uuid());
        select merx.apply_reference_conventions('public.events_probe');
        alter table public.events_probe add column state text;
      `)
      await client.query('savepoint refusal')
      await expect(
        client.query(
          "select merx.apply_audit('public.events_probe', 'document_cancellation', array['state'], null, array['upsert'])",
        ),
      ).rejects.toThrow('Événements d\'audit inconnus')
      await client.query('rollback to savepoint refusal')
      await expect(
        client.query(
          "select merx.apply_audit('public.stock_movement', 'stock_adjustment', array['quantity'], null, array['update'])",
        ),
      ).rejects.toThrow('est en ajout seul')
    })
  })

  /*
   * E4-01, RÈGLE M3-3 — les tables figées. Même forme que les tables dérivées :
   * le registre nomme la table, pas ses triggers, et chaque garde se retire
   * séparément.
   */
  describe('gardes des tables figées', () => {
    const rule: RuleName = 'gardes des tables figées'

    const createFrozenProbe = async (): Promise<void> => {
      await client.query('begin')
      await client.query(`
        create table public.frozen_probe (
          id     uuid primary key default gen_random_uuid(),
          status public.sale_doc_status not null default 'draft',
          note   text
        );
        select merx.apply_business_conventions('public.frozen_probe');
        alter table public.frozen_probe add constraint frozen_probe_tenant_id_id_key unique (tenant_id, id);
        select merx.apply_frozen_when('public.frozen_probe', 'status', 'draft');
        select merx.allow_frozen_transition('public.frozen_probe', 'draft', 'confirmed');

        create table public.frozen_child_probe (
          id              uuid primary key default gen_random_uuid(),
          frozen_probe_id uuid not null
        );
        select merx.apply_business_conventions('public.frozen_child_probe');
        alter table public.frozen_child_probe add constraint frozen_child_probe_fkey
          foreign key (tenant_id, frozen_probe_id) references public.frozen_probe (tenant_id, id)
          on delete cascade;
        select merx.apply_frozen_child('public.frozen_child_probe', 'public.frozen_probe', 'frozen_probe_id');
      `)
    }

    it('connaît sale_document et sale_line, et leurs gardes sont en place', async () => {
      const { rows } = await client.query<{ table_name: string; kind: string }>(
        'select table_name, kind from merx.frozen_registry order by table_name',
      )
      expect(rows).toEqual([
        { table_name: 'sale_document', kind: 'root' },
        { table_name: 'sale_line', kind: 'child' },
      ])
      expect(describeViolations(await violations(client, rule))).toBe('')
    })

    it('laisse passer une racine et un enfant posés par les helpers', async () => {
      await createFrozenProbe()
      expect(onProbe(await violations(client, rule), 'frozen_probe')).toEqual([])
      expect(onProbe(await violations(client, rule), 'frozen_child_probe')).toEqual([])
    })

    const removals: Array<[string, string, string]> = [
      ['la naissance', 'drop trigger reject_frozen_birth on public.frozen_probe', 'BEFORE INSERT merx.reject_frozen_birth'],
      ['la mise à jour', 'drop trigger reject_frozen_update on public.frozen_probe', 'BEFORE UPDATE merx.reject_frozen_update'],
      ['la suppression', 'drop trigger reject_frozen_delete on public.frozen_probe', 'BEFORE DELETE merx.reject_frozen_delete'],
      ['TRUNCATE', 'drop trigger reject_frozen_truncate on public.frozen_probe', 'BEFORE TRUNCATE merx.reject_frozen_truncate'],
    ]
    for (const [label, sql, expected] of removals) {
      it(`signale le garde de ${label} manquant`, async () => {
        await createFrozenProbe()
        await client.query(sql)
        const found = onProbe(await violations(client, rule), 'frozen_probe')
        expect(describeViolations(found)).toContain(expected)
        expect(found).toHaveLength(1)
      })
    }

    it('signale le garde d\'écriture de l\'enfant manquant', async () => {
      await createFrozenProbe()
      await client.query('drop trigger reject_frozen_child_write on public.frozen_child_probe')
      const found = onProbe(await violations(client, rule), 'frozen_child_probe')
      expect(describeViolations(found)).toContain('reject_frozen_child_write')
    })

    it('signale un garde d\'écriture d\'enfant qui ne couvre pas les trois événements', async () => {
      await createFrozenProbe()
      await client.query('drop trigger reject_frozen_child_write on public.frozen_child_probe')
      await client.query(`
        create trigger reject_frozen_child_write before insert on public.frozen_child_probe
          for each row execute function merx.reject_frozen_child_write(
            'frozen_probe', 'frozen_probe_id', 'status', 'draft')
      `)
      const found = onProbe(await violations(client, rule), 'frozen_child_probe')
      expect(describeViolations(found)).toContain('reject_frozen_child_write')
    })

    it('signale TRUNCATE laissé à authenticated', async () => {
      await createFrozenProbe()
      await client.query('grant truncate on public.frozen_probe to authenticated')
      const found = onProbe(await violations(client, rule), 'frozen_probe')
      expect(describeViolations(found)).toContain('authenticated détient TRUNCATE')
    })

    it('signale un garde désactivé, en le nommant', async () => {
      await createFrozenProbe()
      await client.query('alter table public.frozen_probe disable trigger reject_frozen_update')
      const found = onProbe(await violations(client, rule), 'frozen_probe')
      const detail = describeViolations(found)
      expect(detail).toContain('reject_frozen_update')
      expect(detail).toContain('désactivé')
    })

    it('signale une table figée dont aucune transition n\'est déclarée', async () => {
      await createFrozenProbe()
      await client.query("delete from merx.frozen_transition where table_name = 'frozen_probe'")
      const found = onProbe(await violations(client, rule), 'frozen_probe')
      expect(describeViolations(found)).toContain('aucune transition déclarée')
    })

    it('signale une table figée à la main, sans inscription au registre', async () => {
      await client.query('begin')
      await client.query(`
        create table public.rogue_frozen_probe (id uuid primary key default gen_random_uuid());
        select merx.apply_business_conventions('public.rogue_frozen_probe');
        create trigger reject_frozen_delete before delete on public.rogue_frozen_probe
          for each row execute function merx.reject_frozen_delete();
      `)
      const found = onProbe(
        await violations(client, 'aucune table figée hors registre'),
        'rogue_frozen_probe',
      )
      expect(describeViolations(found)).toContain('merx.apply_frozen_when()')
    })

    it('refuse à la pose un statut, une colonne ou un parent qui n\'existent pas', async () => {
      await createFrozenProbe()
      await client.query(`
        create table public.frozen_other_probe (
          id uuid primary key default gen_random_uuid(),
          status public.sale_doc_status not null default 'draft'
        );
        select merx.apply_business_conventions('public.frozen_other_probe');
      `)
      const refusals: Array<[string, string]> = [
        ["select merx.apply_frozen_when('public.frozen_other_probe', 'absente', 'draft')", 'Colonne de statut inconnue'],
        ["select merx.apply_frozen_when('public.frozen_other_probe', 'status', 'brouillon')", 'Statut ouvert inconnu'],
        ["select merx.allow_frozen_transition('public.frozen_probe', 'draft', 'archived')", 'Statut inconnu'],
        ["select merx.allow_frozen_transition('public.frozen_probe', 'confirmed', 'delivered', array['absente'])", 'Colonne inconnue'],
        ["select merx.allow_frozen_transition('public.frozen_other_probe', 'draft', 'confirmed')", 'n\'est pas une table figée'],
        ["select merx.apply_frozen_child('public.frozen_other_probe', 'public.frozen_other_probe', 'id')", 'son enfant ne peut pas la suivre'],
        ["select merx.apply_frozen_child('public.frozen_child_probe', 'public.frozen_probe', 'absente')", 'Colonne de clé inconnue'],
      ]
      for (const [sql, message] of refusals) {
        await client.query('savepoint refusal')
        await expect(client.query(sql), sql).rejects.toThrow(message)
        await client.query('rollback to savepoint refusal')
      }
    })
  })

  it('signale une entrée de registre sans table', async () => {
    await client.query('begin')
    await client.query(
      "insert into merx.convention_registry (table_name, kind) values ('ghost_probe', 'business')",
    )

    const found = await violations(client, 'registre périmé')
    expect(found.map((v) => v.table_name)).toEqual(['ghost_probe'])
  })
})
