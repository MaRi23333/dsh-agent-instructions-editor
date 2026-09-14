// Post-build smoke: the built host entry must expose the plugin surface.
const mod = await import('../lib/index.js')

if (mod.name !== 'agent-instructions-editor') throw new Error(`bad name: ${String(mod.name)}`)
if (typeof mod.apply !== 'function') throw new Error('apply is not a function')
if (mod.Config == null) throw new Error('Config is missing')

console.log('smoke-host: ok')
