// 速度表：把「第几拍」和「第几秒」互相换算。
//
// 为什么需要独立的模块
// --------------------
// 之前整条链路都假设全曲一个 bpm：`spb = 60/bpm` 算一次到处用。
// 但真实谱面会在中途变速（这份《Echo》在 1/8/64/73 小节分别标了
// 65/95/80/95），于是：
//   - 播放：所有音按第一个速度排，中段开始整体提前或拖后
//   - 进度条：位置 = 拍/总拍，和实际听到的进度对不上
//   - 跟唱：跟谱器用固定 secPerBeat 建模"这个音该唱多久"，变速段落
//     每个音都会算错，表现为光标越走越偏
//   - 导出：WAV 和 MIDI 都把变速抹平成一个速度
//
// 内部表示：一个按拍升序的 [ {beat, bpm} ] 数组。第 0 项必须是 beat 0。
// 拍 → 秒用分段线性累加，秒 → 拍用二分 + 段内线性反解。

// 一个速度段的瞬时"每秒多少拍"
const bps = (bpm) => Math.max(1, bpm || 96) / 60

/**
 * 把各种写法的速度标记整理成规范的速度表。
 *
 * 输入可以是：
 *   - 空 / undefined：退化成单速（bpm 参数或默认 96）
 *   - [{beat, bpm}, ...]：已经是速度表
 *   - [{atBeat, tempo}, ...]：别名写法
 * 返回的数组一定非空、按拍升序、首项 beat === 0。
 */
export function normalizeTempoMap(map, fallbackBpm = 96) {
  const base = Math.max(1, fallbackBpm || 96)
  if (!Array.isArray(map) || !map.length) return [{ beat: 0, bpm: base }]

  const pts = []
  for (const m of map) {
    if (!m) continue
    const beat = Number(m.beat != null ? m.beat : m.atBeat)
    const bpm = Number(m.bpm != null ? m.bpm : m.tempo)
    if (!Number.isFinite(beat) || !Number.isFinite(bpm)) continue
    if (bpm < 1) continue
    pts.push({ beat: Math.max(0, beat), bpm })
  }
  if (!pts.length) return [{ beat: 0, bpm: base }]
  pts.sort((a, b) => a.beat - b.beat)

  // 同拍重复取最后一个（后写的标记覆盖前面的），首项补齐到 0
  const out = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.beat - p.beat) < 1e-6) out[out.length - 1] = p
    else out.push(p)
  }
  if (out[0].beat > 1e-6) out.unshift({ beat: 0, bpm: out[0].bpm })
  else out[0] = { beat: 0, bpm: out[0].bpm }
  return out
}

/**
 * 速度表 → 可直接使用的换算器。
 *
 * rate 是播放速率（0.5..2，1 = 原速），乘在每个 bpm 上：
 * 变速播放时整条速度表一起缩放，段与段的比例不变。
 */
export class TempoMap {
  constructor(map, fallbackBpm = 96, rate = 1) {
    this.points = normalizeTempoMap(map, fallbackBpm)
    this.rate = Math.max(0.05, Math.min(4, rate || 1))
    // 预算每段的起始秒，避免每次换算都从头累加
    this.secs = []
    let t = 0
    for (let i = 0; i < this.points.length; i++) {
      this.secs.push(t)
      if (i + 1 < this.points.length) {
        const b0 = this.points[i].beat
        const b1 = this.points[i + 1].beat
        t += (b1 - b0) / bps(this.points[i].bpm * this.rate)
      }
    }
    this._lastSeg = null
  }

  // 从速度表直接构造（score/opts 的常用组合）
  static from(score, opts = {}) {
    const bpm = (score && score.bpm) || 96
    return new TempoMap(score && score.tempos, bpm, opts.rate || 1)
  }
  /** 第 beat 拍是这个速度段的第几段 */
  _segAt(beat) {
    const pts = this.points
    // 快路径：上一个查询落在同一段就直接用。
    // _pump 是按拍顺序扫音符的，绝大多数调用命中，省掉一次二分。
    const last = this._lastSeg
    if (last != null && last < pts.length) {
      const seg = pts[last]
      const nextBeat = last + 1 < pts.length ? pts[last + 1].beat : Infinity
      if (beat >= seg.beat && beat < nextBeat) return last
    }
    let lo = 0
    let hi = pts.length - 1
    if (beat <= pts[0].beat) { this._lastSeg = 0; return 0 }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (pts[mid].beat <= beat) lo = mid
      else hi = mid - 1
    }
    this._lastSeg = lo
    return lo
  }

  /** 第 beat 拍对应的秒数（从全曲开头算） */
  secAt(beat) {
    const b = Math.max(0, beat || 0)
    const i = this._segAt(b)
    const seg = this.points[i]
    return this.secs[i] + (b - seg.beat) / bps(seg.bpm * this.rate)
  }

  /** 第 sec 秒对应第几拍（secAt 的反函数） */
  beatAt(sec) {
    const s = Math.max(0, sec || 0)
    const pts = this.points
    // 找最后一个「起始秒 <= s」的段
    let lo = 0
    let hi = pts.length - 1
    if (s <= 0) return 0
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.secs[mid] <= s) lo = mid
      else hi = mid - 1
    }
    const seg = pts[lo]
    return seg.beat + (s - this.secs[lo]) * bps(seg.bpm * this.rate)
  }

  /** 第 beat 拍此刻的瞬时速度（拍/秒），不含 rate 的语义混乱 */
  beatsPerSecAt(beat) {
    const seg = this.points[this._segAt(Math.max(0, beat || 0))]
    return bps(seg.bpm * this.rate)
  }

  /** 第 beat 拍此刻的秒/拍（= 1 / beatsPerSecAt） */
  secPerBeatAt(beat) {
    return 1 / this.beatsPerSecAt(beat)
  }
}
