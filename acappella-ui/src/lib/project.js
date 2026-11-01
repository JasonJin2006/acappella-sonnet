// 工程（Project）：把一次「完整的创作状态」打包存起来。
//
// 一个工程包含：
//   - 谱面（parts / bpm / bar / title）
//   - 和弦轨、织体轨、力度自动化曲线
//   - 录音轨（多轨录音的 AudioBuffer，转成 PCM 存进 IndexedDB）
//   - 当前编辑到哪个声部
//
// 为什么不复用 myScores：
//   myScores 只存「一份谱面」，是导入的原材料（可能上千首）。
//   工程是「我正在做的东西」，包含录音这种大块二进制数据，
//   两者生命周期和体量都不同，分开放更清楚。
//
// 存储策略：
//   谱面和编配覆盖：IndexedDB 里存 JSON（几 KB）
//   录音轨：AudioBuffer 转 16-bit PCM 存 ArrayBuffer（一分钟立体声 48k 约 11 MB）
//   IndexedDB 没有单条大小硬限制（配额是整体的），比 localStorage 合适得多

// 库名、版本号、建表逻辑统一放在 db.js，和 myScores.js 共用。
// 两边各自写死版本号会导致「版本低于现有版本」打不开库。
import { DB_NAME, DB_VER, ensureStores } from './db'

const STORE = 'projects'

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

// AudioBuffer → 16-bit PCM 交错 ArrayBuffer
export function bufferToPcm(buffer) {
  if (!buffer) return null
  const ch = buffer.numberOfChannels
  const frames = buffer.length
  const out = new Int16Array(frames * ch)
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c)
    for (let i = 0; i < frames; i++) {
      const v = Math.max(-1, Math.min(1, d[i]))
      out[i * ch + c] = v < 0 ? v * 0x8000 : v * 0x7fff
    }
  }
  return {
    pcm: out.buffer,
    frames,
    channels: ch,
    sampleRate: buffer.sampleRate,
  }
}

// PCM ArrayBuffer → AudioBuffer
export function pcmToBuffer(ctx, payload) {
  if (!payload || !payload.pcm) return null
  const { pcm, frames, channels, sampleRate } = payload
  const buf = ctx.createBuffer(channels, frames, sampleRate)
  const data = new Int16Array(pcm)
  for (let c = 0; c < channels; c++) {
    const dst = buf.getChannelData(c)
    for (let i = 0; i < frames; i++) {
      dst[i] = data[i * channels + c] / 32768
    }
  }
  return buf
}

/**
 * 保存工程。同名会覆盖（按 id）。
 * @param {object} project
 *   { id, title, score, chords, textures, automation, myPart, takes, savedAt }
 */
export async function saveProject(project) {
  const db = await openDb()
  const id = project.id || ('p' + Date.now() + '_' + Math.random().toString(36).slice(2, 8))
  const rec = {
    ...project,
    id,
    savedAt: Date.now(),
  }
  // 录音轨里的 AudioBuffer 不能直接存，转成 PCM
  if (Array.isArray(rec.takes)) {
    rec.takes = rec.takes.map((t) => ({
      ...t,
      buffer: undefined,
      pcm: t.buffer ? bufferToPcm(t.buffer) : null,
    }))
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(rec)
    tx.oncomplete = () => resolve(id)
    tx.onerror = () => reject(tx.error || new Error('保存失败'))
  })
}

/**
 * 列出工程摘要（不含谱面和录音，列表才不会卡）。
 */
export async function listProjects() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).openCursor()
    const out = []
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) {
        out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
        resolve(out)
        return
      }
      const r = cur.value
      out.push({
        id: r.id,
        title: r.title || '未命名',
        savedAt: r.savedAt || 0,
        parts: r.score && r.score.parts ? r.score.parts.length : 0,
        beats: sumBeats(r.score),
        bar: (r.score && r.score.bar) || 4,
        takeCount: Array.isArray(r.takes) ? r.takes.filter((t) => t.pcm).length : 0,
      })
      cur.continue()
    }
    req.onerror = () => reject(req.error || new Error('读取失败'))
  })
}

function sumBeats(score) {
  if (!score || !score.parts || !score.parts.length) return 0
  return Math.max(...score.parts.map((p) => (p.notes || []).reduce((s, n) => s + n.beats, 0)))
}

/**
 * 读取完整工程（含录音 PCM）。
 */
export async function getProject(id) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error || new Error('读取失败'))
  })
}

export async function deleteProject(id) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('删除失败'))
  })
}

/**
 * 估算工程占用的存储（字节）。用来在界面上提示「录音占了多少空间」。
 */
export function estimateSize(project) {
  if (!project) return 0
  let n = 0
  try {
    const { takes, ...rest } = project
    n += JSON.stringify(rest).length
    for (const t of takes || []) {
      if (t.pcm && t.pcm.pcm) n += t.pcm.pcm.byteLength
    }
  } catch (e) { /* 忽略 */ }
  return n
}
