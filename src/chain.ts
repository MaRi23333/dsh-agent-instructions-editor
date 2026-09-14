/**
 * Discovery logic mirroring @deepseek-ai/dsh-agent-instructions exactly, so
 * the editor shows precisely the files the loader would load. Sources of
 * truth (verified against the bundled loader, lib/index.js):
 *
 *   - project-root walk: stat-based marker test (file OR directory), upward
 *     until the filesystem root, no marker ⇒ cwd itself is the root
 *   - chain: project root → … → workspace dir, broadest first, inclusive
 *   - candidates per directory: base list first, then overlay list
 *   - presence: stat succeeds AND isFile()
 *   - dedup: per directory, SHA-1 of content.trim(); earliest wins
 *   - budget: dsh-base ships maxBytes 65536, maxSourceBytes 1048576
 *
 * Pure Node — no cordis, no HTTP — so it is unit-testable in isolation.
 *
 * @module dsh-agent-instructions-editor/chain
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const PROJECT_ROOT_MARKERS: readonly string[] = ['.git']
export const BASE_CANDIDATES: readonly string[] = ['AGENTS.md', 'CLAUDE.md']
export const LOCAL_CANDIDATES: readonly string[] = ['AGENTS.local.md', 'CLAUDE.local.md']
export const USER_GLOBAL_FILE = 'AGENTS.md'
/** Every file name the editor may ever read or write. */
export const EDITABLE_NAMES: readonly string[] = [...BASE_CANDIDATES, ...LOCAL_CANDIDATES]
/** dsh-base's budget for the rendered baseline message. */
export const DEFAULT_MAX_BYTES = 65536
/** The loader's per-source-file read cap; bigger files are skipped by the loader. */
export const MAX_SOURCE_BYTES = 1048576

// ── harness home (dsh-home-paths semantics) ────────────────────────────────

/** Expand supported tilde prefixes against the OS home. */
export function expandHomePath(target: string): string {
  if (target === '~') return os.homedir()
  if (target.startsWith('~/') || target.startsWith('~\\')) return path.join(os.homedir(), target.slice(2))
  return target
}

/**
 * Resolve the harness home: explicit config, then a non-blank `$DSH_HOME`,
 * then `~/.dsh`; expanded and resolved to an absolute normalized path.
 */
export function resolveDshHome(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME
  const chosen = configured
    ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : path.join(os.homedir(), '.dsh'))
  return path.resolve(expandHomePath(chosen))
}

/** `~/.dsh` for the default home, `$DSH_HOME` for anything else. */
export function dshHomeDisplay(resolvedHome: string): string {
  return path.resolve(resolvedHome) === path.resolve(path.join(os.homedir(), '.dsh')) ? '~/.dsh' : '$DSH_HOME'
}

/** Absolute path of the user-global instruction file. */
export function userGlobalPath(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDshHome(configured, env), USER_GLOBAL_FILE)
}

