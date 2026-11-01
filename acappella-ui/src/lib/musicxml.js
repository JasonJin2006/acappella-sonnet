// 把内部谱面格式导出成 MusicXML，交给 OSMD 渲染成五线谱。
// OSMD 只吃 MusicXML，所以文本记谱和示例谱必须先转成它。

const PC_STEP  = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B']
const PC_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0]

const xmlEsc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))

// 由拍数推出音符类型与附点数。
//
// 三连音（1/3 拍、2/3 拍）等非 2 的幂时值不能只靠类型表达：
// MusicXML 里它们写成 <type>eighth</type> + <time-modification>
// （actual-notes / normal-notes）。这里同时返回时值修饰信息，
// 否则 0.333 拍会被 round 成 0.25，整份谱越往后偏得越多。
//
// 判定顺序很重要：先试普通时值（含附点），全部对不上才当连音。
// 反过来的话，四分音符 1.0 会被 0.5×2/3×3 这类组合命中，
// 整份谱里每个四分音符都被标成三连音。
function typeAndDots(b) {
  const table = [
    [4, 'whole'], [2, 'half'], [1, 'quarter'],
    [0.5, 'eighth'], [0.25, '16th'], [0.125, '32nd'], [0.0625, '64th'],
  ]
  // 第一步：普通时值 + 附点
  for (const [v, t] of table) {
    if (b >= v - 1e-9) {
      const rest = b - v
      if (rest < 1e-9) return { type: t, dots: 0 }
      if (Math.abs(rest - v / 2) < 1e-9) return { type: t, dots: 1 }
      if (Math.abs(rest - v * 0.75) < 1e-9) return { type: t, dots: 2 }
      break   // 落在两个时值之间，去试连音
    }
  }
  // 第二步：N 连音。只接受"基本时值 × normal/actual"这种真正的连音时值，
  // 且结果必须与普通时值有明显区别（否则就是被第一步漏掉的近似值）。
  for (const [actual, normal] of [[3, 2], [5, 4], [6, 4], [7, 4]]) {
    for (const [base, type] of table) {
      for (let k = 1; k <= actual; k++) {
        const v = (base * normal * k) / actual
        if (Math.abs(b - v) < 1e-6) {
          // 若这个值同时也是普通时值（例如 6:4 的 k=2 等于 base），
          // 说明它不该按连音写，交给第一步的结果
          for (const [pv] of table) {
            if (Math.abs(b - pv) < 1e-9) return { type, dots: 0 }
            if (Math.abs(b - pv * 1.5) < 1e-9) return { type, dots: 0 }
            if (Math.abs(b - pv * 1.75) < 1e-9) return { type, dots: 0 }
          }
          return { type, dots: 0, timeMod: { actual, normal } }
        }
      }
    }
  }
  // 兜底：取不超过它的最大普通时值，不加附点（宁可少标也不标错）
  for (const [v, t] of table) {
    if (b >= v - 1e-9) return { type: t, dots: 0 }
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
      const piece = { midi: n.midi, beats: take, tieStart: left - take > 1e-9, tieStop: !first }
      if (n.vel != null) piece.vel = n.vel
      // 发音法和滑音跟着音符走：拆成多段时只在第一段标起音类标记，
      // 续接段保持同音高、不带新的发音信息，否则回读会重复叠加力度。
      if (first) {
        if (n.accent) piece.accent = n.accent
        if (n.staccato) piece.staccato = true
        if (n.tenuto) piece.tenuto = true
        if (n.gliss) piece.gliss = true
        if (n.slurStart) piece.slurStart = n.slurStart
      }
      // slur / gliss 的收尾可能落在最后一段上
      if (left - take <= 1e-9) {
        if (n.slurStop) piece.slurStop = n.slurStop
      }
      cur.push(piece)
      left -= take
      remain -= take
      first = false
      if (remain <= 1e-9) { measures.push(cur); cur = []; remain = barBeats }
    }
  }
  if (cur.length) measures.push(cur)
  return measures
}

