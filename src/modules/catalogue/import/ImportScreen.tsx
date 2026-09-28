/*
 * L'import du catalogue. M1 — E2-05, point de rupture n° 1 (SPEC § 10).
 *
 * « Si 2 000 références ne rentrent pas en moins d'une heure, rien d'autre ne
 * compte. » Cet écran est le premier contact réel d'un commerçant avec Merx :
 * il arrive avec un fichier Excel qu'il tient depuis des années, et ce fichier
 * est toujours irrégulier — colonnes vides, prix en texte, accents cassés,
 * références en double. L'écran ne lui reproche rien ; il montre ce qu'il a
 * compris, dit ce qu'il ne peut pas lire, et importe le reste.
 *
 * Quatre étapes, dans cet ordre, parce que chacune répond à une question qu'il
 * se pose : « est-ce que mon fichier passe ? », « as-tu compris mes
 * colonnes ? », « qu'est-ce qui va entrer ? », « qu'est-ce qui n'est pas
 * entré ? » (BACKLOG E2-05).
 *
 * Écran de détail : un retour vers Produits, aucune barre d'onglets, et
 * l'action principale en bas (BRAND-UI § 7, § 13).
 */

import { useMemo, useRef, useState } from 'react'

import { BackLink } from '@/components/BackLink'
import { Button } from '@/components/ui/button'
import { useCan } from '@/lib/auth'
import {
  DELIMITERS,
  DELIMITER_LABELS,
  type Delimiter,
} from '@/modules/catalogue/import/csv'
import { FIELDS, proposeMapping, type Field, type Mapping } from '@/modules/catalogue/import/columns'
import { ENCODING_LABELS, type Encoding } from '@/modules/catalogue/import/encoding'
import {
  importRows,
  rejectsCsv,
  type ImportProgress,
  type ImportResult,
} from '@/modules/catalogue/import/importer'
import { prepareRows, type RejectedRow } from '@/modules/catalogue/import/rows'
import {
  ACCEPTED_EXTENSIONS,
  kindOf,
  readCsv,
  readWorkbook,
  type FileKind,
} from '@/modules/catalogue/import/workbook'

/** Les vingt premières lignes, avant validation (BACKLOG E2-05). */
const PREVIEW_ROWS = 20

type Step = 'file' | 'mapping' | 'running' | 'done'

interface Loaded {
  name: string
  kind: FileKind
  bytes: Uint8Array
  table: string[][]
  encoding?: Encoding
  delimiter?: Delimiter
}

const SECONDARY =
  'flex h-button w-full items-center justify-center rounded-button border border-paper-300 bg-white text-body text-ink-700'

const SELECT =
  'h-field w-full rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900 focus-visible:border-ink-600'

function Counts({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-body text-paper-700">{label}</dt>
      <dd className="tabular text-subtitle text-paper-900">{value}</dd>
    </div>
  )
}

