import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { midiToName, DYNAMICS } from '@/lib/music'

// 钢琴卷帘编辑器。
//
// 只编辑「当前声部」，不改别的声部——八个声部一起画在手机屏幕上没法用。
// 坐标系：横轴是拍（0..totalBeats），纵轴是 MIDI 音高（lo..hi）。
// 音符的起始拍由前面所有音的 beats 累加得出，所以拖动改变位置时要
// 重排 beats，不能只存一个 start。这是内部格式（顺序累加）决定的。
//
// 交互（触屏优先，桌面也支持）：
//   - 点空白格子：在该拍插入一个音，音高取该行，时值 1 拍
//   - 点已有音符：选中它
//   - 拖动音符：改起始拍（横向）和音高（纵向）
//   - 拖音符右边缘：改时值
//   - 选中后按删除：移除该音
//   - 底部力度条：选中音符后拖动改力度
//
// 所有编辑走 onChange(notes) 回传完整音符数组，App 负责写回 score。

const PITCH_MIN = 36       // C2
const PITCH_MAX = 84       // C6
const ROW_H = 16           // 每行像素高
const BEAT_W_MIN = 28      // 每拍最小宽度
const EDGE = 10            // 右边缘拖拽热区宽度

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// 音符 → 起始拍
function withStarts(notes) {
  let t = 0
  return notes.map((n) => {
    const out = { ...n, start: t }
    t += n.beats
    return out
  })
}

// 起始拍 → 纯音符数组（内部格式只存 beats，起点靠累加得出）
//
// 编辑时每个音都带一个「目标起点 start」。这里按目标起点排序后，
// 用相邻起点差反推 beats：
//     beats[i] = start[i+1] - start[i]
// 最后一个音没有下一个起点，保持它自己的 beats。
//
// 这样「把某个音拖长」= 把下一个音的起点往后推，语义和用户看到的一致；
// 而且总时值 = 最后一个音的起点 + 它的 beats，不会莫名其妙漂移。
function fromStarts(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start || (a.midi ?? 0) - (b.midi ?? 0))
  const out = []
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i]
    const next = sorted[i + 1]
    const beats = next
      ? Math.max(0.25, next.start - n.start)
      : Math.max(0.25, n.beats)
    const item = { midi: n.midi, beats }
    if (n.vel != null) item.vel = n.vel
    out.push(item)
  }
  return out
}

