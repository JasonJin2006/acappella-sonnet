// 冷启动定位器。
//
// 为什么需要它：逐帧 DTW 的代价是从开头一路累积的，只有"已经跟了一段"才可靠。
// 中途加入时没有历史积累，而同一个和声在曲子里往往出现不止一次
// （欢乐颂第 1~3 小节和第 5~7 小节旋律完全一样），只看当下分不出是 A 段还是 A' 段。
//
// 做法：先攒一小段观测窗口，再对「每个候选起点 × 每个候选速度」把整段窗口
// 一次性对齐到谱面上打分。窗口里靠后的那些帧，相对窗口起点来说就是"未来信息"，
// 歧义因此小很多。
//
// 这不等于跟随慢半拍：定位只在冷启动时跑这一次。锁定之后位置默认接着走，
// 只有连续严重不匹配才会回到这里重新定位。

const EARLY_SEC = 0.85      // 有明确优势时可以提前锁定的最早时刻
const HARD_SEC = 5.0        // 攒到这么久还分不出就认了（再等也没用）
const EARLY_MARGIN = 0.06   // 区分度到这个数就立刻锁定，不必再攒
                            // 实测：真正的段落差异约 0.08，本征歧义时接近 0
const MAX_DUR = 9           // 窗口上限，超过就丢掉最前面的帧
const TEMPOS = [0.80, 1.0, 1.25]
const OCTS = [0, 12, -12]     // 整体高/低八度唱（男声团唱女高谱很常见）
const MIN_RUN = 0.35        // 至少连续这么久都有人唱，才认是在演唱
                            // （零星几帧的假检出不算，环境噪声偶尔会冒出假基频）
const MIN_DISTINCT = 2      // 窗口里至少出现过这么多个不同音高
const HARM_SOLO = 15        // 或者谐波评分高到这个数，说明确实是人声在唱长音
                            // 空调嗡嗡声是"一个音高恒定不变"，两条都不满足
const LOCK_MAX = 0.6        // 定位质量门槛：平均偏差比这还大就不认，继续等
const PRIOR_W = 0.002       // 先验每差一拍的代价权重
                            // 必须远小于真实的段落区分度（~0.1），否则先验会盖过证据

// 事件边界 = 所有参与声部音符起止点的并集。每个事件记录此刻各声部在唱什么。
function buildEvents(parts) {
  const bounds = new Set([0])
  for (const p of parts) {
    let acc = 0
    for (const n of p.notes) { acc += n.beats; bounds.add(acc) }
  }
  const bs = [...bounds].sort((a, b) => a - b)
  const events = []
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i]
    const items = []
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi]
      let acc = 0
      for (const n of p.notes) {
        if (acc <= b + 1e-9 && b < acc + n.beats - 1e-9) {
          if (n.midi != null) items.push({ part: pi, midi: n.midi })
          break
        }
        acc += n.beats
      }
    }
    events.push({ beat: b, beats: i + 1 < bs.length ? bs[i + 1] - b : 1, items })
  }
  return events
}

export class ColdStartAligner {
  constructor(parts, opts) {
    this.bpm = (opts && opts.bpm) || 96
    this.secPerBeat = 60 / this.bpm
    this.events = buildEvents(parts)
    this.n = this.events.length
    this.totalBeats = parts.reduce(
      (mx, p) => Math.max(mx, p.notes.reduce((a, n) => a + n.beats, 0)), 0)
    this.partCount = parts.length
    this._only = []
    for (let k = 0; k < this.partCount; k++) this._only[k] = new Set([k])
    this.reset()
  }

  reset() {
    this.frames = []
    this.dur = 0
    this.voicedDur = 0
    this.run = 0
    this.peakRun = 0
    this.maxHarm = 0
    this.seen = new Set()
    this.distinct = 0
    this._busy = 0
  }

  add(dt, midis, harm) {
    if (!(dt > 0)) return
    const has = !!(midis && midis.length)
    this.frames.push({ t: this.dur, dt, midis: has ? midis.slice() : null })
    this.dur += dt
    if (has) {
      this.voicedDur += dt
      this.run += dt
      if (this.run > this.peakRun) this.peakRun = this.run
      const h = harm || 0
      if (h > this.maxHarm) this.maxHarm = h
      for (const m of midis) {
        // 按 2 个半音分档：同一音的细微抖动（37/38）不该算成"换了音高"
        const q = Math.round(m / 2)
        if (!this.seen.has(q)) { this.seen.add(q); this.distinct++ }
      }
    } else {
      this.run = 0
    }
    if (this.dur > MAX_DUR) this._trim()
  }

