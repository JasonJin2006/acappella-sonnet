// 从 OSMD 的排版结果里取出音符在屏幕上的位置，用来把叠加层对齐到五线谱。

// 半音 → 音级序号（C=0,D=1,…,B=6）。五线谱上一个音级 = 半个线间距，
// 所以画音高曲线必须按音级算，不能按半音线性算，否则 E→F 和 F→G 宽度不一样。
const DIAT_OF_PC = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]

export function diatonic(midi) {
  const m = Math.round(midi)
  const pc = ((m % 12) + 12) % 12
  return (Math.floor(m / 12) - 1) * 7 + DIAT_OF_PC[pc]
}

// OSMD 的 getHalfTone() 比标准 MIDI 小 12（八度编号差一位），实测确认
const OSMD_SHIFT = 12

// 取某个声部所有音符的位置（OSMD 排版单位）
export function extractPartGeometry(osmd, partIndex) {
  const gs = osmd.GraphicSheet
  if (!gs || !gs.MeasureList) return null
  const notes = []
  for (let si = 0; si < gs.MeasureList.length; si++) {
    const line = gs.MeasureList[si]
    if (!line) continue
    for (let mi = 0; mi < line.length; mi++) {
      const gm = line[mi]
      for (const se of (gm && gm.staffEntries) || []) {
        for (const gve of se.graphicalVoiceEntries || []) {
          for (const gn of gve.notes || []) {
            const sn = gn.sourceNote
            if (!sn) continue
            const staff = sn.ParentStaff || (sn.ParentVoiceEntry && sn.ParentVoiceEntry.ParentStaff)
            const pid = staff ? (staff.idInMusicSheet != null ? staff.idInMusicSheet : staff.id) : null
            if (pid !== partIndex) continue
            const ht = sn.Pitch && sn.Pitch.getHalfTone ? sn.Pitch.getHalfTone() : null
            const p = gn.PositionAndShape && gn.PositionAndShape.AbsolutePosition
            if (ht == null || !p) continue
            // 记下这个音的绝对拍号，界面点谱面定位时按它换算
            const ts = sn.getAbsoluteTimestamp ? sn.getAbsoluteTimestamp() : null
            const beat = ts && ts.RealValue != null ? ts.RealValue * 4 : null
            notes.push({ x: p.x, y: p.y, diat: diatonic(ht + OSMD_SHIFT), beat })
          }
        }
      }
    }
  }
  if (!notes.length) return null

  // 换行换 system 时 y 会跳一大截，按 y 聚类分成若干"行组"
  const groups = []
  for (const n of [...notes].sort((a, b) => a.y - b.y)) {
    let g = null
    for (const gg of groups) { if (Math.abs(gg.base - n.y) < 20) { g = gg; break } }
    if (!g) { g = { base: n.y, notes: [] }; groups.push(g) }
    g.notes.push(n)
    g.base = g.notes.reduce((s, x) => s + x.y, 0) / g.notes.length
  }
  // 每组拟合截距：y = a − 0.5 × 音级（斜率为固定的 0.5 排版单位/音级）
  for (const g of groups) {
    g.a = g.notes.reduce((s, n) => s + n.y + 0.5 * n.diat, 0) / g.notes.length
    g.notes = [...g.notes].sort((a, b) => a.x - b.x)   // 组内按横向先后 = 时间先后
  }
  groups.sort((a, b) => a.base - b.base)
  // 时间顺序：先按行（system），行内按 x
  const ordered = []
  for (const g of groups) ordered.push(...g.notes)
  return { notes: ordered, groups }
}

// 取每行五线谱（每个声部一行）的顶线位置，单位是 OSMD 排版单位。
//
// 实测（OSMD 1.x）：第一小节 staffEntries 的 PositionAndShape.AbsolutePosition.y
// 给出的是**每行谱表的顶线**，同一个声部的多个 entry 共用同一个 y。
// 4 声部时是 10.55 / 18.55 / 26.55 / 36.45，间距 8~10 就是行距。
// 调用方负责换算成屏幕像素，并自行补上「顶线 → 谱表中线」的偏移。
export function extractStaffRows(osmd) {
  const gs = osmd.GraphicSheet
  if (!gs || !gs.MeasureList || !gs.MeasureList.length) return null
  const firstLine = gs.MeasureList[0]
  if (!firstLine) return null

  const ys = []
  for (const gm of firstLine) {
    for (const se of (gm && gm.staffEntries) || []) {
      const aps = se.PositionAndShape
      if (!aps) continue
      const y = aps.AbsolutePosition ? aps.AbsolutePosition.y : null
      if (y == null) continue
      if (!ys.some((v) => Math.abs(v - y) < 0.5)) ys.push(y)
    }
  }
  if (!ys.length) return null
  ys.sort((a, b) => a - b)
  return ys.map((y, i) => ({ partIndex: i, y, h: 4 }))
}
