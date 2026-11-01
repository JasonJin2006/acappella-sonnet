// 哼调记谱：把麦克风里的单声部哼唱转成谱面音符。
//
// 采集阶段只做一件事：每 1/30 秒跑一次 YIN，得到 {t, midi, clarity, rms}。
// 转录放在停止之后离线做：中值滤波去毛刺、按音高跳变断句、再按 BPM 量化到半拍。
// 这样比逐帧在线判断稳，也不会因为一帧误判就把音切错。
import { YinDetector, yinWindowSize } from './pitch.js'
import { MultiPitch, fftSizeFor } from './multipitch.js'
import { magnitudeSpectrum } from './fft.js'
import { sharedCtx } from './sharedCtx.js'
import { openMic } from './audioInput.js'

const HOP_MS = 1000 / 30

function median(arr) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[s.length >> 1]
}

export class HumRecorder {
  constructor() {
    this.ctx = null
    this.stream = null
    this.running = false
    this.frames = []
  }

  async start(onFrame, opts = {}) {
    this.ctx = sharedCtx()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    try {
      // 约束口径与录音/跟唱统一，由 openMic 按设备能力决定（见 lib/audioInput.js）
      this.stream = await openMic()
    } catch (e) {
      return { error: '需要麦克风权限：' + (e.message || e.name) }
    }
    this.src = this.ctx.createMediaStreamSource(this.stream)
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 4096
    this.analyser.smoothingTimeConstant = 0
    this.src.connect(this.analyser)

    this.yinSize = yinWindowSize(this.ctx.sampleRate)
    this.det = new YinDetector(this.ctx.sampleRate, this.yinSize)
    this.buf = new Float32Array(this.analyser.fftSize)
    this.yin = new Float32Array(this.yinSize)
    this.frames = []
    this.multi = !!opts.multi   // 低音跟踪模式才开多候选，普通哼唱省一半算力
    this.onFrame = onFrame || null
    this.running = true
    this.t0 = performance.now()
    this.lastTick = 0

    const loop = () => {
      if (!this.running) return
      const now = performance.now()
      if (now - this.lastTick >= HOP_MS) {
        this.lastTick = now
        this._tick()
      }
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
    return { ok: true }
  }

  _tick() {
    this.analyser.getFloatTimeDomainData(this.buf)
    this.yin.set(this.buf.subarray(0, this.yinSize))
    const r = this.multi ? this.det.detectMulti(this.yin) : this.det.detect(this.yin)
    const t = (performance.now() - this.t0) / 1000
    const midi = r.freq > 0 ? 69 + 12 * Math.log2(r.freq / 440) : null
    const frame = { t, midi, clarity: r.clarity, rms: r.rms, candidates: r.candidates }
    this.frames.push(frame)
    if (this.onFrame) this.onFrame(frame)
  }

  // 同步返回采到的帧，交给 transcribe 离线处理
  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
    if (this.src) { try { this.src.disconnect() } catch (e) {} this.src = null }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null }
    return this.frames
  }
}

// 离线分析一段音频，得到和实时采集一样的帧序列。
// 用来导入音频文件转谱，也方便拿真实录音验证算法。
export function framesFromBuffer(buffer, hopMs = HOP_MS, opts = {}) {
  const sr = buffer.sampleRate
  const data = buffer.getChannelData(0)
  const winSize = yinWindowSize(sr)
  const det = new YinDetector(sr, winSize)
  const win = new Float32Array(winSize)
  const hop = Math.max(1, Math.round((sr * hopMs) / 1000))
  const frames = []
  for (let i = 0; i + winSize <= data.length; i += hop) {
    win.set(data.subarray(i, i + winSize))
    const r = opts.multi ? det.detectMulti(win, opts.detector) : det.detect(win)
    let sum = 0
    for (let k = 0; k < winSize; k++) sum += win[k] * win[k]
    frames.push({
      t: i / sr,
      midi: r.freq > 0 ? 69 + 12 * Math.log2(r.freq / 440) : null,
      clarity: r.clarity,
      rms: Math.sqrt(sum / winSize),
      candidates: r.candidates,
    })
  }
  return frames
}

