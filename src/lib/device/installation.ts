/*
 * L'identité de l'appareil, côté client. E1-03.
 *
 * SPEC § 2.5, RÈGLE numérotation : les numéros de document sont attribués
 * localement, préfixés par une lettre d'appareil. Encore faut-il que l'appareil
 * sache qui il est — et qu'il le sache **avant** de parler au serveur, sinon
 * chaque démarrage fabriquerait un nouvel appareil, donc consommerait une
 * nouvelle lettre, et les 26 du commerce seraient brûlées en une semaine.
 *
 * L'identifiant est donc engendré ici, une fois, et conservé. Le serveur ne
 * l'attribue pas : `register_device()` le reçoit et s'en sert comme clé
 * primaire, ce qui rend l'enregistrement idempotent — le même appel répété ne
 * crée rien de plus.
 *
 * C'est aussi la direction que E10 impose : en local-first, une ligne naît sur
 * l'appareil, avec son identifiant, sans attendre le réseau.
 */

/** Clé du stockage local. Nommée, comme `SESSION_STORAGE_KEY` : une clé par
 * défaut se confond entre projets servis sur la même origine. */
export const DEVICE_STORAGE_KEY = 'merx.device'

/*
 * Le repli quand le stockage local est refusé — navigation privée, quota
 * saturé, réglage d'entreprise. L'identifiant vit alors le temps de l'onglet.
 *
 * La conséquence est réelle et assumée : un appareil dans cet état
 * s'enregistrera deux fois et consommera deux lettres. C'est préférable à
 * l'alternative — refuser de démarrer, ou tourner sans identité, donc sans
 * pouvoir numéroter un bon. Un navigateur qui ne garde rien ne peut de toute
 * façon pas tenir sept jours hors ligne (SPEC § 2.5) ; le problème se voit
 * ailleurs, plus tôt.
 */
let inMemory: string | null = null

/*
 * Le stockage local est l'autorité tant qu'il répond : le repli mémoire ne sert
 * que lorsqu'il a *refusé*, jamais lorsqu'il est simplement vide. La nuance
 * décide de tout — dans l'autre sens, un appareil dont on vide les données
 * garderait en mémoire un identifiant que plus rien ne persiste, et le
 * redémarrage suivant en fabriquerait un troisième. On croirait l'identité
 * stable en n'observant que la session en cours.
 */

/** Ce que le stockage a rendu : une valeur, rien, ou un refus. `localStorage`
 * lève à la *lecture* dans certains réglages, pas seulement à l'écriture. */
const REFUSED = Symbol('stockage refusé')

function read(): string | null | typeof REFUSED {
  try {
    return window.localStorage.getItem(DEVICE_STORAGE_KEY)
  } catch {
    return REFUSED
  }
}

/** `true` si la valeur est bien posée. `false` : quota, mode privé. */
function write(value: string): boolean {
  try {
    window.localStorage.setItem(DEVICE_STORAGE_KEY, value)
    return true
  } catch {
    return false
  }
}

/*
 * Un uuid, de la source la plus sûre disponible. `crypto.randomUUID()` n'existe
 * pas sur les WebView anciennes ni hors contexte sécurisé — et les tablettes du
 * terrain sont exactement ce parc-là. Le repli tire les mêmes 122 bits
 * d'aléatoire par `getRandomValues`, sans inventer un générateur maison.
 */
function newIdentifier(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  )
}

/** Forme d'un uuid. Une valeur abîmée dans le stockage — édition manuelle,
 * migration d'un ancien format — serait refusée par la base en `22P02` : mieux
 * vaut la remplacer ici que de laisser l'appareil ne plus jamais s'enregistrer. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * L'identifiant de cette installation. Le même à chaque appel, et à chaque
 * démarrage tant que le stockage local le garde.
 */
export function installationId(): string {
  const saved = read()
  if (saved !== REFUSED && saved !== null && UUID.test(saved)) return saved

  // Le stockage ne rend rien d'exploitable. S'il en a déjà refusé un, c'est
  // celui-là qui vaut : sans quoi chaque appel changerait d'appareil.
  if (inMemory !== null) return inMemory

  const created = newIdentifier()
  if (!write(created)) inMemory = created
  return created
}
