// 原生音频引擎的 JS 适配层。
//
// 目标：让 ScorePlayer 在 Capacitor 环境下把整首谱面交给原生渲染线程，
// 从而彻底摆脱「JS 主线程卡 → 音频卡」的问题。
//
// 设计
// ----
//   - 首次使用时探测原生引擎是否可用（Android + API 26 + so 加载成功）
//   - 可用：把每一声部的采样转成 16-bit PCM 灌给原生，再灌音符事件，
//     之后用简单的定时器轮询 getPositionBeats() 更新 UI
//   - 不可用：所有方法返回 false，调用方继续走 Web Audio（桌面浏览器、
//     老 Android、以及开发时的 vite dev）
//
// 采样格式
// --------
//   原生侧只认 16-bit PCM。我们把 AudioBuffer 的 Float32 转成 Int16，
//   base64 编码后通过桥传过去。一首歌 26 种音色只传一次，
//   之后播放不再有桥接开销。

// 注意：这里不能静态 import '@capacitor/core'。
// 纯 Web 构建（npm run dev / 桌面浏览器）里 Capacitor 可能没有注入，
// 静态 import 会让整个模块在加载期抛错，连带播放器一起崩。
// 全部改成运行时探测 + try/catch。
let pluginPromise = null
let available = null

function capPlugin(name) {
  try {
    const C = typeof window !== 'undefined' ? window.Capacitor : null
    if (!C) return null
    if (typeof C.getPlatform === 'function' && C.getPlatform() !== 'android') return null
    // Capacitor 3+ 用 registerPlugin，4+ 也能从 Plugins 上取
    if (C.Plugins && C.Plugins[name]) return C.Plugins[name]
    if (typeof C.registerPlugin === 'function') return C.registerPlugin(name)
    return null
  } catch (e) {
    return null
  }
}

async function getPlugin() {
  if (pluginPromise) return pluginPromise
  pluginPromise = (async () => {
    const P = capPlugin('NativeAudio')
    if (!P) return null
    try {
      const res = await P.isAvailable()
      if (!res || !res.available) return null
      return P
    } catch (e) {
      return null
    }
  })()
  return pluginPromise
}

/**
 * 原生引擎是否可用。第一次调用会真正探测（异步），之后缓存结果。
 * @returns {Promise<boolean>}
 */
export async function isNativeAvailable() {
  if (available != null) return available
  const p = await getPlugin()
  available = !!p
  return available
}

/** 同步读取上次探测的结果（还没探测过返回 false）。 */
export function nativeAvailableSync() {
  return available === true
}

// AudioBuffer → base64 的 16-bit PCM
function bufferToBase64(buffer) {
  const ch = buffer.numberOfChannels
  const frames = buffer.length
  const total = frames * ch
  const out = new Int16Array(total)
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c)
    if (ch === 1) {
      for (let i = 0; i < frames; i++) {
        const v = Math.max(-1, Math.min(1, data[i]))
        out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
      }
    } else {
      // 交织
      for (let i = 0; i < frames; i++) {
        const v = Math.max(-1, Math.min(1, data[i]))
        out[i * ch + c] = v < 0 ? v * 0x8000 : v * 0x7fff
      }
    }
  }
  const bytes = new Uint8Array(out.buffer)
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

/**
 * 原生播放器：和 ScorePlayer 同样的接口子集，但渲染在原生线程。
 */
export class NativePlayer {
  constructor() {
    this.plugin = null
    this.ready = false
    this.sampleIds = new Map()   // `${timbreId}:${midi}` -> 原生 sample id
    this.nextSampleId = 0
    this._poll = null
    this._onEnd = null
    this._total = 0
    this._from = 0
    this._bpm = 96
    this.playing = false
  }

