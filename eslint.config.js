import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `supabase/tests` est du TypeScript à part entière et reste analysé ; le
  // reste de `supabase/` est du SQL et des dossiers de travail de la CLI.
  //
  // `android/` est le projet natif engendré par Capacitor (E5-01) : du Java, du
  // Gradle, et une copie des assets web empaquetés que `cap sync` réécrit à
  // chaque build. Rien de ce qui s'y trouve n'est écrit à la main.
  {
    ignores: [
      'dist',
      'dev-dist',
      'node_modules',
      'android',
      'supabase/.branches',
      'supabase/.temp',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // Composants shadcn/ui générés par la CLI : ils exportent leurs variantes
    // à côté du composant. Convention amont, pas notre code.
    files: ['src/components/ui/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },
)
