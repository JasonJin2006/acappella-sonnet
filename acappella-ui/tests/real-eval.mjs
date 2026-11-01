// Accuracy evaluation on score-aligned real recordings.
//
// Input manifest (built by prep_csd.py):
// {
//   "pieces": [{
//     "id": "LocusIste", "score": "LocusIste.score.json",
//     "bpm": 72, "secPerBeat": 0.83,
//     "solos": [{ "part": 0, "path": "solo-S1.wav" }],
//     "mix": "mix-quartet.wav",
//     "full": "mix-full.wav"
//   }]
// }
//
// Audio is trimmed so that sample 0 is the first note of the piece, which
// makes beat = t / secPerBeat.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { readWav } from './wav.mjs'
import { analyzeFrames } from './analysis.mjs'
import { prepareScore, midiAt, midisAt, posAt, totalBeats } from './score.mjs'
import { Follower } from '../src/lib/follower.js'
import { ColdStartAligner } from '../src/lib/coldstart.js'
import { transcribe } from '../src/lib/hum.js'

const GATE_CLARITY = 0.55
const GATE_RMS = 0.0035

// Analysis is the expensive part; several metrics share the same file.
const cache = new Map()
function load(path) {
  if (!cache.has(path)) {
    const buf = readWav(path)
    cache.set(path, { buf, frames: analyzeFrames(buf) })
  }
  return cache.get(path)
}

function median(a) {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y)
  return s[s.length >> 1]
}

function pctl(a, p) {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

// Distance in semitones, octave-sensitive.
const semis = (a, b) => Math.abs(a - b)

// Only frames well inside a note are scored: 70 ms after the onset, 50 ms
// before the release. Boundary frames legitimately contain two notes.
function usableFrame(part, beat, spb) {
  const i = posAt(part, beat)
  if (i < 0) return -1
  const start = part.startBeats[i]
  const end = start + part.notes[i].beats
  if (beat - start < 0.07 / spb) return -1
  if (end - beat < 0.05 / spb) return -1
  return i
}

// Frame-level comparison against the dataset's own f0 annotation.
//
// The CSD .f0 files are TONY output that was manually corrected, one value per
// ~5.8 ms, 0 for unvoiced.  They are an independent reference: our detector
// never sees them.
function readF0(path) {
  const text = readFileSync(path, 'utf8').trim()
  const lines = text.split('\n')
  const t = new Float64Array(lines.length)
  const f = new Float64Array(lines.length)
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/)
    t[i] = +parts[0]
    f[i] = +parts[1]
  }
  return { t, f }
}

function evalF0(path, f0Path) {
  const { buf, frames } = load(path)
  const ref = readF0(f0Path)
  let j = 0
  let refVoiced = 0
  let hit = 0
  let oct = 0
  let gross = 0
  let miss = 0
  let falseVoiced = 0
  const cents = []
  for (const fr of frames) {
    while (j + 1 < ref.t.length && ref.t[j + 1] <= fr.t) j++
    if (Math.abs(ref.t[j] - fr.t) > 0.015) continue
    const hz = ref.f[j]
    const refMidi = hz > 0 ? 69 + 12 * Math.log2(hz / 440) : null
    const det = fr.midi != null && fr.clarity > GATE_CLARITY && fr.rms > GATE_RMS ? fr.midi : null
    if (refMidi == null) {
      if (det != null) falseVoiced++
      continue
    }
    refVoiced++
    if (det == null) { miss++; continue }
    const d = semis(det, refMidi)
    if (d <= 0.5) { hit++; cents.push((det - refMidi) * 100) }
    else if (d > 10.5 && d < 13.5) oct++
    else gross++
  }
  return {
    file: path.split(/[\\/]/).pop(),
    sec: +buf.duration.toFixed(1),
    refVoiced,
    hit,
    oct,
    gross,
    miss,
    falseVoiced,
    accurate: +(100 * hit / Math.max(1, refVoiced)).toFixed(1),
    octave: +(100 * oct / Math.max(1, refVoiced)).toFixed(1),
    grossPct: +(100 * gross / Math.max(1, refVoiced)).toFixed(1),
    missed: +(100 * miss / Math.max(1, refVoiced)).toFixed(1),
    centsMedianAbs: +median(cents.map(Math.abs)).toFixed(0),
    centsP90Abs: +pctl(cents.map(Math.abs), 0.9).toFixed(0),
    cents,
  }
}

