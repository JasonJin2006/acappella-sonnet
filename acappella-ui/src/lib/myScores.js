// 我的谱：用户自己导入的谱面，只存本机 IndexedDB，不上传、不随应用分发。
// 这样现代歌曲可以由用户自己提供谱面，应用本身不收录受版权保护的内容。
//
// 注意 open() 的版本号必须跟着 project.js 一起走，不能各写各的。
// 这里原本写死 version 1，而 project.js 用 version 2 打开同一个 'sonnet' 库：
// 只要用户先碰过「工程」（把库升到 v2），再回谱库就会报
// 「The requested version (1) is less than the existing version (2)」，
// 整个「我的谱」直接不可用。所以两边统一用 DB_VER 常量。
import { DB_NAME, DB_VER, ensureStores } from './db'

const STORE = 'myScores'
let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持本地存储'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VER)
    req.onupgradeneeded = () => ensureStores(req.result)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('本地存储打开失败'))
  })
  return dbPromise
}

// 列表只返回摘要：整包导入后可能有上千首，把 parts 一起读出来要占几十兆，
// 打开谱库会明显卡顿。整份谱面在用户点开时再由 getMyScore 取。
export async function listMyScores() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).openCursor()
    const out = []
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) {
        // 同一批导入的时间戳相同，再按曲名排，列表才稳定
        out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0) || String(a.title).localeCompare(String(b.title), 'zh-CN'))
        resolve(out)
        return
      }
      const r = cur.value
      out.push({
        id: r.id,
        title: r.title,
        bpm: r.bpm,
        bar: r.bar,
        savedAt: r.savedAt,
        partCount: Array.isArray(r.parts) ? r.parts.length : 0,
        // 列表里要显示传统，摘要得带上
        tradition: r.tradition || 'western',
      })
      cur.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

export async function getMyScore(id) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

// 改某一首曲子的演唱传统。
// 传统是曲目属性（见 lib/traditions.js），所以只能一首一首改，不能全局切。
export async function setMyScoreTradition(id, tradition) {
  const db = await openDb()
  const rec = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
  if (!rec) throw new Error('这首已经不在本地存储里了')
  rec.tradition = tradition || 'western'
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).put(rec)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
  return rec.tradition
}

function newId() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function putAll(db, recs) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const r of recs) store.put(r)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('写入本地存储失败'))
    tx.onabort = () => reject(tx.error || new Error('写入被中断，可能是本地存储空间不足'))
  })
}

// 同名谱面覆盖旧记录，避免反复导入同一个文件时列表里堆一串。
// 批量导入必须走这个函数：逐条 saveMyScore 会每次都全表读一遍，几百首就是几十秒。
export async function saveMyScores(scores) {
  const list = Array.isArray(scores) ? scores.filter(Boolean) : []
  if (!list.length) return []
  const db = await openDb()
  let all = []
  try {
    all = await listMyScores()
  } catch (e) {
    all = []
  }
  const idByTitle = new Map(all.map((s) => [s.title, s.id]))
  const now = Date.now()
  const recs = list.map((score, i) => {
    const title = score.title || '未命名谱面'
    const id = idByTitle.get(title) || newId()
    idByTitle.set(title, id)
    const rec = {
      id,
      title,
      bpm: score.bpm,
      bar: score.bar,
      parts: score.parts,
      // 传统跟着曲目存档，取回时才知道该用哪套判定
      tradition: score.tradition || 'western',
      // 同一批里保持包内顺序，后面按 savedAt 倒序时不会乱
      savedAt: now - i,
    }
    if (score._xml) rec._xml = score._xml
    return rec
  })
  try {
    await putAll(db, recs)
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') throw new Error('本地存储空间不足，导入包太大')
    throw err
  }
  return recs
}

export async function saveMyScore(score) {
  const [rec] = await saveMyScores([score])
  return rec
}

export async function deleteMyScore(id) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function clearMyScores() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
