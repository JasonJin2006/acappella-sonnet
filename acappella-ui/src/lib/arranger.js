// 阿卡贝拉编配。
//
// 输入一条主旋律，输出 S/A/T/B 四声部。
// 与传统四部和声写作不同，这里把「织体」当成每小节可替换的样式：
// 同样一条旋律，唱成柱式和弦、三度叠置、长音铺底或敲钟，听感完全不同。
//
// 每小节的织体由调用方给定（界面上的画笔），没给就用 defaultPlan 的默认层次：
// 前两小节单薄，中间铺开，最后一小节收在敲钟上。
import { PART_NAMES } from './music.js'

export const TEXTURES = [
  { id: 'solo', name: '独唱', hint: '只有主旋律，其他三个声部休息。适合开场或主歌第一句' },
  { id: 'unison', name: '齐唱', hint: '四个声部同度唱旋律，最厚，适合副歌最后一遍' },
  { id: 'thirds', name: '三度差', hint: '女低跟着旋律走调内三度，男高男低休息。主歌常用' },
  { id: 'pad', name: '长音', hint: '下三声部各唱一个和弦音铺住，旋律自由走动' },
  { id: 'block', name: '柱式', hint: '四声部同节奏，旋律每个音配一个和弦，最规整' },
  { id: 'bell', name: '敲钟', hint: '下三声部依次晚进，主旋律准时，像钟声滚下来' },
  { id: 'vamp', name: '节奏', hint: '下三声部走八分音型，旋律浮在上面，适合快歌' },
]

const TEXTURE_IDS = TEXTURES.map((t) => t.id)
const TEXTURE_NAME = Object.fromEntries(TEXTURES.map((t) => [t.id, t.name]))

const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10]
const TONIC_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

// 声部音区。写的是实际发声音高，男高不按高八度记谱。
const RANGE = {
  S: [58, 81],
  A: [54, 74],
  T: [47, 67],
  B: [38, 60],
}

// 声部编制。roles 从上到下排列，同名字母重复表示分部：
// S1 是最高的女高，S2 在它下面，依此类推。
export const VOICINGS = [
  { id: 'satb', name: '混声四部', roles: ['S', 'A', 'T', 'B'] },
  { id: 'sattb', name: '混声五部', roles: ['S', 'A', 'T', 'B', 'B'] },
  { id: 'ssattb', name: '混声六部', roles: ['S', 'S', 'A', 'T', 'T', 'B'] },
  { id: 'ssaattbb', name: '混声八部', roles: ['S', 'S', 'A', 'A', 'T', 'T', 'B', 'B'] },
  { id: 'ssaa', name: '女声四部', roles: ['S', 'S', 'A', 'A'] },
  { id: 'ttbb', name: '男声四部', roles: ['T', 'T', 'B', 'B'] },
  { id: 'ssa', name: '女声三部', roles: ['S', 'S', 'A'] },
]

const VOICING_MAP = Object.fromEntries(VOICINGS.map((v) => [v.id, v]))

export function voicingOf(id) {
  return VOICING_MAP[id] || VOICING_MAP.satb
}

const ROLE_CN = { S: '女高', A: '女中', T: '男高', B: '男低' }

// 显示名：S1 显示成「Soprano 1 女高」，界面取最后一个词当简称
function nameOf(id) {
  const base = PART_NAMES[id]
  if (!base) return id
  if (/\d$/.test(id)) return `${base} ${ROLE_CN[id[0]] || ''}`.trim()
  return base
}

// 同名字母按出现顺序编号：S S A A T T B B -> S1 S2 A1 A2 T1 T2 B1 B2；
// 只出现一次的不加编号，还是 S、A、T、B。
export function partIds(roles) {
  const total = {}
  for (const r of roles) total[r] = (total[r] || 0) + 1
  const seen = {}
  return roles.map((r) => {
    if (total[r] === 1) return r
    seen[r] = (seen[r] || 0) + 1
    return r + seen[r]
  })
}

// 同一字母的第二个声部整体下移，避免和上面那条挤在一起
function slotRange(roles, i) {
  const base = RANGE[roles[i]]
  const nth = roles.slice(0, i).filter((r) => r === roles[i]).length
  if (nth === 0) return base
  // 低音二分部不跟着一起往下掉，C2 以下业余合唱团唱不了
  const lo = roles[i] === 'B' ? 38 : Math.max(30, base[0] - 5)
  return [lo, base[1] - 3]
}

