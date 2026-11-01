import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { DEFAULT_FX } from '@/lib/fx'

// 效果器参数面板。
//
// 全部参数都用 0..100 的百分比暴露，内部换算成 dB / 秒 / 倍率（见 fx.js）。
// 直接给普通用户看「-7 dB / 3:1」没有意义。
//
// props.fx 缺失时用 DEFAULT_FX——老用户存在 localStorage 里的 settings
// 没有这些字段，不能让面板崩掉。

function Row({ label, value, hint, children }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-[12px] tabular text-muted-foreground">{value}</span>
      </div>
      {children}
      {hint && <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

const pct = (v) => Math.round((v == null ? 0 : v) * 100) + '%'

export default function FxPanel({ fx, onChange }) {
  const f = { ...DEFAULT_FX, ...(fx || {}) }
  const set = (k, v) => onChange({ ...f, [k]: v })

  // 混响时长的秒数显示（和 fx.js 的映射保持一致）
  const reverbSec = (0.6 + f.reverbTime * 3.4).toFixed(1)
  const thresholdDb = (-24 + f.limiterThreshold * 24).toFixed(0)
  const ratioVal = (1 + f.limiterRatio * 9).toFixed(0)

  return (
    <div className="space-y-2.5">
      <Row label="混响量" value={pct(f.reverbMix)} hint="0 是干声，越大空间感越强。四个声部干叠在一起会显得很薄，留一点混响更像合唱。">
        <Slider value={[Math.round(f.reverbMix * 100)]} min={0} max={100} step={5}
          onValueChange={([v]) => set('reverbMix', v / 100)} />
      </Row>

      <Row label="混响时长" value={`${reverbSec} 秒`} hint="礼堂大约 2 秒，教堂 4 秒以上。超过 3 秒时手机的混响计算会更吃 CPU。">
        <Slider value={[Math.round(f.reverbTime * 100)]} min={0} max={100} step={5}
          onValueChange={([v]) => set('reverbTime', v / 100)} />
      </Row>

      <Row label="声像宽度" value={pct(f.panWidth)} hint="0 是全部居中（单声道感），100 是从左到右铺满。声部越多越宽，方向感越强。">
        <Slider value={[Math.round(f.panWidth * 100)]} min={0} max={100} step={5}
          onValueChange={([v]) => set('panWidth', v / 100)} />
      </Row>

      <Row label="限幅阈值" value={`${thresholdDb} dB`} hint="多声部叠加时的安全阀。阈值越低越不容易削顶，但也更容易把强的地方压平。">
        <Slider value={[Math.round(f.limiterThreshold * 100)]} min={0} max={100} step={5}
          onValueChange={([v]) => set('limiterThreshold', v / 100)} />
      </Row>

      <Row label="限幅比" value={`${ratioVal}:1`} hint="超过阈值后压多少。3:1 是温和的合唱限幅，10:1 接近砖墙。">
        <Slider value={[Math.round(f.limiterRatio * 100)]} min={0} max={100} step={5}
          onValueChange={([v]) => set('limiterRatio', v / 100)} />
      </Row>

      <Row label="输出增益" value={pct(f.outputGain / 1.5)} hint="整体推高或衰减。导出前还有一步峰值归一化，这个值主要影响试听的响度。">
        <Slider value={[Math.round((f.outputGain / 1.5) * 100)]} min={0} max={100} step={5}
          onValueChange={([v]) => set('outputGain', (v / 100) * 1.5)} />
      </Row>

      <button
        type="button"
        className="w-full rounded border border-input py-1.5 text-[11px] text-muted-foreground hover:bg-secondary"
        onClick={() => onChange({ ...DEFAULT_FX })}
      >
        恢复默认（混响 40% / 1.8 秒 / 声像铺满 / 3:1）
      </button>
    </div>
  )
}
