/*
 * Accès aux réglages du commerce. M8 — E1-05.
 *
 * Deux fonctions, et une seule idée : les lignes existent déjà. Un commerce est
 * créé avec une ligne par clé (`merx.seed_tenant_settings()`, appelée par
 * `create_tenant()`), donc ce fichier ne fait jamais d'insertion — il lit et il
 * modifie. C'est ce qui lui permet de ne connaître aucun `tenant_id` : la RLS
 * borne la lecture au commerce, et un UPDATE par clé n'a pas à dire lequel
 * (SPEC § 2.1 — aucune requête applicative ne filtre le tenant à la main).
 *
 * Et **aucune valeur par défaut n'est écrite ici**. Quand une valeur est
 * illisible — un jsonb d'une forme inattendue, une clé absente parce que
 * quelqu'un a supprimé la ligne à la main — les fonctions de lecture rendent du
 * vide. Le vide est un rendu, pas un défaut : il s'affiche, il ne s'enregistre
 * pas tant que le patron ne valide pas le formulaire. Le seul endroit où un
 * défaut est décidé reste `merx.setting_default`.
 *
 * L'écriture exige `manage_settings` (SPEC § 3.1) : ce sont les trois policies
 * restrictives de `tenant_setting` qui refusent, pas ce fichier. Un employé qui
 * appellerait `saveSettings()` obtiendrait zéro ligne modifiée, ce que
 * `writeSetting()` transforme en erreur plutôt qu'en succès silencieux.
 */

import { supabase } from '@/lib/supabase'
import {
  isLanguage,
  isPrinterWidth,
  type Language,
  type PrinterWidth,
  type PrintHeaderValue,
  type SettingKey,
} from '@/modules/admin/settingKeys'

/** Les réglages tels que l'écran les manipule. */
export interface Settings {
  printHeader: { businessName: string; phone: string; address: string }
  /** `''` si la valeur stockée n'est pas une langue connue — E11-01 tranchera. */
  language: Language | ''
  printerAddress: string
  /**
   * La largeur de la tête d'impression, en points (E5-01). `''` si la valeur
   * stockée n'est pas une des largeurs admises — même rendu que la langue, et
   * pour la même raison : l'écran montre « rien de choisi » plutôt qu'une
   * valeur inventée ici. L'impression thermique ne s'offre alors pas
   * (SPEC § 2.6), ce qui vaut mieux qu'un ticket imprimé de travers.
   */
  printerWidth: PrinterWidth | ''
}

interface SettingRow {
  key: SettingKey
  value: unknown
}

/**
 * Une chaîne, ou du vide. Ce n'est pas un défaut : c'est ce qu'un champ de
 * formulaire affiche quand la valeur stockée n'est pas affichable.
 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asPrintHeader(value: unknown): Settings['printHeader'] {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as
    Partial<PrintHeaderValue>

  return {
    businessName: asText(stored.business_name),
    phone: asText(stored.phone),
    address: asText(stored.address),
  }
}

/** Les réglages du commerce. La RLS décide de quel commerce il s'agit. */
export async function loadSettings(): Promise<Settings> {
  const { data, error } = await supabase.from('tenant_setting').select('key, value')

  if (error !== null) throw new Error(error.message)

  const rows = new Map((data as SettingRow[]).map((row) => [row.key, row.value]))
  const language = rows.get('default_language')
  const width = rows.get('printer_width')

  return {
    printHeader: asPrintHeader(rows.get('print_header')),
    language: isLanguage(language) ? language : '',
    printerAddress: asText(rows.get('printer_address')),
    printerWidth: isPrinterWidth(width) ? width : '',
  }
}

/**
 * Écrit une clé, et exige d'avoir touché sa ligne.
 *
 * Un UPDATE refusé par la RLS ne lève pas : il ne trouve aucune ligne. Sans ce
 * contrôle, un employé qui forcerait la route verrait « Enregistré » sans que
 * rien ne le soit — et c'est aussi le symptôme d'une ligne manquante, c'est-à-
 * dire de l'invariant rompu. Les deux méritent d'être dits plutôt que tus.
 */
async function writeSetting(key: SettingKey, value: unknown): Promise<void> {
  const { data, error } = await supabase
    .from('tenant_setting')
    .update({ value })
    .eq('key', key)
    .select('id')

  if (error !== null) throw new Error(error.message)
  if ((data as unknown[] | null)?.length !== 1) {
    throw new Error("Réglage non enregistré : ce compte n'a pas le droit de le modifier.")
  }
}

/**
 * Enregistre ce qui a changé, et rien d'autre.
 *
 * Le diff n'est pas une optimisation de confort : chaque écriture est une ligne
 * de plus à réconcilier au retour du réseau (SPEC § 2.5), et réécrire un
 * en-tête d'impression identique parce qu'on a corrigé l'adresse d'imprimante
 * n'a aucune raison de traverser la synchronisation.
 */
export async function saveSettings(previous: Settings, next: Settings): Promise<void> {
  if (next.printerAddress !== previous.printerAddress) {
    await writeSetting('printer_address', next.printerAddress)
  }

  if (next.language !== previous.language && next.language !== '') {
    await writeSetting('default_language', next.language)
  }

  if (next.printerWidth !== previous.printerWidth && next.printerWidth !== '') {
    await writeSetting('printer_width', next.printerWidth)
  }

  const header = next.printHeader
  const before = previous.printHeader
  if (
    header.businessName !== before.businessName ||
    header.phone !== before.phone ||
    header.address !== before.address
  ) {
    const value: PrintHeaderValue = {
      business_name: header.businessName,
      phone: header.phone,
      address: header.address,
    }
    await writeSetting('print_header', value)
  }
}