// 频谱版：用 MultiPitch 的谐波求和找候选。和弦在时域上没有各自的周期，
// 但在频域里每个声部的基频是独立的一根峰，所以这条路径才分得开声部。
export function framesFromBufferSpectral(buffer, hopMs = HOP_MS, opts = {}) {
  const sr = buffer.sampleRate
  const data = buffer.getChannelData(0)
  const size = opts.fftSize || fftSizeFor(sr)
  const hop = Math.max(1, Math.round((sr * hopMs) / 1000))
  const mp = new MultiPitch(sr, size)
  const win = new Float32Array(size)
  const db = new Float32Array(size / 2 + 1)
  const maxVoices = opts.maxVoices || 4
  const frames = []
  for (let i = 0; i + size <= data.length; i += hop) {
    let energy = 0
    for (let k = 0; k < size; k++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (size - 1))
      win[k] = data[i + k] * w
      energy += win[k] * win[k]
    }
    const mag = magnitudeSpectrum(win, size)
    for (let k = 0; k < mag.length; k++) db[k] = 20 * Math.log10(mag[k] + 1e-9)
    const f0s = mp.estimate(db, maxVoices)
    frames.push({
      t: i / sr,
      midi: f0s.length ? f0s[0].midi : null,
      clarity: f0s.length ? Math.min(1, (f0s[0].strength || 1) / 8) : 0,
      rms: Math.sqrt(energy / size),
      candidates: f0s.map((f) => ({
        freq: f.freq,
        midi: f.midi,
        clarity: Math.min(1, (f.strength || 1) / 8),
      })),
    })
  }
  return frames
}

// frames → { notes: [{midi, cents, beats}], totalBeats, voiced }
// bpm 用来把时间换算成拍。默认量化到半拍；free 模式保留实际时长和音分偏差，
// 给散板、自由延长的传统（侗族大歌、格鲁吉亚、长调）用。
export function transcribe(frames, bpm, opts = {}) {
  const src = frames || []
  const minClarity = opts.clarity == null ? 0.55 : opts.clarity
  const minRms = opts.rms == null ? 0.0035 : opts.rms
  // 1) 有效帧：清晰度、音量双门槛，噪声帧记为空
  const midis = src.map((f) => (f.midi != null && f.clarity > minClarity && f.rms > minRms ? f.midi : null))
  return buildNotes(src, midis, bpm, opts)
}

// 跟踪最低声部：每帧拿到多个基频候选，用 Viterbi 选一条连续的音高线。
// 单声部时等价于直接取音高；多声部混音时它不会在几个声部之间乱跳。
export function trackLowest(frames, opts = {}) {
  const src = frames || []
  const n = src.length
  if (!n) return []
  const lo = Math.round(opts.lo == null ? 36 : opts.lo)
  const hi = Math.round(opts.hi == null ? 62 : opts.hi)
  const S = hi - lo + 1
  if (S <= 0) return new Array(n).fill(null)
  const MIN_RMS = opts.rms == null ? 0.0035 : opts.rms
  const STEP = 7          // 一帧最多移动几个半音
  const MOVE = 0.55       // 每移动一个半音的代价
  const FLAT = 3.2        // 没有候选时的默认代价

  // 发射代价：候选离哪个状态近，那个状态就便宜
  const emit = []
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(S).fill(FLAT)
    const cands = src[i].candidates || []
    if ((src[i].rms == null ? 1 : src[i].rms) >= MIN_RMS) {
      for (const c of cands) {
        if (c.clarity < 0.22) continue
        const base = Math.round(c.midi) - lo
        for (let d = -1; d <= 1; d++) {
          const k = base + d
          if (k < 0 || k >= S) continue
          const cost = (1 - c.clarity) * 3 + Math.abs(c.midi - (k + lo)) * 2.2
          if (cost < row[k]) row[k] = cost
        }
      }
    }
    emit.push(row)
  }

  let dp = Float64Array.from(emit[0])
  const back = []
  for (let i = 1; i < n; i++) {
    const ndp = new Float64Array(S).fill(1e9)
    const bp = new Int16Array(S).fill(-1)
    for (let st = 0; st < S; st++) {
      for (let d = -STEP; d <= STEP; d++) {
        const p = st + d
        if (p < 0 || p >= S) continue
        const c = dp[p] + Math.abs(d) * MOVE
        if (c < ndp[st]) { ndp[st] = c; bp[st] = p }
      }
      ndp[st] += emit[i][st]
    }
    back.push(bp)
    dp = ndp
  }
  let best = 0
  for (let st = 1; st < S; st++) if (dp[st] < dp[best]) best = st
  const path = new Array(n)
  path[n - 1] = best
  for (let i = n - 1; i > 0; i--) path[i - 1] = back[i - 1][path[i]] >= 0 ? back[i - 1][path[i]] : path[i]

  // 状态换回具体音高：优先取落在该状态里的候选，这样音分不会丢
  return path.map((st, i) => {
    const target = st + lo
    const cands = src[i].candidates || []
    let pick = null
    for (const c of cands) {
      if (Math.abs(c.midi - target) <= 0.7) { pick = c; break }
    }
    return pick ? pick.midi : null
  })
}

