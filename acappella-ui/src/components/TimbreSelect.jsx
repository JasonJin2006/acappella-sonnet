import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TIMBRE_GROUPS, TIMBRE_COMFORT } from '@/lib/cue'

// 音色选择器。
//
// 原来这个下拉长在设置页里，而且拆成两份（提示音色 / 播放音色），
// 还有一个 playTimbreTouched 的隐式联动：改提示音色会静默改掉播放音色，
// 除非之前单独动过播放音色。用户没法预期哪个会被改。
// 现在只有一份音色，跟随唱提示音和整谱播放共用，放在跟谱页随手就能调。

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

function midiRangeLabel([lo, hi]) {
  const name = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1)
  return `${name(lo)}–${name(hi)}`
}

/**
 * @param {string} value 音色 id
 * @param {(v: string) => void} onChange
 * @param {boolean} disabled
 * @param {number[]} [range] 当前谱面音域 [lo, hi]，超出音色舒适区时给提示
 */
export default function TimbreSelect({ value, onChange, disabled, range }) {
  const comfort = TIMBRE_COMFORT[value]
  let warn = null
  if (range && range.length && comfort) {
    const lo = Math.min(...range)
    const hi = Math.max(...range)
    if (lo < comfort[0] - 6 || hi > comfort[1] + 6) warn = '超出音色音域'
  }
  return (
    <div className="space-y-1">
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TIMBRE_GROUPS.map((g) => (
            <SelectGroup key={g.id}>
              <SelectLabel>{g.name}</SelectLabel>
              {g.items.map(([k, n]) => {
                const c = TIMBRE_COMFORT[k]
                return (
                  <SelectItem key={k} value={k}>
                    {n}
                    {c && <span className="ml-2 text-[10px] text-muted-foreground">{midiRangeLabel(c)}</span>}
                  </SelectItem>
                )
              })}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {warn && <p className="text-[10px] text-amber-500">{warn}，采样会被拉伸，建议换一个覆盖更宽的音色。</p>}
    </div>
  )
}
