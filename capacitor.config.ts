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
     * Le stack de développement est servi en clair sur le LAN
     * (`http://<IP>:54521`, CLAUDE.md « Testing on a real phone »). En
     * production, Supabase est en HTTPS et rien ne passe en clair.
     */
    allowMixedContent: true,
  },
}

export default config
