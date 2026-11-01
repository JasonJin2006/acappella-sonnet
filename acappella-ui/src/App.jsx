import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Pilot, DEFAULT_SETTINGS } from '@/lib/engine'
import { settingsPatchForScore } from '@/lib/traditions'
import { scoreToMusicXML } from '@/lib/musicxml'
import { DEMOS, midiToName, midiToSolf, midiToFreq, DYNAMICS, transposeScore } from '@/lib/music'
import { applyAutomation } from '@/lib/automation'
import { createHistory, snapshotScore } from '@/lib/history'
import FollowPage from '@/pages/FollowPage'
import SettingsPage from '@/pages/SettingsPage'
import BottomNav from '@/components/BottomNav'
import CreatePage from '@/pages/CreatePage'
import PianoRoll from '@/components/PianoRoll'
import ChordTrackEditor from '@/components/ChordTrackEditor'
import { Mixer } from '@/lib/takes'
import { ScorePlayer } from '@/lib/player'
import { takesToScore } from '@/lib/takescore'
// 曲库数据接近 1 MB，拆出去，打开谱库时才加载

// 创作域是一个容器页，标题固定显示「创作」，具体子页在页面内用胶囊切换
const TITLES = { create: '创作', settings: '设置' }

export default function App() {
  const [score, setScore] = useState(() => structuredClone(DEMOS.demo2))
  const [myPart, setMyPart] = useState(0)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('待机')
  const [page, setPage] = useState('follow')
  // 钢琴卷帘是跟谱页上的叠加编辑页，不占底部导航的一个位置
  const [editing, setEditing] = useState(false)
  // 和弦轨 / 织体轨 / 力度自动化：都是「按小节的覆盖」，空数组 = 全自动
  const [chordTrack, setChordTrack] = useState([])
  const [textureTrack, setTextureTrack] = useState([])
  const [automation, setAutomation] = useState([])
  // 和弦轨编辑器是否打开
  const [chordOpen, setChordOpen] = useState(false)
  // 当前工程 id（保存过一次之后才有）。换谱/换工程都要重置。
  const [projectId, setProjectId] = useState(null)


  // 撤销栈：只记录谱面编辑，不含录音和设置。
  // 用 ref 而不是 state，避免每次编辑都触发重渲染。
  const historyRef = useRef(null)
  if (!historyRef.current) historyRef.current = createHistory()
  // 为了让工具栏的撤销/重做按钮能实时变灰，额外存一个版本号
  const [histVer, setHistVer] = useState(0)
  const bumpHist = () => setHistVer((v) => v + 1)
  // 录音 / 哼唱进行中锁住导航，避免半截录音被丢掉
  const [busy, setBusy] = useState(false)
  // 设置存本地：下次打开还是上次的音色、音量、定位方式和传统。
  // followParts 跟声部数绑定，换谱会失效，所以不持久化。
  const [settings, setSettings] = useState(() => {
    const base = { ...DEFAULT_SETTINGS, onlyMine: false }
    try {
      const raw = localStorage.getItem('sonnet-settings')
      if (raw) {
        const saved = JSON.parse(raw)
        for (const k of Object.keys(DEFAULT_SETTINGS)) {
          if (saved[k] !== undefined) base[k] = saved[k]
        }
        base.onlyMine = !!saved.onlyMine
      }
    } catch (e) { /* 隐私模式或旧数据坏了就用默认值 */ }
    return base
  })
  const [err, setErr] = useState(null)
  const [takes, setTakes] = useState([])
  const [hum, setHum] = useState(null)
  const [mixPlaying, setMixPlaying] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [droneOn, setDroneOn] = useState(false)
  const [cardOpen, setCardOpen] = useState(false)
  // 设置统一用函数式更新：连点几个开关时，后面的不会用旧的 settings
  // 把前面的改动盖掉（之前连点三个开关只生效最后一个）
  const updateSettings = useCallback((patch) => {
    setSettings((prev) => {
      const next = typeof patch === 'function' ? patch(prev) : patch
      return next ? { ...prev, ...next } : prev
    })
  }, [])

  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('ap-theme')
      if (saved === 'light' || saved === 'dark') return saved
    } catch (e) { /* 隐私模式下 localStorage 可能不可用 */ }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try { localStorage.setItem('ap-theme', theme) } catch (e) {}
  }, [theme])

  // 升降调只作用在「发声和判定」上，原始 score 保持原调：
  // 撤销历史、我的谱、导出工程存的都是原调，跟着变会把原谱改坏。
  // 播放、提示音、跟唱判定、音名显示统一读 scoreSounding，
  // 三处共用同一个值，就不会出现「声音变了、显示没变、判定还按原调」。
  const scoreSounding = useMemo(
    () => transposeScore(score, settings.transpose || 0),
    [score, settings.transpose]
  )

  // 导入的谱带原始 XML，直接用它渲染以保留原排版；否则按内部格式生成
  const xmlAll = useMemo(
    () => scoreSounding._xml || scoreToMusicXML(scoreSounding),
    [scoreSounding]
  )
  const xmlMine = useMemo(
    () => scoreToMusicXML({ ...scoreSounding, parts: [scoreSounding.parts[myPart]] }),
    [scoreSounding, myPart]
  )

  // 叠加层要按"拍"在谱面上定位，需要每个音的起始拍和时值
  const timing = useMemo(() => {
    const part = score.parts[myPart]
    if (!part) return null
    const startBeats = []
    let acc = 0
    for (const n of part.notes) { startBeats.push(acc); acc += n.beats }
    return {
      startBeats,
      beats: part.notes.map((n) => n.beats),
      // 力度跟着 timing 一起传下去：ScoreView 用它决定彩帘条的粗细
      vels: part.notes.map((n) => (n.vel == null ? null : n.vel)),
      total: part.notes.length,
      totalBeats: acc,
    }
  }, [score, myPart])

  // 当前谱面的音域（所有声部），设置页拿它判断音色够不够用
  const scoreRange = useMemo(() => {
    const all = []
    for (const p of score.parts) for (const n of p.notes) if (n.midi != null) all.push(n.midi)
    return all.length ? [Math.min(...all), Math.max(...all)] : null
  }, [score])

  const engineRef = useRef(null)
  if (!engineRef.current) engineRef.current = new Pilot()
  const mixerRef = useRef(null)
  if (!mixerRef.current) mixerRef.current = new Mixer()
  const playerRef = useRef(null)
  if (!playerRef.current) playerRef.current = new ScorePlayer()

  const noteRef = useRef(null)
  const beatRef = useRef(null)
  const nextRef = useRef(null)
  const centsRef = useRef(null)
  const needleRef = useRef(null)
  const scoreRef = useRef(null)
  const playFillRef = useRef(null)
  const playLabelRef = useRef(null)
  const solfRef = useRef(settings.solf)
  const timingRef = useRef(timing)
  const lastStatusRef = useRef('')
  const partDotRefs = useRef([])
  const cardOpenRef = useRef(false)
  const lastSingRef = useRef(0)
  const pageRef = useRef(page)
  const busyRef = useRef(busy)

  solfRef.current = settings.solf
  timingRef.current = timing
  pageRef.current = page
  busyRef.current = busy

  // 落盘。只存通用项，声部开关随谱面走
  useEffect(() => {
    try {
      const { followParts, ...rest } = settings
      localStorage.setItem('sonnet-settings', JSON.stringify(rest))
    } catch (e) {}
  }, [settings])

  // 设置实时同步进引擎（音量/八度/音色变化时立刻生效）
  useEffect(() => {
    const eng = engineRef.current
    const prev = eng.settings
    eng.settings = settings
    // 定位方式改了要立刻切模式，否则界面提示和引擎行为会对不上
    if (settings.followMode && settings.followMode !== eng.mode) eng.setMode(settings.followMode)
    if (eng.cue) {
      eng.cue.setVolume(settings.vol)
      eng.cue.setTimbre(settings.timbre || 'choir')
      if (eng.cue.setLowPower) eng.cue.setLowPower(settings.lowPower)
      if (prev.oct !== settings.oct || prev.mode !== settings.mode) eng.cue.stopSustain()
    }
    // 播放引擎是独立的一套，音量和音色跟着设置走
    playerRef.current.setVolume(settings.vol)
    playerRef.current.setTimbre(settings.timbre || 'choir')
    if (playerRef.current.cue?.setLowPower) playerRef.current.cue.setLowPower(settings.lowPower)
  }, [settings])

  useEffect(() => { window.__pilot = engineRef.current }, [])
  useEffect(() => { window.__player = playerRef.current }, [])
  // 引擎（跟唱判定 + 提示音）读移调后的谱：唱出来的音和谱面对得上，
  // 否则降了三个半音唱，判定会一直报跑调
  useEffect(() => { engineRef.current.setScore(scoreSounding, myPart) }, [scoreSounding])
  useEffect(() => { engineRef.current.setPart(myPart) }, [myPart])

  // 载入谱面后就把播放要用的采样在后台备好。
  // 首次播放时现传会让主线程一阵一阵堵住（实测 17 个采样共 6 秒，
  // 界面掉到 30fps），而这批工作跟「点播放」没关系，可以提前做完。
  useEffect(() => {
    if (!scoreSounding || !scoreSounding.parts.length) return
    let cancelled = false
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400))
    const handle = idle(() => {
      if (cancelled) return
      playerRef.current.warmup(scoreSounding, {
        timbre: settings.timbre || 'choir',
        parts: settings.playOnlyMine ? [myPart] : undefined,
      })
    })
    return () => {
      cancelled = true
      if (window.cancelIdleCallback && typeof handle === 'number') window.cancelIdleCallback(handle)
    }
    // timbre 变了要重新预热（换音色等于换一整套采样）
  }, [scoreSounding, myPart, settings.timbre, settings.playOnlyMine])

  // 页面切换同步进浏览器历史，Android 返回键才能逐页退回
  useEffect(() => {
    try { window.history.replaceState({ page: 'follow' }, '') } catch (e) {}
    const onPop = (e) => {
      if (busyRef.current) {
        try { window.history.pushState({ page: pageRef.current }, '') } catch (err) {}
        return
      }
      setPage((e.state && e.state.page) || 'follow')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // 只清屏上的实时数字，不动谱面位置。停止播放时用这个，
  // 停下来还停在刚才那一拍，方便接着唱。
  const clearLive = useCallback(() => {
    if (noteRef.current) { noteRef.current.textContent = '—'; noteRef.current.style.color = 'hsl(var(--muted-foreground) / .35)' }
    if (beatRef.current) beatRef.current.textContent = '—'
    if (nextRef.current) nextRef.current.textContent = '—'
    if (centsRef.current) { centsRef.current.textContent = '—'; centsRef.current.style.color = '' }
    if (needleRef.current) {
      needleRef.current.style.left = '50%'
      needleRef.current.style.opacity = '.25'
      needleRef.current.style.background = 'hsl(var(--muted-foreground))'
    }
    cardOpenRef.current = false
    setCardOpen(false)
    // 谱面上的叠加层（彩帘 / 音高曲线）也要一起清掉，否则停止后滚动会重画出来
    scoreRef.current?.clearOverlay?.()
  }, [])

  const resetLive = useCallback(() => {
    clearLive()
    // 停止跟唱只清叠加层，光标和谱面位置留在原处，
    // 否则屏幕跳回第 1 拍、引擎却停在原来的拍子上
    scoreRef.current?.reset()
  }, [clearLive])

  const stopFollow = useCallback(() => {
    const eng = engineRef.current
    // starting：还在等 getUserMedia。stop() 会作废这次启动，
    // 否则 stream 回来之后照样 running=true，界面上却没有停止入口。
    if (!eng.running && !eng.starting) return
    eng.stop()
    setRunning(false)
    setStatus('已停止')
    lastStatusRef.current = ''
    resetLive()
  }, [resetLive])

  // 切页：进哼唱 / 录音要独占麦克风，先停跟随和混音；去设置、谱库则让跟随继续跑
  const goPage = useCallback((next) => {
    if (next === pageRef.current) return
    // 别的页面上没有播放控制入口，离开跟谱页就停掉，免得声音停不下来
    if (playerRef.current.playing) {
      playerRef.current.stop()
      setPlaying(false)
      // 离开跟谱页时把气泡和数字一起清掉，回来不会还挂着上一首的音名
      clearLive()
    }
    // 持续低音只在跟谱页有开关，离开就停，免得声音一直响
    if (next !== 'follow' && engineRef.current.cue) {
      engineRef.current.cue.stopDrone()
      setDroneOn(false)
    }
    // 刚点麦克风还在等授权就切页：这次启动直接作废。
    // 设置 / 谱库页没有停止麦克风的按钮，不能让它悄悄开起来。
    if (next !== 'follow' && engineRef.current.starting) stopFollow()
    if (next === 'hum' || next === 'rec') {
      mixerRef.current.stop()
      setMixPlaying(false)
      stopFollow()
    }
    setPage(next)
    try { window.history.pushState({ page: next }, '') } catch (e) {}
  }, [stopFollow, clearLive])

  // 打开工程：整体替换编辑状态。
  // 这是「换文档」，撤销栈必须清空，否则撤销会跳回上一个工程的内容。
  const openProject = useCallback((proj) => {
    if (!proj) return
    playerRef.current.stop()
    setPlaying(false)
    mixerRef.current.stop()
    setMixPlaying(false)
    setTakes(proj.takes || [])
    setChordTrack(proj.chords || [])
    setTextureTrack(proj.textures || [])
    setAutomation(proj.automation || [])
    automationRef.current = proj.automation || []
    setMyPart(proj.myPart || 0)
    setProjectId(proj.id || null)
    historyRef.current.clear()
    setHistVer((v) => v + 1)
    setHum(null)
    clearLive()
    engineRef.current.seek(0)
    scoreRef.current?.rewind?.()
    setScore(proj.score)
    goPage('follow')
  }, [clearLive, goPage])

  // 底部导航现在是「功能域」，内部仍用原来的 page 标识。
  // 域 → 默认子页：练唱→跟谱，创作→创作域，设置→设置页。
  const goGroup = useCallback((group) => {
    const target = group === 'sing' ? 'follow' : group === 'create' ? 'create' : 'settings'
    goPage(target)
  }, [goPage])

  // 原生返回键：不在跟谱页就回跟谱，在跟谱页返回 false 交给原生退到后台
  useEffect(() => {
    window.__back = () => {
      if (busyRef.current) return true
      if (pageRef.current !== 'follow') { goPage('follow'); return true }
      return false
    }
    return () => { delete window.__back }
  }, [goPage])

  // 持续低音：给侗族大歌、格鲁吉亚这类以持续音托底的传统铺底。
  // 音高取最低声部的第一个音，也就是低音部实际唱的那个音。
  const toggleDrone = useCallback(async (on) => {
    const eng = engineRef.current
    try {
      if (!on) {
        if (eng.cue) eng.cue.stopDrone()
        setDroneOn(false)
        return
      }
      const bass = score.parts[score.parts.length - 1]
      const n = (bass?.notes || []).find((x) => x.midi != null)
      if (!n) {
        setErr('最低声部没有音符，没法起低音')
        return
      }
      const cue = await eng.ensureCue()
      cue.startDrone(midiToFreq(n.midi), 0.5)
      setDroneOn(true)
    } catch (e) {
      setErr('低音启动失败：' + (e.message || e))
    }
  }, [score])

  // 定音：把每个声部的第一个音弹出来，让大家各自找到自己的调
  const tune = useCallback(async (sel) => {
    const eng = engineRef.current
    const firsts = score.parts.map((p) => {
      const n = p.notes.find((x) => x.midi != null)
      return n ? n.midi : null
    })
    try {
      const cue = await eng.ensureCue()
      const t0 = cue.ctx.currentTime + 0.08
      const play = (midi, dur, when) => {
        if (midi == null) return
        cue.tone(midiToFreq(midi), dur, 0.6, when)
      }
      if (sel === 'all') {
        // 四个音一起响，听和弦、对音准
        for (const m of firsts) play(m, 2.4, t0)
      } else if (sel === 'seq') {
        // 依次响，每个人认领自己那个
        let k = 0
        for (const m of firsts) {
          if (m == null) continue
          play(m, 0.95, t0 + k * 1.1)
          k++
        }
      } else {
        play(firsts[sel], 2.1, t0)
      }
      setStatus('定音中')
      lastStatusRef.current = '定音中'
    } catch (e) {
      setErr('定音失败：' + (e.message || e))
    }
  }, [score])

  const onFrame = useCallback((f, eng) => {
    if (!f) return
    // 气泡开合：检测到自己在唱就展开，停了 0.7 秒再收起，
    // 换气、漏检这几帧不会让卡片来回闪
    const nowMs = performance.now()
    if (f.voiced) {
      lastSingRef.current = nowMs
      if (!cardOpenRef.current) { cardOpenRef.current = true; setCardOpen(true) }
    } else if (cardOpenRef.current && nowMs - lastSingRef.current > 700) {
      cardOpenRef.current = false
      setCardOpen(false)
    }
    const fmt = solfRef.current ? midiToSolf : midiToName

    if (noteRef.current) {
      noteRef.current.textContent = f.target == null ? '休止' : fmt(f.target)
      noteRef.current.style.color = f.target == null ? 'hsl(var(--muted-foreground) / .5)' : ''
    }
    if (beatRef.current) beatRef.current.textContent = `第 ${f.bar} 小节 第 ${f.beatInBar} 拍`
    if (nextRef.current) nextRef.current.textContent = f.next == null ? '—' : fmt(f.next)

    let color = 'hsl(173 72% 46%)'
    if (f.cents == null) {
      if (centsRef.current) { centsRef.current.textContent = '—'; centsRef.current.style.color = '' }
      if (needleRef.current) {
        needleRef.current.style.left = '50%'
        needleRef.current.style.opacity = '.25'
        needleRef.current.style.background = 'hsl(var(--muted-foreground))'
      }
    } else {
      const a = Math.abs(f.cents)
      color = a > 35 ? 'hsl(0 72% 51%)' : a > 15 ? 'hsl(38 92% 50%)' : 'hsl(173 72% 46%)'
      if (centsRef.current) {
        centsRef.current.textContent = (f.cents >= 0 ? '+' : '') + Math.round(f.cents) + ' 音分'
        centsRef.current.style.color = color
      }
      if (needleRef.current) {
        const c = Math.max(-50, Math.min(50, f.cents))
        needleRef.current.style.left = 50 + (c / 50) * 50 + '%'
        needleRef.current.style.opacity = '1'
        needleRef.current.style.background = color
      }
    }

    // 状态必须说清楚为什么不动：没听到唱 / 听到的不是这个声部 / 正常跟随
    const st = f.manual
      ? (f.voiced ? '跟唱中' : '按拍走')
      : !f.locked ? (f.heard ? '定位中' : '等你唱')
      : f.hasAnchor ? (f.soloMode ? '练习中' : '跟随中')
      : f.heard ? '搜索中'
      : '等你唱'
    if (lastStatusRef.current !== st) { lastStatusRef.current = st; setStatus(st) }

    const pa = f.parts || []
    for (let i = 0; i < pa.length; i++) {
      const el = partDotRefs.current[i]
      if (el) el.style.opacity = pa[i].active ? '1' : '0.2'
    }
    scoreRef.current?.syncTo(f.beatNow, {
      pos: f.pos,
      total: f.total,
      targetMidi: f.target,
      cents: f.cents,
      trace: eng.trace,
      timing: timingRef.current,
    })
  }, [])

  const addTake = useCallback((t) => setTakes((prev) => [
    ...prev.map((x) => (x.partIndex === t.partIndex ? { ...x, muted: true } : x)),
    t,
  ]), [])
  const updateTake = useCallback(
    (id, patch) => setTakes((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t))),
    []
  )
  const removeTake = useCallback((id) => {
    mixerRef.current.stop()
    setMixPlaying(false)
    setTakes((prev) => prev.filter((t) => t.id !== id))
  }, [])
  const playTakes = useCallback(() => {
    const ok = mixerRef.current.play(takes, { bpm: score.bpm, onEnd: () => setMixPlaying(false) })
    if (ok) setMixPlaying(true)
  }, [takes, score.bpm])
  const stopTakes = useCallback(() => {
    mixerRef.current.stop()
    setMixPlaying(false)
  }, [])

  // 哼唱转录结果追加成一个新声部。加入后原谱的 _xml 不再包含新声部，
  // 必须丢掉它改用内部格式重新生成，否则界面会看不到新声部。
  // 所有改谱面的地方都走这里：先记一笔快照，再执行修改。
  // mergeKey 用于合并连续编辑（拖动一个音会触发几十次 onChange，
  // 不合并的话按一次撤销只退一个像素）。
  const editScore = useCallback((updater, mergeKey) => {
    setScore((prev) => {
      historyRef.current.push(snapshotScore(prev), mergeKey)
      const next = typeof updater === 'function' ? updater(prev) : updater
      if (next && next !== prev) delete next._xml
      return next || prev
    })
    bumpHist()
  }, [])

  const undoScore = useCallback(() => {
    setScore((cur) => {
      const prev = historyRef.current.undo(snapshotScore(cur))
      if (!prev) return cur
      return prev
    })
    bumpHist()
  }, [])

  const redoScore = useCallback(() => {
    setScore((cur) => {
      const next = historyRef.current.redo(snapshotScore(cur))
      if (!next) return cur
      return next
    })
    bumpHist()
  }, [])

  const applyHum = useCallback((res) => {
    if (!res || !res.notes.length) return
    const next = { ...score, parts: [...score.parts] }
    delete next._xml
    const n = next.parts.filter((p) => /^H\d*$/.test(p.id)).length
    next.parts.push({ id: 'H' + (n + 1), name: '哼唱', notes: res.notes })
    clearLive()
    engineRef.current.seek(0)
    scoreRef.current?.rewind?.()
    editScore(next)
    setMyPart(next.parts.length - 1)
    setHum(null)
    goPage('follow')
  }, [score, goPage, clearLive])

  // 播放时气泡里的当前音跟着播放位置走：不听麦克风，看谱面第几拍
  const paintBeat = useCallback((beat) => {
    // 音名要反映实际听到的音高，所以读移调后的谱；节拍/时值两边一样
    const part = scoreSounding.parts[myPart]
    const t = timing
    if (!part || !t || !part.notes.length) return
    const barLen = score.bar || 4
    let idx = 0
    while (idx + 1 < t.startBeats.length && t.startBeats[idx + 1] <= beat + 1e-6) idx++
    const n = part.notes[idx]
    const fmt = solfRef.current ? midiToSolf : midiToName
    if (noteRef.current) {
      noteRef.current.textContent = n.midi == null ? '休止' : fmt(n.midi)
      noteRef.current.style.color = n.midi == null ? 'hsl(var(--muted-foreground) / .5)' : ''
    }
    if (beatRef.current) {
      beatRef.current.textContent = `第 ${Math.floor(beat / barLen) + 1} 小节 第 ${Math.floor(beat % barLen) + 1} 拍`
    }
    const next = part.notes[idx + 1]
    if (nextRef.current) nextRef.current.textContent = next && next.midi != null ? fmt(next.midi) : '—'
    if (centsRef.current) {
      centsRef.current.textContent = '播放中'
      centsRef.current.style.color = ''
    }
    if (needleRef.current) {
      needleRef.current.style.left = '50%'
      needleRef.current.style.opacity = '.25'
      needleRef.current.style.background = 'hsl(var(--muted-foreground))'
    }
  }, [score, scoreSounding, myPart, timing])

  // 播放整份谱。和跟唱互斥：麦克风先停，否则提示音会混进你的声音。
  const startPlayback = useCallback(async (opts = {}) => {
    const eng = engineRef.current
    const player = playerRef.current
    setErr(null)
    if (eng.running || eng.starting) stopFollow()
    // 持续参考音和持续低音都不是播放的一部分，先停掉，免得和曲子打架
    if (eng.cue) {
      eng.cue.stopSustain()
      eng.cue.stopDrone()
    }
    setDroneOn(false)
    mixerRef.current.stop()
    setMixPlaying(false)

    const total = Math.max(
      0,
      ...score.parts.map((p) => p.notes.reduce((s, n) => s + n.beats, 0))
    )
    let from = opts.fromBeat != null ? opts.fromBeat : eng.teamBeat || 0
    if (!(from > 0) || from >= total - 0.05) from = 0

    const ok = await player.play(scoreSounding, {
      fromBeat: from,
      volume: settings.vol,
      timbre: settings.timbre || 'choir',
      rate: settings.playRate || 1,
      lowPower: !!settings.lowPower,
      parts: settings.playOnlyMine ? [myPart] : undefined,
      // 混音器：每个声部的音量（null 视为满音量）
      partVols: settings.partVols || null,
      metro: !!settings.playMetro,
      fx: settings.fx || undefined,
      onEnd: () => {
        setPlaying(false)
        setStatus('播放结束')
        clearLive()
      },
    })
    if (!ok) {
      setErr('这份谱没有可播放的音符')
      return
    }
    // resume 是异步的：这期间切了页或者开了麦克风，就不要再起播，
    // 否则声音会在没有停止按钮的页面上响
    if (pageRef.current !== 'follow' || engineRef.current.running) {
      player.stop()
      return
    }
    eng.seek(from)
    scoreRef.current?.syncTo(from, null, false)
    paintBeat(from)
    cardOpenRef.current = true
    setCardOpen(true)
    setPlaying(true)
    setStatus('播放中')
  }, [score, scoreSounding, myPart, settings.vol, settings.timbre, settings.playOnlyMine, settings.partVols, settings.playMetro, stopFollow, clearLive, paintBeat])

  const stopPlayback = useCallback((keepPlace = true) => {
    const player = playerRef.current
    if (!player.playing) return
    const beat = player.beat
    player.stop()
    setPlaying(false)
    clearLive()
    // 停在原地：接下来按麦克风就从这里开始跟唱
    if (keepPlace) {
      engineRef.current.seek(beat)
      scoreRef.current?.syncTo(beat, null, false)
    }
    setStatus('已停止')
  }, [clearLive])

  const auditionTimbre = useCallback((timbre) => {
    playerRef.current.audition(timbre, settings.vol)
  }, [settings.vol])

  const togglePlay = useCallback(() => {
    if (playerRef.current.playing) stopPlayback(true)
    else startPlayback()
  }, [startPlayback, stopPlayback])

  // 播放时用 rAF 推光标和进度条。走 DOM 不走 React state，
  // 每秒 60 次重渲染会把整页拖慢。
  useEffect(() => {
    if (!playing) return
    const player = playerRef.current
    const eng = engineRef.current
    const barLen = score.bar || 4
    let raf = 0
    let lastPos = -1
    // 进度条和小节文字不需要 60fps。每帧都写 style/textContent 会触发
    // 样式重算，手机上一秒 120 次写入足以把主线程占满（表现是播放卡顿、
    // UI 掉帧）。限制到 ~12fps，且只在值真的变了才写。
    let lastFill = -1
    let lastLabel = ''
    let lastPaintMs = 0
    let lastBeat = -1
    const tick = () => {
      const beat = player.beat
      const total = player.totalBeats || 1
      const now = performance.now()

      // 进度条 + 小节文字：12fps 足够顺滑，肉眼看不出跳
      if (now - lastPaintMs > 80) {
        lastPaintMs = now
        const pct = Math.round(Math.min(100, (beat / total) * 100))
        if (pct !== lastFill && playFillRef.current) {
          lastFill = pct
          playFillRef.current.style.width = pct + '%'
        }
        const bars = Math.max(1, Math.ceil(total / barLen))
        const label = `第 ${Math.min(bars, Math.floor(beat / barLen) + 1)} / ${bars} 小节`
        if (label !== lastLabel && playLabelRef.current) {
          lastLabel = label
          playLabelRef.current.textContent = label
        }
      }

      const pos = eng.posAtBeat(beat)
      // 引擎的位置跟着播放走：停止后按麦克风就能从这一拍接着唱
      eng.teamBeat = beat
      // 音符气泡只在换音时更新：paintBeat 会写 7 处 DOM，
      // 每帧调用是之前卡顿的主要来源。
      if (pos !== lastPos) {
        lastPos = pos
        lastBeat = beat
        // 换音时滚一次，用平滑滚动：以前传 false（瞬间跳），
        // 播放时画面是一格一格蹦过去的，看着就像卡。
        // 这里本来就是「换音」才调用，不是每帧，不会互相打断。
        scoreRef.current?.syncTo(beat, null, true)
        paintBeat(beat)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, score.bar, paintBeat])

  useEffect(() => () => playerRef.current.stop(), [])

  // 退到后台就停播放：没有通知栏控制，留着声音会让人找不到关的地方
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && playerRef.current.playing) {
        playerRef.current.stop()
        setPlaying(false)
        setStatus('已停止')
      }
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [])

  // 点谱面定位：手动模式下由用户决定从哪一拍开始，引擎按时钟走
  const seek = useCallback((beat) => {
    const eng = engineRef.current
    eng.seek(beat)
    scoreRef.current?.syncTo(beat, null, false)
    paintBeat(beat)
    if (playerRef.current.playing) {
      // 播放中点谱面＝跳到那一拍接着放
      startPlayback({ fromBeat: beat })
      return
    }
    if (!eng.running) {
      setStatus(`已定位到第 ${Math.floor(beat / (score.bar || 4)) + 1} 小节`)
      lastStatusRef.current = ''
    }
  }, [score, startPlayback, paintBeat])

  // 整首力度：把每个音都设成同一个力度档位。
  // 只改当前谱面的副本，不改用户导入的原始 XML（_xml 要丢掉，
  // 否则界面还会用旧 XML 渲染，听感和显示就对不上了）。
  const applyDynamics = useCallback((mark) => {
    const vel = DYNAMICS[mark]
    if (vel == null) return
    editScore((prev) => {
      const next = { ...prev, parts: prev.parts.map((p) => ({
        ...p,
        notes: p.notes.map((n) => (n.midi == null ? n : { ...n, vel })),
      })) }
      return next
    })
    setStatus(`整首力度 ${mark}`)
    lastStatusRef.current = ''
    // 正在播放的话，用一个短音试听新力度
    if (playerRef.current.playing) startPlayback({ fromBeat: engineRef.current.teamBeat || 0 })
  }, [startPlayback])

  // 钢琴卷帘：改当前声部的音符列表。
  // 换谱面时原始 XML 必须丢掉——XML 是上次导入/生成时的快照，
  // 不再反映用户后来编辑的音符，留着会让界面显示旧内容。
  const applyPartNotes = useCallback((notes) => {
    // 钢琴卷帘拖动时会连续调用，用同一个 mergeKey 合并成一步撤销
    editScore((prev) => ({
      ...prev,
      parts: prev.parts.map((p, i) => (i === myPart ? { ...p, notes } : p)),
    }), 'roll:' + myPart)
  }, [myPart, editScore])

  // 力度曲线变化时重新套到谱面上。
  // 只改没有显式力度的音——文本记谱里手写的 mf/pp 不被覆盖。
  // 曲线的最新值放在 ref 里。
  // 不能写成 setAutomation(prev => { setScore(...) })——在 state updater 里
  // 调用另一个 setState 是未定义行为，React 18 的严格模式会重复执行 updater，
  // 实际观测到的是「只有第一个控制点生效」。
  const automationRef = useRef([])
  const applyAutomationToScore = useCallback((next) => {
    const points = typeof next === 'function' ? next(automationRef.current) : next
    automationRef.current = points
    setAutomation(points)
    // 拖控制点时连续触发，合并成一步撤销
    editScore((sc) => applyAutomation(sc, points, sc.bar), 'automation')
  }, [])

  const nudge = useCallback((delta) => {
    const eng = engineRef.current
    eng.nudge(delta)
    const beat = eng.teamBeat || 0
    scoreRef.current?.syncTo(beat, null, false)
    paintBeat(beat)
    if (playerRef.current.playing) startPlayback({ fromBeat: beat })
  }, [startPlayback, paintBeat])

  // 分轨录音转谱：每条轨单独转录，再按起始拍拼成一份谱。
  // 转完不清空录音，回录音页还能接着听、接着录。
  const transcribeTakes = useCallback(() => {
    const sc = takesToScore(takes, score)
    if (!sc) {
      setErr('这些录音还没识别出音符，离麦克风近一点重录一条')
      return
    }
    setErr(null)
    mixerRef.current.stop()
    setMixPlaying(false)
    clearLive()
    engineRef.current.seek(0)
    scoreRef.current?.rewind?.()
    // 换谱是「打开另一份文档」，不进撤销栈，直接把历史清空
    historyRef.current.clear()
    setProjectId(null)
    bumpHist()
    setScore(sc)
    setMyPart(0)
    goPage('follow')
  }, [takes, score, goPage, clearLive])

  const loadScore = useCallback((sc) => {
    if (playerRef.current.playing) {
      playerRef.current.stop()
      setPlaying(false)
    }
    // 换谱时正在跟唱的话先停掉，旧谱的跟随状态对新谱没有意义
    stopFollow()
    if (engineRef.current.cue) engineRef.current.cue.stopDrone()
    setDroneOn(false)
    mixerRef.current.stop()
    setMixPlaying(false)
    setTakes([])
    setHum(null)
    clearLive()
    engineRef.current.seek(0)
    scoreRef.current?.rewind?.()
    // 演唱传统是曲目属性：换曲目就跟着换成这首曲子的传统参数（容差、是否要节拍器）。
    // 用户之后在设置里手调过的值仍然以用户为准，这里只给一份起点。
    setSettings((prev) => ({ ...prev, ...settingsPatchForScore(sc, prev) }))
    setScore(sc)
    setMyPart(0)
    goPage('follow')
  }, [goPage, clearLive, stopFollow])

  const toggle = async () => {
    const eng = engineRef.current
    setErr(null)
    // starting：第一次点击已经去开麦了，第二次点击当"取消"
    if (eng.running || eng.starting) {
      stopFollow()
      return
    }
    // 开始跟唱就把播放停掉：麦克风会录到播放出来的声音
    if (playerRef.current.playing) stopPlayback(true)
    // 跟随一旦开始就独占麦克风，正在试听的混音先停掉
    mixerRef.current.stop()
    setMixPlaying(false)
    const res = await eng.start(onFrame)
    if (res.cancelled) {
      // 等待授权期间已经被切页 / 播放 / 再次点击取消了，不要回写 running
      return
    }
    // await 期间可能已经离开跟谱页（此时按钮也点不到了），
    // 不能在设置页留着一路没人管的麦克风
    if (res.ok && pageRef.current !== 'follow') {
      eng.stop()
      setRunning(false)
      return
    }
    if (res.error) {
      setErr(res.error)
      setStatus('未启动')
    } else if (res.ok) {
      setRunning(true)
    }
  }

  return (
    <div className="pt-safe flex h-[100dvh] w-full flex-col overflow-hidden bg-background">
      {/* 顶部安全距离由 .pt-safe 统一处理（见 index.css）：
          Android WebView 的 env(safe-area-inset-top) 是 0，单靠它会贴住状态栏；
          iOS 有刘海时又要用它。.pt-safe 取 max(1rem, env(...)) 兼顾两者。 */}
      {/* 跟谱页不再占一行顶栏：状态点+文字和 SONNET 都不带信息量，
          而谱面才是这一页的主角，纵向空间全让给谱面。 */}
      {page !== 'follow' && (
        <header className="flex h-12 shrink-0 items-center gap-2 px-4">
          <span className="text-[13px] font-medium">{TITLES[page]}</span>
          <span className="ml-auto text-[10px] tracking-[0.18em] text-muted-foreground/50">SONNET</span>
        </header>
      )}

      <main className="relative min-h-0 flex-1">
        {page === 'follow' && (
          <FollowPage
            parts={score.parts}
            myPart={myPart}
            onPart={setMyPart}
            xml={settings.onlyMine ? xmlMine : xmlAll}
            theme={theme}
            running={running}
            onToggle={toggle}
            playing={playing}
            onPlay={togglePlay}
            playFillRef={playFillRef}
            playLabelRef={playLabelRef}
            onTune={tune}
            onSeek={seek}
            onNudge={nudge}
            startBeat={engineRef.current.teamBeat || 0}
            onDynamics={applyDynamics}
            onEdit={() => setEditing(true)}
            playRate={settings.playRate || 1}
            onPlayRate={(v) => setSettings((prev) => ({ ...prev, playRate: v }))}
            onChordTrack={() => setChordOpen(true)}
            onUndo={undoScore}
            onRedo={redoScore}
            canUndo={histVer >= 0 && historyRef.current.canUndo()}
            canRedo={histVer >= 0 && historyRef.current.canRedo()}
            droneOn={droneOn}
            onDrone={toggleDrone}
            scoreRef={scoreRef}
            noteRef={noteRef}
            beatRef={beatRef}
            nextRef={nextRef}
            centsRef={centsRef}
            needleRef={needleRef}
            partDotRefs={partDotRefs}
            cardOpen={cardOpen}
            timbre={settings.timbre || 'choir'}
            onTimbre={(v) => updateSettings({ timbre: v })}
            vol={settings.vol}
            onVol={(v) => updateSettings({ vol: v })}
            onAudition={auditionTimbre}
            scoreRange={scoreRange}
            // 混音器：partVols 按声部下标存，null 表示这项没单独调过
            partVols={settings.partVols || null}
            onPartVol={(i, v) => {
              if (i === null) {
                // 全部还原：清空整组设置，并把所有声部立刻调回满音量
                updateSettings({ partVols: null })
                score.parts.forEach((_, k) => playerRef.current.setPartVolume(k, 1))
                return
              }
              updateSettings((prev) => {
                const cur = Array.isArray(prev.partVols) ? prev.partVols.slice() : score.parts.map(() => 1)
                while (cur.length < score.parts.length) cur.push(1)
                cur[i] = v
                return { ...prev, partVols: cur }
              })
              // 播放中要立刻听到变化，不能等下一次重播
              playerRef.current.setPartVolume(i, v)
            }}
            metroOn={!!settings.playMetro}
            onMetro={(v) => {
              updateSettings({ playMetro: v })
              // 运行中改：直接翻播放状态的开关，_pump 下一轮就按新值排期
              const st = playerRef.current.state
              if (st) st.metro = v
            }}
          />
        )}
        {editing && page === 'follow' && (
          <div className="absolute inset-0 z-40 w-full overflow-hidden bg-background">
            <PianoRoll
              parts={score.parts}
              myPart={myPart}
              theme={theme}
              onChange={applyPartNotes}
              onClose={() => setEditing(false)}
            />
          </div>
        )}

        {chordOpen && page === 'follow' && (
          <div className="absolute inset-0 z-40 w-full overflow-hidden bg-background">
            <ChordTrackEditor
              score={score}
              chords={chordTrack}
              textures={textureTrack}
              automation={automation}
              theme={theme}
              onChords={setChordTrack}
              onTextures={setTextureTrack}
              onAutomation={applyAutomationToScore}
              onClose={() => setChordOpen(false)}
            />
          </div>
        )}

        {page === 'create' && (
          <CreatePage
            hum={{
              bpm: score.bpm,
              bar: score.bar,
              theme,
              disabled: running,
              result: hum,
              onResult: setHum,
              onApply: () => applyHum(hum),
              onDiscard: () => setHum(null),
              onBusyChange: setBusy,
            }}
            rec={{
              score,
              myPart,
              bpm: score.bpm,
              disabled: running,
              theme,
              takes,
              addTake,
              updateTake,
              removeTake,
              playing: mixPlaying,
              onPlay: playTakes,
              onStopPlay: stopTakes,
              onTranscribe: transcribeTakes,
              onBusyChange: setBusy,
            }}
            library={{
              score,
              chordTrack,
              textureTrack,
              onLoad: loadScore,
              playVolume: settings.vol,
              playTimbre: settings.timbre || 'choir',
              fx: settings.fx,
              // 在谱库里改了「当前已载入这首」的传统：谱面字段和生效参数一起换，
              // 否则要重新载入才生效，用户会以为没改成。
              onRetradition: (tr) => {
                setScore((cur) => (cur ? { ...cur, tradition: tr } : cur))
                setSettings((prev) => ({ ...prev, ...settingsPatchForScore({ tradition: tr }, prev) }))
              },
            }}
            export={{ score, settings }}
            project={{
              current: {
                title: score ? score.title : '',
                score,
                chords: chordTrack,
                textures: textureTrack,
                automation,
                myPart,
                takes,
              },
              projectId,
              onSaved: setProjectId,
              onOpen: openProject,
            }}
          />
        )}
        {page === 'settings' && (
          <SettingsPage
            settings={settings}
            myPart={myPart}
            onChange={updateSettings}
            parts={score.parts}
            theme={theme}
            onTheme={setTheme}
            score={score}
          />
        )}

        {err && (
          <div className="absolute inset-x-4 top-2 z-30 flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-card px-3 py-2 text-[12px] text-destructive shadow-sm">
            <AlertCircle className="mt-[2px] h-3.5 w-3.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}
      </main>

      <BottomNav
        group={page === 'follow' ? 'sing' : page === 'create' ? 'create' : 'settings'}
        running={running}
        locked={busy}
        onChange={goGroup}
      />
    </div>
  )
}
