// 时间伸缩（变速不变调）—— WSOLA 实现。
//
// 核心公式（一度写错，务必保留这段说明）：
//
//   设 rate = 1 表示原速，rate > 1 表示变快（时长变短）。
//   输出端每 hop 个采样排一帧；要让它对应输入端的 analyzeHop 个采样，
//   因此 analyzeHop = hop * rate（不是 hop / rate）。
//
//   推导：输出长度 ≈ 输入长度 / rate。
//   输出帧数 = outLen / hop，输入覆盖长度 = 帧数 × analyzeHop。
//   要求 输入覆盖长度 ≈ 输入长度，即 (outLen/hop)·analyzeHop ≈ n。
//   代入 outLen = n/rate： (n/(rate·hop))·analyzeHop ≈ n → analyzeHop ≈ rate·hop。
//
// 第一版写成 hop/rate，导致 rate=0.5 时输入只推进了应有的 1/4，
// 相当于对输入又做了一次拉伸，实测 f0 偏 -545 音分、rate=2 时偏 +1261 音分。
//
// 其余部分：
//   - 每帧在 ±tol 内搜一段和「上一帧尾部」最像的位置（WSOLA 的核心）
//   - Hann 窗 50% 重叠相加，按实际窗和归一化
//
// 搜索门限（第二处关键）：
//
//   TOLERANCE 必须覆盖至少一个基音周期。100–300Hz 人声的周期是
//   150–440 采样（44.1kHz），门限只有 2% 帧长（≈20 采样）时根本
//   找不到相位对齐点，拉伸后频谱被破坏（实测基频偏 ±250 音分）。
//   取帧长的一半（512 采样）可覆盖 43Hz 以上，实测基频误差压到
//   -1 ~ +4 音分。
//
// 性能：
//
//   门限大意味着搜索范围大。用两级搜索控制成本：
//     粗搜：每 COARSE 个采样算一次相似度
//     精搜：在最优点 ±COARSE 内逐点细化
//   代价降到约 1/COARSE，精度损失可忽略（±8 采样远小于帧长）。
//
// 已知限制：
//   - 极端速率（<0.5 或 >2.0）有颗粒感，由 STRETCH_LIMITS 拦住
//   - 复调密集时可能选错帧，中频略糊

const FRAME = 1024
// 搜索门限要覆盖至少一个基音周期，否则低音（100–300Hz，周期 150–440 采样）
// 根本找不到相位对齐点，拉伸后频谱会被破坏（实测基频偏 ±250 音分）。
// 取帧长的一半，可覆盖 43Hz 以上；代价是搜索范围大、计算量上升。
const TOLERANCE = 0.5
const COARSE = 8      // 粗搜步长（采样），8 在 44.1kHz 下约 0.18ms

const hannCache = new Map()
function hann(n) {
  let w = hannCache.get(n)
  if (w) return w
  w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  hannCache.set(n, w)
  return w
}

// 归一化互相关：判断 input[s..] 和 input[refStart..] 是否相位对齐
function score(input, s, refStart, len) {
  let num = 0, da = 0, db = 0
  const lim = Math.min(len, input.length - s, input.length - refStart)
  for (let i = 0; i < lim; i++) {
    const x = input[s + i] || 0
    const y = input[refStart + i] || 0
    num += x * y
    da += x * x
    db += y * y
  }
  const den = Math.sqrt(da * db)
  return den > 1e-9 ? num / den : 0
}

/**
 * 单声道时间伸缩。
 * @param {Float32Array} input
 * @param {number} rate  >1 变快（时长变短），<1 变慢（时长变长）
 * @returns {Float32Array}
 */
export function timeStretchMono(input, rate) {
  const n = input.length
  if (!n || !(rate > 0)) return input
  if (Math.abs(rate - 1) < 0.002) return input

  const frame = Math.min(FRAME, Math.max(256, Math.floor(n / 4)))
  const hop = Math.max(1, Math.floor(frame / 2))
  // 输出的 hop 对应输入的 hop*rate（见文件头推导）
  const analyzeHop = hop * rate
  const tol = Math.max(2, Math.floor(frame * TOLERANCE))
  const win = hann(frame)

  const target = Math.max(1, Math.round(n / rate))
  const outLen = target + frame
  const out = new Float32Array(outLen)
  const weight = new Float32Array(outLen)

  let stepPos = 0
  let anchor = 0
  let outPos = 0
  let first = true

  while (outPos + frame <= outLen) {
    let inp = Math.round(stepPos)
    if (inp + frame > n) inp = Math.max(0, n - frame)
    if (inp < 0) inp = 0

    if (!first) {
      // 候选范围以名义位置为中心，参考是上一帧在 anchor+hop 处的尾部
      const refStart = Math.min(Math.max(0, n - 1), anchor + hop)
      const lo = Math.max(0, inp - tol)
      const hi = Math.min(Math.max(0, n - frame), inp + tol)
      const cmpLen = Math.max(1, Math.min(hop, n - refStart))

      // 粗搜：每 COARSE 个采样一次
      let bestS = inp
      let bestV = -Infinity
      for (let s = lo; s <= hi; s += COARSE) {
        const v = score(input, s, refStart, cmpLen)
        if (v > bestV) { bestV = v; bestS = s }
      }
      // 精搜：粗搜最优点附近逐点细化
      const flo = Math.max(lo, bestS - COARSE)
      const fhi = Math.min(hi, bestS + COARSE)
      for (let s = flo; s <= fhi; s++) {
        const v = score(input, s, refStart, cmpLen)
        if (v > bestV) { bestV = v; bestS = s }
      }
      inp = Math.max(0, Math.min(Math.max(0, n - frame), bestS))
    }

    for (let i = 0; i < frame; i++) {
      const o = outPos + i
      if (o >= outLen) break
      out[o] += (input[inp + i] || 0) * win[i]
      weight[o] += win[i]
    }

    anchor = inp
    stepPos += analyzeHop
    outPos += hop
    first = false
  }

  const result = new Float32Array(target)
  for (let i = 0; i < target; i++) {
    const w = weight[i]
    result[i] = w > 1e-6 ? out[i] / w : 0
  }
  return result
}

/**
 * 多声道时间伸缩。
 * @param {AudioContext|OfflineAudioContext} ctx
 * @param {AudioBuffer} buffer
 * @param {number} rate
 */
export function timeStretch(ctx, buffer, rate) {
  if (!buffer || Math.abs(rate - 1) < 0.002) return buffer
  const ch = buffer.numberOfChannels
  const stretched = timeStretchMono(buffer.getChannelData(0), rate)
  const out = ctx.createBuffer(ch, stretched.length, buffer.sampleRate)
  out.getChannelData(0).set(stretched)
  for (let c = 1; c < ch; c++) {
    out.getChannelData(c).set(timeStretchMono(buffer.getChannelData(c), rate))
  }
  return out
}

export function stretchedLength(frames, rate) {
  if (!(rate > 0)) return frames
  return Math.max(1, Math.round(frames / rate))
}

export const STRETCH_LIMITS = { min: 0.5, max: 2.0 }
