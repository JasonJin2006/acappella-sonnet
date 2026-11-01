#!/usr/bin/env node
// Stage 2 of the import-pack pipeline: melodies.json -> sonnet pack.
//
// Each melody is handed to the project's own arranger, so the generated parts
// behave exactly like the built-in practice arrangements. The output is a plain
// JSON file that the app can ingest in one go.
import fs from 'node:fs'
import path from 'node:path'
import { arrange, defaultPlan, measureCount, rankKeys } from '../src/lib/arranger.js'
const MIN_BARS = 6
const MAX_BARS = 140
// Keep the soprano line singable. The arranger only transposes by one octave, so
// check the result instead of trying to out-guess it.
const SOPRANO_LO = 50
const SOPRANO_HI = 86
const MAX_SPREAD = 24

function sopranoFits(notes) {
  const ps = notes.filter((n) => n.midi != null).map((n) => n.midi)
  if (!ps.length) return false
  const lo = Math.min(...ps)
  const hi = Math.max(...ps)
  return lo >= SOPRANO_LO && hi <= SOPRANO_HI && hi - lo <= MAX_SPREAD
}

function argOf(name, fallback) {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const inPath = argOf('--in')
const outPath = argOf('--out')
const packName = argOf('--name', '导入包')
const source = argOf('--source', '')
const license = argOf('--license', '')
const note = argOf('--note', '')
// block: one chord per melody note, steady and easy to follow (art songs).
// plan: the app's default mix of solo, thirds, pad, vamp and bell (pop material).
const textures = argOf('--textures', 'block')
const indexOut = argOf('--index', '')

if (!inPath || !outPath) {
  console.error('usage: node scripts/build_pack.mjs --in melodies.json --out pack.json')
  process.exit(1)
}

const entries = JSON.parse(fs.readFileSync(inPath, 'utf8'))

// The key signature tells us the tonic; only the major/minor reading is
// ambiguous, so pick the better of the two relative candidates.
function pickKey(melody, fifths) {
  const major = ((Number(fifths || 0) * 7) % 12 + 12) % 12
  const cands = [
    { tonic: major, minor: false },
    { tonic: (major + 9) % 12, minor: true },
  ]
  const ranked = rankKeys(melody)
  const scoreOf = (k) => {
    const hit = ranked.find((r) => r.tonic === k.tonic && r.minor === k.minor)
    return hit ? hit.score : -Infinity
  }
  return cands.sort((a, b) => scoreOf(b) - scoreOf(a))[0]
}

function shortComposer(name) {
  let s = String(name || '').trim()
  if (!s) return ''
  if (s.includes(',')) s = s.split(',')[0]
  // source metadata leaves quotes, brackets and life dates behind: strip them
  s = s.split(/[([{]/)[0]
  s = s.replace(/["'“”‘’()\[\]{}]/g, '').replace(/\s+/g, ' ').trim()
  if (/folk ?song|traditional|anon/i.test(s)) return '民歌'
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(s)) return ''
  return s
}

// Sibelius exports often arrive in caps with embedded newlines.
function tidyTitle(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!s) return '未命名'
  if (s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/(^|[\s(\[-])([a-z])/g, (m, p, c) => p + c.toUpperCase())
  }
  return s
}

const songs = []
const dropped = {}
const seen = new Set()

for (const e of entries) {
  const melody = e.melody.map(([midi, beats]) => ({ midi, beats }))
  const bar = e.bar
  const bars = measureCount(melody, bar)
  if (bars < MIN_BARS || bars > MAX_BARS || bar < 2) {
    dropped.length = (dropped.length || 0) + 1
    continue
  }
  let res
  try {
    // Art songs are mostly homophonic material; a steady block texture keeps the
    // result predictable for rehearsal, while defaultPlan's vamp/bell figures
    // sound out of place against long lyrical phrases.
    const plan = textures === 'plan' ? defaultPlan(bars) : Array(bars).fill('block')
    res = arrange(melody, { bar, textures: plan, key: pickKey(melody, e.fifths) })
  } catch (err) {
    dropped.arrange = (dropped.arrange || 0) + 1
    continue
  }
  const total = melody.reduce((s, n) => s + n.beats, 0)
  const bad = res.parts.some((p) => Math.abs(p.notes.reduce((s, n) => s + n.beats, 0) - total) > 1e-6)
  if (bad) {
    dropped.mismatch = (dropped.mismatch || 0) + 1
    continue
  }
  if (!sopranoFits(res.parts[0].notes)) {
    dropped.range = (dropped.range || 0) + 1
    continue
  }

  const composer = shortComposer(e.composer)
  const songTitle = tidyTitle(e.title)
  let title = composer ? `${songTitle}（${composer}）` : songTitle
  if (seen.has(title)) {
    let k = 2
    while (seen.has(`${title} ${k}`)) k++
    title = `${title} ${k}`
  }
  seen.add(title)

  songs.push({
    title,
    // keep practising tempo in a range a choir can actually follow
    bpm: Math.min(200, Math.max(50, e.bpm)),
    bar,
    parts: res.parts.map((p) => ({
      id: p.id,
      notes: p.notes.map((n) => [n.midi == null ? null : Math.round(n.midi), Math.round(n.beats * 4) / 4]),
    })),
  })
}

const pack = {
  format: 'sonnet-pack',
  version: 1,
  name: packName,
  createdAt: new Date().toISOString().slice(0, 10),
  source,
  license,
  note,
  count: songs.length,
  songs,
}

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(pack), 'utf8')

if (indexOut) {
  const byComposer = new Map()
  for (const s of songs) {
    const m = /（([^（）]+)）\s*\d*$/.exec(s.title)
    const c = m ? m[1] : '未标注'
    if (!byComposer.has(c)) byComposer.set(c, [])
    byComposer.get(c).push(s.title)
  }
  const lines = [`# ${packName}`, '', `共 ${songs.length} 首`, '']
  for (const [c, titles] of [...byComposer.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))) {
    lines.push(`## ${c}（${titles.length}）`, '')
    for (const t of titles) lines.push(`- ${t}`)
    lines.push('')
  }
  fs.writeFileSync(indexOut, lines.join('\n'), 'utf8')
}

const bytes = fs.statSync(outPath).size
console.log(`pack: ${songs.length} songs, ${(bytes / 1048576).toFixed(2)} MB -> ${outPath}`)
for (const [why, n] of Object.entries(dropped)) console.log(`  dropped ${n}: ${why}`)
console.log(`  avg bars: ${(songs.reduce((s, x) => s + measureCount(x.parts[0].notes.map(([m, b]) => ({ midi: m, beats: b })), x.bar), 0) / Math.max(1, songs.length)).toFixed(1)}`)
