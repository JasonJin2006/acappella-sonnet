import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Mic, Square, Trash2, RefreshCw, Play, PencilLine, VolumeX, Volume2, FileMusic } from 'lucide-react'
import { TakeRecorder, alignTake, analyzeBuffer } from '@/lib/takes'
import { sharedCtx } from '@/lib/sharedCtx'
import WaveformEditor from '@/components/WaveformEditor'
import { midiToName } from '@/lib/music'

const fmtSec = (s) => {
  const v = Math.max(0, s || 0)
  return v >= 60 ? Math.floor(v / 60) + ':' + String(Math.round(v % 60)).padStart(2, '0') : v.toFixed(1) + ' 秒'
}

// 录音工作区：整屏替代跟谱界面。这里不画原谱，画的是"我录了哪几条、落在哪"，
// 因为录音时看的是轨道位置对不对，而不是谱面上的光标。
export default function RecStage({
  score, myPart, bpm, disabled, takes, addTake, updateTake, removeTake, theme,
  playing, onPlay, onStopPlay, onBusyChange, onTranscribe,
}) {
  const recRef = useRef(null)
  // 防重入闸门：从点击到 getUserMedia 返回之间，按钮还没来得及变成「停止」
  const startingRef = useRef(false)
  const [idx, setIdx] = useState(myPart || 0)
  const [phase, setPhase] = useState('idle')
  const [secs, setSecs] = useState(0)
  const [err, setErr] = useState(null)
  const [playBeat, setPlayBeat] = useState(0)
  const [peak, setPeak] = useState(0)
  // 正在用波形编辑器编辑哪条轨（null 表示不在编辑）
  const [editingId, setEditingId] = useState(null)
  const [hot, setHot] = useState(false)
  const [converting, setConverting] = useState(false)

  const bar = score.bar || 4
  const spb = 60 / (bpm || 96)
  const totalBeats = useMemo(
    () => Math.max(1, ...score.parts.map((p) => p.notes.reduce((a, n) => a + n.beats, 0))),
    [score]
  )
  const bars = Math.max(1, Math.ceil(totalBeats / bar))
  const part = score.parts[idx]
  const refLine = part
    ? part.notes.slice(0, 10).map((n) => (n.midi == null ? '休止' : midiToName(n.midi))).join(' ')
    : ''

  useEffect(() => {
    if (phase !== 'rec') return
    const t = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [phase])

  useEffect(() => () => {
    const r = recRef.current
    if (r) r.stop()
    if (onBusyChange) onBusyChange(false)
  }, [])

  // 播放头：混音从点击后约 80ms 起播，按拍换算成位置
  useEffect(() => {
    if (!playing) { setPlayBeat(0); return }
    const startAt = performance.now() + 80
    const id = setInterval(() => {
      setPlayBeat(Math.max(0, (performance.now() - startAt) / 1000 / spb))
    }, 60)
    return () => clearInterval(id)
  }, [playing, spb])

  const start = async () => {
    // 防重入。React 的 setPhase 要到下一次渲染才生效，快速双击时第二次点击
    // 看到的还是「录制」按钮。原来每次点击都 new 一个 TakeRecorder 并覆盖
    // recRef，第一个实例的流就再也没人 stop，系统一直显示「正在录音」。
    if (startingRef.current || recRef.current) return
    startingRef.current = true
    setErr(null)
    setSecs(0)
    setPeak(0)
    setHot(false)
    onStopPlay()
    const rec = new TakeRecorder()
    recRef.current = rec
    setPhase('countin')
    if (onBusyChange) onBusyChange(true)
    try {
      const r = await rec.start({
        bpm,
        countIn: 4,
        onPhase: (p) => setPhase(p === 'rec' ? 'rec' : 'countin'),
        onFrame: (f) => {
          setPeak((p) => (Math.abs(p - (f.peak || 0)) > 0.02 ? (f.peak || 0) : p))
          // 限幅前超过 0.98 才算真过载：录下来的波形已经被软限幅保护住了
          setHot((f.rawPeak || 0) > 0.98)
        },
      })
      if (r.error) {
        if (r.error !== '已取消') setErr(r.error)
        setPhase('idle')
        recRef.current = null
        if (onBusyChange) onBusyChange(false)
      }
    } finally {
      startingRef.current = false
    }
  }

  const stop = async () => {
    const rec = recRef.current
    recRef.current = null
    setPhase('idle')
    setPeak(0)
    if (onBusyChange) onBusyChange(false)
    if (!rec) return
    const res = await rec.stop()
    if (!res || !res.buffer || res.duration < 0.4) {
      if (res && res.duration > 0) setErr('录音太短，没有保存')
      return
    }
    const p = score.parts[idx]
    if (!p) { setErr('找不到这个声部'); return }
    const al = alignTake(res.trace || [], p, bpm)
    const stat = analyzeBuffer(res.buffer)
    addTake({
      id: 't' + Date.now() + '_' + Math.round(Math.random() * 1e6),
      partIndex: idx,
      partId: p.id,
      name: p.name,
      buffer: res.buffer,
      duration: res.duration,
      startBeat: al.startBeat,
      cost: al.cost,
      margin: al.margin,
      weak: al.weak,
      offsetMs: 0,
      muted: false,
      peak: stat.peak,
      clipped: stat.clipped,
      trace: res.trace || [],
    })
  }

  const realign = (t) => {
    const p = score.parts[t.partIndex]
    if (!p) return
    const al = alignTake(t.trace || [], p, bpm)
    updateTake(t.id, { startBeat: al.startBeat, cost: al.cost, margin: al.margin, weak: al.weak })
  }

  // 波形编辑结果写回：换掉 buffer，时长要重新算，
  // 峰值/削顶也要重算（编辑可能把音量推高或把削顶那段裁掉）
  const applyWaveform = (buffer, label) => {
    if (!editingId) return
    const stat = analyzeBuffer(buffer)
    updateTake(editingId, {
      buffer,
      duration: buffer.duration,
      peak: stat.peak,
      clipped: stat.clipped,
      edited: label || '已编辑',
    })
    setEditingId(null)
  }

    const editing = editingId ? takes.find((t) => t.id === editingId) : null
  const live = takes.filter((t) => !t.muted).length

  return (
    <div className="flex h-full flex-col gap-2 px-4 pb-3">
      {/* px-4/pb-3 与设置页、谱库页对齐。原来只有 px-3 pb-2 且**没有 pt**，
          卡片会紧贴上面的标签栏，右边也贴屏（实测右边距 0px）。 */}
      <div className="shrink-0 rounded-xl border bg-card/70 px-3 py-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-1.5">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">分声部各录一条，自动对齐到拍</span>
          <div className="ml-auto flex items-center gap-1.5">
            <Select value={String(idx)} onValueChange={(v) => setIdx(parseInt(v, 10))}>
              <SelectTrigger className="h-8 w-[136px] text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {score.parts.map((p, i) => (
                  <SelectItem key={p.id + i} value={String(i)}>
                    {p.id} {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {phase === 'idle' ? (
              <Button size="sm" variant="brand" onClick={start} disabled={disabled}>
                <Mic className="h-3.5 w-3.5" />
                录制
              </Button>
            ) : (
              <Button size="sm" variant="destructive" onClick={stop}>
                <Square className="h-3.5 w-3.5" />
                停止
              </Button>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          {phase === 'countin' && <span className="text-[hsl(38_92%_50%)]">倒计时 4 拍，准备从声部开头唱</span>}
          {phase === 'rec' && <span className="text-[#2dd4bf]">录音中 {fmtSec(secs)}</span>}
          {phase === 'idle' && <span className="truncate">{bar} 拍一小节，共 {bars} 小节。参考音符：{refLine}</span>}
        </div>
        {phase === 'rec' && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full transition-[width] duration-75"
                style={{
                  width: Math.min(100, Math.round(peak * 100)) + '%',
                  background: hot ? 'hsl(38 92% 50%)' : 'hsl(173 72% 46%)',
                }}
              />
            </div>
            <span className={`w-[72px] shrink-0 text-right text-[10px] ${hot ? 'text-[hsl(38_92%_40%)]' : 'text-muted-foreground'}`}>
              {hot ? '麦克风太近' : '输入电平'}
            </span>
          </div>
        )}
        {disabled && <p className="mt-1 text-[11px] text-muted-foreground">跟随还在运行，先在跟谱页停止。</p>}
        {err && <p className="mt-1 text-[11px] text-destructive">{err}</p>}
      </div>

      {editing && (
        <div className="absolute inset-0 z-40 bg-background">
          <WaveformEditor
            take={editing}
            part={score?.parts?.find((p) => p.id === editing.partId)}
            ctx={sharedCtx()}
            theme={theme}
            onApply={applyWaveform}
            onClose={() => setEditingId(null)}
          />
        </div>
      )}

            <div className="relative min-h-0 flex-1 overflow-y-auto rounded-xl border bg-card/40 p-3">
        <div className="relative">
          {/* 小节标尺 */}
          <div className="relative mb-1 h-4 border-b border-border/60">
            {Array.from({ length: bars }).map((_, i) => (
              <span
                key={i}
                className="absolute top-0 text-[9px] text-muted-foreground"
                style={{ left: ((i * bar) / totalBeats) * 100 + '%' }}
              >
                {i + 1}
              </span>
            ))}
          </div>

          {takes.length === 0 && (
            <div className="flex h-28 items-center justify-center text-[11px] text-muted-foreground">
              还没有录音。选一个声部，点录制试一条。
            </div>
          )}

          {takes.map((t, i) => {
            const beatStart = (t.startBeat || 0) + (t.offsetMs || 0) / 1000 / spb
            const b0 = Math.max(0, Math.min(totalBeats, beatStart))
            const b1 = Math.max(b0, Math.min(totalBeats, beatStart + (t.duration || 0) / spb))
            const left = (b0 / totalBeats) * 100
            const width = Math.max(1.2, ((b1 - b0) / totalBeats) * 100)
            const fit = Math.round((1 - (t.cost || 0)) * 100)
            const shaky = t.weak || (t.margin || 0) < 0.02
            return (
              <div key={t.id} className="mb-2.5 rounded-md border bg-secondary/20 px-2 py-1.5">
                <div className="relative h-6 overflow-hidden rounded bg-secondary/50">
                  <div
                    className={`absolute inset-y-0 overflow-hidden rounded border ${
                      t.muted ? 'border-muted-foreground/30 bg-muted-foreground/15' : 'border-brand/60 bg-brand/25'
                    }`}
                    style={{ left: left + '%', width: width + '%' }}
                  >
                    <span className="whitespace-nowrap px-1 text-[10px] leading-6">
                      {t.partId} {fmtSec(t.duration)}
                    </span>
                  </div>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className={`shrink-0 text-[10px] ${shaky ? 'text-[hsl(38_92%_50%)]' : 'text-muted-foreground'}`}>
                    第 {i + 1} 条，起点第 {t.startBeat} 拍，贴合 {fit}%{t.weak ? '，已按第 0 拍' : shaky ? '，位置可能不唯一' : ''}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-0.5">
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" aria-label="重新对齐" onClick={() => realign(t)}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" aria-label={t.muted ? '取消静音' : '静音'} onClick={() => updateTake(t.id, { muted: !t.muted })}>
                      {t.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" aria-label="编辑波形" disabled={!t.buffer} onClick={() => setEditingId(t.id)}>
                      <PencilLine className="h-3.5 w-3.5" />
                    </Button>
                                        <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" aria-label="删除这条录音" onClick={() => removeTake(t.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                  {t.peak != null && <span>峰值 {Math.round(t.peak * 100)}%</span>}
                  {t.clipped > 100 && <span className="text-destructive">有削顶，建议离麦克风远一点重录</span>}
                  {t.weak && <span className="text-[hsl(38_92%_50%)]">自动对齐把握不大，先按第 0 拍播放</span>}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <Slider value={[t.offsetMs || 0]} min={-600} max={600} step={10} onValueChange={([v]) => updateTake(t.id, { offsetMs: v })} />
                  <span className="w-14 shrink-0 text-right text-[10px] tabular text-muted-foreground">
                    {(t.offsetMs || 0) > 0 ? '+' : ''}{t.offsetMs || 0} ms
                  </span>
                </div>
              </div>
            )
          })}

          {playing && (
            <div
              className="pointer-events-none absolute inset-y-0 z-10 w-px bg-brand"
              style={{ left: Math.min(100, (playBeat / totalBeats) * 100) + '%' }}
            />
          )}
          {takes.length > 1 && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              同声部默认只播放最新一条，旧录音可以在列表里手动打开。
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 rounded-xl border bg-card/70 px-3 py-2 backdrop-blur-sm">
        <Button
          size="sm"
          variant={playing ? 'destructive' : 'brand'}
          onClick={playing ? onStopPlay : onPlay}
          disabled={disabled || live === 0}
        >
          {playing ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {playing ? '停止' : '试听混音'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || takes.length === 0 || converting}
          onClick={() => {
            setConverting(true)
            // 让按钮的忙碌态先画出来，转录是同步计算，会占住主线程
            setTimeout(() => {
              try {
                onTranscribe()
              } finally {
                setConverting(false)
              }
            }, 30)
          }}
        >
          <FileMusic className="h-3.5 w-3.5" />
          {converting ? '转谱中' : '转成谱面'}
        </Button>
        <span className="truncate text-[10px] text-muted-foreground">
          {live === 0 && takes.length > 0
            ? '所有轨都静音了，先打开至少一条'
            : '每条轨按起始拍落在时间轴上，对不齐时拉滑杆微调'}
        </span>
      </div>
    </div>
  )
}
