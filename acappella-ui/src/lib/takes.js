// 多轨录音：自己分声部各录一条，录完按谱面自动对齐起始拍，
// 再允许每轨做毫秒级微调，最后混在一起试听。
//
// 自动对齐不靠听感，靠"谱面此刻该唱什么"：把录音的音高轨迹逐帧对到
// 谱面每个候选起点上打分，分最低的就是实际起点。和冷启动定位同一套思路，
// 但录音是离线的，可以把整条轨迹都拿来比，比实时定位稳。
import { YinDetector, yinWindowSize } from './pitch.js'
import { sharedCtx } from './sharedCtx.js'
import { openMic } from './audioInput.js'

const HOP_MS = 1000 / 30

// 取某个声部在任意拍上的期望音高；谱外返回 undefined
function pitchAt(notes, starts, totalBeats, beat) {
  if (beat < 0 || beat >= totalBeats) return undefined
  let lo = 0, hi = starts.length - 1, ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= beat + 1e-9) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return notes[ans].midi
}

// trace: [{t, midi, c}]，t 为录音内的秒数
// 返回 startBeat：这条录音的第 0 秒对应声部的第几拍
export function alignTake(trace, part, bpm) {
  const secPerBeat = 60 / (bpm || 96)
  const notes = (part && part.notes) || []
  if (!notes.length || !trace || !trace.length) return { startBeat: 0, cost: 1, margin: 0 }
  const starts = []
  let acc = 0
  for (const n of notes) { starts.push(acc); acc += n.beats }
  const totalBeats = acc
  const frames = trace.filter((f) => f.midi != null && (f.c == null || f.c > 0.5))
  if (frames.length < 4) return { startBeat: 0, cost: 1, margin: 0 }

  const step = 0.25
  let best = null
  let second = Infinity
  for (let b0 = 0; b0 <= totalBeats + 1e-9; b0 += step) {
    let sum = 0, n = 0
    for (const f of frames) {
      const want = pitchAt(notes, starts, totalBeats, b0 + f.t / secPerBeat)
      if (want == null) continue
      sum += Math.min(6, Math.abs(f.midi - want))
      n++
    }
    // 大半录音都落在谱外，说明这个起点不成立
    if (n < Math.max(4, frames.length * 0.4)) continue
    const cost = sum / n / 6
    const cov = n / frames.length
    // 轻微偏好从声部开头开始：录音一般是从自己声部第一拍唱起
    const score = cost + b0 * 0.004
    if (!best || score < best.score) {
      if (best && best.score < second) second = best.score
      best = { b0, cost, score, cov }
    } else if (score < second) {
      second = score
    }
  }
  if (!best) return { startBeat: 0, cost: 1, margin: 0, weak: true }
  const margin = second - best.score
  // 贴合度太低或几个起点得分接近时，不要硬给一个靠后的位置，
  // 宁可回到第 0 拍，否则播放会从一个奇怪的小节开始
  const weak = best.cost > 0.3 || best.cov < 0.75 || margin < 0.01
  return {
    startBeat: weak ? 0 : +best.b0.toFixed(2),
    cost: +best.cost.toFixed(3),
    margin: +margin.toFixed(3),
    coverage: +best.cov.toFixed(2),
    weak,
  }
}

// 软膝限幅曲线：0.8 以下完全线性（不改变正常演唱的电平），
// 以上用 tanh 平滑压到 0.96 以内。整条曲线斜率不超过 1，不会放大弱信号。
function softClipCurve(n) {
  const curve = new Float32Array(n)
  const knee = 0.8
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    const a = Math.abs(x)
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee))
    curve[i] = Math.sign(x) * Math.min(0.96, y)
  }
  return curve
}

// 边录边采音高。倒计时期间不录，保证每条轨的第 0 秒都对得上节拍。
export class TakeRecorder {
  constructor() {
    this.ctx = null
    this.stream = null
    this.running = false
    this.counting = false
    this.frames = []
    // 同一个实例被 start 两次时，后一次会覆盖前一次的 this.stream，
    // 前一次那路 getUserMedia 就再也没人关，系统一直显示「正在录音」。
    // 用代次号让旧的那次自己发现"已被取代"。
    this._gen = 0
  }

