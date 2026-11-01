// 运行时引擎。
//
// 关键设计：位置由「团队」决定，不是由自己决定。
// 如果我跟着自己走，一旦我自己节奏没跟上团队，系统就跟着我一起错，
// 那就失去了提醒的意义。所以这里用多基频同时听所有人，取各声部的共识位置，
// 我的声音只拿来和"团队此刻该唱什么"做对比，算出我偏了多少。
import { YinDetector, yinWindowSize } from './pitch'
import { Follower } from './follower'
import { CueEngine } from './cue'
import { MultiPitch, pickForPart, fftSizeFor } from './multipitch'
import { ColdStartAligner } from './coldstart'
import { midiToFreq } from './music'
import { sharedCtx } from './sharedCtx'
import { openMic } from './audioInput'
import { TempoMap } from './tempo'

// 锁定之后，跟谱器每帧最多在 pos 附近这么大的范围里活动。
// 一旦锁定就默认接着走，只有持续严重对不上才回到冷启动重新定位。
const LOCK_BACK = 1
const LOCK_FWD = 3
// 判定"对不上了"的门槛：和声匹配代价超过这个数、且持续这么久 → 重新定位
const MISMATCH_COST = 0.8
const MISMATCH_MS = 2500
// 重定位时窗口一次比一次长：第一次尽快给反馈，反复失败就多攒点证据
// 第一次尽快给反馈；失配过之后每次多攒一点证据再下结论
const COLD_DURS = [0.85, 1.6, 3.0, 5.0]

export const DEFAULT_SETTINGS = {
  mode: 'cue',        // cue | sustain | correct | off
  vol: 0.7,
  oct: 0,             // -1 / 0 / +1
  thresh: 35,         // 音分
  advance: 200,       // 下一音提前预告 ms
  metro: false,
  nextCue: true,
  solf: false,
  timbre: 'choir',     // 音色：跟唱提示音和整谱播放共用一套，见 cue.js
  playOnlyMine: false, // 播放时只响我这个声部
  followMode: 'manual', // manual 点谱面定位 / auto 自动跟团队
  // 效果器参数（混响 / 声像 / 限幅），见 fx.js 的 DEFAULT_FX
  fx: null,
  // 整谱播放速率，0.5..2（1 = 原速）。变速不变调。
  playRate: 1,
  // 整首升降调，单位半音，-12..12（0 = 原调）。播放、跟唱提示音、
  // 跟唱判定三处一起移，否则降调唱会被判成一直跑调。
  transpose: 0,
  // 混音器：每个声部一个 0..1 的音量，0 等于静音。
  // 数组下标就是声部下标；缺项按 1 处理（老存档没有这个字段）。
  // 播放和跟唱提示音共用一个口径——练的时候把别的声部压低、
  // 正式听的时候再放开，不用两个地方各调一次。
  partVols: null,
  // 节拍器：播放时按拍打点。跟唱时另有一个 metro 开关（只在跟唱生效）。
  playMetro: false,
  // 低功耗模式：关掉混响、只播主旋律声部、限制采样预加载。
  // 老手机或 8 声部长谱卡顿时打开。
  lowPower: false,
}