/** Display form of the user-global path, exactly as the loader renders it. */
export function userGlobalDisplayPath(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${dshHomeDisplay(resolveDshHome(configured, env))}/${USER_GLOBAL_FILE}`
}

// ── identity keys and budget accounting (shared by host routes; pure, unit-tested)

/**
 * Comparison key for directory identity (dedup and "already seen" sets).
 * Case-folded **only** on platforms whose default filesystem is
 * case-insensitive; on case-sensitive filesystems `/repo/A` and `/repo/a`
 * are distinct directories and must not collide. This key is for comparison
 * only — it must never be used as an actual filesystem path (AIE-PATH-004).
 */
export function dirKey(target: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(target)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Bytes of the user-global file that the instruction loader would actually
 * count toward its budget: sources over MAX_SOURCE_BYTES are skipped
 * entirely, so an over-limit global contributes zero (AIE-BUDGET-003).
 * The result is a source-file estimate for display — the loader's own
 * budget applies to the rendered context and is not byte-identical.
 */
export function countedGlobalBytes(global: { exists: boolean; bytes: number }): number {
  return global.exists && global.bytes <= MAX_SOURCE_BYTES ? global.bytes : 0
}

/** True when the global file exists but the loader would skip it for size. */
export function globalOverLimit(global: { exists: boolean; bytes: number }): boolean {
  return global.exists && global.bytes > MAX_SOURCE_BYTES
}

/**
 * Fold session cwds into the already-known project list (pure; host passes
 * its noise filter). Newest session per directory identity wins, already
 * known directories are never duplicated, newest-first, capped. Identity
 * uses dirKey(), so case-sensitive filesystems keep `/repo/A` and `/repo/a`
 * apart and the returned `dir` values are always real paths, never
 * comparison keys (AIE-PATH-004).
 */
export interface SessionRecordLike {
  cwd: unknown
  createdAt?: unknown
}

export function mergeSessionWorkspaces(
  previous: SessionWorkspaceLike[],
  records: readonly SessionRecordLike[],
  options: { isNoise: (dir: string) => boolean; limit?: number; platform?: NodeJS.Platform },
): SessionWorkspaceLike[] {
  const latest = new Map<string, { dir: string; created: number }>()
  for (const record of records) {
    const cwd = record.cwd
    if (typeof cwd !== 'string' || cwd === '' || options.isNoise(cwd)) continue
    const created = typeof record.createdAt === 'number' ? record.createdAt : 0
    const key = dirKey(cwd, options.platform)
    const known = latest.get(key)
    if (known === undefined || created > known.created) latest.set(key, { dir: path.resolve(cwd), created })
  }
  const seen = new Set(previous.map((entry) => dirKey(entry.dir, options.platform)))
  const extra = [...latest.entries()]
    .filter(([key]) => !seen.has(key))
    .sort((a, b) => b[1].created - a[1].created)
    .slice(0, options.limit ?? 12)
    .map(([, recent]) => ({ dir: recent.dir }))
  return [...previous, ...extra]
}

/** Minimal shape of the workspace entries flowing through discovery. */
export interface SessionWorkspaceLike {
  dir: string
  label?: string
}

// ── per-target write serialization (AIE-WRITE-006) ─────────────────────────

/** One settled tail promise per resolved target path. */
const writeQueues = new Map<string, Promise<unknown>>()

/**
 * Run `task` only after every previously enqueued task for `key` has
 * settled. The returned promise propagates the task's result/rejection to
 * the caller, while the stored tail never rejects (the chain must survive
 * failures). Callers re-check their version fence inside the task, so two
 * concurrent same-version writers serialize and the second one conflicts
 * instead of silently clobbering the first.
 */
export function enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  writeQueues.set(key, tail)
  void tail.then(() => {
    // Drop the map entry once this is still the newest settled tail.
    if (writeQueues.get(key) === tail) writeQueues.delete(key)
  })
  return run
}

// ── probing ────────────────────────────────────────────────────────────────

export interface StatInfo {
  size: number
  mtimeMs: number
}

/** Tri-state presence test mirroring the loader: present only when stat succeeds and isFile(). */
export async function statFile(absolutePath: string): Promise<StatInfo | 'absent' | 'unavailable'> {
  try {
    const info = await fs.stat(absolutePath)
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : 'absent'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unavailable'
  }
}

async function existsAsMarker(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath)
    return true
  } catch {
    return false
  }
}

// ── project root and chain ─────────────────────────────────────────────────

/**
 * Walk upward from `cwd` testing markers (any existing entry — a worktree
 * `.git` file counts); stop only at the filesystem root. No marker ⇒ the
 * cwd itself is the root, exactly like the loader.
 */
export async function findProjectRoot(cwd: string, markers: readonly string[] = PROJECT_ROOT_MARKERS): Promise<string> {
  let current = path.resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await existsAsMarker(path.join(current, marker))) return current
    }
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

/** Inclusive ancestor chain `[root, …, cwd]`, broadest first. */
export function ancestorChain(root: string, cwd: string): string[] {
  const resolvedRoot = path.resolve(root)
  const chain: string[] = []
  let current = path.resolve(cwd)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

// ── chain view ─────────────────────────────────────────────────────────────

export type SlotKind = 'base' | 'overlay'

export interface FileSlot {
  /** Candidate file name, e.g. `AGENTS.local.md`. */
  name: string
  kind: SlotKind
  absolutePath: string
  /** Relative to the project root, platform separators (`AGENTS.md` at root). */
  displayPath: string
  exists: boolean
  bytes?: number
  mtimeMs?: number
  /** displayPath of an earlier sibling with identical trimmed content. */
  dedupWith?: string
  /** Exceeds the loader's per-source read cap; the loader skips it entirely. */
  overLimit?: boolean
  /** Content read failed; the loader would load nothing for it. */
  readFailed?: boolean
}

export interface ChainDir {
  absolutePath: string
  /** Relative to the project root; the root itself is `.`. */
  displayPath: string
  isRoot: boolean
  slots: FileSlot[]
}

export interface ChainView {
  root: string
  workspaceDir: string
  dirs: ChainDir[]
  /** Post-dedup byte sum of existing chain files. */
  totalBytes: number
}

/** SHA-1 of content.trim(), the loader's dedup digest. */
function trimmedDigest(content: string): string {
  return createHash('sha1').update(content.trim(), 'utf8').digest('hex')
}

/**
 * Probe every candidate in every chain directory (base list first, then
 * overlays), then compute per-directory content dedup by reading existing
 * files. Read failures leave `dedupWith` unset rather than lying.
 */
export async function buildChain(workspaceDir: string, markers: readonly string[] = PROJECT_ROOT_MARKERS): Promise<ChainView> {
  const resolvedWorkspace = path.resolve(workspaceDir)
  const root = await findProjectRoot(resolvedWorkspace, markers)
  const dirs: ChainDir[] = []

  for (const dir of ancestorChain(root, resolvedWorkspace)) {
    const relative = path.relative(root, dir)
    const chainDir: ChainDir = {
      absolutePath: dir,
      displayPath: relative === '' ? '.' : relative,
      isRoot: dir === root,
      slots: [],
    }
    for (const [kind, candidates] of [['base', BASE_CANDIDATES], ['overlay', LOCAL_CANDIDATES]] as const) {
      for (const name of candidates) {
        const absolutePath = path.join(dir, name)
        const stat = await statFile(absolutePath)
        chainDir.slots.push({
          name,
          kind,
          absolutePath,
          displayPath: path.relative(root, absolutePath),
          exists: stat !== 'absent' && stat !== 'unavailable',
          ...(typeof stat === 'object'
            ? { bytes: stat.size, mtimeMs: stat.mtimeMs, ...(stat.size > MAX_SOURCE_BYTES ? { overLimit: true as const } : {}) }
            : {}),
        })
      }
    }
    dirs.push(chainDir)
  }

  // Per-directory dedup: read existing files, later duplicates of an earlier
  // trimmed digest in the SAME directory are marked with the winner's path.
  for (const dir of dirs) {
    const seen = new Map<string, string>()
    for (const slot of dir.slots) {
      if (!slot.exists || slot.bytes === undefined || slot.overLimit) continue
      let content: string
      try {
        content = await fs.readFile(slot.absolutePath, 'utf8')
      } catch {
        slot.readFailed = true
        continue
      }
      const digest = trimmedDigest(content)
      const winner = seen.get(digest)
      if (winner !== undefined) {
        slot.dedupWith = winner
      } else {
        seen.set(digest, slot.displayPath)
      }
    }
  }

  let totalBytes = 0
  for (const dir of dirs) {
    for (const slot of dir.slots) {
      // Mirror the loader's budget contribution: over-cap and unreadable
      // files load nothing and contribute zero bytes.
      if (slot.exists && slot.dedupWith === undefined && !slot.overLimit && !slot.readFailed && slot.bytes !== undefined) {
        totalBytes += slot.bytes
      }
    }
  }
  return { root, workspaceDir: resolvedWorkspace, dirs, totalBytes }
}
