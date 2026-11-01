// Traces the follower position against the annotated note index, and shows
// why the cold-start aligner rejects a window.
import { readFileSync } from 'node:fs'
import { readWav } from './wav.mjs'
import { analyzeFrames } from './analysis.mjs'
import { prepareScore, posAt } from './score.mjs'
import { Follower } from '../src/lib/follower.js'
import { ColdStartAligner } from '../src/lib/coldstart.js'

const [manifestPath, pieceId, partArg, mode] = process.argv.slice(2)
const root = manifestPath.replace(/[\\/][^\\/]+$/, '')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const piece = manifest.pieces.find((p) => p.id === pieceId)
const scoreRaw = JSON.parse(readFileSync(`${root}/${piece.score}`, 'utf8'))
const score = prepareScore(scoreRaw.parts, piece.bpm, piece.bar)
const pi = Number(partArg || 0)
const part = score.parts[pi]
const t0 = piece.startSec || 0
const spb = piece.secPerBeat

const file = piece.follow.find((f) => f.part === pi).path
const buf = readWav(`${root}/${file}`)
const frames = analyzeFrames(buf)
console.log('file', file, 'duration', buf.duration.toFixed(1), 'notes', part.notes.length, 't0', t0)

if (mode === 'cold') {
  for (const at of [10, 30, 50]) {
    const a = new ColdStartAligner(score.parts, { bpm: 60 / spb })
    const start = Math.round((t0 + at) * 30)
    for (let i = start; i < frames.length && (i - start) / 30 < 3; i++) {
      const f = frames[i]
      a.add(1 / 30, f.voiced ? f.midis : null, f.maxHarm)
    }
    const s = a.solve([1.0], at / spb)
    console.log(`\nat ${at}s  dur ${a.dur.toFixed(2)} voiced ${a.voicedDur.toFixed(2)} ` +
      `peakRun ${a.peakRun.toFixed(2)} distinct ${a.distinct} maxHarm ${a.maxHarm.toFixed(1)}`)
    console.log('  solve:', s ? JSON.stringify({ startBeat: +s.startBeat.toFixed(1), beat: +s.beat.toFixed(1), tempo: s.tempo, oct: s.oct, score: +s.score.toFixed(2), margin: +s.margin.toFixed(2), viaAll: s.viaAll }) : null)
    console.log('  ready:', JSON.stringify(a.solveIfReady(at / spb, 3.0, [1.0], 0)))
  }
} else {
  const fl = new Follower(part.notes, { bpm: 60 / spb })
  let prev = null
  let silent = 0
  let nextPrint = 0
  const detail = mode === 'detail'
  const from = Number(process.argv[6] || 0)
  const to = Number(process.argv[7] || 1e9)
  for (const f of frames) {
    if (f.t < t0) continue
    const beat = (f.t - t0) / spb
    const det = f.midi != null && f.clarity > 0.55 && f.rms > 0.0035 ? f.midi : null
    const voiced = det != null
    let onset = 0
    if (voiced && (prev == null || Math.abs(det - prev) > 0.6 || silent > 0.15)) onset = 2
    silent = voiced ? 0 : silent + 1 / 30
    prev = det
    fl.push({ midi: det, clarity: det != null ? 0.85 : 0, voiced }, 1 / 30, onset, {
      lo: fl.pos - 1, hi: fl.pos + 3,
    })
    const tt = f.t - t0
    if (detail) {
      if (tt >= from && tt <= to && Math.round(tt * 30) % 6 === 0) {
        const truth = posAt(part, beat)
        console.log(`t ${tt.toFixed(1).padStart(5)}  b ${beat.toFixed(1).padStart(5)}  truth ${String(truth).padStart(3)}  ` +
          `pos ${String(fl.pos).padStart(3)}  m ${String(part.notes[fl.pos].midi).padStart(4)}  ` +
          `obs ${det == null ? '  - ' : det.toFixed(1)}  hold ${fl.hold[fl.pos].toFixed(2)}  ` +
          `mm ${fl.mismatchFrames}  vr ${fl.voicedRun}`)
      }
      continue
    }
    if (tt >= nextPrint) {
      const truth = posAt(part, beat)
      console.log(`t ${tt.toFixed(1).padStart(5)}  beat ${beat.toFixed(1).padStart(6)}  ` +
        `truth ${String(truth).padStart(3)}  pos ${String(fl.pos).padStart(3)}  ` +
        `note ${String(part.notes[fl.pos].midi)}  truthNote ${String(truth >= 0 ? part.notes[truth].midi : '-')}  ` +
        `obs ${det == null ? '-' : det.toFixed(1)}  hold ${fl.hold[fl.pos].toFixed(2)}`)
      nextPrint += 10
    }
  }
}
