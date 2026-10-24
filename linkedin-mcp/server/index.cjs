// linkedin-mcp — HTTP front door. Loads config, owns the token, routes /mcp.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.join(__dirname, '..')
const DATA_DIR = process.env.LINKEDIN_MCP_DATA || path.join(ROOT, 'data')
const PORT = Number(process.env.LINKEDIN_MCP_PORT || 42834)
const HOST = process.env.LINKEDIN_MCP_HOST || '127.0.0.1'
const MAX_BODY = 1024 * 1024

// Config lives in .env next to the code. Existing values in the environment win, so the
// systemd unit or a shell export can override a file that is shared with other tooling.
function loadEnv(file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 1) continue
    const k = t.slice(0, i).trim()
    if (process.env[k] === undefined) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
}
loadEnv(path.join(ROOT, '.env'))

// The token is generated once and persisted. Regenerating it on every restart would silently
// break every connector already holding the URL.
function loadToken() {
  if (process.env.LINKEDIN_MCP_TOKEN) return process.env.LINKEDIN_MCP_TOKEN
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const file = path.join(DATA_DIR, 'mcp-token.txt')
  if (fs.existsSync(file)) {
    const t = fs.readFileSync(file, 'utf8').trim()
    if (t) return t
  }
  const t = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, t + '\n', { mode: 0o600 })
  return t
}

const token = loadToken()
const allowWrites = process.env.LINKEDIN_MCP_READONLY !== '1'
const uni = require('./unipile.cjs')
const careerOps = require('./careerops.cjs')

let mcpHandler = null
async function getHandler() {
  if (!mcpHandler) {
    const { createMcpHandler } = await import('./mcp.mjs')
    mcpHandler = createMcpHandler({ uni, token, allowWrites, careerOps })
  }
  return mcpHandler
}

const readBody = (req) => new Promise((resolve, reject) => {
  let b = ''
  req.on('data', (c) => { b += c; if (b.length > MAX_BODY) { req.destroy(); reject(new Error('payload too large')) } })
  req.on('end', () => resolve(b))
  req.on('error', reject)
})

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname
  try {
    if (p === '/healthz') {
      let unipile = 'unconfigured'
      try { uni.config(); unipile = 'configured' } catch { /* leave unconfigured */ }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, app: 'linkedin-mcp', unipile, account: uni.defaultAccount() || null, writes: allowWrites }))
    }

    if (p === '/mcp') {
      // A connector that probes with GET must not be left holding an SSE stream that never
      // closes — that hangs the dialog instead of failing it. Say POST-only and be done.
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' })
        return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'This MCP endpoint accepts POST only.' }, id: null }))
      }
      const handler = await getHandler()
      return handler(req, res, await readBody(req))
    }

    if (p === '/' || p === '') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      return res.end('LinkedIn MCP server (Unipile). POST /mcp with ?token= or a bearer-token to connect an AI client.\n')
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found', hint: 'This is an MCP server; use POST /mcp' }))
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(e?.message || e) }))
    } else res.end()
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[linkedin-mcp] listening on http://${HOST}:${PORT}`)
  console.log(`[linkedin-mcp] account=${uni.defaultAccount() || '(unset)'} writes=${allowWrites ? 'enabled' : 'READ-ONLY'}`)
  console.log(`[linkedin-mcp] token stored at ${path.join(DATA_DIR, 'mcp-token.txt')}`)
})
