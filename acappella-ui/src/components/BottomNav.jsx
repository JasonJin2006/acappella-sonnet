import { AudioLines, FileDown, FolderOpen, Library, Mic, Music4, PenLine, Settings2 } from 'lucide-react'

// 底部导航按「功能域」分，不按「操作」分。
//
// 之前是 5 个平级入口：跟谱 / 哼唱 / 录音 / 谱库 / 设置。
// 问题是它们的层级其实不平等：
//   - 「哼唱」和「录音」都是「把声音变成谱面」，终点都是回跟谱页练唱
//   - 「谱库」是「找一首谱」，终点也是回跟谱页
//   - 只有「跟谱」和「设置」是常驻的
// 平铺五个入口，让人以为它们是五件独立的事，其实三个只是输入方式。
//
// 现在分三层：
//   练唱  —— 常驻主界面
//   创作  —— 获得谱面的三种途径：哼唱 / 录音 / 谱库
//   设置  —— 偏好
//
// 「创作」进入后是一个子页导航，各途径平铺。

// 一级导航：三个功能域
const GROUPS = [
  ['sing', '练唱', Music4],
  ['create', '创作', PenLine],
  ['settings', '设置', Settings2],
]

// 创作域下的子页
// 「导出」和「工程」原本挂在设置页里，但它们是动作不是偏好：
// 导出是把当前谱面变成文件，工程是把当前编辑状态存档 / 取回，
// 都属于「产出」这一侧，所以挪到创作域。
export const CREATE_TABS = [
  ['hum', '哼唱', AudioLines, '对着麦克风哼一段，自动转成谱面'],
  ['rec', '录音', Mic, '分声部各录一条，自动对齐到谱面'],
  ['library', '谱库', Library, '内置示例与我的谱面'],
  ['export', '导出', FileDown, '导出 MIDI / WAV / MP3 / MusicXML'],
  ['project', '工程', FolderOpen, '把谱面与录音存档，或取回之前的工程'],
]

// locked 用于录音/哼唱进行中锁住跳转，避免半截录音被丢掉。
export default function BottomNav({ group, onChange, running, locked }) {
  return (
    <nav className="shrink-0 border-t bg-card pb-[env(safe-area-inset-bottom)]">
      <div className="flex h-14">
        {GROUPS.map(([key, label, Icon]) => {
          const active = group === key
          return (
            <button
              key={key}
              onClick={() => { if (!locked) onChange(key) }}
              disabled={locked}
              aria-label={label}
              className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors disabled:opacity-40 ${
                active ? 'text-brand' : 'text-muted-foreground'
              }`}
            >
              <span className="relative">
                <Icon className="h-5 w-5" />
                {/* 练唱页在后台运行时给个点，切到创作页也知道还在跟 */}
                {key === 'sing' && running && !active && (
                  <span className="absolute -right-1.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[#2dd4bf]" />
                )}
              </span>
              <span>{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
