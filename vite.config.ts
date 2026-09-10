/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Merx',
        short_name: 'Merx',
        description: 'Gestion pour commerces de gros',
        lang: 'fr',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#2B3C99',
        theme_color: '#2B3C99',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
        // Le catalogue doit rester consultable plusieurs jours sans réseau (SPEC § 2.5).
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    /*
     * Vite ne charge pas `.env.local` en mode test, et `src/lib/supabase.ts`
     * refuse de se construire sans ses deux variables — à raison : un client
     * pointant sur `undefined` échouerait au premier appel réseau, loin de la
     * cause. Les valeurs du stack local suffisent : aucun test unitaire ne
     * s'adresse à ce client, ils injectent tous un doublon (`AuthClient`).
     */
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54521',
      VITE_SUPABASE_ANON_KEY: 'anon-key-de-test',
    },
    /*
     * Deux populations de tests, deux régimes.
     *
     * Ceux de `src` sont indépendants : chacun monte ce qu'il teste et n'a
     * aucun état partagé. Ils tournent en parallèle, en jsdom.
     *
     * Ceux de `supabase/tests` écrivent tous dans **la même** base locale.
     * `isolation.test.ts` y peuple deux commerces entiers, `permissions.test.ts`
     * (E0-05) y crée et détruit des tables témoin, et `conventions.test.ts`
     * balaie tout `public` en exigeant de n'y trouver que des tables
     * conventionnées. Les laisser en parallèle, c'est faire échouer le
     * balayage un jour sur cinq parce qu'il a croisé une table d'un autre
     * fichier — un échec sans rapport avec ce qu'il vérifie, et qui apprend à
     * relancer plutôt qu'à lire. Ils tournent donc en série, en node.
     */
    projects: [
      {
        extends: true,
        test: {
          name: 'front',
          environment: 'jsdom',
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'base',
          environment: 'node',
          include: ['supabase/tests/**/*.{test,spec}.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
})
