/**
 * AIE-SETTINGS-020-001 regression coverage.
 *
 * The service below is the real dsh-settings SettingsForms prototype. Only
 * the profile/config-editor persistence seam is in-memory, so this exercises
 * the shipped schema projection, replace(), and revision/CAS checks without
 * touching a user's DSH_HOME or settings file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import { apply, Config, name } from '../src/index.ts'

type JsonObject = Record<string, unknown>
type Route = (req: IncomingMessage, res: ServerResponse) => Promise<void>

interface Entry {
  id: string
  options: { id: string; config: JsonObject }
  fiber: {
    uid: string
    state: number
    runtime: { Config: typeof Config }
    config: JsonObject
    ctx: Record<string, unknown>
  }
}

interface Harness {
  entry: Entry
  settings: SettingsForms
  routes: Map<string, Route>
}

const clone = <T>(value: T): T => structuredClone(value)

class CapturedResponse {
  statusCode = 0
  headers: Record<string, string | number> = {}
  body = ''

  writeHead(status: number, headers: Record<string, string | number>): this {
    this.statusCode = status
    this.headers = headers
    return this
  }

  end(body?: unknown): this {
    this.body = body === undefined ? '' : String(body)
    return this
  }
}

function request(
  route: string,
  method: string,
  body: JsonObject | undefined,
  headers: Record<string, string> = {},
): { req: IncomingMessage; res: CapturedResponse } {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  const req = Object.assign(stream, {
    method,
    url: route,
    headers: { host: '127.0.0.1:39123', ...headers },
  }) as unknown as IncomingMessage
  return { req, res: new CapturedResponse() }
}

async function invoke(harness: Harness, method: string, body?: JsonObject, headers?: Record<string, string>): Promise<{ status: number; body: JsonObject }> {
  const route = harness.routes.get('/agent-instructions/api/projects')
  assert.ok(route, 'apply() must register the projects route')
  const pair = request('/agent-instructions/api/projects', method, body, headers)
  await route(pair.req, pair.res as unknown as ServerResponse)
  assert.notEqual(pair.res.statusCode, 0, 'route must send a response')
  return { status: pair.res.statusCode, body: JSON.parse(pair.res.body) as JsonObject }
}

function projectEntries(body: JsonObject): Array<JsonObject> {
  assert.ok(Array.isArray(body.projects))
  return body.projects as Array<JsonObject>
}

function manualEntry(body: JsonObject, id: string): JsonObject | undefined {
  return projectEntries(body).find((entry) => entry.id === `manual:${id}`)
}

async function createHarness(home: string, initial: Record<string, string>): Promise<Harness> {
  const initialConfig = { manualProjects: clone(initial) }
  const entry: Entry = {
    id: 'fiber-entry-1',
    options: { id: name, config: clone(initialConfig) },
    fiber: {
      uid: 'fiber-uid-1',
      state: 2,
      runtime: { Config },
      config: clone(initialConfig),
      ctx: {},
    },
  }

  const configEditor = {
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: clone(entry.options.config) }],
    edit: async (_entry: Entry, change: (current: JsonObject, inherited: JsonObject) => JsonObject) => {
      const next = change(clone(entry.options.config), {})
      entry.options.config = clone(next)
      entry.fiber.config = clone(next)
    },
    documentPath: path.join(home, 'profile.json'),
  }

  // Use the actual dsh-settings implementation; this is only its documented
  // profile/config-editor persistence seam, isolated to the temp fixture.
  const ownerContext = {
    configEditor,
    emit: () => {},
    effect: () => {},
  }
  const settings = Object.assign(Object.create(SettingsForms.prototype), {
    ownerContext,
    revisions: new Map(),
    presentations: new Map(),
    closed: false,
    scheduled: false,
  }) as SettingsForms

  const routes = new Map<string, Route>()
  const webServer = {
    register: (spec: { path: string; handler: Route }) => {
      routes.set(spec.path, spec.handler)
      return () => routes.delete(spec.path)
    },
  }
  const ctx = {
    fiber: entry.fiber,
    inject: (services: string[], callback: (serviceContext: Record<string, unknown>) => void) => {
      const service = services[0]
      if (service === 'settings') callback({ settings })
      else if (service === 'configEditor') callback({ configEditor })
      else if (service === 'webServer') callback({ webServer, effect: (effect: () => unknown) => effect() })
    },
    effect: (effect: () => unknown) => effect(),
  }

  apply(ctx as never, { manualProjects: clone(initial) })
  assert.ok(routes.has('/agent-instructions/api/projects'))
  return { entry, settings, routes }
}

async function withFixture(initial: Record<string, string>, callback: (root: string, harness: Harness, dirs: Record<string, string>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aie-settings-compat-'))
  const home = path.join(root, 'dsh-home')
  const dirs = {
    existing: path.join(root, 'existing-project'),
    other: path.join(root, 'other-project'),
    added: path.join(root, 'added-project'),
  }
  await mkdir(home, { recursive: true })
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const harness = await createHarness(home, initial)
    await callback(root, harness, dirs)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
}

test('official SettingsForms exposes the volatile manual-project contract and numeric revision', async () => {
  await withFixture({ existing: '' }, async (_root, harness, dirs) => {
    harness.entry.options.config.manualProjects = { existing: dirs.existing }
    harness.entry.fiber.config.manualProjects = { existing: dirs.existing }
    const schema = Config.toJSON() as { uid?: number; dict?: Record<string, unknown>; refs?: Record<string, { dict?: Record<string, unknown>; meta?: { volatile?: boolean } }> }
    const rootSchema = schema.refs?.[String(schema.uid)] ?? schema
    const manualRef = rootSchema.dict?.manualProjects
    const manualSchema = typeof manualRef === 'number' ? schema.refs?.[String(manualRef)] : manualRef as { meta?: { volatile?: boolean } } | undefined
    assert.equal(manualSchema?.meta?.volatile, true)

    const [descriptor] = harness.settings.describe()
    assert.ok(descriptor)
    assert.equal(typeof descriptor.revision, 'number')
    assert.deepEqual((descriptor.value as JsonObject).manualProjects, { existing: dirs.existing })
    assert.match(JSON.stringify(descriptor.schema), /manualProjects/)

    await harness.settings.replace(name, { manualProjects: { existing: dirs.existing, second: dirs.other } }, descriptor.revision)
    const after = harness.settings.describe()[0]
    assert.equal(typeof after.revision, 'number')
    assert.deepEqual((after.value as JsonObject).manualProjects, { existing: dirs.existing, second: dirs.other })
  })
})

test('apply projects route round-trips manual entries and preserves CAS/security boundaries', async () => {
  await withFixture({ existing: '', other: '' }, async (_root, harness, dirs) => {
    harness.entry.options.config.manualProjects = { existing: dirs.existing, other: dirs.other }
    harness.entry.fiber.config.manualProjects = { existing: dirs.existing, other: dirs.other }

    const initial = await invoke(harness, 'GET')
    assert.equal(initial.status, 200)
    assert.ok(manualEntry(initial.body, 'existing'))
    assert.ok(manualEntry(initial.body, 'other'))
    assert.equal(typeof initial.body.revision, 'number')
    const initialRevision = initial.body.revision as number

    const added = await invoke(harness, 'POST', { op: 'add', dir: dirs.added, expectedRevision: initialRevision }, { 'content-type': 'application/json' })
    assert.equal(added.status, 200, JSON.stringify(added.body))
    const addedEntry = projectEntries(added.body).find((entry) => entry.dir === dirs.added)
    assert.ok(addedEntry)
    const addedId = String(addedEntry.id).replace(/^manual:/, '')
    assert.ok(manualEntry(added.body, 'existing'))
    assert.ok(manualEntry(added.body, 'other'))
    const afterAddRevision = added.body.revision as number
    assert.notEqual(afterAddRevision, initialRevision)

    const afterAddRead = await invoke(harness, 'GET')
    assert.equal(afterAddRead.status, 200)
    assert.ok(manualEntry(afterAddRead.body, addedId))
    assert.ok(manualEntry(afterAddRead.body, 'existing'))
    assert.ok(manualEntry(afterAddRead.body, 'other'))

    const removed = await invoke(harness, 'POST', { op: 'remove', id: addedId, expectedRevision: afterAddRevision }, { 'content-type': 'application/json' })
    assert.equal(removed.status, 200)
    assert.equal(manualEntry(removed.body, addedId), undefined)
    assert.ok(manualEntry(removed.body, 'existing'))
    assert.ok(manualEntry(removed.body, 'other'))

    const afterRemoveRead = await invoke(harness, 'GET')
    assert.equal(afterRemoveRead.status, 200)
    assert.equal(manualEntry(afterRemoveRead.body, addedId), undefined, 'removed keys must not resurrect')
    assert.ok(manualEntry(afterRemoveRead.body, 'existing'))
    assert.ok(manualEntry(afterRemoveRead.body, 'other'))

    const stale = await invoke(harness, 'POST', { op: 'add', dir: dirs.added, expectedRevision: initialRevision }, { 'content-type': 'application/json' })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error, 'conflict')

    const missingRevision = await invoke(harness, 'POST', { op: 'remove', id: 'existing' }, { 'content-type': 'application/json' })
    assert.equal(missingRevision.status, 400)
    assert.equal(missingRevision.body.error, 'revision-required')

    const invalidHost = await invoke(harness, 'POST', { op: 'remove', id: 'existing', expectedRevision: afterRemoveRead.body.revision }, { 'content-type': 'application/json', host: 'attacker.invalid' })
    assert.equal(invalidHost.status, 403)
    assert.equal(invalidHost.body.error, 'host-not-allowed')

    const crossOrigin = await invoke(harness, 'POST', { op: 'remove', id: 'existing', expectedRevision: afterRemoveRead.body.revision }, { 'content-type': 'application/json', origin: 'http://127.0.0.1:39124' })
    assert.equal(crossOrigin.status, 403)
    assert.equal(crossOrigin.body.error, 'cross-origin-forbidden')
  })
})
