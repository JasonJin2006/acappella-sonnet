import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { midiToName } from '@/lib/music'
import {
  trimBuffer, gainBuffer, fadeIn, fadeOut, silenceRange, normalizeBuffer, waveformEnvelope,
} from '@/lib/waveform'

// 波形编辑器：给每条录音轨画波形，可框选区间做剪切/静音/淡入淡出/增益。
//
// 画布只有 300 多像素宽，所以不画原始采样点，用 waveformEnvelope 抽 min/max
// 包络（每列一个上下沿），4000 万个采样也能一帧画完。
//
// 时间轴和 RecStage 保持一致：横轴是录音内的秒，不是谱面拍。
// 起点对齐用 offsetMs / startBeat，不在这里改。

const PAD_L = 6
const PAD_R = 6

export default function WaveformEditor({ take, part, ctx, onApply, onClose, theme }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const [sel, setSel] = useState(null)       // { from, to } 秒
  const [drag, setDrag] = useState(null)
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  const buffer = take?.buffer || null
  const duration = buffer?.duration || 0
  const sr = buffer?.sampleRate || 44100

  // 画布尺寸跟着容器走
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // 画波形
  useEffect(() => {
    const cv = canvasRef.current
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

    const dark = theme !== 'light'
    const waveColor = dark ? '#2dd4bf' : '#0d9488'
    const gridColor = dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.10)'
    const selColor = dark ? 'rgba(245,158,11,.20)' : 'rgba(245,158,11,.22)'
    const mid = h / 2
    const amp = h * 0.42

    // 网格：每秒一条细线，每 5 秒一条粗线
    cx.strokeStyle = gridColor
    cx.lineWidth = 1
    if (duration > 0) {
      const step = duration > 30 ? 5 : duration > 10 ? 2 : 1
      for (let t = 0; t <= duration + 1e-9; t += step) {
        const x = PAD_L + (t / duration) * (w - PAD_L - PAD_R)
        cx.beginPath()
        cx.moveTo(x, 0)
        cx.lineTo(x, h)
        cx.stroke()
      }
    }

    // 选区底色
    if (sel && duration > 0) {
      const x0 = PAD_L + (sel.from / duration) * (w - PAD_L - PAD_R)
      const x1 = PAD_L + (sel.to / duration) * (w - PAD_L - PAD_R)
      cx.fillStyle = selColor
      cx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), h)
    }

    // 中线
    cx.strokeStyle = gridColor
    cx.beginPath()
    cx.moveTo(0, mid)
    cx.lineTo(w, mid)
    cx.stroke()

    if (!buffer) {
      cx.fillStyle = dark ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.35)'
      cx.font = '12px sans-serif'
      cx.textAlign = 'center'
      cx.fillText('这条录音解码失败，只能看不能听', w / 2, mid + 4)
      return
    }

    const cols = Math.max(1, w - PAD_L - PAD_R)
    const env = waveformEnvelope(buffer, cols, 0, duration)
    cx.fillStyle = waveColor
    for (let x = 0; x < cols; x++) {
      const top = mid - env.max[x] * amp
      const bot = mid - env.min[x] * amp
      const height = Math.max(1, bot - top)
      cx.fillRect(PAD_L + x, top, 1, height)
    }

    // 时间刻度
    cx.fillStyle = dark ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)'
    cx.font = '9px sans-serif'
    cx.textAlign = 'left'
    const step2 = duration > 30 ? 5 : duration > 10 ? 2 : 1
    for (let t = 0; t <= duration + 1e-9; t += step2) {
      const x = PAD_L + (t / duration) * (w - PAD_L - PAD_R)
      cx.fillText(t.toFixed(0) + 's', Math.min(w - 20, x + 2), h - 3)
    }
  }, [box, buffer, duration, sel, theme])

  // 屏幕坐标 → 秒
  const timeAt = useCallback((clientX) => {
    const cv = canvasRef.current
    if (!cv || !duration) return 0
    const r = cv.getBoundingClientRect()
    const x = clientX - r.left - PAD_L
    const usable = Math.max(1, r.width - PAD_L - PAD_R)
    return Math.max(0, Math.min(duration, (x / usable) * duration))
  }, [duration])

  const onDown = (e) => {
    if (!buffer) return
    const t = timeAt(e.clientX)
    setDrag({ from: t, to: t })
    setSel({ from: t, to: t })
    setMsg(null)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) {}
  }

  const onMove = (e) => {
    if (!drag) return
    const t = timeAt(e.clientX)
    setSel({ from: Math.min(drag.from, t), to: Math.max(drag.from, t) })
  }

  const onUp = () => {
    if (!drag) return
    setDrag(null)
    // 点击没拖动就是清除选区
    setSel((s) => (s && s.to - s.from > 0.02 ? s : null))
  }

  const apply = async (fn, label) => {
    if (!buffer) return
    const range = sel && sel.to - sel.from > 0.02 ? sel : { from: 0, to: duration }
    setBusy(true)
    try {
      const next = fn(buffer, range)
      if (!next) throw new Error('处理失败')
      onApply(next, label)
      setMsg(`${label}：${range.from.toFixed(2)}–${range.to.toFixed(2)} 秒`)
      setSel(null)
    } catch (e) {
      setMsg('失败：' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const hasSel = sel && sel.to - sel.from > 0.02
  const selLen = hasSel ? sel.to - sel.from : 0

  return (
    <div className="flex h-full w-full min-w-0 max-w-full flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-[11px]">
        <span className="font-medium">{part?.id}</span>
        <span className="text-muted-foreground">
          {duration ? duration.toFixed(2) + ' 秒' : '无音频'}
          {take?.startBeat != null ? ` · 起点第 ${take.startBeat} 拍` : ''}
        </span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={onClose}>完成</Button>
      </div>

      <div ref={wrapRef} className="relative min-h-0 flex-1 border-y">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full touch-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      </div>

      <div className="shrink-0 space-y-2 px-3 py-2">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {hasSel
            ? <>选区 <span className="tabular text-foreground">{sel.from.toFixed(2)} – {sel.to.toFixed(2)} 秒</span>（{selLen.toFixed(2)} 秒）</>
            : '在波形上拖动框选一段；不选就是整条'}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" disabled={busy || !buffer || !hasSel}
            onClick={() => apply((b, r) => trimBuffer(ctx, b, r.from, r.to), '剪切')}>
            只保留选区
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !buffer || !hasSel}
            onClick={() => apply((b, r) => silenceRange(ctx, b, r.from, r.to), '静音')}>
            选区静音
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !buffer}
            onClick={() => apply((b, r) => fadeIn(ctx, b, r.from, r.to), '淡入')}>
            淡入
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !buffer}
            onClick={() => apply((b, r) => fadeOut(ctx, b, r.from, r.to), '淡出')}>
            淡出
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" disabled={busy || !buffer}
            onClick={() => apply((b) => gainBuffer(ctx, b, 1.4), '增益 +3dB')}>
            音量 +3dB
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !buffer}
            onClick={() => apply((b) => gainBuffer(ctx, b, 0.71), '增益 -3dB')}>
            音量 -3dB
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !buffer}
            onClick={() => apply((b) => normalizeBuffer(ctx, b, 0.9), '归一化')}>
            归一化
          </Button>
        </div>
        {msg && <p className="text-[11px] text-muted-foreground">{msg}</p>}
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          编辑只改这条录音的 PCM，不动原始文件；写回后混音试听和转谱都用新波形。静音保留时长，剪切会改变长度。
        </p>
      </div>
    </div>
  )
}
