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
import { TempoMap } from './tempo.js'

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
    this._nativeWatch = null
    // 原生通路失败后的冷却：过一段时间再试，不永久禁用。
    // AAudio 流被系统停掉是暂时的（通话结束、音频焦点回来就能恢复）。
    this._nativeRetryAt = 0
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
      // 位置同步只留一路：nativeaudio 的内部轮询（50ms）负责更新 native._beat，
      // 这里不再另起一条 80ms 的跨桥查询。
      // 之前两条并存，等于每秒 32 次 Capacitor 桥调用，每次都要序列化
      // JSON 并在主线程排队——播放时它会和绘制抢同一个线程。
      this._startNativeRaf()
      this._watchNativeAlive(score, opts)
      return true
    } catch (e) {
      this.useNative = false
      return false
    }
  }

  // 原生播放的身体检查：起播后一秒，位置如果没动就判定原生通路失效，
  // 当场改走 Web Audio。
  //
  // 原生侧 AAudio 流会被系统停掉（来电、别的应用抢音频焦点、蓝牙切换），
  // 而 JS 这边 playScore/play 都返回成功，界面上就成了「点了播放、
  // 进度条停在 0、没有声音」。这种失败必须自己发现，不能等用户察觉。
  _watchNativeAlive(score, opts) {
    if (this._nativeWatch) clearTimeout(this._nativeWatch)
    this._nativeWatch = setTimeout(() => {
      this._nativeWatch = null
      if (!this.useNative || !this.native) return
      // 判定依据必须是「原生真的报过的位置」，不能读 beatNow()：
      // 后者会按 bpm 外推，流停掉之后它照样每帧往前加，看起来像在播放。
      // 只有 _beat 是原生 getPositionBeats() 真正返回过的值。
      const moved = (this.native._beat || 0) - (this.native._beat0 || 0)
      if (Math.abs(moved) > 0.05) return
      // 位置没推进：原生流已失效。停掉它，当场改走 Web Audio，
      // 让这一声不要哑掉。
      this.useNative = false
      if (this._nativeSync) { cancelAnimationFrame(this._nativeSync); this._nativeSync = null }
      // 冷却 8 秒：太短会在音频焦点仍然没回来时反复起播失败，
      // 每次都白等 80ms 探测；太长则通话结束后迟迟回不到原生。
      this._nativeRetryAt = performance.now() + 8000
      if (this.native) this.native.pause().catch(() => {})
      if (!this.state && !this._fallbackRunning) {
        this._fallbackRunning = true
        this._playWebAudio(score, opts).finally(() => { this._fallbackRunning = false })
      }
    }, 1000)
  }

  // 原生播放期间按帧读位置。
  //
  // 读的是 nativeaudio 已经轮询好的缓存值（同步读一个 number），
  // 不发起跨桥调用：跨桥是异步的，放在每帧的渲染循环里要么等
  // 一个微任务、要么读到过期值，而且桥本身在主线程上排队。
  // 缓存由 nativeaudio 的 50ms 轮询刷新，对 UI 已经足够。
  _startNativeRaf() {
    if (this._nativeSync) cancelAnimationFrame(this._nativeSync)
    const step = () => {
      if (!this.useNative || !this.native) { this._nativeSync = null; return }
      this._nativeBeatCache = this.native.beatNow()
      this._nativeSync = requestAnimationFrame(step)
    }
    this._nativeSync = requestAnimationFrame(step)
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
    // 变速谱里"经过的秒数 × 固定 spb"会给错位置，要按速度表反解。
    // 速度表已经是相对全曲开头的，减去 from 对应的秒数即可。
    const elapsed = s.ctx.currentTime - s.startAt
    const b = s.tempo.beatAt(s.tempo.secAt(s.from) + elapsed)
    return Math.min(s.total, Math.max(s.from, b))
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
    //
    // partVols 只看这份谱真实存在的声部：它是随设置持久化的，
    // 换到声部更少的谱之后，数组尾上会留着一串没人用的旧值。
    // 之前不裁剪，某个旧值只要小于 1 就永远判定「要混音」，
    // 原生引擎从此再也不会被启用，声音也一直停在 Web Audio 上。
    const partCount = score.parts.length
    const mixerOn = Array.isArray(opts.partVols) &&
      opts.partVols.slice(0, partCount).some((v) => v != null && v < 0.999)
    const wantsMixer = mixerOn || !!opts.metro
    // 最近一次尝试原生失败过就冷却一段时间再试，不要永久禁用：
    // AAudio 流被系统停掉是暂时的（通话结束、音频焦点回来就能恢复），
    // 一个会话里彻底不用原生会让之后所有播放都退到较差的 Web Audio。
    const cooledDown = !this._nativeRetryAt || performance.now() >= this._nativeRetryAt
    const usedNative = (wantsMixer || !cooledDown)
      ? false
      : await this._tryNative(score, opts)
    if (usedNative) return true

    return this._playWebAudio(score, opts)
  }

  async _playWebAudio(score, opts = {}) {
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
    // 播放速率：改 rate 就是变速，音高不受影响——每个音都是按目标频率
    // 从采样变调（或合成）出来的，不依赖播放速度。
    const rate = Math.max(0.5, Math.min(2, opts.rate || 1))
    // 谱面中途变速时，拍和秒之间不再是线性关系，统一交给速度表换算。
    // 单速谱（tempos 为空）会退化成一条直线，和以前的 spb 完全等价。
    //
    // opts.bpm 是调用方显式覆盖的速度（谱库试听会传）。既然要覆盖，
    // 就把整条速度表按同一比例缩放，而不是只改第一段——否则覆盖之后
    // 中段又跳回谱面标注的速度。
    const tempos = Array.isArray(score.tempos) && score.tempos.length && opts.bpm
      ? score.tempos.map((t) => ({ beat: t.beat, bpm: (t.bpm || bpm) * (bpm / (score.bpm || bpm)) }))
      : score.tempos
    const tempo = new TempoMap(tempos, bpm, rate)
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
      tempo,
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
    const tp = s.tempo
    // 拍 → 音频时间的换算统一走速度表：它已经含了 rate，
    // 变速谱的每一段都按自己的速度排期。
    // 基准偏移一次算好：每个音都调一次 secAt(from) 是纯浪费。
    const base = tp.secAt(s.from)
    const atOf = (beat) => s.startAt + (tp.secAt(beat) - base)

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
        const at = atOf(b)
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
        if (atOf(st) > horizon) break
        const begin = Math.max(st, s.from)
        const end = Math.min(st + n.beats, s.total)
        // 时值也要按速度表算：跨过速度变化点的音会被拉长或压短
        const dur = tp.secAt(end) - tp.secAt(begin)
        if (n.midi != null && dur > 0.02) {
          const when = Math.max(now + 0.005, atOf(begin))
          this._scheduleNote(s, n, notes[line.idx + 1], when, dur, line)
          this.count++
        }
        line.idx++
      }
    }

    // 结束判定用同一套换算，别在这里再算一遍 secAt
    if (now > atOf(s.total) + 0.3) this._finish()
  }

  // 排一个音。滑音、连音、跳音、重音都在这里落地——
  // 它们都只改变"这一个音怎么响"，不改变时间轴。
  _scheduleNote(s, n, next, when, dur, line) {
    // 每个音带着自己的力度（没标就是 mf）。之前所有音固定 gain，
    // 整首听起来是平的，强弱完全做不出来。
    let vel = n.vel == null ? 1 : Math.max(0.05, Math.min(1.4, n.vel / 0.58))
    // 重音：往上抬一点，marcato 抬得更多
    if (n.accent === 1) vel *= 1.25
    else if (n.accent >= 2) vel *= 1.5
    // 跳音：时值压到一半，听感上才是"断的"
    const lenMul = n.staccato ? 0.5 : 1
    // 留 6% 的间隙，同音反复才听得出是两个音；
    // 连音线里的音不间隙，否则听起来还是一颗颗独立的音
    const gapMul = n.slurStop || n.slurStart ? 1 : 0.94

    // 滑音：从本音连续滑到下一个音。
    // 谱面只在源音上标 <glissando type="start">，目标音是下一个音。
    //
    // 时值上限 1.2 秒：滑音是"从这个音滑到那个音"的过程，不是让源音
    // 拖满整个时值再滑。源音标成 8 拍（两个全音符）时，滑 4 秒会变成
    // 一个持续的警笛，而且和目标音整段重叠。真实演奏里滑音总在前面
    // 完成，后面的时间留给目标音。
    if (n.gliss && next && next.midi != null) {
      const glideSec = Math.min(Math.max(0.06, dur * lenMul), 1.2)
      const ok = s.cue.slide(
        midiToFreq(n.midi), midiToFreq(next.midi),
        glideSec, s.gain * vel, when, line.out
      )
      if (ok) return
      // 采样引擎不支持滑音时退回普通音，不要整段没声
    }

    s.cue.tone(midiToFreq(n.midi), Math.max(0.06, dur * lenMul * gapMul), s.gain * vel, when, line.out)
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
    if (this._nativeSync) { cancelAnimationFrame(this._nativeSync); this._nativeSync = null }
    if (this._nativeWatch) { clearTimeout(this._nativeWatch); this._nativeWatch = null }
    // useNative 无论有没有 native 实例都要清：否则上一次原生播放留下的
    // true 会一直挂着，下次读 beat / totalBeats 还在走原生分支，
    // 拿到的是上一首的旧位置（实测停止后 beat 仍是 48.6，超出总长 32）。
    const wasNative = this.useNative
    this.useNative = false
    this._nativeBeatCache = null
    if (wasNative && this.native) {
      this.native.pause()
      return
    }
    if (!this.state) return
    this._close(this.state)
  }
}
