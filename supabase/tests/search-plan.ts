/*
 * Le plan d'exécution de la recherche, lu sur l'appel réel. E2-04, partagé
 * avec E2-05.
 *
 * Écrit en E2-04, sorti du fichier de test le jour où E2-05 en a eu besoin :
 * l'import insère en masse, et c'est précisément après une insertion en masse
 * que l'index se perdait (liste d'attente GIN, `fastupdate`). Les deux stories
 * doivent donc lire le même plan, par le même chemin — sans quoi la seconde
 * mesurerait un plan reconstruit à côté du vrai.
 *
 * Deux propriétés valent d'être répétées ici, toutes deux payées en E2-04 :
 *
 *   — **le plan est celui d'une session chaude.** Le cache de plans d'une
 *     fonction plpgsql vit le temps de la session et peut basculer après cinq
 *     appels ; une connexion PostgREST en sert des centaines. Un sabotage jugé
 *     sur le premier appel est resté vert à tort ;
 *   — **s'il n'y a pas de plan, le test échoue en le disant.** `auto_explain`
 *     ne se charge pas par `LOAD` sur ce stack (supautils le refuse), mais il
 *     est préchargé et ses réglages passent par `SET`. Rien ne se replie sur un
 *     `EXPLAIN` écrit à la main : ce serait mesurer une autre requête.
 */

import type { Client } from 'pg'

import { actAs, tokenFor } from './isolation'

export interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Index Cond'?: string
  'Recheck Cond'?: string
  Plans?: PlanNode[]
}

export function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)]
}

/*
 * La batterie : le pire cas (« creme », des milliers de candidats), les fautes,
 * l'arabe, les références, les codes-barres, un et deux caractères, la requête
 * vide, et ce qui ne trouve rien.
 */
export const BATTERY = [
  '',
  'creme',
  'crème',
  'crme hydratante',
  'shampoing',
  '451',
  '4512',
  'NIV-45',
  '6110000',
  'كريم',
  'اركان',
  '٤٥١',
  'nivea creme 200',
  'a',
  '45',
  'zzqx',
]

/* De quoi dépasser les cinq plans personnalisés du cache, avec des requêtes variées. */
export const WARM_UP = ['savon', 'nivea', '4512', 'argan', 'x', 'huile', 'rose', 'كريم']

/**
 * Le plan de la requête que `search_products()` exécute, sous le jeton d'un
 * employé du commerce donné, lu par `auto_explain` sur l'appel réel.
 */
export async function planOf(client: Client, tenant: string, q: string): Promise<PlanNode[]> {
  const notices: string[] = []
  const listen = (notice: { message?: string | undefined }): void => {
    notices.push(notice.message ?? '')
  }
  client.on('notice', listen)

  await client.query('begin')
  try {
    await actAs(client, tokenFor(tenant, 'worker'))
    for (const warm of WARM_UP) {
      await client.query('select count(*) from public.search_products($1)', [warm])
    }
    await client.query('reset role')

    await client.query('set local auto_explain.log_min_duration = 0')
    await client.query('set local auto_explain.log_nested_statements = on')
    await client.query('set local auto_explain.log_level = notice')
    await client.query('set local auto_explain.log_format = json')
    await actAs(client, tokenFor(tenant, 'worker'))
    await client.query('select count(*) from public.search_products($1)', [q])
  } finally {
    await client.query('rollback')
    client.off('notice', listen)
  }

  const plans = notices.filter((m) => m.includes('with catalogue as not materialized'))
  if (plans.length !== 1) {
    throw new Error(
      `auto_explain a rendu ${plans.length} plan(s) de la requête de recherche pour « ${q} », ` +
        `1 attendu (${notices.length} notices en tout). Sans plan, rien ne prouve que l'index ` +
        'sert : le test échoue plutôt que de mesurer un plan reconstruit à côté.',
    )
  }
  const plan = JSON.parse(plans[0]!.slice(plans[0]!.indexOf('{'))) as { Plan: PlanNode }
  return nodesOf(plan.Plan)
}

export interface IndexUsage {
  /** Parcours séquentiels du catalogue — il ne doit y en avoir aucun. */
  seqScans: string[]
  /** Index trigrammes empruntés : `product_search`, `variant_search`. */
  trigram: string[]
  /** Index portant `tenant_id` dans sa condition, pour les requêtes courtes. */
  tenantIndexes: number
}

/** Ce qu'un plan dit de l'usage des index. */
export function indexUsage(nodes: readonly PlanNode[]): IndexUsage {
  return {
    seqScans: nodes
      .filter(
        (n) =>
          n['Node Type'] === 'Seq Scan' &&
          (n['Relation Name'] === 'product' || n['Relation Name'] === 'variant'),
      )
      .map((n) => n['Relation Name'] ?? ''),
    trigram: nodes
      .filter((n) => n['Node Type'] === 'Bitmap Index Scan')
      .map((n) => n['Index Name'] ?? ''),
    tenantIndexes: nodes.filter(
      (n) => n['Index Name'] !== undefined && (n['Index Cond'] ?? '').includes('tenant_id'),
    ).length,
  }
}