function noteXML(n, divisions, opts = {}) {
  const dur = Math.max(1, Math.round(n.beats * divisions))
  const { type, dots, timeMod } = typeAndDots(n.beats)
  const dotXml = '<dot/>'.repeat(dots)
  // 三连音必须写 time-modification，否则读谱的人会当成普通八分音符，
  // 整份谱的时值从第一个三连音起就开始偏
  const tmXml = timeMod
    ? `<time-modification><actual-notes>${timeMod.actual}</actual-notes><normal-notes>${timeMod.normal}</normal-notes></time-modification>`
    : ''
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
    return `      <note><rest/><duration>${dur}</duration><type>${type}</type>${dotXml}${tmXml}</note>\n`
  }

  // 发音法、滑音、连音线都要写回 <notations>。以前导出只保留 tie，
  // 于是"导入→导出→再导入"会把重音、跳音、滑音全丢掉。
  const notIns = []
  for (const t of (tie.match(/<notations>(.*?)<\/notations>/s)?.[1] || '').matchAll(/<tied[^>]*\/>/g)) {
    notIns.push(t[0])
  }
  if (n.accent === 1) notIns.push('<articulations><accent/></articulations>')
  else if (n.accent >= 2) notIns.push('<articulations><strong-accent/></articulations>')
  if (n.staccato) notIns.push('<articulations><staccato/></articulations>')
  if (n.tenuto) notIns.push('<articulations><tenuto/></articulations>')
  // 滑音只写在源音上，收尾标在下一个音（由调用方通过 opts.glissEnd 告知）
  if (n.gliss) notIns.push('<glissando type="start" number="1">wavy</glissando>')
  if (opts.glissEnd) notIns.push('<glissando type="stop" number="1"/>')
  if (n.slurStart) notIns.push(`<slur type="start" number="${n.slurStart}"/>`)
  if (n.slurStop) notIns.push(`<slur type="stop" number="${n.slurStop}"/>`)
  // tie 已经用独立元素写过，这里不要再重复一份
  const tieXml = tie.replace(/<notations>.*?<\/notations>/s, '')
  const notations = notIns.length ? `<notations>${notIns.join('')}</notations>` : ''

  const m = Math.round(n.midi)
  const pc = ((m % 12) + 12) % 12
  const octave = Math.floor(m / 12) - 1
  const alter = PC_ALTER[pc] ? `<alter>${PC_ALTER[pc]}</alter>` : ''
  return (
    `      <note><pitch><step>${PC_STEP[pc]}</step>${alter}<octave>${octave}</octave></pitch>` +
    `<duration>${dur}</duration><type>${type}</type>${dotXml}${tmXml}${tieXml}${velXml}${notations}</note>\n`
  )
}

export function scoreToMusicXML(sc, divisions = 12) {
  // divisions 默认 12 而不是 4：4 只能整除 1/4 拍，三连音的 1/3 拍
  // （= 0.333）会被 Math.round 舍成 0.25 或 0.5，整份谱越往后偏越多
  // （实测 79 小节的谱丢 11 拍）。12 能同时整除 4 和 3，三连音正好 4 tick。
  const barBeats = sc.bar || 4
  const partList = sc.parts
    .map((p, i) => `    <score-part id="P${i + 1}"><part-name>${xmlEsc(p.name || p.id)}</part-name></score-part>`)
    .join('\n')

  // 速度表按「拍」存，导出要在小节开头写标记。这里预先把拍换算成小节号。
  //
  // 用 round 而不是 floor：速度标记本来就落在小节线上（第 8 小节 = 第 28 拍），
  // 浮点累加会得到 27.9999，floor 会把它算成第 7 小节，整个速度表往前偏一小节。
  const tempoByMeasure = new Map()
  for (const t of (sc.tempos || [])) {
    const mi = Math.round((t.beat || 0) / barBeats)
    tempoByMeasure.set(mi, t.bpm)
  }
  const tempoAtMeasure = (mi) => tempoByMeasure.get(mi)
  // 没有速度表时退回单一 bpm，行为与以前一致
  if (!tempoByMeasure.size) tempoByMeasure.set(0, sc.bpm || 96)

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
        }
        // 变速：这一小节开头有没有速度标记。谱面的速度表是按「拍」存的，
        // 导出要换算成小节——只在这一小节的第一个声部写一次，避免重复标记。
        const mt = tempoAtMeasure(mi)
        if (mt != null && pi === 0) {
          out += '      <direction placement="above">\n'
          out += '        <direction-type><metronome><beat-unit>quarter</beat-unit>'
          out += `<per-minute>${Math.round(mt)}</per-minute></metronome></direction-type>\n`
          out += `        <sound tempo="${Math.round(mt)}"/>\n`
          out += '      </direction>\n'
        }
        // 滑音的收尾要标在「下一个音」上。splitIntoMeasures 会把长音拆开，
        // 所以只在真正换了音高的那一段标收尾，避免同一个滑音标多次。
        for (let k = 0; k < m.length; k++) {
          const prev = k > 0 ? m[k - 1] : null
          const glissEnd = !!(prev && prev.gliss && prev.midi !== m[k].midi)
          out += noteXML(m[k], divisions, { glissEnd })
        }
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
