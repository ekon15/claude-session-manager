#!/usr/bin/env tsx
/**
 * Claude Code Session Manager
 * Usage: tsx scripts/session-ui.ts [--port 7367]
 */

import { createServer } from 'http'
import { readdir, readFile, stat, writeFile, mkdir } from 'fs/promises'
import { join, basename } from 'path'
import { homedir, tmpdir } from 'os'
import { execSync, exec } from 'child_process'
import { promisify } from 'util'
import { createRequire } from 'module'
import { config as loadEnv } from 'dotenv'
import { WebSocketServer, WebSocket } from 'ws'

const _require = createRequire(import.meta.url)
// node-pty is CJS-only; graceful fallback if not installed
let nodePty: { spawn: Function } | null = null
try { nodePty = _require('node-pty') } catch { nodePty = null }

loadEnv() // picks up ANTHROPIC_API_KEY from .env if present

const execAsync = promisify(exec)

const PORT = parseInt(process.argv[process.argv.indexOf('--port') + 1] || '7367', 10) || 7367
const META_PATH = join(homedir(), '.claude', 'session-manager.json')

// ─── Types ───────────────────────────────────────────────────────────────────

interface SessionMeta {
  title?: string
  description?: string
  tags?: string[]
  pinned?: boolean
  archived?: boolean
  deletedAt?: string
}

interface MetaStore {
  sessions: Record<string, SessionMeta>
}

interface Session {
  id: string
  project: string
  cwd: string
  firstMessage: string
  lastMessage: string
  lastModified: number
  messageCount: number
  gitBranch: string
  // merged from metadata
  title?: string
  description?: string
  tags?: string[]
  pinned?: boolean
  archived?: boolean
}

// ─── Metadata store ──────────────────────────────────────────────────────────

async function readMeta(): Promise<MetaStore> {
  try {
    return JSON.parse(await readFile(META_PATH, 'utf-8'))
  } catch {
    return { sessions: {} }
  }
}

async function writeMeta(store: MetaStore): Promise<void> {
  await mkdir(join(homedir(), '.claude'), { recursive: true })
  await writeFile(META_PATH, JSON.stringify(store, null, 2))
}

async function updateSessionMeta(id: string, patch: Partial<SessionMeta>): Promise<void> {
  const store = await readMeta()
  store.sessions[id] = { ...store.sessions[id], ...patch }
  await writeMeta(store)
}

async function tagPlaygroundSessions(after: number, cwd: string): Promise<number> {
  const projectsDir = join(homedir(), '.claude', 'projects')
  const projects = await readdir(projectsDir).catch(() => [] as string[])
  let tagged = 0
  for (const project of projects) {
    const files = await readdir(join(projectsDir, project)).catch(() => [] as string[])
    for (const file of files.filter(f => f.endsWith('.jsonl'))) {
      const filePath = join(projectsDir, project, file)
      const s = await stat(filePath).catch(() => null)
      if (!s) continue
      if (s.birthtimeMs <= after) continue  // only sessions CREATED after playground started
      const fileCwd = await getFirstCwd(filePath)
      if (fileCwd !== cwd) continue
      const id = basename(file, '.jsonl')
      const existing = (await readMeta()).sessions[id] ?? {}
      const tags = [...new Set([...(existing.tags ?? []), 'playground'])]
      await updateSessionMeta(id, { tags, archived: true })
      tagged++
    }
  }
  return tagged
}

// ─── Session reader ───────────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'text') {
        const t = (c.text ?? '').trim()
        if (t && !t.startsWith('<')) return t.replace(/\s+/g, ' ')
      }
    }
    return ''
  }
  if (typeof content === 'string') {
    const t = content.trim()
    return t.startsWith('<') ? '' : t.replace(/\s+/g, ' ')
  }
  return ''
}