function evalSolo(path, part, piece, score) {
  const { buf, frames } = load(path)
  const spb = piece.secPerBeat
  const t0 = piece.startSec || 0
  let refN = 0
  let hit = 0
  let oct = 0
  let gross = 0
  let miss = 0
  let falsePos = 0
  const cents = []
  const onsetHits = []
  for (const f of frames) {
    if (f.t < t0) continue
    const beat = (f.t - t0) / spb
    const i = usableFrame(part, beat, spb)
    if (i < 0) continue
    const ref = part.notes[i].midi
    const det = f.midi != null && f.clarity > GATE_CLARITY && f.rms > GATE_RMS ? f.midi : null
    if (ref == null) {
      if (det != null) falsePos++
      continue
    }
    refN++
    if (det == null) { miss++; continue }
    const d = semis(det, ref)
    if (d <= 0.5) {
      hit++
      cents.push((det - ref) * 100)
      const sinceOnset = (beat - part.startBeats[i]) * spb
      if (sinceOnset < 0.12) onsetHits.push(1)
    } else if (d > 10.5 && d < 13.5) oct++
    else gross++
  }
  const out = {
    part: part.name,
    seconds: +buf.duration.toFixed(1),
    refFrames: refN,
    accurate: +(100 * hit / Math.max(1, refN)).toFixed(1),
    octave: +(100 * oct / Math.max(1, refN)).toFixed(1),
    gross: +(100 * gross / Math.max(1, refN)).toFixed(1),
    missed: +(100 * miss / Math.max(1, refN)).toFixed(1),
    falseVoiced: falsePos,
    centsMedianAbs: +median(cents.map(Math.abs)).toFixed(0),
    centsP90Abs: +pctl(cents.map(Math.abs), 0.9).toFixed(0),
    onsetFrames: onsetHits.length,
  }
  return out
}

function evalEnsemble(path, piece, score) {
  const { buf, frames } = load(path)
  const spb = piece.secPerBeat
  const t0 = piece.startSec || 0
  const perPart = score.parts.map(() => ({ ref: 0, hit: 0, octave: 0 }))
  let refTotal = 0
  let hitTotal = 0
  let detTotal = 0
  let detMatched = 0
  let octaveSubs = 0
  let voiceFrames = 0
  const TOL = 2.5   // same tolerance pickForPart() uses
  for (const f of frames) {
    if (f.t < t0) continue
    const beat = (f.t - t0) / spb
    const refs = []
    for (let pi = 0; pi < score.parts.length; pi++) {
      const m = midiAt(score.parts[pi], beat)
      if (m != null) { refs.push({ pi, midi: m }); perPart[pi].ref++ }
    }
    const det = f.voiced ? f.midis : []
    if (det.length) voiceFrames++
    detTotal += det.length
    refTotal += refs.length
    // Per-part claim, the way the engine does it: each part independently
    // looks for a detection near its own note (exact first, octave second).
    // Detections are not exclusive between parts, so unison is not punished.
    for (const r of refs) {
      let exact = false
      let oct = false
      for (const m of det) {
        const d = semis(m, r.midi)
        if (d <= TOL) { exact = true; break }
        let dd = m - r.midi
        while (dd > 6) dd -= 12
        while (dd < -6) dd += 12
        if (Math.abs(dd) <= TOL) oct = true
      }
      if (exact) { hitTotal++; perPart[r.pi].hit++ }
      else if (oct) { perPart[r.pi].octave++; octaveSubs++ }
    }
    // Precision: a detection counts as correct if it is near any actual note.
    for (const m of det) {
      let ok = false
      for (const r of refs) {
        if (semis(m, r.midi) <= TOL) { ok = true; break }
      }
      if (ok) detMatched++
    }
  }
  const recall = hitTotal / Math.max(1, refTotal)
  const precision = detMatched / Math.max(1, detTotal)
  return {
    seconds: +buf.duration.toFixed(1),
    recall: +(100 * recall).toFixed(1),
    precision: +(100 * precision).toFixed(1),
    f1: +(200 * recall * precision / Math.max(1e-9, recall + precision)).toFixed(1),
    octaveSubs,
    voicesPerVoicedFrame: +(detTotal / Math.max(1, voiceFrames)).toFixed(2),
    parts: score.parts.map((p, i) => ({
      name: p.name,
      recall: +(100 * perPart[i].hit / Math.max(1, perPart[i].ref)).toFixed(1),
      octaveOnly: +(100 * perPart[i].octave / Math.max(1, perPart[i].ref)).toFixed(1),
    })),
  }
}

