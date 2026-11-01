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
    // 复用的 env 可能还连着上一轮的目标。连接是叠加的：同一个 env
    // 连同一个目标两次，信号会被送进去两遍，响度翻倍、相位叠加，
    // 听感就是发毛、发刺。所以只在目标变了的时候重新接。
    if (env.__target !== target) {
      try { env.disconnect() } catch (e) { /* 本来就没连 */ }
      try { env.connect(target) } catch (e) { /* 目标已失效 */ }
      env.__target = target
    }

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
    // 起音时刻不能早于"现在"。
    //
    // when 是提前排期的时间点，正常情况下在未来；但排期迟到（主线程卡顿、
    // 起播时 LEAD 已过）时 when 会落在过去。此时 setValueAtTime(0.0001, when)
    // 会立刻把增益从当前值跳到 0.0001 —— 一个满幅阶跃，就是"刺啦"声。
    // 钳到 now 之后，包络至少还有完整的起音段。
    const now = this.ctx.currentTime
    const t0 = Math.max(when, now + 0.002)
    try {
      g.cancelScheduledValues(t0)
      g.setValueAtTime(0.0001, t0)
      g.linearRampToValueAtTime(peak, t0 + attack)
      if (opt.sustain) {
        g.linearRampToValueAtTime(peak * 0.9, t0 + Math.min(dur * 0.3, 0.12))
        g.setValueAtTime(peak * 0.9, Math.max(t0 + attack, end - release))
      } else if (opt.decay) {
        const dec = Math.min(t0 + Math.max(0.08, opt.decay), end - 0.005)
        g.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.22), dec)
      } else {
        const settle = Math.min(t0 + attack + Math.max(0.12, dur * 0.25), end - release)
        g.linearRampToValueAtTime(peak * 0.88, settle)
        g.setValueAtTime(peak * 0.88, Math.max(settle, end - release))
      }
      g.linearRampToValueAtTime(0.0001, Math.max(end, t0 + 0.01))
    } catch (e) { /* 参数异常时保持静音 */ }

    src.start(t0)
    try { src.stop(Math.max(end, t0) + 0.05) } catch (e) {}

    const entry = { src, env, endAt: Math.max(end, t0) + 0.05, pool: this }
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
      // 回收条件要留出包络走完的时间。
      //
      // 包络在 end 才降到 0.0001，而 endAt = end + 0.05。之前用
      // `endAt <= now + 0.02` 判定，等于在包络还在下降时就把它强行
      // setValueAtTime(0.0001) —— 那是一个阶跃，听感就是"刺啦"的电流声。
      // 现在必须等包络真正结束（endAt 之后再留 60ms 余量）才回收。
      if (v.endAt + 0.06 <= now) {
        try { v.src.disconnect() } catch (e) {}
        // AudioBufferSourceNode 不能复用，丢掉；env 还回去。
        // 归还前先确认增益已经到底，避免下次复用时从半空中起步。
        try {
          v.env.gain.cancelScheduledValues(now)
          v.env.gain.setValueAtTime(0.0001, now)
        } catch (e) {}
        try { v.env.disconnect() } catch (e) {}
        // 断开后目标标记作废，下次复用时必须重新连
        v.env.__target = null
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
      // 先淡出再断开：直接 disconnect 会在波形中途切断，产生爆音。
      // 淡出时间 20ms，足够听不出来又不会拖慢停止响应。
      try {
        v.env.gain.cancelScheduledValues(now)
        v.env.gain.setValueAtTime(Math.max(0.0001, v.env.gain.value), now)
        v.env.gain.linearRampToValueAtTime(0.0001, now + 0.02)
      } catch (e) {}
      try { v.src.stop(now + 0.03) } catch (e) {}
      // 断开延后到淡出走完：立刻 disconnect 会让淡出来不及被听到
      const env = v.env
      const src = v.src
      setTimeout(() => {
        try { src.disconnect() } catch (e) {}
        try { env.disconnect() } catch (e) {}
        try { env.gain.cancelScheduledValues(0) } catch (e) {}
        env.__target = null
      }, 60)
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
