// Unit probe for the pitch floor at different sample rates.
// A 2048-sample YIN window only reaches down to sr/1024 Hz, so at 96 kHz
// nothing below 93.8 Hz is measurable; yinWindowSize() scales the window to
// keep the same musical range at every rate.
import { YinDetector, yinWindowSize } from '../src/lib/pitch.js'

const SR = [44100, 48000, 96000, 192000]
const FREQ = [65.41, 82.41, 98.0, 130.81] // C2 E2 G2 C3

function probe(sr, size, f) {
  const det = new YinDetector(sr, size)
  const b = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    const t = i / sr
    b[i] = 0.5 * Math.sin(2 * Math.PI * f * t) +
      0.25 * Math.sin(4 * Math.PI * f * t) + 0.12 * Math.sin(6 * Math.PI * f * t)
  }
  const r = det.detect(b)
  return r.freq ? r.freq.toFixed(1) : 'none'
}

for (const sr of SR) {
  const adaptive = yinWindowSize(sr)
  const old = FREQ.map((f) => probe(sr, 2048, f)).join(' ')
  const fixed = FREQ.map((f) => probe(sr, adaptive, f)).join(' ')
  console.log(`${String(sr).padStart(6)} Hz  N=2048: ${old.padEnd(28)} ` +
    `N=${String(adaptive).padStart(4)}: ${fixed}`)
}
