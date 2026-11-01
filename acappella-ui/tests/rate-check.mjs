// Sample-rate sensitivity check: the same performance at 44.1 / 48 / 96 kHz
// must produce the same pitch decisions.  Android runs at 48 kHz, desktop
// browsers often at 44.1 kHz, so a rate-dependent result is a real bug.
import { readWav } from './wav.mjs'
import { analyzeFrames } from './analysis.mjs'

const files = process.argv.slice(2)
const runs = files.map((f) => {
  const buf = readWav(f)
  // Keep the FFT window near 93 ms, i.e. the same frequency resolution at
  // every rate (4096 @ 44.1 kHz, 8192 @ 96 kHz).
  const fftSize = 2 ** Math.round(Math.log2(buf.sampleRate * 0.0929))
  const frames = analyzeFrames(buf, { fftSize })
  const voiced = frames.filter((x) => x.voiced)
  const midis = voiced.flatMap((x) => x.midis)
  const h = new Array(12).fill(0)
  for (const m of midis) h[((Math.round(m) % 12) + 12) % 12]++
  return {
    name: f.split(/[\\/]/).pop(),
    sr: buf.sampleRate,
    frames: frames.length,
    voicedPct: +(100 * voiced.length / frames.length).toFixed(1),
    meanVoices: +(voiced.reduce((a, x) => a + x.midis.length, 0) / Math.max(1, voiced.length)).toFixed(3),
    meanMidi: +(midis.reduce((a, b) => a + b, 0) / Math.max(1, midis.length)).toFixed(3),
    topPC: +(100 * Math.max(...h) / Math.max(1, midis.length)).toFixed(1),
    contour: frames.map((x) => x.f0s[0] ? x.f0s[0].midi : null),
  }
})

for (const r of runs) {
  console.log(`${r.name.padEnd(24)} ${r.sr} Hz  frames ${r.frames}  voiced ${r.voicedPct}%  ` +
    `voices ${r.meanVoices}  meanMidi ${r.meanMidi}  topPC ${r.topPC}%`)
}

// Compare the pitch contours frame by frame (same duration, same frame rate).
const base = runs[0]
for (const r of runs.slice(1)) {
  let n = 0
  let same = 0
  let within = 0
  let deg = 0
  for (let i = 0; i < Math.min(base.contour.length, r.contour.length); i++) {
    const a = base.contour[i]
    const b = r.contour[i]
    if (a == null && b == null) { same++; n++; continue }
    if (a == null || b == null) { n++; deg++; continue }
    n++
    const d = Math.abs(a - b)
    if (d < 0.02) same++
    if (d < 0.5) within++
  }
  console.log(`  vs ${r.sr} Hz: identical ${(100 * same / n).toFixed(1)}%  ` +
    `within 50c ${(100 * within / n).toFixed(1)}%  one-sided ${(100 * deg / n).toFixed(1)}%`)
}
