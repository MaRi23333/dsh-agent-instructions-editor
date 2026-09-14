/**
 * Dependency-closure satisfiability check for the 0.1.2-rc.1 upgrade.
 * Walks the @deepseek-ai/* closure from the plugin's devDependencies and,
 * for every dependency range, checks whether any published version
 * satisfies it (npm ^-range semantics with prerelease rules).
 * Run: node scripts/check-upgrade-closure.mjs
 */
const REG = 'https://registry.npmjs.org'
const TARGET = '0.1.2-rc.1'
const FALLBACK = { '@deepseek-ai/dsh-client-runtime': '0.1.1-rc.2', '@deepseek-ai/dsh-host-apiproxy': '0.1.1-rc.2' }

/** Parse "0.1.2-rc.1" → [0,1,2,'rc',1]; prerelease components as comparable array. */
function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)
  if (!m) return null
  const pre = m[4]
    ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))
    : null
  return { maj: +m[1], min: +m[2], pat: +m[3], pre }
}
function cmpPrerelease(a, b) {
  if (a === null) return b === null ? 0 : 1 // no prerelease > prerelease
  if (b === null) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]; const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    return (typeof x === 'number') === (typeof y === 'number') ? (x < y ? -1 : 1) : (typeof x === 'number' ? -1 : 1)
  }
  return 0
}
function cmpVersions(a, b) {
  const p = parse(a); const q = parse(b)
  if (p.maj !== q.maj) return p.maj - q.maj
  if (p.min !== q.min) return p.min - q.min
  if (p.pat !== q.pat) return p.pat - q.pat
  return cmpPrerelease(p.pre, q.pre)
}
/** npm caret semantics incl. prerelease-same-tuple rule. */
function satisfiesCaret(version, range) {
  const m = /^\^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(range)
  if (!m) return version === range // exact or unsupported → literal match
  const v = parse(version); if (!v) return false
  const base = { maj: +m[1], min: +m[2], pat: +m[3], pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : null }
  // upper bound: next non-zero component (caret on 0.x.y)
  let upper
  if (base.maj > 0) upper = { maj: base.maj + 1, min: 0, pat: 0, pre: null }
  else if (base.min > 0) upper = { maj: 0, min: base.min + 1, pat: 0, pre: null }
  else upper = { maj: 0, min: base.min, pat: base.pat + 1, pre: null }
  const lowerOk = cmpVersions(version, `${base.maj}.${base.min}.${base.pat}${m[4] ? '-' + m[4] : ''}`) >= 0
  const upperOk = cmpVersions(version, `${upper.maj}.${upper.min}.${upper.pat}`) < 0
  // prerelease versions only allowed on the same [maj,min,pat] tuple as base when base has prerelease
  let preOk = true
  if (v.pre !== null) {
    if (base.pre === null) preOk = v.maj === upper.maj && v.min === upper.min && v.pat === upper.pat ? false : (v.maj === base.maj && v.min === base.min && v.pat === base.pat ? cmpPrerelease(v.pre, base.pre) >= 0 : false)
    else preOk = v.maj === base.maj && v.min === base.min && v.pat === base.pat && cmpPrerelease(v.pre, base.pre) >= 0
  }
  return lowerOk && upperOk && preOk
}

const packumentCache = new Map()
async function packument(name) {
  if (!packumentCache.has(name)) {
    const res = await fetch(`${REG}/${name.replace('/', '%2F')}`)
    if (!res.ok) throw new Error(`${name}: registry ${res.status}`)
    packumentCache.set(name, await res.json())
  }
  return packumentCache.get(name)
}

const rootPkg = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const queue = Object.keys(rootPkg.devDependencies)
  .filter((n) => n.startsWith('@deepseek-ai/'))
  .map((n) => [n, rootPkg.devDependencies[n] === '0.1.2-rc.1' && FALLBACK[n] ? FALLBACK[n] : rootPkg.devDependencies[n]])
const seen = new Map() // name → resolved version
const failures = []
const overrides = (await import('node:fs')).readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')

while (queue.length) {
  const [name, want] = queue.shift()
  if (seen.has(name)) continue
  const doc = await packument(name)
  const versions = Object.keys(doc.versions)
  let resolved = versions.filter((v) => satisfiesCaret(v, want)).sort(cmpVersions).pop()
  // pnpm override force-pins regardless of range
  const ov = new RegExp(`'${name.replace('/', '/')}':\\s*'([^']+)'`).exec(overrides)
  if (ov) resolved = versions.includes(ov[1]) ? ov[1] : null
  if (!resolved) { failures.push(`${name}: want '${want}' — nothing satisfiable; has ${versions.join(', ')}`); continue }
  seen.set(name, resolved)
  const deps = doc.versions[resolved].dependencies ?? {}
  for (const [dep, range] of Object.entries(deps)) {
    if (dep.startsWith('@deepseek-ai/')) queue.push([dep, range])
  }
}

console.log(`resolved ${seen.size} @deepseek-ai packages:`)
for (const [name, v] of [...seen].sort()) console.log(`  ${name.padEnd(44)} ${v}`)
if (failures.length) {
  console.error('\nUNSATISFIABLE RANGES:')
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log('\nclosure fully satisfiable')
