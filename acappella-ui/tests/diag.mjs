// Diagnoses one track against its .f0 annotation: time base, voiced rate,
// and a few sample comparisons.
import { readFileSync } from 'node:fs'
import { readWav } from './wav.mjs'
import { framesFromBuffer } from '../src/lib/hum.js'

const [wavPath, f0Path] = process.argv.slice(2)
const buf = readWav(wavPath)
const frames = framesFromBuffer(buf, 1000 / 30)
const voiced = frames.filter((f) => f.midi != null && f.clarity > 0.55 && f.rms > 0.0035)
console.log('wav', buf.duration.toFixed(2), 's', buf.sampleRate, 'Hz')
console.log('frames', frames.length, 'gated voiced', voiced.length,
  `${(100 * voiced.length / frames.length).toFixed(1)}%`,
  'clarity p50/p90', frames.map((f) => f.clarity).sort((a, b) => a - b)[Math.floor(frames.length / 2)],
  frames.map((f) => f.clarity).sort((a, b) => a - b)[Math.floor(frames.length * 0.9)])

const lines = readFileSync(f0Path, 'utf8').trim().split('\n')
const t = []
const f = []
for (const line of lines) {
  const [a, b] = line.trim().split(/\s+/)
  t.push(+a)
  f.push(+b)
}
const nz = f.filter((x) => x > 0).length
let first = -1
for (let i = 0; i < f.length; i++) if (f[i] > 0) { first = i; break }
console.log('f0 rows', f.length, 'range', t[0].toFixed(3), '-', t[t.length - 1].toFixed(3),
  'voiced', `${(100 * nz / f.length).toFixed(1)}%`, 'first voiced at', first >= 0 ? t[first].toFixed(3) : '-')

// nearest reference for a few detected frames
let shown = 0
for (const fr of frames) {
  if (fr.midi == null || fr.clarity < 0.55) continue
  let j = 0
  while (j + 1 < t.length && t[j + 1] <= fr.t) j++
  if (Math.abs(t[j] - fr.t) > 0.02) continue
  console.log(`  t ${fr.t.toFixed(2)}  det ${fr.midi.toFixed(2)}  ref ${f[j] > 0 ? (69 + 12 * Math.log2(f[j] / 440)).toFixed(2) : 'unvoiced'}  clarity ${fr.clarity.toFixed(2)}`)
  if (++shown >= 8) break
}
