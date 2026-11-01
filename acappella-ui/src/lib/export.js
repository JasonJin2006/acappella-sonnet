// 内部谱面 → 标准 MIDI 文件（SMF format 1）。
//
// 为什么自己写而不是引库：MIDI 文件格式不复杂（14 字节头 + 若干 track），
// 引一个库要多几十 KB，还要担心它和我们的拍号/速度表示对不上。
//
// 一拍 = 一个四分音符，和内部格式一致；每小节按 score.bar 分。
// 每个声部一个 track，第一个 track 放速度与拍号（format 1 的惯例）。

import { floatToInt16 } from './pcm.js'

const TICKS_PER_QUARTER = 480

// 声部 id → 拼音缩写，放进 MIDI track name（必须是 ASCII）
const ZH_PINYIN = {
  S: 'Soprano', S1: 'Soprano 1', S2: 'Soprano 2',
  A: 'Alto', A1: 'Alto 1', A2: 'Alto 2',
  T: 'Tenor', T1: 'Tenor 1', T2: 'Tenor 2',
  B: 'Bass', B1: 'Bass 1', B2: 'Bass 2',
  H: 'Hum', H1: 'Hum 1', H2: 'Hum 2', H3: 'Hum 3',
}
// 曲名转 ASCII：中文保留不了就退化成 "Sonnet"，具体曲名放到 instrument name 里
const safeAsciiTitle = (title) => {
  const s = String(title || 'Sonnet')
  const ascii = s.replace(/[^\x20-\x7e]/g, '').trim()
  return ascii || 'Sonnet'
}

const zhName = (id) => ZH_PINYIN[id] || 'Part'

const varLen = (n) => {
  // MIDI 的可变长度量：每字节 7 位，最高位表示「还有后续」
  let v = Math.max(0, Math.round(n))
  const bytes = [v & 0x7f]
  v >>= 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>= 7
  }
  return bytes
}

const u16 = (n) => [(n >> 8) & 0xff, n & 0xff]
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

// Track name 只能用 ASCII：MIDI 规范的文本事件没有声明编码，
// 塞 UTF-8 进去很多 DAW/mido 会按 Latin-1 读成乱码（实测 mido 就是这样）。
// 所以中文声部名单独放 instrument name（0x04），主名用音节缩写 + 原文。
const asciiBytes = (s) => {
  const out = []
  for (const ch of String(s)) {
    const code = ch.codePointAt(0)
    out.push(code < 0x80 ? code : 0x3f) // 非 ASCII 换成 '?'
  }
  return out
}

const textEvent = (type, s) => {
  const bytes = asciiBytes(s)
  // delta-time 由 makeTrack 统一补，这里只返回事件本体
  return [0xff, type, ...varLen(bytes.length), ...bytes]
}

const TRACK_NAME = (s) => textEvent(0x03, s)
const INSTRUMENT_NAME = (s) => textEvent(0x04, s)

function makeTrack(events) {
  // events: [{ tick, bytes, order }]，按 tick 排序后转 delta-time
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  const body = []
  let last = 0
  for (const e of events) {
    body.push(...varLen(e.tick - last), ...e.bytes)
    last = e.tick
  }
  body.push(0x00, 0xff, 0x2f, 0x00) // End of Track
  // 一个 track = 'MTrk' + 4 字节长度 + 事件体
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body]
}

/**
 * 把内部谱面导出成 MIDI 文件字节。
 * @param {object} score { title, bpm, bar, parts: [{id, name, notes:[{midi,beats}]}] }
 * @param {object} opts  { program, channelStart, velocity }
 * @returns {Uint8Array}
 */
