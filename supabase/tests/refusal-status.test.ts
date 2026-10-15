// @vitest-environment node

/*
 * SPEC § 4, RÈGLE des refus en 4xx — mesurée, à chaque passage de la suite.
 *
 * PostgREST traduit le SQLSTATE d'un `raise` en statut HTTP, et ce qu'il ne
 * connaît pas devient un `500`. Ce n'est pas un détail d'affichage : en E9,
 * PowerSync rejoue les écritures accumulées hors ligne et lit un 5xx comme une
 * panne passagère — il réessaie sans fin, et la file de l'appareil reste
 * bloquée sur un refus qui ne changera jamais d'avis. Quatre gardes ont vécu
 * plusieurs stories dans cet état (`55006`, `55000`, `54000`, `P0002`), et rien
 * ne le disait.
 *
 * La correspondance n'est pas devinable depuis le code : elle appartient à la
 * version de PostgREST que le CLI épingle. Ce fichier la **mesure** donc, au
 * lieu de la croire — une liste constatée une fois puis recopiée serait la
 * recopie à la main que la RÈGLE des domaines nommés refuse. Le jour où
 * l'épingle du CLI monte et qu'un code change de statut, c'est ici que la suite
 * rougit.
 *
 * Deux listes, et la seconde est la vraie garantie :
 *
 *   1. `REFUSAL_CODES_4XX` — ce que la règle de `conventions.ts` admet. Admis
 *      n'est pas vérifié : chaque code est levé et son statut lu.
 *   2. **les codes réellement levés par les gardes**, relevés au catalogue.
 *      Aucune liste à tenir : un garde neuf est mesuré du seul fait d'exister,
 *      dans la story qui l'écrit.
 *
 * La sonde est une fonction posée puis retirée, qui lève le code qu'on lui
 * donne. Elle est `security invoker` et ne touche aucune table : rien à
 * inscrire à `merx.rls_exception_registry`, et son corps ne porte aucun
 * littéral de SQLSTATE — sans quoi elle se signalerait elle-même à la règle.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { REFUSAL_CODES_4XX } from './refusalCodes'
import { API_URL, SERVICE_KEY } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PROBE = 'refusal_status_probe'

let client: Client

/** Les codes que les gardes lèvent vraiment, lus au catalogue. */
let raisedByGuards: Array<{ code: string; functions: string }> = []

async function reloadSchemaCache(): Promise<void> {
  await client.query("notify pgrst, 'reload schema'")
}

/**
 * Appelle la sonde. PostgREST peut ne pas connaître encore la fonction — son
 * cache de schéma est rechargé par `notify`, de façon asynchrone — d'où la
 * reprise sur `PGRST202` : c'est le seul endroit où attendre est juste, et
 * boucler sans borne cacherait une fonction absente.
 */
async function statusOf(code: string, attempts = 20): Promise<{ status: number; body: string }> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`${API_URL}/rest/v1/rpc/${PROBE}`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_code: code }),
    })
    const body = await response.text()

    if (!body.includes('PGRST202')) return { status: response.status, body }

    await reloadSchemaCache()
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `PostgREST ne connaît toujours pas public.${PROBE} après ${attempts} tentatives : ` +
      'son cache de schéma ne se recharge pas. Stack démarré ?',
  )
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

  /*
   * `errcode = p_code` : le code vient de l'argument, jamais d'un littéral.
   * Une sonde qui écrirait `errcode = '55000'` serait, à juste titre, la
   * première infraction relevée par la règle qu'elle sert à mesurer.
   */
  await client.query(`
    create function public.${PROBE}(p_code text)
    returns void language plpgsql set search_path = '' as $probe$
    begin
      raise exception 'sonde de statut : %', p_code using errcode = p_code;
    end;
    $probe$;
  `)
  await client.query(
    `grant execute on function public.${PROBE}(text) to anon, authenticated, service_role`,
  )
  await reloadSchemaCache()

  const { rows } = await client.query<{ code: string; functions: string }>(`
    with raised as (
      select format('%s.%s', n.nspname, p.proname) as qualified,
             (regexp_matches(p.prosrc, 'errcode = ''([A-Za-z0-9]+)''', 'g'))[1] as code
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'merx')
    )
    select code, string_agg(distinct qualified, ', ' order by qualified) as functions
    from raised
    group by code
    order by code
  `)
  raisedByGuards = rows
}, 60_000)

afterAll(async () => {
  if (client !== undefined) {
    await client.query(`drop function if exists public.${PROBE}(text)`)
    await reloadSchemaCache()
    await client.end()
  }
}, 30_000)

/* ========================================================================== */
/* 1. La liste admise, mesurée code par code                                   */
/* ========================================================================== */

describe('les codes admis sortent en 4xx', () => {
  for (const code of REFUSAL_CODES_4XX) {
    it(`${code} — PostgREST rend un 4xx`, async () => {
      const { status, body } = await statusOf(code)

      expect(status, `${code} : ${body}`).toBeGreaterThanOrEqual(400)
      expect(status, `${code} — un refus rendu en 5xx serait rejoué sans fin : ${body}`).toBeLessThan(
        500,
      )
    })
  }

  /*
   * La famille `PTxxx` tient sa promesse : les trois chiffres *sont* le statut.
   * C'est sur elle que reposent nos quatre gardes corrigés ; si PostgREST
   * cessait de la lire ainsi, le code et le statut divergeraient en silence.
   */
  it('la famille PTxxx rend exactement les trois chiffres de son code', async () => {
    for (const code of REFUSAL_CODES_4XX.filter((candidate) => candidate.startsWith('PT'))) {
      const { status, body } = await statusOf(code)
      expect(status, `${code} : ${body}`).toBe(Number(code.slice(2)))
    }
  })
})

/* ========================================================================== */
/* 2. Les codes que les gardes lèvent vraiment                                 */
/* ========================================================================== */

describe('aucun garde du projet ne refuse en 5xx', () => {
  it('relève au moins les codes des gardes connus', () => {
    // Un balayage qui ne trouve rien passerait tous les cas suivants.
    const codes = raisedByGuards.map((row) => row.code)
    expect(codes).toContain('42501')
    expect(codes).toContain('PT409')
    expect(codes.length).toBeGreaterThan(5)
  })

  it('mesure le statut de chaque code levé, et aucun n’est un 5xx', async () => {
    const offenders: string[] = []

    for (const { code, functions } of raisedByGuards) {
      const { status, body } = await statusOf(code)
      if (status >= 500) offenders.push(`${code} → ${status} (${functions}) : ${body}`)
    }

    expect(
      offenders,
      'ces gardes refusent en 5xx : PowerSync rejouerait leur écriture sans fin (SPEC § 4)\n' +
        offenders.join('\n'),
    ).toEqual([])
  })
})
