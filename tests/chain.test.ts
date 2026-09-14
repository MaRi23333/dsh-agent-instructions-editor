/**
 * Unit tests for the loader-mirroring discovery logic (src/chain.ts).
 * Run: pnpm test  (tsx --test)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ancestorChain,
  buildChain,
  dshHomeDisplay,
  expandHomePath,
  findProjectRoot,
  MAX_SOURCE_BYTES,
  resolveDshHome,
  statFile,
  userGlobalDisplayPath,
  userGlobalPath,
} from '../src/chain.ts'

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'aie-test-'))
}

test('findProjectRoot walks up to the .git directory', async () => {
  const root = tmp()
  try {
    const nested = path.join(root, 'packages', 'app')
    mkdirSync(path.join(root, '.git'), { recursive: true })
    mkdirSync(nested, { recursive: true })
    assert.equal(await findProjectRoot(nested), path.resolve(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findProjectRoot accepts a .git file marker (worktree)', async () => {
  const root = tmp()
  try {
    writeFileSync(path.join(root, '.git'), 'gitdir: somewhere_else')
    assert.equal(await findProjectRoot(root), path.resolve(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findProjectRoot falls back to the cwd itself when no marker exists', async () => {
  const dir = tmp()
  try {
    assert.equal(await findProjectRoot(dir), path.resolve(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ancestorChain is inclusive, broadest first', () => {
  const root = path.resolve('/repo')
  const chain = ancestorChain(root, path.join(root, 'a', 'b'))
  assert.deepEqual(chain, [root, path.join(root, 'a'), path.join(root, 'a', 'b')])
  assert.deepEqual(ancestorChain(root, root), [root])
})

test('buildChain probes base then overlay candidates and orders the chain root→cwd', async () => {
  const root = tmp()
  try {
    const nested = path.join(root, 'packages', 'app')
    mkdirSync(path.join(root, '.git'), { recursive: true })
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(root, 'AGENTS.md'), '# root')
    writeFileSync(path.join(root, 'CLAUDE.md'), '# root')
    writeFileSync(path.join(nested, 'AGENTS.local.md'), 'local overlay')

    const view = await buildChain(nested)
    assert.equal(view.root, path.resolve(root))
    assert.deepEqual(view.dirs.map((dir) => dir.displayPath), ['.', path.join('packages'), path.join('packages', 'app')])

    const rootDir = view.dirs[0]
    assert.deepEqual(rootDir.slots.map((slot) => slot.name), ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'])
    assert.equal(rootDir.slots[0].exists, true)
    // sibling with identical trimmed content is deduped against AGENTS.md
    assert.equal(rootDir.slots[1].exists, true)
    assert.equal(rootDir.slots[1].dedupWith, rootDir.slots[0].displayPath)
    assert.equal(rootDir.slots[2].exists, false)

    const nestedDir = view.dirs[2]
    assert.equal(nestedDir.slots[0].exists, false)
    assert.equal(nestedDir.slots[2].exists, true)
    assert.equal(nestedDir.slots[2].dedupWith, undefined)
    // cross-directory identical content never dedups
    assert.equal(nestedDir.slots[0].dedupWith, undefined)
    // totalBytes counts dedup winners only: root AGENTS.md + nested overlay
    assert.equal(view.totalBytes, '# root'.length + 'local overlay'.length)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveDshHome precedence: config > non-blank env > ~/.dsh', () => {
  assert.equal(resolveDshHome('/custom', { DSH_HOME: '/from-env' }), path.resolve('/custom'))
  assert.equal(resolveDshHome(undefined, { DSH_HOME: '/from-env' }), path.resolve('/from-env'))
  // blank env is treated as unset
  assert.equal(resolveDshHome(undefined, { DSH_HOME: '   ' }), path.join(os.homedir(), '.dsh'))
  assert.equal(resolveDshHome(undefined, {}), path.join(os.homedir(), '.dsh'))
})

test('display paths match the loader exactly', () => {
  assert.equal(dshHomeDisplay(path.join(os.homedir(), '.dsh')), '~/.dsh')
  assert.equal(dshHomeDisplay('/custom'), '$DSH_HOME')
  assert.equal(userGlobalDisplayPath(undefined, {}), '~/.dsh/AGENTS.md')
  assert.equal(userGlobalDisplayPath(undefined, { DSH_HOME: '/custom' }), '$DSH_HOME/AGENTS.md')
  assert.equal(userGlobalPath(undefined, { DSH_HOME: '/custom' }), path.resolve(path.join('/custom', 'AGENTS.md')))
})

test('statFile tri-state: directories and ENOTDIR paths are absent', async () => {
  const root = tmp()
  try {
    const dir = path.join(root, 'dir')
    mkdirSync(dir)
    const file = path.join(root, 'f.txt')
    writeFileSync(file, 'x')
    assert.equal(await statFile(dir), 'absent') // exists but not a file
    const info = await statFile(file)
    assert.equal(typeof info, 'object')
    assert.equal(await statFile(path.join(file, 'child')), 'absent') // ENOTDIR
    assert.equal(await statFile(path.join(root, 'nope.txt')), 'absent')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('over-cap files load nothing: excluded from dedup and totalBytes', async () => {
  const root = tmp()
  try {
    mkdirSync(path.join(root, '.git'), { recursive: true })
    writeFileSync(path.join(root, 'AGENTS.md'), 'y'.repeat(MAX_SOURCE_BYTES + 1))
    writeFileSync(path.join(root, 'CLAUDE.md'), 'small')
    const view = await buildChain(root)
    const [agents, claude] = view.dirs[0].slots
    assert.equal(agents.overLimit, true)
    assert.equal(agents.dedupWith, undefined)
    assert.equal(claude.overLimit, undefined)
    // only the within-cap file counts toward the budget display
    assert.equal(view.totalBytes, 'small'.length)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('expandHomePath tilde branches and tilde-configured home', () => {
  assert.equal(expandHomePath('~'), os.homedir())
  assert.equal(expandHomePath('~/x'), path.join(os.homedir(), 'x'))
  assert.equal(expandHomePath('~\\x'), path.join(os.homedir(), 'x'))
  assert.equal(expandHomePath('C:/x'), 'C:/x')
  assert.equal(resolveDshHome('~/.custom', {}), path.resolve(path.join(os.homedir(), '.custom')))
})