  async start({ bpm = 96, countIn = 4, onPhase, onFrame } = {}) {
    const gen = ++this._gen
    // 已经在采：这次调用直接作废，不要再去开第二路麦
    if (this.stream || this.running) return { error: null, superseded: true }
    this.ctx = sharedCtx()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    let stream = null
    try {
      // 一定不能开 AGC：WebView 的自动增益会把麦克风一路推到 0 dBFS，
      // 波形削平之后听起来就是持续的刺啦，而且录进去已经救不回来。
      // 具体走哪条约束由 openMic 按设备能力决定，见 lib/audioInput.js。
      stream = await openMic({ channelCount: 1 })
    } catch (e) {
      return { error: '需要麦克风权限：' + (e.message || e.name) }
    }
    // getUserMedia 期间又有人调了 start / stop：这路麦立刻关掉，不接管
    if (gen !== this._gen) {
      stream.getTracks().forEach((t) => t.stop())
      return { error: null, superseded: true }
    }
    this.stream = stream
    if (typeof MediaRecorder === 'undefined') return { error: '当前浏览器不支持录音（MediaRecorder）' }

    this.src = this.ctx.createMediaStreamSource(this.stream)

    // 80 Hz 以下基本是手持噪声和呼吸，先切掉，省得占动态余量
    this.hp = this.ctx.createBiquadFilter()
    this.hp.type = 'highpass'
    this.hp.frequency.value = 80
    this.hp.Q.value = 0.7

    // 固定增益留 8 dB 余量，比浏览器 AGC 稳定得多
    this.gain = this.ctx.createGain()
    this.gain.gain.value = 0.9

    // 软限幅：tanh 曲线，超过 1 也不会硬削，峰值被压到 0.96 以内
    this.shaper = this.ctx.createWaveShaper()
    this.shaper.curve = softClipCurve(1024)
    this.shaper.oversample = '2x'

    // 处理后的流交给 MediaRecorder，录下来的电平和监听完全一致
    this.dest = this.ctx.createMediaStreamDestination()

    this.src.connect(this.hp)
    this.hp.connect(this.gain)
    this.gain.connect(this.shaper)
    this.shaper.connect(this.dest)

    // 电平表接在增益后、限幅前：这一级过载说明麦克风确实太近了
    this.rawAnalyser = this.ctx.createAnalyser()
    this.rawAnalyser.fftSize = 2048
    this.rawAnalyser.smoothingTimeConstant = 0
    this.gain.connect(this.rawAnalyser)

    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 4096
    this.analyser.smoothingTimeConstant = 0
    this.shaper.connect(this.analyser)
    // 分析节点要有一条通往 destination 的路径才会被驱动，串一个静音增益
    this.silent = this.ctx.createGain()
    this.silent.gain.value = 0
    this.analyser.connect(this.silent)
    this.silent.connect(this.ctx.destination)
    this.yinSize = yinWindowSize(this.ctx.sampleRate)
    this.det = new YinDetector(this.ctx.sampleRate, this.yinSize)
    this.buf = new Float32Array(this.analyser.fftSize)
    this.rawBuf = new Float32Array(this.rawAnalyser.fftSize)
    this.yin = new Float32Array(this.yinSize)
    this.frames = []
    this.chunks = []
    this.onFrame = onFrame || null
    this.running = true
    this.abort = false

    // 倒计时：用独立的方波咔哒声，不占提示音引擎
    const spb = 60 / (bpm || 96)
    const tStart = this.ctx.currentTime + 0.06
    for (let i = 0; i < countIn; i++) this._click(i === 0, tStart + i * spb)
    this.counting = countIn > 0
    this.running = true
    if (onPhase) onPhase(this.counting ? 'countin' : 'rec')
    if (countIn > 0) {
      const waitMs = Math.max(0, (tStart + countIn * spb - this.ctx.currentTime) * 1000)
      await new Promise((res) => setTimeout(res, waitMs))
    }
    // stop() 在倒计时里被调用过：正常路径下 stop() 的 _cleanup 已经关掉了麦，
    // 这里再清一次是兜底（例如 stop() 比 getUserMedia 先返回的情况）。
    if (this.abort) { this._cleanup(); return { error: '已取消' } }
    this.counting = false

    const mt = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    const opts = mt ? { mimeType: mt, audioBitsPerSecond: 128000 } : { audioBitsPerSecond: 128000 }
    const source = this.dest && this.dest.stream ? this.dest.stream : this.stream
    try {
      this.mr = new MediaRecorder(source, opts)
    } catch (e) {
      // 有些机型不认比特率参数，退回默认配置
      this.mr = new MediaRecorder(source, mt ? { mimeType: mt } : undefined)
    }
    this.mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data) }
    this.mr.start()
    this.t0 = performance.now()
    if (onPhase) onPhase('rec')

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
    const r = this.det.detect(this.yin)
    let peak = 0
    for (let i = 0; i < 2048; i++) {
      const v = Math.abs(this.buf[i])
      if (v > peak) peak = v
    }
    // 限幅前的真实输入电平，用来提示「离麦克风远一点」
    let rawPeak = 0
    if (this.rawAnalyser) {
      this.rawAnalyser.getFloatTimeDomainData(this.rawBuf)
      for (let i = 0; i < this.rawBuf.length; i++) {
        const v = Math.abs(this.rawBuf[i])
        if (v > rawPeak) rawPeak = v
      }
    }
    const t = (performance.now() - this.t0) / 1000
    const midi = r.freq > 0 ? 69 + 12 * Math.log2(r.freq / 440) : null
    this.frames.push({ t, midi, c: r.clarity })
    if (this.onFrame) this.onFrame({ t, midi, clarity: r.clarity, peak, rawPeak })
  }

  // 停止并返回 { blob, buffer, trace, duration }。
  // buffer 解码失败时为 null，那条轨就只能看不能听。
  async stop() {
    this.running = false
    this.abort = true
    cancelAnimationFrame(this.raf)
    let blob = null
    if (this.mr && this.mr.state !== 'inactive') {
      blob = await new Promise((res) => {
        this.mr.onstop = () => {
          try { res(new Blob(this.chunks, { type: this.mr.mimeType || 'audio/webm' })) } catch (e) { res(null) }
        }
        try { this.mr.stop() } catch (e) { res(null) }
      })
    }
    let buffer = null
    if (blob && this.ctx) {
      try { buffer = await this.ctx.decodeAudioData(await blob.arrayBuffer()) } catch (e) { buffer = null }
    }
    const trace = this.frames.slice()
    const duration = buffer ? buffer.duration : (trace.length ? trace[trace.length - 1].t : 0)
    this._cleanup()
    return { blob, buffer, trace, duration }
  }

  _cleanup() {
    this.counting = false
    this.mr = null
    for (const k of ['src', 'hp', 'gain', 'shaper', 'dest', 'analyser', 'rawAnalyser', 'silent']) {
      const node = this[k]
      if (node && node.disconnect) { try { node.disconnect() } catch (e) {} }
      this[k] = null
    }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null }
  }

  _click(strong, when) {
    const ctx = this.ctx
    const g = ctx.createGain(); g.connect(ctx.destination)
    const peak = strong ? 0.5 : 0.3
    g.gain.setValueAtTime(peak, when)
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05)
    const o = ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = strong ? 1600 : 1100
    o.connect(g); o.start(when); o.stop(when + 0.06)
  }
}