async function readSessions(): Promise<Session[]> {
  const projectsDir = join(homedir(), '.claude', 'projects')
  const [meta, projects] = await Promise.all([
    readMeta(),
    readdir(projectsDir).catch(() => [] as string[]),
  ])

  const sessions: Session[] = []

  await Promise.all(
    projects.map(async (project) => {
      const projectPath = join(projectsDir, project)
      const pStat = await stat(projectPath).catch(() => null)
      if (!pStat?.isDirectory()) return

      const files = await readdir(projectPath).catch(() => [] as string[])

      await Promise.all(
        files
          .filter((f) => f.endsWith('.jsonl'))
          .map(async (file) => {
            const sessionId = basename(file, '.jsonl')
            const filePath = join(projectPath, file)
            const fStat = await stat(filePath).catch(() => null)
            if (!fStat) return

            // Skip soft-deleted sessions
            if (meta.sessions[sessionId]?.deletedAt) return

            let firstMessage = ''
            let lastMessage = ''
            let messageCount = 0
            let cwd = ''
            let gitBranch = ''

            try {
              const lines = (await readFile(filePath, 'utf-8'))
                .split('\n')
                .filter((l) => l.trim())

              for (const line of lines) {
                try {
                  const obj = JSON.parse(line)
                  if (obj.cwd && !cwd) cwd = obj.cwd
                  if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch
                  if (obj.type === 'user' || obj.type === 'assistant') messageCount++
                  if (obj.type === 'user' && !obj.isSidechain) {
                    const text = extractText(obj.message?.content).slice(0, 300)
                    if (text) {
                      if (!firstMessage) firstMessage = text
                      lastMessage = text
                    }
                  }
                  if (obj.type === 'assistant' && !obj.isSidechain) {
                    const text = extractText(obj.message?.content).slice(0, 200)
                    if (text) lastMessage = text
                  }
                } catch {}
              }
            } catch {
              return
            }

            // Exclude only truly empty sessions (no cwd = no real content)
            if (!firstMessage && !cwd) return

            const m = meta.sessions[sessionId] ?? {}
            sessions.push({
              id: sessionId,
              project,
              cwd,
              firstMessage,
              lastMessage,
              lastModified: fStat.mtimeMs,
              messageCount,
              gitBranch,
              title: m.title,
              description: m.description,
              tags: m.tags,
              pinned: m.pinned,
              archived: m.archived,
            })
          })
      )
    })
  )

  return sessions.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.lastModified - a.lastModified
  })
}

// ─── Terminal launcher ────────────────────────────────────────────────────────

async function getFirstCwd(filePath: string): Promise<string> {
  try {
    for (const line of (await readFile(filePath, 'utf-8')).split('\n').slice(0, 20)) {
      try { const o = JSON.parse(line); if (o.cwd) return o.cwd } catch {}
    }
  } catch {}
  return ''
}


function runInTerminal(cmd: string, title?: string) {
  const nameStmt = title ? `\n      set name to ${JSON.stringify(title)}` : ''
  const iterm = `tell application "iTerm2"
    set w to (create window with default profile)
    tell current session of w${nameStmt}
      write text ${JSON.stringify(cmd)}
    end tell
    activate
  end tell`
  const titlePrefix = title ? `printf '\\033]0;${title.replace(/'/g, "'\\''")}\\007' && ` : ''
  const termApp = `tell application "Terminal"
    do script ${JSON.stringify(titlePrefix + cmd)}
    activate
  end tell`
  try {
    execSync(`osascript -e 'id of application "iTerm2"'`, { stdio: 'ignore' })
    exec(`osascript << 'APPLESCRIPT'\n${iterm}\nAPPLESCRIPT`)
  } catch {
    exec(`osascript << 'APPLESCRIPT'\n${termApp}\nAPPLESCRIPT`)
  }
}

