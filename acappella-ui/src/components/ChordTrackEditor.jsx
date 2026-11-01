import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TEXTURES, textureName, measureCount, keyName, rankKeys, defaultPlan } from '@/lib/arranger'
import { markOf, valueAt, VEL_MARKS, extractAutomation } from '@/lib/automation'

// 和弦轨 + 力度自动化编辑器。
//
// 两个视图切换：
//   和弦轨：每个小节一格，显示/编辑「和弦」和「织体」
//   自动化：力度曲线，横轴小节、纵轴力度，点一下加控制点、拖动改值
//
// 为什么不合并成一个视图：两者的编辑手势不同（和弦是点选，自动化是拖动），
// 挤在一起在手机上会互相误触。

const ROOT_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const CHORD_TYPES = [
  ['I', '主和弦'],
  ['ii', '上主'],
  ['iii', '中音'],
  ['IV', '下属'],
  ['V', '属'],
  ['vi', '下中音'],
  ['I7', '主七'],
  ['ii7', '上主七'],
  ['V7', '属七'],
]

export default function ChordTrackEditor({
  score, chords, textures, automation, onChords, onTextures, onAutomation, onClose, theme,
}) {
  const [tab, setTab] = useState('chord')
  // measureCount(notes, bar) 接收的是音符数组，不是整个 score。
  // 取最长声部的总时值换算成小节数（各声部时值一般一致）。
  const barBeats = score.bar || 4
  const bars = useMemo(() => {
    const parts = score.parts || []
    if (!parts.length) return 1
    const longest = parts.reduce((a, b) => {
      const la = (a.notes || []).reduce((s, n) => s + n.beats, 0)
      const lb = (b.notes || []).reduce((s, n) => s + n.beats, 0)
      return lb > la ? b : a
    })
    return measureCount(longest.notes || [], barBeats)
  }, [score, barBeats])
  const [sel, setSel] = useState(0)      // 当前小节

  // 首次切到自动化页且还没有控制点时，从当前谱面反推一条曲线，
  // 用户能看到「现在是什么样」再开始改，而不是面对空白画布。
  const seededRef = useRef(false)
  useEffect(() => {
    if (tab !== 'auto' || seededRef.current) return
    seededRef.current = true
    if ((automation || []).length) return
    const pts = extractAutomation(score, barBeats)
    if (pts.length) onAutomation((prev) => (prev && prev.length ? prev : pts))
  }, [tab, automation, score, barBeats, onAutomation])

  // 只数「真的有音符」的声部：手机上可能用哼唱加过空声部，
  // 直接看 parts.length 会显示成 5 声部，但实际只有 4 个在唱。
  const voicedCount = (score.parts || []).filter(
    (p) => (p.notes || []).some((n) => n.midi != null)
  ).length

  const dark = theme !== 'light'
  const gridColor = dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.10)'

  // ---------------- 力度曲线画布 ----------------
  const cvRef = useRef(null)
  const wrapRef = useRef(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [drag, setDrag] = useState(null)

  // 画布容器只在「自动化」标签页渲染。切到该页时容器才挂载，
  // 所以这个 effect 必须依赖 tab，否则第一次切过去时 wrapRef 还是 null，
  // 尺寸测不到，画布永远是 0×0（表现为一片空白）。
  useEffect(() => {
    if (tab !== 'auto') return
    const el = wrapRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tab])

  useEffect(() => {
    if (tab !== 'auto') return
    const cv = cvRef.current
    if (!cv || !box.w || !box.h) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.floor(box.w))
    const h = Math.max(1, Math.floor(box.h))
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
    }
    const cx = cv.getContext('2d')
    cx.setTransform(dpr, 0, 0, dpr, 0, 0)
    cx.clearRect(0, 0, w, h)

    const padL = 26
    const padR = 8
    const padT = 8
    const padB = 18
    const gw = Math.max(1, w - padL - padR)
    const gh = Math.max(1, h - padT - padB)
    const xOf = (bar) => padL + (bars <= 1 ? 0 : (bar / (bars - 1)) * gw)
    const yOf = (v) => padT + (1 - v) * gh

    // 小节竖线
    cx.strokeStyle = gridColor
    cx.lineWidth = 1
    for (let b = 0; b < bars; b++) {
      const x = padL + (b / Math.max(1, bars)) * gw
      cx.beginPath()
      cx.moveTo(x, padT)
      cx.lineTo(x, padT + gh)
      cx.stroke()
    }

    // 力度档位横线 + 标签
    cx.font = '9px sans-serif'
    cx.textAlign = 'right'
    for (const [v, m] of VEL_MARKS) {
      const y = yOf(v)
      cx.strokeStyle = gridColor
      cx.beginPath()
      cx.moveTo(padL, y)
      cx.lineTo(padL + gw, y)
      cx.stroke()
      cx.fillStyle = dark ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)'
      cx.fillText(m, padL - 4, y + 3)
    }

    // 当前小节高亮
    if (sel >= 0 && sel < bars) {
      const x0 = padL + (sel / Math.max(1, bars)) * gw
      const x1 = padL + ((sel + 1) / Math.max(1, bars)) * gw
      cx.fillStyle = dark ? 'rgba(45,212,191,.12)' : 'rgba(13,148,136,.12)'
      cx.fillRect(x0, padT, Math.max(2, x1 - x0), gh)
    }

    // 曲线
    const pts = automation || []
    if (pts.length) {
      cx.strokeStyle = '#2dd4bf'
      cx.lineWidth = 2
      cx.beginPath()
      for (let b = 0; b < bars; b++) {
        const v = valueAt(pts, b)
        if (v == null) continue
        const x = xOf(Math.min(bars - 1, b))
        const y = yOf(v)
        if (b === 0) cx.moveTo(x, y)
        else cx.lineTo(x, y)
      }
      cx.stroke()
      // 控制点
      for (const p of pts) {
        if (p.bar >= bars) continue
        cx.fillStyle = '#f59e0b'
        cx.beginPath()
        cx.arc(xOf(p.bar), yOf(p.value), 4, 0, Math.PI * 2)
        cx.fill()
      }
    }
  }, [tab, box, automation, bars, sel, theme, gridColor])

  const barAt = (clientX) => {
    const cv = cvRef.current
    if (!cv) return 0
    const r = cv.getBoundingClientRect()
    const padL = 26
    const padR = 8
    const gw = Math.max(1, r.width - padL - padR)
    const x = clientX - r.left - padL
    return Math.max(0, Math.min(bars - 1, Math.round((x / gw) * (bars - 1))))
  }
  const valAt = (clientY) => {
    const cv = cvRef.current
    if (!cv) return 0.58
    const r = cv.getBoundingClientRect()
    const padT = 8
    const padB = 18
    const gh = Math.max(1, r.height - padT - padB)
    const y = clientY - r.top - padT
    return Math.max(0.05, Math.min(1, 1 - y / gh))
  }

  const onDown = (e) => {
    const b = barAt(e.clientX)
    const v = valAt(e.clientY)
    setSel(b)
    setDrag({ bar: b })
    onAutomation((prev) => setPointLocal(prev, b, v))
  }
  const onMove = (e) => {
    if (!drag) return
    const v = valAt(e.clientY)
    onAutomation((prev) => setPointLocal(prev, drag.bar, v))
  }
  const onUp = () => setDrag(null)

  // 和弦/织体
  const curChord = (chords && chords[sel]) || ''
  const curTexture = (textures && textures[sel]) || ''

  const setChord = (name) => {
    const next = [...(chords || [])]
    while (next.length < bars) next.push('')
    next[sel] = name
    onChords(next)
  }
  const setTexture = (id) => {
    const next = [...(textures || [])]
    while (next.length < bars) next.push('')
    next[sel] = id
    onTextures(next)
  }
  const clearBar = () => {
    const c = [...(chords || [])]
    const t = [...(textures || [])]
    if (c.length > sel) c[sel] = ''
    if (t.length > sel) t[sel] = ''
    onChords(c)
    onTextures(t)
  }

  return (
    <div className="flex h-full w-full min-w-0 max-w-full flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-1.5 px-2 py-1.5">
        <button
          className={`rounded px-2 py-1 text-[11px] ${tab === 'chord' ? 'bg-brand/15 text-foreground' : 'text-muted-foreground'}`}
          onClick={() => setTab('chord')}
        >和弦轨</button>
        <button
          className={`rounded px-2 py-1 text-[11px] ${tab === 'auto' ? 'bg-brand/15 text-foreground' : 'text-muted-foreground'}`}
          onClick={() => setTab('auto')}
        >力度自动化</button>
        <span className="ml-1 text-[10px] text-muted-foreground">{bars} 小节 · {voicedCount} 声部</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={onClose}>完成</Button>
      </div>

      {tab === 'chord' ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <div className="grid grid-cols-4 gap-1">
              {Array.from({ length: bars }, (_, b) => {
                const c = (chords && chords[b]) || ''
                const t = (textures && textures[b]) || ''
                const active = b === sel
                return (
                  <button
                    key={b}
                    onClick={() => setSel(b)}
                    className={`rounded border px-1 py-1.5 text-left text-[10px] leading-tight transition-colors ${
                      active ? 'border-brand bg-brand/15' : 'border-input'
                    }`}
                  >
                    <div className="text-muted-foreground">{b + 1}</div>
                    <div className="truncate font-medium">{c || '—'}</div>
                    <div className="truncate text-muted-foreground">{t ? textureName(t) : '自动'}</div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="shrink-0 space-y-2 border-t px-3 py-2">
            <div className="text-[11px] text-muted-foreground">第 {sel + 1} 小节</div>
            <div>
              <div className="mb-1 text-[10px] text-muted-foreground">和弦（留空 = 自动推断）</div>
              <div className="flex flex-wrap gap-1">
                {CHORD_TYPES.map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setChord(id)}
                    className={`rounded border px-2 py-1 text-[10px] ${
                      curChord === id ? 'border-brand bg-brand/15' : 'border-input text-muted-foreground'
                    }`}
                    aria-label={`和弦 ${id} ${label}`}
                  >
                    <span className="font-medium">{id}</span>
                    <span className="ml-1 opacity-70">{label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] text-muted-foreground">织体（留空 = 自动）</div>
              <div className="flex flex-wrap gap-1">
                {TEXTURES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTexture(t.id)}
                    className={`rounded border px-2 py-1 text-[10px] ${
                      curTexture === t.id ? 'border-brand bg-brand/15' : 'border-input text-muted-foreground'
                    }`}
                    aria-label={`织体 ${textureName(t.id)}`}
                  >
                    {textureName(t.id)}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" className="flex-1" onClick={clearBar}>这一小节恢复自动</Button>
              <Button size="sm" variant="outline" onClick={() => onChords([])}>全部清空</Button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="text-[10px] leading-relaxed text-muted-foreground px-3 pb-1">
            点一下加控制点，上下拖动改力度。手写力度（文本记谱里的 mf/pp）优先，不会被曲线覆盖。
          </div>
          <div ref={wrapRef} className="relative min-h-0 w-full flex-1 overflow-hidden border-y">
            <canvas
              ref={cvRef}
              data-automation-canvas="1"
              className="absolute inset-0 block h-full w-full touch-none"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            />
          </div>
          <div className="shrink-0 px-3 py-2 text-[11px] text-muted-foreground">
            {automation && automation.length
              ? <>当前 {automation.length} 个控制点，第 {sel + 1} 小节约 {markOf(valueAt(automation, sel))}（{Math.round((valueAt(automation, sel) || 0.58) * 100)}）</>
              : '还没有控制点。点曲线区域开始画。'}
            {automation && automation.length > 0 && (
              <button
                className="ml-2 rounded border border-destructive/40 px-2 py-0.5 text-[10px] text-destructive"
                onClick={() => onAutomation(() => [])}
              >清空曲线</button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// 本地版 setPoint（避免为了一个简单操作引入循环依赖）
function setPointLocal(points, bar, value) {
  // points 可能还没初始化（首次点击前 automation 是空数组）

  const v = Math.max(0.05, Math.min(1, value))
  const list = (points || []).filter((p) => p.bar !== bar)
  list.push({ bar, value: +v.toFixed(3) })
  return list.sort((a, b) => a.bar - b.bar)
}