  async init() {
    if (this.ready) return true
    const p = await getPlugin()
    if (!p) return false
    this.plugin = p
    try {
      const res = await p.start({ sampleRate: 48000 })
      if (!res || !res.ok) return false
      this.ready = true
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * 把一个音色里「这次播放用得到」的采样灌进原生侧。
   *
   * 以前是整个音色全传：一个音色按小三度存一个采样，大约 28 个、
   * 两千万个样本、20MB PCM。首次播放要串行传完，主线程被桥接和
   * base64 解码占掉 8 秒，WebView 掉到 20fps（实测）。
   * 但一首谱顶多用得上中间十几个音，大部分采样根本发不出声。
   *
   * 所以按谱面实际音域挑：每个目标音高找最近的采样（就是
   * samples.js 里 sampleFor 的同一条规则），去重后只传这些。
   *
   * @param {string} timbreId
   * @param {{buffers: Array<{midi:number,buffer:AudioBuffer}>}} loaded
   * @param {number[]} [usedMidis] 谱面实际出现的音高；不给则退回全量
   * @param {{limit?:number}} [opts] limit：这次最多传几个（先出声用）
   */
  async uploadTimbre(timbreId, loaded, usedMidis, opts = {}) {
    if (!this.ready || !loaded || !loaded.buffers) return false
    // loaded.buffers 已经由 samples.js 按 usedMidis 挑过（见 pickEntries），
    // 这里直接全传即可。再做一次「最近邻去重」会把两端的音挤到同一个
    // 采样上，导致超出 3 半音的变调、共振峰跑偏。
    const want = loaded.buffers.slice()

    let sent = 0
    const limit = opts.limit == null ? Infinity : opts.limit
    for (const b of want) {
      if (sent >= limit) break
      const key = `${timbreId}:${b.midi}`
      if (this.sampleIds.has(key)) continue
      const id = this.nextSampleId++
      const b64 = bufferToBase64(b.buffer)
      await this.plugin.loadSample({
        id,
        pcm: b64,
        frames: b.buffer.length,
        channels: b.buffer.numberOfChannels,
        rootMidi: b.midi,
      })
      this.sampleIds.set(key, id)
      sent++
      // 每传一个就让出一次主线程：单个采样 1MB 左右的 base64 要过
      // JSON.stringify + 桥，实测 150~590ms。连着传会让界面长时间
      // 掉帧；让出之后同样的总时间被摊到多帧，观感上不再「卡死」。
      await new Promise((r) => {
        const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 60))
        idle(r, { timeout: 200 })
      })
    }
    return true
  }

  /**
   * 播放整份谱面。
   * @param {object} score
   * @param {object} opts { fromBeat, untilBeat, bpm, parts, volume, panWidth }
   */
  async playScore(score, opts = {}) {
    if (!this.ready) return false
    const parts = Array.isArray(opts.parts) && opts.parts.length
      ? opts.parts.map((i) => score.parts[i]).filter(Boolean)
      : score.parts
    const bpm = opts.bpm || score.bpm || 96
    const from = Math.max(0, opts.fromBeat || 0)

    // 收集所有事件
    const beats = []
    const lengths = []
    const midis = []
    const vels = []
    const pans = []
    let total = 0
    parts.forEach((p, pi) => {
      const pan = parts.length === 1 ? 0 : -0.35 + (0.7 * pi) / (parts.length - 1)
      let t = 0
      for (const n of p.notes) {
        if (n.midi != null && n.beats > 0) {
          beats.push(t)
          lengths.push(n.beats)
          midis.push(n.midi)
          vels.push(n.vel == null ? 0.58 : n.vel)
          pans.push(pan)
        }
        t += n.beats
      }
      total = Math.max(total, t)
    })
    if (opts.untilBeat != null) total = Math.min(total, opts.untilBeat)

    this._total = total
    this._from = from
    this._bpm = bpm
    this._onEnd = typeof opts.onEnd === 'function' ? opts.onEnd : null

    if (opts.volume != null) await this.plugin.setMasterGain({ gain: opts.volume })
    if (opts.reverbMix != null) await this.plugin.setReverbMix({ mix: opts.reverbMix })

    await this.plugin.playScore({
      beats, lengths, midis, velocities: vels, pans,
      fromBeat: from, totalBeats: total, bpm,
    })
    await this.plugin.play()
    this.playing = true
    this._startPoll()
    return true
  }

  _startPoll() {
    this._stopPoll()
    // 20Hz 足够 UI 顺滑，而且这个轮询只读一个 double，代价可以忽略
    this._poll = setInterval(async () => {
      if (!this.plugin) return
      try {
        const r = await this.plugin.getPositionBeats()
        if (r && !r.playing && this.playing) {
          this.playing = false
          this._stopPoll()
          const cb = this._onEnd
          this._onEnd = null
          if (cb) cb()
        }
      } catch (e) { /* 桥接偶发失败忽略 */ }
    }, 50)
  }

  _stopPoll() {
    if (this._poll) {
      clearInterval(this._poll)
      this._poll = null
    }
  }

  async getPositionBeats() {
    if (!this.plugin) return 0
    try {
      const r = await this.plugin.getPositionBeats()
      return r ? this._from + (r.beat || 0) : this._from
    } catch (e) {
      return this._from
    }
  }

  async pause() {
    if (this.plugin) await this.plugin.pause()
    this.playing = false
    this._stopPoll()
  }

  async seekToBeat(beat) {
    if (this.plugin) await this.plugin.seekToBeat({ beat })
  }

  async setVolume(v) {
    if (this.plugin) await this.plugin.setMasterGain({ gain: v })
  }

  async stats() {
    if (!this.plugin) return null
    try {
      return await this.plugin.getStats()
    } catch (e) {
      return null
    }
  }

  async dispose() {
    this._stopPoll()
    if (this.plugin) {
      try { await this.plugin.stop() } catch (e) {}
    }
    this.plugin = null
    this.ready = false
    this.sampleIds.clear()
    this.nextSampleId = 0
  }
}
