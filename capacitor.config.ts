/*
 * L'enveloppe Android. E5-01 — SPEC § 2.7, RÈGLE de l'enveloppe Android.
 *
 * Elle existe pour une seule raison : un navigateur n'ouvre pas de socket TCP
 * vers le port 9100 d'une imprimante réseau. Tout le reste de l'application est
 * la même SPA, le même code, les mêmes écrans.
 *
 * `webDir: 'dist'` — les assets sont **empaquetés** dans l'APK, pas chargés
 * depuis le réseau. C'est ce que SPEC § 2.5 exige : l'application doit démarrer
 * après des jours sans réseau. La contrepartie est que chaque correctif est un
 * APK à réinstaller, et la distribution reste à trancher
 * (docs/PENDING-CHECKS.md).
 *
 * Aucun `server.url` : y pointer un site rendrait le premier démarrage
 * dépendant du réseau, ce qui est exactement ce que l'enveloppe ne doit pas
 * coûter.
 */

import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'ma.merx.app',
  appName: 'Merx',
  webDir: 'dist',
  android: {
    /*
     * **Faux par défaut, et c'est la décision.** La page est servie depuis
     * `https://localhost` (schéma Android de Capacitor) : un appel vers un
     * `http://` du réseau local est du contenu mixte, que la WebView refuse.
     * L'autoriser n'a de sens que pour un APK d'essai dirigé sur le stack local
     * d'un PC — en production, Supabase est en HTTPS et rien ne doit passer en
     * clair.
     *
     * La bascule est donc **une variable d'environnement de `cap sync`**, posée
     * par le seul workflow d'essai (`android-test-apk.yml`). Un APK construit
     * sans elle — celui de `main`, celui des pilotes — ne l'a pas.
     */
    allowMixedContent: process.env['MERX_TEST_CLEARTEXT'] === '1',
  },
}

export default config
