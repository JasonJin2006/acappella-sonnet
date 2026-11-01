// 整谱播放：按拍号把每个声部的音符排进 AudioContext 的时间轴，
// 用 CueEngine 现场合成，不需要采样文件。和跟谱的提示音各用一套引擎，
// 换播放音色不会影响提示音，播放时的电平也走自己的总线限幅。
//
// 调度是滚动的：只提前排 0.6 秒，所以一首三十秒的众赞歌也只有十几个
// 振荡器在排队，手机上不会因为一次排上千个音而卡住。

import { CueEngine } from './cue.js'
import { buildFxChain, disposeFxChain, panFor, partGainFor, reverbSeconds, makeImpulse, DEFAULT_FX } from './fx.js'
import { midiToFreq } from './music.js'
import { sharedCtx } from './sharedCtx.js'
import { NativePlayer, isNativeAvailable } from './nativeaudio.js'
import { loadTimbre } from './samples.js'

const LOOKAHEAD = 0.6 // 提前排多少秒的音
const PUMP_MS = 120 // 每 120ms 补一次排期
const LEAD = 0.18 // 按下播放到第一个音之间留的余量

export class ScorePlayer {
  constructor() {
    this.ctx = null
    this.cue = null
    this.timer = null
    this.state = null
    this.impulse = null // 混响脉冲响应缓存
    this.impulseKey = '' // 时长变了要重新生成
    this.count = 0 // 本次播放已排期的音符数，调试和验证用
    // 原生播放器：Android + API 26 时可用。可用就把渲染交给原生线程，
    // 彻底避免「JS 主线程卡 → 音频断续」。
    this.native = null
    this.useNative = false
    this._nativeBeatCache = null
    this._nativeTotalCache = null
    this._nativeSync = null
  }

  /**
   * 尝试用原生引擎播放。成功返回 true，失败静默退回 Web Audio。
   */
  async _tryNative(score, opts) {
    try {
      if (!(await isNativeAvailable())) return false
      if (!this.native) {
        this.native = new NativePlayer()
        if (!(await this.native.init())) {
          this.native = null
          return false
        }
      }
      const timbre = opts.timbre || 'choir'
      const ctx = sharedCtx()
      // 先算出这个谱实际用到的音高，解码和上传都只做这些：
      // 全量解码 28 个采样要 5.5 秒、全量上传 20MB 要 6 秒（实测），
      // 而一首谱通常只用得上其中一半
      const pickParts = Array.isArray(opts.parts) && opts.parts.length
        ? opts.parts.map((i) => score.parts[i]).filter(Boolean)
        : score.parts
      const used = []
      for (const p of pickParts) {
        for (const n of p.notes || []) if (n.midi != null) used.push(n.midi)
      }
      const loaded = await loadTimbre(ctx, timbre, used)
      if (!loaded) return false

      // 关键：不能等采样全部传完再开播。
      // 走一趟 Capacitor JSON 桥传 13MB PCM 实测要 6 秒，
      // 期间主线程被占满，界面掉到 20~36fps。
      // 原生侧缺采样时用「最接近的那个采样变调」，只是音色差一点，
      // 不会没声音。所以先传前几个把声音放出来，其余边播边补。
      await this.native.uploadTimbre(timbre, loaded, used, { limit: 3 })
      const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 120))
      idle(() => { this.native.uploadTimbre(timbre, loaded, used).catch(() => {}) })

