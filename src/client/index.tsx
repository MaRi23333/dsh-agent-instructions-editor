/**
 * dsh-agent-instructions-editor — browser half.
 *
 * A Settings section ("个性化指令") that edits the harness workspace
 * instruction files through the plugin's own host routes
 * (`/agent-instructions/api/*`). The standard `api.settings.*` wire face
 * cannot serve a third-party namespace in this harness build (the gateway
 * only exposes its own allowlist), so the editor talks to the host directly,
 * exactly like dsh-subagent-library and dsh-plugin-fish-tts do.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { InstructionsSection, type InstructionsSectionInjected } from './InstructionsSection.tsx'
import { SECTION_ICON_INNER } from './icon.tsx'
import { en, zh } from './locales.ts'

const NS = 'agent-instructions-editor'
const API_BASE = '/agent-instructions/api'
/** The nav label this plugin registers — also the DOM hook for icon decoration. */
const NAV_LABELS = new Set(['个性化指令'])

// ── wire types ─────────────────────────────────────────────────────────────

export interface GlobalFileFacts {
  absolutePath: string
  displayPath: string
  exists: boolean
  bytes?: number
  mtimeMs?: number
}

export interface ProjectEntryView {
  id: string
  dir: string
  realpath: string | null
  label: string
  source: 'manual' | 'session'
  missing?: boolean
}

export interface ProjectsView {
  writable: boolean
  revision?: number
  home: string
  budgetBytes: number
  global: GlobalFileFacts
  projects: ProjectEntryView[]
}

export interface FileSlotView {
  name: string
  kind: 'base' | 'overlay'
  absolutePath: string
  displayPath: string
  exists: boolean
  bytes?: number
  mtimeMs?: number
  dedupWith?: string
  overLimit?: boolean
}

export interface ChainDirView {
  absolutePath: string
  displayPath: string
  isRoot: boolean
  slots: FileSlotView[]
}

export interface ChainView {
  root: string
  workspaceDir: string
  dirs: ChainDirView[]
  totalBytes: number
  budgetBytes: number
  global: { exists: boolean; bytes: number; overLimit?: boolean }
}

export interface FileView {
  exists: boolean
  displayPath: string
  absolutePath?: string
  content: string
  bytes: number
  mtimeMs?: number
}

export type ProjectsWrite =
  | { op: 'add'; dir: string }
  | { op: 'remove'; id: string }

export type ProjectsWriteResult =
  | { ok: true; view: ProjectsView }
  | { ok: false; conflict?: boolean; message?: string }

export type FileWriteResult =
  | { ok: true; bytes: number; mtimeMs: number }
  | { ok: false; conflict?: boolean; exists?: boolean; message?: string }

// ── error mapping ──────────────────────────────────────────────────────────

const ERROR_TEXT: Record<string, string> = {
  'not-ready': '插件服务尚未就绪，请稍后重试。',
  'readonly': '设置当前为只读，无法写入。',
  'content-type-json-required': '请求被拒绝：写入只接受 JSON。',
  'cross-origin-forbidden': '请求被拒绝：跨源写入。',
  'host-not-allowed': '请求被拒绝：目标主机不是本机回环地址。',
  'body-too-large': '请求体超过上限。',
  'bad-json': '请求体不是合法 JSON。',
  'invalid-name': '非法的文件名。',
  'invalid-target': '非法的目标。',
  'invalid-dir': '请提供项目的绝对路径。',
  'dir-missing': '目录不存在或无法访问。',
  'not-a-directory': '该路径不是目录。',
  'unknown-project': '未知项目。',
  'dir-not-editable': '该目录不在可编辑范围内。',
  'file-too-large': '文件超过 1 MiB 上限（加载器同样会跳过它）。',
  'revision-required': '缺少版本号，请刷新后重试。',
  'unknown-op': '未知操作。',
}

function errorText(body: { error?: string; message?: string } | null | undefined, fallback: string): string {
  const message = body?.message
  if (typeof message === 'string' && message !== '') return message
  const code = body?.error
  if (code !== undefined && ERROR_TEXT[code] !== undefined) return ERROR_TEXT[code]
  return fallback
}

// ── fetch wrappers ─────────────────────────────────────────────────────────

async function readProjects(): Promise<ProjectsView> {
  const response = await fetch(`${API_BASE}/projects`, { cache: 'no-store' })
  const body: unknown = await response.json()
  if (!response.ok || typeof body !== 'object' || body === null || (body as { ok?: boolean }).ok !== true) {
    throw new Error(errorText(body as { error?: string; message?: string } | null, '项目列表不可用（插件未加载？）'))
  }
  return body as unknown as ProjectsView
}

