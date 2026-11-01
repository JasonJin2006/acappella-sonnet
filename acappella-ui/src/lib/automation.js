// 力度自动化：把「整首一个力度」或「逐音写死」升级成按小节的可编辑曲线。
//
// 数据模型：automation = [{ bar: 0, value: 0.34 }, { bar: 4, value: 0.84 }, ...]
//   - bar 是小节下标（0 起）
//   - value 是 0..1 的力度
//   - 相邻两个控制点之间线性插值
//   - 数组按 bar 升序，允许不连续（没覆盖的小节沿用自前一个点）
//
// 为什么不存「每个音一个力度」：那样 8 声部 100 小节会有上千个数值，
// localStorage 存不下也不直观。按小节采样足够表达渐强渐弱，
// 需要精确到单个音时仍然可以在文本记谱里写 C4 1 mf。
//
// 应用顺序（见 applyAutomation）：
//   1. 自动化曲线按音所在小节给出基准力度
//   2. 文本记谱里显式写的力度优先（用户手写的不能被曲线盖掉）
//   3. 都没有就是默认 mf

export const DEFAULT_VELOCITY = 0.58

/**
 * 在第 bar 小节处的自动化力度。
 * 控制点按 bar 升序；第一个点之前用第一个点的值，最后一个点之后用最后一个点的值。
 * @param {Array<{bar:number,value:number}>} points
 * @param {number} bar
 * @returns {number|null}  没有控制点时返回 null
 */
export function valueAt(points, bar) {
  if (!points || !points.length) return null
  const pts = points
  if (bar <= pts[0].bar) return pts[0].value
  if (bar >= pts[pts.length - 1].bar) return pts[pts.length - 1].value
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (bar >= a.bar && bar <= b.bar) {
      const span = b.bar - a.bar
      if (span <= 0) return b.value
      const t = (bar - a.bar) / span
      return a.value + (b.value - a.value) * t
    }
  }
  return pts[pts.length - 1].value
}

/**
 * 把自动化曲线应用到整份谱面。
 *
 * 只改「没有显式力度」的音——文本记谱里写了 mf / pp 的音保持原样，
 * 否则用户手写的力度会被曲线悄悄覆盖掉，而且再打开文本编辑会看到
 * 一堆不是自己写的内容。
 *
 * @param {object} score
 * @param {Array<{bar:number,value:number}>} points
 * @param {number} barBeats
 * @returns {object} 新的 score（不修改入参）
 */
export function applyAutomation(score, points, barBeats) {
  if (!points || !points.length) return score
  const bar = Math.max(1, barBeats || score.bar || 4)
  return {
    ...score,
    parts: score.parts.map((p) => {
      let beat = 0
      return {
        ...p,
        notes: p.notes.map((n) => {
          const idx = Math.floor(beat / bar + 1e-9)
          const at = beat
          beat += n.beats
          // 显式力度优先
          if (n.explicitVel) return n
          const v = valueAt(points, idx)
          if (v == null) return n
          return { ...n, vel: +v.toFixed(3), at }
        }),
      }
    }),
  }
}

// 从当前谱面反推一条自动化曲线。
//
// 关键是压缩：整首力度一样时只留一个点，而不是每小节一个。
// 早期实现每小节都产一个点，结果用户点第一小节和最后一小节时，
// 中间 6 个 0.58 的点还在，曲线变成「两端变、中间不动」——
// 看起来像 bug，实际是数据形状不对。
//
// 压缩规则：
//   - 值相同的小节合并（保留第一个）
//   - 只在值「变了」的地方留点，线性插值能还原
export function extractAutomation(score, barBeats) {
  const bar = Math.max(1, barBeats || score.bar || 4)
  const part = score.parts && score.parts[0]
  if (!part) return []
  const byBar = new Map()
  let beat = 0
  for (const n of part.notes) {
    const idx = Math.floor(beat / bar + 1e-9)
    beat += n.beats
    if (n.midi == null) continue
    if (!byBar.has(idx) && n.vel != null) byBar.set(idx, n.vel)
  }
  const raw = [...byBar.entries()].sort((a, b) => a[0] - b[0])
  if (!raw.length) return []

  // 只保留「值发生变化」的小节，外加第一个
  const pts = []
  let prev = null
  for (const [b, v] of raw) {
    if (prev == null || Math.abs(v - prev) > 0.005) {
      pts.push({ bar: b, value: +v.toFixed(3) })
      prev = v
    }
  }
  return pts
}

// 增/改一个控制点（同小节已有就替换）
export function setPoint(points, bar, value) {
  const v = Math.max(0.05, Math.min(1, value))
  const list = (points || []).filter((p) => p.bar !== bar)
  list.push({ bar, value: +v.toFixed(3) })
  return list.sort((a, b) => a.bar - b.bar)
}

// 删一个控制点
export function removePoint(points, bar) {
  return (points || []).filter((p) => p.bar !== bar)
}

// 力度档位名（和 music.js 的 DYNAMICS 对应），给 UI 显示用
export const VEL_MARKS = [
  [0.16, 'ppp'],
  [0.24, 'pp'],
  [0.34, 'p'],
  [0.46, 'mp'],
  [0.58, 'mf'],
  [0.72, 'f'],
  [0.84, 'ff'],
  [0.94, 'fff'],
]

export function markOf(value) {
  if (value == null) return ''
  let best = 'mf'
  let bd = Infinity
  for (const [v, m] of VEL_MARKS) {
    const d = Math.abs(v - value)
    if (d < bd) { bd = d; best = m }
  }
  return best
}