      const ok = await this.native.playScore(score, {
        fromBeat: opts.fromBeat || 0,
        untilBeat: opts.untilBeat,
        bpm: opts.bpm,
        parts: opts.parts,
        volume: opts.volume,
        reverbMix: 0.18,
        onEnd: opts.onEnd,
      })
      if (!ok) return false
      this.useNative = true
      this._nativeBeatCache = this.native._from
      this._nativeTotalCache = this.native._total
      if (this._nativeSync) clearInterval(this._nativeSync)
      this._nativeSync = setInterval(async () => {
        if (!this.native || !this.useNative) return
        this._nativeBeatCache = await this.native.getPositionBeats()
      }, 80)
      return true
    } catch (e) {
      this.useNative = false
      return false
    }
  }

  get playing() {
    if (this.useNative) return !!this.native && this.native.playing
    return !!this.state
  }

  // 当前播放到第几拍。还没开始（LEAD 期间）停在起点。
  get beat() {
    if (this.useNative) {
      // 原生模式下位置由原生线程维护，这里返回最近一次轮询到的快照
      return this._nativeBeatCache != null ? this._nativeBeatCache : (this.native ? this.native._from : 0)
    }
    const s = this.state
    if (!s) return 0
    const t = (s.ctx.currentTime - s.startAt) / s.spb
    return Math.min(s.total, Math.max(s.from, s.from + t))
  }

  get totalBeats() {
    if (this.useNative) return this._nativeTotalCache != null ? this._nativeTotalCache : 0
    return this.state ? this.state.total : 0
  }

  get fromBeat() {
    if (this.useNative) return this.native ? this.native._from : 0
    return this.state ? this.state.from : 0
  }

  setVolume(v) {
    if (this.cue) this.cue.setVolume(v)
  }

  /**
   * 运行中改某个声部的音量（0 = 静音）。播放中即时生效，不用重播。
   *
   * 只对 Web Audio 通路有效。原生通路目前没有按声部音量的接口
   * （见 setPartMute 的说明），所以带混音的播放会走 Web Audio。
   */
  setPartVolume(partIndex, vol) {
    const s = this.state
    // 没在播放时改音量不应该报错：设置已经存进 settings，
    // 下次起播会按新值建节点
    if (!s) return false
    const v = Math.max(0, Math.min(1, vol))
    let hit = false
    for (const line of s.lines) {
      if (line.partIndex !== partIndex) continue
      // 用目标值直接设，不做渐变：拖动滑块时每帧都可能改一次，
      // 渐变会互相打断，听感反而是一串咔哒声
      line.out.gain.value = partGainFor(line.mixIndex) * v
      hit = true
    }
    return hit
  }

  /**
   * 预热原生引擎：解码 + 上传这个谱要用的采样。
   *
   * 为什么要有这一步：首次播放前什么采样都没上传，播放走到原生侧时
   * 才现传，单次过桥 150~590ms（实测 17 个共 6 秒），界面掉到 30fps。
   * 这些工作跟「用户点了播放」没有关系，可以在载入谱面之后、
   * 用户还在看谱的时候先做完。放过一次之后就命中缓存，再播是 0 开销。
   *
   * 失败一律静默：预热只是优化，不影响正常播放（真没预热到，
   * 播放时会走原来的路径补上）。
   */
  async warmup(score, opts = {}) {
    if (!score || !Array.isArray(score.parts) || !score.parts.length) return false
    try {
      if (!(await isNativeAvailable())) return false
      if (!this.native) {
        this.native = new NativePlayer()
        if (!(await this.native.init())) {
          this.native = null
          return false
        }
      }
      const timbre = opts.timbre || 'choir'
      const ctx = sharedCtx()
      const pickParts = Array.isArray(opts.parts) && opts.parts.length
        ? opts.parts.map((i) => score.parts[i]).filter(Boolean)
        : score.parts
      const used = []
      for (const p of pickParts) {
        for (const n of p.notes || []) if (n.midi != null) used.push(n.midi)
      }
      if (!used.length) return false
      const loaded = await loadTimbre(ctx, timbre, used)
      if (!loaded) return false
      await this.native.uploadTimbre(timbre, loaded, used)
      return true
    } catch (e) {
      return false
    }
  }

  setTimbre(name) {
    if (this.cue) this.cue.setTimbre(name)
  }

  // 试听一个音色：弹一个四声部和弦，选音色时不用先回跟谱页
  async audition(timbre, volume = 0.8) {
    const ctx = sharedCtx()
    if (ctx.state === 'suspended') {
      try { await ctx.resume() } catch (e) { /* 没有手势时静默失败 */ }
    }
    if (!this.cue) this.cue = new CueEngine(ctx)
    this.cue.setVolume(volume)
    this.cue.setTimbre(timbre)
    // 采样音色要等采样解码完，否则试听会先响一段合成音
    await this.cue.ready()
    const t0 = ctx.currentTime + 0.06
    for (const m of [48, 55, 60, 64]) {
      this.cue.tone(midiToFreq(m), 1.4, 0.2, t0)
    }
  }

  // opts:
  //   fromBeat   从第几拍开始（默认 0）
  //   untilBeat  只播到第几拍（谱库试听用）
  //   bpm        覆盖谱面速度
  //   parts      只播哪几个声部（默认全部）
  //   volume     0..1
  //   timbre     cue.js 里的音色名
  //   onEnd      播完或到 untilBeat 时回调
  async play(score, opts = {}) {
    this.stop()
    if (!score || !Array.isArray(score.parts) || !score.parts.length) return false

    // 优先原生引擎；不可用时静默退回 Web Audio。
    //
    // 例外：这次带了混音器设置（某个声部不是满音量）或要开节拍器时，
    // 直接走 Web Audio。原生侧只有 pan、没有按声部的增益和节拍器通道，
    // 走原生会出现「界面上静音了但还在响」这种对不上的情况。
    // 混音只影响听感，用 Web Audio 的代价可以接受（音色略差一点）。
    const wantsMixer =
      (Array.isArray(opts.partVols) && opts.partVols.some((v) => v != null && v < 0.999)) ||
      !!opts.metro
    const usedNative = wantsMixer ? false : await this._tryNative(score, opts)
    if (usedNative) return true

    const ctx = sharedCtx()
    if (ctx.state === 'suspended') {
      try { await ctx.resume() } catch (e) { /* 用户手势之外可能被拒，下面的排期仍会生效 */ }
    }
    if (!this.cue) this.cue = new CueEngine(ctx)
    this.cue.setVolume(opts.volume == null ? 0.85 : opts.volume)
    this.cue.setTimbre(opts.timbre || 'choir')
    // 采样音色要等解码完；最多等 2.5 秒，等不到就先用合成音色开播
    await this.cue.ready()

    const picks =
      Array.isArray(opts.parts) && opts.parts.length
        ? opts.parts
        : score.parts.map((_, i) => i)

    const bpm = Math.max(30, opts.bpm || score.bpm || 96)
    // 播放速率：改 spb 就是变速。音高不受影响——每个音都是
    // 按目标频率从采样变调（或合成）出来的，不依赖播放速度。
    const rate = Math.max(0.5, Math.min(2, opts.rate || 1))
    const spb = 60 / (bpm * rate)
    const from = Math.max(0, opts.fromBeat || 0)

    // 每个声部一张表：第 i 个音从第几拍开始
    const lines = []
    for (const i of picks) {
      const part = score.parts[i]
      if (!part || !part.notes || !part.notes.length) continue
      const starts = []
      let acc = 0
      for (const n of part.notes) {
        starts.push(acc)
        acc += n.beats
      }
      // 跳过 from 之前已经结束的音；正在响的音会被截短后接上
      let idx = 0
      while (idx < part.notes.length && starts[idx] + part.notes[idx].beats <= from + 1e-6) idx++
      // 记下原始声部下标：混音器按声部调音量时要靠它对回去，
      // 不能直接用 lines 的下标（可以只播某几个声部，两者会错开）
      lines.push({ part, starts, idx, total: acc, partIndex: i })
    }
    if (!lines.length) return false

    let total = Math.max(...lines.map((l) => l.total))
    if (opts.untilBeat != null) total = Math.min(total, opts.untilBeat)
    if (total <= from + 0.01) return false

    // 效果链：限幅、混响、声像都走 fx.js，和导出（render.js）用同一套参数。
    // 以前这两处各写一份，改一个另一个就不同步，导出的听感和试听对不上。
    this.count = 0
    // 低功耗模式下关掉混响：ConvolverNode 是这套链里最贵的节点，
    // 长脉冲响应在手机上会让音频线程持续高负载。
    const fx = { ...DEFAULT_FX, ...(opts.fx || {}) }
    if (opts.lowPower) fx.reverbMix = 0
    const fxKey = String(reverbSeconds(fx))
    if (!this.impulse || this.impulseKey !== fxKey) {
      this.impulse = makeImpulse(ctx, reverbSeconds(fx), 2.2)
      this.impulseKey = fxKey
    }
    const chain = buildFxChain(ctx, fx, this.cue.master, this.impulse)
    const { bus, limiter, reverb, wet, output } = chain

    // 每个声部一个声像 + 一个独立音量：混音器要能单独压/静某一个声部。
    // 之前只有 panFor，音量写死在 partGainFor，所以「只想听我的声部」
    // 这种最基本的练习需求做不到。
    const partVols = Array.isArray(opts.partVols) ? opts.partVols : null
    lines.forEach((line, i) => {
      const out = ctx.createGain()
      // 旋律略高于内声部，四个声部等音量时会听不清主旋律
      // partVols 按「声部下标」对齐，不是按 lines 下标：
      // 只播某几个声部时两者会错开，用错会把音量加到别的声部上
      const mix = partVols && partVols[line.partIndex] != null
        ? Math.max(0, Math.min(1, partVols[line.partIndex]))
        : 1
      out.gain.value = partGainFor(i) * mix
      if (ctx.createStereoPanner) {
        const pan = ctx.createStereoPanner()
        pan.pan.value = panFor(i, lines.length, fx)
        out.connect(pan)
        pan.connect(bus)
      } else {
        out.connect(bus)
      }
      line.out = out
      // 记下这条线在 lines 里的位置：partGainFor 按它决定旋律/内声部的基准音量
      line.mixIndex = i
    })

    this.state = {
      ctx,
      spb,
      from,
      total,
      lines,
      bus,
      limiter,
      reverb,
      wet,
      output,
      cue: this.cue,
      startAt: ctx.currentTime + LEAD,
      // 声部越多每个音越轻，四个声部大约各 0.24
      gain: (opts.gain == null ? 0.34 : opts.gain) / Math.sqrt(Math.max(1, lines.length) / 2),
      fx,
      onEnd: typeof opts.onEnd === 'function' ? opts.onEnd : null,
      // 节拍器：开播时就把状态定下来；运行中改这个字段生效
      metro: !!opts.metro,
      metroNextBeat: null,
      barLen: score.bar || 4,
    }

    this.timer = setInterval(() => this._pump(), PUMP_MS)
    this._pump()
    return true
  }

  _pump() {
    const s = this.state
    if (!s) return
    const now = s.ctx.currentTime
    const horizon = now + LOOKAHEAD

    // 节拍器：和音符一样提前排期，不靠 setInterval 准点。
    // 直接按「拍」排，所以变速播放时节拍器跟着快慢走。
    if (s.metro) {
      if (s.metroNextBeat == null) {
        // 从 from 的下一个整拍开始，避免一开播就响一下
        s.metroNextBeat = Math.ceil(s.from - 1e-6)
      }
      const barLen = s.barLen || 4
      while (true) {
        const b = s.metroNextBeat
        const at = s.startAt + (b - s.from) * s.spb
        if (at > horizon) break
        if (b >= s.total - 1e-6) break
        if (at >= now) {
          // 每小节第一拍重音，和跟唱时的节拍器口径一致。
          // 传 at 让它提前排在音频时间轴上，不受 JS 定时器抖动影响。
          s.cue.click(Math.abs(b - Math.round(b / barLen) * barLen) < 1e-6, 0.7, at)
        }
        s.metroNextBeat = b + 1
      }
    }

    for (const line of s.lines) {
      const notes = line.part.notes
      while (line.idx < notes.length) {
        const n = notes[line.idx]
        const st = line.starts[line.idx]
        if (st >= s.total - 1e-6) break
        // 还没进排期窗口就停下，等下一次补
        if (s.startAt + (st - s.from) * s.spb > horizon) break
        const begin = Math.max(st, s.from)
        const end = Math.min(st + n.beats, s.total)
        const dur = (end - begin) * s.spb
        if (n.midi != null && dur > 0.02) {
          const when = Math.max(now + 0.005, s.startAt + (begin - s.from) * s.spb)
          // 每个音带着自己的力度（没标就是 mf）。之前所有音固定 gain，
          // 整首听起来是平的，强弱完全做不出来。
          const vel = n.vel == null ? 1 : Math.max(0.05, Math.min(1.4, n.vel / 0.58))
          // 留 6% 的间隙，同音反复才听得出是两个音
          s.cue.tone(midiToFreq(n.midi), Math.max(0.06, dur * 0.94), s.gain * vel, when, line.out)
          this.count++
        }
        line.idx++
      }
    }

    if (now > s.startAt + (s.total - s.from) * s.spb + 0.3) this._finish()
  }

  _finish() {
    const s = this.state
    if (!s) return
    const cb = s.onEnd
    this._close(s)
    if (cb) cb()
  }

  _close(s) {
    this.state = null
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const ctx = s.ctx
    const t = ctx.currentTime
    try {
      s.bus.gain.cancelScheduledValues(t)
      s.bus.gain.setValueAtTime(s.bus.gain.value, t)
      // 5ms 淡出，停止和切歌都不会有爆音
      s.bus.gain.linearRampToValueAtTime(0.0001, t + 0.05)
    } catch (e) { /* 节点可能已被回收 */ }
    setTimeout(() => disposeFxChain(s), 400)
  }

  stop() {
    // 原生模式：停原生播放 + 停位置同步
    if (this._nativeSync) { clearInterval(this._nativeSync); this._nativeSync = null }
    if (this.useNative && this.native) {
      this.native.pause()
      this.useNative = false
      this._nativeBeatCache = null
      return
    }
    if (!this.state) return
    this._close(this.state)
  }
}
