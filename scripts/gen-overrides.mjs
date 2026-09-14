/**
 * One-shot: emit a pnpm overrides block pinning every transitively referenced
 * @deepseek-ai/dsh-* package — 0.1.2-rc.1 where published, otherwise the
 * highest 0.1.x (the inline-refactor packages that stopped at 0.1.1-rc.2).
 * Run: node scripts/gen-overrides.mjs
 */
const names = 'agent-default-model agent-presets attachment brand client-runtime code-runtime cordis-host-runner credentials deque file-reference goal host-apiproxy host-directory-picker host-plugin-inventory invariants llm-retry message-feedback native-command sandbox sandbox-policy scope session-persistence session-projection session-projection-cache session-title skill storage storage-domain system-prompt timeout tool-todo typert-protocol typert-registry user-approval user-questions util-crypto util-values util-time'.split(' ')

const lines = []
for (const n of names) {
  const name = `@deepseek-ai/dsh-${n}`
  const url = 'https://registry.npmjs.org/' + encodeURIComponent(name).replace('%40', '@').replace('%2F', '/')
  const r = await fetch(url)
  if (!r.ok) { console.error('NO PACKUMENT', name); continue }
  const doc = await r.json()
  const vs = Object.keys(doc.versions)
  const pin = vs.includes('0.1.2-rc.1') ? '0.1.2-rc.1' : vs.filter((v) => v.startsWith('0.1.')).sort().pop()
  lines.push(`  '${name}': ${pin}`)
}
console.log(lines.sort().join('\n'))
