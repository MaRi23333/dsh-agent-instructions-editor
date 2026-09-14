/**
 * dsh-agent-instructions-editor — host half.
 *
 * Serves the browser settings page through the plugin's OWN routes under
 * `/agent-instructions/api/*` (the standard api.settings.* wire face cannot
 * serve a third-party namespace in this harness build — the gateway only
 * exposes its own allowlist — so the editor talks to the host directly,
 * exactly like dsh-subagent-library and dsh-plugin-fish-tts do).
 *
 * Endpoints:
 *   GET  /agent-instructions/api/projects          — registry + global file facts
 *   POST /agent-instructions/api/projects          — add/remove a manual project
 *   GET  /agent-instructions/api/chain?dir=…       — loader-exact chain view
 *   GET  /agent-instructions/api/file?scope=…      — read one instruction file
 *   POST /agent-instructions/api/file              — atomic write with mtime fencing
 *
 * Write safety: candidate names come from a fixed whitelist, directories must
 * realpath into a registered project's root→workspace chain, and writes land
 * through temp-file + rename so the loader never observes a half-written file.
 *
 * @module dsh-agent-instructions-editor
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promises as fs, realpathSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-query'
import {
  ancestorChain,
  buildChain,
  countedGlobalBytes,
  DEFAULT_MAX_BYTES,
  dirKey,
  dshHomeDisplay,
  EDITABLE_NAMES,
  enqueueWrite,
  findProjectRoot,
  globalOverLimit,
  MAX_SOURCE_BYTES,
  mergeSessionWorkspaces,
  resolveDshHome,
  statFile,
  USER_GLOBAL_FILE,
  userGlobalDisplayPath,
  userGlobalPath,
} from './chain.ts'

export const name = 'agent-instructions-editor'
export const inject: string[] = []

export interface Config {
  /** Manual project registry, keyed by id (`[a-z0-9][a-z0-9-]*`). */
  manualProjects?: Record<string, string>
}

export const Config: z<Config> = z.object({
  manualProjects: z.dict(z.string()).default({}),
})

const NS = 'agent-instructions-editor'
const API_BASE = '/agent-instructions/api'
const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/
/** JSON body cap — 4 MiB: a ≤1 MiB instruction file with newline-heavy JSON escaping stays well inside it. */
const MAX_BODY_BYTES = 4 << 20

// ── HTTP helpers (same posture as dsh-subagent-library) ────────────────────

const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

type BodyRead =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: 'too-large' | 'bad-json' }

const readJsonBody = async (req: IncomingMessage): Promise<BodyRead> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return { ok: false, error: 'too-large' }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return { ok: true, body: {} }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? { ok: true, body: parsed as Record<string, unknown> }
      : { ok: false, error: 'bad-json' }
  } catch {
    return { ok: false, error: 'bad-json' }
  }
}

/**
 * Host-header allowlist — the anti-DNS-rebinding defense for these routes.
 * A rebound attacker domain resolves to 127.0.0.1 but keeps its own name in
 * the Host header; only loopback literals/localhost may pass, on any port.
 */
const HOSTNAME_LOOPBACK = /^(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})$/

const guardHost = (req: IncomingMessage, res: ServerResponse): boolean => {
  const hostHeader = req.headers.host
  if (hostHeader === undefined) {
    sendJson(res, 403, { ok: false, error: 'host-not-allowed' })
    return false
  }
  const host = hostHeader.trim().toLowerCase()
  const colon = host.lastIndexOf(':')
  const hostname = colon === -1 ? host : host.slice(0, colon)
  if (!HOSTNAME_LOOPBACK.test(hostname)) {
    sendJson(res, 403, { ok: false, error: 'host-not-allowed' })
    return false
  }
  return true
}

const guardWrite = (req: IncomingMessage, res: ServerResponse): boolean => {
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    sendJson(res, 415, { ok: false, error: 'content-type-json-required' })
    return false
  }
  const origin = req.headers.origin
  if (origin !== undefined) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = ''
    }
    const hostHeader = req.headers.host ?? ''
    // Strict same-origin only. The former loopback-prefix exemption let any
    // local web app's page (Origin 127.0.0.1:<other-port>) write instruction
    // files; non-browser local clients send no Origin and remain unaffected.
    if (originHost === '' || originHost !== hostHeader) {
      sendJson(res, 403, { ok: false, error: 'cross-origin-forbidden' })
      return false
    }
  }
  return true
}

