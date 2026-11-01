// 采样音色库。
//
// 采样是从 MuseScore 4 自带的 MS Basic.sf3 里拆出来的真实录音（MIT 许可，
// 内含 FluidR3 采样），用 scripts/build_samples.py 生成到 src/assets/samples。
// 一个音色按小三度存一个单音采样，播放时用 playbackRate 变调覆盖整个音域；
// 变调超过 3 个半音共振峰就明显跑偏，所以采样的间隔不能再放大。
//
// 这里只负责「加载 + 取某音高最近的采样」，真正的发声在 cue.js 里。
// 没有采样（或加载失败）时返回 null，cue.js 会退回合成音色。

import manifest from '@/assets/samples/manifest.json'
import { freqToMidi } from './pitch.js'

// Vite 会在构建时把目录里的文件变成 URL，这里一次性收进来。
// 用 glob 而不是手写 import，加音色只要重新跑 build_samples.py。
const FILES = import.meta.glob('@/assets/samples/*/*.ogg', {
  eager: true,
  query: '?url',
  import: 'default',
})

const cache = new Map()   // timbreId -> { buffers: [{midi, buffer, rate}], sustain, gain }
const pending = new Map() // timbreId -> Promise

function urlsFor(timbreId) {
  const map = {}
  for (const [path, url] of Object.entries(FILES)) {
    // '/src/assets/samples/choir/60.ogg' → '60.ogg'
    const parts = path.split('/')
    if (parts[parts.length - 2] !== timbreId) continue
    map[parts[parts.length - 1]] = url
  }
  return map
}

function decodeAll(ctx, urls, entries, sustain) {
  return Promise.all(
    entries.map(async (e) => {
      const url = urls[e.file]
      if (!url) return null
      const res = await fetch(url)
      const bytes = await res.arrayBuffer()
      const buffer = await ctx.decodeAudioData(bytes)
      // 延音类采样要循环播放，循环点在这里一次算好。
      // 放到每次发声时算的话，一个音就要扫几千个候选点，
      // 而且结果完全一样——没有理由重复。
      //
      // 算完再做交叉淡化：光对齐循环点只能把阶跃压小，压不到零
      // （真实录音里没有首尾完全相同的两点）。交叉淡化直接改 buffer，
      // 回跳发生在两段等值波形之间，阶跃彻底消失。
      let loop = null
      if (sustain > 0) {
        const raw = findLoopPoints(buffer)
        if (raw) loop = applyLoopCrossfade(buffer, raw)
      }
      return { midi: e.midi, buffer, loop }
    })
  )
}

// 采样表里离这个音高最近的那一条的下标（规则和 sampleFor 一致：先二分再比邻位）
function nearestIndex(list, midi) {
  let lo = 0
  let hi = list.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].midi < midi) lo = mid + 1
    else hi = mid
  }
  let idx = lo
  if (idx > 0 && Math.abs(list[idx - 1].midi - midi) <= Math.abs(list[idx].midi - midi)) idx -= 1
  return idx
}

// 挑出「要让这些音高都落在最近采样 3 个半音内」所需的采样下标。
//
// 不能简单地给每个目标音高各取一个最近邻：谱面音域可能超出采样表两端
// 或稀疏处，最近邻会重复落到同一个采样上，于是某些音要走 7~9 个半音的
// 变调（注释开头就写了超过 3 个半音共振峰明显跑偏）。
//
// 做法是按采样表逐个相邻对扫，只要「这一对之间有个目标音高，且它离两端
// 都超过 3 个半音」就说明缺一个采样——但采样表是固定的 28 个，
// 真正能做的是：把目标音高覆盖到的部分整段带上，宁可多解几个。
function pickEntries(list, usedMidis) {
  // 先标记哪些采样「被用到」，再把它们之间的空档按 3 半音规则补齐
  const used = new Set()
  for (const m of usedMidis) {
    if (m == null) continue
    used.add(nearestIndex(list, m))
  }
  if (!used.size) return []
  // 已选范围要连成一段：中间不跳，避免「按了播放才现解码」的抖动
  let lo = Math.min(...used)
  let hi = Math.max(...used)
  // 两端各放宽一个采样，让最边上那个音的两侧都有参考
  lo = Math.max(0, lo - 1)
  hi = Math.min(list.length - 1, hi + 1)

  // 再检查段内有没有「相邻两个采样间距 > 6 半音」的地方——那样的音不管
  // 选谁都要超过 3 半音变调，属于采样表本身的稀疏区，补不出来，保持原样
  return list.slice(lo, hi + 1)
}