function openInTerminal(sessionId: string | null, cwd: string, title?: string) {
  const resumePart = sessionId ? `claude --resume ${sessionId}` : 'claude'
  const cmd = (cwd ? `cd ${JSON.stringify(cwd)} && ` : '') + resumePart
  runInTerminal(cmd, title || undefined)
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

function json(res: Parameters<typeof createServer>[0] extends (req: any, res: infer R) => any ? R : never, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

async function readBody(req: Parameters<typeof createServer>[0] extends (req: infer R, res: any) => any ? R : never): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c))
    req.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve({}) } })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`)
  const parts = url.pathname.split('/').filter(Boolean) // ['api', 'meta', ':id']

  try {
    // GET /api/sessions
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const sessions = await readSessions()
      for (const s of sessions) {
        if (activePtys.has(s.id)) (s as any).activePty = true
      }
      return json(res, 200, sessions)
    }

    // PUT /api/meta/:id  — update title, description, tags
    if (parts[0] === 'api' && parts[1] === 'meta' && parts[2] && req.method === 'PUT') {
      const id = parts[2]
      const body = await readBody(req) as Record<string, unknown>
      const patch: Partial<SessionMeta> = {}
      if ('title' in body) patch.title = (body.title as string) || undefined
      if ('description' in body) patch.description = (body.description as string) || undefined
      if ('tags' in body) patch.tags = Array.isArray(body.tags) ? body.tags as string[] : undefined
      await updateSessionMeta(id, patch)
      return json(res, 200, { ok: true })
    }

    // POST /api/pin/:id
    if (parts[0] === 'api' && parts[1] === 'pin' && parts[2] && req.method === 'POST') {
      const id = parts[2]
      const store = await readMeta()
      const pinned = !store.sessions[id]?.pinned
      await updateSessionMeta(id, { pinned })
      return json(res, 200, { pinned })
    }

    // POST /api/archive/:id
    if (parts[0] === 'api' && parts[1] === 'archive' && parts[2] && req.method === 'POST') {
      const id = parts[2]
      const store = await readMeta()
      const archived = !store.sessions[id]?.archived
      await updateSessionMeta(id, { archived })
      return json(res, 200, { archived })
    }

    // DELETE /api/session/:id  — soft delete
    if (parts[0] === 'api' && parts[1] === 'session' && parts[2] && req.method === 'DELETE') {
      const id = parts[2]
      await updateSessionMeta(id, { deletedAt: new Date().toISOString() })
      return json(res, 200, { ok: true })
    }

    // POST /api/resume
    if (url.pathname === '/api/resume' && req.method === 'POST') {
      const body = await readBody(req) as Record<string, unknown>
      const id = body.id as string
      if (!id) return json(res, 400, { error: 'Missing session id' })
      openInTerminal(id, (body.cwd as string) || '', (body.title as string) || undefined)
      return json(res, 200, { ok: true })
    }


    // POST /api/playground — returns startedAt + cwd so client can open embedded terminal
    if (url.pathname === '/api/playground' && req.method === 'POST') {
      const startedAt = Date.now()
      const cwd = process.cwd()
      return json(res, 200, { ok: true, startedAt, cwd })
    }

    // POST /api/new  — start a fresh claude session in presales-os-cli
    if (url.pathname === '/api/new' && req.method === 'POST') {
      openInTerminal(null, process.cwd())
      return json(res, 200, { ok: true })
    }

    // GET /
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end(HTML)
    }

    res.writeHead(404)
    res.end('Not found')
  } catch (e) {
    json(res, 500, { error: String(e) })
  }
})

// ─── UI ───────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Code Sessions</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤖</text></svg>">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5/css/xterm.css">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; font-size: 14px; }

  /* ── Layout ── */
  header { padding: 14px 24px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; background: #0d1117; z-index: 20; }
  header h1 { font-size: 15px; font-weight: 600; color: #f0f6fc; letter-spacing: -.01em; }
  #last-refresh { font-size: 12px; color: #484f58; }
  .header-right { margin-left: auto; display: flex; gap: 8px; }

  .toolbar { padding: 10px 24px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #21262d; background: #0d1117; position: sticky; top: 49px; z-index: 10; }
  .search-wrap { position: relative; flex: 1; max-width: 480px; }
  .search-wrap input { width: 100%; padding: 7px 12px 7px 34px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-size: 13px; outline: none; }
  .search-wrap input:focus { border-color: #58a6ff; box-shadow: 0 0 0 3px #1f6feb22; }
  .search-wrap input::placeholder { color: #484f58; }
  .search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #484f58; font-size: 14px; pointer-events: none; }
  .pills { display: flex; gap: 4px; }
  .pill { padding: 5px 13px; border-radius: 20px; border: 1px solid #30363d; background: transparent; color: #8b949e; font-size: 12px; cursor: pointer; }
  .pill:hover { border-color: #8b949e; color: #c9d1d9; }
  .pill.active { background: #1f6feb1a; border-color: #388bfd; color: #58a6ff; }
  .pill.arch.active { background: #8957e51a; border-color: #8957e5; color: #d2a8ff; }
  #count { font-size: 12px; color: #484f58; margin-left: auto; }

  /* ── Grid ── */
  #list { padding: 12px 24px 32px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: start; }

  .grp { grid-column: 1 / -1; padding: 6px 0 4px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #21262d; margin-top: 8px; }
  .grp:first-child { margin-top: 0; }
  .grp-label { font-size: 11px; font-weight: 600; color: #484f58; text-transform: uppercase; letter-spacing: .07em; white-space: nowrap; }
  .grp-path { font-size: 11px; color: #30363d; font-family: 'SF Mono', 'Fira Code', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── Card ── */
  .row { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 11px 12px; display: flex; flex-direction: column; gap: 5px; cursor: default; transition: border-color .15s; position: relative; }
  .row:hover { border-color: #30363d; }
  .row.pinned { border-left: 2px solid #388bfd; }
  .row.archived { opacity: .55; }
  .row-gutter { display: none; }

  .card-head { display: flex; align-items: flex-start; gap: 4px; }
  .row-body { flex: 1; min-width: 0; }
  .row-title { font-size: 13px; font-weight: 500; color: #e6edf3; line-height: 1.4; cursor: text; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
  .row-title:empty::before { content: attr(data-placeholder); color: #484f58; font-weight: 400; font-style: italic; }
  .row-title[contenteditable="true"] { outline: none; -webkit-line-clamp: unset; overflow: visible; border-bottom: 1px solid #388bfd; }

  .row-icons { display: flex; gap: 0; opacity: 0; transition: opacity .15s; flex-shrink: 0; }
  .row:hover .row-icons { opacity: 1; }
  .icon-btn { background: transparent; border: none; color: #484f58; cursor: pointer; padding: 3px 5px; border-radius: 4px; font-size: 15px; line-height: 1; }
  .icon-btn:hover { background: #21262d; color: #c9d1d9; }
  .icon-btn.on { color: #388bfd; }
  .icon-btn.del:hover { background: #da363322; color: #f85149; }

  .row-meta { font-size: 11px; color: #6e7681; font-family: 'SF Mono', 'Fira Code', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row-meta .branch { color: #3fb950; }

  .row-desc { font-size: 12px; color: #8b949e; font-style: italic; cursor: text; line-height: 1.4; }
  .row-desc:empty { display: none; }
  .row-desc[contenteditable="true"] { display: block; outline: none; border-bottom: 1px dashed #388bfd88; }

  .row-preview { display: none; }

  .row-tags { display: flex; flex-wrap: wrap; gap: 3px; }
  .tag { font-size: 10px; padding: 1px 7px; border-radius: 8px; background: #21262d; color: #8b949e; cursor: pointer; border: none; }
  .tag:hover { background: #30363d; color: #c9d1d9; }
  .tag-add { background: transparent; border: 1px dashed #30363d !important; color: #484f58; }
  .tag-add:hover { border-color: #8b949e !important; color: #8b949e; }

  .card-foot { display: flex; gap: 6px; margin-top: 4px; justify-content: flex-end; }
  .row-actions { display: none; }

  .resume-btn { padding: 5px 14px; border-radius: 5px; background: #238636; border: 1px solid #2ea043; color: #fff; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; }
  .resume-btn:hover { background: #2ea043; }
  .resume-btn:active { background: #1a7f2e; }
  .resume-btn.loading { opacity: .6; cursor: wait; }
  .copy-btn { padding: 5px 10px; border-radius: 5px; background: transparent; border: 1px solid #30363d; color: #8b949e; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .copy-btn:hover { border-color: #8b949e; color: #e6edf3; }

  /* ── Misc ── */
  .empty { padding: 64px 24px; text-align: center; color: #484f58; font-size: 14px; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: #238636; color: #fff; padding: 9px 16px; border-radius: 8px; font-size: 13px; opacity: 0; transform: translateY(6px); transition: opacity .2s, transform .2s; pointer-events: none; z-index: 99; }
  .toast.show { opacity: 1; transform: translateY(0); }
  .btn { padding: 5px 12px; border-radius: 6px; border: 1px solid #30363d; background: transparent; color: #8b949e; font-size: 12px; cursor: pointer; }
  .btn:hover { border-color: #8b949e; color: #e6edf3; }
  .new-btn { padding: 6px 14px; border-radius: 6px; background: #1f6feb; border: 1px solid #388bfd; color: #fff; font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; }
  .new-btn:hover { background: #388bfd; }
  .playground-btn { padding: 6px 14px; border-radius: 6px; background: transparent; border: 1px solid #6e40c9; color: #d2a8ff; font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; }
  .playground-btn:hover { background: #6e40c911; border-color: #8957e5; }

  /* ── Terminal overlay ── */
  .term-overlay { position: fixed; inset: 0; background: #0d1117; z-index: 200; display: none; flex-direction: column; }
  .term-overlay.open { display: flex; }
  .term-topbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; flex-shrink: 0; }
  .term-close { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 6px; background: transparent; border: 1px solid #30363d; color: #8b949e; font-size: 12px; cursor: pointer; }
  .term-close:hover { border-color: #8b949e; color: #e6edf3; }
  .live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #3fb950; margin-right: 5px; box-shadow: 0 0 4px #3fb95088; flex-shrink: 0; }
  .term-topbar-title { font-size: 13px; color: #8b949e; flex: 1; text-align: center; font-family: 'SF Mono', 'Fira Code', monospace; }
  .term-body { flex: 1; overflow: hidden; padding: 8px 8px 8px 8px; }
  .term-body .xterm { height: 100%; }

</style>
</head>
<body>
<header>
  <h1>Claude Code Sessions</h1>
  <span id="last-refresh">Loading...</span>
  <div class="header-right">
    <button class="btn" onclick="refreshSessions()">Refresh</button>
  </div>
</header>
<div class="toolbar">
  <div class="search-wrap">
    <span class="search-icon">⌕</span>
    <input type="text" id="search" placeholder="Search sessions, tags, paths..." oninput="render()" autofocus>
  </div>
  <div class="pills">
    <button class="pill active" data-filter="active" onclick="setFilter('active',this)">Active</button>
    <button class="pill" data-filter="all" onclick="setFilter('all',this)">All</button>
    <button class="pill" data-filter="today" onclick="setFilter('today',this)">Today</button>
    <button class="pill" data-filter="week" onclick="setFilter('week',this)">This week</button>
    <button class="pill arch" data-filter="archived" onclick="setFilter('archived',this)">Archived</button>
  </div>
  <span id="count"></span>
  <button class="playground-btn" onclick="openPlayground()">⚡ Playground</button>
  <button class="new-btn" onclick="newSession()">+ New</button>
</div>
<div id="list"></div>
<div class="toast" id="toast"></div>

<div class="term-overlay" id="term-overlay">
  <div class="term-topbar">
    <button class="term-close" onclick="closeTerminal()">✕ Close</button>
    <span class="term-topbar-title" id="term-title"></span>
  </div>
  <div class="term-body" id="term-body"></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/xterm@5/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8/lib/xterm-addon-fit.js"></script>
<script>
let allSessions = []
let activeFilter = 'active'

function esc(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
function shortPath(p) {
  if (!p) return ''
  const parts = p.split('/')
  if (parts[1] === 'Users' && parts.length > 3) return '~/' + parts.slice(3).join('/')
  if (parts[1] === 'Users') return '~'
  return p
}
function timeAgo(ms) {
  const d = Date.now() - ms, m = Math.floor(d/60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m/60)
  if (h < 24) return h + 'h ago'
  return Math.floor(h/24) + 'd ago'
}
function showToast(msg, color) {
  const t = document.getElementById('toast')
  t.textContent = msg; t.style.background = color || '#238636'
  t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500)
}
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}

// ── filters ────────────────────────────────────────────────────────────────
function setFilter(f, btn) {
  activeFilter = f
  document.querySelectorAll('.pill').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  render()
}
function filtered() {
  const q = document.getElementById('search').value.toLowerCase()
  const now = Date.now(), DAY = 86400000
  return allSessions.filter(s => {
    if (activeFilter === 'archived') return !!s.archived
    if (s.archived) return false
    if (activeFilter === 'today' && now - s.lastModified > DAY) return false
    if (activeFilter === 'week' && now - s.lastModified > 7 * DAY) return false
    if (activeFilter === 'active' && now - s.lastModified > 7 * DAY) return false
    if (q) {
      const hay = [s.title, s.firstMessage, s.lastMessage, s.cwd, s.gitBranch, ...(s.tags||[])].join(' ').toLowerCase()
      return hay.includes(q)
    }
    return true
  }).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.lastModified - a.lastModified
  })
}

// ── render ─────────────────────────────────────────────────────────────────
function render() {
  const container = document.getElementById('list')
  const list = filtered()
  document.getElementById('count').textContent = list.length + ' session' + (list.length !== 1 ? 's' : '')

  if (list.length === 0) {
    container.innerHTML = '<div class="empty">No sessions found</div>'
    return
  }

  let html = ''
  const hasPinned = list.some(s => s.pinned)

  if (hasPinned) {
    html += '<div class="grp"><span class="grp-label">Pinned</span></div>'
    for (const s of list.filter(s => s.pinned)) html += rowHtml(s)
    if (list.some(s => !s.pinned)) html += '<div class="grp"><span class="grp-label">Recent</span></div>'
  }

  for (const s of list.filter(s => !s.pinned)) html += rowHtml(s)

  container.innerHTML = html
}

function rowHtml(s) {
  const liveDot = s.activePty ? '<span class="live-dot" title="Session is running"></span>' : ''
  const meta = [shortPath(s.cwd || s.project), s.gitBranch ? '<span class="branch">' + esc(s.gitBranch) + '</span>' : '', timeAgo(s.lastModified), s.messageCount + ' msgs'].filter(Boolean).join(' &middot; ')
  const tags = (s.tags||[]).map(t => '<button class="tag" data-tag="' + esc(t) + '">' + esc(t) + ' ×</button>').join('')

  let r = '<div class="row' + (s.pinned ? ' pinned' : '') + (s.archived ? ' archived' : '') + '" data-id="' + esc(s.id) + '">'
  r += '<div class="card-head">'
  r += '  <div class="row-body"><div class="row-title" data-field="title" contenteditable="false" data-placeholder="Untitled...">' + liveDot + esc(s.title || '') + '</div></div>'
  r += '  <div class="row-icons">'
  r += '    <button class="icon-btn ' + (s.pinned ? 'on' : '') + '" data-action="pin" title="' + (s.pinned ? 'Unpin' : 'Pin') + '">⊙</button>'
  r += '    <button class="icon-btn" data-action="archive" title="' + (s.archived ? 'Unarchive' : 'Archive') + '">⊟</button>'
  r += '    <button class="icon-btn del" data-action="delete" title="Remove">⊗</button>'
  r += '  </div>'
  r += '</div>'
  r += '<div class="row-meta">' + meta + '</div>'
  if (s.description) r += '<div class="row-desc" data-field="description" contenteditable="false">' + esc(s.description) + '</div>'
  if (s.tags && s.tags.length) r += '<div class="row-tags">' + tags + '<button class="tag tag-add" data-action="add-tag">+ tag</button></div>'
  else r += '<div class="row-tags"><button class="tag tag-add" data-action="add-tag">+ tag</button></div>'
  r += '<div class="card-foot">'
  r += '  <button class="copy-btn" data-action="copy" title="Copy claude --resume command">Copy</button>'
  r += '  <button class="resume-btn" data-action="resume">Resume</button>'
  r += '</div>'
  r += '</div>'
  return r
}

// ── actions ────────────────────────────────────────────────────────────────
function sessionById(id) { return allSessions.find(s => s.id === id) }
function patchLocal(id, patch) { const s = sessionById(id); if (s) Object.assign(s, patch) }


let _term = null, _termWs = null, _termFit = null, _termResize = null

function openTerminal(id, cwd, title, extra = {}) {
  // Clean up any previous terminal
  closeTerminal()

  document.getElementById('term-title').textContent = title || (id ? id.slice(0, 8) : 'New session')
  document.getElementById('term-overlay').classList.add('open')

  const term = new Terminal({
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff', selectionBackground: '#388bfd44' },
    fontFamily: "'SF Mono', 'Fira Code', 'Menlo', 'Courier New', monospace",
    fontSize: 14,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
  })
  const fitAddon = new FitAddon.FitAddon()
  term.loadAddon(fitAddon)

  const body = document.getElementById('term-body')
  term.open(body)
  fitAddon.fit()

  const params = new URLSearchParams({ cwd: cwd || '', ...extra })
  if (id) params.set('id', id)
  const ws = new WebSocket('ws://localhost:${PORT}/terminal?' + params.toString())

  ws.onopen = () => {
    fitAddon.fit()
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
  }
  ws.onmessage = e => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data))
  ws.onclose = () => { /* server sends exit message before closing */ }
  ws.onerror = () => term.write('\\r\\n\\x1b[31m[connection error — is node-pty installed?]\\x1b[0m\\r\\n')

  term.onData(data => { if (ws.readyState === WebSocket.OPEN) ws.send(data) })

  const observer = new ResizeObserver(() => {
    fitAddon.fit()
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
  })
  observer.observe(body)

  _term = term; _termWs = ws; _termFit = fitAddon; _termResize = observer

  document.addEventListener('keydown', _escHandler)
  term.focus()
}

function _escHandler(e) {
  if (e.key === 'Escape' && e.target.tagName !== 'INPUT') { closeTerminal() }
}

function closeTerminal() {
  document.removeEventListener('keydown', _escHandler)
  if (_termResize) { _termResize.disconnect(); _termResize = null }
  // Close WS (server detaches, PTY keeps running) then dispose local terminal
  if (_termWs) { try { _termWs.close() } catch {} _termWs = null }
  if (_term) { _term.dispose(); _term = null }
  _termFit = null
  document.getElementById('term-overlay').classList.remove('open')
  // Refresh now (clears live dot) and again shortly after (picks up playground tag)
  refreshSessions()
  setTimeout(refreshSessions, 1500)
}

async function doResume(id, btn) {
  const s = sessionById(id); if (!s) return
  if (typeof Terminal === 'undefined') {
    // xterm.js not loaded — fall back to system terminal
    btn.classList.add('loading'); btn.textContent = 'Opening...'
    try { await api('POST', '/api/resume', { id: s.id, cwd: s.cwd, title: s.title || '' }); showToast('Opened in terminal') }
    catch { showToast('Failed', '#da3633') }
    finally { btn.classList.remove('loading'); btn.textContent = 'Resume' }
    return
  }
  openTerminal(s.id, s.cwd, s.title || s.firstMessage || '')
}
async function doPin(id) {
  await api('POST', '/api/pin/' + id)
  await refreshSessions()
}
async function doArchive(id) {
  const { archived } = await api('POST', '/api/archive/' + id)
  patchLocal(id, { archived }); render(); showToast(archived ? 'Archived' : 'Unarchived')
}
async function doDelete(id) {
  if (!confirm('Remove from list? (File stays on disk.)')) return
  await api('DELETE', '/api/session/' + id)
  allSessions = allSessions.filter(s => s.id !== id); render(); showToast('Removed')
}
function doCopy(id) {
  const s = sessionById(id); if (!s) return
  const cmd = (s.cwd ? 'cd ' + s.cwd + ' && ' : '') + 'claude --resume ' + s.id
  navigator.clipboard.writeText(cmd).then(() => showToast('Copied'))
}
async function saveField(id, field, value) {
  await api('PUT', '/api/meta/' + id, { [field]: value })
  patchLocal(id, { [field]: value || undefined })
}
async function doAddTag(id) {
  const val = prompt('Tag:'); if (!val) return
  const s = sessionById(id); if (!s) return
  const tags = [...new Set([...(s.tags||[]), val.trim()])]
  await api('PUT', '/api/meta/' + id, { tags }); patchLocal(id, { tags }); render()
}
async function doRemoveTag(id, tag) {
  const s = sessionById(id); if (!s) return
  const tags = (s.tags||[]).filter(t => t !== tag)
  await api('PUT', '/api/meta/' + id, { tags }); patchLocal(id, { tags }); render()
}

// ── contenteditable ────────────────────────────────────────────────────────
function makeEditable(el, id, field) {
  el.contentEditable = 'true'; el.focus()
  const range = document.createRange(); range.selectNodeContents(el); range.collapse(false)
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
  function finish() { el.contentEditable = 'false'; saveField(id, field, el.textContent.trim()) }
  el.addEventListener('blur', finish, { once: true })
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur() }
    if (e.key === 'Escape') { el.contentEditable = 'false'; el.removeEventListener('blur', finish) }
  }, { once: true })
}

// ── event delegation ───────────────────────────────────────────────────────
document.getElementById('list').addEventListener('click', async e => {
  const row = e.target.closest('[data-id]'); if (!row) return
  const id = row.dataset.id
  const btn = e.target.closest('[data-action]')
  if (btn) {
    e.preventDefault()
    const a = btn.dataset.action
    if (a === 'resume') return doResume(id, btn)
    if (a === 'copy') return doCopy(id)
    if (a === 'pin') return doPin(id)
    if (a === 'archive') return doArchive(id)
    if (a === 'delete') return doDelete(id)
    if (a === 'add-tag') return doAddTag(id)
    return
  }
  const tagEl = e.target.closest('.tag[data-tag]')
  if (tagEl) return doRemoveTag(id, tagEl.dataset.tag)
  const field = e.target.closest('[data-field]')
  if (field && field.contentEditable !== 'true') makeEditable(field, id, field.dataset.field)
})

// ── playground ────────────────────────────────────────────────────────────
async function openPlayground() {
  const { startedAt, cwd } = await api('POST', '/api/playground', {})
  openTerminal(null, cwd, '⚡ Playground', { playground: 'true', after: String(startedAt) })
}

// ── new session ────────────────────────────────────────────────────────────
async function newSession() {
  await api('POST', '/api/new', {})
  showToast('Opened new session')
}

// ── load ───────────────────────────────────────────────────────────────────
async function refreshSessions() {
  document.getElementById('last-refresh').textContent = 'Loading...'
  try {
    allSessions = await (await fetch('/api/sessions')).json()
    document.getElementById('last-refresh').textContent = 'Updated ' + timeAgo(Date.now())
    render()
  } catch { document.getElementById('last-refresh').textContent = 'Error' }
}

refreshSessions()
setInterval(refreshSessions, 30000)
</script>
</body>
</html>`

