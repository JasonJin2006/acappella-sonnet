import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Check, Mic, Music2, Square, Trash2 } from 'lucide-react'
import { HumRecorder, transcribe, transcribeTracked } from '@/lib/hum'
import { midiToName } from '@/lib/music'
import { scoreToMusicXML } from '@/lib/musicxml'

const ScoreView = lazy(() => import('@/components/ScoreView'))

// 哼唱工作区：整屏替代跟谱界面。上半是采集控制，下半是转录结果。
// 哼唱时看的是"我在哼什么"，而不是原来的谱子，所以这里不再渲染主谱面。
export default function HumStage({ bpm, bar, theme, disabled, result, onResult, onApply, onDiscard, onBusyChange }) {
  const recRef = useRef(null)
  // 防重入闸门：从点击到 getUserMedia 返回之间，按钮还没来得及变成「停止」
  const startingRef = useRef(false)
  const [phase, setPhase] = useState('idle')
  const [live, setLive] = useState(null)
  const [level, setLevel] = useState(0)
  const [err, setErr] = useState(null)
  const [tempo, setTempo] = useState(Math.round(bpm || 96))
  // quant 量化半拍 / free 自由节拍 / bass 只跟最低声部（实验）
  const [mode, setMode] = useState('quant')

  useEffect(() => () => {
    const r = recRef.current
    if (r) r.stop()
    if (onBusyChange) onBusyChange(false)
  }, [])

  const start = async () => {
    // 防重入：setPhase 要到下一次渲染才生效，快速双击时第二次点击
    // 看到的还是「开始哼唱」，会再 new 一个 HumRecorder 覆盖 recRef，
    // 第一个实例的流就再也没人 stop（系统一直显示「正在录音」）。
    if (startingRef.current || recRef.current) return
    startingRef.current = true
    setErr(null)
    setLive(null)
    setLevel(0)
    if (onBusyChange) onBusyChange(true)
    const rec = new HumRecorder()
    recRef.current = rec
    setPhase('rec')
    try {
      const r = await rec.start((f) => {
        setLive(f.midi != null ? midiToName(f.midi) : null)
        setLevel(Math.min(1, (f.rms || 0) * 12))
      })
      if (r.error) {
        setErr(r.error)
        setPhase('idle')
        recRef.current = null
        if (onBusyChange) onBusyChange(false)
      }
    } finally {
      startingRef.current = false
    }
  }

  const stop = () => {
    const rec = recRef.current
    recRef.current = null
    setPhase('idle')
    setLive(null)
    setLevel(0)
    if (onBusyChange) onBusyChange(false)
    if (!rec) return
    const frames = rec.stop()
    const res =
      mode === 'bass'
        ? transcribeTracked(frames, tempo, { free: true, lo: 36, hi: 60 })
        : transcribe(frames, tempo, { free: mode === 'free' })
    if (!res.notes.length) {
      setErr('没识别到旋律，离麦克风近一点再试')
      return
    }
    setErr(null)
    onResult(res)
  }

  const previewXml = useMemo(() => {
    if (!result || !result.notes.length) return null
    return scoreToMusicXML({
      title: '哼唱结果',
      bpm: tempo,
      bar: bar || 4,
      parts: [{ id: 'H', name: '哼唱', notes: result.notes }],
    })
  }, [result, tempo, bar])

  return (
    <div className="flex h-full flex-col gap-2 px-4 pb-3 pt-3">
      {/* pt-3 与设置页、谱库页对齐：卡片不能紧贴上面的标签栏。
          px-4/pb-3 同理，原来只有 px-3 pb-2 且没有 pt，
          卡片会紧贴上面的标签栏，右边也贴屏（实测练唱页右边距 0px）。 */}
      <div className="shrink-0 rounded-xl border bg-card/70 px-3 py-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-1.5">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">用同一个字哼一段，停止后自动记谱</span>
          {/* shrink-0 + whitespace-nowrap：这一排控件在窄屏上会被 flex 压缩，
              实测「量化/自由/低音」被挤成竖排两行。它们不该收缩，宁可整排
              溢出由外层卡片承担。 */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <div className="flex shrink-0 overflow-hidden rounded-full border border-input">
              {[
                ['quant', '量化'],
                ['free', '自由'],
                ['bass', '低音'],
              ].map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setMode(k)}
                  title={
                    k === 'quant'
                      ? '吸到半拍网格，适合有拍子的旋律'
                      : k === 'free'
                        ? '不量化，保留实际时长和音分偏差'
                        : '实验：只跟最低声部，合唱录音里可能跳到别的声部'
                  }
                  className={`shrink-0 whitespace-nowrap px-2 py-0.5 text-[10px] transition-colors ${
                    mode === k ? 'bg-brand text-brand-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-muted-foreground">BPM</span>
            <input
              type="number"
              min={40}
              max={220}
              step={1}
              value={tempo}
              onChange={(e) => setTempo(Math.max(40, Math.min(220, parseInt(e.target.value, 10) || 96)))}
              className="w-14 rounded-md border border-input bg-transparent px-2 py-1 text-[12px] tabular outline-none focus:ring-1 focus:ring-ring"
            />
            {phase === 'rec' ? (
              <Button size="sm" variant="destructive" onClick={stop}>
                <Square className="h-3.5 w-3.5" />
                停止并记谱
              </Button>
            ) : (
              <Button size="sm" variant="brand" onClick={start} disabled={disabled}>
                <Mic className="h-3.5 w-3.5" />
                {result ? '重新哼' : '开始哼唱'}
              </Button>
            )}
          </div>
        </div>

        <div className="mt-2 flex items-end gap-3">
          <div className="min-w-[76px] text-[34px] font-semibold leading-none tabular">
            {phase === 'rec' ? (live || '…') : <Music2 className="h-8 w-8 text-muted-foreground/35" aria-hidden="true" />}
          </div>
          <div className="mb-1 min-w-0 flex-1">
            <div className="h-[5px] overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-brand transition-[width] duration-100" style={{ width: Math.round(level * 100) + '%' }} />
            </div>
            <div className="mt-1 truncate text-[10px] text-muted-foreground">
              {phase === 'rec' ? '正在采集，唱满每个音，中间可以换气' : '建议戴耳机，环境越安静越准'}
            </div>
          </div>
        </div>

        {disabled && <p className="mt-1.5 text-[11px] text-muted-foreground">先回到跟谱界面停止跟随，麦克风是共用的。</p>}
        {err && <p className="mt-1.5 text-[11px] text-destructive">{err}</p>}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-card/40">
        {previewXml ? (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">渲染谱面…</div>}>
            <ScoreView xml={previewXml} theme={theme} myPart={0} />
          </Suspense>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[12px] text-muted-foreground">
            <Mic className="h-6 w-6 opacity-40" />
            <span>停止哼唱后，这里会显示转录出来的谱面</span>
          </div>
        )}
      </div>

      {result && (
        <div className="flex shrink-0 items-center gap-2 rounded-xl border bg-card/70 px-3 py-2 backdrop-blur-sm">
          <span className="text-[11px] text-muted-foreground">
            {result.voiced} 个音，共 {result.totalBeats} 拍
            {result.free ? '，未量化' : ''}
            {mode === 'bass' ? '，实验：只跟最低声部' : ''}
            {(() => {
              const c = (result.notes || []).filter((n) => n.midi != null && Math.abs(n.cents || 0) >= 20)
              if (!c.length) return ''
              const max = Math.max(...c.map((n) => Math.abs(n.cents)))
              return `，${c.length} 个音偏离十二平均律（最大 ${max} 音分）`
            })()}
          </span>
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" variant="brand" onClick={onApply}>
              <Check className="h-3.5 w-3.5" />
              加入谱面
            </Button>
            <Button size="sm" variant="outline" onClick={onDiscard}>
              <Trash2 className="h-3.5 w-3.5" />
              丢弃
            </Button>
          </span>
        </div>
      )}
    </div>
  )
}