async function writeProjects(write: ProjectsWrite, expectedRevision?: number): Promise<ProjectsWriteResult> {
  try {
    const response = await fetch(`${API_BASE}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...write, expectedRevision }),
      cache: 'no-store',
    })
    const body: unknown = await response.json()
    if (response.status === 409) return { ok: false, conflict: true }
    if (!response.ok || typeof body !== 'object' || body === null || (body as { ok?: boolean }).ok !== true) {
      return { ok: false, message: errorText(body as { error?: string; message?: string } | null, '操作失败') }
    }
    return { ok: true, view: body as unknown as ProjectsView }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

async function readChain(dir: string): Promise<ChainView> {
  const response = await fetch(`${API_BASE}/chain?dir=${encodeURIComponent(dir)}`, { cache: 'no-store' })
  const body: unknown = await response.json()
  if (!response.ok || typeof body !== 'object' || body === null || (body as { ok?: boolean }).ok !== true) {
    throw new Error(errorText(body as { error?: string; message?: string } | null, '项目链不可用'))
  }
  return body as unknown as ChainView
}

/** Fetch error carrying the API error code so callers can branch on it
 * (e.g. the global editor's file-too-large state) instead of parsing text. */
class ApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

async function readFile(scope: 'global' | 'project', dir: string | undefined, name: string): Promise<FileView> {
  const params = new URLSearchParams({ scope, ...(dir !== undefined ? { dir } : {}), name })
  const response = await fetch(`${API_BASE}/file?${params.toString()}`, { cache: 'no-store' })
  const body: unknown = await response.json()
  if (!response.ok || typeof body !== 'object' || body === null || (body as { ok?: boolean }).ok !== true) {
    const payload = body as { error?: string; message?: string } | null
    throw new ApiError(payload?.error ?? 'unknown', response.status, errorText(payload, '文件不可读'))
  }
  return body as unknown as FileView
}

async function writeFile(
  write: { scope: 'global' | 'project'; dir?: string; name: string; content: string; expectedMtimeMs?: number | null },
): Promise<FileWriteResult> {
  try {
    const response = await fetch(`${API_BASE}/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(write),
      cache: 'no-store',
    })
    const body: unknown = await response.json()
    if (response.status === 409) {
      const payload = body as { exists?: boolean } | null
      return { ok: false, conflict: true, exists: payload?.exists }
    }
    if (!response.ok || typeof body !== 'object' || body === null || (body as { ok?: boolean }).ok !== true) {
      return { ok: false, message: errorText(body as { error?: string; message?: string } | null, '保存失败') }
    }
    const payload = body as unknown as { bytes: number; mtimeMs: number }
    return { ok: true, bytes: payload.bytes, mtimeMs: payload.mtimeMs }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}

// ── slot registration ──────────────────────────────────────────────────────

export const inject = ['slots', 'locale', 'remote']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-instructions-editor: dictionaries')

  // Pushed invalidation: the manual project registry lives in the settings
  // document, so any committed change re-reads it (multi-window sync).
  const listeners = new Set<() => void>()
  const subscribeRefresh = (fn: () => void): (() => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }
  const refresh = (): void => {
    for (const fn of listeners) {
      try {
        fn()
      } catch {
        // one stale subscriber must not break the others
      }
    }
  }
  ctx.effect(() => ctx.remote.$on('settings/document-updated', (ns: string) => {
    if (ns === NS) refresh()
  }), 'agent-instructions-editor: settings invalidation')

  // Native directory chooser served by the host's directory-picker service.
  // Unsupported backends refuse the verb — degrade to manual paste in the UI.
  const pickDirectory = async (): Promise<string | null> => {
    try {
      const result = await ctx.remote.directoryPicker.pick()
      return result.ok ? result.value : null
    } catch {
      return null
    }
  }

  // Dedicated nav icon for THIS plugin's own row. The shell's navIcon(id)
  // table is closed (official ids only; everything else falls back to a
  // generic gear), so the decoration replaces the fallback <svg> inside our
  // nav button — matched by our own registered label text — with the drawn
  // icon. A MutationObserver re-applies it when the panel re-renders; gated
  // on the settings dialog being present so idle chat streams never pay the
  // query cost. Every third-party settings plugin owns the same pattern for
  // its own row (see dsh-subagent-library/src/client/nav-icon.ts).
  ctx.effect(() => {
    const decorate = (): void => {
      if (document.querySelector('[role="dialog"]') === null) return
      for (const button of Array.from(document.querySelectorAll('button'))) {
        const label = button.querySelector(':scope > span')
        if (label === null || !NAV_LABELS.has(label.textContent ?? '')) continue
        const existing = button.firstElementChild
        if (existing instanceof SVGElement) {
          if (existing.dataset.navIcon === '1') continue
          const template = document.createElement('template')
          template.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-nav-icon="1">${SECTION_ICON_INNER}</svg>`
          existing.replaceWith(template.content.firstElementChild as SVGElement)
        }
      }
    }
    const observer = new MutationObserver(() => decorate())
    observer.observe(document.body, { childList: true, subtree: true })
    decorate()
    return () => observer.disconnect()
  }, 'agent-instructions-editor: nav icon decoration')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NS,
    order: 42,
    label: () => '个性化指令',
    inject: (): InstructionsSectionInjected => ({ readProjects, writeProjects, readChain, readFile, writeFile, pickDirectory, subscribeRefresh }),
  }, InstructionsSection))
}
