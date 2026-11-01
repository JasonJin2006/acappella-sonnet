// 迭代式基 2 FFT。离线分析需要频谱，而 AnalyserNode 只在实时音频图里可用，
// 所以这里自己算一份，给 MultiPitch 的谐波求和用。
export function magnitudeSpectrum(samples, size, win) {
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const n = Math.min(size, samples.length)
  for (let i = 0; i < n; i++) {
    // Hann 窗，减少频谱泄漏，否则相邻半音会互相污染
    const w = win ? win(i, size) : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, size - 1))
    re[i] = samples[i] * w
  }
  // 位反转置换
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < size; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const vr = re[b] * cr - im[b] * ci
        const vi = re[b] * ci + im[b] * cr
        re[b] = re[a] - vr
        im[b] = im[a] - vi
        re[a] += vr
        im[a] += vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
  const mag = new Float32Array(size / 2 + 1)
  for (let i = 0; i <= size / 2; i++) mag[i] = Math.hypot(re[i], im[i])
  return mag
}
