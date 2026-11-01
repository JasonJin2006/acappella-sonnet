// 离线渲染：把整份谱面渲染成一段立体声 PCM，用来导出 WAV。
//
// 复用播放引擎那套声音设计（每个声部一个声像、总线限幅、混响），
// 但跑在 OfflineAudioContext 里——比实时播放快得多，也不受系统卡顿影响。
//
// 采样音色要先在离线上下文里重新解码：AudioBuffer 和 AudioContext 绑定，
// 不同上下文不能共用。采样包很小（4.9 MB），解码一次几十毫秒。
//
// 注意：OfflineAudioContext 里 AudioBufferSourceNode 的 start(when) 用的是
// 离线时间轴，和实时上下文的 currentTime 语义一致，所以排期逻辑可以照搬。

import { CueEngine } from './cue.js'
import { midiToFreq } from './music.js'
import { buildFxChain, panFor, partGainFor, reverbSeconds, makeImpulse, DEFAULT_FX } from './fx.js'
import { TempoMap } from './tempo.js'

const TAIL_BASE = 0.8 // 音符结束后的基础余量（秒）
const LEAD = 0.05     // 开头留一点余量，避免第一个音被裁掉

/**
 * 离线渲染整份谱面。
 * @param {object} score  { title, bpm, bar, parts }
 * @param {object} opts
 *   - timbre      音色 id（见 cue.js）
 *   - volume      总音量 0..1
 *   - onlyParts   只渲染这些声部下标（默认全部）
 *   - sampleRate  默认 44100
 *   - rate        播放速率 0.5..2（1 = 原速），不变调
 *   - onProgress  0..1 回调
 * @returns {Promise<{left: Float32Array, right: Float32Array, sampleRate: number, seconds: number}>}
 */
export async function renderScore(score, opts = {}) {
  const parts = (score.parts || []).filter((p) => p && p.notes && p.notes.length)
  if (!parts.length) throw new Error('这份谱没有音符，没法渲染')

  const picks =
    Array.isArray(opts.onlyParts) && opts.onlyParts.length
      ? opts.onlyParts.filter((i) => parts[i])
      : parts.map((_, i) => i)
  const lines = picks.map((pi) => {
    const part = parts[pi]
    const starts = []
    let acc = 0
    for (const n of part.notes) { starts.push(acc); acc += n.beats }
    return { part, starts, total: acc }
  })
  const totalBeats = Math.max(...lines.map((l) => l.total))
  if (!(totalBeats > 0)) throw new Error('这份谱没有可渲染的时值')

  const bpm = Math.max(20, Math.min(300, score.bpm || 96))
  // 播放速率：1 = 原速。音高由 cue 按频率独立决定，所以这里不需要
  // 时间伸缩——每个音本来就按目标频率重新合成/变调。
  const rate = Math.max(0.5, Math.min(2, opts.rate || 1))
  // 谱面中途变速时，拍 → 秒按速度表换算；单速谱退化成一条直线
  const tempo = new TempoMap(score.tempos, bpm, rate)
  const sampleRate = opts.sampleRate || 44100
  const fx = { ...DEFAULT_FX, ...(opts.fx || {}) }
  // 混响尾巴要留够：4 秒的混响只留 0.8 秒尾会把混响切断
  const tail = TAIL_BASE + reverbSeconds(fx)
  const seconds = LEAD + tempo.secAt(totalBeats) + tail
  const frames = Math.ceil(seconds * sampleRate)

  const ctx = new OfflineAudioContext(2, frames, sampleRate)

  // 提示音引擎：在离线上下文里新建一个，音色与设置一致
  const cue = new CueEngine(ctx)
  cue.timbre = opts.timbre || 'choir'
  cue.setVolume(opts.volume == null ? 0.85 : opts.volume)

  // 离线上下文里没有 fetch 缓存共享，重新解码一遍采样
  if (cue.sampleState) cue.sampleState[cue.timbre] = 'loading'
  try {
    await cue.ready(6000)
  } catch (e) { /* 采样加载失败就走合成兜底 */ }

  // ---- 效果链：和播放引擎共用 fx.js，导出和试听听感一致 ----
  const impulse = makeImpulse(ctx, reverbSeconds(fx), 2.2)
  const { bus } = buildFxChain(ctx, fx, ctx.destination, impulse)

  // ---- 每个声部一个声像轨 ----
  const lineOuts = []
  lines.forEach((line, i) => {
    const out = ctx.createGain()
    out.gain.value = partGainFor(i)
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner()
      pan.pan.value = panFor(i, lines.length, fx)
      out.connect(pan)
      pan.connect(bus)
    } else {
      out.connect(bus)
    }
    lineOuts.push(out)
  })

  // ---- 排期 ----
  const gain = (opts.gain == null ? 0.34 : opts.gain) / Math.sqrt(Math.max(1, lines.length) / 2)
  let scheduled = 0
  let totalNotes = 0
  for (const line of lines) totalNotes += line.part.notes.filter((n) => n.midi != null).length

  lines.forEach((line, li) => {
    const notes = line.part.notes
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      if (n.midi == null) continue
      const start = line.starts[i]
      // 拍 → 秒走速度表，变速段落会被拉长/压短；时值同理
      const when = LEAD + tempo.secAt(start)
      const dur = Math.max(0.06, (tempo.secAt(start + n.beats) - tempo.secAt(start)) * (n.staccato ? 0.5 : 0.94))
      // 每个音自己的力度：和 player.js 用同一个换算，
      // 导出结果才和试听一致
      let vel = n.vel == null ? 1 : Math.max(0.05, Math.min(1.4, n.vel / 0.58))
      if (n.accent === 1) vel *= 1.25
      else if (n.accent >= 2) vel *= 1.5
      // 提示音引擎自己解决「采样 or 合成」，这里只要把音排进去
      const next = notes[i + 1]
      if (n.gliss && next && next.midi != null && cue.slide) {
        // 滑音时长上限 1.2 秒，和实时播放同一口径：源音标成 8 拍时
        // 滑满会变成持续警笛，还会和目标音整段重叠
        const glideSec = Math.min(dur, 1.2)
        const ok = cue.slide(
          midiToFreq(n.midi), midiToFreq(next.midi),
          glideSec, gain * vel, when, lineOuts[li]
        )
        if (ok) { scheduled++; continue }
      }
      cue.tone(midiToFreq(n.midi), dur, gain * vel, when, lineOuts[li])
      scheduled++
    }
    if (opts.onProgress) {
      opts.onProgress(scheduled / Math.max(1, totalNotes))
    }
  })

  const rendered = await ctx.startRendering()
  return {
    left: rendered.getChannelData(0),
    right: rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : rendered.getChannelData(0),
    sampleRate,
    seconds,
  }
}

// 峰值归一化到 -1 dB，导出不会削顶
export function normalize(channels, target = 0.89) {
  let peak = 0
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i])
      if (a > peak) peak = a
    }
  }
  if (peak <= 1e-6) return channels
  const g = target / peak
  if (Math.abs(g - 1) < 0.01) return channels
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= g
  }
  return channels
}
