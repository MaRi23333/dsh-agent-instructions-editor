/**
 * Regression tests for the editor-state contracts behind AIE-UI-001 and
 * AIE-UI-002 (pure transitions from src/client/editState.ts — the React
 * component delegates every risky merge to these, so pinning them here pins
 * the client behavior without a DOM harness).
 * Run: pnpm test  (tsx --test)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chainResultMayLand, classifyGlobalRead, mergeFreshContent, mergeSaveSuccess, responseIsCurrent } from '../src/client/editState.ts'
import type { EditorTextState } from '../src/client/editState.ts'

function editorState(overrides: Partial<EditorTextState> = {}): EditorTextState {
  return {
    exists: true,
    content: 'A0',
    draft: 'A0',
    mtimeMs: 100,
    conflict: false,
    ...overrides,
  }
}

// ── AIE-UI-001: a save commits only the exact snapshot it sent ─────────────

test('mergeSaveSuccess commits the snapshot, not the in-flight draft', () => {
  // draft A was saved; while the request was in flight the user typed B.
  const state = editorState({ content: 'A0', draft: 'B' })
  const next = mergeSaveSuccess(state, 'A', { ok: true, mtimeMs: 200, bytes: 1 })
  assert.equal(next.content, 'A', 'content must reflect what actually hit the disk')
  assert.equal(next.draft, 'B', 'the newer draft stays in the editor')
  assert.notEqual(next.draft, next.content, 'the editor stays dirty so B can be saved')
})

test('mergeSaveSuccess refreshes disk facts and clears the conflict banner', () => {
  const state = editorState({ conflict: true, exists: false, mtimeMs: null })
  const next = mergeSaveSuccess(state, 'A', { ok: true, mtimeMs: 200 })
  assert.equal(next.conflict, false)
  assert.equal(next.exists, true)
  assert.equal(next.mtimeMs, 200)
})

test('mergeSaveSuccess keeps untouched drafts clean', () => {
  const state = editorState({ content: 'A0', draft: 'A0' })
  const next = mergeSaveSuccess(state, 'A0', { ok: true, mtimeMs: 200 })
  assert.equal(next.draft, next.content, 'no phantom dirty state')
})

// ── AIE-UI-002: a read only applies to the editor session that asked ───────

test('mergeFreshContent applies a matching-target reload', () => {
  const state = editorState({ draft: 'local mess', conflict: true })
  const next = mergeFreshContent(
    state,
    { dir: '/p/a', name: 'AGENTS.md' },
    { dir: '/p/a', name: 'AGENTS.md' },
    { exists: true, content: 'disk', mtimeMs: 300 },
  )
  assert.notEqual(next, null)
  assert.equal(next.content, 'disk')
  assert.equal(next.draft, 'disk')
  assert.equal(next.mtimeMs, 300)
  assert.equal(next.conflict, false)
})

test('mergeFreshContent refuses a late response bound for another file', () => {
  // A's reload resolved after the editor had already moved to B: A's
  // content/mtime must never land in B's editor.
  const stateB = editorState({ content: 'B-disk', draft: 'B-draft', mtimeMs: 9 })
  const refused = mergeFreshContent(
    stateB,
    { dir: '/p/a', name: 'AGENTS.md' },
    { dir: '/p/b', name: 'AGENTS.md' },
    { exists: true, content: 'A-disk', mtimeMs: 300 },
  )
  assert.equal(refused, null, 'identity mismatch → caller keeps the current state')
})

test('mergeFreshContent refuses when name matches but dir differs', () => {
  const state = editorState()
  const refused = mergeFreshContent(
    state,
    { dir: '/p/a', name: 'AGENTS.md' },
    { dir: '/p/other', name: 'AGENTS.md' },
    { exists: true, content: 'x', mtimeMs: 1 },
  )
  assert.equal(refused, null)
})

test('mergeFreshContent handles reload of a now-absent file', () => {
  const state = editorState()
  const next = mergeFreshContent(
    state,
    { dir: '/p/a', name: 'AGENTS.md' },
    { dir: '/p/a', name: 'AGENTS.md' },
    { exists: false, content: '' },
  )
  assert.notEqual(next, null)
  assert.equal(next.exists, false)
  assert.equal(next.mtimeMs, null)
  assert.equal(next.content, '')
})

// ── AIE-BUDGET-003: global read states and budget-refresh wiring ───────────

test('classifyGlobalRead maps file-too-large distinctly from other failures', () => {
  assert.equal(classifyGlobalRead('file-too-large'), 'too-large')
  assert.equal(classifyGlobalRead('stat-failed'), 'failed')
  assert.equal(classifyGlobalRead('read-failed'), 'failed')
  assert.equal(classifyGlobalRead(undefined), 'failed')
  assert.equal(classifyGlobalRead('unknown'), 'failed')
})

// ── AIE-BUDGET-003 r3: chain responses land only while newest ──────────────

test('responseIsCurrent: newest request lands (A save→B switch→save completes)', () => {
  // refreshBudget issued for A (request 1); the user switched to B and the
  // selection effect issued request 2; A's save completion must not land.
  const generationAtSaveIssue = 1
  const generationAfterSwitch = 2
  assert.equal(responseIsCurrent(generationAfterSwitch, generationAtSaveIssue), false)
})

test('responseIsCurrent: A slow / B fast — the late A chain read is dropped', () => {
  const generationAtAIssue = 1
  const generationAfterBIssue = 2
  assert.equal(responseIsCurrent(generationAfterBIssue, generationAtAIssue), false)
  assert.equal(responseIsCurrent(generationAfterBIssue, generationAfterBIssue), true)
})

test('responseIsCurrent: a response arriving after the view was cleared is stale', () => {
  // Collapsing the section bumps the generation while clearing the view, so
  // the late response cannot repopulate it.
  const generationAtIssue = 3
  const generationAfterClear = 4
  assert.equal(responseIsCurrent(generationAfterClear, generationAtIssue), false)
})

// ── AIE-BUDGET-003 r4: the FULL chain landing predicate ────────────────────
// Generation equality alone cannot stop a stale async callback (a
// project-file save completing after a project switch) that ISSUES the
// newest request for an old directory — target, open state and generation
// must all be checked at landing time.

test('chainResultMayLand: happy path — alive, newest, open, matching dir', () => {
  assert.equal(chainResultMayLand({
    alive: true, requestIsNewest: true, open: true, selectedDir: '/w/a', requestedDir: '/w/a',
  }), true)
})

test('chainResultMayLand: the r4 hole — newest generation for a stale dir is refused', () => {
  // A file save completed after the user switched to B; its callback issued
  // a fresh (newest) loadChain for A. Generation says "current", the
  // selection says the user is looking at B — the A view must not land.
  assert.equal(chainResultMayLand({
    alive: true, requestIsNewest: true, open: true, selectedDir: '/w/b', requestedDir: '/w/a',
  }), false)
})

test('chainResultMayLand: save completed after the section was collapsed', () => {
  assert.equal(chainResultMayLand({
    alive: true, requestIsNewest: true, open: false, selectedDir: '/w/a', requestedDir: '/w/a',
  }), false)
})

test('chainResultMayLand: a superseded request is refused even for the right dir', () => {
  assert.equal(chainResultMayLand({
    alive: true, requestIsNewest: false, open: true, selectedDir: '/w/a', requestedDir: '/w/a',
  }), false)
})

test('chainResultMayLand: an unmounted component never lands anything', () => {
  assert.equal(chainResultMayLand({
    alive: false, requestIsNewest: true, open: true, selectedDir: '/w/a', requestedDir: '/w/a',
  }), false)
})
