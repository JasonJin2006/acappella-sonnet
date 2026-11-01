// 演唱传统档案。
//
// 世界各地有大量多声部民歌，它们的区别不只是"唱什么音"，而是四件事：
// 声部怎么分层、用什么律、时间怎么走、值不值得判音准。
// 这个文件把差异写成数据，界面据此调整提示方式与判定标准。
//
// texture 取以下几类：
//   functional 功能和声：三度叠置、按调性走（西方四部、Sacred Harp）
//   drone      持续低音：一个声部长时间保持主音，其他声部在其上走
//   hetero     支声：几个声部唱同一旋律的不同变体，时分时合
//   parallel   平行音程：两声部保持固定音程同向移动
//   hocket     互锁：声部交替填空，单看都是碎片，合起来才成旋律或节奏
//   overtone   泛音：靠泛音列叠置，音高不是平均律里的点
//
// judgment 决定这个传统里"准"该怎么判：
//   cents     按十二平均律算音分（西方功能和声适用）
//   band      只看是否落在容忍带内，不追究精确音分
//   stability 只看持续音稳不稳，不看偏离多少
//   rhythm    只判节奏与位置，不判音高

export const TRADITIONS = [
  {
    id: 'western',
    name: '西方四部和声',
    region: '欧洲教堂与合唱传统',
    voices: '4 声部',
    texture: 'functional',
    time: 'metered',
    reference: 'cue',
    tolerance: 25,
    judgment: 'cents',
    note: '按十二平均律判音准，声部间避免平行五八度。应用默认就工作在这个传统上。',
  },
  {
    id: 'dong',
    name: '侗族大歌',
    region: '贵州 广西 湖南',
    voices: '2 声部，众低独高',
    texture: 'drone',
    time: 'free',
    reference: 'drone',
    tolerance: 60,
    judgment: 'stability',
    note: '低音部在 la 上长时间持续，高音部在其上变唱，两者节奏基本同步。徵音本身游移，高音 sol 略低、低音 sol 略高，用平均律判会把风格判成错误。',
  },
  {
    id: 'georgian',
    name: '格鲁吉亚复调',
    region: '高加索',
    voices: '3 声部',
    texture: 'drone',
    time: 'free',
    reference: 'drone',
    tolerance: 35,
    judgment: 'band',
    note: '低音持续托底，上两声部即兴加花。Guria 一带最高声部用约德尔式的假声，音区跳得很大。',
  },
  {
    id: 'sardinian',
    name: '撒丁岛 tenore',
    region: '意大利撒丁岛',
    voices: '4 声部',
    texture: 'drone',
    time: 'metered',
    reference: 'drone',
    tolerance: 40,
    judgment: 'band',
    note: '四人各司其职，bassu 用喉音唱低音，是整套声音的地基。和声以五度、三度叠置，靠音色融合而不是精确音分。',
  },
  {
    id: 'albanian',
    name: '阿尔巴尼亚 iso 复调',
    region: '巴尔干',
    voices: '2 到 3 声部',
    texture: 'drone',
    time: 'free',
    reference: 'drone',
    tolerance: 45,
    judgment: 'band',
    note: 'iso 是持续不断的低音，旋律在其上展开。南部两声部，中部三声部，拖腔很长。',
  },
  {
    id: 'mongolian',
    name: '蒙古潮尔',
    region: '内蒙古 蒙古国',
    voices: '2 声部',
    texture: 'overtone',
    time: 'free',
    reference: 'drone',
    tolerance: 50,
    judgment: 'stability',
    note: '低音是长持续音，高音用泛音唱出旋律，音高来自泛音列而不是平均律。',
  },
  {
    id: 'bulgarian',
    name: '保加利亚女声',
    region: '巴尔干',
    voices: '2 到 3 声部',
    texture: 'drone',
    time: 'metered',
    reference: 'drone',
    tolerance: 45,
    judgment: 'band',
    note: '持续音上叠出大二度，装饰音密集，听感尖锐但内部极稳。',
  },
  {
    id: 'icelandic',
    name: '冰岛 tvísöngur',
    region: '北欧',
    voices: '2 声部',
    texture: 'parallel',
    time: 'metered',
    reference: 'start',
    tolerance: 30,
    judgment: 'band',
    note: '两声部保持平行五度同向移动，音程本身就是形式，不需要第三个声部填空。',
  },
  {
    id: 'bunun',
    name: '布农族 pasibutbut',
    region: '中国台湾',
    voices: '多声部',
    texture: 'overtone',
    time: 'free',
    reference: 'drone',
    tolerance: 60,
    judgment: 'stability',
    note: '祈祷小米丰收歌，靠泛音叠置形成和弦，音高随泛音列缓慢张开，没有固定音阶可依。',
  },
  {
    id: 'isicathamiya',
    name: '南非 isicathamiya',
    region: '南非',
    voices: '4 声部',
    texture: 'functional',
    time: 'metered',
    reference: 'start',
    tolerance: 30,
    judgment: 'cents',
    note: '亲密和声加呼应，音量克制，重在咬字和律动，和声语言接近西方但更依赖三度。',
  },
  {
    id: 'sacredharp',
    name: 'Sacred Harp',
    region: '美国南部',
    voices: '4 声部',
    texture: 'functional',
    time: 'metered',
    reference: 'start',
    tolerance: 35,
    judgment: 'cents',
    note: '围坐方阵、不排练、无伴奏，靠开放五度撑起音墙，音准随时间漂移也不影响效果。',
  },
  {
    id: 'kecak',
    name: '印尼 kecak',
    region: '巴厘岛',
    voices: '多人',
    texture: 'hocket',
    time: 'free',
    reference: 'none',
    tolerance: 0,
    judgment: 'rhythm',
    note: '只有节奏互锁，没有旋律，靠不同音节的交替形成密度。这个模式下应用只判节奏和位置。',
  },
  {
    id: 'inuit',
    name: '因纽特 katajjaq',
    region: '北极圈',
    voices: '2 人',
    texture: 'hocket',
    time: 'free',
    reference: 'none',
    tolerance: 0,
    judgment: 'rhythm',
    note: '两人面对面互相接话的喉音游戏，节奏交替、气息极短，没有固定音高。',
  },
]