  _trim() {
    let drop = 0
    while (this.frames.length > 2 && this.dur - (this.frames[0].t + this.frames[0].dt) > 3) {
      const f = this.frames.shift()
      drop = f.t + f.dt
    }
    if (drop > 0) {
      for (const f of this.frames) f.t -= drop
      this.dur -= drop
    }
    this.voicedDur = 0; this.peakRun = 0; this.run = 0; this.distinct = 0
    this.seen = new Set()
    for (const f of this.frames) {
      if (!f.midis) { this.run = 0; continue }
      this.voicedDur += f.dt
      this.run += f.dt
      if (this.run > this.peakRun) this.peakRun = this.run
      for (const m of f.midis) {
        // 按 2 个半音分档：同一音的细微抖动（37/38）不该算成"换了音高"
        const q = Math.round(m / 2)
        if (!this.seen.has(q)) { this.seen.add(q); this.distinct++ }
      }
    }
  }

  // 给定拍 → 事件序号；超出谱面范围返回 -1
  indexAt(beat) {
    const ev = this.events
    if (!ev.length || beat < -1e-9 || beat >= this.totalBeats) return -1
    let lo = 0, hi = ev.length - 1, ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (ev[mid].beat <= beat + 1e-9) { ans = mid; lo = mid + 1 }
      else hi = mid - 1
    }
    return ans
  }

  // 此刻谱面要求这些音（八度归一后）与听到的音差多远。0 = 完全吻合
  //
  // 必须一对一分配，不能各算各的：欢乐颂这类和弦音重叠很多，
  // 若允许同一个观测音被好几个期望音重复认领，不同段落的代价会几乎一样，
  // 结果就是分不出 A 段和 A' 段（实测代价差只有 0.04，等于没区分度）。
  cost(k, midis, only, shift) {
    if (k < 0) return 1.1
    const items = this.events[k].items
    const want = only ? items.filter((it) => only.has(it.part)) : items
    const obs = (midis || []).length
    if (!want.length) {
      // 谱上此刻全体休止，却听到声音 → 罚；但别罚太狠（多基频有误检）
      return obs ? 0.55 : 0
    }
    if (!obs) return 0.5                       // 一个都没检出：按漏检处理，中等罚
    const sh = shift || 0
    const taken = new Array(obs).fill(false)
    let total = 0
    for (const it of want) {
      let bi = -1, bd = 12
      for (let i = 0; i < obs; i++) {
        if (taken[i]) continue
        // 这里绝不能做八度归一：那样男低的 C3 会去顶替女高的 C4，
        // 几个声部互相"代班"，结果不同段落的代价全都一样，等于没匹配
        const a = Math.abs(midis[i] + sh - it.midi)
        if (a < bd) { bd = a; bi = i }
      }
      if (bi >= 0) taken[bi] = true
      total += bd / 12
    }
    let extra = 0
    for (let i = 0; i < obs; i++) if (!taken[i]) extra++
    // 逐声部匹配时观测里必然混着别的声部的音，对本声部而言它们都是"多余的"，
    // 只能轻罚——重罚的话代价会被别人的声音主导，等于白匹配
    return (total / want.length) * 2.2 + extra * 0.08
  }

  // 监控用：团队此刻在 beat，听到的音是 midis，只比对 only 里的声部
  costAt(beat, midis, only) {
    return this.cost(this.indexAt(beat), midis, only)
  }

  // prior：期望的起点拍（重新定位时用当前位置外推值），只用来打破平局
  // 对某一组声部，把整段窗口对齐到谱面上打分，取最优
  _evalOnly(only, list, p, t0, span) {
    let best = null, second = Infinity
    for (let j = 0; j < this.n; j++) {
      const b0 = this.events[j].beat
      for (const tm of list) {
        const spb = this.secPerBeat / tm
        if (b0 + span / spb > this.totalBeats + 0.25) continue
        for (const oct of OCTS) {
          let total = 0, wsum = 0, wall = 0, wnote = 0
          for (const f of this.frames) {
            wall += f.dt
            const k = this.indexAt(b0 + (f.t - t0 + f.dt / 2) / spb)
            if (k < 0) continue
            // 没检出音的帧权重减半：多基频本来就有漏检，不该按"唱错"重罚
            const w = f.midis ? f.dt : f.dt * 0.5
            for (const it of this.events[k].items) {
              if (!only || only.has(it.part)) { wnote += w; break }
            }
            total += this.cost(k, f.midis, only, oct) * w
            wsum += w
          }
          // 覆盖不足的直接排除：否则"窗口大部分跑到谱子外面"的候选
          // 只靠开头几帧就能拿到很低的分（谱子末尾全是空事件，代价恒为 0）
          if (!(wsum > 0) || wsum < wall * 0.6) continue
          // 这些声部在窗口里基本都在休止 → 没有信息量，不能拿来定位
          if (wnote < wall * 0.5) continue
          const score = total / wsum + Math.abs(b0 - p) * (this.priorW || PRIOR_W) + Math.abs(oct) * 0.004
          if (!best || score < best.score) {
            if (best && best.score < second) second = best.score
            best = { j, tempo: tm, score, b0, oct }
          } else if (score < second) {
            second = score
          }
        }
      }
    }
    if (!best) return null
    best.beat = best.b0 + span / (this.secPerBeat / best.tempo)
    best.margin = second - best.score
    return best
  }

  solve(tempos, prior) {
    if (!this.n || this.voicedDur < 0.45 || !this.frames.length) return null
    const list = tempos || TEMPOS
    const p = prior == null ? 0 : prior
    const t0 = this.frames[0].t
    const span = this.dur - t0

    // 两条路都要走，因为各自的强项不同：
    //
    // 全声部——把"此刻全体应该响什么"整体去比对，区分力最强：
    // 单看一个声部，欢乐颂第一段和第二段的旋律是一模一样的，
    // 但四个声部叠起来的和声在不同段落不同，只有整体比才能分开。
    const all = this._evalOnly(null, list, p, t0, span)

    // 逐声部——只拿一个声部去比对，应对"只有部分声部在唱"：
    // 自己一个人练的时候，其余声部的期望音永远落空，整体比代价会高到没法定位。
    let part = null
    for (let pi = 0; pi < this.partCount; pi++) {
      const r = this._evalOnly(this._only[pi], list, p, t0, span)
      if (r && (!part || r.score < part.score)) part = r
    }

    // 整体比对确实吻合 → 用它（区分力更强，能分开重复的乐段）；
    // 对不上，多半是因为没有那么多人一起唱 → 退回逐声部
    let pick = null
    if (all && all.score < (this.maxScore || LOCK_MAX)) pick = all
    else pick = part || all
    if (!pick) return null
    return {
      beat: pick.beat,               // 窗口结束时谱面走到哪
      startBeat: pick.b0,            // 窗口起点对应的拍
      tempo: pick.tempo,
      oct: pick.oct,
      score: pick.score,
      margin: pick.margin,
      viaAll: pick === all,          // 是靠整体和声定下来的，还是靠单个声部
    }
  }

  // prior 同上；minDur = 这次至少攒多久才认。
  // 失败次数越多 minDur 越大：第一次尽快给反馈（哪怕猜错），
  // 锁定后要是持续对不上就会重来，那时窗口更长、证据更足。
  // 每帧都可以调，内部自带节流（解一次要扫全谱，不必每帧算）
  solveIfReady(prior, minDur, tempos, ambigSec) {
    const need = minDur == null ? EARLY_SEC : minDur
    if (this.dur < EARLY_SEC || this.peakRun < MIN_RUN) return null
    // 一个音高从头到尾不动、谐波又不像人声 → 那是环境里的嗡嗡声，不是演唱。
    // 只靠"能不能对上谱面"挡不住它：噪声配上八度偏移也能凑出一个勉强吻合的位置。
    if (this.distinct < MIN_DISTINCT && this.maxHarm < HARM_SOLO) return null
    if (this._busy-- > 0) return null
    this._busy = 2                                  // 之后每 3 帧解一次
    const s = this.solve(tempos, prior)
    if (!s) return null
    // 质量太差就不认：噪声里随机冒出来的音也能"匹配"出一个最优起点，
    // 但那个起点是乱指的。宁可多等，也别锁到一个瞎猜的位置。
    // 攒得越久要求越松：一开始要"一眼就认得出"才锁，
    // 等久了还没认出来就降低标准，免得在跳段这种场景里一直卡着不收敛
    const base = this.maxScore || LOCK_MAX
    const lim = this.dur > 6 ? base * 1.8 : base
    if (s.score > lim) return null
    if (s.margin > EARLY_MARGIN) return s           // 分得清，立刻锁定
    // 分不清时多攒一会儿：重复乐段要等唱到有差别的地方才能分开。
    // 首次启动不延（要尽快给反馈），重新定位时才延
    const cap = Math.max(need, ambigSec || 0)
    return this.dur >= cap ? s : null
  }
}
