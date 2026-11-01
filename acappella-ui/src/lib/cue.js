// 提示音。优先用真实采样（src/lib/samples.js，从 MuseScore 音源拆出来的，
// 见 scripts/build_samples.py）；采样没加载好或该音色没有采样时，
// 退回下面这套现场合成的谐波音色。两套走同一个 tone() 接口，调用方不用区分。

import { getLoadedTimbre, loadTimbre, sampleFor } from './samples.js'
import { VoicePool } from './voicepool.js'

// 合成音色表。id 与采样音色的 id 对齐（piano/organ/strings/flute/marimba/
// voice/voiceO），这样界面上只显示一份音色列表，采样有没有加载完都能响。
const TIMBRES = {
  sine: {
    name: '正弦',
    partials: [[1, 1], [2, 0.12]],
    attack: 0.012,
  },
  piano: {
    name: '钢琴',
    // 第三个数是每个分音的失谐（音分）。真实琴弦是刚性的，泛音会偏高，
    // 全按整数倍叠出来像风琴，加一点失谐才有敲击感
    partials: [[1, 1, 0], [2, 0.55, 4], [3, 0.3, 9], [4, 0.18, 16], [5, 0.1, 24], [6, 0.06, 33]],
    attack: 0.003, decay: 1.6, type: 'triangle',
  },
  strings: {
    name: '弦乐',
    partials: [[1, 1], [2, 0.4], [3, 0.22], [4, 0.12]],
    attack: 0.09, type: 'sawtooth', detune: 6, cutoff: 2400,
    vibrato: 4.6, vibratoCents: 4,
  },
  flute: {
    name: '长笛',
    partials: [[1, 1], [2, 0.1], [3, 0.04]],
    attack: 0.05, type: 'sine', cutoff: 3600,
  },
  marimba: {
    name: '木琴',
    partials: [[1, 1], [4, 0.4], [7, 0.14]],
    attack: 0.002, decay: 0.4, type: 'sine',
  },
  organ: {
    name: '管风琴',
    partials: [[1, 1], [2, 0.5], [3, 0.3], [4, 0.18], [6, 0.1]],
    attack: 0.02, type: 'sine',
  },
  // 人声用共振峰合成：声带是锯齿波，三个带通滤波器的中心频率决定唱哪个元音。
  // 这是「啊」和「哦」的近似，不是真正的歌声合成，听感接近合唱的衬词。
  // 采样版（choir / voiceO）加载好之后会顶替掉它。
  voice: {
    name: '人声 啊',
    formant: [800, 1150, 2900],
    formantGain: [8, 6, 3],   // dB，抬高频谱上的共振区
    formantQ: [3, 4.5, 6.5],
    attack: 0.08, release: 0.2, vibrato: 5, vibratoCents: 4, detune: 4, level: 0.9,
  },
  voiceO: {
    name: '人声 哦',
    formant: [450, 800, 2830],
    formantGain: [9, 6, 3],
    formantQ: [2.8, 4.5, 6.5],
    attack: 0.09, release: 0.22, vibrato: 4.6, vibratoCents: 4, detune: 4, level: 0.94,
  },
}

// 只走合成、没有采样的音色 id
const SYNTH_ONLY = new Set(['sine'])

// 音色推荐音域（MIDI）。超出这个范围采样会被拉伸超过 6 个半音，
// 音色明显失真；设置页用它提示「这个音色覆盖不了你现在的谱面」。
// 数值取「采样根音 ±6 半音」的并集，和 samples.js 的 MAX_STRETCH 对应。
export const TIMBRE_COMFORT = {
  choir: [48, 96],
  voiceO: [54, 102],
  soloVoice: [42, 90],
  piano: [15, 99],
  harpsichord: [44, 89],
  celesta: [54, 90],
  organ: [39, 90],
  rockOrgan: [50, 97],
  strings: [34, 88],
  violin: [62, 98],
  cello: [31, 82],
  contrabass: [27, 65],
  harp: [38, 89],
  flute: [55, 90],
  clarinet: [58, 94],
  oboe: [57, 88],
  recorder: [68, 96],
  trumpet: [49, 90],
  trombone: [49, 85],
  tuba: [42, 74],
  frenchHorn: [45, 81],
  marimba: [54, 90],
  vibraphone: [54, 102],
  xylophone: [60, 102],
  glockenspiel: [78, 114],
  kalimba: [61, 90],
}