export function ImportScreen() {
  const withCost = useCan('view_cost')
  const fileInput = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('file')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [mapping, setMapping] = useState<Mapping>({})
  const [progress, setProgress] = useState<ImportProgress>({ done: 0, total: 0 })
  const [result, setResult] = useState<ImportResult | null>(null)
  const [refusedRows, setRefusedRows] = useState<RejectedRow[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [reading, setReading] = useState(false)

  const headers = loaded?.table[0] ?? []
  const fields = useMemo(
    () => FIELDS.filter((spec) => withCost || spec.confidential !== true),
    [withCost],
  )

  const prepared = useMemo(
    () => (loaded === null ? null : prepareRows(loaded.table, mapping)),
    [loaded, mapping],
  )

  const open = async (file: File): Promise<void> => {
    setFailure(null)
    setReading(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const kind = kindOf(file.name)
      const next: Loaded =
        kind === 'xlsx'
          ? { name: file.name, kind, bytes, table: await readWorkbook(bytes) }
          : { name: file.name, kind, bytes, ...readCsv(bytes) }

      if (next.table.length < 2) {
        setFailure('Ce fichier ne contient pas de lignes à importer.')
        return
      }
      setLoaded(next)
      setMapping(proposeMapping(next.table[0] ?? [], next.table.slice(1, 50), withCost))
      setResult(null)
      setStep('mapping')
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Fichier illisible.')
    } finally {
      setReading(false)
    }
  }

  /* Relire le même fichier autrement : l'encodage et le séparateur se corrigent. */
  const reread = (encoding: Encoding | undefined, delimiter: Delimiter | undefined): void => {
    if (loaded === null || loaded.kind !== 'csv') return
    const next = readCsv(loaded.bytes, encoding ?? loaded.encoding, delimiter ?? loaded.delimiter)
    const table = next.table
    setLoaded({ ...loaded, ...next })
    setMapping(proposeMapping(table[0] ?? [], table.slice(1, 50), withCost))
  }

  const choose = (field: Field, value: string): void => {
    setMapping((current) => {
      const next = { ...current }
      if (value === '') delete next[field]
      else next[field] = Number.parseInt(value, 10)
      return next
    })
  }

  const run = async (): Promise<void> => {
    if (prepared === null) return
    setFailure(null)
    setStep('running')
    setProgress({ done: 0, total: prepared.rows.length })
    const cells = new Map(prepared.rejected.map((reject) => [reject.line, reject.cells]))
    for (const row of prepared.rows) {
      cells.set(row.line, loaded?.table[row.line - 1] ?? [])
    }

    try {
      const outcome = await importRows(
        prepared.rows,
        (line) => cells.get(line) ?? [],
        setProgress,
      )
      setResult(outcome)
      setRefusedRows([...prepared.rejected, ...outcome.rejected].sort((a, b) => a.line - b.line))
      setStep('done')
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Import impossible.')
      setStep('mapping')
    }
  }

  const download = (): void => {
    const blob = new Blob([rejectsCsv(headers, refusedRows)], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'rejets-import.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const restart = (): void => {
    setLoaded(null)
    setMapping({})
    setResult(null)
    setRefusedRows([])
    setFailure(null)
    setStep('file')
    if (fileInput.current !== null) fileInput.current.value = ''
  }

  return (
    <main className="px-4 py-6 pb-32">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <BackLink to="/products" label="Produits" />
        <h1 className="text-title text-paper-900">Importer un fichier</h1>

        {failure !== null && (
          <p role="alert" className="text-body text-red-600">
            {failure}
          </p>
        )}

        {step === 'file' && (
          <div className="flex flex-col gap-4">
            <p className="text-body text-paper-700">
              Un fichier Excel (.xlsx) ou CSV, une ligne par produit. La première ligne porte les
              noms de colonnes.
            </p>
            <label htmlFor="import-file" className="text-label text-paper-700">
              Fichier à importer
            </label>
            <input
              id="import-file"
              ref={fileInput}
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              disabled={reading}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file !== undefined) void open(file)
              }}
              className="h-field w-full rounded-field border border-paper-300 bg-white px-4 py-3 text-body text-paper-900"
            />
          </div>
        )}

        {step === 'mapping' && loaded !== null && prepared !== null && (
          <>
            <p className="text-body text-paper-700">
              {loaded.name} — {prepared.counts.total} ligne
              {prepared.counts.total > 1 ? 's' : ''} lue
              {prepared.counts.total > 1 ? 's' : ''}.
            </p>

            {loaded.kind === 'csv' && (
              <section aria-labelledby="reading-title" className="flex flex-col gap-4">
                <h2 id="reading-title" className="text-subtitle text-paper-900">
                  Lecture du fichier
                </h2>
                <div className="flex flex-col gap-2">
                  <label htmlFor="import-encoding" className="text-label text-paper-700">
                    Jeu de caractères
                  </label>
                  <select
                    id="import-encoding"
                    value={loaded.encoding}
                    onChange={(event) => reread(event.target.value as Encoding, undefined)}
                    className={SELECT}
                  >
                    {Object.entries(ENCODING_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <label htmlFor="import-delimiter" className="text-label text-paper-700">
                    Séparateur de colonnes
                  </label>
                  <select
                    id="import-delimiter"
                    value={loaded.delimiter}
                    onChange={(event) => reread(undefined, event.target.value as Delimiter)}
                    className={SELECT}
                  >
                    {DELIMITERS.map((value) => (
                      <option key={value} value={value}>
                        {DELIMITER_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </div>
              </section>
            )}

            <section aria-labelledby="mapping-title" className="flex flex-col gap-4">
              <h2 id="mapping-title" className="text-subtitle text-paper-900">
                Correspondance des colonnes
              </h2>
              {fields.map((spec) => (
                <div key={spec.field} className="flex flex-col gap-2">
                  <label htmlFor={`map-${spec.field}`} className="text-label text-paper-700">
                    {spec.label}
                    {spec.hint !== '' && <span className="text-paper-600"> — {spec.hint}</span>}
                  </label>
                  <select
                    id={`map-${spec.field}`}
                    value={mapping[spec.field] ?? ''}
                    onChange={(event) => choose(spec.field, event.target.value)}
                    className={SELECT}
                  >
                    <option value="">Aucune colonne</option>
                    {headers.map((header, column) => (
                      <option key={column} value={column}>
                        {header.trim() === '' ? `Colonne ${column + 1}` : header}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </section>

            <section aria-labelledby="preview-title" className="flex flex-col gap-4">
              <h2 id="preview-title" className="text-subtitle text-paper-900">
                Aperçu des {PREVIEW_ROWS} premières lignes
              </h2>
              <div className="overflow-x-auto rounded-card border border-paper-200 bg-white">
                <table className="w-full text-body text-paper-900">
                  <thead>
                    <tr className="border-b border-paper-200 text-start">
                      <th scope="col" className="p-2 text-start text-label text-paper-700">
                        Ligne
                      </th>
                      {fields
                        .filter((spec) => mapping[spec.field] !== undefined)
                        .map((spec) => (
                          <th
                            key={spec.field}
                            scope="col"
                            className="p-2 text-start text-label text-paper-700"
                          >
                            {spec.label}
                          </th>
                        ))}
                    </tr>
                  </thead>
                  <tbody>
                    {prepared.rows.slice(0, PREVIEW_ROWS).map((row) => (
                      <tr key={row.line} className="border-b border-paper-200 last:border-b-0">
                        <td className="tabular p-2 text-paper-700">{row.line}</td>
                        {fields
                          .filter((spec) => mapping[spec.field] !== undefined)
                          .map((spec) => (
                            <td key={spec.field} className="p-2" dir="auto">
                              {String(row[spec.field] ?? '')}
                            </td>
                          ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <dl className="flex flex-col gap-2 rounded-card border border-paper-200 bg-white p-4">
                <Counts label="Lignes prêtes à importer" value={prepared.counts.ready} />
                <Counts label="Lignes rejetées avant envoi" value={prepared.counts.rejected} />
                <Counts label="Sans référence (recréées à chaque import)" value={prepared.counts.withoutCode} />
                <Counts label="Prix de vente absent (cellule vide)" value={prepared.counts.priceMissing} />
                <Counts label="Prix de vente à 0 (importé sans prix)" value={prepared.counts.priceZero} />
              </dl>

              {prepared.rejected.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {prepared.rejected.slice(0, 5).map((reject) => (
                    <li key={reject.line} className="text-body text-red-600">
                      Ligne {reject.line} — {reject.motif}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="flex flex-col gap-2">
              <Button
                type="button"
                disabled={prepared.counts.ready === 0}
                onClick={() => void run()}
                className="h-button w-full rounded-button bg-ink-600 text-body text-white"
              >
                Importer {prepared.counts.ready} ligne{prepared.counts.ready > 1 ? 's' : ''}
              </Button>
              <button type="button" onClick={restart} className={SECONDARY}>
                Choisir un autre fichier
              </button>
            </div>
          </>
        )}

        {step === 'running' && (
          <div className="flex flex-col gap-4" aria-busy="true">
            <p role="status" className="text-body text-paper-900">
              Import en cours — <span className="tabular">{progress.done}</span> sur{' '}
              <span className="tabular">{progress.total}</span> lignes.
            </p>
            <div className="h-2 w-full rounded-field bg-paper-100">
              <div
                className="h-2 rounded-field bg-ink-600"
                style={{
                  width: `${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%`,
                }}
              />
            </div>
            <p className="text-body text-paper-700">
              Ne fermez pas l’écran. Les lignes déjà envoyées sont enregistrées.
            </p>
          </div>
        )}

        {step === 'done' && result !== null && (
          <section aria-labelledby="report-title" className="flex flex-col gap-4">
            <h2 id="report-title" className="text-subtitle text-paper-900">
              Import terminé
            </h2>
            <dl className="flex flex-col gap-2 rounded-card border border-paper-200 bg-white p-4">
              <Counts label="Produits créés" value={result.created} />
              <Counts label="Produits mis à jour" value={result.updated} />
              <Counts label="Produits déjà à jour" value={result.unchanged} />
              <Counts label="Lignes rejetées" value={refusedRows.length} />
            </dl>

            {refusedRows.length > 0 && (
              <>
                <ul className="flex flex-col gap-2">
                  {refusedRows.slice(0, 5).map((reject) => (
                    <li key={reject.line} className="text-body text-red-600">
                      Ligne {reject.line} — {reject.motif}
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={download} className={SECONDARY}>
                  Télécharger les lignes rejetées
                </button>
                <p className="text-body text-paper-700">
                  Corrigez ce fichier et réimportez-le : les produits déjà entrés seront mis à jour,
                  pas dupliqués.
                </p>
              </>
            )}

            <button type="button" onClick={restart} className={SECONDARY}>
              Importer un autre fichier
            </button>
          </section>
        )}
      </div>
    </main>
  )
}
