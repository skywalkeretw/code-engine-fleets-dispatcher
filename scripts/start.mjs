// Starts the production build locally (`npm run build && npm start`).
//
// next.config.ts uses `output: 'standalone'`, so `next start` is not supported and the
// standalone server does not serve /public or /_next/static by itself. Copy them next
// to server.js (the Dockerfile does the same) and launch it.

import { cpSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const standalone = '.next/standalone'

if (!existsSync(`${standalone}/server.js`)) {
  console.error('No production build found. Run `npm run build` first.')
  process.exit(1)
}

cpSync('.next/static', `${standalone}/.next/static`, { recursive: true })
if (existsSync('public')) cpSync('public', `${standalone}/public`, { recursive: true })

const child = spawn(process.execPath, [`${standalone}/server.js`], {
  stdio: 'inherit',
  // Bind to localhost only: the app has no login and holds an IBM Cloud API key.
  env: { ...process.env, PORT: process.env.PORT ?? '8080', HOSTNAME: 'localhost' },
})
child.on('exit', code => process.exit(code ?? 0))