// 音色按乐器族分组，设置页按组显示。
// id 与 scripts/build_samples.py 的 TIMBRES 一一对应；name 用中文简称。
export const TIMBRE_GROUPS = [
  {
    id: 'voice',
    name: '人声',
    items: [
      ['choir', '合唱 啊'],
      ['voiceO', '合唱 哦'],
      ['soloVoice', '独唱 啊'],
    ],
  },
  {
    id: 'keyboard',
    name: '键盘',
    items: [
      ['piano', '钢琴'],
      ['harpsichord', '大键琴'],
      ['celesta', '钢片琴'],
    ],
  },
  {
    id: 'organ',
    name: '风琴',
    items: [
      ['organ', '管风琴'],
      ['rockOrgan', '摇滚风琴'],
    ],
  },
  {
    id: 'strings',
    name: '弦乐',
    items: [
      ['strings', '弦乐合奏'],
      ['violin', '小提琴'],
      ['cello', '大提琴'],
      ['contrabass', '低音提琴'],
      ['harp', '竖琴'],
    ],
  },
  {
    id: 'woodwind',
    name: '木管',
    items: [
      ['flute', '长笛'],
      ['clarinet', '单簧管'],
      ['oboe', '双簧管'],
      ['recorder', '竖笛'],
    ],
  },
  {
    id: 'brass',
    name: '铜管',
    items: [
      ['trumpet', '小号'],
      ['trombone', '长号'],
      ['tuba', '大号'],
      ['frenchHorn', '圆号'],
    ],
  },
  {
    id: 'percussion',
    name: '打击',
    items: [
      ['marimba', '木琴'],
      ['vibraphone', '颤音琴'],
      ['xylophone', '木琴条'],
      ['glockenspiel', '钟琴'],
      ['kalimba', '卡林巴'],
    ],
  },
  {
    id: 'synth',
    name: '合成',
    items: [
      ['sine', '正弦'],
    ],
  },
]

// 扁平表：id -> 名字，内部查表用
export const SAMPLE_TIMBRES = Object.fromEntries(
  TIMBRE_GROUPS.flatMap((g) => g.items).filter(([id]) => !SYNTH_ONLY.has(id))
)


// 采样音色对应的合成兜底（加载完成之前、或者加载失败时用）
const SAMPLE_FALLBACK = {
  choir: 'voice',
  voiceO: 'voiceO',
  soloVoice: 'voice',
  piano: 'piano',
  harpsichord: 'piano',
  celesta: 'marimba',
  organ: 'organ',
  rockOrgan: 'organ',
  strings: 'strings',
  violin: 'strings',
  cello: 'strings',
  contrabass: 'strings',
  harp: 'piano',
  flute: 'flute',
  clarinet: 'flute',
  oboe: 'flute',
  recorder: 'flute',
  trumpet: 'strings',
  trombone: 'strings',
  tuba: 'strings',
  frenchHorn: 'strings',
  marimba: 'marimba',
  vibraphone: 'marimba',
  xylophone: 'marimba',
  glockenspiel: 'marimba',
  kalimba: 'marimba',
}

// 兼容旧的无分组列表
export const TIMBRE_NAMES = TIMBRE_GROUPS.flatMap((g) => g.items)

export function timbreName(id) {
  return SAMPLE_TIMBRES[id] || (TIMBRES[id] && TIMBRES[id].name) || id
}

export function timbreGroup(id) {
  return TIMBRE_GROUPS.find((g) => g.items.some(([k]) => k === id)) || null
}

class CueEngine {
  constructor(ctx) {
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = 0.7
    this.master.connect(ctx.destination)
    this.sustain = null
    this.timbre = 'choir'
    // 采样加载状态：timbre id -> 'loading' | 'ready' | 'failed'
    this.sampleState = {}
    this._pending = {}
    // 低功耗：合成兜底时只保留前 4 个谐波，少建一半振荡器
    this.lowPower = false
    // 采样播放的 voice 池：第一次播采样时创建，复用 GainNode
    this.pool = null
    // 预加载默认音色，第一次发声就用采样
    this.preload(this.timbre)
  }
  setLowPower(on) { this.lowPower = !!on }