// ── project registry ───────────────────────────────────────────────────────

interface ProjectEntry {
  id: string
  dir: string
  realpath: string | null
  label: string
  source: 'manual' | 'session'
}

/**
 * Session-sourced workspaces: the durable workspace registry (the GUI
 * sidebar's project list) plus the most recent distinct session cwds. Wired
 * in `apply` via `ctx.inject` so the plugin still loads if either service is
 * absent — manual projects always work without them.
 */
type SessionWorkspace = { dir: string; label?: string }

let sessionWorkspaceSource: () => Promise<SessionWorkspace[]> = async () => []

/** Directories never worth listing as projects. */
function isNoiseDir(dir: string): boolean {
  const resolved = path.resolve(dir)
  if (path.dirname(resolved) === resolved) return true // filesystem root
  const home = resolveDshHome()
  if (resolved === home || resolved === path.dirname(home)) return true
  return resolved === path.resolve(os.homedir()) || resolved === os.tmpdir()
}

async function recentSessionWorkspaces(): Promise<SessionWorkspace[]> {
  const registry = await sessionWorkspaceSource()
  return registry.filter((entry) => !isNoiseDir(entry.dir))
}

async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target)
  } catch {
    return null
  }
}

function labelFor(dir: string): string {
  const base = path.basename(dir)
  return base === '' ? dir : base
}

