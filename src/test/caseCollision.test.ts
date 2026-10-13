/*
 * Deux fichiers qui ne diffèrent que par la casse. E3-02.
 *
 * Windows et macOS ont un système de fichiers insensible à la casse : pour eux,
 * `src/modules/stock/Quantity.tsx` et `src/modules/stock/quantity.ts` sont le
 * **même** fichier. Le résolveur de Vite, lui, est sensible à la casse, et
 * `import { Quantity } from '@/modules/stock/Quantity'` est tombé sur
 * `quantity.ts`, qui n'exporte aucun composant : React a reçu `undefined` et
 * douze tests sont devenus rouges sur « Element type is invalid ».
 *
 * Ce qui rend le piège coûteux n'est pas la faute, c'est où elle se voit :
 *
 *   — `tsc` ne dit rien, `eslint` ne dit rien. Les deux chemins existent ;
 *   — sur une CI Linux, rien ne se produit du tout : les deux fichiers y sont
 *     distincts, tout s'importe correctement, et la casse reste cassée pour
 *     celui qui développe sur Windows ;
 *   — à l'inverse, un dépôt sain sur Windows peut livrer deux fichiers que
 *     seul Linux distingue, et c'est alors la production qui diverge du poste.
 *
 * D'où ce contrôle, qui ne dépend d'aucun système de fichiers : il lit les
 * chemins tels que git les connaît et refuse deux entrées dont la forme
 * minuscule est identique. Il échoue sur n'importe quelle machine, au `npm run
 * test` d'avant la livraison, et non six semaines plus tard sur une autre.
 */

import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * Les chemins suivis par git, à la racine du dépôt.
 *
 * `git ls-files` plutôt qu'un parcours du disque : sur un système insensible à
 * la casse, le parcours ne **peut pas** voir les deux entrées — il n'en voit
 * qu'une, et le contrôle serait aveugle précisément là où il sert. L'index git,
 * lui, retient les deux noms tels qu'ils ont été ajoutés.
 */
function trackedPaths(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((path) => path !== '')
}

describe('aucune collision de casse entre deux chemins', () => {
  it('git ls-files répond — sans quoi ce test ne vérifierait rien', () => {
    // Un dépôt vide ou une commande absente rendrait le contrôle vide, donc
    // vert, donc inutile. Mieux vaut qu'il le dise.
    expect(trackedPaths().length).toBeGreaterThan(50)
  })

  it('deux fichiers ne diffèrent jamais par la seule casse', () => {
    const byFolded = new Map<string, string[]>()

    for (const path of trackedPaths()) {
      const folded = path.toLowerCase()
      byFolded.set(folded, [...(byFolded.get(folded) ?? []), path])
    }

    const collisions = [...byFolded.values()]
      .filter((paths) => paths.length > 1)
      .map((paths) => paths.sort().join(' ≠ '))
      .sort()

    expect(
      collisions,
      'Ces chemins sont le même fichier sous Windows et macOS. Un import tombera ' +
        'sur l’un ou sur l’autre selon la machine, sans que tsc ni eslint le voient. ' +
        'Renommer l’un des deux.',
    ).toEqual([])
  })

  /*
   * La même règle un cran plus haut : deux **dossiers** dont les noms ne
   * diffèrent que par la casse cassent tout ce qu'ils contiennent, et la
   * comparaison de chemins complets ci-dessus ne les voit pas — `src/Foo/a.ts`
   * et `src/foo/b.ts` sont deux chemins distincts même repliés.
   */
  it('deux dossiers non plus', () => {
    const byFolded = new Map<string, Set<string>>()

    for (const path of trackedPaths()) {
      const parts = path.split('/')
      parts.pop()
      let prefix = ''
      for (const part of parts) {
        const folded = `${prefix.toLowerCase()}${part.toLowerCase()}`
        byFolded.set(folded, (byFolded.get(folded) ?? new Set()).add(`${prefix}${part}`))
        prefix += `${part}/`
      }
    }

    const collisions = [...byFolded.values()]
      .filter((names) => names.size > 1)
      .map((names) => [...names].sort().join(' ≠ '))
      .sort()

    expect(collisions, 'Deux dossiers que Windows et macOS confondent.').toEqual([])
  })
})