  setVolume(v) { this.master.gain.value = v }

  // 预加载某个音色的采样。加载完成后如果这个音色正在响，会无缝换成采样。
  preload(name) {
    // 只有采样音色才需要加载；合成音色（sine）直接返回
    if (!SAMPLE_TIMBRES[name]) return Promise.resolve(null)
    const id = name
    if (this.sampleState[id] === 'ready') return Promise.resolve(getLoadedTimbre(id))
    // 正在加载：返回同一个 Promise，ready() 才能真正等到它结束
    if (this.sampleState[id] === 'loading') return this._pending[id] || Promise.resolve(null)
    this.sampleState[id] = 'loading'
    const task = loadTimbre(this.ctx, id).then((loaded) => {
      this._pending[id] = null
      if (!loaded) {
        this.sampleState[id] = 'failed'
        return null
      }
      this.sampleState[id] = 'ready'
      // 加载期间音色没变，就把正在响的持续音换成采样
      if (this.timbre === id) {
        if (this.sustain) {
          const { freq, gain } = this.sustain
          this.stopSustain()
          this.startSustain(freq, gain)
        }
        if (this.drone) {
          const { freq, gain } = this.drone
          this.stopDrone()
          this.startDrone(freq, gain)
        }
      }
      return loaded
    })
    this._pending[id] = task
    return task
  }

  // 这个音色当前可用的采样包（没加载好返回 null）
  _sample() {
    return getLoadedTimbre(this.timbre)
  }

  // 当前音色用来合成的参数：采样音色退回它对应的合成兜底
  _spec() {
    const id = this.timbre
    if (TIMBRES[id]) return TIMBRES[id]
    const fallback = SAMPLE_FALLBACK[id]
    return TIMBRES[fallback] || TIMBRES.sine
  }

  setTimbre(name) {
    const known = TIMBRES[name] || SAMPLE_TIMBRES[name]
    if (!known || name === this.timbre) return
    this.timbre = name
    // 采样音色第一次选中时开始加载
    if (SAMPLE_TIMBRES[name]) this.preload(name)
    // 持续音正在响时换音色：用新音色在原音高上重启，听感不中断
    if (this.sustain) {
      const { freq, gain } = this.sustain
      this.stopSustain()
      this.startSustain(freq, gain)
    }
    if (this.drone) {
      const { freq, gain } = this.drone
      this.stopDrone()
      this.startDrone(freq, gain)
    }
  }

  // 等当前音色的采样就绪（最多等 ms 毫秒）。
  // 整谱播放前调一下，第一小节才不会用合成音色顶替。
  async ready(ms = 2500) {
    if (!SAMPLE_TIMBRES[this.timbre]) return
    if (this.sampleState[this.timbre] === 'ready') return
    await Promise.race([
      this.preload(this.timbre),
      new Promise((r) => setTimeout(r, ms)),
    ])
  }

  // 采样发声：一个 AudioBufferSourceNode + 包络。
  // 长音靠循环采样中段延音；打击类（sustain=0）不循环，自然衰减。
  _buildSample(freq, t0, env, durSec) {
    const ctx = this.ctx
    const loaded = this._sample()
    const pick = sampleFor(loaded, freq)
    if (!pick) return null
    // 拉伸超过两个八度时音色已经完全走样，退回合成音色更稳
    if (pick.stretch > 24) return null
    const src = ctx.createBufferSource()
    src.buffer = pick.buffer
    src.playbackRate.value = pick.rate
    // 延音：从采样 35% 处循环到 85%，跳过起音段，循环点落在稳态
    if (loaded.sustain > 0) {
      const start = pick.buffer.duration * 0.35
      const end = pick.buffer.duration * 0.85
      if (end - start > 0.08) {
        src.loop = true
        src.loopStart = start
        src.loopEnd = end
      }
    }
    // 采样包自带的增益（不同音色响度不同）直接乘进声部总线，
    // 不再为每个音单独建一个 GainNode——省一个节点就是省一次音频线程分配。
    src.connect(env)
    src.start(t0)
    return { src, gain: null, durSec }
  }

