import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Play, Search, Square, Trash2, X } from 'lucide-react'
import { LIBRARY, CATEGORIES, buildSong, getLibrary } from '@/lib/library'
import { listMyScores, saveMyScore, saveMyScores, deleteMyScore, clearMyScores, getMyScore, setMyScoreTradition } from '@/lib/myScores'
import { TRADITIONS, traditionOf } from '@/lib/traditions'
import { setBuiltinTraditionOverride } from '@/lib/libraryTraditions'
import { ScorePlayer } from '@/lib/player'
import ScorePanel from '@/components/ScorePanel'

const PAGE = 40

// 只显示「真的有曲目」的分类，再加固定的「全部 / 我的谱」。
// 曲目只剩一首时，若把分类全列出来会是一排 0，看着像坏了。
function buildChips(library) {
  const used = new Set(library.map((s) => s.category))
  return [
    { id: 'all', name: '全部' },
    { id: 'mine', name: '我的谱' },
    ...CATEGORIES.filter((c) => c.id !== 'all' && used.has(c.id)),
  ]
}
const CHIPS = buildChips(LIBRARY)

const levelDots = (level) => (
  <span className="flex items-center gap-0.5">
    {[1, 2, 3].map((i) => (
      <span
        key={i}
        className={`h-1 w-1 rounded-full ${i <= level ? 'bg-brand' : 'bg-muted-foreground/25'}`}
      />
    ))}
  </span>
)