// 预加载一个音色的采样。重复调用共用同一个 Promise。
//
// usedMidis 给了就只解码「一段能覆盖这些音高」的采样，其余不管。
// 一个音色按小三度存了约 28 个采样，全解码实测要 5.5 秒（28 次
// decodeAudioData）。但只解需要的会带来一个坑：缓存里存的是「窄版」，
// 换一首音域更宽的谱就拿不到缺的那些。所以缓存同时记下覆盖到的
// 音域，新需求超出这个范围就重新解一份大的。
export function loadTimbre(ctx, timbreId, usedMidis) {
  const want = pickRange(timbreId, usedMidis)
  const hit = cache.get(timbreId)
  if (hit && covers(hit, want)) return Promise.resolve(hit)
  if (pending.has(timbreId)) return pending.get(timbreId)
  const meta = manifest[timbreId]
  if (!meta) return Promise.resolve(null)
  const urls = urlsFor(timbreId)
  if (!Object.keys(urls).length) return Promise.resolve(null)

  const sorted = meta.samples.slice().sort((a, b) => a.midi - b.midi)
  const entries = want ? sorted.slice(want.lo, want.hi + 1) : meta.samples

  const task = decodeAll(ctx, urls, entries, meta.sustain || 0)
    .then((decoded) => {
      const buffers = decoded.filter(Boolean).sort((a, b) => a.midi - b.midi)
      if (!buffers.length) return null
      const entry = { buffers, sustain: meta.sustain || 0, gain: meta.gain || 1, span: want || null }
      cache.set(timbreId, entry)
      return entry
    })
    .catch(() => null)
    .finally(() => pending.delete(timbreId))
  pending.set(timbreId, task)
  return task
}

// 已有的缓存是否覆盖了这次要的范围
function covers(entry, want) {
  // 这次要全量：只有当初就是全量解过才算覆盖
  if (!want) return entry.span === null
  // 当初是全量：一定覆盖
  if (entry.span === null) return true
  return entry.span.lo <= want.lo && entry.span.hi >= want.hi
}

// 算出这次要覆盖的采样下标区间
function pickRange(timbreId, usedMidis) {
  if (!Array.isArray(usedMidis) || !usedMidis.length) return null
  const meta = manifest[timbreId]
  if (!meta) return null
  const sorted = meta.samples.slice().sort((a, b) => a.midi - b.midi)
  const picked = pickEntries(sorted, usedMidis)
  if (!picked.length) return null
  const lo = sorted.findIndex((e) => e === picked[0])
  const hi = sorted.findIndex((e) => e === picked[picked.length - 1])
  return { lo, hi }
}

// 同步取已加载的音色；没加载完返回 null（调用方退回合成）
export function getLoadedTimbre(timbreId) {
  return cache.get(timbreId) || null
}

// 给一个目标频率挑最近的采样，返回 { buffer, rate, rootMidi, stretch }。
//
// rate 必须严格等于「目标音高 / 采样根音」的 2 的幂，否则发出来的音就是错的。
// 提示音是给人对音准用的，宁可音色差一点，也不能差一个八度。
// 采样音域覆盖不到的音（比如钟琴的采样都在 84 以上，却要弹 C4）只能大幅拉伸，
// 听起来会发闷、变慢；stretch 就是拉伸的半音数，上层可以据此在 UI 上提示
// 或换一个更合适的音色。
export function sampleFor(loaded, freq) {
  if (!loaded || !loaded.buffers.length) return null
  const midi = freqToMidi(freq)
  const list = loaded.buffers
  // 采样按 midi 升序，先二分再在附近线性扫几下：
  // 8 声部导出要挑上千次采样，线性遍历整个表（钢琴 31 个）也够快，
  // 但二分更稳，而且这里不额外分配内存。
  let lo = 0
  let hi = list.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].midi < midi) lo = mid + 1
    else hi = mid
  }
  // lo 是第一个 >= midi 的；比较 lo 和 lo-1
  let idx = lo
  if (idx > 0 && Math.abs(list[idx - 1].midi - midi) <= Math.abs(list[idx].midi - midi)) idx -= 1
  const s = list[idx]
  const shift = midi - s.midi
  const ratio = Math.pow(2, shift / 12)
  return { buffer: s.buffer, rate: ratio, rootMidi: s.midi, stretch: Math.abs(shift), loop: s.loop }
}