function evalFollowSolo(path, part, piece) {
  const { buf, frames } = load(path)
  const spb = piece.secPerBeat
  const t0 = piece.startSec || 0
  const fl = new Follower(part.notes, { bpm: 60 / spb })
  let prev = null
  let silent = 0
  let errSum = 0
  let n = 0
  let exact = 0
  let within1 = 0
  let beatErrSum = 0
  let beatWithin1 = 0
  const beatErrs = []
  let back = 0
  let lastPos = 0
  for (const f of frames) {
    if (f.t < t0) continue
    const beat = (f.t - t0) / spb
    const truth = posAt(part, beat)
    const det = f.midi != null && f.clarity > GATE_CLARITY && f.rms > GATE_RMS ? f.midi : null
    const voiced = det != null
    let onset = 0
    if (voiced && (prev == null || Math.abs(det - prev) > 0.6 || silent > 0.15)) onset = 2
    silent = voiced ? 0 : silent + 1 / 30
    prev = det
    fl.push(
      { midi: det, clarity: det != null ? 0.85 : 0, voiced },
      1 / 30,
      onset,
      { lo: fl.pos - 1, hi: fl.pos + 3 }
    )
    if (truth < 0) continue
    const err = Math.abs(fl.pos - truth)
    // Position error in beats: distance from the current beat to the span of
    // the note the follower is on.  Zero while the cursor sits inside the
    // right note, which is what the UI shows.
    const sp = part.startBeats[fl.pos]
    const ep = sp + part.notes[fl.pos].beats
    const beatErr = beat < sp ? sp - beat : beat > ep ? beat - ep : 0
    errSum += err
    beatErrSum += beatErr
    beatErrs.push(beatErr)
    n++
    if (err === 0) exact++
    if (err <= 1) within1++
    if (beatErr <= 1) beatWithin1++
    if (fl.pos < lastPos - 1) back++
    lastPos = fl.pos
  }
  return {
    part: part.name,
    frames: n,
    exact: +(100 * exact / Math.max(1, n)).toFixed(1),
    within1: +(100 * within1 / Math.max(1, n)).toFixed(1),
    mae: +(errSum / Math.max(1, n)).toFixed(2),
    beatMae: +(beatErrSum / Math.max(1, n)).toFixed(2),
    beatP90: +pctl(beatErrs, 0.9).toFixed(2),
    beatWithin1: +(100 * beatWithin1 / Math.max(1, n)).toFixed(1),
    backJumps: back,
  }
}

function evalColdStart(path, piece, score, opts = {}) {
  const { buf, frames } = load(path)
  const spb = piece.secPerBeat
  const t0 = piece.startSec || 0
  const windowSec = opts.windowSec || 3.0
  const results = []
  for (const atSec of opts.times || [0, 20, 40, 60]) {
    const a = new ColdStartAligner(score.parts, { bpm: 60 / spb })
    const start = Math.round((t0 + atSec) * 30)
    for (let i = start; i < frames.length && (i - start) / 30 < windowSec; i++) {
      const f = frames[i]
      a.add(1 / 30, f.voiced ? f.midis : null, f.maxHarm)
    }
    const truthBeat = atSec / spb
    const prior = opts.prior != null ? (typeof opts.prior === 'function' ? opts.prior(atSec, truthBeat) : opts.prior) : truthBeat
    const s = a.solveIfReady(prior, windowSec - 0.05, [1.0], 0)
    results.push({
      atSec: +atSec.toFixed(1),
      truthBeat: +truthBeat.toFixed(1),
      beat: s ? +s.startBeat.toFixed(1) : null,
      errBeats: s ? +(s.startBeat - truthBeat).toFixed(1) : null,
      score: s ? +s.score.toFixed(2) : null,
      margin: s ? +s.margin.toFixed(2) : null,
      viaAll: s ? !!s.viaAll : null,
    })
  }
  return results
}

