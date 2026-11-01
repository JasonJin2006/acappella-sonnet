// Smoke test: can the DOM-free library modules run under Node on real audio?
import { readWav } from './wav.mjs'
import { framesFromBuffer } from '../src/lib/hum.js'
import { YinDetector } from '../src/lib/pitch.js'
import { MultiPitch } from '../src/lib/multipitch.js'

const path = process.argv[2]
if (!path) {
  console.error('usage: node tests/smoke.mjs <file.wav>')
  process.exit(2)
}
const buf = readWav(path)
console.log('file', path, buf.sampleRate, 'Hz', buf.duration.toFixed(2), 's')

const t0 = Date.now()
const frames = framesFromBuffer(buf)
const dt = Date.now() - t0
const voiced = frames.filter((f) => f.midi != null && f.clarity > 0.55 && f.rms > 0.0035)
console.log('frames', frames.length, 'voiced', voiced.length,
  `${((voiced.length / frames.length) * 100).toFixed(1)}%`, 'in', dt, 'ms')

const mp = new MultiPitch(buf.sampleRate, 4096)
console.log('multipitch ok', typeof mp.estimate, 'yin ok', typeof new YinDetector(44100, 2048).detect)