export function transcribeTracked(frames, bpm, opts = {}) {
  const src = frames || []
  const midis = trackLowest(src, opts)
  return buildNotes(src, midis, bpm, opts)
}

// 把逐帧音高切成音符。量化与否在这里决定，跟踪方式不影响这段逻辑。
function buildNotes(src, midis, bpm, opts = {}) {
  const secPerBeat = 60 / (bpm || 96)
  const free = !!opts.free
  if (!src.length) return { notes: [], totalBeats: 0, voiced: 0, free }

  // 2) 5 帧中值滤波，抹掉单个八度跳错和毛刺
  const med = midis.map((v, i) => {
    if (v == null) return null
    const w = []
    for (let k = -2; k <= 2; k++) {
      const x = midis[i + k]
      if (x != null) w.push(x)
    }
    return w.length ? median(w) : v
  })

  // 3) 断句。音高跳变不能立刻切音：真实录音里（尤其几个人同时唱）一帧跳到别的声部
  //    很常见，立刻切会切出一堆几十毫秒的碎片。新音高要连续站住 HOLD 帧才算数，
  //    中途回到原来的音高就当噪声丢掉。
  const HOLD = opts.hold == null ? 3 : opts.hold
  const segs = []
  let cur = null
  let lastT = null
  let pend = null
  for (let i = 0; i < src.length; i++) {
    const t = src[i].t
    const m = med[i]
    if (m == null) {
      // 静音超过 90ms 才收尾，短空档算作同音里的断气
      if (cur && lastT != null && t - lastT > 0.09) {
        cur.end = lastT
        segs.push(cur)
        cur = null
        pend = null
      }
      continue
    }
    if (!cur) {
      cur = { start: t, end: t, ps: [m] }
      lastT = t
      continue
    }
    const ref = median(cur.ps)
    if (Math.abs(m - ref) <= 0.85) {
      // 回到当前音高：之前攒的候选是噪声，整段算在这个音里
      cur.ps.push(m)
      cur.end = t
      pend = null
    } else if (!pend || Math.abs(m - pend.pitch) > 0.85) {
      pend = { pitch: m, ps: [m], start: t, last: t }
    } else {
      pend.ps.push(m)
      pend.last = t
      if (pend.ps.length >= HOLD) {
        cur.end = lastT ?? pend.start
        segs.push(cur)
        cur = { start: pend.start, end: pend.last, ps: [...pend.ps] }
        pend = null
      }
    }
    lastT = t
  }
  if (pend && pend.ps.length >= 2 && cur) {
    cur.end = Math.max(cur.end, pend.start)
    segs.push(cur)
    cur = { start: pend.start, end: pend.last, ps: [...pend.ps] }
    pend = null
  }
  if (cur && cur.ps.length) { cur.end = Math.max(cur.end, lastT ?? cur.end); segs.push(cur) }

  // 4) 合并：同音高的碎片接回去，太短的碎片直接并进前一个音
  const merged = []
  for (const s of segs) {
    const p = Math.round(median(s.ps))
    const last = merged[merged.length - 1]
    const dur = s.end - s.start
    if (last && (Math.round(median(last.ps)) === p || dur < 0.09) && s.start - last.end < 0.14) {
      last.end = Math.max(last.end, s.end)
      if (Math.round(median(last.ps)) === p) last.ps.push(...s.ps)
    } else {
      merged.push({ start: s.start, end: s.end, ps: [...s.ps] })
    }
  }
  if (!merged.length) return { notes: [], totalBeats: 0, voiced: 0, free }

  // 5) 量化到半拍，或者自由记谱保留实际时长
  const t0 = merged[0].start
  const notes = []
  let beat = 0
  let voiced = 0
  for (const s of merged) {
    const raw = median(s.ps)
    const midi = Math.round(raw)
    // 音分偏差单独存：谱面仍是十二平均律，分析结果不丢游移音高的信息
    const cents = Math.round((raw - midi) * 100)
    const rawStart = (s.start - t0) / secPerBeat
    const rawDur = (s.end - s.start) / secPerBeat
    const start = free ? +rawStart.toFixed(2) : Math.round(rawStart * 2) / 2
    if (start > beat + 1e-9) {
      notes.push({ midi: null, beats: +(start - beat).toFixed(2) })
      beat = start
    }
    let dur = free ? +rawDur.toFixed(2) : Math.round(rawDur * 2) / 2
    const floor = free ? 0.08 : 0.5
    if (!(dur >= floor)) dur = floor
    notes.push({ midi, cents, beats: dur })
    beat += dur
    voiced++
  }
  return { notes, totalBeats: +beat.toFixed(2), voiced, free }
}