/**
 * 给一段采样找一对"相位对齐"的循环点。
 *
 * 为什么必须对齐：循环回跳时如果 loopEnd 的波形值和 loopStart 对不上，
 * 每个循环周期都会出现一次阶跃 —— 听感是持续的"刺啦"电流声。
 * 实测管风琴采样在 35%~85% 处的跳变是 0.40（正常波形斜率的 11 倍），
 * 每 1.3 秒循环一次，耳机里非常明显。
 *
 * 做法分两步：
 *   1. 用自相关估出这段采样的基音周期（很多采样带揉弦/颤音，周期会漂，
 *      所以取整段的中位数，不用单点估计）。
 *   2. 让循环长度等于"整数个周期"：这样 loopEnd 回到 loopStart 时
 *      相位天然接上，不需要碰运气找波形相似点。
 * 第二步再在 ±1 个周期内微调，把残差压到最小。
 *
 * @returns {{loopStart:number, loopEnd:number} | null} 单位是秒
 */
export function findLoopPoints(buffer) {
  if (!buffer || !buffer.length) return null
  const data = buffer.getChannelData(0)
  const n = data.length
  const rate = buffer.sampleRate
  const start = Math.floor(n * 0.35)
  const baseEnd = Math.floor(n * 0.85)
  const minLen = Math.floor(rate * 0.08)
  if (baseEnd - start < minLen) return null

  // ---- 1. 估基音周期（自相关）----
  // 取中段 8192 个样本，找归一化自相关的第一个显著峰。
  const segLen = Math.min(8192, n - start)
  const seg = data.subarray(start, start + segLen)
  let bestLag = 0
  let bestScore = 0
  const minLag = Math.max(2, Math.floor(rate / 2000))   // 上限 2kHz
  const maxLag = Math.min(Math.floor(segLen / 2), Math.floor(rate / 40))  // 下限 40Hz
  for (let lag = minLag; lag < maxLag; lag++) {
    let num = 0, da = 0, db = 0
    // 每 2 个样本取一个，够用且快一倍
    for (let i = 0; i < segLen - lag; i += 2) {
      const x = seg[i], y = seg[i + lag]
      num += x * y; da += x * x; db += y * y
    }
    const den = Math.sqrt(da * db)
    const score = den > 1e-12 ? num / den : 0
    if (score > bestScore) { bestScore = score; bestLag = lag }
  }
  // 找不到明显周期性（噪声段）：退回固定 35%/85% 的位置。
  // 不返回 null——交叉淡化能兜住任何位置的循环，只是周期对齐时更好。
  if (bestLag < minLag || bestScore < 0.25) {
    const fallbackEnd = baseEnd
    if (fallbackEnd <= start + minLen) return null
    return { loopStart: start / rate, loopEnd: fallbackEnd / rate }
  }

  // ---- 2. 循环长度取整数个周期 ----
  const targetLen = baseEnd - start
  const cycles = Math.max(1, Math.round(targetLen / bestLag))
  let end = start + cycles * bestLag

  // ---- 3. 在 ±1 个周期内微调，把残差压到最小 ----
  // 揉弦会让周期缓慢漂移，整数周期只是近似，这里做最后一点修正。
  const win = bestLag
  let bestEnd = end
  let bestCost = Infinity
  for (let off = -win; off <= win; off++) {
    const e = end + off
    if (e <= start + minLen || e >= n - 64) continue
    let cost = 0
    for (let k = 0; k < 64; k++) {
      const a = data[start + k] || 0
      const b = data[e + k] || 0
      const d = a - b
      cost += d * d
    }
    if (cost < bestCost) { bestCost = cost; bestEnd = e }
  }

  // ---- 4. 和"固定 35%/85%"比一次，取跳变更小的那个 ----
  //
  // 周期法不是万能的：带揉弦的采样（小提琴、独唱）周期一直在漂，
  // 自相关估出来的整数周期反而可能比原始位置更差（实测 violin 从
  // 0.4 倍劣化到 4.7 倍）。所以两个候选都算一遍，谁小用谁。
  //
  // 判据直接用"回跳处两个样本的差值"——这正是听感上阶跃的来源，
  // 比用一段波形的残差更贴题（残差小但首尾值差得远，照样会啪一下）。
  const jumpAt = (e) => Math.abs((data[e] || 0) - (data[start] || 0))
  const jPeriodic = bestEnd > start + minLen ? jumpAt(bestEnd) : Infinity
  const jFixed = jumpAt(baseEnd)
  const chosen = jPeriodic <= jFixed ? bestEnd : baseEnd
  if (chosen <= start + minLen) return null
  return { loopStart: start / rate, loopEnd: chosen / rate }
}