export const TEXTURE_LABEL = {
  functional: '功能和声',
  drone: '持续低音',
  hetero: '支声',
  parallel: '平行音程',
  hocket: '节奏互锁',
  overtone: '泛音',
}

export const JUDGMENT_LABEL = {
  cents: '按音分判准',
  band: '只看容忍带',
  stability: '只判持续音是否稳',
  rhythm: '只判节奏与位置',
}

export const TRADITION_MAP = Object.fromEntries(TRADITIONS.map((t) => [t.id, t]))

export function traditionOf(id) {
  return TRADITION_MAP[id] || TRADITION_MAP.western
}

// 传统是「曲目属性」，不是全局设置。
//
// 之前它是 settings.tradition：一个全局开关，切一首侗族大歌会把所有歌都变成
// 侗族判定，而且切换时 settingsFor() 还会覆盖用户手调的跑调阈值。
// 但传统描述的是「这首曲子属于哪种多声部传统」，普通歌曲不会因为你想换口味
// 就变成侗族大歌。所以它跟着曲目走。
//
// 应用之所以收录这些传统，是因为收录了那些曲风——不是为了给每首歌换判定方式。

/** 取某个谱面的传统 id；谱面没标就是西方四部和声 */
export function traditionOfScore(score) {
  return traditionOf(score && score.tradition).id
}

/**
 * 把传统落到实际生效的判定参数上。
 *
 * 引擎本身不读 tradition：它只认 settings 里的 thresh 等数值。
 * 所以由调用方在「载入曲目」时用这个函数把曲目的传统换算成一份 settings 补丁。
 */
export function settingsPatchForScore(score, settings) {
  const tr = traditionOf(score && score.tradition)
  // 不判音高的传统（kecak、因纽特）tolerance 是 0，这时候不能写 thresh：
  // 0 在 UI 上是合法值（要求严到零偏差）但在这里表示「不适用」，
  // 用 `tr.tolerance || settings.thresh` 会让它退回旧值，语义就乱了。
  const patch = {
    // 自由节拍的传统（侗族大歌、格鲁吉亚等）默认关掉节拍器
    metro: tr.time === 'metered' ? settings.metro : false,
  }
  if (tr.tolerance > 0) patch.thresh = tr.tolerance
  return patch
}

// 这个传统是否值得显示音分指针
export function judgesPitch(id) {
  const j = traditionOf(id).judgment
  return j === 'cents' || j === 'band' || j === 'stability'
}

// 引擎是否应该按音分给反馈。rhythm 类传统（kecak、因纽特）只判节奏与位置，
// 不该拿音分去判它对错。
export function judgesCents(id) {
  return traditionOf(id).judgment === 'cents'
}
