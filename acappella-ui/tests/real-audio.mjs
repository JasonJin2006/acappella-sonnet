// Real-audio regression harness.
//
// Runs the app's own analysis modules (YIN, MultiPitch, harmonicity gate,
// EnsembleFollower, ColdStartAligner, transcribe) over recordings that were
// not synthesized here.  Two modes:
//
//   node tests/real-audio.mjs scan <manifest.json>
//       descriptive statistics on unannotated recordings
//   node tests/real-audio.mjs csd <csd-manifest.json>
//       accuracy against score-aligned choir recordings
//
// The point of the scan mode is to catch behaviour that clean synthetic
// signals never trigger: octave flapping, phantom voices on instruments,
// pitch jumping between parts.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { readWav } from './wav.mjs'
import { analyzeFrames, rmsOf } from './analysis.mjs'
import { transcribe } from '../src/lib/hum.js'

function pct(x, n) {
  return n ? (100 * x / n).toFixed(1) + '%' : '—'
}

function median(a) {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y)
  return s[s.length >> 1]
}

function pcHist(midis) {
  const h = new Array(12).fill(0)
  for (const m of midis) h[((Math.round(m) % 12) + 12) % 12]++
  return h
}

function scanFile(path) {
  const buf = readWav(path)
  const frames = analyzeFrames(buf, { fps: 30, fftSize: 4096, maxVoices: 6 })
  const voiced = frames.filter((f) => f.voiced)
  const midis = voiced.flatMap((f) => f.midis)
  const voices = voiced.map((f) => f.midis.length)

  // Octave flapping: pitch moves by roughly an octave between neighbouring frames.
  let oct = 0
  let steps = 0
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].f0s[0]
    const b = frames[i].f0s[0]
    if (!a || !b) continue
    steps++
    const d = Math.abs(b.midi - a.midi)
    if (d > 10.5 && d < 13.5) oct++
  }

  const h = pcHist(midis)
  const top = Math.max(...h)
  const conc = midis.length ? top / midis.length : 0
  const clarity = frames.map((f) => f.clarity)

  const notes = transcribe(frames, 100)
  const durs = notes.notes.map((n) => (n.beats * 60) / 100)

  return {
    file: path.split(/[\\/]/).pop(),
    sec: +buf.duration.toFixed(1),
    frames: frames.length,
    voicedPct: +(100 * voiced.length / frames.length).toFixed(1),
    voicesAvg: +(voices.reduce((a, b) => a + b, 0) / Math.max(1, voices.length)).toFixed(2),
    voicesMax: Math.max(0, ...voices),
    octaveJumpPct: +(100 * oct / Math.max(1, steps)).toFixed(1),
    topPitchClassPct: +(100 * conc).toFixed(1),
    clarityMedian: +median(clarity).toFixed(2),
    clarityP10: +[...clarity].sort((a, b) => a - b)[Math.floor(clarity.length * 0.1)].toFixed(2),
    notes: notes.notes.length,
    noteDurMedian: +median(durs).toFixed(2),
    rms: +rmsOf(buf).toFixed(3),
  }
}

function printTable(rows) {
  const cols = [
    ['file', 'file', 24],
    ['sec', 'sec', 6],
    ['voicedPct', 'voiced%', 8],
    ['voicesAvg', 'voices', 7],
    ['octaveJumpPct', 'octJump%', 9],
    ['topPitchClassPct', 'topPC%', 7],
    ['clarityMedian', 'clar', 5],
    ['notes', 'notes', 6],
    ['noteDurMedian', 'dur', 5],
  ]
  const head = cols.map(([, label, w]) => label.padEnd(w)).join('')
  console.log(head)
  console.log('-'.repeat(head.length))
  for (const r of rows) {
    console.log(cols.map(([k, , w]) => String(r[k]).padEnd(w)).join(''))
  }
}

function main() {
  const [mode, manifestArg] = process.argv.slice(2)
  if (!mode) {
    console.error('usage: node tests/real-audio.mjs scan|csd <manifest.json>')
    process.exit(2)
  }
  const manifestPath = resolve(manifestArg)
  const root = dirname(manifestPath)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  const rows = []
  for (const item of manifest.clips) {
    const path = resolve(root, item.path)
    try {
      const r = scanFile(path)
      r.kind = item.kind || ''
      rows.push(r)
    } catch (e) {
      console.error(`! ${item.path}: ${e.message}`)
    }
  }
  printTable(rows)
  const out = resolve(root, 'scan-results.json')
  console.log('\nwrote', out)
  writeFileSync(out, JSON.stringify(rows, null, 2))
}

main()
