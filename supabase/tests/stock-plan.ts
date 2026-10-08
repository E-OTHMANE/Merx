/*
 * Le plan d'exécution d'une requête de stock, lu sur l'appel réel. E3-02.
 *
 * `search-plan.ts` fait la même chose pour `search_products()`, et ne peut pas
 * servir ici : il reconnaît le plan à une phrase du corps de cette
 * fonction-là. Les deux fichiers partagent en revanche les deux propriétés
 * qu'E2-04 a payées, et elles valent d'être répétées :
 *
 *   — **le plan est celui d'une session chaude.** Un plan générique remplace le
 *     plan personnalisé après cinq exécutions d'une instruction préparée, et
 *     PostgREST en prépare (`db-prepared-statements`, actif par défaut) : une
 *     connexion du pool en sert des centaines. Un sabotage jugé sur le premier
 *     appel est resté vert à tort en E2-04. Les requêtes sont donc préparées
 *     puis exécutées plusieurs fois, et c'est le plan de la dernière qu'on lit ;
 *
 *   — **s'il n'y a pas de plan, le test échoue en le disant.** `auto_explain`
 *     ne se charge pas par `LOAD` sur ce stack (supautils le refuse), mais il
 *     est préchargé et ses réglages passent par `SET`. Rien ne se replie sur un
 *     `EXPLAIN` écrit à la main : ce serait mesurer une autre requête.
 *
 * Ce qui est mesuré est la **forme** que PostgREST émet — `where quantity = 0`
 * sur `stock_level`, le commerce venant de la policy et non de la requête —, pas
 * la requête HTTP elle-même : les notices d'`auto_explain` arrivent par le
 * canal de la session SQL, qu'une requête passée par l'API ne partage pas. Le
 * contenu rendu, lui, est éprouvé à travers PostgREST dans le fichier de test.
 */

import type { Client } from 'pg'

import { actAs } from './isolation'
import { nodesOf, type PlanNode } from './search-plan'

export type { PlanNode }

/* De quoi dépasser les cinq exécutions au-delà desquelles le plan générique prend le relais. */
const WARM_UP = 8

/**
 * Le plan d'une instruction sans paramètre, exécutée sous les claims donnés,
 * lu par `auto_explain` sur une session chaude.
 *
 * `marker` est un fragment du texte de l'instruction : il sert à retrouver *sa*
 * notice parmi celles que la session a produites.
 */
export async function planOfStatement(
  client: Client,
  claims: Record<string, unknown>,
  sql: string,
  marker: string,
): Promise<PlanNode[]> {
  const notices: string[] = []
  const listen = (notice: { message?: string | undefined }): void => {
    notices.push(notice.message ?? '')
  }

  /*
   * Un point de sauvegarde, pas un `begin` : les fichiers de test tiennent tout
   * leur peuplement dans une transaction unique, annulée à la fin. Ouvrir une
   * transaction ici refermerait la leur, et les cas suivants s'arrêteraient sur
   * « SAVEPOINT can only be used in transaction blocks ». Mesuré.
   *
   * `prepare`, `set local` et le rôle sont tous annulés par le retour au point
   * de sauvegarde ; `deallocate` est néanmoins explicite, parce qu'un nom
   * d'instruction préparée qui survivrait ferait échouer le cas suivant sur un
   * doublon plutôt que sur ce qu'il mesure.
   */
  await client.query('savepoint plan_probe')
  try {
    await client.query('reset role')
    await client.query(`prepare plan_probe as ${sql}`)

    await actAs(client, claims)
    for (let n = 0; n < WARM_UP; n += 1) {
      await client.query('execute plan_probe')
    }
    await client.query('reset role')

    await client.query('set local auto_explain.log_min_duration = 0')
    await client.query('set local auto_explain.log_nested_statements = on')
    await client.query('set local auto_explain.log_level = notice')
    await client.query('set local auto_explain.log_format = json')

    client.on('notice', listen)
    await actAs(client, claims)
    await client.query('execute plan_probe')
  } finally {
    client.off('notice', listen)
    await client.query('reset role')
    await client.query('rollback to savepoint plan_probe')
    await client.query('deallocate all')
  }

  const plans = notices.filter((m) => m.includes(marker))
  if (plans.length !== 1) {
    throw new Error(
      `auto_explain a rendu ${plans.length} plan(s) contenant « ${marker} », 1 attendu ` +
        `(${notices.length} notices en tout). Sans plan, rien ne prouve que l'index sert : ` +
        'le test échoue plutôt que de mesurer un plan reconstruit à côté.',
    )
  }

  const plan = JSON.parse(plans[0]!.slice(plans[0]!.indexOf('{'))) as { Plan: PlanNode }
  return nodesOf(plan.Plan)
}

/** Les parcours séquentiels d'une table donnée — il ne doit y en avoir aucun. */
export function seqScansOf(nodes: readonly PlanNode[], relation: string): PlanNode[] {
  return nodes.filter(
    (n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === relation,
  )
}

/** Les index empruntés, quel que soit le type de parcours. */
export function indexesUsed(nodes: readonly PlanNode[]): string[] {
  return nodes
    .filter((n) => n['Index Name'] !== undefined)
    .map((n) => n['Index Name'] as string)
}
