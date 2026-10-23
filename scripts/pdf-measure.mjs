/*
 * La mesure de la taille du PDF. E5-03.
 *
 * Le PDF part par WhatsApp, souvent en 3G : sa taille est une décision, pas une
 * conséquence. Et elle ne se mesure que dans un vrai navigateur — les octets
 * sont ceux du canvas comprimés par `deflate`, et jsdom n'a pas de contexte 2D.
 *
 * Ce script sert donc `scripts/pdf-measure.client.ts` à un Chrome sans fenêtre,
 * par le serveur de développement de Vite, et lit le résultat par le protocole
 * DevTools. Il écrit aussi les PDF dans `.pdf-measure/`, qui sont **ce qu'il
 * faut ouvrir** pour la vérification à l'œil, sur un écran de téléphone.
 *
 * Même famille que `npm run printer:fake` : un harnais qui remplace un matériel
 * absent, pas un test de la suite.
 *
 *   npm run pdf:measure
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createServer } from 'vite'

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((path) => existsSync(path))

if (CHROME === undefined) {
  console.error('Aucun Chrome ni Edge trouvé : la mesure demande un vrai moteur de rendu.')
  process.exit(1)
}

const PAGE = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>Mesure du PDF</title>
    <link rel="stylesheet" href="/src/styles/index.css" />
  </head>
  <body>
    <p>Mesure en cours…</p>
    <script type="module" src="/scripts/pdf-measure.client.ts"></script>
  </body>
</html>
`

/** Une page servie en mémoire : rien à écrire dans l'arbre du projet. */
const server = await createServer({
  configFile: 'vite.config.ts',
  /*
   * L'adresse est posee, pas deduite : `localhost` se resout vers `::1` sur
   * cette machine, et Chrome lance sur `127.0.0.1` recevait un refus de
   * connexion — une page blanche, sans console, qui ressemble a une mesure qui
   * n'a rien rendu.
   */
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
  plugins: [
    {
      name: 'merx-pdf-measure',
      configureServer(dev) {
        dev.middlewares.use('/pdf-measure', (_request, response) => {
          dev.transformIndexHtml('/pdf-measure', PAGE).then((html) => {
            response.setHeader('Content-Type', 'text/html')
            response.end(html)
          })
        })
      },
    },
  ],
})

await server.listen()
const url = `http://127.0.0.1:5199/pdf-measure`

const profile = mkdtempSync(join(tmpdir(), 'merx-pdf-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--remote-debugging-port=9333',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  url,
])

chrome.stderr.on('data', () => undefined)

/** Attend que DevTools réponde, puis trouve l'onglet de la page. */
async function devtools() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await fetch('http://127.0.0.1:9333/json/list').then((r) => r.json())
      const page = targets.find((target) => target.type === 'page' && target.url.includes('pdf-measure'))
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch {
      /* Chrome n'écoute pas encore. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error("Chrome n'a pas ouvert la page de mesure.")
}

function connect(endpoint) {
  const socket = new WebSocket(endpoint)
  let next = 1
  const waiting = new Map()
  /*
   * Les evenements sans `id` sont la console de la page. Sans eux, un module
   * qui ne charge pas ressemble a une page qui n'a rien rendu : le script
   * attendrait deux minutes puis dirait la mauvaise chose.
   */
  const console_ = []

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) {
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(' ')
        console_.push(`${message.params.type}: ${text}`)
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails
        console_.push(`exception: ${details.exception?.description ?? details.text}`)
      }
      return
    }
    const pending = waiting.get(message.id)
    if (pending !== undefined) {
      waiting.delete(message.id)
      pending(message)
    }
  })

  const open = new Promise((resolve) => socket.addEventListener('open', resolve))

  return {
    console: console_,
    async send(method, params) {
      await open
      const id = next
      next += 1
      return new Promise((resolve) => {
        waiting.set(id, resolve)
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close: () => socket.close(),
  }
}

/**
 * Le resultat que la page pose sur `window`, attendu par scrutation.
 *
 * Un rechargement a mi-parcours, et ce n'est pas une precaution : au premier
 * lancement Vite reoptimise ses dependances et repond `504` aux modules
 * decouverts pendant ce temps-la. Le module ne charge alors jamais, et la page
 * reste muette sans rien dire.
 */
async function result(session) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const answer = await session.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__merxPdf ?? null)',
      returnByValue: true,
      awaitPromise: true,
    })
    const value = answer.result?.result?.value
    if (typeof value === 'string' && value !== 'null') return JSON.parse(value)

    if (attempt === 30) await session.send('Page.reload', { ignoreCache: true })
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  const seen = session.console.length === 0 ? '(console vide)' : session.console.join('\n    ')
  throw new Error(`La page de mesure n'a rien rendu.\n    ${seen}`)
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} Ko`

try {
  const session = connect(await devtools())
  await session.send('Runtime.enable', {})
  await session.send('Page.enable', {})
  const measured = await result(session)
  session.close()

  if (measured.error !== undefined) {
    console.error(`La page a échoué : ${measured.error}`)
    process.exitCode = 1
  } else {
    const out = join(process.cwd(), '.pdf-measure')
    mkdirSync(out, { recursive: true })

    console.log('')
    console.log('  échelle  cas          lignes  pages  taille')
    console.log('  -------  -----------  ------  -----  ---------')
    for (const row of measured.measured) {
      console.log(
        `  ${String(row.scale).padEnd(7)}  ${row.name.padEnd(11)}  ${String(row.lines).padStart(6)}  ${String(row.pages).padStart(5)}  ${kb(row.bytes).padStart(9)}`,
      )
      writeFileSync(join(out, `${row.name}-x${row.scale}.pdf`), Buffer.from(row.base64, 'base64'))
    }
    for (const shot of measured.previews) {
      writeFileSync(join(out, `apercu-${shot.name}.png`), Buffer.from(shot.png, 'base64'))
      console.log(`  aperçu ${shot.name} : ${shot.width} × ${shot.height} points`)
    }

    console.log('')
    console.log(`  Les PDF sont dans ${out} — à ouvrir sur un téléphone.`)
    console.log('')
  }
} finally {
  chrome.kill()
  await server.close()
}