// 谱库页：分类、搜索、分页加载。点一首直接进跟谱页，右侧的播放键就地试听。
export default function LibraryPage({ score, onLoad, playVolume = 0.85, playTimbre = 'voice' , chordTrack, textureTrack, onRetradition }) {
  const [cat, setCat] = useState('all')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [showCustom, setShowCustom] = useState(false)
  const [mine, setMine] = useState([])
  const [mineErr, setMineErr] = useState(null)
  const [previewId, setPreviewId] = useState(null)
  // 内置曲目的传统存在只读常量 + localStorage 覆盖层里，改完要 bump 一下
  // 让列表重算，否则下拉会停在新值之前的旧值上。
  const [libVer, setLibVer] = useState(0)

  // 试听用的播放器独立于跟谱页，不改变当前载入的谱面
  const playerRef = useRef(null)
  if (!playerRef.current) playerRef.current = new ScorePlayer()

  const stopPreview = useCallback(() => {
    playerRef.current.stop()
    setPreviewId(null)
  }, [])

  const preview = useCallback(async (s) => {
    const player = playerRef.current
    if (previewId === s.id) {
      stopPreview()
      return
    }
    player.stop()
    setPreviewId(null)
    try {
      const song = await buildSong(s)
      const ok = await player.play(song, {
        fromBeat: 0,
        untilBeat: (song.bar || 4) * 4, // 听四小节，够认出一首
        volume: playVolume,
        timbre: playTimbre,
        onEnd: () => setPreviewId(null),
      })
      if (ok) setPreviewId(s.id)
    } catch (err) {
      setMineErr(err.message)
    }
  }, [previewId, playVolume, playTimbre, stopPreview])

  // 换分类、换搜索词、离开页面都停掉试听
  useEffect(() => { stopPreview() }, [cat, q, stopPreview])
  useEffect(() => { window.__libPlayer = playerRef.current }, [])
  useEffect(() => () => playerRef.current.stop(), [])

  const refreshMine = useCallback(async () => {
    try {
      setMine(await listMyScores())
      setMineErr(null)
    } catch (err) {
      setMineErr(err.message)
    }
  }, [])

  useEffect(() => { refreshMine() }, [refreshMine])

  const mineEntries = useMemo(
    () =>
      mine.map((m) => ({
        id: m.id,
        title: m.title,
        sub: '我的谱 ' + new Date(m.savedAt).toLocaleDateString('zh-CN'),
        category: 'mine',
        bpm: m.bpm,
        bar: m.bar,
        level: 2,
        parts: m.partCount || 0,
        text: m.title.toLowerCase(),
        mine: true,
        build: async () => {
          const rec = await getMyScore(m.id)
          if (!rec) throw new Error('这首已经不在本地存储里了')
          return {
            title: rec.title,
            bpm: rec.bpm,
            bar: rec.bar,
            parts: rec.parts,
            tradition: rec.tradition || 'western',
            ...(rec._xml ? { _xml: rec._xml } : {}),
          }
        },
      })),
    [mine]
  )

  // 内置曲目的传统可被覆盖层改，所以要按 libVer 重新取一次。
  const library = useMemo(() => getLibrary(), [libVer])

  const counts = useMemo(() => {
    const m = { all: library.length + mine.length, mine: mine.length }
    for (const s of library) m[s.category] = (m[s.category] || 0) + 1
    return m
  }, [library, mine.length])

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase()
    let base
    if (cat === 'mine') base = mineEntries
    else if (cat === 'all') base = [...mineEntries, ...library]
    else base = library.filter((s) => s.category === cat)
    return base.filter((s) => !query || s.text.includes(query))
  }, [cat, q, mineEntries, library])

  const shown = filtered.slice(0, limit)

  const remove = async (e, id) => {
    e.stopPropagation()
    if (!window.confirm('从我的谱中删除这首？')) return
    try {
      await deleteMyScore(id)
      await refreshMine()
    } catch (err) {
      setMineErr(err.message)
    }
  }

  // 改某一首曲子的演唱传统。
  // 传统是曲目属性（不是全局设置），所以只能逐首改。
  // 内置曲目写在只读常量里，走 localStorage 覆盖层；
  // 「我的谱」直接改 IndexedDB 记录。
  const changeTradition = async (e, entry, next) => {
    e.stopPropagation()
    try {
      if (entry.mine) {
        await setMyScoreTradition(entry.id, next)
        await refreshMine()
        // 改的正好是当前载入的这首：谱面字段与生效参数一起换
        if (score && score.title === entry.title) onRetradition && onRetradition(next)
      } else {
        setBuiltinTraditionOverride(entry.id, next)
        setLibVer((v) => v + 1)   // 触发列表重算，下拉立刻显示新值
        // 内置曲目的谱面标题常带后缀（如「欢乐颂（Ode to Joy，示范四部和声）」），
        // 不能拿 title 全等去比。用曲目 id 记录来源：载入时写入 score._libId。
        if (score && score._libId === entry.id) onRetradition && onRetradition(next)
      }
    } catch (err) {
      setMineErr(err.message)
    }
  }

  const clearMine = async () => {
    if (!window.confirm(`删除「我的谱」里的全部 ${mine.length} 首？删除后只能重新导入。`)) return
    try {
      await clearMyScores()
      await refreshMine()
    } catch (err) {
      setMineErr(err.message)
    }
  }

  return (
    <div className="h-full overflow-y-auto px-4 pb-8 pt-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setLimit(PAGE) }}
          placeholder="搜索曲名或作曲家"
          className="h-9 w-full rounded-full border border-border bg-secondary/30 pl-8 pr-8 text-[12px] outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        />
        {q && (
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground"
            aria-label="清空搜索"
            onClick={() => { setQ(''); setLimit(PAGE) }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="-mx-1 mt-2 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {CHIPS.map((c) => (
          <button
            key={c.id}
            onClick={() => { setCat(c.id); setLimit(PAGE) }}
            className={`shrink-0 rounded-full border px-3 py-1 text-[11px] transition-colors ${
              cat === c.id
                ? 'border-brand bg-brand/15 text-foreground'
                : 'border-border text-muted-foreground'
            }`}
          >
            {c.name}
            <span className="ml-1 tabular opacity-50">{counts[c.id] || 0}</span>
          </button>
        ))}
      </div>

      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>共 {filtered.length} 首</span>
        <span className="min-w-0 flex-1 truncate">当前：{score.title}</span>
        {cat === 'mine' && mine.length > 0 && (
          <button className="shrink-0 underline-offset-2 active:underline" onClick={clearMine}>
            清空
          </button>
        )}
      </div>

      {mineErr && <p className="mt-1 text-[10px] text-destructive">本地存储不可用：{mineErr}</p>}

      <div className="mt-2 space-y-1.5">
        {shown.map((s) => (
          <div key={s.id} className="flex items-start gap-2 rounded-lg border bg-card px-3 py-2">
            <div className="min-w-0 flex-1">
              {/* 载入按钮只包标题和信息，不能把 <select> 包进去：
                  嵌套在 <button> 里的表单控件收不到真实点击，下拉会打不开。 */}
              <button
                className="block w-full text-left transition-opacity active:opacity-70"
                onClick={async () => {
                  try {
                    onLoad(await buildSong(s))
                  } catch (err) {
                    setMineErr(err.message)
                  }
                }}
              >
                <span className="block truncate text-[13px] font-medium">{s.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{s.sub}</span>
              </button>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                <span className="shrink-0 whitespace-nowrap">每小节 {s.bar} 拍</span>
                <span className="shrink-0 whitespace-nowrap">{s.bpm} BPM</span>
                {/* 演唱传统是曲目属性。内置曲目存在覆盖层，我的谱直接改记录。
                    宽屏下一行放得下；窄屏允许换行，避免把「每小节 4 拍」挤成竖排。 */}
                <select
                  value={s.tradition || 'western'}
                  onChange={(e) => changeTradition(e, s, e.target.value)}
                  aria-label="演唱传统"
                  title={`演唱传统：${traditionOf(s.tradition).name}`}
                  className={`max-w-[46%] shrink rounded-full px-1.5 py-0 text-[10px] ${
                    s.tradition && s.tradition !== 'western'
                      ? 'border border-brand/40 bg-brand/10 text-brand'
                      : 'border border-input text-muted-foreground'
                  }`}
                >
                  {TRADITIONS.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <span className="shrink-0">{levelDots(s.level)}</span>
              </div>
            </div>
            <button
              className={`mt-0.5 shrink-0 rounded-full border p-1.5 transition-colors active:bg-secondary ${
                previewId === s.id ? 'border-brand bg-brand/15 text-brand' : 'text-muted-foreground'
              }`}
              aria-label={previewId === s.id ? '停止试听' : '试听'}
              onClick={(e) => {
                e.stopPropagation()
                preview(s)
              }}
            >
              {previewId === s.id ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
            {s.mine ? (
              <button
                className="mt-0.5 shrink-0 rounded-full border p-1.5 text-muted-foreground active:bg-secondary"
                aria-label="从我的谱中删除"
                onClick={(e) => remove(e, s.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : (
              <span className="mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                载入
              </span>
            )}
          </div>
        ))}
      </div>

      {cat === 'mine' && mine.length === 0 && (
        <p className="py-8 text-center text-[11px] leading-relaxed text-muted-foreground">
          还没有保存的谱面。
          <br />
          展开下方「导入或手写谱面」，可以多选文件、选整个文件夹，或者导入一个整包。
        </p>
      )}

      {filtered.length === 0 && !(cat === 'mine' && mine.length === 0) && (
        <p className="py-10 text-center text-[12px] text-muted-foreground">没有找到匹配的曲目</p>
      )}

      {filtered.length > shown.length && (
        <button
          onClick={() => setLimit((n) => n + PAGE)}
          className="mt-2 w-full rounded-lg border bg-secondary/30 py-2 text-[12px] text-muted-foreground"
        >
          显示更多，还有 {filtered.length - shown.length} 首
        </button>
      )}

      <button
        onClick={() => setShowCustom((v) => !v)}
        className="mt-3 flex w-full items-center justify-between rounded-lg border bg-card px-3 py-2 text-[12px]"
      >
        <span>导入或手写谱面</span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${showCustom ? 'rotate-180' : ''}`} />
      </button>
      {showCustom && (
        <ScorePanel
          score={score}
          onLoad={onLoad}
          onImported={async (sc) => {
            await saveMyScore(sc)
            await refreshMine()
          }}
          onImportedMany={async (list) => {
            await saveMyScores(list)
            await refreshMine()
            // 一次导入很多首时，把人带到「我的谱」，否则用户看不出发生了什么
            if (list.length > 1) {
              setCat('mine')
              setLimit(PAGE)
            }
          }}
          className="mt-2"
        />
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        内置曲目只保留《欢乐颂》一首示例（公版旋律，和声是程序生成的练习编配，不是原作和声）。
        自己的谱面走上面的「导入」或「我的谱面」。
      </p>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        「我的谱」只保存在本机浏览器存储里，不上传，也不随应用分发。导入前请确认你有权使用该谱面。
      </p>
    </div>
  )
}
