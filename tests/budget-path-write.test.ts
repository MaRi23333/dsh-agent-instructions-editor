/**
 * Regression tests for the review findings AIE-BUDGET-003, AIE-PATH-004 and
 * AIE-WRITE-006: budget accounting helpers, case-aware directory identity
 * keys, session-workspace merging, and the per-target write queue that makes
 * the mtime fence and the write one transaction.
 * Run: pnpm test  (tsx --test)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import {
  countedGlobalBytes,
  dirKey,
  enqueueWrite,
  globalOverLimit,
  MAX_SOURCE_BYTES,
  mergeSessionWorkspaces,
} from '../src/chain.ts'

// ── AIE-BUDGET-003: only loader-relevant global bytes count ────────────────

test('countedGlobalBytes counts a normal global file once', () => {
  assert.equal(countedGlobalBytes({ exists: true, bytes: 100 }), 100)
  // host formula: project total + counted global — global 100 / project 10 → 110, not 210.
  assert.equal(10 + countedGlobalBytes({ exists: true, bytes: 100 }), 110)
})

test('countedGlobalBytes: empty and missing globals contribute zero', () => {
  assert.equal(countedGlobalBytes({ exists: false, bytes: 0 }), 0)
  assert.equal(countedGlobalBytes({ exists: true, bytes: 0 }), 0)
})

test('countedGlobalBytes: the loader skips globals over 1 MiB', () => {
  assert.equal(countedGlobalBytes({ exists: true, bytes: MAX_SOURCE_BYTES + 1 }), 0)
  // boundary: exactly at the limit it is still counted
  assert.equal(countedGlobalBytes({ exists: true, bytes: MAX_SOURCE_BYTES }), MAX_SOURCE_BYTES)
  assert.equal(globalOverLimit({ exists: true, bytes: MAX_SOURCE_BYTES }), false)
  assert.equal(globalOverLimit({ exists: true, bytes: MAX_SOURCE_BYTES + 1 }), true)
  assert.equal(globalOverLimit({ exists: false, bytes: 5 }), false)
})

// ── AIE-PATH-004: identity keys are comparison-only and case-aware ─────────

test('dirKey folds case only on case-insensitive platforms', () => {
  const a = '/repo/A'
  const b = '/repo/a'
  assert.equal(dirKey(a, 'win32'), dirKey(b, 'win32'), 'win32 default FS is case-insensitive')
  assert.notEqual(dirKey(a, 'linux'), dirKey(b, 'linux'), 'case-sensitive FS keeps both distinct')
})

test('dirKey never returns the raw unresolved string', () => {
  // The key is for comparison only; callers must keep real paths separately.
  assert.equal(dirKey('/repo/A', 'linux'), path.resolve('/repo/A'))
  assert.equal(dirKey('/repo/./A', 'linux'), path.resolve('/repo/./A'))
})

test('mergeSessionWorkspaces keeps case-distinct dirs apart on linux', () => {
  const merged = mergeSessionWorkspaces(
    [],
    [
      { cwd: '/home/User/Project', createdAt: 1 },
      { cwd: '/home/user/project', createdAt: 2 },
    ],
    { isNoise: () => false, platform: 'linux' },
  )
  assert.equal(merged.length, 2, 'distinct case-sensitive paths must not collapse')
  // Returned dir values are the real resolved paths — never a lowercased key.
  assert.deepEqual(
    merged.map((entry) => entry.dir).sort(),
    [path.resolve('/home/User/Project'), path.resolve('/home/user/project')].sort(),
  )
})

test('mergeSessionWorkspaces dedups case-variants on win32 keeping newest', () => {
  const merged = mergeSessionWorkspaces(
    [],
    [
      { cwd: 'C:\\Repo\\A', createdAt: 1 },
      { cwd: 'c:\\repo\\a', createdAt: 5 },
    ],
    { isNoise: () => false, platform: 'win32' },
  )
  assert.equal(merged.length, 1)
  // AIE-CI-007: the runtime `path.resolve` decides the returned string (on
  // POSIX a Windows-style path is just a name under the cwd) — assert
  // against the same contract the implementation uses, so the suite holds
  // on Windows and Linux alike without weakening product behavior (case
  // folding stays win32-only, newest session wins).
  assert.equal(merged[0].dir, path.resolve('c:\\repo\\a'))
})

test('mergeSessionWorkspaces never re-adds known projects and caps extras', () => {
  const known = [{ dir: path.resolve('/w/known') }]
  const records = Array.from({ length: 20 }, (_, index) => ({ cwd: `/w/gen-${index}`, createdAt: index }))
  const merged = mergeSessionWorkspaces(known, records, { isNoise: () => false, platform: 'linux' })
  assert.equal(merged.length, 1 + 12, 'cap of 12 extras')
  assert.equal(merged[0].dir, path.resolve('/w/known'), 'previous entries come first')
  assert.ok(merged.slice(1).every((entry) => entry.dir !== path.resolve('/w/known')))
  // newest first among extras
  assert.equal(merged[1].dir, path.resolve('/w/gen-19'))
})

// ── AIE-WRITE-006: fence + write are one serialized transaction ────────────

test('enqueueWrite serializes same-target writers; the stale fence conflicts', async () => {
  let mtime = 100
  const outcomes: string[] = []
  const attempt = (tag: string, expected: number): Promise<void> =>
    enqueueWrite('target-a', async () => {
      // in-queue version re-check (the mtime fence)
      if (expected !== mtime) {
        outcomes.push(`${tag}:409`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
      mtime += 1 // simulates atomicWrite bumping mtime
      outcomes.push(`${tag}:200`)
    })
  // Both writers carry the same expected version — exactly the review probe.
  await Promise.all([attempt('A', 100), attempt('B', 100)])
  assert.deepEqual(outcomes, ['A:200', 'B:409'], 'second same-version writer must conflict, not clobber')
})

test('enqueueWrite: a rejecting task does not poison the queue', async () => {
  const order: string[] = []
  const first = enqueueWrite('target-b', async () => {
    order.push('first')
    throw new Error('disk exploded')
  })
  await assert.rejects(first, /disk exploded/)
  await enqueueWrite('target-b', async () => { order.push('second') })
  assert.deepEqual(order, ['first', 'second'])
})

test('enqueueWrite: different targets run concurrently', async () => {
  let inside = 0
  let maxInside = 0
  await Promise.all([
    enqueueWrite('t1', async () => {
      inside += 1
      maxInside = Math.max(maxInside, inside)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inside -= 1
    }),
    enqueueWrite('t2', async () => {
      inside += 1
      maxInside = Math.max(maxInside, inside)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inside -= 1
    }),
  ])
  assert.equal(maxInside, 2, 'distinct targets must not serialize against each other')
})
