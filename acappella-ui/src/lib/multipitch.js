// 多基频估计：一次估出当前同时响着的几个音高。
// 不做声源分离（单麦克风物理上做不到），而是"合唱里每个人基频不同"这个事实把它们找出来。
//
// 做法：谐波求和谱（某个 f0 的各次谐波处能量都高 → 它像个基频），
// 挑一个就把它的谐波从谱里抹掉，再挑下一个，最多 4 个。

import { freqToMidi } from './pitch.js'

// FFT window that keeps the frequency resolution constant across sample rates
// (~93 ms, the same span as 4096 points at 44.1 kHz). A fixed 4096-point FFT
// at 96 kHz halves the resolution and degrades the harmonic sum.
export function fftSizeFor(sr) {
  return Math.min(16384, 2 ** Math.round(Math.log2(sr * 0.0929)))
}

export class MultiPitch {
  constructor(sampleRate, fftSize) {
    this.sr = sampleRate
    this.fftSize = fftSize || 4096
    this.binHz = sampleRate / this.fftSize
    this.minHz = 70
    this.maxHz = 1000
    this.nCand = 240
    this.nHarm = 9
    this.grid = new Float32Array(this.nCand)
    for (let i = 0; i < this.nCand; i++) {
      this.grid[i] = this.minHz * Math.pow(this.maxHz / this.minHz, i / (this.nCand - 1))
    }
    this.spec = new Float32Array(this.fftSize / 2 + 1)
    this.work = new Float32Array(this.fftSize / 2 + 1)
  }

  // dbSpectrum 来自 analyser.getFloatFrequencyData（单位是 dB）
  estimate(dbSpectrum, maxVoices) {
    const n = Math.min(dbSpectrum.length, this.spec.length)
    let sum = 0
    for (let i = 0; i < n; i++) {
      const v = Math.pow(10, dbSpectrum[i] / 20)   // dB → 线性幅度
      this.spec[i] = v
      sum += v
    }
    const base = n ? sum / n : 0
    if (!(base > 0)) return []
    this.work.set(this.spec)

    const out = []
    const limit = maxVoices || 4
    for (let v = 0; v < limit; v++) {
      let best = -1, bestVal = 0
      for (let i = 0; i < this.nCand; i++) {
        const f0 = this.grid[i]
        let s = 0, cnt = 0
        for (let h = 1; h <= this.nHarm; h++) {
          const f = f0 * h
          if (f > this.sr * 0.475) break
          const b = Math.round(f / this.binHz)
          if (b < 1 || b >= n - 1) continue
          let m = this.work[b]
          if (this.work[b - 1] > m) m = this.work[b - 1]
          if (this.work[b + 1] > m) m = this.work[b + 1]
          s += m; cnt++
        }
        if (!cnt) continue
        const val = s / cnt
        if (val > bestVal) { bestVal = val; best = i }
      }
      // 要明显高于整条谱的平均水平才算数，否则就是噪声
      if (best < 0 || bestVal < base * 4.0) break
      const f0 = this.grid[best]
      out.push({
        freq: f0,
        midi: freqToMidi(f0),
        strength: bestVal / base,      // 相对强度，用来判断谁离麦克风近
      })
      this._kill(f0, n)
    }
    return out
  }

  _kill(f0, n) {
    for (let h = 1; h <= 10; h++) {
      const f = f0 * h
      if (f > this.sr * 0.475) break
      const b = Math.round(f / this.binHz)
      for (let k = -2; k <= 2; k++) {
        const idx = b + k
        if (idx > 0 && idx < n) this.work[idx] *= 0.04
      }
    }
  }
}

// 从一堆候选基频里，挑出与"这个声部当前该唱的音"最吻合的那个。
// 声部之间不需要显式分配——每个声部各按自己的谱去找，天然就把 F0 分完了。
// 返回 {f, exact}：exact 表示是按真实音高认领的，false 表示只差一个八度。
// 锚点选择只信 exact——否则女中会把男低的 C3 当成自己的 C4 认领走。
export function pickForPart(f0s, targetMidi, tolSemitones) {
  if (!f0s || !f0s.length || targetMidi == null) return null
  const tol = tolSemitones == null ? 2.5 : tolSemitones
  let exact = null, exactDiff = Infinity
  let oct = null, octDiff = Infinity
  for (const f of f0s) {
    const raw = Math.abs(f.midi - targetMidi)
    if (raw <= tol && raw < exactDiff) { exactDiff = raw; exact = f }
    let d = f.midi - targetMidi
    while (d > 6) d -= 12
    while (d < -6) d += 12
    const a = Math.abs(d)
    if (a <= tol && a < octDiff) { octDiff = a; oct = f }
  }
  return exact ? { f: exact, exact: true } : oct ? { f: oct, exact: false } : null
}
