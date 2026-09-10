// @vitest-environment node

import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'
import { beforeAll, describe, expect, it } from 'vitest'

/*
 * Ces tests compilent réellement `index.css` avec Tailwind et lisent les
 * propriétés personnalisées émises. Ils ne relisent pas un objet TypeScript
 * écrit à côté : un tel test ne prouverait rien d'autre que sa propre copie.
 *
 * Référence : docs/BRAND-UI.md.
 */

const stylesDir = fileURLToPath(new URL('.', import.meta.url))

/** Compile `index.css` en forçant la génération des utilitaires demandés. */
async function compile(candidates: readonly string[]): Promise<string> {
  const source = [
    "@import './index.css';",
    `@source inline("${candidates.join(' ')}");`,
  ].join('\n')

  const result = await postcss([tailwindcss()]).process(source, {
    // Fichier virtuel : seul le dossier compte pour résoudre `./index.css`.
    from: `${stylesDir}tokens.probe.css`,
  })

  return result.css
}

/** Valeur d'une propriété personnalisée dans la feuille compilée. */
function customProperty(css: string, name: string): string | undefined {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css)
  return match?.[1]?.trim()
}

const INK = {
  '--color-ink-950': '#0e1440',
  '--color-ink-900': '#16205c',
  '--color-ink-800': '#1e2b75',
  '--color-ink-700': '#24338a',
  '--color-ink-600': '#2b3c99',
  '--color-ink-500': '#3a4eb8',
  '--color-ink-400': '#6274d1',
  '--color-ink-300': '#96a3e3',
  '--color-ink-200': '#c4cbf0',
  '--color-ink-100': '#e3e7f9',
  '--color-ink-50': '#f2f4fd',
} as const

const RED = {
  '--color-red-700': '#9b1c15',
  '--color-red-600': '#c0271e',
  '--color-red-500': '#d9433a',
  '--color-red-100': '#fbe5e3',
} as const

const PAPER = {
  '--color-paper-950': '#101216',
  '--color-paper-900': '#1c1f25',
  '--color-paper-800': '#2e323b',
  '--color-paper-700': '#434955',
  '--color-paper-600': '#5a6170',
  '--color-paper-500': '#767e8e',
  '--color-paper-400': '#9ba3b2',
  '--color-paper-300': '#c3c9d4',
  '--color-paper-200': '#dde1e8',
  '--color-paper-100': '#edeff3',
  '--color-paper-50': '#f7f8fa',
} as const

const FUNCTIONAL = {
  '--color-valid': '#107c4f',
  '--color-valid-bg': '#e3f4ec',
  '--color-warn': '#b45309',
  '--color-warn-bg': '#fdf0dc',
  '--color-sync': '#3a4eb8',
} as const

const COLORS = { ...INK, ...RED, ...PAPER, ...FUNCTIONAL }

const colorCandidates = Object.keys(COLORS).map(
  (name) => `bg-${name.replace('--color-', '')}`,
)

describe('BRAND-UI § 5 — couleur', () => {
  let css: string

  beforeAll(async () => {
    css = await compile(colorCandidates)
  }, 60_000)

  it.each(Object.entries(COLORS))('%s vaut %s dans la CSS compilée', (name, hex) => {
    expect(customProperty(css, name)).toBe(hex)
  })

  it('génère bien les utilitaires correspondants', () => {
    for (const candidate of colorCandidates) {
      expect(css).toContain(`.${candidate}`)
    }
  })

  it('refuse toute couleur hors palette', async () => {
    // « Six couleurs au total. [...] Rien d'autre. »
    const stray = await compile(['bg-emerald-500', 'text-slate-400', 'bg-blue-500'])

    expect(stray).not.toContain('.bg-emerald-500')
    expect(stray).not.toContain('.text-slate-400')
    expect(stray).not.toContain('.bg-blue-500')
  }, 60_000)
})

describe('BRAND-UI § 6 — typographie', () => {
  const SCALE = {
    'text-amount': { size: '40px', lineHeight: '44px', weight: '600' },
    'text-amount-sm': { size: '28px', lineHeight: '32px', weight: '600' },
    'text-title': { size: '22px', lineHeight: '28px', weight: '600' },
    'text-subtitle': { size: '18px', lineHeight: '26px', weight: '500' },
    'text-body': { size: '16px', lineHeight: '24px', weight: '400' },
    'text-label': { size: '14px', lineHeight: '20px', weight: '500' },
    'text-note': { size: '13px', lineHeight: '18px', weight: '400' },
  } as const

  let css: string

  beforeAll(async () => {
    css = await compile(Object.keys(SCALE))
  }, 60_000)

  it.each(Object.entries(SCALE))('%s respecte l\'échelle', (utility, expected) => {
    const token = `--${utility.replace('text-', 'text-')}`

    expect(customProperty(css, token)).toBe(expected.size)
    expect(customProperty(css, `${token}--line-height`)).toBe(expected.lineHeight)
    expect(customProperty(css, `${token}--font-weight`)).toBe(expected.weight)
  })

  it('ne descend jamais sous 13 px', () => {
    const sizes = Object.values(SCALE).map((entry) => Number.parseInt(entry.size, 10))

    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(13)
  })

  it('utilise IBM Plex Sans et IBM Plex Sans Arabic', async () => {
    const fonts = await compile(['font-sans'])
    const family = customProperty(fonts, '--font-sans')

    expect(family).toContain('IBM Plex Sans')
    expect(family).toContain('IBM Plex Sans Arabic')
  }, 60_000)
})

describe('BRAND-UI § 7 — espacement et cibles tactiles', () => {
  let css: string

  beforeAll(async () => {
    css = await compile([
      'p-1',
      'h-touch',
      'h-button',
      'h-field',
      'h-row',
      'rounded-none',
      'rounded-field',
      'rounded-card',
      'rounded-button',
      'shadow-floating',
    ])
  }, 60_000)

  it('a une base de 4 px', () => {
    expect(customProperty(css, '--spacing')).toBe('4px')
  })

  it.each([
    ['--spacing-touch', '48px'],
    ['--spacing-button', '56px'],
    ['--spacing-field', '56px'],
    ['--spacing-row', '64px'],
  ])('%s vaut %s', (name, value) => {
    expect(customProperty(css, name)).toBe(value)
  })

  it.each([
    ['--radius-none', '0px'],
    ['--radius-field', '8px'],
    ['--radius-card', '8px'],
    ['--radius-button', '10px'],
  ])('%s vaut %s', (name, value) => {
    expect(customProperty(css, name)).toBe(value)
  })

  it("n'expose qu'une seule ombre portée", () => {
    expect(customProperty(css, '--shadow-floating')).toBe('0 2px 8px rgb(16 18 22 / 0.12)')
  })
})
