import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Upload, FileMusic, Package, FolderOpen, RefreshCw, Loader2 } from 'lucide-react'
import { DEMOS, parseTextScore, readScoreFile, midiToName } from '@/lib/music'
import { omrConvert, omrHealth, omrCheckFile } from '@/lib/omr'
import { parsePack, isScoreFile } from '@/lib/pack'
import {
  arrange,
  defaultPlan,
  measureCount,
  rankKeys,
  keyName,
  TEXTURES,
  textureName,
  VOICINGS,
  voicingOf,
} from '@/lib/arranger'

// 内部谱面 → 文本记谱。力度只有非默认值才写出来，
// 否则每个音都挂一个 mf，文本会变得很难读。
const VEL_NAME = [[0.2, 'ppp'], [0.28, 'pp'], [0.4, 'p'], [0.51, 'mp'], [0.64, 'mf'], [0.77, 'f'], [0.88, 'ff'], [1.0, 'fff']]
function velToMark(vel) {
  if (vel == null) return ''
  // 找最接近的力度档位；和默认 mf（0.58）差不到 0.02 就当没写
  let best = 'mf'
  let bd = Infinity
  for (const [v, n] of VEL_NAME) {
    const d = Math.abs(v - vel)
    if (d < bd) { bd = d; best = n }
  }
  return Math.abs(vel - 0.58) < 0.02 ? '' : best
}

function scoreToText(sc) {
  const L = ['bpm ' + sc.bpm, 'bar ' + sc.bar, 'title ' + sc.title]
  for (const p of sc.parts) {
    L.push(p.id + ': ' + p.notes.map((n) => {
      const head = n.midi == null ? 'r' : midiToName(n.midi)
      const mark = velToMark(n.vel)
      return head + ' ' + n.beats + (mark ? ' ' + mark : '')
    }).join(' '))
  }
  return L.join('\n')
}

// ---- OMR 进度显示 ----
// omr.js 把服务端 phase（"recognise 4/24" 之类）翻成结构化字段；
// 老服务器没有这些字段，就退回「已等 N 秒」的简单提示。

const RECOGNISE_RE = /^recognise\s+(\d+)\s*\/\s*(\d+)$/i

