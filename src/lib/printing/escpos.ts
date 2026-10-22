/*
 * L'encodeur ESC/POS. E5-01 — SPEC § 2.7, RÈGLE du ticket rendu en image.
 *
 * Ce fichier ne connaît ni le réseau, ni le canvas, ni la vente : il transforme
 * une image en 1 bit en une suite d'octets qu'une imprimante thermique sait
 * lire. Rien d'autre. C'est ce qui le rend vérifiable octet par octet, sans
 * imprimante et sans navigateur.
 *
 * **Aucune commande de texte ici, et c'est la décision de la story.** Les jeux
 * de caractères de l'imprimante ne lient pas les lettres arabes et ne gèrent
 * pas le sens droite-à-gauche ; leur documentation se révèle de surcroît
 * fausse d'un modèle à l'autre (docs/research/E5-02-arabe-thermique.md § 2). Le
 * ticket part donc en mode graphique, entièrement, pour le français comme pour
 * l'arabe : une seule voie à régler, une seule à tester.
 */

/** Une image en 1 bit par point, prête pour `GS v 0`. */
export interface Raster {
  /** Largeur en points. Multiple de 8 : c'est la largeur de la tête. */
  width: number
  /** Hauteur en points. */
  height: number
  /**
   * Les points, ligne par ligne, `width / 8` octets par ligne, bit de poids
   * fort à gauche. Un bit à 1 est un point noir.
   */
  dots: Uint8Array
}

/** `ESC @` — réinitialise. L'imprimante peut sortir d'un ticket interrompu. */
export const INITIALIZE = Uint8Array.of(0x1b, 0x40)

/**
 * Hauteur maximale d'une bande, en points.
 *
 * Une imprimante bon marché reçoit mal une image entière d'un bloc : le ticket
 * sort brouillé ou s'arrête à mi-chemin. 200 points est la valeur qu'emploient
 * les bibliothèques qui marchent (recherche § 3). Ce n'est pas une limite du
 * protocole, c'est une limite de la mémoire des imprimantes.
 */
export const MAX_BAND_ROWS = 200

/**
 * Taille maximale d'un lot d'écriture, en octets.
 *
 * Le découpage en lots ne coupe **jamais** une commande en deux : une bande
 * tronquée laisse l'imprimante attendre des points qui ne viennent pas, et
 * elle n'en sort qu'éteinte.
 */
export const MAX_BATCH_BYTES = 256 * 1024

function bytesPerRow(width: number): number {
  if (width % 8 !== 0) {
    throw new Error(`Largeur de tête invalide : ${width} points n'est pas un multiple de 8.`)
  }
  return width / 8
}

/**
 * `GS v 0` pour une bande : `1D 76 30 m xL xH yL yH` puis les points.
 *
 * `m = 0` : échelle normale. `xL/xH` est un nombre d'**octets** par ligne,
 * `yL/yH` un nombre de **lignes** — les deux sur deux octets, poids faible
 * d'abord.
 */
export function rasterBand(raster: Raster, firstRow: number, rows: number): Uint8Array {
  const stride = bytesPerRow(raster.width)
  const start = firstRow * stride
  const end = start + rows * stride

  if (firstRow < 0 || rows <= 0 || end > raster.dots.length) {
    throw new Error(`Bande hors de l'image : ${rows} lignes à partir de ${firstRow}.`)
  }

  const header = Uint8Array.of(
    0x1d,
    0x76,
    0x30,
    0x00,
    stride & 0xff,
    (stride >> 8) & 0xff,
    rows & 0xff,
    (rows >> 8) & 0xff,
  )

  const command = new Uint8Array(header.length + (end - start))
  command.set(header, 0)
  command.set(raster.dots.subarray(start, end), header.length)
  return command
}

/**
 * `ESC d n` puis `GS V 66 0` — avance le papier, puis coupe partiellement.
 *
 * L'avance avant la coupe n'est pas cosmétique : sans elle, la coupe tombe dans
 * la dernière ligne imprimée, et le client reçoit un total tranché en deux.
 */
export function feedAndCut(lines = 4): Uint8Array {
  if (lines < 0 || lines > 255) throw new Error(`Avance papier invalide : ${lines}.`)
  return Uint8Array.of(0x1b, 0x64, lines, 0x1d, 0x56, 0x42, 0x00)
}

/** Les commandes d'un ticket, dans l'ordre, une par bande. */
export function ticketCommands(raster: Raster): Uint8Array[] {
  const commands: Uint8Array[] = [INITIALIZE]

  for (let row = 0; row < raster.height; row += MAX_BAND_ROWS) {
    commands.push(rasterBand(raster, row, Math.min(MAX_BAND_ROWS, raster.height - row)))
  }

  commands.push(feedAndCut())
  return commands
}

/**
 * Les lots à écrire sur le socket, dans l'ordre.
 *
 * Une commande plus grande que `MAX_BATCH_BYTES` partirait seule dans son lot
 * plutôt que d'être coupée — mais `MAX_BAND_ROWS` la rend impossible : une
 * bande de 200 lignes sur 576 points pèse 14 408 octets.
 */
export function encodeTicket(raster: Raster): Uint8Array[] {
  const batches: Uint8Array[] = []
  let current: Uint8Array[] = []
  let size = 0

  const flush = (): void => {
    if (current.length === 0) return
    const batch = new Uint8Array(size)
    let at = 0
    for (const command of current) {
      batch.set(command, at)
      at += command.length
    }
    batches.push(batch)
    current = []
    size = 0
  }

  for (const command of ticketCommands(raster)) {
    if (size > 0 && size + command.length > MAX_BATCH_BYTES) flush()
    current.push(command)
    size += command.length
  }

  flush()
  return batches
}

/**
 * Les octets en base64 — c'est sous cette forme que le plugin natif les passe
 * au socket. Par tranches : `String.fromCharCode(...)` sur une image entière
 * dépasse la pile d'arguments.
 */
export function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(text)
}