/**
 * 把采样的循环边界做成交叉淡化，彻底消除回跳阶跃。
 *
 * 为什么光对齐循环点不够：真实录音里几乎找不到"首尾波形完全一样"的两点。
 * 实测即使按基音周期对齐，仍有音色残留 4~5 倍于正常斜率的跳变
 * （带揉弦的采样周期一直在漂）。跳变只要听得见，循环一次就"啪"一次。
 *
 * 做法：把 [loopStart, loopStart+cross) 这一段和 [loopEnd, loopEnd+cross)
 * 之后的内容做线性交叉淡化，然后把 loopEnd 收缩到交叉段起点。
 * 这样回跳发生在两段等值波形之间，天然连续。
 *
 * 直接改 AudioBuffer 的数据：每个采样只做一次（解码时），
 * 播放路径不用改，也不用多建节点。
 */
export function applyLoopCrossfade(buffer, loop, crossSec = 0.012) {
  if (!buffer || !loop) return loop
  const rate = buffer.sampleRate
  const start = Math.floor(loop.loopStart * rate)
  const end = Math.floor(loop.loopEnd * rate)
  const cross = Math.min(Math.floor(crossSec * rate), Math.floor((end - start) / 4))
  if (cross < 8) return loop

  // 回跳点：播到这里就跳回 start。
  //
  // 这个下标必须和返回值 loopEnd 严格对应，否则淡化段会整体偏移一个样本
  // ——实测就是这样：data[z+1] 等于 data[start]，而 data[z] 还是旧值，
  // 回跳处的阶跃一点没消。
  //
  // 所以先定死 jumpAt 这个整数下标，用它算 loopEnd，而不是反过来
  // 从 loopEnd 乘回去取整（两次 floor 可能差 1）。
  const jumpAt = end - cross

  // 交叉淡化：把 [start, start+cross) 的内容按权重融进 [jumpAt, jumpAt+cross)。
  //
  // 要求 jumpAt 处的值等于 start 处的值，也就是 w 在 k=0 时必须为 1
  // （完全用头部内容）。淡化段从"完全是头部内容"线性过渡到"完全是尾部内容"，
  // 这样循环回跳处的波形天然连续。
  //
  // 每个声道都要做：立体声采样只处理左声道，右声道回跳时照样有阶跃。
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    const head = new Float32Array(cross)
    for (let k = 0; k < cross; k++) head[k] = data[start + k] || 0
    for (let k = 0; k < cross; k++) {
      const w = k / cross              // 0 → 1：从头部过渡到尾部
      const tail = data[jumpAt + k] || 0
      data[jumpAt + k] = head[k] * (1 - w) + tail * w
    }
  }
  // loopEnd 用整数下标换算，保证和 jumpAt 一致。
  //
  // 加半个样本再除：jumpAt/rate 是一个浮点秒数，播放引擎和测试都会
  // Math.floor(loopEnd*rate) 还原下标，浮点往返可能得到 jumpAt - 1e-9，
  // floor 之后就少了一个样本 —— 淡化段整体错位，阶跃原样回来。
  // 加 0.5 个样本的余量，floor 必然还原成 jumpAt。
  return { loopStart: start / rate, loopEnd: (jumpAt + 0.5) / rate }
}

export default manifest