// 相邻声部的最小间隔，越往下越宽，低音才不会糊成一团
const GAPS = [3, 3, 4, 4, 5, 6, 9]

const mod12 = (n) => ((n % 12) + 12) % 12
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// 大调和小调各七个和弦。pcs 是相对主音的半音数，deg 是和弦根音相对主音的音级。
const TRIADS = {
  major: [
    { name: 'I', deg: 0, pcs: [0, 4, 7] },
    { name: 'ii', deg: 2, pcs: [2, 5, 9] },
    { name: 'iii', deg: 4, pcs: [4, 7, 11] },
    { name: 'IV', deg: 5, pcs: [5, 9, 12] },
    { name: 'V', deg: 7, pcs: [7, 11, 14] },
    { name: 'V7', deg: 7, pcs: [7, 11, 14, 17] },
    { name: 'vi', deg: 9, pcs: [9, 12, 16] },
  ],
  minor: [
    { name: 'i', deg: 0, pcs: [0, 3, 7] },
    { name: 'ii°', deg: 2, pcs: [2, 5, 8] },
    { name: 'III', deg: 3, pcs: [3, 7, 10] },
    { name: 'iv', deg: 5, pcs: [5, 8, 12] },
    { name: 'V', deg: 7, pcs: [7, 11, 14] },
    { name: 'VI', deg: 8, pcs: [8, 12, 15] },
    { name: 'VII', deg: 10, pcs: [10, 14, 17] },
  ],
}

export function keyName(key) {
  if (!key) return '未知调'
  const tonic = TONIC_NAMES[mod12(key.tonic)] || 'C'
  return `${tonic} ${key.minor ? '小调' : '大调'}`
}

export function textureName(id) {
  return TEXTURE_NAME[id] || id
}

// Krumhansl-Kessler 调性轮廓。只用「在不在音阶里」判断，分不出主音和上主音，
// 小星星会被判成 D 小调；用轮廓相关性才能把主音的位置区分开。
const PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function correlate(hist, profile, tonic) {
  const n = 12
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mx += hist[mod12(tonic + i)]
    my += profile[i]
  }
  mx /= n
  my /= n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const a = hist[mod12(tonic + i)] - mx
    const b = profile[i] - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0
}

