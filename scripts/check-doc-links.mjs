// Checks that every relative link, image and #anchor in a Markdown file resolves (#132).
// Anchors follow GitHub's heading slugs. External (http/https/mailto) links are not fetched.
// Run: node scripts/check-doc-links.mjs [README.md ...]
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')

/** GitHub slugs of a file's headings (outside code fences), with -1, -2… for repeats. */
function anchors(text) {
  const seen = new Map()
  const out = new Set()
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const m = !fenced && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const base = slug(m[1])
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.add(n === 0 ? base : `${base}-${n}`)
  }
  return out
}

/** Link targets: Markdown `](target)` and HTML `src=`/`href=`, outside code fences. */
function targets(text) {
  const prose = text.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1/gm, '')
  const found = []
  for (const m of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) found.push(m[1])
  for (const m of prose.matchAll(/\b(?:src|href)="([^"]+)"/g)) found.push(m[1])
  return found
}

let failures = 0
for (const file of process.argv.slice(2).length ? process.argv.slice(2) : ['README.md']) {
  const path = resolve(file)
  const text = readFileSync(path, 'utf8')
  const own = anchors(text)
  let checked = 0
  for (const target of targets(text)) {
    if (/^(https?:|mailto:)/.test(target)) continue
    checked++
    const [rel, hash] = target.split('#')
    const dest = rel ? resolve(dirname(path), decodeURIComponent(rel)) : path
    if (!existsSync(dest)) {
      console.error(`${file}: missing file ${target}`)
      failures++
    } else if (hash !== undefined && dest.endsWith('.md') && !(rel ? anchors(readFileSync(dest, 'utf8')) : own).has(hash)) {
      console.error(`${file}: missing anchor ${target}`)
      failures++
    }
  }
  console.log(`${file}: ${checked} relative links checked`)
}
process.exit(failures ? 1 : 0)
