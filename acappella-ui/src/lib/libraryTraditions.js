// 内置曲目的传统覆盖。
//
// 为什么需要这一层
// ----------------
// 内置曲目写在 library.js 的 MELODY_SONGS 里，是只读的模块常量，不在
// IndexedDB 里，所以不能像「我的谱」那样直接改记录。但内置曲目同样需要
// 能标定传统——比如将来收录侗族大歌、格鲁吉亚复调这些曲目时，它们不是
// 西方功能和声。
//
// 做法：曲目自带的 tradition 是「出厂标注」，用户改过的存这里，读的时候
// 覆盖层优先。这样静态曲库不用变成可写的。
//
// 存在 localStorage 而不是 IndexedDB：这是一张很小的「id -> 传统」表，
// 渲染曲库列表时要同步读，走 IndexedDB 会变成异步，不值得。

const KEY = 'sonnet-library-tradition'

function readMap() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch (e) {
    // 隐私模式或数据坏了：当作没有覆盖
    return {}
  }
}

function writeMap(map) {
  try {
    if (Object.keys(map).length) localStorage.setItem(KEY, JSON.stringify(map))
    else localStorage.removeItem(KEY)
  } catch (e) {
    // 存不进去就只在本次会话生效，不阻塞界面
  }
}

/** 取某首内置曲目被覆盖的传统；没覆盖过返回 null */
export function getBuiltinTraditionOverride(id) {
  return readMap()[id] || null
}

/**
 * 设置内置曲目的传统。
 * 改回西方（默认）时删掉覆盖，表里不会堆无用条目。
 */
export function setBuiltinTraditionOverride(id, tradition) {
  const map = readMap()
  if (!tradition || tradition === 'western') delete map[id]
  else map[id] = tradition
  writeMap(map)
  return tradition || 'western'
}

/** 内置曲目的实际生效传统：覆盖优先，其次出厂标注，最后默认西方 */
export function resolveBuiltinTradition(entry) {
  return getBuiltinTraditionOverride(entry && entry.id) || (entry && entry.tradition) || 'western'
}
