// Post-build smoke: the client bundle must self-register under its package
// name and its factory must produce exports with apply/inject.
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const factories = new Map()

globalThis.window = {
  __ModuleLoader__: {
    load(entry) { factories.set(entry.id, entry.factory) },
  },
}

require('../lib/client.js')

if (!factories.has('dsh-agent-instructions-editor')) {
  throw new Error(`client bundle did not self-register (have: ${[...factories.keys()].join(', ') || 'nothing'})`)
}

const stubs = {
  react: {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
  },
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: Symbol('Fragment') },
  'react-dom': {},
  'react-dom/client': {},
}

const factory = factories.get('dsh-agent-instructions-editor')
const exports = factory((id) => stubs[id] ?? {})

if (exports == null || typeof exports !== 'object') throw new Error('factory returned no exports')
if (typeof exports.apply !== 'function') throw new Error('exports.apply is not a function')
if (!Array.isArray(exports.inject)) throw new Error('exports.inject is not an array')

// Exercise the native settings registration without browser DOM or API access.
const registrations = new Map()
const cleanups = []
exports.apply({
  effect: (effect) => { cleanups.push(effect()) },
  locale: { register: () => () => {} },
  remote: { $on: () => () => {} },
  slots: {
    inject: (_name, callback) => { cleanups.push(callback()) },
    register: (spec, component) => {
      registrations.set(spec.name, { spec, component })
      return () => registrations.delete(spec.name)
    },
  },
})
const section = registrations.get('settings.section')
const icon = registrations.get('settings.section.icon')
assert.equal(section?.spec.id, 'agent-instructions-editor')
assert.equal(icon?.spec.id, section.spec.id, 'icon must match the host row-id filter')
const svg = icon.component({ size: 20, active: true })
assert.equal(svg.type, 'svg')
assert.equal(svg.props.width, 20)
assert.equal(svg.props.height, 20)
assert.equal(svg.props.stroke, 'currentColor')
assert.equal(icon.component({ size: 18, active: false }).props.width, 18)
for (const cleanup of cleanups.reverse()) cleanup?.()
assert.equal(registrations.size, 0, 'unloading must remove both settings registrations')

console.log('smoke-client: ok')