// 混音播放：按每条轨的 startBeat 与 offsetMs 排到同一条时间轴上。
export class Mixer {
  constructor() {
    this.ctx = null
    this.srcs = []
    this.timer = 0
    this.playing = false
    this.onEnd = null
  }

  _ensureCtx() {
    this.ctx = sharedCtx()
    return this.ctx
  }

  play(tracks, { bpm = 96, onEnd } = {}) {
    this.stop()
    const list = (tracks || []).filter((t) => t.buffer && !t.muted)
    if (!list.length) return false
    const ctx = this._ensureCtx()
    // 总线压缩限幅：多条轨叠加时不至于削顶成“刺啦”
    if (!this.master) {
      this.master = ctx.createDynamicsCompressor()
      this.master.threshold.value = -6
      this.master.knee.value = 12
      this.master.ratio.value = 4
      this.master.attack.value = 0.006
      this.master.release.value = 0.3
      this.masterGain = ctx.createGain()
      this.masterGain.gain.value = 0.9
      this.master.connect(this.masterGain)
      this.masterGain.connect(ctx.destination)
    }
    const t0 = ctx.currentTime + 0.08
    const spb = 60 / bpm
    let end = t0
    for (const tr of list) {
      const src = ctx.createBufferSource()
      src.buffer = tr.buffer
      const g = ctx.createGain()
      const peakGain = (tr.gain == null ? 0.85 : tr.gain) * 0.9
      src.connect(g)
      g.connect(this.master)
      const pos = (tr.startBeat || 0) * spb + (tr.offsetMs || 0) / 1000
      const startAt = pos >= 0 ? t0 + pos : t0
      const skip = pos >= 0 ? 0 : Math.min(-pos, Math.max(0, tr.buffer.duration - 0.05))
      // 首尾 8ms 淡入淡出，避免切在非零采样上产生爆音
      const fade = Math.min(0.02, tr.buffer.duration / 4)
      g.gain.setValueAtTime(0.0001, startAt)
      g.gain.exponentialRampToValueAtTime(peakGain, startAt + fade)
      g.gain.setValueAtTime(peakGain, Math.max(startAt + fade, startAt + tr.buffer.duration - skip - fade))
      g.gain.linearRampToValueAtTime(0.0001, startAt + tr.buffer.duration - skip)
      if (pos >= 0) {
        src.start(t0 + pos)
        end = Math.max(end, t0 + pos + tr.buffer.duration)
      } else {
        src.start(t0, skip)
        end = Math.max(end, t0 + tr.buffer.duration - skip)
      }
      this.srcs.push(src)
    }
    this.playing = true
    this.onEnd = onEnd || null
    const ms = Math.max(0, (end - ctx.currentTime) * 1000) + 150
    this.timer = setTimeout(() => {
      this.playing = false
      this.stop()
      const cb = this.onEnd
      this.onEnd = null
      if (cb) cb()
    }, ms)
    return true
  }

  stop() {
    clearTimeout(this.timer)
    this.timer = 0
    for (const s of this.srcs) {
      try { s.stop() } catch (e) {}
      try { s.disconnect() } catch (e) {}
    }
    this.srcs = []
    this.playing = false
  }
}


// 统计一段录音的峰值和削顶采样数，用来判断“刺啦”是不是录入时就过载了
export function analyzeBuffer(buffer) {
  if (!buffer) return { peak: 0, clipped: 0 }
  let peak = 0
  let clipped = 0
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i])
      if (v > peak) peak = v
      if (v >= 0.999) clipped++
    }
  }
  return { peak: +peak.toFixed(3), clipped }
}
