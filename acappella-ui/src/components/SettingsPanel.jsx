import { useState } from 'react'
import { ChevronDown, Minus, Plus } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { traditionOf, judgesPitch } from '@/lib/traditions'
import FxPanel from '@/components/FxPanel'

// 设置区只放「改一次就不再碰」的偏好。
//
// 这次重排掉的四类问题：
//   1. 位置不对：音色、音量是跟唱时随手要调的，已搬到跟谱页；
//      深色模式原来飘在设置页外面单独一块，现收进「界面」。
//   2. 重复设置：提示音色和播放音色原本是两份，还有 playTimbreTouched 的
//      隐式联动（改一个静默改另一个）。现在只有一份 timbre，两处共用。
//   3. 不属于这里：导出、工程管理是动作不是偏好，已移出设置。
//   4. 平铺堆叠：演唱页曾把「传统 / 提示音 / 定位」三个 Section 加两个 Fold
//      平铺在一屏。现在按使用频率分层，低频项才折起来，且折叠里不再套折叠。

const TABS = [
  { id: 'sing', name: '演唱' },
  { id: 'play', name: '播放' },
  { id: 'ui', name: '界面' },
  { id: 'about', name: '关于' },
]

const OCT_LABEL = ['低八度', '同度', '高八度']
const shortName = (name) => (name || '').split(' ').pop()

// 半音数写成「+3 半音」而不是「升到 X 调」：移调移的是绝对音高，
// 跟调号（几个升号）不是一回事，写「X 调」会误导。
const transposeLabel = (n) => (n ? `${n > 0 ? '+' : ''}${n} 半音` : '原调')

// 分组容器：标题 + 说明 + 内容
function Section({ title, desc, children }) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-[12px] font-medium">{title}</div>
        {desc && <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{desc}</p>}
      </div>
      <div className="space-y-2.5">{children}</div>
    </div>
  )
}

// 折叠区：低频设置收在这里，默认收起。不允许嵌套。
function Fold({ title, hint, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="overflow-hidden rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors active:bg-secondary"
        aria-expanded={open}
      >
        <span className="text-[11px] text-muted-foreground">{title}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="space-y-2.5 border-t px-3 py-2.5">
          {hint && <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p>}
          {children}
        </div>
      )}
    </div>
  )
}

