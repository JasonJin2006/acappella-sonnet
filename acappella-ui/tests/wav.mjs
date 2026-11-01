// Minimal RIFF/WAVE reader for the offline test harness.
// Supports PCM 16/24/32 and IEEE float 32, which covers everything the
// corpus writer produces.  Returns mono float samples in [-1, 1].
import { readFileSync } from 'node:fs'

function parseFmt(buf, off) {
  const format = buf.readUInt16LE(off)
  const channels = buf.readUInt16LE(off + 2)
  const sampleRate = buf.readUInt32LE(off + 4)
  const bits = buf.readUInt16LE(off + 14)
  return { format, channels, sampleRate, bits }
}

export function readWav(path) {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a RIFF/WAVE file: ${path}`)
  }
  let fmt = null
  let dataOff = -1
  let dataLen = 0
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') fmt = parseFmt(buf, body)
    else if (id === 'data') { dataOff = body; dataLen = Math.min(size, buf.length - body) }
    off = body + size + (size & 1)
  }
  if (!fmt || dataOff < 0) throw new Error(`missing fmt/data chunk: ${path}`)

  const { format, channels, sampleRate, bits } = fmt
  const bytes = bits / 8
  const frames = Math.floor(dataLen / (bytes * channels))
  const out = new Float32Array(frames)
  const isFloat = format === 3
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (i * channels + c) * bytes
      let v
      if (isFloat && bits === 32) v = buf.readFloatLE(p)
      else if (isFloat && bits === 64) v = buf.readDoubleLE(p)
      else if (bits === 16) v = buf.readInt16LE(p) / 32768
      else if (bits === 24) v = buf.readIntLE(p, 3) / 8388608
      else if (bits === 32) v = buf.readInt32LE(p) / 2147483648
      else throw new Error(`unsupported bit depth ${bits}`)
      sum += v
    }
    out[i] = sum / channels
  }
  return {
    sampleRate,
    channels,
    duration: frames / sampleRate,
    data: out,
    // Shape matches the two fields of WebAudio's AudioBuffer that the
    // analysis code actually touches.
    getChannelData: () => out,
  }
}
