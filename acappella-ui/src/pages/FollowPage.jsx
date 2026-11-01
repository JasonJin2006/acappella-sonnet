import { Suspense, lazy, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { ListMusic, Mic, Music2, Music4, PencilLine, Play, Redo2, SlidersHorizontal, Square, Undo2, Volume2 } from 'lucide-react'
import { midiToName } from '@/lib/music'
import TimbreSelect from '@/components/TimbreSelect'

const ScoreView = lazy(() => import('@/components/ScoreView'))

// 声部短名：用于混音器和定音列表里的窄按钮。
//
// 不能简单取名字的最后一段：导入的谱叫「Soprano 1」「Bass 2」，
// 取末段会得到 "1" "2"，混音器上就变成 1 2 1 2 —— 认不出是哪个声部。
//
// 优先级：名字里的中文（「Tenor 男高」→「男高」）> 声部 id > 名字首段。
// 中文最直观，id（S1/A2/T/B1）足够短且唯一，最后才退回英文首词。
const ZH_IN_NAME = /[\u4e00-\u9fa5]+/
const shortName = (part) => {
  if (!part) return ''
  const name = part.name || ''
  const zh = name.match(ZH_IN_NAME)
  // id 和中文名都缺失时才用英文，避免把「Soprano 1」显示成 "1"
  if (zh) {
    // 名字里带编号就保留（「Tenor 1 男高」→「男高1」），否则并列声部重名
    const num = (name.match(/\d+/) || [''])[0]
    return zh[0] + num
  }
  if (part.id) return part.id
  return name.split(/\s+/)[0] || ''
}

// 跟谱页：声部切换在顶部，谱面占满，左下角气泡 + 右下角麦克风。
export default function FollowPage({
  parts, myPart, onPart, xml, theme, running, onToggle, onTune, droneOn, onDrone, onSeek, onNudge, startBeat, onDynamics, onEdit, playRate, onPlayRate, onChordTrack,
  onUndo, onRedo, canUndo, canRedo,
  playing, onPlay, playFillRef, playLabelRef,
  scoreRef, noteRef, beatRef, nextRef, centsRef, needleRef, partDotRefs, cardOpen,
  timbre, onTimbre, vol, onVol, onAudition, scoreRange,
  partVols, onPartVol, metroOn, onMetro,
}) {
  const [tuneOpen, setTuneOpen] = useState(false)
  const [audioOpen, setAudioOpen] = useState(false)
  const firsts = parts.map((p) => {
    const n = (p.notes || []).find((x) => x.midi != null)
    return n ? n.midi : null
  })
  return (
    <div className="relative flex h-full flex-col">
      {/* 工具按钮一行。
          声部选择已经挪到谱面左侧、贴着各自那条五线谱（见 ScoreView），
          因为顶部一排胶囊和谱线对不上号——6/8 声部时分不清哪个对应哪行。
          这里只留编辑类按钮。
          用 .scroll-x-pad 而不是 px-3：横向滚动容器上的右内边距会被裁掉，
          实测「定音」按钮贴到右边缘；这个类同时补内边距和渐隐提示。 */}
      <div className="scroll-x-pad flex shrink-0 items-center gap-1.5 overflow-x-auto py-2">
        <button
          onClick={() => onUndo && onUndo()}
          disabled={!canUndo}
          aria-label="撤销"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors active:bg-secondary disabled:opacity-30"
        >
          <Undo2 className="h-3 w-3" />
        </button>
        <button
          onClick={() => onRedo && onRedo()}
          disabled={!canRedo}
          aria-label="重做"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors active:bg-secondary disabled:opacity-30"
        >
          <Redo2 className="h-3 w-3" />
        </button>
        <button
          onClick={() => onChordTrack && onChordTrack()}
          className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors active:bg-secondary"
          aria-label="和弦轨"
        >
          <ListMusic className="h-3 w-3" />
          和弦
        </button>
        <button
          onClick={() => onEdit && onEdit()}
          className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors active:bg-secondary"
          aria-label="编辑音符"
        >
          <PencilLine className="h-3 w-3" />
          编辑
        </button>
        <button
          onClick={() => setTuneOpen((v) => !v)}
          className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[10px] transition-colors ${
            tuneOpen ? 'border-brand bg-brand/15 text-foreground' : 'border-border text-muted-foreground'
          }`}
          aria-label="定音"
        >
          <Music2 className="h-3 w-3" />
          定音
        </button>
      </div>

      {playing && (
        <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5">
          <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-secondary">
            <div ref={playFillRef} className="h-full rounded-full bg-brand" style={{ width: '0%' }} />
          </div>
          <span ref={playLabelRef} className="shrink-0 text-[10px] tabular text-muted-foreground">
            第 1 / 1 小节
          </span>
        </div>
      )}

      {tuneOpen && (
        <div className="absolute inset-x-3 top-[52px] z-40 rounded-xl border bg-card p-2 shadow-xl">
          <div className="px-1 pb-1 text-[10px] text-muted-foreground">
            各声部起始音，点一行单独听
          </div>
          {parts.map((p, i) => (
            <button
              key={p.id + i}
              onClick={() => onTune(i)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-secondary"
            >
              <span className="w-6 text-[11px] font-medium">{p.id}</span>
              <span className="text-[10px] text-muted-foreground">{shortName(p)}</span>
              <span className="ml-auto text-[13px] font-medium tabular">
                {firsts[i] == null ? '—' : midiToName(firsts[i])}
              </span>
              <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          ))}
          <button
            onClick={() => onDrone(!droneOn)}
            className={`mt-1 flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors ${
              droneOn ? 'border-brand bg-brand/10 text-foreground' : 'border-input text-muted-foreground'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${droneOn ? 'bg-brand' : 'bg-muted-foreground/40'}`} />
            {droneOn ? '停止持续低音' : '持续低音'}
            <span className="ml-auto text-[10px] opacity-70">{droneOn ? '正在响' : '低音声部的第一个音'}</span>
          </button>
          <div className="mt-1 flex gap-1.5">
            <Button size="sm" className="flex-1" onClick={() => onTune('seq')}>
              依次播放
            </Button>
            <Button size="sm" variant="outline" className="flex-1" onClick={() => onTune('all')}>
              一起播放
            </Button>
          </div>

          {/* 力度：点一下把整首谱面所有声部设成这个强弱。
              逐个音编辑在文本记谱里做（C4 1 mf），这里给的是常用的一键操作。 */}
          <div className="mt-2 border-t pt-2">
            <div className="px-1 pb-1 text-[10px] text-muted-foreground">整首力度</div>
            <div className="flex flex-wrap gap-1">
              {[
                ['pp', '很轻'],
                ['p', '轻'],
                ['mp', '中轻'],
                ['mf', '中'],
                ['f', '强'],
                ['ff', '很强'],
              ].map(([mark, label]) => (
                <button
                  key={mark}
                  type="button"
                  onClick={() => onDynamics && onDynamics(mark)}
                  className="rounded border border-input px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-secondary active:bg-secondary"
                  aria-label={`整首力度 ${label}`}
                >
                  <span className="font-medium text-foreground">{mark}</span>
                  <span className="ml-1 opacity-70">{label}</span>
                </button>
              ))}
            </div>
            <p className="mt-1 px-1 text-[10px] leading-relaxed text-muted-foreground">
              逐音力度在「导入或手写谱面」的文本里写：<span className="font-mono">C4 1 mf</span>
            </p>
          </div>

          {/* 变速不变调：练慢速时把整谱放慢，音高不变 */}
          <div className="mt-2 border-t pt-2">
            <div className="flex items-center justify-between px-1 pb-1">
              <span className="text-[10px] text-muted-foreground">播放速度</span>
              <span className="text-[10px] tabular text-muted-foreground">{Math.round((playRate || 1) * 100)}%</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {[
                [0.5, '50%'],
                [0.65, '65%'],
                [0.8, '80%'],
                [1, '原速'],
                [1.25, '125%'],
                [1.5, '150%'],
              ].map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => onPlayRate && onPlayRate(v)}
                  className={`rounded border px-2 py-1 text-[10px] transition-colors ${
                    Math.abs((playRate || 1) - v) < 0.01
                      ? 'border-brand bg-brand/15 text-foreground'
                      : 'border-input text-muted-foreground hover:bg-secondary'
                  }`}
                  aria-label={`播放速度 ${label}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1 px-1 text-[10px] leading-relaxed text-muted-foreground">
              变速不变调。慢速练习时音高保持原样，导出 WAV 也跟着这个速度。
            </p>
          </div>
        </div>
      )}

      {/* 底部留出 132px 给气泡、播放键和麦克风，谱面不会钻到控件底下。
          原来留 150px，去掉右侧调节按钮后可以收紧一档，多给谱面一点高度。 */}
      <div className="relative min-h-0 flex-1 pb-[132px]">
        <Suspense fallback={<div className="mx-4 h-full rounded-lg border bg-card/40" />}>
          <ScoreView ref={scoreRef} xml={xml} theme={theme} myPart={myPart} parts={parts} onPart={onPart} startBeat={startBeat} onSeek={onSeek} />
        </Suspense>
      </div>

      {/* 空态收成小圆泡，唱起来向上展开；内容钉在底部，动画不会抖。
          展开宽度 160 而不是 172：右边要留出音色按钮的位置，
          172 撑到 184 之后只剩 53px，塞不下 48px 的按钮（实测会压到
          播放键）。针尖条同步从 132 收窄到 120 才放得下。 */}
      <div
        className="pointer-events-none absolute bottom-4 left-3 z-20 overflow-hidden border bg-card/70 backdrop-blur-sm transition-[width,height,border-radius] duration-300 ease-out"
        style={{
          width: cardOpen ? 160 : 48,
          height: cardOpen ? 138 : 48,
          borderRadius: cardOpen ? 14 : 24,
        }}
      >
        <span
          className="absolute inset-0 flex items-center justify-center transition-opacity duration-200"
          style={{ opacity: cardOpen ? 0 : 1 }}
        >
          <Music4 className={`h-4 w-4 ${running ? 'text-brand' : 'text-muted-foreground/60'}`} />
        </span>

        <div
          className="absolute bottom-0 left-0 w-[160px] px-4 pb-3 transition-opacity duration-200"
          style={{ opacity: cardOpen ? 1 : 0, transitionDelay: cardOpen ? '120ms' : '0ms' }}
        >
          <div
            ref={noteRef}
            className="text-[46px] font-semibold leading-none tracking-tight tabular"
            style={{ color: 'hsl(var(--muted-foreground) / .35)' }}
          >
            —
          </div>
          <div ref={beatRef} className="mt-1.5 text-[11px] text-muted-foreground tabular">—</div>
          <div className="relative mt-2.5 h-[5px] w-[120px] rounded-full bg-secondary">
            <span className="absolute left-1/2 top-0 h-full w-px bg-background/70" />
            <span
              ref={needleRef}
              className="needle absolute top-0 h-full w-[3px] -translate-x-1/2 rounded-full"
              style={{ left: '50%', background: 'hsl(var(--muted-foreground))', opacity: 0.25 }}
            />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 text-[11px]">
            <span ref={centsRef} className="tabular text-muted-foreground">—</span>
            <span className="text-muted-foreground">
              下一个 <span ref={nextRef} className="font-medium text-foreground tabular">—</span>
            </span>
          </div>
        </div>
      </div>

      {/* 音色与音量：跟唱和播放共用这一套，放在离耳朵最近的地方随手可调。
          位置跟着气泡走：收起时气泡只有 48 宽，按钮落在 68；
          展开时气泡 160 宽（右沿 172），按钮被推到 184 让开，
          缩小时再滑回 68。和气泡一样用 300ms 缓动，看起来是被"推"开的。 */}
      <button
        className={`absolute bottom-4 z-30 flex h-12 w-12 items-center justify-center rounded-full border shadow-lg backdrop-blur-sm transition-[left,color,border-color,background-color] duration-300 ease-out ${
          audioOpen ? 'border-brand bg-brand/15 text-brand' : 'border-border bg-card/85 text-muted-foreground'
        }`}
        style={{ left: cardOpen ? 184 : 68 }}
        onClick={() => setAudioOpen((v) => !v)}
        aria-label="音色与音量"
        aria-expanded={audioOpen}
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>

      {audioOpen && (
        <div
          className="absolute bottom-[76px] z-40 max-h-[58vh] space-y-3 overflow-y-auto rounded-xl border bg-card/95 p-3 shadow-xl backdrop-blur-sm"
          // 弹层贴左、从气泡上沿再往上长：气泡展开时占 12~172 × 582~720，
          // 弹层底边放在 660（= 屏幕高 - 底部 12 - 气泡高 138 - 间距 6），
          // 不盖住正在看的音符大字。收起时气泡只有 48 高，可以矮一些。
          style={{
            left: 12,
            width: 272,
            maxWidth: 'calc(100vw - 24px)',
            bottom: cardOpen ? 168 : 78,
          }}
        >
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">音色</span>
              <button
                type="button"
                onClick={() => onAudition && onAudition(timbre)}
                className="text-[10px] text-brand underline-offset-2 active:underline"
              >
                试听
              </button>
            </div>
            <TimbreSelect
              value={timbre || 'choir'}
              onChange={(v) => onTimbre && onTimbre(v)}
              range={scoreRange}
            />
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              跟唱提示音和整谱播放共用这个音色。
            </p>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">音量</span>
              <span className="text-[11px] tabular text-muted-foreground">{Math.round((vol || 0) * 100)}%</span>
            </div>
            <Slider
              value={[Math.round((vol || 0) * 100)]}
              min={0}
              max={100}
              step={5}
              onValueChange={([v]) => onVol && onVol(v / 100)}
            />
          </div>

          {/* 混音器：每个声部单独的音量和静音。
              练唱时通常只想压低别的声部、听自己这条线，之前只能整首一起听。 */}
          {parts.length > 1 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">混音器</span>
                <button
                  type="button"
                  onClick={() => onPartVol && onPartVol(null)}
                  className="text-[10px] text-brand underline-offset-2 active:underline"
                >
                  全部还原
                </button>
              </div>
              <div className="space-y-1.5">
                {parts.map((p, i) => {
                  const v = partVols && partVols[i] != null ? partVols[i] : 1
                  const muted = v <= 0.001
                  return (
                    <div key={p.id || i} className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-label={`${muted ? '取消静音' : '静音'} ${shortName(p)}`}
                        onClick={() => onPartVol && onPartVol(i, muted ? 1 : 0)}
                        className={`flex h-6 w-8 shrink-0 items-center justify-center rounded-md border text-[10px] ${
                          muted ? 'border-brand bg-brand/20 text-brand' : 'border-border bg-secondary/40 text-muted-foreground'
                        }`}
                      >
                        {shortName(p)}
                      </button>
                      <Slider
                        value={[Math.round(v * 100)]}
                        min={0}
                        max={100}
                        step={5}
                        onValueChange={([nv]) => onPartVol && onPartVol(i, nv / 100)}
                      />
                      <span className="w-8 shrink-0 text-right text-[10px] tabular text-muted-foreground">
                        {muted ? '静音' : `${Math.round(v * 100)}`}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => onMetro && onMetro(!metroOn)}
            className={`flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-[11px] ${
              metroOn ? 'border-brand bg-brand/10 text-brand' : 'border-border bg-secondary/30 text-muted-foreground'
            }`}
          >
            <span>节拍器</span>
            <span>{metroOn ? '开' : '关'}</span>
          </button>
        </div>
      )}

      {/* 播放整首：不碰麦克风，纯粹听谱面。
          底部四个控件（气泡 / 音色 / 播放 / 麦克风）统一 48×48、底边 16px，
          原来气泡 48 底边 720、音色 48 底边 720、播放 48 底边 712、
          麦克风 56 底边 716，四种尺寸四种底边，看着就是不齐。
          间距 8px：60 | 68 | 124 | 180 … 排列，右边两个用 right 定位保持贴边。 */}
      <Button
        className="absolute bottom-4 right-[76px] z-30 h-12 w-12 rounded-full border bg-card/85 p-0 shadow-lg backdrop-blur-sm"
        size="icon"
        variant="outline"
        onClick={onPlay}
        aria-label={playing ? '停止播放' : '播放整首'}
      >
        {playing ? <Square className="h-4 w-4" /> : <Play className="ml-0.5 h-5 w-5" />}
      </Button>

      <Button
        className="absolute bottom-4 right-4 z-30 h-12 w-12 rounded-full p-0 shadow-lg"
        size="icon"
        variant={running ? 'destructive' : 'brand'}
        onClick={onToggle}
        aria-label={running ? '停止' : '开始跟随'}
      >
        {running ? <Square className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
      </Button>
    </div>
  )
}