export default function PianoRoll({ parts, myPart, onChange, onClose, theme }) {
  const part = parts[myPart]
  const notes = part?.notes || []

  const [sel, setSel] = useState(null)          // 选中的下标
  const [beatW, setBeatW] = useState(36)
  const scrollRef = useRef(null)
  // window 监听器注册一次就不再重绑，所以要靠 ref 转发到「最新一次渲染」的回调。
  // 直接注册 onPointerMove 会捕获旧闭包，导致拖拽用的还是上一次的 withS / drag。
  const onPointerMoveRef = useRef(null)
  const endDragRef = useRef(null)
  // 容器高度用 ResizeObserver 跟：横竖屏切换、键盘弹出都要跟着变
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setBoxH(el.clientHeight))
    ro.observe(el)
    setBoxH(el.clientHeight)
    return () => ro.disconnect()
  }, [])
  const dragRef = useRef(null)
  const [drag, setDrag] = useState(null)        // 拖拽预览 { i, start, midi, beats }

  const totalBeats = useMemo(
    () => Math.max(4, notes.reduce((s, n) => s + n.beats, 0)),
    [notes]
  )
  const withS = useMemo(() => withStarts(notes), [notes])

  // 音域：包住当前声部所有音，上下各留两行。
  // 至少留 18 个半音（约一个半八度），否则窄音域的声部会挤成一条缝；
  // 最多 48 个半音，再多手机上就没法点了。
  const pitches = notes.filter((n) => n.midi != null).map((n) => n.midi)
  const pLo = pitches.length ? Math.min(...pitches) : 60
  const pHi = pitches.length ? Math.max(...pitches) : 72
  const center = Math.round((pLo + pHi) / 2)
  const span = Math.max(18, Math.min(48, pHi - pLo + 5))
  let lo = center - Math.floor(span / 2)
  let hi = lo + span
  if (lo < PITCH_MIN) { lo = PITCH_MIN; hi = lo + span }
  if (hi > PITCH_MAX) { hi = PITCH_MAX; lo = hi - span }
  const rows = hi - lo + 1

  const width = Math.ceil(totalBeats * beatW) + 60
  // 行高按可用高度撑满：内容比容器矮时放大行高，避免下面一大片空白
  const [boxH, setBoxH] = useState(0)
  const rowH = boxH > 0 ? Math.max(10, Math.min(28, Math.floor(boxH / rows))) : ROW_H
  const height = rows * rowH

  const yOf = (midi) => (hi - midi) * rowH
  const xOf = (beat) => beat * beatW
  const beatAt = (clientX) => {
    const el = scrollRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    const x = clientX - r.left + el.scrollLeft
    return clamp(Math.round(x / beatW * 4) / 4, 0, totalBeats)
  }

  // 选中音符被删掉时清掉选择
  useEffect(() => {
    if (sel != null && !withS[sel]) setSel(null)
  }, [withS, sel])

  const commit = useCallback((list) => {
    onChange(fromStarts(list))
  }, [onChange, totalBeats])

  const addNote = (beat, midi) => {
    const list = withS.map((n) => ({ ...n }))
    // 插到第一个起点 >= 目标拍的位置。新音时值 1 拍；
    // 它跟上一个音之间的空档通过「把上一个音的时值补到新起点」表达。
    const at = list.findIndex((n) => n.start >= beat - 1e-6)
    const idx = at < 0 ? list.length : at
    const newNote = { midi, start: beat, beats: 1, vel: 0.58 }
    if (idx > 0) {
      const prev = list[idx - 1]
      prev.beats = Math.max(0.25, beat - prev.start)
    }
    list.splice(idx, 0, newNote)
    commit(list)
    setSel(idx)
  }

  const removeSelected = () => {
    if (sel == null) return
    const list = withS.filter((_, i) => i !== sel).map((n) => ({ ...n }))
    // 删掉后要保证总时值不缩水：把被删音的时值补给前一个音
    commit(list)
    setSel(null)
  }

  const onBgPointerDown = (e) => {
    // 点到背景（不是音符）才插入
    if (e.target !== e.currentTarget) return
    const el = scrollRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const y = e.clientY - r.top + el.scrollTop
    const midi = clamp(hi - Math.floor(y / rowH), lo, hi)
    addNote(beatAt(e.clientX), midi)
  }

  // 拖拽期间在 window 上监听 pointermove/pointerup。
  // 不能只挂在滚动容器的 onPointerMove 上：手指移出容器、或者在子元素上
  // 按下后事件目标变了，容器就收不到了，拖动会中途断掉。
  useEffect(() => {
    if (!drag) return
    const onMove = (e) => onPointerMoveRef.current && onPointerMoveRef.current(e)
    const onUp = () => endDragRef.current && endDragRef.current()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [drag])

  const startDrag = (e, i, mode) => {
    e.stopPropagation()
    e.preventDefault()
    setSel(i)
    const n = withS[i]
    // start/midi/beats 是「最新预览值」，onPointerMove 会直接改它；
    // endDrag 也读这里，不读 React state——window 监听器闭包里的 state 会是旧的。
    dragRef.current = {
      i, mode,
      x0: e.clientX, y0: e.clientY,
      start0: n.start, midi0: n.midi, beats0: n.beats,
      start: n.start, midi: n.midi, beats: n.beats,
    }
    setDrag({ i, start: n.start, midi: n.midi, beats: n.beats })
  }

  const onPointerMove = (e) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.x0
    const dy = e.clientY - d.y0
    if (d.mode === 'move') {
      const start = clamp(Math.round((d.start0 + dx / beatW) * 4) / 4, 0, totalBeats - 0.25)
      const midi = clamp(d.midi0 - Math.round(dy / rowH), lo, hi)
      d.start = start
      d.midi = midi
      setDrag({ i: d.i, start, midi, beats: d.beats0 })
    } else {
      // 拖右边缘改时值：最小时值 0.25 拍。
      // 时值变长/变短时，后面所有音的起点跟着平移同样距离，
      // 这样「拖长一个音」不会吃掉下一个音的时间。
      const beats = clamp(Math.round((d.beats0 + dx / beatW) * 4) / 4, 0.25, totalBeats)
      d.beats = beats
      d.delta = beats - d.beats0
      setDrag({ i: d.i, start: d.start0, midi: d.midi0, beats })
    }
  }

  const endDrag = () => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) { setDrag(null); return }
    // 直接读 dragRef 里的最新预览值（不可变 state 在闭包里可能是旧的）
    const g = { start: d.start, midi: d.midi, beats: d.beats }
    const list = withS.map((n) => ({ ...n }))
    if (d.mode === 'move') {
      // 拖位置：改这一个音的音高，起点用「加长/缩短前一个音」来表达。
      //
      // 内部格式没有绝对起点，第 i 个音的起点 = 前面所有 beats 之和。
      // 所以把它往后挪 d 拍，正确做法是把第 i-1 个音的时值加长 d；
      // 往前挪就缩短前一个音（缩到 0.25 为止，还不够继续往前扣）。
      // 这样其他所有音的位置和时值都不受影响。
      const n = list[d.i]
      const delta = g.start - d.start0
      list[d.i] = { ...n, midi: g.midi }
      if (Math.abs(delta) > 1e-6) {
        if (delta > 0) {
          if (d.i > 0) list[d.i - 1] = { ...list[d.i - 1], beats: list[d.i - 1].beats + delta }
        } else {
          let need = -delta
          let k = d.i - 1
          while (need > 1e-6 && k >= 0) {
            const take = Math.min(need, Math.max(0, list[k].beats - 0.25))
            list[k] = { ...list[k], beats: list[k].beats - take }
            need -= take
            k--
          }
        }
      }
    } else {
      // 改时值：把新时长写进这个音，并把 delta 应用到后面所有音的起点。
      // 这样 fromStarts 用「相邻起点差」反推 beats 时，只有这一个音的长度变了。
      const delta = (g.beats - d.beats0) || 0
      list[d.i] = { ...list[d.i], beats: g.beats }
      if (Math.abs(delta) > 1e-6) {
        for (let k = d.i + 1; k < list.length; k++) {
          list[k] = { ...list[k], start: Math.max(0, list[k].start + delta) }
        }
      }
    }
    commit(list)
    setDrag(null)
  }

  // 每次渲染都刷新 ref，保证 window 监听器调到的永远是最新闭包
  onPointerMoveRef.current = onPointerMove
  endDragRef.current = endDrag

  // 力度条：拖动改选中音符的力度
  const velBarRef = useRef(null)
  const setVelFromX = (clientX) => {
    if (sel == null) return
    const el = velBarRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const v = clamp((clientX - r.left) / r.width, 0.1, 1)
    const list = withS.map((n, i) => (i === sel ? { ...n, vel: v } : { ...n }))
    commit(list)
  }

  const selNote = sel != null ? withS[sel] : null
  const selVel = selNote?.vel == null ? 0.58 : selNote.vel

  const dark = theme !== 'light'
  const gridLine = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.07)'
  const barLine = dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.22)'
  const whiteKey = dark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.03)'
  const accent = '#2dd4bf'
  const selected = '#f59e0b'

  return (
    <div className="flex h-full w-full min-w-0 max-w-full flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-1.5 px-2 py-1.5 text-[11px]">
        <span className="font-medium">{part?.id} {part?.name}</span>
        <span className="text-muted-foreground">{notes.filter((n) => n.midi != null).length} 音</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            className="flex items-center justify-center rounded border border-input px-1.5 py-0.5 text-muted-foreground"
            onClick={() => setBeatW((w) => clamp(w - 6, BEAT_W_MIN, 72))}
            aria-label="缩小"
          >
            <Minus className="h-3 w-3" aria-hidden="true" />
          </button>
          <button
            className="flex items-center justify-center rounded border border-input px-1.5 py-0.5 text-muted-foreground"
            onClick={() => setBeatW((w) => clamp(w + 6, BEAT_W_MIN, 72))}
            aria-label="放大"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
          </button>
          <Button size="sm" variant="outline" onClick={onClose}>完成</Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto border-t"
      >
        <div
          className="relative"
          style={{ width, height: height + 20 }}
          onPointerDown={onBgPointerDown}
        >
          {/* 横向网格：每拍一条细线，每小节一条粗线 */}
          {Array.from({ length: Math.ceil(totalBeats) + 1 }, (_, b) => (
            <div
              key={'v' + b}
              className="pointer-events-none absolute top-0"
              style={{
                left: xOf(b), width: 1, height,
                background: b % (part?.bar || 4) === 0 ? barLine : gridLine,
              }}
            />
          ))}
          {/* 纵向网格：黑键行加底色，方便对音高 */}
          {Array.from({ length: rows }, (_, k) => {
            const midi = hi - k
            const pc = ((midi % 12) + 12) % 12
            const isBlack = [1, 3, 6, 8, 10].includes(pc)
            const isC = pc === 0
            return (
              <div key={'h' + midi} className="pointer-events-none absolute left-0" style={{ top: k * rowH, width, height: rowH }}>
                {isBlack && <div className="absolute inset-0" style={{ background: whiteKey }} />}
                {isC && <div className="absolute inset-x-0 top-0" style={{ height: 1, background: gridLine }} />}
                {isC && (
                  <span className="absolute left-1 top-0 text-[8px] text-muted-foreground/60" style={{ lineHeight: rowH + 'px' }}>
                    {midiToName(midi)}
                  </span>
                )}
              </div>
            )
          })}
          {/* 音符 */}
          {withS.map((n, i) => {
            if (n.midi == null) return null
            // 拖时值时，后面所有音一起平移（预览和最终结果一致）
            const delta = drag && drag.i < i && drag.mode === 'resize' ? (drag.beats - withS[drag.i].beats) : 0
            const live = drag && drag.i === i ? drag : { ...n, start: n.start + delta }
            const left = xOf(live.start)
            const w = Math.max(6, xOf(live.beats) - 2)
            const top = yOf(live.midi)
            const isSel = sel === i
            const v = live.vel == null ? 0.58 : live.vel
            // 力度决定不透明度：轻的音半透明，重的音实心
            const alpha = 0.35 + v * 0.65
            return (
              <div
                key={'n' + i}
                className="absolute rounded-sm"
                style={{
                  left, top: top + 1, width: w, height: rowH - 2,
                  background: isSel ? selected : accent,
                  opacity: alpha,
                  boxShadow: isSel ? `0 0 0 1.5px ${selected}` : 'none',
                  touchAction: 'none',
                }}
                onPointerDown={(e) => startDrag(e, i, 'move')}
              >
                {/* 右边缘：拖时值 */}
                <div
                  className="absolute right-0 top-0 h-full cursor-ew-resize"
                  style={{ width: EDGE, touchAction: 'none' }}
                  onPointerDown={(e) => startDrag(e, i, 'resize')}
                />
              </div>
            )
          })}
          {/* 播放头位置（只读参考） */}
          <div className="pointer-events-none absolute top-0" style={{ left: 0, width: 1, height, background: 'rgba(45,212,191,.5)' }} />
        </div>
      </div>

      {/* 底部：选中音符的力度 */}
      <div className="shrink-0 border-t px-3 py-2">
        {selNote ? (
          <>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-medium">{midiToName(selNote.midi)}</span>
              <span className="text-muted-foreground">第 {(Math.floor(selNote.start / (part?.bar || 4)) + 1)} 小节 · 时值 {selNote.beats} 拍</span>
              <span className="ml-auto tabular text-muted-foreground">力度 {Math.round(selVel * 100)}</span>
            </div>
            <div
              ref={velBarRef}
              className="relative mt-1.5 h-6 overflow-hidden rounded border border-input"
              style={{ touchAction: 'none' }}
              onPointerDown={(e) => { e.preventDefault(); setVelFromX(e.clientX) }}
              onPointerMove={(e) => { if (e.buttons) setVelFromX(e.clientX) }}
            >
              <div className="h-full bg-brand/30" style={{ width: `${selVel * 100}%` }} />
              <div className="absolute inset-0 flex items-center justify-between px-2 text-[9px] text-muted-foreground">
                <span>轻</span><span>重</span>
              </div>
            </div>
            <div className="mt-1.5 flex gap-1.5">
              {[['pp', '很轻'], ['p', '轻'], ['mp', '中轻'], ['mf', '中'], ['f', '强'], ['ff', '很强']].map(([m, label]) => (
                <button
                  key={m}
                  className="flex-1 rounded border border-input py-1 text-[10px] text-muted-foreground hover:bg-secondary"
                  onClick={() => {
                    const list = withS.map((n, i) => (i === sel ? { ...n, vel: DYNAMICS[m] } : { ...n }))
                    commit(list)
                  }}
                  aria-label={`选中音力度 ${label}`}
                >{m}</button>
              ))}
            </div>
            <button
              className="mt-1.5 w-full rounded border border-destructive/40 py-1 text-[11px] text-destructive"
              onClick={removeSelected}
            >删除这个音</button>
          </>
        ) : (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            点空白格子加一个音；点音符选中后可改力度、拖右边缘改时值、拖动音符改音高和位置。
          </p>
        )}
      </div>
    </div>
  )
}