function Row({ label, value, hint, children }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {value != null && <span className="text-[12px] tabular text-muted-foreground">{value}</span>}
      </div>
      {children}
      {hint && <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Toggle({ label, checked, onChange, disabled }) {
  return (
    <label className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-[12px] leading-snug">{label}</span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  )
}

export default function SettingsPanel({
  settings, myPart, onChange, parts, className, theme, onTheme, score,
}) {
  const [tab, setTab] = useState('sing')

  // 支持两种调用形式：
  //   set('metro', true)               改单个字段
  //   set(prev => ({ ...prev, ... }))  一次改多个字段
  const set = (k, v) =>
    typeof k === 'function' ? onChange(k) : onChange((prev) => ({ ...prev, [k]: v }))

  // 每个声部独立开关：可能你只在跟其中一两个声部
  const fp = settings.followParts || []
  const isOn = (i) => (fp[i] === undefined ? true : !!fp[i])
  const setPart = (i, v) => {
    const next = parts.map((_, k) => (k === i ? v : isOn(k)))
    onChange({ ...settings, followParts: next })
  }
  const onIds = parts.filter((_, i) => isOn(i)).map((p) => p.id)
  const noneOn = onIds.length === 0
  const modeOff = settings.mode === 'off'
  // 演唱传统是曲目属性，不是设置项。这里只借用它判断「跑调阈值」对当前曲目适不适用。
  const tradition = traditionOf(score && score.tradition)

  return (
    <Card className={`animate-slide-up ${className || 'mt-3'}`}>
      <CardContent className="p-3">
        <div className="-mx-1 mb-3 flex gap-1 overflow-x-auto px-1 pb-0.5">
          {TABS.map((t) => {
            const on = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-label={`设置：${t.name}`}
                className={`shrink-0 rounded-full px-3 py-1 text-[11px] transition-colors ${
                  on ? 'bg-brand text-brand-foreground' : 'border border-input text-muted-foreground'
                }`}
              >
                {t.name}
              </button>
            )
          })}
        </div>

        {/* ---------------- 演唱 ---------------- */}
        {tab === 'sing' && (
          <div className="space-y-4">
            <Section title="定位" desc="手动定位不猜位置；自动跟谱会听整个团队，但重复段落容易跳错。">
              <Select value={settings.followMode || 'manual'} onValueChange={(v) => set('followMode', v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">手动点谱面</SelectItem>
                  <SelectItem value="auto">自动听团队</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {settings.followMode === 'auto'
                  ? '边唱边听整个团队，自动判断走到哪。乐句重复时要多等一会儿才敢定位。'
                  : '点谱面任意位置定起点，之后按拍子走。唱的时候音头会自动校正节奏，也可以用右侧的加减号手动推半拍。'}
              </p>

              <Fold title={`参与定位的声部（${onIds.length}/${parts.length}）`}>
                {parts.map((p, i) => (
                  <Toggle
                    key={p.id + i}
                    label={
                      <span>
                        {p.id} <span className="text-muted-foreground">{shortName(p.name)}</span>
                        {i === myPart ? '（我）' : ''}
                      </span>
                    }
                    checked={isOn(i)}
                    onChange={(v) => setPart(i, v)}
                  />
                ))}
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  {noneOn
                    ? '全部关闭：只跟你自己的声音，跟随器不再听其他声部。'
                    : `定位只用 ${onIds.join('、')}；关闭的声部照常显示，但不参与判断。`}
                </p>
              </Fold>
            </Section>

            <Section title="提示音细节" desc="音色和音量在跟谱页随手调，这里只放不常动的。">
              <Fold title="提示音行为">
                <div className="space-y-1.5">
                  <Label>模式</Label>
                  <Select value={settings.mode} onValueChange={(v) => set('mode', v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cue">起音提示</SelectItem>
                      <SelectItem value="sustain">持续参考音</SelectItem>
                      <SelectItem value="correct">只在跑调时</SelectItem>
                      <SelectItem value="off">不发声</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Row label="提示音八度" value={OCT_LABEL[settings.oct + 1]} hint="整体升降八度，低音声部听不清时可以调低。">
                  <Slider value={[settings.oct]} min={-1} max={1} step={1} disabled={modeOff}
                    onValueChange={([v]) => set('oct', v)} />
                </Row>

                {judgesPitch(tradition.id) ? (
                  <Row label="跑调阈值" value={settings.thresh + ' 音分'}
                    hint={settings.mode === 'correct' ? '偏差超过这个值才给提示音。' : '只在「只在跑调时」模式下生效。'}>
                    <Slider value={[settings.thresh]} min={10} max={100} step={5} disabled={settings.mode !== 'correct'}
                      onValueChange={([v]) => set('thresh', v)} />
                  </Row>
                ) : (
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    当前曲目的传统是「{tradition.name}」，不判音高，跑调阈值不适用，只按节奏和位置跟进。
                  </p>
                )}

                <Row label="下一音提前" value={settings.advance + ' ms'}
                  hint={settings.nextCue ? '提前多久预告下一个音，蓝牙耳机可以加大。' : '打开「下一音预告」后生效。'}>
                  <Slider value={[settings.advance]} min={0} max={600} step={20} disabled={!settings.nextCue}
                    onValueChange={([v]) => set('advance', v)} />
                </Row>

                <Toggle label="节拍器" checked={settings.metro} onChange={(v) => set('metro', v)} />
                <Toggle label="下一音预告" checked={settings.nextCue} onChange={(v) => set('nextCue', v)} />
              </Fold>
            </Section>
          </div>
        )}

        {/* ---------------- 播放 ---------------- */}
        {tab === 'play' && (
          <div className="space-y-4">
            <Section title="音高" desc="整首一起升或降，播放和跟唱提示音同时变，跟唱判定也按新调算。">
              <Row
                label="升降调"
                value={transposeLabel(settings.transpose || 0)}
                hint="觉得整体偏高偏低时用。±12 半音，0 是原调。"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="降半音"
                    onClick={() => set('transpose', Math.max(-12, (settings.transpose || 0) - 1))}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-secondary/40"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <Slider
                    value={[settings.transpose || 0]}
                    min={-12}
                    max={12}
                    step={1}
                    onValueChange={([v]) => set('transpose', v)}
                  />
                  <button
                    type="button"
                    aria-label="升半音"
                    onClick={() => set('transpose', Math.min(12, (settings.transpose || 0) + 1))}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-secondary/40"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </Row>
              {(settings.transpose || 0) !== 0 && (
                <button
                  type="button"
                  onClick={() => set('transpose', 0)}
                  className="w-full rounded-lg border bg-secondary/30 py-2 text-[12px] text-muted-foreground"
                >
                  回到原调
                </button>
              )}
            </Section>

            <Section title="播放" desc="整谱播放的行为。音色和音量跟跟唱共用，在跟谱页调。">
              <Toggle
                label="只播我的声部"
                checked={!!settings.playOnlyMine}
                onChange={(v) => set('playOnlyMine', v)}
              />
              <Toggle
                label="低功耗模式"
                checked={!!settings.lowPower}
                onChange={(v) => set('lowPower', v)}
              />
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                低功耗会关掉混响和部分谐波。老手机或 8 声部长谱播放卡顿时打开。
              </p>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                播放和跟唱互斥：按下播放会先停掉麦克风，按下跟唱会先停掉播放。播放中点谱面可以直接跳到那一拍。
              </p>
            </Section>

            <Section title="音质" desc="混响、声像、限幅。默认值适合大多数情况。">
              <FxPanel fx={settings.fx} onChange={(v) => set('fx', v)} />
            </Section>
          </div>
        )}

        {/* ---------------- 界面 ---------------- */}
        {tab === 'ui' && (
          <div className="space-y-4">
            <Section title="界面">
              <Toggle
                label="深色模式"
                checked={theme === 'dark'}
                onChange={(v) => onTheme && onTheme(v ? 'dark' : 'light')}
              />
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                深色在排练时更不刺眼。
              </p>
            </Section>

            <Section title="谱面显示">
              <Toggle label="显示唱名" checked={!!settings.solf} onChange={(v) => set('solf', v)} />
              <Toggle label="只显示我的声部" checked={!!settings.onlyMine} onChange={(v) => set('onlyMine', v)} />
            </Section>
          </div>
        )}

        {/* ---------------- 关于 ---------------- */}
        {tab === 'about' && (
          <div className="space-y-4">
            <div className="rounded-lg border bg-card p-3">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[13px] font-medium text-foreground">十四行</span>
                <span className="text-[11px] tracking-wide text-muted-foreground">Sonnet</span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">听见整队，唱准自己</p>
            </div>
            <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
              阿卡贝拉实时跟谱提示工具。音频只在本机处理，不上传。
              「我的谱」保存在本机浏览器存储里，不随应用分发。
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