export class Pilot {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS }
    // manual：点谱面定位，之后按时钟走，用音头做微调（默认）
    // auto：听整个团队做在线对齐
    this.mode = 'manual'
    this.manualTempo = 1
    this.teamBeat = 0
    this.phase = 'locked'
    this.fps = 30
    this.running = false
    this.score = null
    this.myPart = 0
    this.frame = null
    this.raf = 0
    this.buf = null
    // 开麦要等 getUserMedia，await 期间可能被切页 / 播放 / 重复点击打断。
    // _startToken 每次 stop/cancel 自增，旧的那次 start 回来就知道自己过期了。
    this.starting = false
    this._startToken = 0
  }

  setScore(score, myPart) {
    if (!score || !score.parts || !score.parts.length) return
    for (const p of score.parts) {
      let acc = 0
      p.startBeats = p.notes.map((n) => { const b = acc; acc += n.beats; return b })
      p.totalBeats = acc
    }
    this.score = score
    this.myPart = Math.max(0, Math.min(myPart ?? this.myPart, score.parts.length - 1))
    // 换谱必须回到开头。不清的话，新歌会从上一首停下的拍子开始播，
    // 光标和气泡也会指着新谱中间某个音。
    this.teamBeat = 0
    this.phase = 'locked'
    this.hasLocked = true
    this._manPrev = null
    this._manSilent = 0
    this.smoothedCents = null
    this.frame = null
    // 运行中换谱必须整套重建：否则 followers / aligner 还停留在旧谱上，
    // 监控会对着旧谱算代价导致乱重定位，声部数变多时帧对象还会越界
    if (this.running) this._rebuildFollowers()
  }

  setPart(i) {
    if (!this.score) return
    this.myPart = i
    this.frame = null
    if (this.running) this._rebuildFollowers()
  }

  _rebuildFollowers() {
    // 谱面速度表：变速谱里每个音「该唱多久」都不一样，跟谱器要按音的位置
    // 查速度，不能用一个全局 secPerBeat。单速谱会退化成一条直线。
    this.tempo = new TempoMap(this.score.tempos, this.score.bpm)
    // 每个声部各有一个跟谱器，各自只认领与自己谱面吻合的那个基频
    this.followers = this.score.parts.map(
      (p) => new Follower(p.notes, { bpm: this.score.bpm, tempo: this.tempo })
    )
    this.partState = this.score.parts.map(() => ({ prevMidi: null, silentMs: 0, lastOnset: 0 }))
    this.lastPos = -1
    this.nextCuedFor = -1
    // 手动模式下重建不能把用户点的位置清掉
    this.teamBeat = this.mode === 'manual' ? this.teamBeat || 0 : 0
    this.trace = []
    this.secPerBeat = 60 / this.score.bpm
    // cold = 正在攒窗口定位；locked = 已定位，默认接着走
    this.phase = 'cold'
    this.hasLocked = false
    this.coldFail = 0
    this.aligner = null
    this.alignerParts = null
    this.mismatchMs = 0
    this.coldFromBeat = 0
    this.teamTempo = 1
    if (this.mode === 'manual' && this.score) {
      this.phase = 'locked'
      this.hasLocked = true
    }
  }

  // 参与定位的声部（关掉的声部不参与），全关了就只跟自己
  _pool() {
    const fp = this.settings.followParts
    const allow = []
    for (let pi = 0; pi < this.score.parts.length; pi++) {
      const on = !fp || fp[pi] === undefined ? true : !!fp[pi]
      if (on) allow.push(pi)
    }
    this._solo = !allow.length
    return allow.length ? allow : [this.myPart]
  }

  _buildAligner() {
    const pool = this._pool()
    this.alignerParts = pool
    this.aligner = new ColdStartAligner(
      pool.map((i) => this.score.parts[i]),
      { bpm: this.score.bpm }
    )
  }

  // 回到冷启动：重新攒一段和声走向来定位
  _enterCold() {
    this.phase = 'cold'
    this.coldFail = this.hasLocked ? (this.coldFail || 0) + 1 : 0
    this.coldFromBeat = this.teamBeat || 0
    this.mismatchMs = 0
    if (this.aligner) {
      // 重新定位时已经知道大概在哪：先验给得更重、质量要求更严，
      // 免得合唱里偶尔漏检就跳回一个不相干的乐段
      this.aligner.priorW = this.hasLocked ? 0.02 : 0.002
      this.aligner.maxScore = this.hasLocked ? 0.45 : 0.6
      this.aligner.reset()
    }
  }

  _minDur() {
    return COLD_DURS[Math.min(this.coldFail || 0, COLD_DURS.length - 1)]
  }

  // 某个声部此刻该唱的音（锁定后用它自己的位置，冷启动中按团队拍换算）
  _claimTarget(pi) {
    const notes = this.score.parts[pi].notes
    if (this.mode !== 'manual' && this.phase === 'locked' && this.followers[pi]) {
      const p = this.followers[pi].pos
      return { midi: notes[p] ? notes[p].midi : null, idx: p }
    }
    const i = this._posAtBeat(this.score.parts[pi], this.teamBeat || 0)
    return { midi: notes[i] ? notes[i].midi : null, idx: i }
  }

  setMode(m) {
    this.mode = m === 'auto' ? 'auto' : 'manual'
    if (this.mode === 'manual') {
      this.phase = 'locked'
      this.hasLocked = true
    } else if (this.score) {
      this.phase = 'cold'
      this.hasLocked = false
      this.mismatchMs = 0
    }
    this.frame = null
  }

  // 点谱面定位：把队列位置直接挪过去
  seek(beat) {
    if (!this.score) return
    const b = Math.max(0, beat || 0)
    this.teamBeat = b
    this.phase = 'locked'
    this.hasLocked = true
    this._manPrev = null
    this._manSilent = 0
    this.smoothedCents = null
    this.frame = null
  }

  nudge(delta) {
    this.seek((this.teamBeat || 0) + delta)
  }

  // 我的声部在第几拍唱第几个音，给界面在暂停时移动光标用
  posAtBeat(beat) {
    if (!this.score) return 0
    return this._posAtBeat(this.score.parts[this.myPart], beat || 0)
  }

  // 手动模式：时钟推进 + 音头相位微调
  _manualTick(dt, chosen) {
    const part = this.score.parts[this.myPart]
    const total =
      part.startBeats[part.notes.length - 1] != null
        ? part.startBeats[part.notes.length - 1] + (part.notes[part.notes.length - 1].beats || 0)
        : 0
    // 时钟推进按「当前位置的速度」走：变速谱里同一秒走过的拍数不同，
    // 用固定 secPerBeat 会让中段开始整体偏快或偏慢
    const spbNow = this.tempo ? this.tempo.secPerBeatAt(this.teamBeat) : this.secPerBeat
    this.teamBeat += (dt / spbNow) * (this.manualTempo || 1)
    if (this.teamBeat > total) this.teamBeat = total

    const mine = chosen[this.myPart]
    const midi = mine ? mine.midi : null
    // 音头：音高跳变，或者从静音进来
    const onset =
      midi != null &&
      (this._manPrev == null || Math.abs(midi - this._manPrev) > 0.9 || this._manSilent > 0.15)
    this._manSilent = midi == null ? (this._manSilent || 0) + dt : 0
    if (onset) {
      const near = this._nearestOnset(part, this.teamBeat)
      if (near != null) {
        const err = near - this.teamBeat
        // 差超过两拍说明是点错了位置，不要硬拽回上一个音
        if (Math.abs(err) < 2) {
          this.teamBeat += Math.max(-0.25, Math.min(0.25, err * 0.35))
        }
      }
    }
    this._manPrev = midi
  }

  _nearestOnset(part, beat) {
    let best = null
    let bd = Infinity
    for (let i = 0; i < part.notes.length; i++) {
      if (part.notes[i].midi == null) continue
      const b = part.startBeats[i]
      const d = Math.abs(b - beat)
      if (d < bd) { bd = d; best = b }
    }
    return best
  }

  // 定音：不碰麦克风，只确保有 AudioContext 和提示音引擎，用当前音色发声
  async ensureCue() {
    if (!this.ctx) this.ctx = sharedCtx()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    if (!this.cue) this.cue = new CueEngine(this.ctx)
    this.cue.setVolume(this.settings.vol)
    this.cue.setTimbre(this.settings.timbre)
    return this.cue
  }

  async start(onFrame) {
    if (!this.score) return { error: '先载入谱面' }
    // 已经在跑或正在开麦：重复点击不能起第二路 getUserMedia / 第二条 rAF 循环
    if (this.running) return { error: null }
    if (this.starting) return { error: null }
    const token = ++this._startToken
    this.starting = true
    // iOS Safari：AudioContext 必须在用户手势的同步部分创建/恢复
    this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)()
    if (this.ctx.state === 'suspended') this.ctx.resume()
    let stream
    try {
      // 约束口径由 openMic 按设备能力决定：有些机型关掉 AEC/降噪/AGC 后
      // 拿到的时域数据量纲是错的（±256），YIN 会永远判成没声音，见 lib/audioInput.js
      stream = await openMic()
    } catch (e) {
      if (token !== this._startToken) return { error: null, cancelled: true }
      this.starting = false
      return { error: '需要麦克风权限：' + (e.message || e.name) }
    }
    // await 期间被 stop / 切页 / 播放打断：拿到流也要立刻关掉，
    // 否则会留下一个界面看不到、也停不掉的麦克风
    if (token !== this._startToken) {
      stream.getTracks().forEach((t) => t.stop())
      return { error: null, cancelled: true }
    }
    // 到 AudioContext.resume 之前都算"正在启动"，stop() 还能把它取消
    this.stream = stream
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    // resume 也是异步的，结束之后再确认一次没被打断
    if (token !== this._startToken) {
      stream.getTracks().forEach((t) => t.stop())
      this.stream = null
      return { error: null, cancelled: true }
    }
    this.starting = false

    this.src = this.ctx.createMediaStreamSource(this.stream)
    this.analyser = this.ctx.createAnalyser()
    // 频谱窗口按采样率取：频率分辨率不随设备采样率变化
    this.analyser.fftSize = fftSizeFor(this.ctx.sampleRate)
    this.analyser.smoothingTimeConstant = 0
    this.src.connect(this.analyser)

    this.yinSize = yinWindowSize(this.ctx.sampleRate)
    this.det = new YinDetector(this.ctx.sampleRate, this.yinSize)
    this.mp = new MultiPitch(this.ctx.sampleRate, this.analyser.fftSize)
    this.cue = this.cue || new CueEngine(this.ctx)
    this.cue.setVolume(this.settings.vol)
    this.cue.setTimbre(this.settings.timbre)
    this._rebuildFollowers()

    this.smoothedCents = null
    this.noiseFloor = NaN
    this.prevObsMidi = null
    this.prevRms = 0
    this.lastOnsetMs = 0
    this.silentMs = 0
    this.lastCorrectCue = 0
    this.metroLastBeat = -1
    this.frames = 0
    this.lastT = performance.now()
    this._tickAt = 0

    this.running = true
    this.onFrame = onFrame
    const loop = () => {
      if (!this.running) return
      const now = performance.now()
      const dt = (now - this.lastT) / 1000
      if (dt >= 1 / (this.fps * 1.15)) {
        this.lastT = now
        this._tick(Math.min(dt, 0.5))
        // 记下这次分析的时刻，供平滑位置外推用
        this._tickAt = now
      }
      if (this.onFrame) this.onFrame(this.frame, this)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
    return { ok: true }
  }

  // 两次分析之间的连续位置，给「画面滚动」用。
  //
  // 分析按 30fps 跑（多基频 + 谐波检验，跑不满 60fps），于是 teamBeat
  // 是每 33ms 跳一小格。拿这个格子值直接滚谱面，画面就是 30fps 的阶梯；
  // 而 rAF 是 60fps 的，一半的帧没有新值可画 —— 实测 80% 的帧谱面完全静止。
  //
  // 这里按「距离上次分析过去了多久」把位置往前推一点，让滚动每帧都有
  // 位移。只用于显示：判定、提示音仍然用真实分析出来的位置。
  smoothBeat() {
    if (!this.running) return this.teamBeat || 0
    const at = this._tickAt
    if (!at) return this.teamBeat || 0
    const dt = Math.max(0, Math.min(0.06, (performance.now() - at) / 1000))
    // 手动模式下时钟是匀速的，可以直接外推；自动模式速度由团队决定，
    // 外推同样成立——用的就是上一帧估出的 tempo
    const baseSpb = this.tempo ? this.tempo.secPerBeatAt(this.teamBeat) : this.secPerBeat
    const spb = baseSpb / (this.teamTempo || 1)
    return (this.teamBeat || 0) + dt / spb
  }

  stop() {
    // 作废还在等 getUserMedia 的那次 start
    this._startToken++
    this.starting = false
    this.running = false
    this._tickAt = 0
    cancelAnimationFrame(this.raf)
    if (this.cue) this.cue.stopSustain()
    if (this.src) { try { this.src.disconnect() } catch (e) {} this.src = null }
    if (this.analyser) { try { this.analyser.disconnect() } catch (e) {} }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null }
    this.frame = null
  }

  // 谐波结构评分（dB）：人声在 f0/2f0/3f0… 处有一根根谱峰，环境噪声的频谱是平的。
  _harmonicity(dbSpec, f0) {
    if (!dbSpec || !(f0 > 0)) return 0
    const binHz = (this.ctx.sampleRate / 2) / dbSpec.length
    let sum = 0, cnt = 0, hit = 0
    for (let h = 1; h <= 5; h++) {
      const f = f0 * h
      if (f > this.ctx.sampleRate * 0.45) break
      const b = Math.round(f / binHz)
      if (b < 3 || b >= dbSpec.length - 3) continue
      let peak = -Infinity
      for (let k = -1; k <= 1; k++) peak = Math.max(peak, dbSpec[b + k])
      // 基线取中位数而不是均值：合唱时旁边声部的谱峰会把均值抬上去，
      // 用均值会算出"峰比基线还低"，于是被误判成没人唱
      const around = []
      for (let k = -16; k <= 16; k++) {
        if (Math.abs(k) <= 1) continue
        const idx = b + k
        if (idx < 0 || idx >= dbSpec.length) continue
        around.push(dbSpec[idx])
      }
      if (around.length && isFinite(peak)) {
        around.sort((x, y) => x - y)
        const base = around[around.length >> 1]
        const d = peak - base
        sum += d; cnt++
        if (d >= 5) hit++          // 这一阶谐波确实高出基线一截
      }
    }
    // 单看平均不够：随机噪声偶尔也会冒出个别高谱峰。
    // 要求至少 3 个谐波都明显高于基线，才认它是有谐波列的人声。
    if (hit < 3) return 0
    return cnt ? sum / cnt : 0
  }


  _tick(dt) {
    const an = this.analyser
    if (!an) return
    if (!this.buf || this.buf.length !== an.fftSize) this.buf = new Float32Array(an.fftSize)
    an.getFloatTimeDomainData(this.buf)
    // YIN 用按采样率放大的窗口：窗口时长固定，音域下限才不会随采样率上升
    if (!this.yinBuf || this.yinBuf.length !== this.yinSize) this.yinBuf = new Float32Array(this.yinSize)
    this.yinBuf.set(this.buf.subarray(0, this.yinSize))
    // 频谱只取一次，谐波检验和多基频共用
    if (!this.dbSpec || this.dbSpec.length !== an.frequencyBinCount) {
      this.dbSpec = new Float32Array(an.frequencyBinCount)
    }
    an.getFloatFrequencyData(this.dbSpec)

    const r = this.det.detect(this.yinBuf)
    // 环境底噪：掉到新低点时快跟，回升时慢跟
    if (!isFinite(this.noiseFloor)) this.noiseFloor = r.rms
    if (r.rms < this.noiseFloor) this.noiseFloor += (r.rms - this.noiseFloor) * 0.25
    else this.noiseFloor += (r.rms - this.noiseFloor) * 0.0004   // 极慢，只作参考

    // 注意：这里不能用 YIN 判断"有没有人在唱"——YIN 是单音高算法，
    // 四个人一起唱时它找不到单一周期，会直接返回"没声音"。
    // 所以先估多基频，再用谐波结构把噪声产生的假音高筛掉。
    const raw = this.mp.estimate(this.dbSpec, Math.min(6, this.score.parts.length + 2))
    const solid = []
    let maxHarm = 0
    for (const f of raw) {
      const h = this._harmonicity(this.dbSpec, f.freq)
      if (h > maxHarm) maxHarm = h
      if (h >= 7) solid.push(f)
    }
    // 短时漏检就沿用上一帧：多基频总有零星帧检不出来，
    // 一检不出就冻结，整体会明显落后于团队
    let f0s
    if (solid.length) {
      this.lastF0s = solid
      this.lastF0sAt = performance.now()
      f0s = solid
    } else if (this.lastF0s && performance.now() - this.lastF0sAt < 220) {
      f0s = this.lastF0s
    } else {
      f0s = []
    }
    const voiced = f0s.length > 0 && r.rms > 0.006

    const parts = this.score.parts
    const nowMs = performance.now()
    const chosen = new Array(parts.length).fill(null)
    const midis = f0s.map((f) => f.midi)
    const pool = this._pool()

    // ---- 认领：每个声部从多基频里挑走自己该唱的那个音 ----
    for (let pi = 0; pi < parts.length; pi++) {
      const fl = this.followers[pi]
      if (!fl) continue
      const notes = parts[pi].notes
      const base = this._claimTarget(pi)
      let pick = pickForPart(f0s, base.midi, 2.5)
      // 当前这个音没认领到时，往后看两个音：一旦自己落后了（比如漏了几拍），
      // 只盯着当前音就永远追不回来，会卡死在原地
      if (!pick || !pick.exact) {
        for (let k = 1; k <= 2 && (!pick || !pick.exact); k++) {
          const t2 = notes[base.idx + k] ? notes[base.idx + k].midi : null
          const p2 = pickForPart(f0s, t2, 2.5)
          if (p2 && p2.exact) pick = p2
        }
      }
      const f = pick ? pick.f : null
      this.partExact = this.partExact || []
      this.partExact[pi] = !!(pick && pick.exact)
      const st = this.partState[pi]

      let onset = 0
      if (f) {
        if (st.prevMidi == null && st.silentMs > 60) onset = 2
        else if (st.prevMidi != null && Math.abs(f.midi - st.prevMidi) > 0.6) onset = 2
        st.prevMidi = f.midi
        st.silentMs = 0
      } else {
        st.prevMidi = null
        st.silentMs += dt * 1000
      }
      if (onset && nowMs - st.lastOnset < 150) onset = 0
      if (onset) st.lastOnset = nowMs
      this.partOnset = this.partOnset || []
      this.partOnset[pi] = onset
      chosen[pi] = f
    }

    // 声部开关变了就重建定位器，并重新定位一次。
    // 手动模式不靠听声定位，定位点由用户点谱面决定；这里进 cold 会把
    // target / 音分 / 提示音一起关掉，界面就变成一直显示"休止"。
    const poolKey = pool.join(',')
    if (!this.aligner || this._poolKey !== poolKey) {
      this._buildAligner()
      this._poolKey = poolKey
      if (this.phase === 'locked' && this.mode !== 'manual') this._enterCold()
    }

    // ---- 阶段机：手动模式走时钟；否则 cold 攒窗口定位 / locked 接着走 ----
    let anchor = -1
    let bestScore = 0
    if (this.mode === 'manual') {
      this._manualTick(dt, chosen)
    } else if (this.phase === 'cold') {
      this.aligner.add(dt, voiced ? midis : null, maxHarm)
      // 首次没有先验；重新定位时用"刚才在哪"当先验，免得跳到不相干的乐段。
      // 速度只在重新定位时才搜：首次窗口太短（不到 1 秒），估出来的速度是瞎猜的，
      // 实测会把 1.0 估成 0.8，直接导致定位偏慢。首次一律按谱面速度，
      // 真唱快唱慢由后面跟谱器自己适应。
      // ambigSec：最优与次优分不清时多攒多久。首次要尽快给反馈，不延；
      // 重新定位撞进重复乐段（欢乐颂 0-11 拍与 16-27 拍）时多等 0.6 秒，
      // 够唱到下一处和声变化再判，避免抛硬币锁错段。
      const s = this.aligner.solveIfReady(
        this.hasLocked ? this.coldFromBeat : 0,
        this._minDur(),
        this.hasLocked ? null : [1.0],
        this.hasLocked ? 2.0 : 0
      )
      if (s) {
        this.phase = 'locked'
        this.hasLocked = true
        this.coldFail = 0
        this.teamBeat = s.beat
        this.teamTempo = s.tempo
        for (let pi = 0; pi < parts.length; pi++) {
          const pos = this._posAtBeat(parts[pi], s.beat)
          const start = parts[pi].startBeats[pos] || 0
          // 这个音已经唱了多久：变速谱要按速度表算秒数
          const spb = this.tempo ? this.tempo.secPerBeatAt(s.beat) : this.secPerBeat
          this.followers[pi].jumpTo(pos, Math.max(0, (s.beat - start) * spb / (s.tempo || 1)))
        }
        this.mismatchMs = 0
      } else if (this.hasLocked) {
        // 重定位期间音乐还在走，按已知速度外推，免得谱面卡死在原地
        const spb = this.tempo ? this.tempo.secPerBeatAt(this.teamBeat) : this.secPerBeat
        this.teamBeat += dt / (spb / (this.teamTempo || 1))
      }
      anchor = -1
      bestScore = 0
    } else {
      // 已锁定：各声部只在自己位置附近小范围推进
      for (let pi = 0; pi < parts.length; pi++) {
        const fl = this.followers[pi]
        if (!fl) continue
        const f = chosen[pi]
        fl.push(
          { midi: f ? f.midi : null, clarity: f ? 0.85 : 0, voiced: !!f },
          dt, this.partOnset[pi] || 0,
          { lo: fl.pos - LOCK_BACK, hi: fl.pos + LOCK_FWD }
        )
      }

      // 团队位置：所有声部共用同一条时间轴，所以只要有一个跟得住就够了。
      // 挑"当前还在唱、且跟得最稳"的那个声部当锚——比投票平均稳健，
      // 不会因为几个没跟上的声部把整体拖慢。
      anchor = -1
      bestScore = -1
      for (const pi of pool) {
        const fl = this.followers[pi]
        if (!fl || !chosen[pi]) continue
        if (!(this.partExact && this.partExact[pi])) continue        // 差八度的不算数
        const sc = fl.confidence()
        if (sc > bestScore) { bestScore = sc; anchor = pi }
      }
      // 一个精确认领都没有时，退而求其次用八度的，总比卡住强
      if (anchor < 0) {
        for (const pi of pool) {
          const fl = this.followers[pi]
          if (!fl || !chosen[pi]) continue
          const sc = fl.confidence() * 0.5
          if (sc > bestScore) { bestScore = sc; anchor = pi }
        }
      }
      if (anchor >= 0) {
        const b = parts[anchor].startBeats[this.followers[anchor].pos] || 0
        // 音乐只往前：小幅修正可以，大步倒退忽略（真要重来会连续多帧坚持）
        this.teamBeat = b < this.teamBeat - 1 ? this.teamBeat : b
      }

      // 监控：听到的和声跟谱面此刻对不对得上。
      // 这才是"要不要重新定位"的依据，锁定期间不重复做全谱搜索。
      // 只拿"精确认领到自己音高"的声部去比对。
      // 差一个八度认领上的不算——solo 时别的声部会把 Bass 的 C3 当成自己的 C4 认走，
      // 于是凭空多出几个对不上的期望音，代价被拉高到一直判定失配。
      const only = new Set()
      for (const pi of pool) {
        const k = this.alignerParts.indexOf(pi)
        if (k >= 0 && chosen[pi] && this.partExact[pi]) only.add(k)
      }
      if (voiced && midis.length && only.size) {
        const c = this.aligner.costAt(this.teamBeat, midis, only)
        this.matchCost = c
        this.mismatchMs = c > MISMATCH_COST
          ? this.mismatchMs + dt * 1000
          : Math.max(0, this.mismatchMs - dt * 600)
        if (this.mismatchMs > MISMATCH_MS) this._enterCold()
      } else {
        // 没检出音（休止或漏检）不算对不上，别动不动就重新定位
        this.mismatchMs = Math.max(0, this.mismatchMs - dt * 400)
      }
    }
    const teamBeat = this.teamBeat

    // ---- 我该唱什么：由团队位置决定，不是由我自己 ----
    const myPart = parts[this.myPart]
    const sb = myPart.startBeats
    const dpos = this._posAtBeat(myPart, teamBeat)
    // 冷启动还没定位好时不知道"该唱什么"，就不显示、也不出声，免得误导
    const locked = this.phase === 'locked'
    const target = locked && myPart.notes[dpos] ? myPart.notes[dpos].midi : null

    const mine = chosen[this.myPart]
    let cents = null
    if (mine && target != null) {
      let d = mine.midi - target
      while (d > 6) d -= 12
      while (d < -6) d += 12
      cents = d * 100
      this.smoothedCents = this.smoothedCents == null ? cents : this.smoothedCents * 0.6 + cents * 0.4
    } else {
      this.smoothedCents = this.smoothedCents == null ? null : this.smoothedCents * 0.8
    }

    let next = null
    for (let k = dpos + 1; k < myPart.notes.length; k++) {
      if (myPart.notes[k].midi != null) { next = myPart.notes[k].midi; break }
    }

    // 我唱的音高轨迹，按"团队此刻在哪"记，用来画曲线
    this.trace.push({ pos: dpos, midi: mine ? mine.midi : null, cents, clarity: mine ? 0.85 : 0 })
    if (this.trace.length > 320) this.trace.shift()

    if (locked) this._cue(dpos, target, next, myPart.notes, cents)

    const conf = anchor >= 0 ? bestScore : 0
    const lost = this.followers[this.myPart].mismatchFrames > 12
    const beatNow = sb[dpos] || 0

    this.frames++
    this.frame = {
      pos: dpos,
      target,
      next,
      cents: this.smoothedCents,
      obsMidi: mine ? mine.midi : null,
      voiced: !!mine,
      silent: voiced ? 0 : (this.silentFrames = (this.silentFrames || 0) + 1),
      mismatch: this.followers[this.myPart].mismatchFrames > 12,
      hold: this.followers[this.myPart].hold[this.followers[this.myPart].pos],
      level: Math.min(1, r.rms * 12),
      hasAnchor: anchor >= 0,
      soloMode: !!this._solo,
      locked,
      manual: this.mode === 'manual',
      coldDur: this.aligner ? this.aligner.dur : 0,
      coldFail: this.coldFail || 0,
      heard: f0s.length > 0,
      matchCost: this.matchCost == null ? null : +this.matchCost.toFixed(2),
      dbg: { freq: Math.round(r.freq), clarity: +r.clarity.toFixed(2), rms: +r.rms.toFixed(4),
             nf: +this.noiseFloor.toFixed(4),
             harm: f0s.length ? +this._harmonicity(this.dbSpec, f0s[0].freq).toFixed(1) : 0,
             f0n: f0s.length,
             midis: f0s.map((f) => Math.round(f.midi)),
             want: parts.map((pp) => (pp.notes[this.followers[parts.indexOf(pp)].pos] || {}).midi) },
      conf,
      lost,
      beatNow,
      teamBeat,
      bar: Math.floor(beatNow / this.score.bar) + 1,
      beatInBar: Math.floor(beatNow % this.score.bar) + 1,
      total: myPart.notes.length,
      // 各声部的情况，用来显示"谁在唱"
      parts: parts.map((p, pi) => ({
        target: (p.notes[this._posAtBeat(p, teamBeat)] || {}).midi ?? null,
        active: !!chosen[pi],
        strength: chosen[pi] ? chosen[pi].strength : 0,
      })),
    }
  }

  // 某个声部在给定拍上唱的是第几个音
  _posAtBeat(part, beat) {
    let i = 0
    for (let k = 0; k < part.startBeats.length; k++) {
      if (part.startBeats[k] <= beat + 1e-6) i = k
      else break
    }
    return i
  }

  _cue(pos, target, next, notes, cents) {
    const st = this.settings
    const oct = st.oct * 12

    if (pos !== this.lastPos) {
      this.lastPos = pos
      this.nextCuedFor = -1
      if (target != null) {
        if (st.mode === 'cue') this.cue.tone(midiToFreq(target + oct), 0.22, 0.85)
        else if (st.mode === 'sustain') this.cue.startSustain(midiToFreq(target + oct), 0.35)
      } else if (st.mode === 'sustain') {
        this.cue.stopSustain()
      }
    }
    if (st.mode === 'sustain' && target == null) this.cue.stopSustain()

    if (st.mode === 'correct' && cents != null && Math.abs(cents) > st.thresh) {
      const t = performance.now()
      if (t - this.lastCorrectCue > 900) {
        this.lastCorrectCue = t
        this.cue.tone(midiToFreq(target + oct), 0.3, 0.9)
      }
    }

    if (st.nextCue && next != null && this.nextCuedFor !== pos && st.advance > 0) {
      const fp = this.followers[this.myPart]
      const elapsed = fp.hold[fp.pos]
      const expectSec = fp._expectSec ? fp._expectSec(pos) : Math.max(0.08, (notes[pos] ? notes[pos].beats : 1) * fp.secPerBeat)
      if (Math.max(0, expectSec - elapsed) <= st.advance / 1000) {
        this.nextCuedFor = pos
        this.cue.tone(midiToFreq(next + oct), 0.16, 0.42)
      }
    }

    if (st.metro) {
      // 节拍器按团队走，这样我慢了会明显听出来
      const b = Math.floor(this.teamBeat)
      if (b !== this.metroLastBeat) {
        this.metroLastBeat = b
        this.cue.click(Math.floor(this.teamBeat) % this.score.bar === 0, 0.8)
      }
    }
  }
}
