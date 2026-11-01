import { Suspense, lazy, useState } from 'react'
import { CREATE_TABS } from '@/components/BottomNav'

const HumStage = lazy(() => import('@/components/HumStage'))
const RecStage = lazy(() => import('@/components/RecStage'))
const LibraryPage = lazy(() => import('@/pages/LibraryPage'))
const ExportPanel = lazy(() => import('@/components/ExportPanel'))
const ProjectPanel = lazy(() => import('@/components/ProjectPanel'))

// 「创作」域：谱面的输入与产出。
//
// 输入：哼唱 / 录音 / 谱库（把谱面弄进应用）
// 产出：导出 / 工程（把谱面变成文件、存档、取回）
//
// 「导出」和「工程」原本挂在设置页里，占着两个子页。它们不是偏好设置，
// 是动作，放设置里既难找也不合语义。现在归到创作域。
//
// 子页用顶部胶囊切换，和设置页的子页样式一致。
export default function CreatePage(props) {
  const [tab, setTab] = useState('hum')

  return (
    <div className="flex h-full flex-col">
      {/* 标签栏：改用换行（flex-wrap）而不是横向滚动。
          原因：「创作」有 5 个标签（哼唱/录音/谱库/导出/工程），
          在手机宽度下横排会溢出——实测「工程」被切掉半截，而且横向滚动容器上
          的右内边距会被裁切、按钮还会被 flex 压成两行文字。
          换行后每个标签都完整可见、可点，代价只是多占一行高度。
          横向滚动的场景见 FollowPage 的工具栏（那里按钮小，能滚得动）。 */}
      <div className="flex shrink-0 flex-wrap gap-1 px-4 pt-2 pb-1.5">
        {CREATE_TABS.map(([key, label, Icon]) => {
          const on = tab === key
          return (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-label={`创作：${label}`}
              className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-[11px] transition-colors ${
                on ? 'bg-brand text-brand-foreground' : 'border border-input text-muted-foreground'
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {label}
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Suspense fallback={null}>
          {tab === 'hum' && <HumStage {...props.hum} />}
          {tab === 'rec' && <RecStage {...props.rec} />}
          {tab === 'library' && <LibraryPage {...props.library} />}
          {tab === 'export' && (
            props.export?.score
              ? <ExportPanel score={props.export.score} settings={props.export.settings} />
              : <p className="px-4 py-4 text-[11px] text-muted-foreground">还没有加载谱面。</p>
          )}
          {tab === 'project' && <ProjectPanel {...props.project} />}
        </Suspense>
      </div>
    </div>
  )
}