function evalTranscribe(path, part, piece) {
  const t0 = piece.startSec || 0
  const frames = load(path).frames.filter((f) => f.t >= t0)
  const res = transcribe(frames, 60 / piece.secPerBeat, { free: true })
  // transcribe() returns sequential notes (no absolute start), with t0 at the
  // first detected note.  Rebuild cumulative onsets so both sides start at 0.
  let acc = 0
  const out = res.notes.map((n) => {
    const start = acc
    acc += n.beats
    return { ...n, start }
  })
  const truth = []
  for (let i = 0; i < part.notes.length; i++) {
    if (part.notes[i].midi != null) truth.push({ beat: part.startBeats[i], midi: part.notes[i].midi })
  }
  const origin = truth.length ? truth[0].beat : 0
  let hit = 0
  const used = new Array(truth.length).fill(false)
  for (const n of out) {
    let bi = -1
    let bd = 0.12 / piece.secPerBeat
    for (let i = 0; i < truth.length; i++) {
      if (used[i]) continue
      const d = Math.abs(truth[i].beat - origin - n.start)
      if (d < bd) { bd = d; bi = i }
    }
    if (bi >= 0 && Math.abs(truth[bi].midi - n.midi) <= 0.5) { used[bi] = true; hit++ }
  }
  const precision = hit / Math.max(1, out.length)
  const recall = hit / Math.max(1, truth.length)
  return {
    part: part.name,
    truthNotes: truth.length,
    outNotes: out.length,
    precision: +(100 * precision).toFixed(1),
    recall: +(100 * recall).toFixed(1),
    f1: +(200 * precision * recall / Math.max(1e-9, precision + recall)).toFixed(1),
  }
}

function aggregateF0(rows) {
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0)
  const ref = sum('refVoiced')
  const cents = rows.flatMap((r) => r.cents || [])
  return {
    singers: rows.length,
    refFrames: ref,
    accurate: +(100 * sum('hit') / Math.max(1, ref)).toFixed(1),
    octave: +(100 * sum('oct') / Math.max(1, ref)).toFixed(1),
    gross: +(100 * sum('gross') / Math.max(1, ref)).toFixed(1),
    missed: +(100 * sum('miss') / Math.max(1, ref)).toFixed(1),
    falseVoiced: sum('falseVoiced'),
    centsMedianAbs: +median(cents.map(Math.abs)).toFixed(0),
    centsP90Abs: +pctl(cents.map(Math.abs), 0.9).toFixed(0),
  }
}

function main() {
  const manifestPath = resolve(process.argv[2])
  const root = dirname(manifestPath)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const only = process.argv[3]
  const all = []
  for (const piece of manifest.pieces) {
    if (only && piece.id !== only) continue
    const scoreRaw = JSON.parse(readFileSync(resolve(root, piece.score), 'utf8'))
    const score = prepareScore(scoreRaw.parts, piece.bpm || 96, piece.bar || 4)
    console.log(`\n=== ${piece.id} ${piece.title || ''}  bpm ${piece.bpm}  ` +
      `spb ${piece.secPerBeat.toFixed(3)}  beats ${totalBeats(score).toFixed(0)} ===`)
    const record = { id: piece.id }

    if (piece.solos) {
      const rows = piece.solos.map((s) => ({
        ...evalF0(resolve(root, s.path), resolve(root, s.f0)),
        part: s.part,
      }))
      record.f0 = rows.map(({ cents, ...r }) => r)
      const sections = ['S', 'A', 'T', 'B']
      for (let pi = 0; pi < score.parts.length; pi++) {
        const sub = rows.filter((r) => r.part === pi)
        if (!sub.length) continue
        const a = aggregateF0(sub)
        console.log(`  ${sections[pi] || pi}  acc ${String(a.accurate).padStart(5)}%  ` +
          `oct ${String(a.octave).padStart(4)}%  gross ${String(a.gross).padStart(4)}%  ` +
          `miss ${String(a.missed).padStart(4)}%  false ${a.falseVoiced}  ` +
          `cents med ${a.centsMedianAbs} p90 ${a.centsP90Abs}`)
      }
    }
    if (piece.mix) {
      const e = evalEnsemble(resolve(root, piece.mix), piece, score)
      record.ensemble = e
      console.log('  ensemble: ' + JSON.stringify(e))
      if (piece.follow) {
        const fs = piece.follow.map((f) => evalFollowSolo(resolve(root, f.path), score.parts[f.part], piece))
        record.follow = fs
        for (const r of fs) console.log('  follow ' + JSON.stringify(r))
      }
      const cs = evalColdStart(resolve(root, piece.mix), piece, score, {
        times: piece.coldTimes || [10, 30, 50],
      })
      record.cold = cs
      for (const r of cs) console.log('  cold ' + JSON.stringify(r))
    }
    if (piece.transcribe) {
      const tr = piece.transcribe.map((t) => evalTranscribe(resolve(root, t.path), score.parts[t.part], piece))
      record.transcribe = tr
      for (const r of tr) console.log('  transcribe ' + JSON.stringify(r))
    }
    all.push(record)
    cache.clear()
  }
  const out = resolve(root, 'csd-results.json')
  writeFileSync(out, JSON.stringify(all, null, 2))
  console.log('\nwrote', out)
}

main()
