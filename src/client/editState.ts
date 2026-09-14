/**
 * Pure state transitions shared by the global and project editors, extracted
 * so the risky save/reload merges have runnable regression coverage without
 * a DOM test harness (AIE-UI-001 / AIE-UI-002).
 */

/** Text-bearing fields of an editor state (global or per-file editing). */
export interface EditorTextState {
  exists: boolean
  content: string
  draft: string
  mtimeMs: number | null
  conflict: boolean
}

/** What a successful write reports back (subset the merges consume). */
export interface SaveSuccess {
  ok: true
  mtimeMs: number
  bytes?: number
}

/**
 * AIE-UI-001: a successful save commits **only the exact snapshot that was
 * sent to the server**. Any draft the user typed while the request was in
 * flight stays untouched in `draft`, so the editor remains dirty and the
 * next save writes it — the page must never report more as persisted than
 * what actually hit the disk.
 */
export function mergeSaveSuccess<T extends EditorTextState>(
  previous: T,
  snapshot: string,
  result: SaveSuccess,
): T {
  return {
    ...previous,
    content: snapshot,
    mtimeMs: result.mtimeMs,
    exists: true,
    conflict: false,
  }
}

/** What a fresh read reports back (subset the merges consume). */
export interface FreshContent {
  exists: boolean
  content: string
  mtimeMs?: number
}

/** Identity of the file an editor session is bound to. */
export interface EditorTarget {
  dir?: string
  name: string
}

function sameTarget(a: EditorTarget, b: EditorTarget): boolean {
  return a.dir === b.dir && a.name === b.name
}

/**
 * AIE-UI-002: a finished read (initial open, conflict reload) may only be
 * applied to the editor session that requested it. `requested` is the
 * target captured when the request was issued, `current` the target of the
 * state about to be patched; on any mismatch the merge is refused (`null`)
 * and the caller keeps the current state — a late response must never move
 * another file's content or mtime into this editor.
 */
export function mergeFreshContent<T extends EditorTextState>(
  previous: T,
  requested: EditorTarget,
  current: EditorTarget,
  fresh: FreshContent,
): T | null {
  if (!sameTarget(requested, current)) return null
  return {
    ...previous,
    exists: fresh.exists,
    content: fresh.content,
    draft: fresh.content,
    mtimeMs: fresh.exists && fresh.mtimeMs !== undefined ? fresh.mtimeMs : null,
    conflict: false,
  }
}

/**
 * AIE-BUDGET-003: the global editor has states beyond "loaded ok" — a read
 * can fail (host down, permissions) or refuse an over-1 MiB file (the host
 * returns error code `file-too-large`, and the loader would skip that file
 * anyway). The over-limit fact must not depend on successfully reading the
 * body, so it gets its own state.
 */
export type GlobalReadState = 'ok' | 'too-large' | 'failed'

export function classifyGlobalRead(code: string | undefined): GlobalReadState {
  return code === 'file-too-large' ? 'too-large' : 'failed'
}

/**
 * Monotonic-request discipline shared by every async view (editing session,
 * chain/budget view): a response may only land while it is still the newest
 * request issued for its slot. `latestIssued` is the counter's current
 * value at completion time; `thisRequest` is the generation the response
 * belongs to.
 */
export function responseIsCurrent(latestIssued: number, thisRequest: number): boolean {
  return thisRequest === latestIssued
}

/**
 * AIE-BUDGET-003 r4: the full landing predicate for a chain response. A
 * read may only update the budget bar when ALL of these hold:
 * - the component is still mounted (`alive`),
 * - no newer chain request was issued since (`requestIsNewest`) — this
 *   alone is NOT enough: a stale async callback (e.g. a project-file save
 *   completing after the user switched projects) can ISSUE the newest
 *   request for an old directory,
 * - the section is still open (`open`) — a collapsed section has no live
 *   chain view,
 * - the response is for the project the user is still looking at
 *   (`selectedDir === requestedDir`).
 */
export interface ChainLandingContext {
  alive: boolean
  requestIsNewest: boolean
  open: boolean
  selectedDir: string | null
  requestedDir: string
}

export function chainResultMayLand(ctx: ChainLandingContext): boolean {
  return ctx.alive && ctx.requestIsNewest && ctx.open && ctx.selectedDir === ctx.requestedDir
}
