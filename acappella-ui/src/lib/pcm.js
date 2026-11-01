// 浮点采样 → 16-bit 有符号整数。
//
// 负半轴乘 0x8000、正半轴乘 0x7fff：Int16 的范围是 -32768..32767，
// 两侧不对称。统一乘 32768 的话 +1.0 会溢出成 -32768，听感上就是一声爆音。
//
// WAV 写入、MP3 编码、原生音频传输、工程存档都要这一步。四份实现曾经
// 各写一遍，其中一份漏了钳位，只在削顶时才会暴露，很难查。

export function floatToInt16(v) {
  const x = v < -1 ? -1 : v > 1 ? 1 : (v || 0)
  return x < 0 ? x * 0x8000 : x * 0x7fff
}

/** 多声道 Float32Array → 交错 Int16Array */
export function interleaveToInt16(channels) {
  const numCh = channels.length
  const frames = numCh ? channels[0].length : 0
  const out = new Int16Array(frames * numCh)
  for (let c = 0; c < numCh; c++) {
    const src = channels[c]
    for (let i = 0; i < frames; i++) out[i * numCh + c] = floatToInt16(src[i])
  }
  return out
}
