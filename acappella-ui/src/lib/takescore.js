// 录音转谱。
//
// 分工：多轨录音页负责"一个人一个人录"，这里把每条轨单独转录，
// 再按起始拍拼回同一份谱面。单声部转录已经验证到音分级别准确，
// 所以分轨录 + 各自转谱，比在混音上硬拆声部靠谱得多。
import { framesFromBuffer, transcribe } from './hum.js'

// 一条录音 → 音符序列。起点不是第 0 拍时，前面补对应拍数的休止。
export function takeToNotes(take, { bpm = 96, free = false } = {}) {
  if (!take || !take.buffer) return []
  const frames = framesFromBuffer(take.buffer, 33.3)
  const res = transcribe(frames, bpm, { free })
  if (!res.notes.length) return []
  // offsetMs 是手动微调量，折算成拍加进起点
  const lead = (take.startBeat || 0) + ((take.offsetMs || 0) / 1000) * (bpm / 60)
  const notes = []
  if (lead > 0.01) notes.push({ midi: null, beats: +lead.toFixed(2) })
  notes.push(...res.notes)
  return notes
}

// 多条录音 → 一份多声部谱。同一个声部录了多条时取最后一条（最新）。
export function takesToScore(takes, score, opts = {}) {
  const bpm = (score && score.bpm) || 96
  const bar = (score && score.bar) || 4
  const free = !!opts.free
  const byPart = new Map()
  for (const t of takes || []) {
    if (!t.buffer) continue
    byPart.set(t.partIndex, t)
  }
  const parts = (score.parts || []).map((p, i) => {
    const t = byPart.get(i)
    if (!t) return { id: p.id, name: p.name, notes: [] }
    return { id: p.id, name: p.name, notes: takeToNotes(t, { bpm, free }) }
  })
  const used = parts.filter((p) => p.notes.length)
  if (!used.length) return null

  // 各声部长度补齐，否则渲染时最后一小节会不齐
  const totals = used.map((p) => p.notes.reduce((s, n) => s + n.beats, 0))
  const max = Math.max(...totals)
  const balanced = used.map((p) => {
    const total = p.notes.reduce((s, n) => s + n.beats, 0)
    if (max - total < 0.01) return p
    return { ...p, notes: [...p.notes, { midi: null, beats: +(max - total).toFixed(2) }] }
  })

  return {
    title: `${score.title || '录音'}（录音转谱）`,
    bpm,
    bar,
    parts: balanced,
  }
}
