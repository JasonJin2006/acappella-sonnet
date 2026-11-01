import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { extractPartGeometry, extractStaffRows } from '@/lib/scoreGeometry'

// 横向卷轴模式：整首谱子排成一行，唱到哪就横向滚到哪，不换行。
// 换行的话视线要在行末"跳"一下，和声连续感会断，看音高曲线尤其明显。
//
// OSMD 是按容器宽度决定排几行的，所以给它一个足够宽的容器即可单行；
// 它的 Endless 模式指的是"纵向无限高"，不是无限宽，用错了一样会换行。

// 遍历一次光标，记下每一步的起始拍，之后就能按"拍"直接定位
function buildIndex(osmd) {
  const idx = []
  const c = osmd.cursor
  try { c.reset() } catch (e) { /* 老版本可能没有 reset */ }
  let guard = 0
  while (c.iterator && !c.iterator.EndReached && guard++ < 8000) {
    const ts = c.iterator.currentTimeStamp
    // OSMD 的时间戳单位是「全音符」，1 全音符 = 4 拍，必须换算成拍才能和谱面对齐
    idx.push(ts ? (ts.RealValue || 0) * 4 : 0)
    c.next()
  }
  try { c.reset() } catch (e) {}
  return idx
}

// OSMD 默认拿黑色画音符，深色背景下等于隐形，必须按主题喂颜色
function applyTheme(osmd, isDark) {
  osmd.setOptions({
    defaultColor: isDark ? '#f4f4f5' : '#18181b',
    cursorsOptions: [
      // alpha 压到 .22：高亮只是提示位置，不能把音符盖住
      { type: 0, color: isDark ? '#2dd4bf' : '#0d9488', alpha: 0.22, follow: false },
    ],
  })
}

// 音分偏差的视觉放大倍数：不放大在手机上根本看不出偏高偏低。
// 但最多只允许偏离 1.5 个音级，免得曲线跑到隔壁音符上去造成误读。
const CURVE_GAIN = 6
const MAX_OFF_STEPS = 1.5
const CLR_OK = '#2dd4bf'
const CLR_WARN = '#f59e0b'
const CLR_BAD = '#f43f5e'

function partCount(xml) {
  return Math.max(1, (xml.match(/<part\s+id=/g) || []).length)
}

// 声部越多，谱面越高。手机上八行五线谱按原缩放会顶出屏幕，按声部数降一档。
// 手机上 1.35 的缩放一小节都占满一屏，滚动后连谱号都看不见。
// 四声部降到 1.0，一屏能放进一个半小节，读谱才有上下文。
function zoomFor(parts) {
  if (parts <= 2) return 1.25
  if (parts <= 4) return 1.05
  if (parts <= 6) return 0.9
  if (parts <= 8) return 0.75
  return 0.65
}

// 单行要排多宽：先按小节数估一个足够宽的值，渲染完再按实际谱宽收紧，
// 免得右边留一大片空白
function estimateWidth(xml) {
  const mAll = (xml.match(/<measure\s/g) || []).length
  const parts = partCount(xml)
  const measures = Math.max(1, Math.round(mAll / parts))
  // 宽度按缩放线性放大：OSMD 会把给定宽度均分给各小节，
  // 用 zoom/0.75 这种非线性系数会让手机上一屏连一小节都放不下
  return Math.round(measures * 260 * zoomFor(parts) + 80)
}

// 声部数分级只解决"大概多高"，真到 6/8 声部或矮屏幕上，谱面仍会高过
// 分谱区；竖向是 overflow-hidden，顶上去的声部就被裁掉了，而且没法滚出来。
// 这里拿实际渲染高度再收一次 zoom，保证所有声部都在可视区内。
function fitToHeight(osmd, box, wrap, base) {
  const avail = Math.max(80, (wrap ? wrap.clientHeight : 0) - 4)
  let z = base
  for (let i = 0; i < 3; i++) {
    osmd.zoom = z
    osmd.render()
    const svg = box.querySelector('svg')
    const h = svg ? svg.getBoundingClientRect().height || 0 : 0
    if (!h || h <= avail) break
    z = Math.max(0.4, z * (avail / h) * 0.995)
  }
  return z
}

