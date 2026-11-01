// 音频波形的编辑操作。
//
// 全部在 AudioBuffer 上做，不碰 MediaRecorder 的原始 blob——录音一旦解码，
// 编辑就是在解码后的 PCM 上切片/加窗，最后生成一个新的 AudioBuffer 给混音器。
// 这样不用重新编码，也不需要 Web Audio 的渲染循环。
//
// 设计约束：
//   - 不做撤销栈（编辑是幂等的，用户不满意就重新录音；撤销栈要存整段 PCM，
//     一分钟立体声就 10 MB，手机上放不下）
//   - 每个操作都返回新 buffer，不原地改，方便 React 判断变化
//   - 时间坐标全部用「录音内的秒」，和 Mixer 的排期逻辑一致

// 复制一段 PCM。from/to 是秒，超出范围自动裁剪。
export function trimBuffer(ctx, buffer, fromSec, toSec) {
  if (!buffer) return null
  const sr = buffer.sampleRate
  const from = Math.max(0, Math.min(buffer.duration, fromSec))
  const to = Math.max(from, Math.min(buffer.duration, toSec))
  const frames = Math.max(1, Math.round((to - from) * sr))
  const out = ctx.createBuffer(buffer.numberOfChannels, frames, sr)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c)
    const dst = out.getChannelData(c)
    const start = Math.round(from * sr)
    for (let i = 0; i < frames; i++) dst[i] = src[start + i] || 0
  }
  return out
}

// 线性增益。gain > 1 会放大，超过 1 的部分在混音器里由限幅器兜住。
export function gainBuffer(ctx, buffer, gain) {
  if (!buffer) return null
  const g = Math.max(0, Math.min(4, gain))
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c)
    const dst = out.getChannelData(c)
    for (let i = 0; i < src.length; i++) dst[i] = src[i] * g
  }
  return out
}

// 在 [fromSec, toSec] 区间内做线性淡入（from→to 从 0 升到 1）。
// 区间外保持原样；这样可以对选区单独做淡入。
export function fadeIn(ctx, buffer, fromSec, toSec) {
  if (!buffer) return null
  const sr = buffer.sampleRate
  const from = Math.max(0, Math.min(buffer.duration, fromSec))
  const to = Math.max(from, Math.min(buffer.duration, toSec))
  const out = cloneBuffer(ctx, buffer)
  const a = Math.round(from * sr)
  const b = Math.round(to * sr)
  const n = Math.max(1, b - a)
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c)
    for (let i = 0; i < n && a + i < d.length; i++) d[a + i] *= i / n
  }
  return out
}

// 线性淡出（from→to 从 1 降到 0）
export function fadeOut(ctx, buffer, fromSec, toSec) {
  if (!buffer) return null
  const sr = buffer.sampleRate
  const from = Math.max(0, Math.min(buffer.duration, fromSec))
  const to = Math.max(from, Math.min(buffer.duration, toSec))
  const out = cloneBuffer(ctx, buffer)
  const a = Math.round(from * sr)
  const b = Math.round(to * sr)
  const n = Math.max(1, b - a)
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c)
    for (let i = 0; i < n && a + i < d.length; i++) d[a + i] *= 1 - i / n
  }
  return out
}

// 静音一段（选区删除）。和「剪切」不同：保留时长，只是把那段清零。
// 多轨对齐的场景下保留时长更重要，否则后面整条都往前挪了。
export function silenceRange(ctx, buffer, fromSec, toSec) {
  if (!buffer) return null
  const sr = buffer.sampleRate
  const from = Math.max(0, Math.min(buffer.duration, fromSec))
  const to = Math.max(from, Math.min(buffer.duration, toSec))
  const out = cloneBuffer(ctx, buffer)
  const a = Math.round(from * sr)
  const b = Math.round(to * sr)
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c)
    for (let i = a; i < b && i < d.length; i++) d[i] = 0
  }
  return out
}

// 归一化到目标峰值
export function normalizeBuffer(ctx, buffer, target = 0.9) {
  if (!buffer) return null
  let peak = 0
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c)
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i])
      if (v > peak) peak = v
    }
  }
  if (peak <= 1e-6) return cloneBuffer(ctx, buffer)
  return gainBuffer(ctx, buffer, target / peak)
}

function cloneBuffer(ctx, buffer) {
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.getChannelData(c).set(buffer.getChannelData(c))
  }
  return out
}

/**
 * 把波形抽成 min/max 包络，用来画图。
 *
 * 不直接画几万个采样点：一屏只有 300–400 像素，用每列一个 min/max 就够了，
 * 而且能保留尖峰（只取平均会看不出削顶）。
 *
 * @param {AudioBuffer} buffer
 * @param {number} columns 期望的列数（通常等于画布宽度）
 * @param {number} [fromSec]
 * @param {number} [toSec]
 * @returns {{min: Float32Array, max: Float32Array, len: number}}
 */
export function waveformEnvelope(buffer, columns, fromSec, toSec) {
  const cols = Math.max(1, Math.floor(columns))
  const min = new Float32Array(cols)
  const max = new Float32Array(cols)
  if (!buffer) return { min, max, len: cols }
  const sr = buffer.sampleRate
  const from = Math.max(0, fromSec == null ? 0 : fromSec)
  const to = Math.min(buffer.duration, toSec == null ? buffer.duration : toSec)
  const ch = buffer.getChannelData(0)   // 波形只看第一声道，够表示了
  const a = Math.round(from * sr)
  const b = Math.round(to * sr)
  const span = Math.max(1, b - a)
  for (let x = 0; x < cols; x++) {
    const s = a + Math.floor((x / cols) * span)
    const e = a + Math.floor(((x + 1) / cols) * span)
    let lo = 1
    let hi = -1
    for (let i = s; i < e && i < ch.length; i++) {
      const v = ch[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    // 空区间（超出缓冲区）画成 0
    min[x] = lo > hi ? 0 : lo
    max[x] = lo > hi ? 0 : hi
  }
  return { min, max, len: cols }
}
