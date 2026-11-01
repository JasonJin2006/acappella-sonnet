// 把内部谱面格式导出成 MusicXML，交给 OSMD 渲染成五线谱。
// OSMD 只吃 MusicXML，所以文本记谱和示例谱必须先转成它。

const PC_STEP  = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B']
const PC_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0]

const xmlEsc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))

// 由拍数推出音符类型与附点数
function typeAndDots(b) {
  const table = [[4, 'whole'], [2, 'half'], [1, 'quarter'], [0.5, 'eighth'], [0.25, '16th']]
  for (const [v, t] of table) {
    if (b >= v - 1e-9) {
      const rest = b - v
      if (rest < 1e-9) return { type: t, dots: 0 }
      if (Math.abs(rest - v / 2) < 1e-9) return { type: t, dots: 1 }
      if (Math.abs(rest - v * 0.75) < 1e-9) return { type: t, dots: 2 }
      return { type: t, dots: 0 }
    }
  }
  return { type: 'quarter', dots: 0 }
}

// MusicXML 要求每个小节严格填满，跨小节的音符要拆开并用连音线接回去
function splitIntoMeasures(notes, barBeats) {
  const measures = []
  let cur = []
  let remain = barBeats
  for (const n of notes) {
    let left = n.beats
    let first = true
    while (left > 1e-9) {
      const take = Math.min(left, remain)
      cur.push({ midi: n.midi, beats: take, tieStart: left - take > 1e-9, tieStop: !first, ...(n.vel == null ? {} : { vel: n.vel }) })
      left -= take
      remain -= take
      first = false
      if (remain <= 1e-9) { measures.push(cur); cur = []; remain = barBeats }
    }
  }
  if (cur.length) measures.push(cur)
  return measures
}

function noteXML(n, divisions) {
  const dur = Math.max(1, Math.round(n.beats * divisions))
  const { type, dots } = typeAndDots(n.beats)
  const dotXml = '<dot/>'.repeat(dots)
  // 跨三小节以上的音中间段同时收尾和续接，两个 tie 都要给；
  // 休息符不发音，跨小节时不需要也不允许挂连线
  let tie = ''
  if (n.midi != null) {
    if (n.tieStart && n.tieStop) tie = '<tie type="stop"/><tie type="start"/><notations><tied type="stop"/><tied type="start"/></notations>'
    else if (n.tieStart) tie = '<tie type="start"/><notations><tied type="start"/></notations>'
    else if (n.tieStop) tie = '<tie type="stop"/><notations><tied type="stop"/></notations>'
  }

  // 力度写成 <velocity>：MusicXML 用它驱动采样器的力度层，
  // OSMD 渲染时忽略，不影响谱面显示。
  const velXml = n.midi != null && n.vel != null
    ? `<velocity>${Math.max(1, Math.min(127, Math.round(n.vel / 0.58 * 88)))}</velocity>`
    : ''
  if (n.midi == null) {
    return `      <note><rest/><duration>${dur}</duration><type>${type}</type>${dotXml}</note>\n`
  }
  const m = Math.round(n.midi)
  const pc = ((m % 12) + 12) % 12
  const octave = Math.floor(m / 12) - 1
  const alter = PC_ALTER[pc] ? `<alter>${PC_ALTER[pc]}</alter>` : ''
  return (
    `      <note><pitch><step>${PC_STEP[pc]}</step>${alter}<octave>${octave}</octave></pitch>` +
    `<duration>${dur}</duration><type>${type}</type>${dotXml}${tie}${velXml}</note>\n`
  )
}

export function scoreToMusicXML(sc, divisions = 4) {
  const barBeats = sc.bar || 4
  const partList = sc.parts
    .map((p, i) => `    <score-part id="P${i + 1}"><part-name>${xmlEsc(p.name || p.id)}</part-name></score-part>`)
    .join('\n')

  const parts = sc.parts
    .map((p, pi) => {
      const isBass = /^B/i.test(p.id) || /男低|bass/i.test(p.name || '')
      const clef = isBass
        ? '<clef><sign>F</sign><line>4</line></clef>'
        : '<clef><sign>G</sign><line>2</line></clef>'
      const measures = splitIntoMeasures(p.notes, barBeats)
      let out = `  <part id="P${pi + 1}">\n`
      measures.forEach((m, mi) => {
        out += `    <measure number="${mi + 1}">\n`
        if (mi === 0) {
          out += '      <attributes>\n'
          out += `        <divisions>${divisions}</divisions>\n`
          out += '        <key><fifths>0</fifths></key>\n'
          out += `        <time><beats>${barBeats}</beats><beat-type>4</beat-type></time>\n`
          out += `        ${clef}\n`
          out += '      </attributes>\n'
          out += '      <direction placement="above">\n'
          out += '        <direction-type><metronome><beat-unit>quarter</beat-unit>'
          out += `<per-minute>${Math.round(sc.bpm || 96)}</per-minute></metronome></direction-type>\n`
          out += `        <sound tempo="${Math.round(sc.bpm || 96)}"/>\n`
          out += '      </direction>\n'
        }
        for (const n of m) out += noteXML(n, divisions)
        out += '    </measure>\n'
      })
      out += '  </part>\n'
      return out
    })
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>${xmlEsc(sc.title || '')}</work-title></work>
  <part-list>
${partList}
  </part-list>
${parts}</score-partwise>
`
}
