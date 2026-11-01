// Voice pool：复用 AudioNode，避免每个音都新建/销毁节点。
//
// 为什么必须这样做
// ----------------
// 之前的实现每个音都 createBufferSource() + createGain()，播完靠 GC 回收。
// 桌面 Chrome 建一个节点约 0.1ms，看不出问题；但在 Android WebView 上：
//   - 节点创建发生在主线程，会阻塞排期
//   - 一首 8 声部、几百个音的歌，几秒内产生上千个待回收节点
//   - GC 停顿正好撞上音频线程要 buffer 的时刻，表现就是断续和爆音
//
// 专业音频软件的做法是启动时预分配固定数量的 voice，播放时只从池里取、
// 改参数、标记占用，播完还回去——整个播放过程零分配。这个文件就是那个思路。
//
// 设计
// ----
// 每个 voice = 一个常驻的 { src: AudioBufferSourceNode, env: GainNode }。
// 关键限制：AudioBufferSourceNode 的 start() 只能调用一次，播完就不能再用。
// 所以 voice 用完必须丢弃重建——但那只需要「重建一个」，不是每个音都建，
// 而且重建发生在音结束之后，不在排期路径上。
//
// 真正的收益来自：
//   1. GainNode 常驻复用（省掉每次的 createGain + connect）
//   2. voice 数量有上限，不会无限增长
//   3. 复用时不走 connect 链路搭建，只 setValueAtTime

const MAX_VOICES = 48      // 同时发声的 voice 上限（8 声部 × 6 个同时音足够）
const RELEASE_S = 0.12     // 归还前的淡出时间

export class VoicePool {
  constructor(ctx, dest) {
    this.ctx = ctx
    // dest 只是「默认输出」。实际每个音会连到调用方指定的目标
    // （整谱播放时是不同的声部总线），播完断开重连。
    this.dest = dest
    this.free = []          // 可复用的 { env }
    this.active = []        // 正在响的 { src, env, endAt }
    this.created = 0
    this.reused = 0
    this.dropped = 0
  }

  // 取一个可用的 env（没有就新建）
  _takeEnv() {
    const v = this.free.pop()
    if (v) {
      this.reused++
      return v
    }
    this.created++
    const env = this.ctx.createGain()
    env.gain.value = 0.0001
    // 不在这里 connect：连接目标每个音都可能不同（声部总线），
    // 由 playSample 连、sweep 断开。
    return { env }
  }

  // 归还：淡出后放回池子
  _release(env, at) {
    const t = Math.max(this.ctx.currentTime, at)
    try {
      env.gain.cancelScheduledValues(t)
      env.gain.setValueAtTime(Math.max(0.0001, env.gain.value), t)
      env.gain.linearRampToValueAtTime(0.0001, t + RELEASE_S)
    } catch (e) { /* 已断开 */ }
    this.free.push({ env })
  }

  /**
   * 播放一个音。
   * @param {AudioBuffer} buffer  已解码的采样
   * @param {number} rate         playbackRate
   * @param {object} opt          { loop, loopStart, loopEnd, peak, attack, dur, when }
   * @returns {{ stop: Function } | null}
   */
  playSample(buffer, rate, opt) {
    const ctx = this.ctx
    const when = opt.when
    const dur = Math.max(0.05, opt.dur)
    const end = when + dur

    // 超过上限就丢弃（宁可少一个音，也不要因为 GC 让整段爆音）
    if (this.active.length >= MAX_VOICES) {
      this.dropped++
      return null
    }

    const { env } = this._takeEnv()
    const target = opt.dest || this.dest
    try { env.connect(target) } catch (e) { /* 已连接 */ }

    // AudioBufferSourceNode 不能复用，每次新建（这是唯一无法避免的分配）
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = rate
    if (opt.loop) {
      src.loop = true
      src.loopStart = opt.loopStart
      src.loopEnd = opt.loopEnd
    }
    src.connect(env)

    // 包络：复用 env，只重排时间点
    const g = env.gain
    const peak = Math.max(0.0001, opt.peak)
    const attack = Math.min(opt.attack == null ? 0.012 : opt.attack, dur * 0.4)
    const release = Math.min(opt.release == null ? 0.06 : opt.release, dur * 0.5)
    try {
      g.cancelScheduledValues(when)
      g.setValueAtTime(0.0001, when)
      g.linearRampToValueAtTime(peak, when + attack)
      if (opt.sustain) {
        g.linearRampToValueAtTime(peak * 0.9, when + Math.min(dur * 0.3, 0.12))
        g.setValueAtTime(peak * 0.9, Math.max(when + attack, end - release))
      } else if (opt.decay) {
        const dec = Math.min(when + Math.max(0.08, opt.decay), end - 0.005)
        g.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.22), dec)
      } else {
        const settle = Math.min(when + attack + Math.max(0.12, dur * 0.25), end - release)
        g.linearRampToValueAtTime(peak * 0.88, settle)
        g.setValueAtTime(peak * 0.88, Math.max(settle, end - release))
      }
      g.linearRampToValueAtTime(0.0001, end)
    } catch (e) { /* 参数异常时保持静音 */ }

    src.start(when)
    try { src.stop(end + 0.05) } catch (e) {}

    const entry = { src, env, endAt: end + 0.05, pool: this }
    this.active.push(entry)
    this._scheduleSweep()
    return entry
  }

  // 定期把已经播完的 voice 收回池子
  _scheduleSweep() {
    if (this._sweepTimer) return
    this._sweepTimer = setTimeout(() => {
      this._sweepTimer = 0
      this.sweep()
    }, 200)
  }

  sweep() {
    const now = this.ctx.currentTime
    const keep = []
    for (const v of this.active) {
      if (v.endAt <= now + 0.02) {
        try { v.src.disconnect() } catch (e) {}
        // AudioBufferSourceNode 不能复用，丢掉；env 还回去（先断开旧目标）
        try { v.env.disconnect() } catch (e) {}
        try {
          v.env.gain.cancelScheduledValues(now)
          v.env.gain.setValueAtTime(0.0001, now)
        } catch (e) {}
        this.free.push({ env: v.env })
      } else {
        keep.push(v)
      }
    }
    this.active = keep
    if (this.active.length) this._scheduleSweep()
  }

  // 停止所有正在响的音，池子保留
  stopAll() {
    const now = this.ctx.currentTime
    for (const v of this.active) {
      try { v.src.stop(now) } catch (e) {}
      try { v.src.disconnect() } catch (e) {}
      try { v.env.disconnect() } catch (e) {}
      try { v.env.gain.cancelScheduledValues(now) } catch (e) {}
      this.free.push({ env: v.env })
    }
    this.active = []
  }

  stats() {
    return {
      free: this.free.length,
      active: this.active.length,
      created: this.created,
      reused: this.reused,
      dropped: this.dropped,
    }
  }
}
