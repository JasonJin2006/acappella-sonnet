// Score helpers for the real-audio tests.  The internal score format is the
// one used by src/lib/arranger.js: each part holds sequential notes, so a
// note's start beat is the running sum of the beats before it.

export function prepareScore(parts, bpm, bar = 4) {
  const out = parts.map((p) => {
    let acc = 0
    const startBeats = p.notes.map((n) => {
      const b = acc
      acc += n.beats
      return b
    })
    return { ...p, startBeats, totalBeats: acc }
  })
  return { parts: out, bpm, bar, title: 'csd' }
}

// Index of the note sounding at `beat`, or -1 when the part is resting.
export function posAt(part, beat) {
  const sb = part.startBeats
  if (beat < 0 || beat >= part.totalBeats) return -1
  let lo = 0
  let hi = sb.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sb[mid] <= beat + 1e-9) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

export function midiAt(part, beat) {
  const i = posAt(part, beat)
  if (i < 0) return null
  const n = part.notes[i]
  return n && n.midi != null ? n.midi : null
}

export function midisAt(score, beat) {
  const out = []
  for (const p of score.parts) {
    const m = midiAt(p, beat)
    if (m != null) out.push(m)
  }
  return out
}

export function totalBeats(score) {
  return Math.max(...score.parts.map((p) => p.totalBeats))
}

// Onset times (in beats) for every non-rest note.
export function onsets(part) {
  const out = []
  for (let i = 0; i < part.notes.length; i++) {
    if (part.notes[i].midi != null) out.push(part.startBeats[i])
  }
  return out
}
