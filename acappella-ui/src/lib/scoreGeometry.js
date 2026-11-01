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

// 取每行五线谱（每个声部一行）的位置。
//
// 返回 { partIndex, y, h }，y 是 OSMD 排版单位下的**谱表顶线**。
// 调用方负责换算成屏幕像素。
//
// 这里必须按声部（staffEntries 的顺序）逐个取，不能去数 SVG 里的横线：
// 实测 7 声部的谱里，getBBox 会把符杠（beam）这类宽横条也算成"长横线"，
// 数出来 8 组而实际只有 7 个声部，之后每 5 条一组就整体错位 ——
// 表现就是左边的声部名和谱表对不上。
//
// staffEntries 的顺序就是声部从上到下的顺序，直接给下标，不用猜。
export function extractStaffRows(osmd) {
  const gs = osmd.GraphicSheet
  if (!gs || !gs.MeasureList || !gs.MeasureList.length) return null
  const firstLine = gs.MeasureList[0]
  if (!firstLine) return null

  const rows = []
  for (const gm of firstLine) {
    for (const se of (gm && gm.staffEntries) || []) {
      const aps = se.PositionAndShape
      if (!aps || !aps.AbsolutePosition) continue
      const y = aps.AbsolutePosition.y
      const h = aps.Size && aps.Size.height ? aps.Size.height : 4
      // 同一行谱表会被多个小节/多个 entry 重复报到，按 y 去重
      if (rows.some((r) => Math.abs(r.y - y) < 0.5)) continue
      // ParentStaff 能给出它属于哪个声部，比按下标硬对更可靠
      const staff = se.ParentStaff
      const partIndex = staff && staff.ParentInstrument
        ? staff.ParentInstrument.IdString != null
          ? (typeof staff.ParentInstrument.IdString === 'number'
              ? staff.ParentInstrument.IdString
              : (staff.ParentInstrument.Index != null ? staff.ParentInstrument.Index : null))
          : null
        : null
      rows.push({ y, h, partIndex })
    }
  }
  if (!rows.length) return null
  rows.sort((a, b) => a.y - b.y)
  // partIndex 拿不到时退回"从上到下第几个"——这个顺序和声部顺序一致
  return rows.map((r, i) => ({ partIndex: r.partIndex == null ? i : r.partIndex, y: r.y, h: r.h, rowIndex: i }))
}