// 从音高分布猜调。轮廓相关性为主，配合三条和声上的常识：
// 调外音要罚；末音落在主音通常是收束；主和弦三个音最好都在旋律里出现。
export function rankKeys(notes) {
  const hist = new Array(12).fill(0)
  let first = null
  let last = null
  let total = 0
  for (const n of notes) {
    if (n.midi == null) continue
    hist[mod12(n.midi)] += n.beats
    total += n.beats
    if (first == null) first = n.midi
    last = n.midi
  }
  if (!total) return []
  const out = []
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const scale = (minor ? MINOR : MAJOR).map((d) => mod12(tonic + d))
      let outside = 0
      for (let pc = 0; pc < 12; pc++) {
        if (!scale.includes(pc)) outside += hist[pc]
      }
      const outRatio = outside / total
      let score = correlate(hist, minor ? PROFILE_MINOR : PROFILE_MAJOR, tonic)
      // 调外音要罚：否则「末音落在主音」会把带变化音的旋律硬拉到别的调上
      score -= outRatio * 1.0
      // 主和弦三音齐全，说明这个主音站得住
      const triad = minor ? [0, 3, 7] : [0, 4, 7]
      let cover = 0
      for (const d of triad) if (hist[mod12(tonic + d)] > 0) cover++
      score += (cover / 3) * 0.08
      if (last != null && mod12(last) === tonic && outRatio < 0.05) score += 0.1
      if (first != null && mod12(first) === tonic) score += 0.03
      // 大调小调相关性接近时偏向大调，旋律写作里更常见
      if (!minor) score += 0.01
      out.push({ tonic, minor, score })
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

export function guessKey(notes) {
  const ranked = rankKeys(notes)
  return ranked.length ? ranked[0] : { tonic: 0, minor: false, score: 0 }
}

// 把旋律按拍数切成小节。跨小节的音会被拆开，保证每小节时值对齐。
export function splitMeasures(notes, bar) {
  const out = []
  let cur = []
  let sum = 0
  for (const n of notes) {
    let left = n.beats
    while (sum + left > bar + 1e-9) {
      const take = bar - sum
      // 拆小节时必须把力度一起带走，否则编配出来的下层声部全是默认力度
      if (take > 1e-6) cur.push(n.vel == null ? { midi: n.midi, beats: take } : { midi: n.midi, beats: take, vel: n.vel })
      out.push(cur)
      cur = []
      sum = 0
      left -= take
      if (left <= 1e-9) break
    }
    if (left > 1e-9) {
      cur.push(n.vel == null ? { midi: n.midi, beats: left } : { midi: n.midi, beats: left, vel: n.vel })
      sum += left
    }
    if (Math.abs(sum - bar) < 1e-9) {
      out.push(cur)
      cur = []
      sum = 0
    }
  }
  if (cur.length) out.push(cur)
  return out.filter((m) => m.length)
}

export function measureCount(notes, bar) {
  const total = notes.reduce((s, n) => s + n.beats, 0)
  return Math.max(1, Math.ceil(total / bar - 1e-6))
}

// 默认织体：开头就要铺满，不能一上来只有两个人唱。
// 之前的方案第一、二小节是三度差，男高男低整两小节休止，
// 库里所有旋律曲目的播放听起来都缺低音。
export function defaultPlan(n, voices = 4) {
  return Array.from({ length: n }, (_, i) => {
    if (n === 1) return 'block'
    if (i === 0) return 'pad'
    if (i === 1) return 'block'
    if (i === n - 1) return 'bell'
    if (i % 4 === 3) return 'vamp'
    return 'block'
  })
}

function resolveChord(name, key) {
  const table = key.minor ? TRIADS.minor : TRIADS.major
  const roman = String(name).trim()
  // 小调曲目里，作者写的是大调记法（I / IV / V / vi），要映射到小调的
  // i / iv / V / VI。不映射的话 I、IV 查不到会静默落到 table[0] = i，
  // 整首歌唱的和弦全是主和弦（康定情歌第 3 小节 IV 就变成了 i）。
  // 归一化顺手处理 ii° 与 ii、V7 与 V 这类写法差异。
  const norm = (s) => String(s).trim().replace(/[°º]/g, '').replace(/dim/gi, '').toLowerCase()
  const hit =
    table.find((c) => c.name === roman) ||
    (!key.minor
      ? null
      : table.find((c) => norm(c.name) === norm(roman)) ||
        table.find((c) => norm(c.name) === norm(roman).replace(/7$/, '')))
  if (!hit) return { ...table[0], requested: roman }
  return {
    name: hit.name,
    root: mod12(key.tonic + hit.deg),
    pcs: hit.pcs.map((p) => mod12(key.tonic + p)),
    deg: hit.deg,
  }
}

function chordScore(measure, chord, key, bar) {
  let score = 0
  let pos = 0
  for (const n of measure) {
    const strong = Math.abs(pos % bar) < 1e-6 || Math.abs((pos % bar) - bar / 2) < 1e-6
    if (n.midi != null) {
      const pc = mod12(n.midi)
      if (chord.pcs.includes(pc)) score += n.beats * (strong ? 1.5 : 1)
      else score -= n.beats * (strong ? 1.8 : 0.9)
      if (pc === chord.root) score += n.beats * 0.12
    }
    pos += n.beats
  }
  return score
}

// 每小节挑一个和弦。看旋律音落在和弦音里的比例，强拍权重更高，再按前后进行微调。
export function inferChords(measures, key, bar) {
  const table = key.minor ? TRIADS.minor : TRIADS.major
  const chords = table.map((c) => resolveChord(c.name, key))
  const out = []
  let prev = null
  for (let i = 0; i < measures.length; i++) {
    let best = null
    for (const chord of chords) {
      let score = chordScore(measures[i], chord, key, bar)
      // I / IV / V 是骨架和弦，覆盖程度相同时优先用它们
      if (chord.deg === 0 || chord.deg === 5 || chord.deg === 7) score += 0.5
      // 大调三级和弦在根位很弱，容易写成「I iii iii」这种散架进行
      if (!key.minor && chord.deg === 4) score -= 0.4
      if (i === 0 && chord.deg === 0) score += 3
      if (i === measures.length - 1) {
        if (chord.deg === 0) score += 3
        else if (chord.deg === 7) score += 1
      }
      if (prev) {
        const move = mod12(chord.deg - prev.deg)
        // 四度、五度进行比三度循环更稳
        if (move === 5 || move === 7) score += 0.6
        if (move === 0) score += 0.2
      }
      if (!best || score > best.score) best = { chord, score }
    }
    out.push(best.chord.name)
    prev = best.chord
  }
  return out
}

function candidates(pcs, lo, hi) {
  const out = []
  for (let m = lo; m <= hi; m++) if (pcs.includes(mod12(m))) out.push(m)
  return out
}

// 从主旋律往下铺声部栈。
// roles 决定声部数与类型，间隔按 GAPS 逐层放宽，低音尽量落在根音上。
function voiceStack(s, chord, roles, prevStack) {
  const out = [s]
  const n = roles.length
  // 把固定间隔缩放到实际可用音区，否则 8 个声部会在低音区撞成一堆同度
  const bottomLo = slotRange(roles, n - 1)[0]
  const raw = GAPS.slice(0, n - 1)
  const sum = raw.reduce((a, b) => a + b, 0)
  const span = Math.min(Math.max(12, s - bottomLo), 30)
  const scale = Math.min(1.15, span / sum)
  for (let i = 1; i < n; i++) {
    const [lo, hi] = slotRange(roles, i)
    const gap = raw[i - 1] * scale
    const target = out[i - 1] - gap
    const cands = candidates(chord.pcs, lo, Math.min(hi, out[i - 1] - 2))
    if (!cands.length) {
      // 音区用尽时与上一声部同度，绝不能塞一个调外音进去
      out.push(Math.min(out[i - 1], hi))
      continue
    }
    const below = cands.filter((m) => m <= target)
    let pick = below.length ? below[below.length - 1] : cands[0]
    // 上一小节同一声部离得远时，改取附近的和弦音，让进行平滑
    if (prevStack && prevStack[i] != null && Math.abs(pick - prevStack[i]) > 7) {
      const near = cands.filter((m) => Math.abs(m - prevStack[i]) <= 5 && m < out[i - 1] - 1)
      if (near.length) {
        pick = near.reduce((a, b) => (Math.abs(b - prevStack[i]) < Math.abs(a - prevStack[i]) ? b : a))
      }
    }
    out.push(pick)
  }
  // 三音是和弦的性格，缺了就成了空五度。女低能够到就补上三音，
  // 否则 C 和弦会写成 C-G-C-G，听起来发空。
  if (roles.length >= 3) {
    const third = chord.pcs.find((pc) => {
      const d = mod12(pc - chord.root)
      return d === 3 || d === 4
    })
    if (third != null && !out.some((m) => mod12(m) === third)) {
      // 先让女低唱三音。
      // 注意 roles[1] 不一定是女低：SSA / SSAA / SSATTB 里它是第二女高。
      // 改完必须仍然压在下面那个声部之上，否则会出现 S2 唱到 A 下面的倒挂。
      const [lo, hi] = slotRange(roles, 1)
      const cands = candidates([third], lo, Math.min(hi, out[0] - 2))
      if (cands.length) {
        const pick = cands.reduce((a, b) => (Math.abs(b - out[1]) < Math.abs(a - out[1]) ? b : a))
        if (Math.abs(pick - out[1]) <= 5 && pick > out[2] + 1) out[1] = pick
      }
      // 女低够不到（比如 C 和弦的 E3 低于女低音区）时，
      // 四声部改成男高唱三音、男低唱根音，C4-G3-E3-C3 才是完整和弦
      if (roles.length === 4 && !out.some((m) => mod12(m) === third)) {
        const [tLo, tHi] = slotRange(roles, 2)
        const tCands = candidates([third], tLo, Math.min(tHi, out[1] - 2))
        if (tCands.length) {
          const tPick = tCands.reduce((a, b) => (Math.abs(b - out[2]) < Math.abs(a - out[2]) ? b : a))
          const [bLo, bHi] = slotRange(roles, 3)
          const bCands = candidates([chord.root], bLo, Math.min(bHi, tPick - 2))
          if (bCands.length) {
            out[2] = tPick
            out[3] = bCands.reduce((a, b) => (Math.abs(b - out[3]) < Math.abs(a - out[3]) ? b : a))
          }
        }
      }
      // 五声部以上同样要补：SATTB / SSATTB / SSAATTBB 的低音副声部常常
      // 占掉了根音，三音没地方放。这里在男高到男低之间找一个能唱三音的分部，
      // 只要不越过上面的声部、也不低于下面的声部就换上。
      if (roles.length > 4 && !out.some((m) => mod12(m) === third)) {
        for (let i = 2; i < roles.length - 1 && !out.some((m) => mod12(m) === third); i++) {
          const [lo, hi] = slotRange(roles, i)
          const c = candidates([third], lo, Math.min(hi, out[i - 1] - 2))
          if (!c.length) continue
          const pick = c.reduce((a, b) => (Math.abs(b - out[i]) < Math.abs(a - out[i]) ? b : a))
          if (Math.abs(pick - out[i]) <= 7 && pick > out[i + 1] + 1) out[i] = pick
        }
      }
      // 还补不上时退一步：把最靠近三音的声部换成三音。
      // SSA / SSAA / TTBB 的三音常和相邻分部同度（S2 与 A 都是 G3），
      // 上面分支要求 pick > out[2] + 1，差一个半音就放弃，于是永远补不上。
      if (!out.some((m) => mod12(m) === third)) {
        let bestI = -1
        let bestPick = null
        let bestD = Infinity
        for (let i = 1; i < roles.length; i++) {
          const [lo, hi] = slotRange(roles, i)
          const above = i > 0 ? out[i - 1] : Infinity
          const below = i < roles.length - 1 ? out[i + 1] : -Infinity
          for (const m of candidates([third], lo, hi)) {
            if (m > above || m < below) continue
            const d = Math.abs(m - out[i])
            if (d < bestD) { bestD = d; bestI = i; bestPick = m }
          }
        }
        if (bestI >= 0 && bestD <= 7) out[bestI] = bestPick
      }
    }
  }

  // 低音最好在根音上，差得不多就换过去。
  // 但如果三音只落在低音上，换根音会把三音弄丢（V 变成空五度 G-D-G），
  // 这时保留低音的三音——转位比缺三音好听。
  const bi = roles.length - 1
  if (bi > 0 && mod12(out[bi]) !== chord.root) {
    const thirdPc = chord.pcs.find((pc) => {
      const d = mod12(pc - chord.root)
      return d === 3 || d === 4
    })
    const thirdElsewhere = thirdPc != null && out.some((m, i) => i !== bi && mod12(m) === thirdPc)
    if (!(thirdPc != null && mod12(out[bi]) === thirdPc && !thirdElsewhere)) {
      const [lo, hi] = slotRange(roles, bi)
      const alt = candidates([chord.root], lo, Math.min(hi, out[bi - 1] - 2))
      if (alt.length) {
        const best = alt.reduce((a, b) => (Math.abs(b - out[bi]) < Math.abs(a - out[bi]) ? b : a))
        if (Math.abs(best - out[bi]) <= 5) out[bi] = best
      }
    }
  }
  return out
}

// 调内三度：优先取小三度或大三度，且必须落在调内音阶上。
// 只查下界会把高音旋律的女低写到 74 以上（G5 的「三度下」是 E5=76），
// 所以上界也要卡住；卡住之后退到四度下（G5 → D5），仍是调内音。
function thirdBelow(s, key) {
  const scale = (key.minor ? MINOR : MAJOR).map((d) => mod12(key.tonic + d))
  for (const d of [3, 4, 5]) {
    const m = s - d
    if (m >= RANGE.A[0] && m <= RANGE.A[1] && scale.includes(mod12(m))) return m
  }
  return clamp(s - 4, RANGE.A[0], RANGE.A[1])
}

function octaveTo(midi, lo, hi) {
  let m = midi
  while (m < lo) m += 12
  while (m > hi) m -= 12
  return clamp(m, lo, hi)
}

// 主入口。
// melody: [{ midi, beats }]，midi 为 null 表示休止
// opts: { bar, chords: ['I','V',...], textures: ['pad',...], key }
export function arrange(melody, opts = {}) {
  const bar = opts.bar || 4
  const src = melody.filter((n) => n.beats > 0)
  const key = opts.key && typeof opts.key === 'object' ? opts.key : guessKey(src)
  const voicing = voicingOf(opts.voicing)

  // 把旋律挪进最高声部的音区。整首一起移，不动内部音程。
  // 男声编制（TTBB）不能照女高音区放，否则男高要唱到 A5。
  // 只按「低音不够就往上、高音超了就往下」判一次会过头：
  // 旋律 55–85 会先因为 55 < 58 整体上移八度成 67–97，反而更唱不了。
  // 这里把所有八度位移都算一遍，取越界最少、又不越界优先的那个；
  // 同样不越界时取位移最小的，不能把本来就在音区里的旋律无故移八度。
  const topRange = slotRange(voicing.roles, 0)
  const pitches = src.filter((n) => n.midi != null).map((n) => n.midi)
  let oct = 0
  if (pitches.length) {
    const lo = Math.min(...pitches)
    const hi = Math.max(...pitches)
    let bestCost = Infinity
    for (const shift of [0, 12, -12, 24, -24, 36, -36]) {
      const cost = Math.max(0, topRange[0] - (lo + shift)) + Math.max(0, (hi + shift) - topRange[1])
      if (cost < bestCost) { bestCost = cost; oct = shift }
      if (cost === 0) break
    }
  }
  // 逐音修正：平移后仍越界的音，按八度折回音区。
  // 只动八度、不动音级，旋律的可唱性优先于绝对音高。
  const foldInto = (midi, [lo, hi]) => {
    let m = midi
    // 最多折 4 次，够覆盖任何现实输入；同时防止死循环
    for (let k = 0; k < 4 && m < lo; k++) m += 12
    for (let k = 0; k < 4 && m > hi; k++) m -= 12
    // 音区跨度小于一个八度时可能折不进去，最后夹一次求稳
    return Math.max(lo, Math.min(hi, m))
  }

  let folded = 0
  const soprano = src.map((n) => {
    let m = n.midi == null ? null : n.midi + oct
    if (m != null) {
      const f = foldInto(m, topRange)
      if (f !== m) folded++
      m = f
    }
    const out = { midi: m, beats: n.beats }
    // 主旋律的力度带到编配结果里：下面的声部按同样的强弱走，
    // 整段才像一个合唱团在同一个气口上做渐强渐弱
    if (n.vel != null) out.vel = n.vel
    return out
  })
  // 记在返回值上，调用方可以提示「有 N 个音超出音域，已折回」
  const foldedCount = folded

  const measures = splitMeasures(soprano, bar)
  const chordNames =
    opts.chords && opts.chords.length
      ? opts.chords.map((c, i) => String(c || 'I') || (i === 0 ? 'I' : 'V'))
      : inferChords(measures, key, bar)
  const chords = chordNames.map((name) => resolveChord(name, key))
  const roles = voicing.roles
  const plan = measures.map((_, i) => {
    const t = opts.textures && opts.textures[i]
    return TEXTURE_IDS.includes(t) ? t : defaultPlan(measures.length, roles.length)[i]
  })

  const ids = partIds(roles)
  const lower = Array.from({ length: roles.length - 1 }, () => [])
  let prevStack = null
  const stackFor = (measure, chord) => {
    const pitches = measure.filter((n) => n.midi != null).map((n) => n.midi)
    const s = pitches.length ? Math.min(...pitches) : (prevStack ? prevStack[0] : 72)
    return { stack: voiceStack(s, chord, roles, prevStack), s }
  }

  for (let i = 0; i < measures.length; i++) {
    const measure = measures[i]
    const len = measure.reduce((acc, n) => acc + n.beats, 0)
    const chord = chords[Math.min(i, chords.length - 1)]
    const texture = plan[i]
    const voiced = measure.some((n) => n.midi != null)
    // 本小节的力度：取第一个有音高的音的力度。低音声部跟着主旋律的强弱走，
    // 逐音照抄会把长音铺底拆成一堆参差的强弱，反而不像合唱。
    const firstVoiced = measure.find((n) => n.midi != null)
    const vel = firstVoiced ? firstVoiced.vel : undefined
    // 本小节的力度带到所有下层声部；没标力度就原样返回，不塞默认值
    const withVel = (o) => (vel == null ? o : { ...o, vel })
    const restAll = (beats) => {
      for (const lane of lower) lane.push(withVel({ midi: null, beats }))
    }

    if (texture === 'solo' || !voiced) {
      restAll(len)
      continue
    }

    if (texture === 'unison') {
      for (const n of measure) {
        if (n.midi == null) {
          restAll(n.beats)
          continue
        }
        roles.forEach((role, k) => {
          if (k === 0) return
          const [lo, hi] = slotRange(roles, k)
          lower[k - 1].push({ midi: octaveTo(n.midi, lo, hi), beats: n.beats })
        })
      }
      continue
    }

    if (texture === 'thirds') {
      for (const n of measure) {
        if (n.midi == null) {
          restAll(n.beats)
          continue
        }
        lower[0].push({ midi: thirdBelow(n.midi, key), beats: n.beats })
        for (let k = 1; k < lower.length; k++) lower[k].push(withVel({ midi: null, beats: n.beats }))
      }
      continue
    }

    if (texture === 'pad') {
      const { stack } = stackFor(measure, chord)
      stack.slice(1).forEach((midi, k) => lower[k].push(withVel({ midi, beats: len })))
      prevStack = stack
      continue
    }

    if (texture === 'bell') {
      // 各声部依次晚进，主旋律不延迟，否则整首歌会往后拖。
      // 延迟取到十六分音符网格上，MusicXML 的 divisions 才除得尽。
      let d = Math.min(len / 8, 0.5)
      d = Math.round(d * 4) / 4
      d = Math.max(0.25, Math.min(d, len / Math.max(2, roles.length)))
      const { stack } = stackFor(measure, chord)
      stack.slice(1).forEach((midi, k) => {
        // len*0.6 不一定是十六分网格（4 拍的 60% 是 2.4），
        // MusicXML 会把 2.4/1.6 各自取整成 2.5/1.5，钟声的进入点就偏了。
        let delay = Math.min(len * 0.6, (k + 1) * d)
        delay = Math.round(delay * 4) / 4
        delay = Math.min(delay, len - 0.25)
        lower[k].push(withVel({ midi: null, beats: delay }), withVel({ midi, beats: len - delay }))
      })
      prevStack = stack
      continue
    }

    if (texture === 'vamp') {
      // 八分音符一下、一空：note 与 rest 都落在十六分网格上，
      // 否则 0.11 拍这种值会被 XML 取整成 0.25，小节越算越长
      const n = Math.max(1, Math.round(len / 0.5))
      const each = len / n
      const hit = Math.min(0.25, each)
      const gap = each - hit
      const { stack } = stackFor(measure, chord)
      for (let k = 0; k < n; k++) {
        stack.slice(1).forEach((midi, vi) => {
          lower[vi].push(withVel({ midi, beats: hit }))
          if (gap > 1e-9) lower[vi].push(withVel({ midi: null, beats: gap }))
        })
      }
      prevStack = stack
      continue
    }

    // block：跟着旋律的节奏，一个音一个和弦
    for (const n of measure) {
      if (n.midi == null) {
        restAll(n.beats)
        continue
      }
      const stack = voiceStack(n.midi, chord, roles, prevStack)
      stack.slice(1).forEach((midi, k) => lower[k].push(withVel({ midi, beats: n.beats })))
      prevStack = stack
    }
  }

  const parts = [
    { id: ids[0], name: nameOf(ids[0]), notes: soprano },
    ...lower.map((notes, k) => ({
      id: ids[k + 1],
      name: nameOf(ids[k + 1]),
      notes,
    })),
  ]

  return { parts, key, chords: chordNames, textures: plan, bar, voicing: voicing.id, folded: foldedCount }
}

/**
 * 常见织体的用法（写给界面的说明）：
 * solo     开场、主歌第一句，让听众先记住旋律
 * thirds   主歌，两把声音贴住，留出空间
 * pad      过渡，和声铺底，旋律自由
 * block    副歌，饱满规整
 * bell    乐句起点、终止式，制造重音
 * vamp    快歌或桥段，给节奏动力
 * unison  最后一遍副歌，或者渐强结尾
 */
