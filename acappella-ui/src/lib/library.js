// 内置曲库。
//
// 目前只保留「欢乐颂」一首示例曲，其余曲目（公版民歌、儿歌、巴赫众赞歌）
// 全部移除。原因：
//   1. 众赞歌数据 742 KB，占整个 JS 包的三分之一，而实际用的人很少
//   2. 曲目多了以后曲库页的搜索/分类反而变成负担
//
// 用户自己的谱面走「导入」和「我的谱面」，不依赖这个文件。
// 如果以后想加回曲目，往 MELODY_SONGS 里加一条就是：
//   { id, title, by, cat, bpm, bar, level, melody: 'C4 1 D4 1 | ...', chords: 'I V' }
// melody 用 | 分小节，和弦每小节一个罗马数字。

import { parseNoteList, PART_NAMES } from './music.js'
import { arrange } from './arranger.js'
import { resolveBuiltinTradition } from './libraryTraditions.js'

export const CATEGORIES = [
  { id: 'all', name: '全部' },
  { id: 'classical', name: '古典' },
  { id: 'folk', name: '民歌' },
  { id: 'kids', name: '儿歌' },
  { id: 'carol', name: '圣诞' },
  { id: 'hymn', name: '赞美诗' },
  { id: 'exercise', name: '练习' },
]

// 旋律按小节切开。编配交给 arranger.js：每小节一个和弦、一种织体。
function measureList(text) {
  return String(text)
    .split('|')
    .map((s) => parseNoteList(s.trim()))
    .filter((m) => m.length > 0)
}

function buildMelodySong(entry) {
  const measures = measureList(entry.melody)
  const flat = measures.flat()
  const bar = entry.bar || 4
  const chords = String(entry.chords || 'I').trim().split(/\s+/).filter(Boolean)
  const res = arrange(flat, { bar, chords })
  return {
    title: entry.title,
    bpm: entry.bpm || 96,
    bar,
    parts: res.parts,
    // 传统跟着曲目走，见 lib/traditions.js。
    // 出厂标注在 entry.tradition，用户改过的存在覆盖层里，两者都要认。
    tradition: resolveBuiltinTradition(entry),
    // 记住来源曲目 id：谱面标题常带后缀（「欢乐颂（Ode to Joy，示范四部和声）」），
    // 靠 title 匹配不到原来是哪一首，改了传统就没法同步到当前载入的谱面。
    _libId: entry.id,
    _totalBeats: flat.reduce((s, n) => s + n.beats, 0),
  }
}

// ---- 内置曲目 ----
// 只留欢乐颂作为示例，用来验证编配和播放。
const MELODY_SONGS = [
  {
    id: 'ode', title: '欢乐颂', by: '贝多芬', cat: 'classical', bpm: 100, bar: 4, level: 1,
    melody: 'E4 1 E4 1 F4 1 G4 1 | G4 1 F4 1 E4 1 D4 1 | C4 1 C4 1 D4 1 E4 1 | E4 1.5 D4 0.5 D4 2 | E4 1 E4 1 F4 1 G4 1 | G4 1 F4 1 E4 1 D4 1 | C4 1 C4 1 D4 1 E4 1 | D4 1.5 C4 0.5 C4 2',
    chords: 'I V I V I V I I',
  },
]

const melodyEntries = MELODY_SONGS.map((e) => ({
  id: e.id,
  title: e.title,
  sub: e.by,
  category: e.cat,
  bpm: e.bpm,
  bar: e.bar,
  level: e.level || 2,
  parts: 4,
  // 传统不在这里定死：它可能被 libraryTraditions 的覆盖层改过。
  // 列表每次取值都调用 traditionOfBuiltin(e)，见 getLibrary()。
  text: `${e.title} ${e.by}`.toLowerCase(),
  build: () => buildMelodySong(e),
  // 出厂标注，覆盖层读不到时用
  _tradition: e.tradition || 'western',
}))

export const LIBRARY = melodyEntries

/**
 * 取当前生效的曲库列表：每条都按覆盖层重新解析传统。
 *
 * 为什么不直接用导出常量 LIBRARY：内置曲目的传统可以被用户改（存在
 * localStorage 覆盖层里），常量是模块加载时定下的，改完不会自动更新。
 * 谱库页每次渲染都调这个，改了传统立刻能反映出来。
 */
export function getLibrary() {
  return melodyEntries.map((s) => ({ ...s, tradition: resolveBuiltinTradition(s) }))
}

export function buildSong(entry) {
  return entry.build()
}