export function apply(ctx: Context, config: Config): void {
  let settingsService: SettingsProvider | undefined
  let settingsFailure: string | undefined

  // The manual registry lives in the settings document (hot reloaded, no
  // restart), like dsh-subagent-library's roster. `installSettingsSection`
  // is deliberately not used — in this harness build its registration is
  // dropped for bundle-loaded plugins.
  ctx.inject(['settings'], (sctx: Context) => {
    settingsService = sctx.settings
    settingsFailure = undefined // the latch must reset when a restarted fiber registers successfully
    try {
      const scope = sctx.settings.register(NS, Config, { base: config })
      sctx.effect(() => () => { /* nothing derived is memoized */ }, 'agent-instructions-editor: settings scope')
      scope.watch(() => { /* every operation re-reads the descriptor */ })
    } catch (error) {
      settingsFailure = `agent-instructions-editor 设置段注册失败：${String(error)}`
    }
  })

  // Auto-discovered projects, best effort: the durable workspace registry
  // first, then the most recent distinct session cwds that the registry
  // does not already cover. Each source wires at most once — ctx.inject
  // callbacks can re-fire when a service fiber restarts, and re-wrapping
  // would duplicate every entry.
  let registryWired = false
  let sessionQueryWired = false

  ctx.inject(['workspaceRegistry'], (wctx: Context) => {
    if (registryWired) return
    registryWired = true
    // Re-arm on fiber dispose so a restarted service is re-wired with a fresh
    // closure instead of hanging on the destroyed instance.
    wctx.effect(() => () => { registryWired = false }, 'agent-instructions-editor: registry source lifetime')
    const registrySource = sessionWorkspaceSource
    sessionWorkspaceSource = async () => {
      const fromRegistry = await registrySource()
      try {
        return [
          ...fromRegistry,
          ...wctx.workspaceRegistry.list().map((workspace) => ({ dir: workspace.path, label: workspace.title })),
        ]
      } catch {
        return fromRegistry
      }
    }
  })
  ctx.inject(['sessionQuery'], (qctx: Context) => {
    if (sessionQueryWired) return
    sessionQueryWired = true
    // Same re-arm contract as the registry wrap above.
    qctx.effect(() => () => { sessionQueryWired = false }, 'agent-instructions-editor: session-query source lifetime')
    const previousSource = sessionWorkspaceSource
    sessionWorkspaceSource = async () => {
      const fromPrevious = await previousSource()
      try {
        const records = await qctx.sessionQuery.listSessions()
        return mergeSessionWorkspaces(fromPrevious, records.map((record) => ({
          cwd: record.header.cwd,
          createdAt: record.header.createdAt,
        })), { isNoise: isNoiseDir })
      } catch {
        return fromPrevious
      }
    }
  })

  const manualProjects = (): Record<string, string> => {
    const svc = settingsService
    if (svc === undefined) return {}
    const descriptor = svc.describe().find((candidate) => candidate.ns === NS)
    if (descriptor === undefined) return {}
    const section = (descriptor.user ?? descriptor.value) as Record<string, unknown> | undefined
    const raw = section?.manualProjects
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: Record<string, string> = {}
    for (const [id, dir] of Object.entries(raw as Record<string, unknown>)) {
      if (PROJECT_ID.test(id) && typeof dir === 'string' && dir !== '') out[id] = dir
    }
    return out
  }

  const currentRevision = (): number | undefined => {
    const svc = settingsService
    if (svc === undefined) return undefined
    return svc.describe().find((candidate) => candidate.ns === NS)?.revision
  }

  const registeredProjects = async (): Promise<ProjectEntry[]> => {
    const entries: ProjectEntry[] = []
    for (const { dir, label } of await recentSessionWorkspaces()) {
      if (typeof dir !== 'string' || dir === '') continue
      entries.push({ id: `session:${dir}`, dir, realpath: null, label: label ?? labelFor(dir), source: 'session' })
    }
    for (const [id, dir] of Object.entries(manualProjects())) {
      entries.push({ id: `manual:${id}`, dir, realpath: null, label: labelFor(dir), source: 'manual' })
    }
    // Authoritative dedup by canonical path: realpath collapses drive-letter
    // case, 8.3 short names, separator drift, and any double-wrapped source.
    // Manual wins so its remove control survives; missing dirs pass through
    // keyed by their resolved raw path.
    const byKey = new Map<string, ProjectEntry>()
    for (const entry of entries) {
      const real = await safeRealpath(entry.dir)
      if (real === null) {
        const key = `missing:${dirKey(entry.dir)}`
        if (!byKey.has(key)) byKey.set(key, entry)
        continue
      }
      entry.realpath = real
      const key = dirKey(real)
      const existing = byKey.get(key)
      if (existing === undefined || (existing.source !== 'manual' && entry.source === 'manual')) byKey.set(key, entry)
    }
    return [...byKey.values()]
  }

  /** Global file facts + project registry with realpaths resolved lazily. */
  const projectsView = async () => {
    const globalPath = userGlobalPath()
    const globalStat = await statFile(globalPath)
    const entries: (ProjectEntry & { missing?: boolean })[] = []
    for (const entry of await registeredProjects()) {
      entries.push({ ...entry, ...(entry.realpath === null ? { missing: true } : {}) })
    }
    return {
      writable: settingsService?.writable ?? false,
      revision: currentRevision(),
      home: dshHomeDisplay(resolveDshHome()),
      budgetBytes: DEFAULT_MAX_BYTES,
      global: {
        absolutePath: globalPath,
        displayPath: userGlobalDisplayPath(),
        exists: globalStat !== 'absent' && globalStat !== 'unavailable',
        ...(typeof globalStat === 'object' ? { bytes: globalStat.size, mtimeMs: globalStat.mtimeMs } : {}),
      },
      projects: entries,
    }
  }

  /**
   * Every directory the editor may touch: for each registered workspace, the
   * loader's own root→workspace chain, realpathed. Returns the owning project
   * root too, because the loader renders display paths relative to it.
   */
  const editableChainDirs = async (): Promise<{ dirs: Set<string>; rootsByDir: Map<string, string> }> => {
    const dirs = new Set<string>()
    const rootsByDir = new Map<string, string>()
    for (const entry of await registeredProjects()) {
      const realWorkspace = entry.realpath ?? await safeRealpath(entry.dir)
      if (realWorkspace === null) continue
      const root = await findProjectRoot(realWorkspace)
      for (const dir of ancestorChain(root, realWorkspace)) {
        const real = await safeRealpath(dir)
        if (real === null) continue
        if (!rootsByDir.has(real)) rootsByDir.set(real, root)
        dirs.add(real)
      }
    }
    return { dirs, rootsByDir }
  }

  type Target = { absolutePath: string; displayPath: string }
  type TargetFailure = { error: string; message?: string }

  /** Whitelist + realpath containment — the whole write-path security model. */
  const resolveTarget = async (scope: unknown, dir: unknown, name: unknown): Promise<Target | TargetFailure> => {
    if (typeof name !== 'string' || !EDITABLE_NAMES.includes(name)) return { error: 'invalid-name' }
    if (name.includes('/') || name.includes('\\') || name.includes('..')) return { error: 'invalid-name' }
    if (scope === 'global') {
      // The global scope is exactly one file — a different `name` must not
      // silently retarget to ~/.dsh/AGENTS.md.
      if (dir !== undefined || name !== USER_GLOBAL_FILE) return { error: 'invalid-target' }
      return { absolutePath: userGlobalPath(), displayPath: userGlobalDisplayPath() }
    }
    if (scope !== 'project' || typeof dir !== 'string' || dir === '') return { error: 'invalid-target' }
    const real = await safeRealpath(dir)
    if (real === null) return { error: 'unknown-project' }
    const { dirs, rootsByDir } = await editableChainDirs()
    const root = dirs.has(real) ? rootsByDir.get(real) : undefined
    if (root === undefined) return { error: 'dir-not-editable' }
    return { absolutePath: path.join(real, name), displayPath: path.relative(root, path.join(real, name)) }
  }

  type FileReadResult = { status: number; payload: Record<string, unknown> }

  const readFile = async (target: Target): Promise<FileReadResult> => {
    const stat = await statFile(target.absolutePath)
    if (stat === 'unavailable') return { status: 503, payload: { ok: false, error: 'stat-failed' } }
    if (stat === 'absent') {
      return { status: 200, payload: { ok: true, exists: false, ...target, content: '', bytes: 0 } }
    }
    if (stat.size > MAX_SOURCE_BYTES) {
      return { status: 400, payload: { ok: false, error: 'file-too-large', message: `文件超过 ${MAX_SOURCE_BYTES} 字节上限（加载器也会跳过它），请在编辑器外处理。` } }
    }
    let content: string
    try {
      content = await fs.readFile(target.absolutePath, 'utf8')
    } catch {
      return { status: 503, payload: { ok: false, error: 'read-failed' } }
    }
    return { status: 200, payload: { ok: true, exists: true, ...target, content, bytes: stat.size, mtimeMs: stat.mtimeMs } }
  }

  const atomicWrite = async (targetPath: string, content: string): Promise<{ bytes: number; mtimeMs: number }> => {
    const dir = path.dirname(targetPath)
    await fs.mkdir(dir, { recursive: true })
    // Sweep stale temp files left by crashed runs (older than one minute).
    try {
      const now = Date.now()
      const prefix = `.${path.basename(targetPath)}.tmp-`
      for (const name of await fs.readdir(dir)) {
        if (!name.startsWith(prefix)) continue
        const stalePath = path.join(dir, name)
        const info = await fs.stat(stalePath).catch(() => null)
        if (info !== null && now - info.mtimeMs > 60_000) await fs.rm(stalePath, { force: true }).catch(() => {})
      }
    } catch {
      // best effort — a failed sweep must never block the write
    }
    const tmp = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
    try {
      await fs.writeFile(tmp, content, 'utf8')
      try {
        await fs.rename(tmp, targetPath)
      } catch (error) {
        // Windows: a watcher/AV holding the target briefly makes rename EPERM —
        // one retry after a beat before giving up.
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
        await new Promise((resolve) => setTimeout(resolve, 50))
        await fs.rename(tmp, targetPath)
      }
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw error
    }
    const stat = await statFile(targetPath)
    if (typeof stat !== 'object') throw new Error('写入后校验失败')
    return { bytes: stat.size, mtimeMs: stat.mtimeMs }
  }

  // ── /projects ──────────────────────────────────────────────────────────
  ctx.inject(['webServer'], (wctx: Context) => {
    const web = wctx.webServer

    wctx.effect(() => web.register({
      kind: 'exact',
      path: `${API_BASE}/projects`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guardHost(req, res)) return
        if (req.method === 'GET') {
          if (settingsFailure !== undefined) {
            sendJson(res, 503, { ok: false, error: 'not-ready', message: settingsFailure })
            return
          }
          sendJson(res, 200, { ok: true, ...(await projectsView()) })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        if (!guardWrite(req, res)) return
        const read = await readJsonBody(req)
        if (!read.ok) {
          if (read.error === 'too-large') sendJson(res, 413, { ok: false, error: 'body-too-large' })
          else sendJson(res, 400, { ok: false, error: 'bad-json' })
          return
        }
        const svc = settingsService
        if (settingsFailure !== undefined || svc === undefined) {
          sendJson(res, 503, { ok: false, error: 'not-ready', message: settingsFailure })
          return
        }
        if (!svc.writable) {
          sendJson(res, 403, { ok: false, error: 'readonly' })
          return
        }
        const body = read.body
        const op = body.op
        // CAS is mandatory at the API layer: dsh-settings only enforces the
        // revision fence when expectedRevision is provided, so an absent
        // value would silently bypass optimistic concurrency.
        if (typeof body.expectedRevision !== 'number') {
          sendJson(res, 400, { ok: false, error: 'revision-required' })
          return
        }
        const expectedRevision = body.expectedRevision
        let candidate: Record<string, string>
        try {
          const current = manualProjects()
          if (op === 'add') {
            const dir = typeof body.dir === 'string' ? body.dir.trim() : ''
            if (dir === '' || !path.isAbsolute(dir)) {
              sendJson(res, 400, { ok: false, error: 'invalid-dir', message: '请提供项目的绝对路径。' })
              return
            }
            const real = await safeRealpath(dir)
            if (real === null) {
              sendJson(res, 400, { ok: false, error: 'dir-missing', message: '目录不存在或无法访问。' })
              return
            }
            const stat = await fs.stat(real)
            if (!stat.isDirectory()) {
              sendJson(res, 400, { ok: false, error: 'not-a-directory' })
              return
            }
            if (Object.values(current).some((known) => safeRealpathSync(known) === real)) {
              sendJson(res, 200, { ok: true, ...(await projectsView()) })
              return
            }
            const base = labelFor(real).replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 24) || 'project'
            let id = `${base}-${randomBytes(2).toString('hex')}`
            while (Object.hasOwn(current, id)) id = `${base}-${randomBytes(2).toString('hex')}`
            candidate = { ...current, [id]: real }
          } else if (op === 'remove') {
            const id = typeof body.id === 'string' ? body.id : ''
            if (!PROJECT_ID.test(id) || !Object.hasOwn(current, id)) {
              sendJson(res, 400, { ok: false, error: 'unknown-project' })
              return
            }
            candidate = { ...current }
            delete candidate[id]
          } else {
            sendJson(res, 400, { ok: false, error: 'unknown-op' })
            return
          }
          const saveDescriptor = svc.describe().find((row) => row.ns === NS)
          const userSection = (saveDescriptor?.user ?? {}) as Record<string, unknown>
          // Wholesale replace (never update): the map must be able to lose keys.
          await svc.replace(NS, { ...userSection, manualProjects: candidate }, expectedRevision)
          sendJson(res, 200, { ok: true, ...(await projectsView()) })
        } catch (error) {
          console.error('[agent-instructions-editor] projects write failed:', error)
          if ((error as { code?: unknown }).code === 'SETTINGS_CONFLICT') {
            sendJson(res, 409, { ok: false, error: 'conflict' })
          } else {
            sendJson(res, 400, { ok: false, error: 'rejected' })
          }
        }
      },
    }), 'agent-instructions-editor: projects route')

    // ── /chain ───────────────────────────────────────────────────────────
    wctx.effect(() => web.register({
      kind: 'exact',
      path: `${API_BASE}/chain`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guardHost(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams
        const dir = query.get('dir') ?? ''
        const real = dir === '' ? null : await safeRealpath(dir)
        if (real === null) {
          sendJson(res, 400, { ok: false, error: 'unknown-project', message: '目录不存在或无法访问。' })
          return
        }
        const { dirs } = await editableChainDirs()
        if (!dirs.has(real)) {
          sendJson(res, 403, { ok: false, error: 'dir-not-editable' })
          return
        }
        const view = await buildChain(real)
        const globalPath = userGlobalPath()
        const globalStat = await statFile(globalPath)
        const globalExists = globalStat !== 'absent' && globalStat !== 'unavailable'
        const globalBytes = typeof globalStat === 'object' ? globalStat.size : 0
        const globalInfo = { exists: globalExists, bytes: globalBytes }
        sendJson(res, 200, {
          ok: true,
          ...view,
          global: { ...globalInfo, overLimit: globalOverLimit(globalInfo) },
          // AIE-BUDGET-003: single sum point — the loader skips sources over
          // 1 MiB, so they must not be counted here either. The client adds
          // nothing on top of this.
          totalBytes: view.totalBytes + countedGlobalBytes(globalInfo),
          budgetBytes: DEFAULT_MAX_BYTES,
        })
      },
    }), 'agent-instructions-editor: chain route')

    // ── /file ────────────────────────────────────────────────────────────
    wctx.effect(() => web.register({
      kind: 'exact',
      path: `${API_BASE}/file`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guardHost(req, res)) return
        if (req.method === 'GET') {
          const query = new URL(req.url ?? '/', 'http://localhost').searchParams
          const target = await resolveTarget(query.get('scope') ?? undefined, query.get('dir') ?? undefined, query.get('name'))
          if ('error' in target) {
            sendJson(res, target.error === 'invalid-name' || target.error === 'invalid-target' ? 400 : 403, { ok: false, error: target.error, message: target.message })
            return
          }
          const result = await readFile(target)
          sendJson(res, result.status, result.payload)
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        if (!guardWrite(req, res)) return
        const read = await readJsonBody(req)
        if (!read.ok) {
          if (read.error === 'too-large') sendJson(res, 413, { ok: false, error: 'body-too-large' })
          else sendJson(res, 400, { ok: false, error: 'bad-json' })
          return
        }
        const body = read.body
        const content = body.content
        if (typeof content !== 'string') {
          sendJson(res, 400, { ok: false, error: 'content-required' })
          return
        }
        if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) {
          sendJson(res, 413, { ok: false, error: 'file-too-large', message: `内容超过 ${MAX_SOURCE_BYTES} 字节上限。` })
          return
        }
        const target = await resolveTarget(body.scope, body.dir, body.name)
        if ('error' in target) {
          sendJson(res, target.error === 'invalid-name' || target.error === 'invalid-target' ? 400 : 403, { ok: false, error: target.error, message: target.message })
          return
        }
        // AIE-WRITE-006: the version fence and the write must be one
        // transaction per target. Writes to the same resolved file are
        // serialized through an in-process queue; the mtime fence is
        // re-checked INSIDE the queue, so a second same-version writer now
        // sees the first writer's fresh mtime and gets 409 instead of
        // silently clobbering it. Different targets still run concurrently.
        try {
          const written = await enqueueWrite(target.absolutePath, async () => {
            const stat = await statFile(target.absolutePath)
            if (stat === 'unavailable') return { status: 503 as const, payload: { ok: false, error: 'stat-failed' } }
            const expectedMtimeMs = body.expectedMtimeMs
            if (typeof stat === 'object') {
              // Existing file: a numeric matching mtime fences concurrent
              // edits; anything else (missing, stale, or a
              // create-over-appearance) is a conflict the client resolves by
              // re-reading.
              if (typeof expectedMtimeMs !== 'number' || Math.abs(stat.mtimeMs - expectedMtimeMs) > 1) {
                return { status: 409 as const, payload: { ok: false, error: 'conflict', exists: true, bytes: stat.size, mtimeMs: stat.mtimeMs } }
              }
            } else if (expectedMtimeMs !== null && expectedMtimeMs !== undefined) {
              return { status: 409 as const, payload: { ok: false, error: 'conflict', exists: false } }
            }
            const written = await atomicWrite(target.absolutePath, content)
            return { status: 200 as const, payload: { ok: true as const, ...target, ...written } }
          })
          sendJson(res, written.status, written.payload)
        } catch (error) {
          console.error('[agent-instructions-editor] file write failed:', error)
          sendJson(res, 500, { ok: false, error: 'write-failed' })
        }
      },
    }), 'agent-instructions-editor: file route')
  })
}

/** Best-effort synchronous realpath for duplicate detection; falls back to the raw path. */
function safeRealpathSync(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return target
  }
}
