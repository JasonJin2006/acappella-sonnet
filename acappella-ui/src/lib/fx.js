// 播放/渲染共用的效果器链。
//
// 之前这些参数是写死在 player.js 和 render.js 里的两份拷贝（限幅 -7dB/3:1、
// 混响 1.8s/干湿 0.2、声像 -0.35..+0.35），改一个地方另一个就不同步。
// 现在集中到这里：一处定义默认值，两处都用，导出和试听的听感天然一致。
//
// 参数都在 0..1 的「音乐化」区间里暴露给界面，内部换算成 dB / 秒 / 倍率。
// 直接暴露 dB 和比率对普通用户没意义。

export const DEFAULT_FX = {
  // 混响：0..1，映射到干湿 0..0.5、时长 0.6..4.0 秒
  reverbMix: 0.4,
  // 混响时长：0..1，映射到 0.6..4.0 秒（只影响脉冲响应，生成一次）
  reverbTime: 0.35,
  // 声像宽度：0 = 所有声部都在中间，1 = 左右铺满（当前是 -0.35..+0.35）
  panWidth: 1,
  // 限幅器阈值：0..1，映射到 -24..0 dB。越大越「压不住」，越小越安全
  limiterThreshold: 0.71,   // ≈ -7 dB
  // 限幅比：0..1，映射到 1:1..10:1
  limiterRatio: 0.22,       // ≈ 3:1
  // 主音量之外的输出增益：0..1 -> 0..1.5 倍
  outputGain: 0.67,
}

// 0..1 → [lo, hi] 线性插值
const map = (v, lo, hi) => lo + (Math.max(0, Math.min(1, v)) * (hi - lo))

export function reverbSeconds(fx) {
  return map(fx.reverbTime, 0.6, 4.0)
}

export function reverbWet(fx) {
  return map(fx.reverbMix, 0, 0.5)
}

export function panSpread(fx) {
  return map(fx.panWidth, 0, 0.7) / 2   // ±0..0.35
}

export function limiterThresholdDb(fx) {
  return map(fx.limiterThreshold, -24, 0)
}

export function limiterRatioValue(fx) {
  return map(fx.limiterRatio, 1, 10)
}

export function outputGainValue(fx) {
  return map(fx.outputGain, 0, 1.5)
}

// 合成混响脉冲响应：指数衰减的暗噪声。
// 和以前 player.js / render.js 里的实现一致，只是把时长变成参数。
// 噪声是随机的，同一段参数每次生成都不同——但混响尾巴本身听不出差异，
// 而且 mimpulse 只生成一次缓存起来。
export function makeImpulse(ctx, seconds = 1.8, decay = 2.2) {
  const rate = ctx.sampleRate
  const len = Math.max(1, Math.floor(rate * seconds))
  const buf = ctx.createBuffer(2, len, rate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    let last = 0
    for (let i = 0; i < len; i++) {
      const t = i / len
      // 一阶低通：白噪声磨成偏暗的尾巴
      last = last * 0.62 + (Math.random() * 2 - 1) * 0.38
      data[i] = last * Math.pow(1 - t, decay)
    }
  }
  return buf
}

/**
 * 在给定的 AudioContext 里搭一条效果链：
 *
 *   声部各轨 → bus → ┬→ limiter → output → dest
 *                    └→ reverb → wet ─┘
 *
 * @param {AudioContext|OfflineAudioContext} ctx
 * @param {object} fx  见 DEFAULT_FX
 * @param {AudioNode} dest  最终输出节点（通常是 ctx.destination 或 cue.master）
 * @param {AudioBuffer} [impulse]  复用的脉冲响应；不传就按 fx 生成
 * @returns {{bus, limiter, reverb, wet, output, impulse}}
 */
export function buildFxChain(ctx, fx, dest, impulse) {
  const f = { ...DEFAULT_FX, ...(fx || {}) }

  const bus = ctx.createGain()
  bus.gain.value = 1

  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = limiterThresholdDb(f)
  limiter.knee.value = 12
  limiter.ratio.value = limiterRatioValue(f)
  limiter.attack.value = 0.01
  limiter.release.value = 0.3

  const output = ctx.createGain()
  output.gain.value = outputGainValue(f)

  let reverb = null
  let wet = null
  if (reverbWet(f) > 0.001) {
    reverb = ctx.createConvolver()
    reverb.buffer = impulse || makeImpulse(ctx, reverbSeconds(f), 2.2)
    wet = ctx.createGain()
    wet.gain.value = reverbWet(f)
    bus.connect(reverb)
    reverb.connect(wet)
    wet.connect(limiter)
  }

  bus.connect(limiter)
  limiter.connect(output)
  output.connect(dest)

  return { bus, limiter, reverb, wet, output, impulse: reverb ? reverb.buffer : null }
}

/**
 * 声部声像：第 i 个声部在 -spread..+spread 之间均匀铺开。
 * 单声部居中，多声部左到右铺满。
 */
export function panFor(index, count, fx) {
  const spread = panSpread({ ...DEFAULT_FX, ...(fx || {}) })
  if (count <= 1) return 0
  return -spread + (2 * spread * index) / (count - 1)
}

// 声部音量：主旋律略高，内声部约低 1.6 dB（和以前的设定一致）
export function partGainFor(index) {
  return index === 0 ? 1 : 0.82
}

/**
 * 拆掉整条效果链。停止播放时调用，避免节点泄漏。
 * bass 和 reverb 之间是两路，都要断。
 */
export function disposeFxChain(chain) {
  if (!chain) return
  for (const node of [chain.bus, chain.reverb, chain.wet, chain.limiter, chain.output]) {
    if (!node) continue
    try { node.disconnect() } catch (e) { /* 可能已经被回收 */ }
  }
}
