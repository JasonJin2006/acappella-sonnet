#!/usr/bin/env node
// Validate a sonnet pack before importing it in the app.
// Usage: node scripts/check_pack.mjs <pack.json>
import fs from 'node:fs'
import { parsePack } from '../src/lib/pack.js'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/check_pack.mjs <pack.json>')
  process.exit(1)
}

const raw = fs.readFileSync(file, 'utf8')
const pack = parsePack(raw)
const bytes = Buffer.byteLength(raw)

let minNote = Infinity
let maxNote = -Infinity
let badBeat = 0
const barCount = {}
const partCount = {}

for (const s of pack.songs) {
  const totals = s.parts.map((p) => p.notes.reduce((sum, n) => sum + n.beats, 0))
  if (Math.max(...totals) - Math.min(...totals) > 1e-6) badBeat++
  barCount[s.bar] = (barCount[s.bar] || 0) + 1
  partCount[s.parts.length] = (partCount[s.parts.length] || 0) + 1
  for (const p of s.parts) {
    for (const n of p.notes) {
      if (n.midi == null) continue
      if (n.midi < minNote) minNote = n.midi
      if (n.midi > maxNote) maxNote = n.midi
    }
  }
}

const summary = {
  name: pack.name || '(unnamed)',
  songs: pack.songs.length,
  skipped: pack.skipped,
  sizeMB: +(bytes / 1048576).toFixed(2),
  parts: partCount,
  bars: barCount,
  midiRange: [minNote, maxNote],
  partLengthMismatch: badBeat,
  source: pack.source,
  license: pack.license,
}
console.log(JSON.stringify(summary, null, 2))

if (badBeat) {
  console.error(`${badBeat} songs have parts of different length`)
  process.exit(1)
}
