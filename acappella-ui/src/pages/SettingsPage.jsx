import SettingsPanel from '@/components/SettingsPanel'

// 设置页：只放「改一次就不再碰」的偏好。
//
// 导出、工程管理（保存/打开工程）是动作不是偏好，已移出设置，见跟谱页与谱库页的入口。
// 深色模式原来飘在这页最下面单独一块，现在并入设置的「界面」子页。
export default function SettingsPage({
  settings, myPart, onChange, parts, theme, onTheme, score,
}) {
  return (
    <div className="h-full overflow-y-auto px-4 pb-8 pt-3">
      <SettingsPanel
        settings={settings}
        myPart={myPart}
        onChange={onChange}
        parts={parts}
        className="mt-0"
        theme={theme}
        onTheme={onTheme}
        score={score}
      />
    </div>
  )
}