function fmtDuration(ms) {
  const n = Number(ms)
  const s = Number.isFinite(n) ? Math.max(0, Math.round(n / 1000)) : 0
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分钟`
}

function fmtEta(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return ''
  const s = Math.max(0, Math.round(Number(ms) / 1000))
  if (s < 15) return '马上就好'
  return `约 ${fmtDuration(ms)}`
}

function fmtUploadMB(loaded, total) {
  const mb = (n) => (Number(n) / (1024 * 1024)).toFixed(1)
  if (!Number.isFinite(Number(loaded)) || !Number.isFinite(Number(total)) || Number(total) <= 0) return ''
  return `${mb(loaded)} / ${mb(total)} MB`
}

/**
 * 服务端 warnings 里混着两类：被跳过的页（无谱面 / 引擎报错），以及格式提醒
 * （小节时值不对之类）。只有「页被跳过」必须大声说出来，其余会淹没提示。
 * 老服务器没有这个字段，传进来空数组，这里全部返回空。
 */
function humanizePageWarning(w) {
  const s = typeof w === 'string' ? w.trim() : ''
  if (!s) return ''
  const m = s.match(/第\s*(\d+)\s*页[^。]*?跳过/)
  if (!m) return ''
  const page = m[1]
  if (/无谱面|no music/i.test(s)) return `第 ${page} 页没有谱面，已跳过`
  if (/引擎内部|NullPointer|Error processing|引擎|internal/i.test(s)) {
    return `第 ${page} 页识别失败已跳过（引擎内部错误），其余页已保留`
  }
  return `第 ${page} 页已跳过`
}

/** 0 附近的值没有信息量，画成不确定态，避免一条「卡在 0%」的死条。 */
function barProgress(v) {
  return v != null && Number.isFinite(Number(v)) && Number(v) > 0.001 ? Number(v) : null
}

/** 把一次 onProgress 回调翻译成进度文案和进度条。 */
function progressView(p, startedAt) {
  const elapsed = p.elapsedMs != null ? p.elapsedMs : Date.now() - startedAt
  const waited = `已等 ${fmtDuration(elapsed)}`
  const eta = fmtEta(p.etaMs)
  // 「马上就好」本身已经是完整短语，不能再套「约 / 预计还要」。
  const etaChip = eta ? (eta === '马上就好' ? eta : `预计 ${eta.replace(/^约\s*/, '')}`) : ''

  if (p.phase === 'upload') {
    const pct = p.ratio != null ? Math.round(p.ratio * 100) : null
    const chips = [waited]
    if (p.total) chips.push(fmtUploadMB(p.loaded, p.total) || '')
    return {
      label: pct == null ? '上传 PDF' : `上传 PDF ${pct}%`,
      text: pct == null
        ? '上传 PDF 中…'
        : pct >= 100
          ? '上传完成，正在交给服务器…'
          : `上传 PDF ${pct}%`,
      // 进度条按「当前阶段」显示：上传阶段就是文件传输百分比；传完进入排队后
      // 归零重新表示识别进度，下面的 hint 会说明这一点。
      progress: p.ratio == null ? null : p.ratio,
      indeterminate: p.ratio == null,
      hint: '进度条这里是文件上传百分比；传完后归零，重新表示识别进度',
      chips: chips.filter(Boolean),
      legacy: false,
    }
  }

  if (p.phase === 'retry') {
    const bar = barProgress(p.progress)
    return {
      label: '自动重试中',
      text: `${p.reason || '网络连接中断'}，第 ${p.attempt}/${p.maxAttempts} 次重试…`,
      progress: bar,
      indeterminate: bar == null,
      hint: '任务还在服务器上（保留 1 小时），不用重新上传',
      chips: [waited, `${p.reason || '网络中断'}`],
      legacy: false,
    }
  }

  if (p.phase === 'queued') {
    const pos = p.position
    const front = pos && pos > 1 ? `前面还有 ${pos - 1} 个任务` : '下一个就轮到'
    const chips = [pos && pos > 0 ? `第 ${pos} 位` : '', etaChip, waited]
    // 排队时的 progress 恒为 0，画成「动着的等待条」比一条卡在 0% 的死条诚实；
    // 真正的信息是位次和等待时长，已经写在文字里。
    const bar = barProgress(p.progress)
    return {
      label: '排队中',
      text: `排队中，${front}${eta ? `，${eta}` : ''}`,
      progress: bar,
      indeterminate: bar == null,
      hint: p.hasDetail
        ? `服务器一次只识别一份；${waited}。轮到后会自动开始，不用守着`
        : `服务器一次只识别一份；${waited}。旧版服务不报进度，轮到时会自动开始`,
      chips: chips.filter(Boolean),
      legacy: !p.hasDetail,
    }
  }

  if (p.phase === 'download') {
    return {
      label: '下载谱面',
      text: '识别完成，正在下载谱面…',
      progress: 0.95,
      indeterminate: false,
      hint: '马上就能载入编辑',
      chips: [waited],
      legacy: false,
    }
  }

  if (p.phase === 'done') {
    return {
      label: '识别完成',
      text: '识别完成，正在解析谱面…',
      progress: 1,
      indeterminate: false,
      hint: '',
      chips: [waited],
      legacy: false,
    }
  }

  if (p.phase === 'running' || p.serverPhase || p.progress != null) {
    const m = RECOGNISE_RE.exec(p.serverPhase || '')
    const done = m ? Number(m[1]) : p.page
    const total = m ? Number(m[2]) : p.pageCount
    // 0/8 的时候还没完成任何一页，不要显示「第 0/8 页」这种别扭的说法。
    const pageText = done != null && total && done > 0 ? `第 ${done}/${total} 页` : ''
    const sp = p.serverPhase || ''
    let stage
    let label
    if (/^(export|parse)\b/i.test(sp)) {
      stage = '谱面整理和导出'
      label = '正在整理谱面'
    } else if (/^preflight\b/i.test(sp)) {
      stage = '正在准备识别（清点页数、检查版面，第一页最慢）'
      label = '准备识别'
    } else if (m && done === 0) {
      stage = '正在准备识别（第一页最慢）'
      label = total ? `识别 0/${total}` : '准备识别'
    } else if (m) {
      stage = `正在识别${pageText ? ' ' + pageText : ''}`
      label = `识别 ${done}/${total}`
    } else {
      stage = '正在识别'
      label = '识别中'
    }
    // 老服务只有 status=running，没有 phase/progress/pages：明确标出「无进度」，
    // 而不是让用户对着一个看起来卡在 0% 的条。
    const legacy = !sp && p.progress == null && p.pageCount == null && p.page == null
    if (legacy) label = '识别中（旧版服务）'
    const bar = barProgress(p.progress)
    const chips = [
      pageText,
      etaChip,
      p.progress != null ? `${Math.round(p.progress * 100)}%` : '',
      waited,
    ]
    return {
      label,
      text: `${stage}${eta ? `，${eta}` : `，${waited}`}`,
      progress: bar,
      indeterminate: bar == null,
      hint: eta
        ? `${waited}；多页谱要逐页处理，可以先去别的页面`
        : legacy
          ? '旧版识别服务不报页数和进度，只能显示已等时长'
          : '多页谱要逐页处理，可能要几分钟',
      chips: chips.filter(Boolean),
      legacy,
    }
  }

  // 老服务器只有 status=running，没有 phase/progress：保持原来的诚实文案。
  return {
    label: '识别中（旧版服务）',
    text: `识别中，${waited}（多页谱要逐页处理，可能要几分钟）…`,
    progress: null,
    indeterminate: true,
    hint: '旧版识别服务不报页数和进度，只能显示已等时长',
    chips: [waited],
    legacy: true,
  }
}

export default function ScorePanel({ score, onLoad, onImported, onImportedMany, className, chordTrack, textureTrack }) {
  const [text, setText] = useState(() => (score ? scoreToText(score) : ''))
  const [msg, setMsg] = useState(null)
  const [plan, setPlan] = useState(null)
  const [brush, setBrush] = useState('block')
  const [busy, setBusy] = useState(false)
  const [omr, setOmr] = useState(null)      // { label, text, progress, indeterminate, hint, chips, legacy }
  const fileRef = useRef(null)
  const packRef = useRef(null)
  const dirRef = useRef(null)
  const omrAbortRef = useRef(null)

  const apply = async (sc, note, save) => {
    if (save && onImported) {
      try {
        await onImported(sc)
      } catch (err) {
        // 存不进去不影响这次使用，下次再导入还会重新尝试
        console.warn('保存到我的谱失败：', err)
      }
    }
    onLoad(sc)
    setText(scoreToText(sc))
    setMsg(note ? { ok: true, text: note } : { ok: true, text: sc.title })
  }

  const tick = () => new Promise((r) => setTimeout(r, 0))

  const saveMany = async (list) => {
    if (!list.length) return
    if (onImportedMany) {
      await onImportedMany(list)
      return
    }
    for (const sc of list) if (onImported) await onImported(sc)
  }

  const importFiles = async (files) => {
    const list = files.filter((f) => isScoreFile(f.name))
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name)).length
    if (!list.length) {
      setMsg({
        ok: false,
        text: pdfs
          ? `选中了 ${pdfs} 个 PDF。多选时 PDF 会被跳过，请一次选一个 PDF 让它走服务器识别`
          : '没有找到 .xml / .musicxml / .mxl 文件',
      })
      return
    }
    setBusy(true)
    const ok = []
    let fail = 0
    let lastErr = ''
    for (let i = 0; i < list.length; i++) {
      setMsg({ ok: true, text: `解析 ${i + 1}/${list.length}　${list[i].name}` })
      try {
        ok.push(await readScoreFile(list[i]))
      } catch (err) {
        fail++
        lastErr = err.message
      }
      // 每几个文件让出一次主线程，进度才刷得出来
      if (i % 4 === 3) await tick()
    }
    try {
      await saveMany(ok)
      if (!ok.length) {
        setMsg({ ok: false, text: '没有一个文件读懂：' + lastErr })
      } else {
        const tail = [
          fail ? `${fail} 个没读懂（${lastErr}）` : '',
          pdfs ? `${pdfs} 个 PDF 跳过，请一次选一个 PDF 单独识别` : '',
        ].filter(Boolean).join('，')
        setMsg({ ok: !fail, text: `已导入 ${ok.length} 首${tail ? '，' + tail : ''}` })
      }
    } catch (err) {
      setMsg({ ok: false, text: '写入我的谱失败：' + err.message })
    }
    setBusy(false)
  }

  const onFile = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    if (files.length === 1) {
      // PDF 走服务器 OMR：PDF 本身没有音符数据，要先识别成 MusicXML
      if (/\.pdf$/i.test(files[0].name)) return convertPdf(files[0])
      setMsg({ ok: true, text: '解析中…' })
      try {
        const sc = await readScoreFile(files[0])
        await apply(sc, `已载入 ${sc.title}，${sc.parts.length} 个声部，${sc.bpm} BPM`, true)
      } catch (err) {
        setMsg({ ok: false, text: err.message })
      }
      return
    }
    await importFiles(files)
  }

  // 把 PDF 交给服务器上的 Audiveris 识别，再按普通 MusicXML 载入。
  // 服务在公网上（见 lib/omr.js），手机不需要连电脑。
  const convertPdf = async (file) => {
    setBusy(true)
    setOmr({ label: '上传 PDF', text: '检查文件…', progress: null, indeterminate: true, hint: '', chips: [], legacy: false })
    setMsg({ ok: true, text: '检查文件…' })

    // 控制器在本地检查和 /health 之前就建好，否则这段时间点「取消」没有反应。
    const ctl = typeof AbortController === 'function' ? new AbortController() : null
    omrAbortRef.current = ctl
    const aborted = () => !!(ctl && ctl.signal.aborted)
    const started = Date.now()
    try {
      // 先在本地挡掉超大/非 PDF，别为一次注定失败的请求花上传流量。
      try {
        await omrCheckFile(file)
      } catch (err) {
        setMsg({ ok: false, text: err.message })
        return
      }
      if (aborted()) {
        setMsg({ ok: true, text: '已取消识别' })
        return
      }

      setMsg({ ok: true, text: '连接识别服务…' })
      const health = await omrHealth()
      if (aborted()) {
        setMsg({ ok: true, text: '已取消识别' })
        return
      }
      if (!health.ok) {
        setMsg({
          ok: false,
          text: `没连上识别服务（${health.reason || '未知原因'}）。检查一下手机能不能上网。`,
        })
        return
      }

      const { xml, info } = await omrConvert(file, {
        signal: ctl ? ctl.signal : undefined,
        onProgress: (p) => {
          const v = progressView(p, started)
          setOmr(v)
          // 详细说明在进度卡里；底部状态栏只留一句简短状态，避免同一句话出现两遍。
          setMsg({ ok: true, text: v.label })
        },
      })
      const blob = new File([xml], file.name.replace(/\.pdf$/i, '.musicxml'), {
        type: 'application/vnd.recordare.musicxml+xml',
      })
      const sc = await readScoreFile(blob)
      const skipped = (Array.isArray(info.warnings) ? info.warnings : [])
        .map((w) => humanizePageWarning(w))
        .filter(Boolean)
      const warn = info.notes
        ? `识别 ${info.parts} 声部 / ${info.bars} 小节 / ${info.notes} 音，用了 ${info.seconds}s。识别会有错音，请对着原谱过一遍`
        : ''
      // 有页被跳过时必须说出来：否则用户以为整本都识别了，漏掉的一页只能靠自己对谱才发现。
      const skipNote = skipped.length ? `；${skipped.join('；')}` : ''
      await apply(sc, (warn || `已载入 ${sc.title}`) + skipNote, true)
    } catch (err) {
      if (err && err.name === 'AbortError') {
        setMsg({ ok: true, text: '已取消识别。任务可能还在服务器上排队（保留 1 小时）；重新上传会新建一个任务。' })
      } else {
        setMsg({ ok: false, text: err.message || '识别失败，请稍后再试' })
      }
    } finally {
      omrAbortRef.current = null
      setBusy(false)
      setOmr(null)
    }
  }

  const cancelOmr = () => {
    const ctl = omrAbortRef.current
    if (!ctl) return
    ctl.abort()
    setMsg({ ok: true, text: '正在取消…' })
  }

  const onPack = async (e) => {
    const f = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!f) return
    setBusy(true)
    setMsg({ ok: true, text: '读取导入包…' })
    try {
      const pack = parsePack(await f.text())
      setMsg({ ok: true, text: `写入 ${pack.songs.length} 首…` })
      await tick()
      await saveMany(pack.songs)
      const skipped = pack.skipped ? `，跳过 ${pack.skipped} 首（重复或数据不完整）` : ''
      setMsg({ ok: true, text: `已导入 ${pack.songs.length} 首${skipped}` })
    } catch (err) {
      setMsg({ ok: false, text: err.message })
    }
    setBusy(false)
  }

  // 打开编配：取第一个声部当主旋律，给出默认织体方案和三个候选调
  const openArrange = () => {
    try {
      const sc = parseTextScore(text)
      if (!sc.parts.length) throw new Error('没解析出声部')
      const melody = sc.parts[0].notes
      const n = measureCount(melody, sc.bar)
      setPlan({
        melody,
        bar: sc.bar,
        bpm: sc.bpm,
        title: sc.title,
        textures: defaultPlan(n, voicingOf('satb').roles.length),
        keys: rankKeys(melody).slice(0, 3),
        keyIdx: 0,
        voicing: 'satb',
      })
      setBrush('block')
      setMsg({ ok: true, text: '选一种织体当画笔，点小节涂上去' })
    } catch (err) {
      setMsg({ ok: false, text: err.message })
    }
  }

  const generate = async () => {
    try {
      const sc = parseTextScore(text)
      if (!sc.parts.length) throw new Error('没解析出声部')
      const melody = sc.parts[0].notes
      const n = measureCount(melody, sc.bar)
      if (n !== plan.textures.length) {
        // 文本被改过，小节数变了，原来的织体对不上，重开一次
        openArrange()
        setMsg({ ok: false, text: '小节数变了，重新涂一遍织体' })
        return
      }
      // 和弦轨 / 织体轨是「按小节的覆盖」：有值就用，空位交给自动推断。
      // 只传非空的部分，否则 arrange 会把 '' 当成有效值。
      const chordOverride = (chordTrack || []).some(Boolean) ? (chordTrack || []) : null
      const textureOverride = (textureTrack || []).some(Boolean)
        ? (textureTrack || []).map((v, i) => v || plan.textures[i])
        : plan.textures
      const res = arrange(melody, {
        bar: sc.bar,
        textures: textureOverride,
        chords: chordOverride,
        key: plan.keys[plan.keyIdx],
        voicing: plan.voicing,
      })
      const out = { title: sc.title, bpm: sc.bpm, bar: sc.bar, parts: res.parts }
      const vn = voicingOf(plan.voicing).name
      await apply(out, `已配成${vn}：${keyName(res.key)}，${plan.textures.length} 小节`, true)
      setPlan(null)
    } catch (err) {
      setMsg({ ok: false, text: err.message })
    }
  }

  const paint = (i) =>
    setPlan((p) => ({ ...p, dirty: true, textures: p.textures.map((t, k) => (k === i ? brush : t)) }))

  const hint = TEXTURES.find((t) => t.id === brush)?.hint || ''

  return (
    <Card className={`animate-slide-up ${className || 'mt-3'}`}>
      <CardContent className="space-y-2.5 p-3">
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" onClick={() => apply(structuredClone(DEMOS.demo1), null, false)}>
            卡农和声垫
          </Button>
          <Button variant="outline" size="sm" onClick={() => apply(structuredClone(DEMOS.demo2), null, false)}>
            欢乐颂
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            导入
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => packRef.current?.click()}>
            <Package className="h-3.5 w-3.5" />
            整包
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => dirRef.current?.click()}>
            <FolderOpen className="h-3.5 w-3.5" />
            文件夹
          </Button>
          <input ref={fileRef} type="file" accept=".xml,.musicxml,.mxl,.zip,.pdf" multiple hidden onChange={onFile} />
          <input ref={packRef} type="file" accept=".json,.sonnetpack" hidden onChange={onPack} />
          <input
            ref={dirRef}
            type="file"
            multiple
            hidden
            {...{ webkitdirectory: 'true', directory: 'true' }}
            onChange={onFile}
          />
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          rows={plan ? 4 : 7}
          className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[11px] leading-relaxed outline-none focus:ring-1 focus:ring-ring"
        />

        {plan && (
          <div className="space-y-2 rounded-md border bg-secondary/25 p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-medium">编配</span>
              <button
                type="button"
                className="flex items-center gap-1 rounded-full border border-input px-2 py-0.5 text-[10px] tabular hover:bg-secondary"
                onClick={() =>
                  setPlan((p) => ({ ...p, keyIdx: (p.keyIdx + 1) % p.keys.length }))
                }
              >
                {keyName(plan.keys[plan.keyIdx])}
                <RefreshCw className="h-2.5 w-2.5 opacity-70" aria-hidden="true" />
              </button>
              <span className="text-[10px] text-muted-foreground">{plan.textures.length} 小节</span>
              <div className="ml-auto flex gap-1">
                <button
                  type="button"
                  className="rounded border border-input px-1.5 py-0.5 text-[10px] hover:bg-secondary"
                  onClick={() => setPlan((p) => ({ ...p, dirty: false, textures: defaultPlan(p.textures.length, voicingOf(p.voicing).roles.length) }))}
                >
                  层层加厚
                </button>
                <button
                  type="button"
                  className="rounded border border-input px-1.5 py-0.5 text-[10px] hover:bg-secondary"
                  onClick={() => setPlan((p) => ({ ...p, dirty: true, textures: p.textures.map(() => 'block') }))}
                >
                  全柱式
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-muted-foreground">编制</span>
              {VOICINGS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() =>
                    setPlan((p) => ({
                      ...p,
                      voicing: v.id,
                      // 用户手工涂过就尊重原样，没动过才按新编制重排
                      textures: p.dirty ? p.textures : defaultPlan(p.textures.length, v.roles.length),
                    }))
                  }
                  className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                    plan.voicing === v.id
                      ? 'border-brand bg-brand/10 text-foreground'
                      : 'border-input text-muted-foreground hover:bg-secondary'
                  }`}
                >
                  {v.name}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap gap-1">
              {TEXTURES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setBrush(t.id)}
                  className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                    brush === t.id
                      ? 'bg-brand text-brand-foreground'
                      : 'border border-input text-muted-foreground hover:bg-secondary'
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <p className="text-[10px] leading-snug text-muted-foreground">{hint}</p>

            <div className="flex flex-wrap gap-1">
              {plan.textures.map((t, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => paint(i)}
                  className={`w-[50px] rounded border px-0.5 py-[3px] text-center leading-tight transition-colors ${
                    t === brush ? 'border-brand/60 bg-brand/10' : 'border-border hover:bg-secondary'
                  }`}
                >
                  <span className="block text-[8px] text-muted-foreground tabular">{i + 1}</span>
                  <span className="block text-[10px]">{textureName(t)}</span>
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <Button size="sm" variant="ghost" onClick={() => setPlan(null)}>
                取消
              </Button>
              <Button size="sm" onClick={generate}>
                生成多声部
              </Button>
            </div>
          </div>
        )}

        {omr && (
          <div className="space-y-1.5 rounded-md border bg-secondary/25 p-2 animate-fade-in" aria-live="polite">
            <div className="flex flex-wrap items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" aria-hidden="true" />
              <span className="text-[11px] font-medium">{omr.label}</span>
              {omr.legacy && (
                <span className="rounded border border-input px-1 py-0.5 text-[9px] text-muted-foreground">
                  旧版服务 · 无进度
                </span>
              )}
              <button
                type="button"
                className="ml-auto rounded border border-input px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary"
                onClick={cancelOmr}
              >
                取消
              </button>
            </div>

            <div
              className="h-1 w-full overflow-hidden rounded-full bg-secondary"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={omr.progress == null || omr.indeterminate ? undefined : Math.round(omr.progress * 100)}
              aria-label="PDF 识别进度"
            >
              {omr.progress == null || omr.indeterminate ? (
                <div className="h-full w-1/3 animate-pulse rounded-full bg-brand/60" />
              ) : (
                <div
                  className="h-full rounded-full bg-brand transition-[width] duration-300"
                  style={{ width: `${Math.max(2, Math.round(omr.progress * 100))}%` }}
                />
              )}
            </div>

            <p className="text-[10px] leading-snug text-muted-foreground">{omr.text}</p>
            {!!(omr.chips && omr.chips.length) && (
              <div className="flex flex-wrap gap-1">
                {omr.chips.map((c, i) => (
                  <span key={i} className="rounded bg-secondary px-1.5 py-0.5 text-[9px] tabular text-muted-foreground">
                    {c}
                  </span>
                ))}
              </div>
            )}
            {omr.hint && <p className="text-[9px] leading-snug text-muted-foreground/80">{omr.hint}</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <FileMusic className="h-3.5 w-3.5" />
            {msg ? (
              <span className={msg.ok ? '' : 'text-destructive'}>{msg.text}</span>
            ) : (
              <span className="font-mono">bpm 92，bar 4，S: E4 1 F4 1 | r 2</span>
            )}
          </span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={busy} onClick={openArrange}>
              配成多声部
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                try {
                  const sc = parseTextScore(text)
                  if (!sc.parts.length) throw new Error('没解析出声部')
                  apply(sc, `已载入 ${sc.title}，${sc.parts.length} 个声部`, true)
                } catch (err) {
                  setMsg({ ok: false, text: err.message })
                }
              }}
            >
              载入
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
