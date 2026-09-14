// Post-build smoke: the client bundle must self-register under its package
// name and its factory must produce exports with apply/inject.
import { createRequire } from 'node:module'

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
  'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') },
  'react-dom': {},
  'react-dom/client': {},
}

const factory = factories.get('dsh-agent-instructions-editor')
const exports = factory((id) => stubs[id] ?? {})

if (exports == null || typeof exports !== 'object') throw new Error('factory returned no exports')
if (typeof exports.apply !== 'function') throw new Error('exports.apply is not a function')
if (!Array.isArray(exports.inject)) throw new Error('exports.inject is not an array')

console.log('smoke-client: ok')
