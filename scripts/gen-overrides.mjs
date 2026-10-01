/**
 * One-shot: emit a pnpm overrides block pinning every transitively referenced
 * @deepseek-ai/dsh-* package — TARGET where published, otherwise the highest
 * non-alpha release (the inline-refactor packages that stopped publishing).
 * Run: node scripts/gen-overrides.mjs
 */
const TARGET = '0.2.0-rc.2'
const names = 'agent-default-model agent-presets attachment brand client-runtime code-runtime config-editor cordis-host-runner credentials deque file-reference goal host-apiproxy host-directory-picker host-plugin-inventory invariants llm-retry message-feedback native-command sandbox sandbox-policy scope session-persistence session-projection session-projection-cache session-title skill storage storage-domain system-prompt timeout tool-todo typert-protocol typert-registry user-approval user-questions util-crypto util-values util-time'.split(' ')

const lines = []
for (const n of names) {
  const name = `@deepseek-ai/dsh-${n}`
  const url = 'https://registry.npmjs.org/' + encodeURIComponent(name).replace('%40', '@').replace('%2F', '/')
  const r = await fetch(url)
  if (!r.ok) { console.error('NO PACKUMENT', name); continue }
  const doc = await r.json()
  const vs = Object.keys(doc.versions)
  const stable = vs.filter((v) => !v.includes('alpha'))
  const pin = vs.includes(TARGET) ? TARGET : (stable.sort().pop() ?? vs.sort().pop())
  lines.push(`  '${name}': ${pin}`)
}
console.log(lines.sort().join('\n'))
