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

function decodeAll(ctx, urls, entries) {
  return Promise.all(
    entries.map(async (e) => {
      const url = urls[e.file]
      if (!url) return null
      const res = await fetch(url)
      const bytes = await res.arrayBuffer()
      const buffer = await ctx.decodeAudioData(bytes)
      return { midi: e.midi, buffer }
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

  const task = decodeAll(ctx, urls, entries)
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
  const midi = 69 + 12 * Math.log2(Math.max(1e-6, freq) / 440)
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
  return { buffer: s.buffer, rate: ratio, rootMidi: s.midi, stretch: Math.abs(shift) }
}

// 采样音域：给 UI 判断某个音色能不能覆盖当前谱面
export function timbreRange(timbreId) {
  const meta = manifest[timbreId]
  if (!meta || !meta.samples.length) return null
  return { lo: meta.samples[0].midi, hi: meta.samples[meta.samples.length - 1].midi }
}

export function timbreIds() {
  return Object.keys(manifest)
}

export function timbreMeta(timbreId) {
  return manifest[timbreId] || null
}

export default manifest
