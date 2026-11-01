// Offline mirror of the engine's per-frame analysis.
//
// The engine reads AnalyserNode data at 30 fps: YIN on the first 2048 samples
// plus a 4096-point dB spectrum feeding MultiPitch and the harmonicity filter.
// AnalyserNode is browser-only, so here the same numbers are produced with the
// project's own FFT and the same Blackman window the browser applies.
import { magnitudeSpectrum } from '../src/lib/fft.js'
import { MultiPitch, fftSizeFor } from '../src/lib/multipitch.js'
import { YinDetector, yinWindowSize } from '../src/lib/pitch.js'

const blackman = (i, n) =>
  0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1))

// Copy of Pilot._harmonicity (src/lib/engine.js:357).  Kept here so the
// harness measures the same gate the engine uses; sr is passed explicitly
// because there is no AudioContext.
export function harmonicity(db, f0, sr) {
  if (!db || !(f0 > 0)) return 0
  const binHz = (sr / 2) / db.length
  let sum = 0
  let cnt = 0
  let hit = 0
  for (let h = 1; h <= 5; h++) {
    const f = f0 * h
    if (f > sr * 0.45) break
    const b = Math.round(f / binHz)
    if (b < 3 || b >= db.length - 3) continue
    let peak = -Infinity
    for (let k = -1; k <= 1; k++) peak = Math.max(peak, db[b + k])
    const around = []
    for (let k = -16; k <= 16; k++) {
      if (Math.abs(k) <= 1) continue
      const idx = b + k
      if (idx < 0 || idx >= db.length) continue
      around.push(db[idx])
    }
    if (around.length && isFinite(peak)) {
      around.sort((x, y) => x - y)
      const base = around[around.length >> 1]
      const d = peak - base
      sum += d
      cnt++
      if (d >= 5) hit++
    }
  }
  if (hit < 3) return 0
  return cnt ? sum / cnt : 0
}

export function analyzeFrames(buffer, opts = {}) {
  const sr = buffer.sampleRate
  const data = buffer.getChannelData(0)
  const fps = opts.fps || 30
  const fftSize = opts.fftSize || fftSizeFor(sr)
  const yinSize = yinWindowSize(sr)
  const hop = Math.max(1, Math.round(sr / fps))
  const maxVoices = opts.maxVoices || 6
  const det = new YinDetector(sr, yinSize)
  const mp = new MultiPitch(sr, fftSize)
  const yinWin = new Float32Array(yinSize)
  const specWin = new Float32Array(fftSize)
  const db = new Float32Array(fftSize / 2 + 1)
  const frames = []
  let lastSolid = null
  let lastSolidAt = -Infinity
  for (let i = 0; i + fftSize <= data.length; i += hop) {
    yinWin.set(data.subarray(i, i + yinSize))
    const r = det.detect(yinWin)

    for (let k = 0; k < fftSize; k++) {
      const w = blackman(k, fftSize)
      specWin[k] = data[i + k] * w
    }
    const mag = magnitudeSpectrum(specWin, fftSize, () => 1)
    for (let k = 0; k < mag.length; k++) db[k] = 20 * Math.log10(mag[k] + 1e-9)
    const raw = mp.estimate(db, maxVoices)

    const solid = []
    let maxHarm = 0
    for (const f of raw) {
      const h = harmonicity(db, f.freq, sr)
      f.harm = h
      if (h > maxHarm) maxHarm = h
      if (h >= 7) solid.push(f)
    }
    // Same 220 ms memory as the engine: short dropouts keep the previous frame.
    let f0s
    const t = i / sr
    if (solid.length) {
      lastSolid = solid
      lastSolidAt = t
      f0s = solid
    } else if (lastSolid && t - lastSolidAt < 0.22) {
      f0s = lastSolid
    } else {
      f0s = []
    }
    const rms = r.rms
    const yinMidi = r.freq > 0 ? 69 + 12 * Math.log2(r.freq / 440) : null
    frames.push({
      t,
      midi: yinMidi,          // transcribe() reads this field
      yinMidi,
      clarity: r.clarity,
      rms,
      raw,
      f0s,
      maxHarm,
      voiced: f0s.length > 0 && rms > 0.006,
      midis: f0s.map((f) => f.midi),
    })
  }
  return frames
}

export function rmsOf(buffer) {
  const d = buffer.getChannelData(0)
  let s = 0
  for (let i = 0; i < d.length; i++) s += d[i] * d[i]
  return Math.sqrt(s / Math.max(1, d.length))
}
