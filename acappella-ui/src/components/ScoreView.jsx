import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { extractPartGeometry, extractStaffRows } from '@/lib/scoreGeometry'

// 横向卷轴模式：整首谱子排成一行，唱到哪就横向滚到哪，不换行。
// 换行的话视线要在行末"跳"一下，和声连续感会断，看音高曲线尤其明显。
//
// OSMD 是按容器宽度决定排几行的，所以给它一个足够宽的容器即可单行；
// 它的 Endless 模式指的是"纵向无限高"，不是无限宽，用错了一样会换行。

// 排版单位 → 屏幕像素。
//
// OSMD 的 AbsolutePosition 是「tenths」：1 个排版单位 = 0.1 个谱表间距。
// UnitToPixel 是「一个排版单位多少像素」，zoom 再乘一次。
// 谱表本身高 4 个间距 = 4 个排版单位，中线在顶线下方 2 个排版单位。
//
// 以前这个乘法在五处各写一遍，其中四处把 UnitToPixel 写死成 10。
// 一旦 OSMD 改默认值，声部标签和叠加层就会和谱面错位，所以收成一个函数。
function unitPxOf(osmd) {
  if (!osmd) return 10
  return (osmd.UnitToPixel || 10) * (osmd.zoom || 1)
}

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
// 免得右边留一大片空白。
//
// 估窄了 OSMD 会自动换行（谱面纵向叠成多行），所以宁可估宽一点：
// 渲染完 tightenWidth 会把容器收到实际内容宽度，估宽没有副作用。
// 但也不能太宽——OSMD 排版耗时随宽度线性上涨，估成十几万像素会直接卡死。
function estimateWidth(xml) {
  const mAll = (xml.match(/<measure\s/g) || []).length
  const parts = partCount(xml)
  const measures = Math.max(1, Math.round(mAll / parts))
  const noteCount = (xml.match(/<note[\s>]/g) || []).length
  // 音符密的谱每小节要更多横向空间。基础 300px，每个音补 5px，
  // 上限 900px：实测 7 声部 79 小节 2887 音（每小节约 37 音）需要
  // 约 490px/小节，正好落在 300 + 37×5 = 485。
  const perMeasure = Math.min(900, 300 + (noteCount / measures) * 5)
  return Math.round(measures * perMeasure * zoomFor(parts) + 80)
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

// 确认谱面没有被排成多行。
//
// OSMD 按容器宽度决定换行。横向卷轴模式要求"整首排成一行"：宽度估窄了
// 它会自动换行，谱面纵向叠成多行，横向卷轴就失去意义了。
//
// 判据：同一组小节在所有 system 里的 y 应该一致（单行时每个 system 的
// y 范围相同）。这里只在真的检测到换行时打一条警告——不做自动加宽，
// 因为加宽会让 OSMD 重新排版，耗时随宽度线性上涨（实测 13 万像素直接超时），
// 而正常谱面用 estimateWidth 估出来的宽度是够的。
//
// 如果以后真遇到换行，正确做法是调 estimateWidth 的系数，不是在这里补救。
function assertSingleLine(osmd) {
  const ml = (osmd.GraphicSheet && osmd.GraphicSheet.MeasureList) || []
  if (!ml.length) return true
  const rangeOf = (line) => {
    let lo = Infinity, hi = -Infinity
    for (const gm of line || []) {
      const se = gm && gm.staffEntries && gm.staffEntries[0]
      const ps = se && se.PositionAndShape
      const y = ps && ps.AbsolutePosition ? ps.AbsolutePosition.y : null
      if (y == null) continue
      if (y < lo) lo = y
      if (y > hi) hi = y
    }
    return { lo, hi }
  }
  const first = rangeOf(ml[0])
  for (let i = 1; i < ml.length; i++) {
    const r = rangeOf(ml[i])
    // 单行时每个 system 的纵向范围完全相同（都是同一组谱表）。
    // 差超过 2 个排版单位说明被排到了别的行。
    if (Math.abs(r.lo - first.lo) > 2) {
      console.warn('[ScoreView] 谱面被排成了多行，estimateWidth 估窄了：', i, r.lo, first.lo)
      return false
    }
  }
  return true
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
  const beatMapRef = useRef(null)   // [{beat, x}]，播放时按拍插值定位滚动
  const selfScrollRef = useRef(-1)  // 上一次由我们写入的 scrollLeft，用来忽略自己触发的 scroll 事件
  // 这几个缓存要在这里声明：下面几个 effect 里会用到，
  // 放到后面的函数旁边会在首次 render 时命中 TDZ
  const contentWRef = useRef(0)     // 谱面内容宽度缓存，重新排版时置 0
  const contentLeftRef = useRef(0)  // SVG 左缘在滚动内容里的横坐标
  const contentTopRef = useRef(0)   // SVG 上缘在滚动内容里的纵坐标
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
    buildBeatMap()
  }

  // 播放时滚动要按「拍」连续推进，不能只在换音那一刻跳一格。
  //
  // beatMap 是 (拍 → 谱面横坐标) 的分段线性表：只取每个音的起始拍，
  // 中间的空白（长音、休止）由两侧端点插值补满。OSMD 排版里音与音的
  // 间距本来就不等（长音占位宽、休止符窄），直接按「拍 × 平均宽度」
  // 算会和音符对不上，所以必须用真实坐标插值。
  //
  // 同一拍上可能有多个音（和弦），取最左边那个——滚动参考点应当落在
  // 这一拍的第一个音上，不然和弦的后续音会把光标往前拽。
  function buildBeatMap() {
    const notes = (geoRef.current && geoRef.current.notes) || []
    const pts = []
    for (const n of notes) {
      if (n.beat == null) continue
      const last = pts[pts.length - 1]
      if (last && Math.abs(last.beat - n.beat) < 1e-6) continue
      if (last && n.beat < last.beat) continue
      pts.push({ beat: n.beat, x: n.x })
    }
    beatMapRef.current = pts.length >= 2 ? pts : null
  }

  // 每个声部那一行五线谱在屏幕上的纵向位置，用来把声部名贴在谱线左侧。
  //
  // 用 OSMD 的 staffEntries 直接定位，不去数 SVG 里的横线。
  //
  // 为什么不能用"数长横线、每 5 条一组"：谱面里除了谱线还有符杠（beam）、
  // 加线、连谱号括号，它们也是长横条，getBBox 分不出来。7 声部的谱实测
  // 数出 8 组，之后每 5 条一组的切分整体错位——表现就是左边的声部名
  // 和实际谱表对不上（S1 标到 S2 的位置、B2 落到谱外）。
  //
  // staffEntries 的顺序就是声部从上到下的顺序，y 是排版单位，
  // 乘上 UnitToPixel 就是屏幕像素，不需要任何猜测。
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

    // 排版单位 → 屏幕像素。
    //
    // OSMD 的 AbsolutePosition 是「tenths」：1 个排版单位 = 0.1 个谱表间距。
    // UnitToPixel 是「一个排版单位多少像素」，zoom 再乘一次。
    // 谱表本身高 4 个间距 = 4 个排版单位，中线在顶线下方 2 个排版单位。
    const unit = unitPxOf(osmd)
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
    // 谱宽也变了，缓存的内容宽度作废
    contentWRef.current = 0
    beatMapRef.current = null
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
        // 确认谱面是一整行（宽度估窄时 OSMD 会自动换行）
        assertSingleLine(osmd)
        indexRef.current = buildIndex(osmd)
        stepRef.current = 0
        osmd.cursor.show()
        rebuildGeo()
        tightenWidth()
        measureContent()
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

  // 容器尺寸变了（横竖屏切换、分屏、软键盘收起）要重新贴声部标签。
  // 谱面的纵向排版是按容器高度缩放的，高度一变，每行谱表的位置全变，
  // 不重新量的话标签会整体偏离谱表。
  useEffect(() => {
    if (!ready) return
    const wrap = wrapRef.current
    if (!wrap || typeof ResizeObserver === 'undefined') return
    let lastH = wrap.clientHeight
    let lastW = wrap.clientWidth
    const ro = new ResizeObserver(() => {
      const h = wrap.clientHeight
      const w = wrap.clientWidth
      if (h === lastH && w === lastW) return
      lastH = h
      lastW = w
      // 尺寸变化会让 SVG 重排，等一帧再量
      requestAnimationFrame(() => {
        contentWRef.current = 0
        measureContent()
        measureStaffRows()
      })
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [ready])

  // 切声部要重建叠加层和点击定位的坐标
  useEffect(() => {
    if (partRef.current === myPart) return
    partRef.current = myPart
    const osmd = osmdRef.current
    if (!osmd || !ready) return
    rebuildGeo()
    const cv = canvasRef.current
    if (cv) cv.__layoutKey = ''
    contentWRef.current = 0
    measureContent()
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
    contentWRef.current = 0
    measureContent()
    layoutCanvas()
    // 主题切换会重新 render，谱表的纵向位置跟着变（zoom 可能不同），
    // 声部标签要重新贴一次，否则还停在旧位置
    measureStaffRows()
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
  //
  // 结果缓存起来：这个方法要遍历整份排版（每小节 × 每个声部），
  // 40 小节的众赞歌一次就是几百次读属性。播放时滚动每帧都在动，
  // 原来的缓存判定每帧都会失效，不缓存就会每帧重算一遍。
  // 只有重新排版（换谱 / 换主题 / 换缩放）才会变，那时置 0 让它重算。
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
    return far * unitPxOf(osmd)
  }

  function contentWidthCached() {
    if (!contentWRef.current) contentWRef.current = contentWidth(osmdRef.current)
    return contentWRef.current
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
    const unitPx = unitPxOf(osmd)
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
    const w = contentWidthCached()
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
  //
  // 量一次 SVG 在滚动内容里的位置。
  //
  // 只能在这里读 getBoundingClientRect：谱面是垂直居中的，SVG 相对容器
  // 会有一个偏移（4 声部时约 29px），必须用 rect 差值算。
  // 但滚动时 SVG 和容器一起移动、相对距离不变，所以量一次就够。
  // 播放时每帧滚动，若每帧都读 rect，浏览器每次都要重排一遍，
  // 这正是之前滚动掉帧的一个来源。
  function measureContent() {
    const box = boxRef.current
    const wrap = wrapRef.current
    const svg = box && box.querySelector('svg')
    if (!svg || !wrap) return
    const wr = wrap.getBoundingClientRect()
    const sr = svg.getBoundingClientRect()
    contentLeftRef.current = sr.left - wr.left + wrap.scrollLeft
    contentTopRef.current = sr.top - wr.top + wrap.scrollTop
  }

  function layoutCanvas() {
    const box = boxRef.current
    const cv = canvasRef.current
    const wrap = wrapRef.current
    const svg = box && box.querySelector('svg')
    if (!cv || !svg || !wrap) return
    const dpr = window.devicePixelRatio || 1
    const w = contentWidthCached() || parseFloat(svg.getAttribute('width') || 0)
    const h = parseFloat(svg.getAttribute('height') || svg.clientHeight || 0)
    if (!w || !h) return

    // 画布按内容宽度来，不是按 SVG 宽度（后者等于容器宽度，会大一截）
    const svgLeft = contentLeftRef.current
    const svgTop = contentTopRef.current
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
    // 只在真的变了才写 style：每帧都写会触发样式重算
    const leftCss = Math.round(left)
    if (cv.__leftCss !== leftCss) { cv.__leftCss = leftCss; cv.style.left = leftCss + 'px' }
    const topCss = Math.round(svgTop)
    if (cv.__topCss !== topCss) { cv.__topCss = topCss; cv.style.top = topCss + 'px' }
    if (cv.__cssW !== cssW) { cv.__cssW = cssW; cv.style.width = cssW + 'px' }
    if (cv.__cssH !== h) { cv.__cssH = h; cv.style.height = h + 'px' }
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
    const unitPx = unitPxOf(osmd)

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
    const offsetOf = (cents) => {
      if (cents == null) return 0
      let off = (cents / 100) * 0.25 * unitPx * CURVE_GAIN
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
      if (t.cents == null) continue
      const e = avg.get(t.pos) || { s: 0, n: 0 }
      e.s += t.cents; e.n++
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
    const pts = (data.trace || []).filter((t) => t.midi != null && t.clarity >= 0.45)
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
      const y = notes[p].y * unitPx - offsetOf(t.cents)
      lastY = y
      if (!started) { cx.moveTo(x, y); started = true }
      else cx.lineTo(x, y)
    }
    if (started) cx.stroke()
    cv.__dbg = { posIdx, notesLen: notes.length, lastCurveY: lastY, curBarY: notes[posIdx].y * unitPx }
  }

  // 横向跟随：让当前音停在屏幕偏左，右边留出"接下来要唱的"。
  // 用户正在手动拖谱面时不抢滚动（手指按下的 2.5 秒内都算）。
  const grabbed = () => grabRef.current && Date.now() - grabRef.current < 2500

  // 光标锚点：光标放在 70% 处，当前小节从左边完整露出来，不会一滚动就把谱号切掉
  const ANCHOR = 0.7

  // 由「拍」算出谱面内容坐标。beatMap 是真实音符排版位置的分段线性插值，
  // 所以长音会按它在谱面上实际占的宽度匀速推进，而不是按拍均速。
  const xAtBeat = (beat) => {
    const pts = beatMapRef.current
    if (!pts) return null
    const n = pts.length
    if (beat <= pts[0].beat) return pts[0].x
    if (beat >= pts[n - 1].beat) return pts[n - 1].x
    // 二分找到所在区段；播放时每帧调用，不能线性扫
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (pts[mid].beat <= beat) lo = mid
      else hi = mid
    }
    const a = pts[lo]
    const b = pts[hi]
    const span = b.beat - a.beat
    if (span <= 1e-9) return b.x
    return a.x + ((beat - a.beat) / span) * (b.x - a.x)
  }

  // 播放时的逐帧滚动：按当前拍直接算出应有的 scrollLeft 并写进去。
  //
  // 为什么不用 scrollTo({behavior:'smooth'})：
  // 平滑滚动是浏览器自己的动画，每个新的滚动请求都会顶掉上一次。
  // 之前只在「换音」那一帧调一次，于是滚动走十几帧就停住，等下一个音
  // 再猛地跳一截——实测 20 秒里 84% 的帧 scrollLeft 完全不动，
  // 其余帧一次跳 25~51px，肉眼就是「一顿一顿」。
  // 改成每帧按拍算目标位置（位置本身随拍连续），滚动就是匀速连续的。
  const scrollToBeat = (beat) => {
    const wrap = wrapRef.current
    const osmd = osmdRef.current
    if (!wrap || !osmd || grabbed()) return
    const x = xAtBeat(beat)
    if (x == null) return
    const unitPx = unitPxOf(osmd)
    const target = Math.max(0, contentLeftRef.current + x * unitPx - wrap.clientWidth * ANCHOR)
    // 阈值取 0.25px：高刷屏一帧只推进 0.6px，门槛设高了会被整段吞掉，
    // 又退回「攒几帧跳一次」。scrollLeft 支持小数，不必自己取整。
    if (Math.abs(target - wrap.scrollLeft) < 0.25) return
    selfScrollRef.current = target
    wrap.scrollLeft = target
  }

  // 非播放场景（点谱面定位、切声部、换主题）用的定点跳转：
  // 光标是 OSMD 自己维护的 DOM，位置只能从它身上量。
  const scrollToCursor = (smooth) => {
    const wrap = wrapRef.current
    const osmd = osmdRef.current
    if (!wrap || !osmd || grabbed()) return
    const el = osmd.cursor?.cursorElement
    if (!el || !el.getBoundingClientRect) return
    const r = el.getBoundingClientRect()
    const br = wrap.getBoundingClientRect()
    const x = r.left - br.left + wrap.scrollLeft
    const target = Math.max(0, x - wrap.clientWidth * ANCHOR)
    // 阈值只用于「非播放」的定点跳转：位移小于半小节的没必要动，
    // 免得切声部这种小变化把谱面推来推去
    if (Math.abs(target - wrap.scrollLeft) < 40) return
    selfScrollRef.current = Math.round(target)
    wrap.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' })
  }

  // 把 OSMD 光标推进到第 target 步（光标本身只按音走，不跟拍连续移动）
  function stepCursorTo(osmd, target) {
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
  }

  // 拍 → 光标步号。播放时每帧都要算，用二分而不是线性扫：
  // 40 小节的谱有上千步，线性扫每帧就是上千次比较。
  function cursorStepAt(beat) {
    const idx = indexRef.current
    let lo = 0
    let hi = idx.length - 1
    if (beat <= idx[0] + 1e-6) return 0
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (idx[mid] <= beat + 1e-6) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  useImperativeHandle(ref, () => ({
    // beat：我这个声部当前音符的起始拍；live：叠加层要用的实时数据
    // smooth：非播放场景是否用平滑滚动
    // scrollBeat：用于滚动的连续拍位置。跟唱时 beat 是按音离散的
    //   （只在换音时跳一格），拿它滚动会一顿一顿；调用方把连续的
    //   teamBeat 传进来，滚动就能按拍连续推进。
    syncTo(beat, live, smooth = true, scrollBeat) {
      const osmd = osmdRef.current
      const idx = indexRef.current
      if (!osmd || !idx.length) return
      lastBeatRef.current = beat
      stepCursorTo(osmd, cursorStepAt(beat))
      if (scrollBeat != null && beatMapRef.current) scrollToBeat(scrollBeat)
      else scrollToCursor(smooth)
      if (live) drawOverlay(live)
    },

    // 播放专用：每帧调用，按拍连续滚动。
    // 和 syncTo 分开是因为播放时不需要每帧推进 OSMD 光标：
    // 光标只在换音时更新，滚动则由拍位置直接决定，两者解耦。
    tick(beat, live) {
      const osmd = osmdRef.current
      const idx = indexRef.current
      if (!osmd || !idx.length) return
      lastBeatRef.current = beat
      const target = cursorStepAt(beat)
      if (target !== stepRef.current) stepCursorTo(osmd, target)
      scrollToBeat(beat)
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
        // 播放时每帧都在滚，这次 scroll 事件就是自己触发的。
        // 画布是空的（播放不画叠加层），没必要再跑一遍布局。
        if (Math.abs(wrapRef.current.scrollLeft - selfScrollRef.current) < 1.5) return
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