const ScoreView = forwardRef(function ScoreView({ xml, theme, myPart, parts = [], onPart, startBeat = 0, onTap, onSeek }, ref) {
  const wrapRef = useRef(null)      // 横向滚动的外壳
  const boxRef = useRef(null)       // OSMD 渲染的容器（超宽）
  const canvasRef = useRef(null)
  const osmdRef = useRef(null)
  const geoRef = useRef(null)
  const liveRef = useRef(null)
  const indexRef = useRef([])
  const zoomRef = useRef(1)
  const stepRef = useRef(0)
  const lastBeatRef = useRef(0)
  const startBeatRef = useRef(startBeat)
  startBeatRef.current = startBeat
  const grabRef = useRef(0)
  const downRef = useRef(null)
  const tapMapRef = useRef([])      // [{x, beat}]，点谱面定位用
  const seekRef = useRef(onSeek)
  seekRef.current = onSeek
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState(null)
  // 各声部谱线的屏幕纵向位置，用来把声部名贴在对应的五线谱左侧
  const [staffRows, setStaffRows] = useState([])
  const themeRef = useRef(theme)
  const partRef = useRef(myPart)

  // 换声部后叠加层和点击定位都要用新声部的音头位置。
  // 只显示我的声部时 XML 里只剩一个 part，不能用全局 myPart 当索引。
  function rebuildGeo() {
    const osmd = osmdRef.current
    if (!osmd) return
    const partIndex = partCount(xml) > 1 ? partRef.current : 0
    geoRef.current = extractPartGeometry(osmd, partIndex)
    tapMapRef.current = ((geoRef.current && geoRef.current.notes) || [])
      .filter((n) => n.beat != null)
      .map((n) => ({ x: n.x, beat: n.beat }))
  }

  // 每个声部那一行五线谱在屏幕上的纵向位置，用来把声部名贴在谱线左侧。
  //
  // 做法：量 SVG 里**够长的**水平线，每 5 条一组 = 一行五线谱，取首尾中点。
  //
  // 宽度阈值很关键：谱面里还有大量短横笔（拍号的 4/4、加线、符杠），
  // 实测 212 条水平线里只有 160 条够长，其中真正的谱线是 20 条
  // （4 行 × 5 条）。不加宽度过滤时，短笔混进来会把「每 5 条一组」
  // 整体错位——表现就是 S/A 大致对准、T/B 落到相邻谱表上。
  function measureStaffRows() {
    const osmd = osmdRef.current
    const box = boxRef.current
    const wrap = wrapRef.current
    if (!osmd || !box || !wrap) return
    const rows = extractStaffRows(osmd)
    if (!rows || !rows.length) { setStaffRows([]); return }
    const svg = box.querySelector('svg')
    if (!svg) return

    const sr = svg.getBoundingClientRect()
    const wrapRect = wrap.getBoundingClientRect()
    const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null
    const scale = vb && vb.height ? sr.height / vb.height : 1

    // 只取长线：谱线横跨整个小节（100+ 单位），短横笔都在 50 以内
    const ys = []
    for (const p of svg.querySelectorAll('path')) {
      let bb
      try { bb = p.getBBox() } catch (e) { continue }
      if (!bb || bb.height >= 2 || bb.width < 100) continue
      ys.push(Math.round((sr.top + (bb.y - (vb ? vb.y : 0)) * scale) * 10) / 10)
    }
    const uniq = [...new Set(ys)].sort((a, b) => a - b)

    if (uniq.length >= rows.length * 5) {
      const lines = []
      for (let i = 0; i + 4 < uniq.length; i += 5) {
        const g = uniq.slice(i, i + 5)
        lines.push((g[0] + g[4]) / 2)
      }
      setStaffRows(rows.map((r, i) => ({
        partIndex: r.partIndex,
        top: (lines[i] != null ? lines[i] : 0) - wrapRect.top,
      })))
      return
    }

    // 兜底：按 OSMD 的 y 换算（线距 1 排版单位）
    const unit = (osmd.UnitToPixel || 10) * (osmd.zoom || 1)
    const svgTop = sr.top - wrapRect.top + wrap.scrollTop
    setStaffRows(rows.map((r) => ({
      partIndex: r.partIndex,
      top: svgTop + (r.y + 2) * unit,
    })))
  }
  function clearOverlay() {
    liveRef.current = null
    const cv = canvasRef.current
    if (!cv) return
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height)
    cv.__dbg = null
  }


  useEffect(() => {
    const box = boxRef.current
    if (!box || !xml) return
    let dead = false
    box.innerHTML = ''
    // 换谱 / 换 XML 后 SVG 是新的，画布布局缓存必须失效
    const cv0 = canvasRef.current
    if (cv0) cv0.__layoutKey = ''
    setReady(false)
    setErr(null)

    const osmd = new OpenSheetMusicDisplay(box, {
      autoResize: false,           // 宽度由我们给，别让 OSMD 按外壳宽度去排版
      backend: 'svg',
      drawTitle: false,
      drawSubtitle: false,
      drawComposer: false,
      drawPartNames: false,   // 顶部已有声部胶囊，谱面里再写一遍会白占半屏宽
      drawMeasureNumbers: true,
      drawMetronomeMarks: true,
      followCursor: false,
    })
    osmdRef.current = osmd

    ;(async () => {
      try {
        await osmd.load(xml)
        if (dead) return
        applyTheme(osmd, themeRef.current !== 'light')
        osmd.zoom = fitToHeight(osmd, box, wrapRef.current, zoomFor(partCount(xml)))
        zoomRef.current = osmd.zoom
        indexRef.current = buildIndex(osmd)
        stepRef.current = 0
        osmd.cursor.show()
        rebuildGeo()
        tightenWidth()
        layoutCanvas()
        measureStaffRows()
        // 从别的页面回来时引擎位置还在，光标也要跟过去，不能从第 0 拍重新显示
        const restart = startBeatRef.current || 0
        if (restart > 0) {
          let target = 0
          const idx = indexRef.current
          for (let i = 0; i < idx.length; i++) { if (idx[i] <= restart + 1e-6) target = i; else break }
          let g = 0
          while (stepRef.current < target && g++ < 8000) { osmd.cursor.next(); stepRef.current++ }
          lastBeatRef.current = restart
          try { osmd.cursor.update?.() } catch (e) {}
          scrollToCursor(false)
        }
        if (box) box.__osmd = osmd
        setReady(true)
      } catch (e) {
        if (dead) setErr(String((e && e.message) || e))
      }
    })()

    return () => { dead = true }
  }, [xml])

  // 切声部要重建叠加层和点击定位的坐标
  useEffect(() => {
    if (partRef.current === myPart) return
    partRef.current = myPart
    const osmd = osmdRef.current
    if (!osmd || !ready) return
    rebuildGeo()
    const cv = canvasRef.current
    if (cv) cv.__layoutKey = ''
    layoutCanvas()
  }, [myPart, ready])

  // 切换主题不必重新解析谱子，改颜色重画一次即可，画完把光标送回原处
  useEffect(() => {
    if (themeRef.current === theme) return
    themeRef.current = theme
    const osmd = osmdRef.current
    if (!osmd || !ready) return
    applyTheme(osmd, theme !== 'light')
    osmd.zoom = zoomRef.current || zoomFor(partCount(xml))
    osmd.render()
    indexRef.current = buildIndex(osmd)
    stepRef.current = 0
    osmd.cursor.show()
    rebuildGeo()
    tightenWidth()
    const cv = canvasRef.current
    if (cv) cv.__layoutKey = ''
    layoutCanvas()
    const idx = indexRef.current
    if (idx.length) {
      let target = 0
      for (let i = 0; i < idx.length; i++) { if (idx[i] <= lastBeatRef.current + 1e-6) target = i; else break }
      let g = 0
      while (stepRef.current < target && g++ < 8000) { osmd.cursor.next(); stepRef.current++ }
      try { osmd.cursor.update?.() } catch (e) {}
    }
  }, [theme, ready])

  // 谱子实际占多宽（排版单位 → 像素）。
  // SVG 的宽度等于我们给的容器宽度，不是内容宽度，直接拿会留一大片空白。
  function contentWidth(osmd) {
    const ml = (osmd && osmd.GraphicSheet && osmd.GraphicSheet.MeasureList) || []
    let far = 0
    for (const line of ml) {
      for (const gm of line) {
        const ps = gm && gm.PositionAndShape
        if (!ps) continue
        const x = ps.AbsolutePosition ? ps.AbsolutePosition.x || 0 : 0
        const w = ps.Size ? ps.Size.width || 0 : 0
        if (x + w > far) far = x + w
      }
    }
    if (!far) return 0
    return far * 10 * (osmd.zoom || 1)
  }

  // 排完后把容器收到实际谱宽，右边不多留空白。
  // SVG 的宽度等于我们给的容器宽度（比谱子本身宽出一截），
  // 不裁的话右边会拖出一大片空白，横向滚动条也跟着变长。
  // 把点击的屏幕横坐标换成谱面上最近的音，再交给上层定位
  function seekAt(clientX) {
    const box = boxRef.current
    const osmd = osmdRef.current
    const map = tapMapRef.current
    if (!box || !osmd || !map.length || !seekRef.current) return false
    const unitPx = 10 * (osmd.zoom || 1)
    const rect = box.getBoundingClientRect()
    const x = (clientX - rect.left) / unitPx
    let best = map[0]
    let bd = Math.abs(best.x - x)
    for (const p of map) {
      const d = Math.abs(p.x - x)
      if (d < bd) { bd = d; best = p }
    }
    seekRef.current(best.beat)
    return true
  }

  function tightenWidth() {
    const box = boxRef.current
    const osmd = osmdRef.current
    if (!box || !osmd) return
    const w = contentWidth(osmd)
    if (w > 0) {
      box.style.width = Math.ceil(w) + 24 + 'px'
      box.style.overflow = 'hidden'
    }
  }

  // 叠加层画布要盖在乐谱上，尺寸和位置都得跟 SVG 对齐。
  // 画布宽度有上限：3000+ CSS px 的众赞歌在 DPR 2 手机上会超过浏览器的
  // 位图上限，浏览器把整张画布缩放着画，叠加层就和音符整体错位。
  // 所以长谱只给视口一屏画布（originX 记下它对应内容的哪一段），
  // 滚动时重排 + 重画；短谱仍然一次铺满整首。
  function layoutCanvas() {
    const box = boxRef.current
    const cv = canvasRef.current
    const wrap = wrapRef.current
    const svg = box && box.querySelector('svg')
    if (!cv || !svg || !wrap) return
    const dpr = window.devicePixelRatio || 1
    // 跟着唱时 syncTo 每帧都会走到这里。先用便宜的几何量做一次缓存判断，
    // 位置没变就不重算 contentWidth（它要遍历整份排版，40 小节的众赞歌很贵）。
    const wr = wrap.getBoundingClientRect()
    const sr = svg.getBoundingClientRect()
    const layoutKey = [wrap.scrollLeft, wrap.clientWidth, wr.left, wr.top, sr.left, sr.top, sr.width, sr.height, dpr].join('|')
    if (cv.__layoutKey === layoutKey) return
    cv.__layoutKey = layoutKey
    // 画布按内容宽度来，不是按 SVG 宽度（后者等于容器宽度，会大一截）
    const w = contentWidth(osmdRef.current) || parseFloat(svg.getAttribute('width') || 0)
    const h = parseFloat(svg.getAttribute('height') || svg.clientHeight || 0)
    if (!w || !h) return
    // SVG 元素没有 offsetLeft/offsetTop（拿到的 undefined 会写成非法 CSS，
    // 画布就停在滚动容器的 0,0）。谱面又是垂直居中的，4 声部时会错开约 29px，
    // 所以必须用 rect 差值算，并补上横向滚动量。
    const svgLeft = sr.left - wr.left + wrap.scrollLeft
    const svgTop = sr.top - wr.top + wrap.scrollTop
    const maxCss = 8000 / dpr
    let left = svgLeft
    let cssW = w
    let originX = 0
    if (w > maxCss) {
      const vw = Math.max(80, wrap.clientWidth)
      originX = Math.max(0, Math.min(w - vw, wrap.scrollLeft - svgLeft))
      left = svgLeft + originX
      cssW = Math.min(vw, w)
    }
    cv.style.left = Math.round(left) + 'px'
    cv.style.top = Math.round(svgTop) + 'px'
    cv.style.width = cssW + 'px'
    cv.style.height = h + 'px'
    const bw = Math.round(cssW * dpr)
    const bh = Math.round(h * dpr)
    // 只有尺寸变了才重设位图，否则每帧都会清空画布、闪烁
    if (cv.width !== bw) cv.width = bw
    if (cv.height !== bh) cv.height = bh
    cv.__originX = originX
  }

  // 叠加层：整首铺开的彩帘条（按当时唱的音准上色）+ 一条连续的音高曲线。
  // 单行之后不再有"行"的概念，条和曲线都是从头到尾连续的。
  function drawOverlay(live) {
    const osmd = osmdRef.current
    const cv = canvasRef.current
    const geo = geoRef.current
    if (live) liveRef.current = live
    const data = live || liveRef.current
    if (!osmd || !cv || !geo || !data) return
    // 长谱的画布只覆盖视口一屏：画之前先把画布挪到当前滚动位置。
    // 不能只靠 scroll 事件——程序化 scrollTo（跟随时追光标）和
    // 「先滚到谱尾再开跟唱」都可能不经过我们期望的事件时序。
    layoutCanvas()
    const cx = cv.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    cx.setTransform(dpr, 0, 0, dpr, 0, 0)
    cx.clearRect(0, 0, cv.width / dpr, cv.height / dpr)

    const notes = geo.notes
    if (!notes.length) return
    const unitPx = 10 * (osmd.zoom || 1)

    // 渲染出来的音符个数和谱面音符个数一般一致；跨小节长音会被拆开，
    // 那时退化为按比例对位，至少不会画到界外
    const tm = data.timing
    const nTotal = tm ? tm.total : notes.length
    const mapPos = (p) =>
      notes.length === nTotal
        ? Math.min(notes.length - 1, Math.max(0, p))
        : Math.min(notes.length - 1, Math.round((p / Math.max(1, nTotal - 1)) * (notes.length - 1)))

    const posIdx = mapPos(data.pos)
    // 画布可能只是整首谱里的一段窗口（长谱），originX 是它左边对应的内容坐标。
    // 所有横向坐标都要减掉 originX 换成画布局部坐标。
    const originX = cv.__originX || 0
    const xStart = (i) => notes[i].x * unitPx - originX
    const xEnd = (i) => (i + 1 < notes.length ? notes[i + 1].x : notes[i].x + 4) * unitPx - originX
    const maxOff = MAX_OFF_STEPS * 0.5 * unitPx
    const offsetOf = (cs) => {
      if (cs == null) return 0
      let off = (cs / 100) * 0.25 * unitPx * CURVE_GAIN
      if (off > maxOff) off = maxOff
      if (off < -maxOff) off = -maxOff
      return off
    }

    // 只画这块画布覆盖到的音
    const viewL = -1
    const viewR = cv.width / dpr + 1
    const inView = (x) => x >= viewL && x <= viewR

    // 每个音唱下来平均偏差多少，用来给历史条上色
    const avg = new Map()
    for (const t of data.trace || []) {
      if (t.cs == null) continue
      const e = avg.get(t.pos) || { s: 0, n: 0 }
      e.s += t.cs; e.n++
      avg.set(t.pos, e)
    }

    // ---- 彩帘：唱过的音，条长 = 该音的时值 ----
    // 条的粗细跟着力度走：p 细、f 粗，一眼能看出这句该轻该响。
    // 力度从 timing.beats 同下标的 vel 取（和谱面用的是同一份音符列表）。
    const vels = tm && tm.vels ? tm.vels : null
    for (let i = 0; i <= posIdx; i++) {
      const x0 = xStart(i), x1 = xEnd(i)
      if (!inView(x0) && !inView(x1)) continue
      const e = avg.get(i)
      const c = e ? e.s / e.n : null
      const a = Math.abs(c || 0)
      const vel = vels && vels[i] != null ? vels[i] : 0.58
      // 0.24(pp) → 2.4px，0.84(ff) → 8.4px。上下限放宽一些，
      // 手机上强弱才看得出来（原来的 4px 固定粗细完全看不出力度）。
      const thick = Math.max(2, Math.min(9, vel * 10))
      cx.globalAlpha = i === posIdx ? 0.95 : 0.4
      cx.fillStyle = a > 35 ? CLR_BAD : a > 15 ? CLR_WARN : CLR_OK
      cx.fillRect(x0, notes[i].y * unitPx - thick / 2, Math.max(3, x1 - x0 - 1.5), thick)
    }
    cx.globalAlpha = 1

    // ---- 我的声部：当前该唱的音单独框出来 ----
    // OSMD 的列光标盖住所有声部，一列里哪個音是自己的并不醒目。
    // 在音符头外面套一个圆角框，位置跟着跟谱器走；休止时不画。
    if (data.targetMidi != null && notes[posIdx]) {
      const n = notes[posIdx]
      const gap = xEnd(posIdx) - xStart(posIdx)
      const bw = Math.min(1.7 * unitPx, Math.max(1.15 * unitPx, gap * 0.72))
      const bh = 1.75 * unitPx
      const bx = n.x * unitPx - (bw - 1.0 * unitPx) / 2
      const by = n.y * unitPx - bh / 2
      const br = 0.42 * unitPx
      cx.beginPath()
      if (cx.roundRect) {
        cx.roundRect(bx, by, bw, bh, br)
      } else {
        cx.moveTo(bx + br, by)
        cx.arcTo(bx + bw, by, bx + bw, by + bh, br)
        cx.arcTo(bx + bw, by + bh, bx, by + bh, br)
        cx.arcTo(bx, by + bh, bx, by, br)
        cx.arcTo(bx, by, bx + bw, by, br)
        cx.closePath()
      }
      cx.fillStyle = 'rgba(45, 212, 191, 0.18)'
      cx.fill()
      cx.strokeStyle = 'rgba(45, 212, 191, 0.95)'
      cx.lineWidth = 1.5
      cx.stroke()
    }

    // ---- 音高曲线：从头到尾连续，不被音符切断 ----
    const pts = (data.trace || []).filter((t) => t.midi != null && t.c >= 0.45)
    let lastY = null
    if (pts.length < 2) {
      // 刚开口还没形成曲线，也把诊断信息留下，测试脚本靠它判断叠加层是否在工作
      cv.__dbg = { posIdx, notesLen: notes.length, lastCurveY: null, curBarY: notes[posIdx].y * unitPx }
      return
    }
    const totals = {}
    const counters = {}
    for (const t of pts) totals[t.pos] = (totals[t.pos] || 0) + 1
    cx.strokeStyle = '#38bdf8'
    cx.lineWidth = 2
    cx.lineJoin = 'round'
    cx.beginPath()
    let started = false
    for (const t of pts) {
      const idx = counters[t.pos] || 0
      counters[t.pos] = idx + 1
      const frac = totals[t.pos] > 1 ? idx / (totals[t.pos] - 1) : 0.5
      const p = mapPos(t.pos)
      const x = xStart(p) + frac * (xEnd(p) - xStart(p))
      if (!inView(x) && !started) continue
      const y = notes[p].y * unitPx - offsetOf(t.cs)
      lastY = y
      if (!started) { cx.moveTo(x, y); started = true }
      else cx.lineTo(x, y)
    }
    if (started) cx.stroke()
    cv.__dbg = { posIdx, notesLen: notes.length, lastCurveY: lastY, curBarY: notes[posIdx].y * unitPx }
  }

  // 横向跟随：让光标停在屏幕偏左的位置，右边留出"接下来要唱的"。
  // 用户正在手动拖谱面时不抢滚动（手指按下的 2.5 秒内都算）。
  const grabbed = () => grabRef.current && Date.now() - grabRef.current < 2500

  // 目标位置每次都要重算（光标元素会变），但「够近就不动」的判定要留余量：
  // 阈值太小会让滚动器每换一个音就重新起步，看起来一顿一顿的。
  // 40px 大约是半个小节的宽度，比这小的位移肉眼几乎看不出。
  const scrollToCursor = (smooth) => {
    const wrap = wrapRef.current
    const osmd = osmdRef.current
    if (!wrap || !osmd || grabbed()) return
    const el = osmd.cursor?.cursorElement
    if (!el || !el.getBoundingClientRect) return
    const r = el.getBoundingClientRect()
    const br = wrap.getBoundingClientRect()
    const x = r.left - br.left + wrap.scrollLeft
    // 光标放在 70% 处：当前小节从左边完整露出来，不会一滚动就把谱号切掉
    const target = Math.max(0, x - wrap.clientWidth * 0.7)
    if (Math.abs(target - wrap.scrollLeft) < 40) return
    wrap.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' })
  }

  useImperativeHandle(ref, () => ({
    // beat：我这个声部当前音符的起始拍；live：叠加层要用的实时数据
    // smooth：播放时不走平滑滚动，动画会每帧打断上一次，反而抖
    syncTo(beat, live, smooth = true) {
      const osmd = osmdRef.current
      const idx = indexRef.current
      if (!osmd || !idx.length) return
      lastBeatRef.current = beat
      let target = 0
      for (let i = 0; i < idx.length; i++) {
        if (idx[i] <= beat + 1e-6) target = i
        else break
      }
      const c = osmd.cursor
      if (target < stepRef.current) {
        try { c.reset() } catch (e) {}
        stepRef.current = 0
      }
      let guard = 0
      while (stepRef.current < target && guard++ < 8000) {
        c.next()
        stepRef.current++
      }
      try { c.update?.() } catch (e) {}
      scrollToCursor(smooth)
      if (live) drawOverlay(live)
    },
    // 停止跟唱：清叠加层，但光标和滚动位置留在原地。
    // 早先这里顺手 cursor.reset() + 滚回 0，结果停止后屏幕跳回第一拍、
    // 引擎却停在原来的拍子上，再按麦克风就从看不见的地方接着唱。
    reset() {
      // 必须一起清 liveRef：否则下一次横向滚动时 onScroll 又拿旧数据重画，
      // 停止跟唱后彩帘和音高曲线会“复活”。
      clearOverlay()
    },
    // 换谱 / 回到开头才需要把光标也归零
    rewind() {
      const osmd = osmdRef.current
      if (!osmd) return
      try { osmd.cursor.reset() } catch (e) {}
      stepRef.current = 0
      lastBeatRef.current = 0
      if (wrapRef.current) wrapRef.current.scrollTo({ left: 0 })
      clearOverlay()
    },
    clearOverlay,
  }))

  // 竖向也允许滚动：fitToHeight 会把 zoom 一路压到 0.4 去迁就高度，
  // 但声部特别多（8 行五线谱）或屏幕特别矮时压到 0.4 仍放不下，
  // 而 overflow-y-hidden 会把超出部分裁掉且滚不出来——表现就是
  // 「谱子太高显示不全」。改成可滚，缩到最小仍放不下时至少能滚到。
  return (
    <div className="relative h-full w-full">
    {/* 声部名贴在各自五线谱的左侧。
        必须在滚动容器外面：放进 overflow-auto 里 sticky left-0 不生效，
        实测被定位到内容宽度处（x=1485，完全在屏幕外）。
        改绝对定位到视口左缘，纵向按谱表中线摆。
        left-0 + 不透明底色：谱表左边缘有竖线会穿过半透明标签，
        看起来像字被切开。 */}
    {ready && staffRows.length > 1 && parts.length > 0 && (
      <div className="pointer-events-none absolute left-1 top-0 z-20" style={{ height: '100%' }}>
        {staffRows.map((r) => {
          const p = parts[r.partIndex]
          if (!p) return null
          const on = r.partIndex === myPart
          return (
            <button
              key={r.partIndex}
              onClick={() => onPart && onPart(r.partIndex)}
              className={`pointer-events-auto absolute -translate-y-1/2 rounded border px-1 py-0.5 text-[10px] font-medium shadow-sm ${
                on
                  ? 'border-brand bg-brand text-brand-foreground'
                  : 'border-border bg-card text-muted-foreground'
              }`}
              style={{ top: r.top }}
              aria-label={`声部 ${p.id}`}
            >
              {p.id}
            </button>
          )
        })}
      </div>
    )}
    <div
      ref={wrapRef}
      data-score
      className="relative flex h-full w-full items-center overflow-auto"
      onPointerDown={(e) => {
        grabRef.current = Date.now()
        downRef.current = { x: e.clientX, t: Date.now() }
      }}
      onPointerUp={(e) => {
        grabRef.current = 0
        const d = downRef.current
        downRef.current = null
        // 轻点一下（没怎么横向拖动）：优先当成"点谱面定位"
        if (d && Math.abs(e.clientX - d.x) < 10 && Date.now() - d.t < 350) {
          if (!seekAt(e.clientX) && onTap) onTap()
        }
      }}
      onPointerCancel={() => { grabRef.current = 0; downRef.current = null }}
      onScroll={() => {
        // 没在跟唱/播放时画布是空的，不用跟着滚动重排
        if (!ready) return
        if (!liveRef.current) {
          // 空闲时滚动：把画布挪到新位置，但不重画（画布本来就是空的），
          // 否则下次开始跟唱时画布还停在旧位置。
          layoutCanvas()
          return
        }
        // 长谱的画布只覆盖视口一屏，滚动后要挪到新的位置再重画
        layoutCanvas()
        drawOverlay(null)
      }}
    >
      {/* shrink-0：flex 容器会把这个超宽容器压回视口宽度，一压就又变成竖排了 */}
      <div ref={boxRef} className="relative shrink-0" style={{ width: estimateWidth(xml || '') }} />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute"
        style={{ left: 0, top: 0 }}
      />
      {!ready && !err && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground">
          渲染谱面…
        </div>
      )}
      {err && (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[12px] text-destructive">
          谱面渲染失败：{err}
        </div>
      )}
    </div>
    </div>
  )
})

export default ScoreView
