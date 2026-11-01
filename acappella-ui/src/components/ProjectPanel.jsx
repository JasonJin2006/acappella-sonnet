import { useEffect, useState } from 'react'
import { FolderOpen, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { listProjects, getProject, saveProject, deleteProject, pcmToBuffer } from '@/lib/project'
import { sharedCtx } from '@/lib/sharedCtx'

// 工程管理面板。
//
// 一个「工程」= 谱面 + 和弦轨 + 织体轨 + 力度曲线 + 录音轨 + 当前声部。
// 之前这些只活在内存里：关掉 App 录音就全丢，编配也留不下来。
//
// 这个面板放在设置页「工程」子页里。保存是增量的（同名覆盖），
// 打开会把整个状态换掉，并清空撤销栈（换工程等于换文档）。
export default function ProjectPanel({
  current,          // { title, score, chords, textures, automation, myPart, takes }
  projectId,        // 当前工程 id（null 表示还没保存过）
  onSaved,          // (id) => void
  onOpen,           // (project) => void
}) {
  const [list, setList] = useState([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [name, setName] = useState('')

  const refresh = async () => {
    try {
      setList(await listProjects())
    } catch (e) {
      setMsg('读取工程列表失败：' + (e.message || e))
    }
  }

  useEffect(() => { refresh() }, [])

  // 打开面板时把当前曲名填进输入框，方便直接「保存」
  useEffect(() => {
    if (!name && current?.title) setName(current.title)
  }, [current, name])

  const doSave = async (asNew) => {
    setBusy(true)
    setMsg(null)
    try {
      const title = (name || current?.title || '未命名').trim() || '未命名'
      const id = await saveProject({
        id: asNew ? undefined : (projectId || undefined),
        title,
        score: current.score,
        chords: current.chords,
        textures: current.textures,
        automation: current.automation,
        myPart: current.myPart,
        takes: current.takes,
      })
      onSaved && onSaved(id)
      await refresh()
      setMsg(asNew ? '已另存为新工程' : '已保存')
    } catch (e) {
      setMsg('保存失败：' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const doOpen = async (id) => {
    setBusy(true)
    setMsg(null)
    try {
      const p = await getProject(id)
      if (!p) throw new Error('工程不存在')
      // 录音轨的 PCM 解码回 AudioBuffer
      const ctx = sharedCtx()
      const takes = (p.takes || []).map((t) => ({
        ...t,
        buffer: t.pcm ? pcmToBuffer(ctx, t.pcm) : null,
        pcm: undefined,
      }))
      onOpen && onOpen({
        id: p.id,
        title: p.title,
        score: p.score,
        chords: p.chords || [],
        textures: p.textures || [],
        automation: p.automation || [],
        myPart: p.myPart || 0,
        takes,
      })
      setMsg('已打开「' + (p.title || '未命名') + '」')
    } catch (e) {
      setMsg('打开失败：' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async (id, title) => {
    setBusy(true)
    setMsg(null)
    try {
      await deleteProject(id)
      await refresh()
      setMsg('已删除「' + (title || '未命名') + '」')
    } catch (e) {
      setMsg('删除失败：' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const fmtSize = (n) => {
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }
  const fmtTime = (ts) => {
    if (!ts) return ''
    const d = new Date(ts)
    const pad = (x) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const takeCount = (current?.takes || []).filter((t) => t.buffer).length

  return (
    <div className="space-y-3 px-4 pb-8 pt-3">
      <div>
        <div className="text-[12px] font-medium">当前工程</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          工程包含谱面、和弦轨、力度曲线和 {takeCount} 条录音。只存在本机，不上传。
        </p>
      </div>

      <div className="space-y-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="工程名"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-[12px] outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex gap-1.5">
          <Button size="sm" disabled={busy} onClick={() => doSave(false)} className="flex-1">
            <Save className="h-3.5 w-3.5" />
            {projectId ? '保存' : '保存为新工程'}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !projectId} onClick={() => doSave(true)}>
            另存为
          </Button>
        </div>
      </div>

      <div className="h-px bg-border" />

      <div className="flex items-center justify-between">
        <div className="text-[12px] font-medium">全部工程（{list.length}）</div>
        <button type="button" className="text-[10px] text-brand" onClick={refresh}>刷新</button>
      </div>

      {list.length === 0 && (
        <p className="text-[11px] text-muted-foreground">还没有保存过工程。上面的「保存为新工程」会创建第一个。</p>
      )}

      <div className="space-y-1.5">
        {list.map((p) => (
          <div key={p.id} className={`rounded-lg border px-2.5 py-2 ${p.id === projectId ? 'border-brand bg-brand/10' : ''}`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium">{p.title}</div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {p.parts} 声部，{Math.round(p.beats / (p.bar || 4))} 小节
                  {p.takeCount > 0 && `，${p.takeCount} 条录音`}
                  {p.savedAt > 0 && `，${fmtTime(p.savedAt)}`}
                </div>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => doOpen(p.id)}
                aria-label={`打开工程 ${p.title}`}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground active:bg-secondary disabled:opacity-40"
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => doDelete(p.id, p.title)}
                aria-label={`删除工程 ${p.title}`}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground active:bg-secondary disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {msg && <p className="text-[11px] text-muted-foreground">{msg}</p>}
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        打开工程会替换当前编辑内容并清空撤销记录。录音按 16-bit PCM 存，一分钟单声道约 5.5 MB。
      </p>
    </div>
  )
}