  // 按音色谐波表造一组振荡器，接到 env（或先过低通再进 env）
  _build(freq, spec, t0, env) {
    if (spec.formant) return this._buildVoice(freq, spec, t0, env)
    const ctx = this.ctx
    const nodes = []
    const bus = spec.cutoff ? ctx.createBiquadFilter() : null
    if (bus) {
      bus.type = 'lowpass'
      bus.frequency.value = spec.cutoff
      bus.Q.value = 0.7
      bus.connect(env)
    }
    const norm = spec.partials.reduce((s, p) => s + p[1], 0) || 1
    for (const [m, g, inharm] of spec.partials) {
      for (const dt of spec.detune ? [-spec.detune, spec.detune] : [0]) {
        const o = ctx.createOscillator()
        o.type = spec.type || 'sine'
        o.frequency.value = freq * m
        if (dt || inharm) o.detune.value = (dt || 0) + (inharm || 0)
        const vg = ctx.createGain()
        vg.gain.value = (g / norm) * (spec.detune ? 0.55 : 1)
        o.connect(vg)
        vg.connect(bus || env)
        o.start(t0)
        nodes.push({ o, m })
      }
    }
    if (spec.vibrato) this._vibrato(nodes.filter((n) => n.m).map((n) => n.o), spec, t0, nodes)
    return nodes
  }

  // 颤音：一个低频振荡器同时推所有声带振荡器的 detune（单位是音分）
  _vibrato(oscs, spec, t0, nodes) {
    const ctx = this.ctx
    const lfo = ctx.createOscillator()
    lfo.frequency.value = spec.vibrato
    const depth = ctx.createGain()
    depth.gain.value = spec.vibratoCents || 5
    lfo.connect(depth)
    for (const o of oscs) depth.connect(o.detune)
    lfo.start(t0)
    nodes.push({ o: lfo, m: 0 })
  }

  // 共振峰人声：锯齿波当声带，三个 peaking 滤波器把共振区抬起来。
  // 用 peaking 而不是带通，是因为带通只留三条窄缝，能量和肉感都没了；
  // peaking 保留全部谐波，只改频谱形状，才像人在唱而不是口哨。
  _buildVoice(freq, spec, t0, env) {
    const ctx = this.ctx
    const nodes = []
    const out = ctx.createGain()
    out.gain.value = spec.level == null ? 0.6 : spec.level
    out.connect(env)

    const src = ctx.createGain()
    src.gain.value = 0.22
    const oscs = []
    for (const cents of [-spec.detune, 0, spec.detune]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = freq
      o.detune.value = cents
      o.connect(src)
      o.start(t0)
      oscs.push(o)
      nodes.push({ o, m: 1 })
    }
    if (spec.vibrato) this._vibrato(oscs, spec, t0, nodes)

    // 4.2kHz 以上是锯齿波的毛刺，人声没有这么亮
    const air = ctx.createBiquadFilter()
    air.type = 'lowpass'
    air.frequency.value = 4200
    air.Q.value = 0.7
    src.connect(air)

    // 胸腔：抬一点低频，基音才站得住，不会只剩共振峰的亮
    const chest = ctx.createBiquadFilter()
    chest.type = 'lowshelf'
    chest.frequency.value = 320
    chest.gain.value = 5
    air.connect(chest)

    // 共振峰随音区移动：低音声部的声道更长，固定 800Hz 会让男低音听起来像捏着嗓子。
    // 每低一个八度整体乘 0.79，每高一个八度乘 1.26，限制在两倍以内。
    const midi = 69 + 12 * Math.log2(freq / 440)
    const scale = Math.max(0.8, Math.min(1.25, Math.pow(2, (midi - 60) / 36)))

    let node = chest
    spec.formant.forEach((f, i) => {
      const peak = ctx.createBiquadFilter()
      peak.type = 'peaking'
      peak.frequency.value = f * scale
      peak.Q.value = spec.formantQ ? spec.formantQ[i] : 5
      peak.gain.value = spec.formantGain ? spec.formantGain[i] : 10
      node.connect(peak)
      node = peak
    })
    node.connect(out)
    return nodes
  }

