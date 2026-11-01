import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TIMBRE_GROUPS } from '@/lib/cue'
import { scoreToMidi, downloadBlob, safeFileName, encodeWav } from '@/lib/export'
import { renderScore, normalize } from '@/lib/render'
import { encodeMp3, resample, MP3_RATES } from '@/lib/mp3'
import { scoreToMusicXML } from '@/lib/musicxml'
import { TempoMap } from '@/lib/tempo'

// 创作域的「导出」子页：音频（WAV / MP3）、乐谱（MusicXML）、工程交换（MIDI）。
// 渲染是纯本地的，不上传任何东西。
//
// 这里的「音频音色」只影响导出这一次渲染，不会改回设置里的音色。
// 导出时换个音色试听是常见需求，但不该顺手改掉练习用的音色。
export default function ExportPanel({ score, settings }) {
  const [busy, setBusy] = useState(null)      // 'wav' | 'midi' | 'xml' | null
  const [progress, setProgress] = useState(0)
  const [msg, setMsg] = useState(null)
  const [timbre, setTimbre] = useState(settings.timbre || 'choir')
  const [normalizeOut, setNormalizeOut] = useState(true)
  // 导出采样率。48000 是 Android 音频设备的原生值，44100 是 CD 标准。
  const [sampleRate, setSampleRate] = useState(44100)
  // MP3 码率（kbps）
  const [kbps, setKbps] = useState(192)

  const totalBeats = Math.max(
    0,
    ...score.parts.map((p) => p.notes.reduce((s, n) => s + n.beats, 0))
  )
  // 变速谱不能直接用"总拍 × 60 / bpm"：中段换了速度，实际时长和这个算法
  // 差很多（这份 79 小节的谱差 80 秒）。有速度表就按它算，和渲染结果一致。
  const seconds = Math.round(
    new TempoMap(score.tempos, score.bpm || 96, settings.playRate || 1).secAt(totalBeats)
  )

  // 渲染一次，供 WAV / MP3 共用。
  // 采样率由用户选，renderScore 直接按目标采样率跑离线渲染，
  // 不需要渲染完再重采样——那会多一次全量拷贝和一次精度损失。
  const renderOnce = async () => {
    const res = await renderScore(score, {
      timbre,
      volume: settings.vol,
      fx: settings.fx,
      rate: settings.playRate || 1,
      sampleRate,
      onProgress: (p) => setProgress((prev) => Math.max(prev, p * 0.1)),
    })
    const chans = [res.left, res.right]
    if (normalizeOut) normalize(chans)
    return { res, chans }
  }

  const exportWav = async () => {
    setBusy('wav')
    setMsg(null)
    setProgress(0)
    // OfflineAudioContext 渲染期间拿不到进度回调，只能按预计耗时平滑推进。
    // 实测大约每秒音频需要 0.06 秒渲染（含采样解码），这里按 0.1 估，
    // 到 92% 就停住，等真正渲染完再跳到 100%。
    const estimateMs = Math.max(600, seconds * 1000 * 0.1)
    const t0 = performance.now()
    const timer = setInterval(() => {
      const p = Math.min(0.92, ((performance.now() - t0) / estimateMs) * 0.92)
      setProgress((prev) => Math.max(prev, p))
    }, 120)
    try {
      const { res, chans } = await renderOnce()
      clearInterval(timer)
      setProgress(1)
      const wav = encodeWav(chans, res.sampleRate)
      downloadBlob(safeFileName(score.title + '-音频', 'wav'), new Blob([wav], { type: 'audio/wav' }))
      setMsg(`已导出 ${seconds} 秒的 WAV（${(res.sampleRate / 1000).toFixed(1)} kHz / ${(wav.length / 1048576).toFixed(1)} MB）`)
    } catch (e) {
      setMsg('导出失败：' + (e.message || e))
    } finally {
      clearInterval(timer)
      setBusy(null)
      setProgress(0)
    }
  }

  const exportMp3 = async () => {
    setBusy('mp3')
    setMsg(null)
    setProgress(0)
    const estimateMs = Math.max(600, seconds * 1000 * 0.1)
    const t0 = performance.now()
    const timer = setInterval(() => {
      const p = Math.min(0.9, ((performance.now() - t0) / estimateMs) * 0.9)
      setProgress((prev) => Math.max(prev, p))
    }, 120)
    try {
      const { res, chans } = await renderOnce()
      // MP3 只支持固定采样率档位，选的值必须在列表里
      let outChans = chans
      if (res.sampleRate !== sampleRate) {
        outChans = resample(chans, res.sampleRate, sampleRate)
      }
      setProgress(0.95)
      const mp3 = await encodeMp3(outChans, sampleRate, kbps)
      clearInterval(timer)
      setProgress(1)
      downloadBlob(safeFileName(score.title + '-音频', 'mp3'), new Blob([mp3], { type: 'audio/mpeg' }))
      setMsg(`已导出 MP3（${Math.round(kbps)} kbps / ${(sampleRate / 1000).toFixed(1)} kHz，${(mp3.length / 1048576).toFixed(1)} MB）`)
    } catch (e) {
      setMsg('导出失败：' + (e.message || e))
    } finally {
      clearInterval(timer)
      setBusy(null)
      setProgress(0)
    }
  }

  const exportXml = () => {
    setBusy('xml')
    try {
      // 导入的谱带原始 XML，直接用；否则按内部格式生成
      const xml = score._xml || scoreToMusicXML(score)
      downloadBlob(safeFileName(score.title, 'musicxml'), new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }))
      setMsg('已导出 MusicXML')
    } catch (e) {
      setMsg('导出失败：' + (e.message || e))
    } finally {
      setBusy(null)
    }
  }

  const exportMidi = () => {
    setBusy('midi')
    try {
      // 音色 → GM program 号，DAW 打开时直接用对应乐器
      const GM = {
        piano: 0, harpsichord: 6, celesta: 8, organ: 19, rockOrgan: 18,
        choir: 52, voiceO: 53, soloVoice: 54,
        strings: 48, violin: 40, cello: 42, contrabass: 43, harp: 46,
        flute: 73, clarinet: 71, oboe: 68, recorder: 74,
        trumpet: 56, trombone: 57, tuba: 58, frenchHorn: 60,
        marimba: 12, vibraphone: 11, xylophone: 13, glockenspiel: 9, kalimba: 108,
        sine: 80,
      }
      const bytes = scoreToMidi(score, { program: GM[timbre] ?? 0 })
      downloadBlob(safeFileName(score.title, 'mid'), new Blob([bytes], { type: 'audio/midi' }))
      setMsg('已导出 MIDI（每个声部一个 track）')
    } catch (e) {
      setMsg('导出失败：' + (e.message || e))
    } finally {
      setBusy(null)
    }
  }

  const disabled = busy != null

  return (
    <div className="space-y-2.5 px-4 pb-8 pt-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        当前谱面：{score.parts.length} 个声部、约 {seconds} 秒。全部在本机渲染，不上传。
      </p>

      <div className="space-y-1">
        <Label>音频音色</Label>
        <Select value={timbre} onValueChange={setTimbre} disabled={disabled}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMBRE_GROUPS.map((g) => (
              <SelectGroup key={g.id}>
                <SelectLabel>{g.name}</SelectLabel>
                {g.items.map(([k, n]) => (
                  <SelectItem key={k} value={k}>{n}</SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          只影响这次导出。练习用的音色在跟谱页调。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label>采样率</Label>
          <Select value={String(sampleRate)} onValueChange={(v) => setSampleRate(Number(v))} disabled={disabled}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="44100">44.1 kHz（CD）</SelectItem>
              <SelectItem value="48000">48 kHz（设备原生）</SelectItem>
              <SelectItem value="32000">32 kHz（省空间）</SelectItem>
              <SelectItem value="22050">22.05 kHz（只做参考）</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>MP3 码率</Label>
          <Select value={String(kbps)} onValueChange={(v) => setKbps(Number(v))} disabled={disabled}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="128">128 kbps</SelectItem>
              <SelectItem value="192">192 kbps</SelectItem>
              <SelectItem value="256">256 kbps</SelectItem>
              <SelectItem value="320">320 kbps</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={normalizeOut}
          onChange={(e) => setNormalizeOut(e.target.checked)}
          disabled={disabled}
          className="h-3.5 w-3.5 accent-brand"
        />
        导出前把峰值归一化到 -1 dB（推荐，避免削顶）
      </label>

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" disabled={disabled} onClick={exportWav}>
          {busy === 'wav' ? `渲染中 ${Math.round(progress * 100)}%` : '导出 WAV'}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={exportMp3}>
          {busy === 'mp3' ? `编码中 ${Math.round(progress * 100)}%` : '导出 MP3'}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={exportXml}>
          导出 MusicXML
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={exportMidi}>
          导出 MIDI
        </Button>
      </div>

      {busy === 'wav' && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
          <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {msg && <p className="text-[11px] text-muted-foreground">{msg}</p>}
    </div>
  )
}