// ─── WebSocket terminal server ────────────────────────────────────────────────

// Resolve claude binary once at startup (node-pty inherits a limited PATH)
let claudeBin = 'claude'
try { claudeBin = execSync('which claude', { encoding: 'utf8' }).trim() } catch {}

// ── Active PTY registry ────────────────────────────────────────────────────
interface ActivePty {
  pty: any
  cwd: string
  ws: import('ws').WebSocket | null
  buffer: string  // rolling output buffer for reconnect replay (~100 KB)
}
const activePtys = new Map<string, ActivePty>()

if (nodePty) {
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url!, `http://localhost:${PORT}`)
    if (url.pathname !== '/terminal') { ws.close(); return }

    const isPlayground = url.searchParams.get('playground') === 'true'
    const playgroundAfter = parseInt(url.searchParams.get('after') || '0', 10)
    const sessionId = url.searchParams.get('id') || `anon-${Date.now()}`
    const cwd = url.searchParams.get('cwd') || process.cwd()

    // ── Reconnect to existing PTY ──────────────────────────────────────────
    const existing = activePtys.get(sessionId)
    if (existing) {
      existing.ws = ws
      // Replay buffered output so the terminal catches up
      if (existing.buffer) ws.send(existing.buffer)
      ws.on('message', (msg: Buffer) => {
        const str = msg.toString()
        try {
          const obj = JSON.parse(str)
          if (obj.type === 'resize') { existing.pty.resize(Math.max(2, obj.cols), Math.max(2, obj.rows)); return }
        } catch {}
        existing.pty.write(str)
      })
      ws.on('close', () => { existing.ws = null }) // detach only
      return
    }

    // ── Spawn new PTY ──────────────────────────────────────────────────────
    const args = sessionId.startsWith('anon-') ? [] : ['--resume', sessionId]
    const shell = process.env.SHELL || '/bin/zsh'
    const cmdStr = [claudeBin, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')

    let pty: any
    try {
      pty = nodePty!.spawn(shell, ['-c', cmdStr], {
        name: 'xterm-256color',
        cols: 220,
        rows: 50,
        cwd,
        env: { ...process.env } as Record<string, string>,
      })
    } catch (e) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`\r\n\x1b[31mFailed to spawn: ${e}\x1b[0m\r\n`)
        ws.close()
      }
      return
    }

    const active: ActivePty = { pty, cwd, ws, buffer: '' }
    activePtys.set(sessionId, active)

    pty.onData((data: string) => {
      active.buffer = (active.buffer + data).slice(-102400) // keep ~100 KB
      if (active.ws?.readyState === WebSocket.OPEN) active.ws.send(data)
    })

    ws.on('message', (msg: Buffer) => {
      const str = msg.toString()
      try {
        const obj = JSON.parse(str)
        if (obj.type === 'resize') { pty.resize(Math.max(2, obj.cols), Math.max(2, obj.rows)); return }
      } catch {}
      pty.write(str)
    })

    ws.on('close', () => {
      active.ws = null
      // For playground: tag+archive as soon as the user closes the panel
      if (isPlayground && playgroundAfter) {
        tagPlaygroundSessions(playgroundAfter, cwd).catch(() => {})
      }
    })

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      const msg = `\r\n\x1b[90m[session ended: exit ${exitCode}]\x1b[0m\r\n`
      active.buffer += msg
      if (active.ws?.readyState === WebSocket.OPEN) {
        active.ws.send(msg)
        active.ws.close()
      }
      activePtys.delete(sessionId)
      // Also tag on natural exit in case panel was never closed
      if (isPlayground && playgroundAfter) {
        tagPlaygroundSessions(playgroundAfter, cwd).catch(() => {})
      }
    })
  })
} else {
  console.warn('node-pty not available — embedded terminal disabled, Resume will open in system terminal')
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude Code Session Manager → http://localhost:${PORT}`)
  exec(`open http://localhost:${PORT}`)
})

process.on('SIGINT', () => { console.log('\nDone.'); process.exit(0) })
