// 导入包：把很多首谱面打成一个 JSON，一次写进「我的谱」。
// 包只在本地读取，不上传；结构刻意保持扁平，方便外部脚本批量生成。
import { PART_NAMES } from './music.js'

const DEFAULT_IDS = ['S', 'A', 'T', 'B', 'S2', 'A2', 'T2', 'B2']
const MAX_PARTS = 8
const MAX_BEATS = 64

function toNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

// 音符支持两种写法：紧凑的 [midi, beats] 和 { midi, beats }。
// midi 为 null 表示休止，beats 缺省按一拍算。
function normNotes(raw) {
  if (!Array.isArray(raw)) return null
  const notes = []
  for (const item of raw) {
    let midi = null
    let beats = 1
    if (Array.isArray(item)) {
      midi = item[0] == null ? null : toNumber(item[0])
      beats = item[1] == null ? 1 : toNumber(item[1])
    } else if (item && typeof item === 'object') {
      midi = item.midi == null ? null : toNumber(item.midi)
      beats = item.beats == null ? 1 : toNumber(item.beats)
    } else {
      continue
    }
    if (beats == null || beats <= 0) continue
    if (beats > MAX_BEATS) beats = MAX_BEATS
    if (midi != null) {
      midi = Math.round(midi)
      // 超出 MIDI 音域的当休止处理，避免把整份谱拖偏
      if (midi < 0 || midi > 127) midi = null
    }
    notes.push({ midi, beats })
  }
  return notes.length ? notes : null
}

export function normalizeSong(raw) {
  if (!raw || typeof raw !== 'object') return null
  const partsRaw = Array.isArray(raw.parts) ? raw.parts : []
  const parts = []
  for (let i = 0; i < partsRaw.length && parts.length < MAX_PARTS; i++) {
    const p = partsRaw[i]
    if (!p || typeof p !== 'object') continue
    const notes = normNotes(p.notes)
    if (!notes) continue
    const id = String(p.id || DEFAULT_IDS[i] || 'P' + (parts.length + 1)).toUpperCase().slice(0, 4)
    parts.push({ id, name: p.name || PART_NAMES[id] || id, notes })
  }
  if (!parts.length) return null

  const totalBeats = parts[0].notes.reduce((s, n) => s + n.beats, 0)
  if (totalBeats < 2) return null

  const bpmRaw = toNumber(raw.bpm)
  const barRaw = toNumber(raw.bar)
  const title = String(raw.title || '').trim().slice(0, 120) || '未命名谱面'

  return {
    title,
    bpm: bpmRaw && bpmRaw >= 30 && bpmRaw <= 260 ? Math.round(bpmRaw) : 96,
    bar: barRaw && barRaw >= 1 && barRaw <= 12 ? Math.round(barRaw) : 4,
    parts,
  }
}

// 接受整个包对象，也接受只有歌曲数组的裸 JSON
export function parsePack(input) {
  let data = input
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input)
    } catch (e) {
      throw new Error('导入包不是有效的 JSON')
    }
  }
  const songsRaw = Array.isArray(data) ? data : data && Array.isArray(data.songs) ? data.songs : null
  if (!songsRaw) throw new Error('导入包里找不到 songs 列表')

  const songs = []
  const seen = new Set()
  let skipped = 0
  for (const raw of songsRaw) {
    const sc = normalizeSong(raw)
    if (!sc) {
      skipped++
      continue
    }
    // 包内同名只留第一首，否则写库时会互相覆盖，计数对不上
    if (seen.has(sc.title)) {
      skipped++
      continue
    }
    seen.add(sc.title)
    songs.push(sc)
  }
  if (!songs.length) throw new Error('包里没有可用的谱面')

  return {
    name: (data && data.name) || '',
    source: (data && data.source) || '',
    license: (data && data.license) || '',
    songs,
    skipped,
  }
}

const SCORE_EXT = /\.(xml|musicxml|mxl|zip)$/i

export function isScoreFile(name) {
  return SCORE_EXT.test(String(name || ''))
}