  // dest 可选：整谱播放会把音排进自己的总线，停止时整条总线淡出即可，
  // 不用记住每一个音符。不传就还是接到提示音的主输出。
  tone(freq, durSec, gain, when, dest) {
    const ctx = this.ctx
    const spec = this._spec()
    const t0 = (when != null ? when : ctx.currentTime) + 0.001
    const dur = Math.max(0.05, durSec)
    const end = t0 + dur

    // 采样优先。采样音色的音量曲线按采样包自己的 gain 走；
    // 打击类采样（sustain=0）让采样自然衰减，只补一个收尾淡出。
    const loaded = this._sample()
    if (loaded) {
      const pick = sampleFor(loaded, freq)
      // stretch > 24 表示采样被拉伸超过两个八度，音色已走样，退回合成
      if (pick && pick.stretch <= 24) {
        const out = dest || this.master
        // 整个引擎只有一个池，上限对所有声部统一生效。
        // （早先是「每个 dest 一个池」，整谱播放时 8 个声部各建一个，
        //  峰值放大 8 倍，反而更容易爆。）
        if (!this.pool) this.pool = new VoicePool(ctx, this.master)
        // 采样包自带的响度差乘进峰值
        const peak = Math.max(0.0001, gain * 1.15 * (loaded.gain == null ? 1 : loaded.gain))
        // 延音类从 35% 处循环到 85%，跳过起音段
        let loop = false
        let loopStart = 0
        let loopEnd = 0
        if (loaded.sustain > 0) {
          const a = pick.buffer.duration * 0.35
          const b = pick.buffer.duration * 0.85
          if (b - a > 0.08) { loop = true; loopStart = a; loopEnd = b }
        }
        const voice = this.pool.playSample(pick.buffer, pick.rate, {
          when: t0,
          dur,
          peak,
          // 采样包已有自己的起音，这里只补一个很短的爬升
          attack: Math.min(0.012, dur * 0.35),
          release: loaded.sustain > 0 ? 0.09 : 0.05,
          sustain: loaded.sustain > 0,
          loop,
          loopStart,
          loopEnd,
          dest: out,
        })
        if (voice) {
          return {
            stop() { try { voice.src.stop() } catch (e) {} },
          }
        }
        // 池满被丢弃时也直接返回，不要往下走合成——
        // 否则声音会突然从采样变成电子音，反而更明显
        return { stop() {} }
      }
      // 采样覆盖不到这个音高（stretch 过大）就往下走合成
    }

    const peak = Math.max(0.0001, gain * 1.15)
    // 起音和收音按音符长度收紧，很短的音也不会被包络吃掉
    const attack = Math.min(spec.attack == null ? 0.012 : spec.attack, dur * 0.45)
    const release = Math.min(spec.release == null ? 0.06 : spec.release, dur * 0.55)

    const env = ctx.createGain()
    env.connect(dest || this.master)
    env.gain.setValueAtTime(0.0001, t0)
    env.gain.linearRampToValueAtTime(peak, t0 + attack)

    if (spec.decay) {
      // 打击类音色：起音后指数衰减，像敲一下
      const dec = Math.min(Math.max(t0 + 0.08, t0 + spec.decay), end - 0.005)
      env.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.22), dec)
      env.gain.exponentialRampToValueAtTime(0.0001, Math.max(dec + 0.01, end))
    } else {
      // 持续类：起音后轻微回落再保持，长音不会像风琴一样死平
      const settle = Math.min(t0 + attack + Math.max(0.12, dur * 0.25), end - release)
      env.gain.linearRampToValueAtTime(peak * 0.88, settle)
      env.gain.setValueAtTime(peak * 0.88, Math.max(settle, end - release))
      env.gain.linearRampToValueAtTime(0.0001, end)
    }

    const nodes = this._build(freq, spec, t0, env)
    for (const { o } of nodes) o.stop(end + 0.05)
    return {
      stop() { for (const { o } of nodes) { try { o.stop() } catch (e) {} } },
    }
  }

  // when：绝对时间（AudioContext.currentTime 的口径）。整谱播放的节拍器
  // 要提前排期才准，所以不能固定用 currentTime；跟唱时仍可省略。
  click(strong, vol, when) {
    const ctx = this.ctx
    const t0 = when == null ? ctx.currentTime + 0.001 : Math.max(ctx.currentTime + 0.001, when)
    const g = ctx.createGain(); g.connect(this.master)
    const peak = (strong ? 0.5 : 0.28) * (vol == null ? 1 : vol)
    g.gain.setValueAtTime(peak, t0)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05)
    const o = ctx.createOscillator()
    o.type = 'square'; o.frequency.value = strong ? 1600 : 1100
    o.connect(g); o.start(t0); o.stop(t0 + 0.06)
  }

  // 持续低音：独立于乐谱位置的 drone，给侗族大歌、格鲁吉亚、阿尔巴尼亚 iso
  // 这类以持续音托底的传统用。和 sustain 分开存，跟谱的持续参考音不会把它顶掉。
  startDrone(freq, gain) {
    this.stopDrone()
    const ctx = this.ctx
    const spec = this._spec()
    const t = ctx.currentTime
    const peak = Math.max(0.0001, gain * 1.1)
    const env = ctx.createGain()
    env.connect(this.master)
    env.gain.setValueAtTime(0.0001, t)
    // 慢起慢收：低音是铺底，不能像提示音那样一下子切进来
    env.gain.linearRampToValueAtTime(peak, t + 0.15)
    // 采样优先：drone 必须能一直响，所以只在采样有循环时才用采样
    const played = this._buildSample(freq, t, env, Infinity)
    if (played && played.src.loop) {
      this.drone = { nodes: [], env, freq, gain, src: played.src }
      return
    }
    if (played) { try { played.src.stop() } catch (e) {} }
    const nodes = this._build(freq, spec, t, env)
    this.drone = { nodes, env, freq, gain }
  }

  stopDrone() {
    if (!this.drone) return
    const { nodes, env, src } = this.drone
    const t = this.ctx.currentTime
    env.gain.cancelScheduledValues(t)
    env.gain.setTargetAtTime(0, t, 0.08)
    if (src) { try { src.stop(t + 0.5) } catch (e) {} }
    for (const { o } of nodes || []) { try { o.stop(t + 0.5) } catch (e) {} }
    this.drone = null
  }

  startSustain(freq, gain) {
    this.stopSustain()
    const ctx = this.ctx
    const spec = this._spec()
    const t = ctx.currentTime
    const peak = Math.max(0.0001, gain * 1.1)
    const env = ctx.createGain()
    env.connect(this.master)
    env.gain.setValueAtTime(0.0001, t)
    env.gain.linearRampToValueAtTime(peak, t + Math.max(0.03, (spec.attack || 0.02) + 0.02))
    if (spec.decay) {
      env.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.32), t + Math.max(0.1, spec.decay))
    }
    // 持续参考音也要能一直响，同样只接受可循环的采样
    const played = this._buildSample(freq, t, env, Infinity)
    if (played && played.src.loop) {
      this.sustain = { nodes: [], env, freq, gain, src: played.src, sample: true }
      return
    }
    if (played) { try { played.src.stop() } catch (e) {} }
    const nodes = this._build(freq, spec, t, env)
    this.sustain = { nodes, env, freq, gain }
  }

  setSustainFreq(freq) {
    if (!this.sustain) return
    this.sustain.freq = freq
    const t = this.ctx.currentTime
    if (this.sustain.sample) {
      // 采样音高靠 playbackRate 变，换音时直接改倍率
      const loaded = this._sample()
      const pick = loaded && sampleFor(loaded, freq)
      if (pick) this.sustain.src.playbackRate.setTargetAtTime(pick.rate, t, 0.02)
      return
    }
    for (const { o, m } of this.sustain.nodes) o.frequency.setTargetAtTime(freq * m, t, 0.02)
  }

  stopSustain() {
    if (!this.sustain) return
    const { nodes, env, src } = this.sustain
    const t = this.ctx.currentTime
    env.gain.cancelScheduledValues(t)
    env.gain.setTargetAtTime(0, t, 0.02)
    if (src) { try { src.stop(t + 0.15) } catch (e) {} }
    for (const { o } of nodes || []) { try { o.stop(t + 0.15) } catch (e) {} }
    this.sustain = null
  }
}

export { CueEngine }
