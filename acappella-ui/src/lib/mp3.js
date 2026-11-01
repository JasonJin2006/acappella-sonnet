// MP3 编码（纯前端，lamejs）。
//
// 关于 lamejs 的坑
// ----------------
// lamejs 1.2.1 的 npm 主入口（src/js/index.js）是 CommonJS，它靠 `require`
// 把 MPEGMode / Lame / BitStream 等十几个文件串起来。Vite 打包时这些
// 隐式全局依赖会丢失，运行时报 `MPEGMode is not defined`。
//
// 官方给浏览器用的版本是 `lame.all.js`：一个自包含的 IIFE，
// 里面把所有依赖都内联了，末尾 `lamejs.Mp3Encoder = Mp3Encoder`，
// 然后调用 `lamejs()` 把自己挂到全局。
//
// 所以这里不走 npm import，而是把 lame.all.js 当静态资源用 <script> 加载，
// 再从 window.lamejs 取。代价是首次导出多一次脚本加载（150 KB，可缓存）。

import { floatToInt16 } from './pcm.js'

let lamePromise = null

function loadLameScript() {
  if (lamePromise) return lamePromise
  lamePromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') { reject(new Error('需要在浏览器里运行')); return }
    // 已经加载过
    if (window.lamejs && window.lamejs.Mp3Encoder) { resolve(window.lamejs); return }
    // lame.all.js 放在 public/ 下，Vite 原样发布到站点根目录。
    // 不能用 new URL('lame.all.js', import.meta.url)——那会解析成
    // /src/lib/lame.all.js（开发期）或 /assets/lame.all.js（构建后），
    // 都不是实际位置。
    const s = document.createElement('script')
    s.src = '/lame.all.js'
    s.async = true
    s.onload = () => {
      if (window.lamejs && window.lamejs.Mp3Encoder) resolve(window.lamejs)
      else reject(new Error('lame.all.js 已加载但没有导出 Mp3Encoder'))
    }
    s.onerror = () => reject(new Error('lame.all.js 加载失败'))
    document.head.appendChild(s)
  })
  return lamePromise
}

// MP3 支持的采样率（MPEG-1 Layer III + MPEG-2 的低采样率档）
export const MP3_RATES = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000]

export function isMp3Rate(rate) {
  return MP3_RATES.includes(rate)
}

/**
 * 把 PCM 编码成 MP3。
 *
 * lamejs 要求分块喂（每块 1152 采样），左右声道分开传。
 * 这里收成一个函数，业务侧不用关心块长和 flush。
 *
 * @param {Float32Array[]} channels 每个声道一段样本（长度一致）
 * @param {number} sampleRate
 * @param {number} kbps 码率，常见 128 / 192 / 256 / 320
 * @returns {Promise<Uint8Array>}
 */
export async function encodeMp3(channels, sampleRate, kbps = 192) {
  if (!channels || !channels.length) throw new Error('没有音频数据')
  if (!isMp3Rate(sampleRate)) {
    throw new Error(`MP3 不支持 ${sampleRate} Hz 采样率，请选 ${MP3_RATES.filter((r) => r >= 16000).join(' / ')}`)
  }
  const lame = await loadLameScript()
  const Encoder = lame.Mp3Encoder
  if (!Encoder) throw new Error('MP3 编码器不可用')

  const numCh = Math.min(2, channels.length)
  const enc = new Encoder(numCh, sampleRate, kbps)
  const frames = channels[0].length
  const BLOCK = 1152

  const toInt16 = (src) => {
    const out = new Int16Array(src.length)
    for (let i = 0; i < src.length; i++) out[i] = floatToInt16(src[i])
    return out
  }

  const left = toInt16(channels[0])
  const right = numCh > 1 ? toInt16(channels[1]) : null

  const chunks = []
  for (let i = 0; i < frames; i += BLOCK) {
    const end = Math.min(i + BLOCK, frames)
    const l = left.subarray(i, end)
    const buf = numCh > 1
      ? enc.encodeBuffer(l, right.subarray(i, end))
      : enc.encodeBuffer(l)
    if (buf.length > 0) chunks.push(new Uint8Array(buf))
  }
  const tail = enc.flush()
  if (tail.length > 0) chunks.push(new Uint8Array(tail))

  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/**
 * 重采样（线性插值 + 降采样前的简单低通）。
 *
 * 只在导出时用，所以用最简单的实现：导出场景下 44.1k↔48k 这种
 * 小比例差异听不出来，换来的是不用引一个几万行的重采样库。
 * 降采样必须先低通，否则会有混叠。
 */
export function resample(channels, fromRate, toRate) {
  if (fromRate === toRate) return channels
  const ratio = toRate / fromRate
  const outLen = Math.max(1, Math.round(channels[0].length * ratio))
  const win = toRate < fromRate ? Math.max(1, Math.ceil(fromRate / toRate)) : 1

  return channels.map((src) => {
    const out = new Float32Array(outLen)
    const srcEff = win > 1 ? movingAverage(src, win) : src
    for (let i = 0; i < outLen; i++) {
      const pos = i / ratio
      const i0 = Math.floor(pos)
      const i1 = Math.min(i0 + 1, srcEff.length - 1)
      const f = pos - i0
      out[i] = (srcEff[i0] || 0) * (1 - f) + (srcEff[i1] || 0) * f
    }
    return out
  })
}

function movingAverage(src, win) {
  const n = src.length
  const out = new Float32Array(n)
  const half = Math.floor(win / 2)
  const pre = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + src[i]
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half)
    const b = Math.min(n, i + half + 1)
    out[i] = (pre[b] - pre[a]) / (b - a)
  }
  return out
}