export function scoreToMidi(score, opts = {}) {
  const bpm = Math.max(20, Math.min(300, score.bpm || 96))
  const bar = Math.max(1, score.bar || 4)
  const parts = (score.parts || []).filter((p) => p && p.notes && p.notes.length)
  if (!parts.length) return new Uint8Array()

  const tracks = []

  // ---- track 0：曲名 + 速度 + 拍号 ----
  {
    const beatToUs = (b) => {
      const us = Math.round(60_000_000 / Math.max(1, b))
      return [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]
    }
    const events = [
      { tick: 0, order: 0, bytes: TRACK_NAME(safeAsciiTitle(score.title)) },
    ]
    // 速度表：谱面中途变速时逐条写进 MIDI，DAW 里播放才是原速。
    // 以前只写第一条，整首会被拉成一个速度。
    const tempos = Array.isArray(score.tempos) && score.tempos.length
      ? score.tempos
      : [{ beat: 0, bpm }]
    for (const t of tempos) {
      events.push({
        tick: Math.max(0, Math.round((t.beat || 0) * TICKS_PER_QUARTER)),
        order: 1,
        bytes: beatToUs(t.bpm || bpm),
      })
    }
    events.push({ tick: 0, order: 2, bytes: [0xff, 0x58, 0x04, bar, 2, 24, 8] }) // 拍号 n/4，每 24 clocks 一个 32 分音符
    // C 大调（0 个升降号）。内部格式没存调号，用 0 最安全，
    // 音符本身带半音，调号只影响 DAW 里的显示。
    events.push({ tick: 0, order: 3, bytes: [0xff, 0x59, 0x02, 0, 0] })
    tracks.push(events)
  }

  // ---- 每个声部一个 track ----
  parts.forEach((part, pi) => {
    // 通道 9（从 0 数）是 General MIDI 的打击乐通道，旋律声部落上去会变成
    // 鼓声。声部多于 9 个时自动跳过它，而不是把两个声部挤到同一个通道。
    const start = opts.channelStart == null ? 0 : opts.channelStart
    const wanted = start + pi
    const channel = Math.min(15, wanted >= 9 ? wanted + 1 : wanted)
    const program = opts.program == null ? 0 : Math.max(0, Math.min(127, opts.program))
    const velocity = opts.velocity == null ? 88 : Math.max(1, Math.min(127, opts.velocity))
    const events = []
    // track name 用 ASCII（DAW 轨道列表里认这个），中文放 instrument name
    const label = part.id || ('P' + (pi + 1))
    events.push({ tick: 0, order: 0, bytes: TRACK_NAME(label + ' - ' + zhName(part.id)) })
    events.push({ tick: 0, order: 1, bytes: INSTRUMENT_NAME(label + ' ' + (part.name || '')) })
    events.push({ tick: 0, order: 2, bytes: [0xc0 | channel, program] })
    let beat = 0
    for (let i = 0; i < part.notes.length; i++) {
      const n = part.notes[i]
      const dur = Math.max(0, n.beats || 0)
      if (n.midi != null && dur > 1e-6) {
        const startTick = Math.round(beat * TICKS_PER_QUARTER)
        const end = beat + dur
        const endTick = Math.round(end * TICKS_PER_QUARTER)
        // 力度：没标就用默认 velocity，标了按比例换算成 MIDI 力度值
        let vel = n.vel == null ? velocity : Math.max(1, Math.min(127, Math.round(velocity * (n.vel / 0.58))))
        // 重音在 MIDI 里也用力度表达，和播放引擎一致
        if (n.accent === 1) vel = Math.min(127, Math.round(vel * 1.25))
        else if (n.accent >= 2) vel = Math.min(127, Math.round(vel * 1.5))
        events.push({ tick: startTick, order: 2, bytes: [0x90 | channel, n.midi & 0x7f, vel] })

        // 滑音：MIDI 用 pitch bend 表达。这里写成"起音后快速弯到目标音"，
        // 弯音在目标音开始时回到中心。不做这一步，导出的 MIDI 里滑音
        // 会完全消失（谱面上有、声音里没有）。
        const next = part.notes[i + 1]
        if (n.gliss && next && next.midi != null) {
          const semis = next.midi - n.midi
          const bendRange = 2   // 标准 GM 弯音范围 ±2 个半音
          if (Math.abs(semis) <= bendRange * 12) {
            const amount = Math.max(-8192, Math.min(8191, Math.round((semis / bendRange) * 8192)))
            const glideTicks = Math.min(endTick - startTick, TICKS_PER_QUARTER / 2)
            events.push({ tick: startTick, order: 3, bytes: [0xe0 | channel, 0x00, 0x40] })
            events.push({
              tick: startTick + glideTicks, order: 3,
              bytes: [0xe0 | channel, amount & 0x7f, ((amount >> 7) & 0x7f)],
            })
            events.push({ tick: endTick, order: 3, bytes: [0xe0 | channel, 0x00, 0x40] })
          }
        }

        // 留 95% 时值，同音反复才听得出来是两个音（和播放引擎的做法一致）；
        // 跳音压到 50%，连音线里不压缩。
        const keep = n.staccato ? 0.5 : (n.slurStop || n.slurStart) ? 1.0 : 0.95
        const off = Math.max(startTick + 1, Math.round(startTick + (endTick - startTick) * keep))
        events.push({ tick: off, order: 1, bytes: [0x80 | channel, n.midi & 0x7f, 0] })
      }
      beat += dur
    }
    tracks.push(events)
  })

  // ---- 文件头：MThd + format 1 + ntrks + division ----
  const ntrks = tracks.length
  const header = [
    0x4d, 0x54, 0x68, 0x64,   // 'MThd'
    ...u32(6),
    ...u16(1),      // format 1（多轨同步）
    ...u16(ntrks),
    ...u16(TICKS_PER_QUARTER),
  ]
  const out = [...header]
  for (const evs of tracks) out.push(...makeTrack(evs))
  return new Uint8Array(out)
}

// 触发下载。CSV/XML/MIDI 都走这一个 helper。
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让部分浏览器来不及下载，延迟一下
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

// 文件名里的非法字符换成下划线，保留中文
export function safeFileName(name, ext) {
  const base = String(name || 'sonnet').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'sonnet'
  return `${base}.${ext}`
}

/**
 * 把一段 PCM 编码成 WAV（16-bit，可选声道数与采样率）。
 * @param {Float32Array[]} channels 每个声道一段样本
 * @param {number} sampleRate
 */
export function encodeWav(channels, sampleRate) {
  const numCh = channels.length
  const frames = channels[0].length
  const dataBytes = frames * numCh * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buf)
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)     // fmt chunk 长度
  view.setUint16(20, 1, true)      // PCM
  view.setUint16(22, numCh, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numCh * 2, true)
  view.setUint16(32, numCh * 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataBytes, true)
  // 交错写入。钳位与 16-bit 换算在 pcm.js，四份实现共用一份。
  let off = 44
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      view.setInt16(off, floatToInt16(channels[ch][i]), true)
      off += 2
    }
  }
  return new Uint8Array(buf)
}
