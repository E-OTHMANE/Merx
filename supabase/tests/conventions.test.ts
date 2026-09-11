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

  it('signale une entrée de registre sans table', async () => {
    await client.query('begin')
    await client.query(
      "insert into merx.convention_registry (table_name, kind) values ('ghost_probe', 'business')",
    )

    const found = await violations(client, 'registre périmé')
    expect(found.map((v) => v.table_name)).toEqual(['ghost_probe'])
  })
})
