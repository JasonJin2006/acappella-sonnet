// 麦克风开启的唯一入口。
//
// 为什么需要这一层
// ----------------
// 采集链路（录音、哼唱、跟唱）都必须关掉浏览器的自动增益（AGC）：
// 它会把电平一路推到 0 dBFS，波形削平后听起来是持续的刺啦，录进去也救不回来。
//
// 但「关哪些」不能想当然。实测 HONOR ALI-AN00 / MagicOS 9（Android 15，WebView 150）：
//   - 只要在约束里关掉 echoCancellation（或它连带关掉 noiseSuppression），
//     AudioFlinger 的输入线程就切到 HAL format 0x4（AUDIO_FORMAT_PCM_8_24_BIT），
//     而 WebView 把这份定点数据当浮点交出来，AnalyserNode 读数变成 ±256
//     （正常范围 ±1，实测比值恰为 256 倍）。
//   - 症状：静音时也报满幅、频谱全频段乱跳、YIN 永远返回 freq=0。
//     于是「跟唱永远听不见」「哼唱识别不到旋律」「录音全是削顶」。
//   - 只关 autoGainControl、保留 echoCancellation 时，HAL 走 0x1（PCM_16_BIT），
//     读数正常（±0.01 量级），AGC 也确实关掉了（applied.autoGainControl=false）。
//
// 所以首选口径是「只关 AGC」。万一某台设备给出的量纲仍然不对，再退回浏览器默认，
// 至少保证功能可用。探测结果按会话缓存，不会每次开麦都多花一次授权。

// 首选：只关 AGC，保留 AEC / 降噪（它们不影响 AGC 的目标，还能保住采集格式）
const PREFERRED = { autoGainControl: false }

// 兜底：浏览器默认口径
const FALLBACK = true

// 「坏数据」判据：正常浮点时域样本落在 [-1, 1]。允许一点过载余量，
// 超过 1.5 就认定量纲错了（正常麦克风不会到 1.5）。
const SANE_LIMIT = 1.5

let decision = null // null 未探测 | 'preferred' | 'fallback'

function readPeak(analyser, buf) {
  analyser.getFloatTimeDomainData(buf)
  let peak = 0
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] < 0 ? -buf[i] : buf[i]
    if (v > peak) peak = v
  }
  return peak
}

// 读一小段时间里的最大峰值，用来判断这条约束拿到的数据能不能用
async function measurePeak(stream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  try {
    const src = ctx.createMediaStreamSource(stream)
    const an = ctx.createAnalyser()
    an.fftSize = 2048
    an.smoothingTimeConstant = 0
    src.connect(an)
    const buf = new Float32Array(an.fftSize)
    let worst = 0
    // 连读几帧，避开刚开麦时的全零缓冲
    for (let i = 0; i < 8; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 90))
      const p = readPeak(an, buf)
      if (p > worst) worst = p
    }
    try { src.disconnect() } catch (e) {}
    return worst
  } finally {
    try { await ctx.close() } catch (e) {}
  }
}

function openStream(constraints) {
  return navigator.mediaDevices.getUserMedia({ audio: constraints })
}

/**
 * 开一路麦克风，返回 MediaStream。
 * 首选「只关 AGC」的口径；数据量纲明显不对时自动退回浏览器默认口径。
 *
 * @param {{ channelCount?: number }} [opts]
 * @returns {Promise<MediaStream>}
 */
export async function openMic(opts = {}) {
  const preferred = opts.channelCount
    ? { ...PREFERRED, channelCount: opts.channelCount }
    : PREFERRED

  if (decision === 'fallback') return openStream(FALLBACK)
  if (decision === 'preferred') return openStream(preferred)

  // 第一次：按首选口径真开一次，并当场验证量纲
  let stream = null
  try {
    stream = await openStream(preferred)
  } catch (e) {
    // 首选口径开不起来（权限除外）：交给默认口径再试
    decision = 'fallback'
    return openStream(FALLBACK)
  }

  const worst = await measurePeak(stream)
  if (worst < SANE_LIMIT) {
    decision = 'preferred'
    return stream
  }

  // 量纲坏了：丢掉这路流，换默认口径
  stream.getTracks().forEach((t) => t.stop())
  decision = 'fallback'
  return openStream(FALLBACK)
}
