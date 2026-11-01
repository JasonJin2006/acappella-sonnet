// PDF 谱面识别：把 PDF 交给服务器上的 Audiveris，拿回 MusicXML。
//
// 为什么放到服务器
// ----------------
// PDF 里只有图形，没有音符数据。浏览器和 WebView 里没有 OMR 引擎，
// Audiveris 是 Java 桌面程序（GPL-3.0），塞不进 APK。
//
// 服务地址
// --------
// 公网 HTTPS：https://101.43.109.115:443
// 证书是自签的，已固定进 APK（res/raw/sonnet_omr_ca.pem），手机上不用装证书。
// 以前只能走 SSH 隧道（127.0.0.1），现在手机在任何网络下都能直接用。
//
// 鉴权
// ----
// 公网服务必须带 token，否则任何人都能拿这台机器跑 Audiveris（吃满内存）。
// token 放在下面的 TOKEN 常量里，随 APK 分发——这是一个「够用就好」的选择：
// 它挡住的是扫端口的爬虫和随手试试的人，挡不住专门逆向 APK 的人。
// 真要防住后者，得做账号体系。
//
// 新服务端字段（客户端全部按「可以没有」处理）
// --------------------------------------------
// GET /omr/<id> 新增：
//   phase     "queued" | "preflight" | "recognise 4/24" | "export" | "done"
//   progress  0..1
//   timings   { upload, queueWait, pageCount, preflight, recognise, export, parse, total }（毫秒）
//   pages     PDF 页数（页数探测完成后才有）
// 老服务没有这些字段，仍然按 status（queued/running/done/error）工作。
//
// 等待策略
// --------
// 排队时 2~4 秒查一次，识别收尾时 0.7 秒查一次；网络抖动/5xx/超时自动重试
// 3 次。任务在服务端保留 1 小时，所以掉一次线不等于要重新上传。

const BASE = 'https://101.43.109.115:443'
const TOKEN = '3901b08123ffd3c6c63fef2e188e05bf27d47a5eab48ef82'

const POLL_MS = 1500              // 老服务器没有 progress 时的兜底节奏
const QUEUED_SLOW_MS = 4000       // 前面排了 4 个以上
const QUEUED_MS = 2500            // 前面排了 2~3 个
const NEXT_IN_QUEUE_MS = 2000     // 下一个就轮到
const RUNNING_MS = 1200           // 识别中，还看不到收尾信号
const NEAR_DONE_MS = 700          // 正在导出/解析，或进度 >= 75%
const NEAR_DONE_PROGRESS = 0.75
const MAX_POLLS = 2000            // 防御性上限；正常 20 分钟内不会撞到

const TIMEOUT_MS = 20 * 60 * 1000
const STATUS_TIMEOUT_MS = 15 * 1000
const XML_TIMEOUT_MS = 30 * 1000
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000

const MAX_TRANSIENT_RETRIES = 3
const RETRY_BASE_MS = 800
// 服务端按「整个 multipart 请求体」卡 40MB（Content-Length），不是文件净大小。
// 留 128KB 给边界和头部，免得一个恰好 40MB 的文件在本地过关、上传完才被 413。
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024 - 128 * 1024

// 上一次成功任务的耗时（毫秒）。只用于给排队位次一个粗略 ETA；
// 页面刷新后自然丢掉，不做持久化。老服务器完成时也有 seconds，能用。
let lastJobMs = null

function authHeaders(extra) {
  const h = { ...(extra || {}) }
  // 保持原有行为：只有 TOKEN 被换成非默认值时才带 X-Token。
  // （默认值是否发送是部署侧的取舍，不在本次性能改动里改。）
  // TODO(deploy): 若服务器 token.txt 恰好等于下面这个默认串，这行会让每个请求
  // 都不带 X-Token 而拿到 401（上传和轮询都坏）。部署前在服务器上 `cat
  // ~/sonnet-omr/token.txt` 比对；相同就删掉 `!==` 条件并重新打 APK。
  if (TOKEN && TOKEN !== '3901b08123ffd3c6c63fef2e188e05bf27d47a5eab48ef82') h['X-Token'] = TOKEN
  return h
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('已取消', 'AbortError')
  const e = new Error('已取消')
  e.name = 'AbortError'
  return e
}

function isAbortError(e) {
  return !!e && (e.name === 'AbortError' || e.code === 20)
}

/** 等一会儿，但 AbortController 一按就立刻退出。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError())
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    const cleanup = () => {
      if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, ms))
    if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true })
    // 检查完 aborted 到挂上监听之间也可能刚好取消，补一次。
    if (signal && signal.aborted) onAbort()
  })
}

/**
 * 带单次请求超时、并能和调用方 AbortSignal 合并的 fetch。
 * consume 在超时定时器还生效时读响应体，避免「响应头回来了、body 卡住」
 * 躲过 15 秒超时。外部主动取消仍然抛 AbortError；自身超时抛 code=TIMEOUT。
 */
async function fetchWithTimeout(url, init, timeoutMs, consume) {
  const outside = init && init.signal
  if (outside && outside.aborted) throw abortError()
  const ctl = new AbortController()
  let timedOut = false
  const onAbort = () => {
    try { ctl.abort() } catch (e) { /* 已经结束 */ }
  }
  if (outside && outside.addEventListener) outside.addEventListener('abort', onAbort, { once: true })
  // 检查完 aborted 到挂上监听之间也可能刚好取消，补一次。
  if (outside && outside.aborted) onAbort()
  const timer = setTimeout(() => {
    timedOut = true
    onAbort()
  }, timeoutMs)
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal })
    return consume ? await consume(r) : r
  } catch (e) {
    if (outside && outside.aborted) throw abortError()
    if (timedOut) {
      const err = new Error('请求超时')
      err.code = 'TIMEOUT'
      throw err
    }
    if (isAbortError(e)) {
      const err = new Error('连接中断')
      err.code = 'NETWORK'
      throw err
    }
    throw e
  } finally {
    clearTimeout(timer)
    if (outside && outside.removeEventListener) outside.removeEventListener('abort', onAbort)
  }
}

async function readJsonResponse(r) {
  const text = await r.text()
  if (!text) {
    const err = new Error('服务器返回了空内容')
    err.code = 'BAD_BODY'
    throw err
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    const err = new Error('服务器返回的内容不完整')
    err.code = 'BAD_BODY'
    throw err
  }
}

/** 轮询响应必须是带 status 字符串的对象，否则按可重试的坏响应处理。 */
async function readStatusResponse(r) {
  const j = await readJsonResponse(r)
  if (!j || typeof j !== 'object' || typeof j.status !== 'string') {
    const err = new Error('服务器返回的任务状态不完整')
    err.code = 'BAD_BODY'
    throw err
  }
  return j
}

async function readTextResponse(r) {
  const text = await r.text()
  if (!text) {
    const err = new Error('服务器返回了空内容')
    err.code = 'BAD_BODY'
    throw err
  }
  return text
}

async function readErrorBody(r) {
  let text = ''
  try { text = await r.text() } catch (e) { /* 连错误内容都没读到，按状态码处理 */ }
  if (!text) return ''
  try {
    const j = JSON.parse(text)
    return j.error || j.message || text
  } catch (e) {
    return text.slice(0, 300)
  }
}

/** 把服务端错误文本翻成用户能照着做的中文。 */
function friendlyServerError(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return '未知错误'
  const low = s.toLowerCase()

  if (low.includes('unauthorized') || low.includes('x-token') || low.includes('识别码')) {
    return '识别码无效：请更新应用'
  }
  if (low.includes('每小时最多') || low.includes('rate limit') || low.includes('too many') || low.includes('429')) {
    return '今天用得太频繁了，过一小时再试'
  }
  if (low.includes('队列已满') || low.includes('queue is full') || low.includes('503')) {
    return '服务器正在忙（队列已满），过几分钟再试'
  }
  if (low.includes('too large') || low.includes('40mb') || low.includes('413')) {
    return 'PDF 超过服务器 40 MB 上限，请先压缩，或按乐章/分册拆开再传'
  }
  if (low.includes('not a pdf') || low.includes('empty body')) {
    return '选中的文件不是有效的 PDF，请重新选择'
  }
  if (low.includes('no such job') || low.includes('job not found') || low.includes('过期')) {
    return '任务不存在或已过期（服务器只保留 1 小时），请重新上传'
  }

  const pageLimit = s.match(/超过上限\s*(\d+)\s*页/)
  if (pageLimit) {
    return `这份 PDF 超过服务器 ${pageLimit[1]} 页上限，请按乐章或分册拆开再传`
  }
  if (low.includes('找不到 audiveris') || low.includes('pdf_to_score.py') || low.includes('audiveris')) {
    return '服务器上的识别引擎暂时不可用，请过一会儿再试'
  }
  if (
    low.includes('no page could be recognised') ||
    low.includes('no system found') ||
    low.includes('没有产出') ||
    low.includes('识别失败')
  ) {
    return '没能从这份 PDF 里认出谱面：可能是扫描太模糊、页面空白，或者不是乐谱。换一份清晰的 PDF，或先裁掉封面和空白页再试'
  }
  if (low.includes('没有生成 musicxml')) {
    return '识别完成但没能生成 MusicXML，请换一份 PDF 再试'
  }
  if (low.includes('timed out') || low.includes('timeout') || low.includes('超时')) {
    return '识别服务器响应超时，请稍后再试'
  }

  // 保留服务端的原始原因，但去掉 Python 的 RuntimeError: 前缀，读起来干净些。
  return s.replace(/^(?:[A-Za-z_]*Error|[A-Za-z_]*Exception):\s*/, '')
}

function httpErrorMessage(status, detail) {
  if (status === 401) return '识别码无效：请更新应用'
  if (status === 429) return '今天用得太频繁了，过一小时再试'
  if (status === 503) return '服务器正在忙（队列已满），过几分钟再试'
  if (status === 404) return '任务不存在或已过期（服务器只保留 1 小时），请重新上传'
  if (status === 409) return '任务还没准备好（HTTP 409），请稍后重试'
  if (status === 413) return 'PDF 超过服务器 40 MB 上限，请先压缩，或按乐章/分册拆开再传'
  if (status === 400) return detail ? friendlyServerError(detail) : '服务器没接受这份文件，请确认是有效的 PDF'
  if (status >= 500) return `服务器暂时出错（HTTP ${status}），请过几分钟再试`
  return `服务器返回 HTTP ${status}${detail ? '：' + detail : ''}`
}

function makeHttpError(status, detail) {
  const err = new Error(httpErrorMessage(status, detail))
  err.httpStatus = status
  err.detail = detail || ''
  // 401/404/409/429 以及其它 4xx 都不能重试；5xx 可以。
  err.noRetry = status < 500
  return err
}

function retryReason(err) {
  if (err && err.httpStatus) return `服务器暂时出错（HTTP ${err.httpStatus}）`
  if (err && err.code === 'BAD_BODY') return '服务器返回的内容不完整'
  if (err && (err.code === 'TIMEOUT' || /超时/.test(err.message || ''))) return '和服务器通信超时'
  return '网络连接中断'
}

function exhaustedError(lastErr) {
  const badBody = lastErr && lastErr.code === 'BAD_BODY'
  const timeout = lastErr && (lastErr.code === 'TIMEOUT' || /超时/.test(lastErr.message || ''))
  const err = new Error(badBody
    ? `服务器返回的数据不完整，已自动重试 ${MAX_TRANSIENT_RETRIES} 次仍失败。任务可能还在服务器上（保留 1 小时），请稍后再试`
    : timeout
      ? `和服务器通信超时，已自动重试 ${MAX_TRANSIENT_RETRIES} 次仍没响应。任务可能还在服务器上（保留 1 小时），请检查网络后再试`
      : `网络不稳定，已自动重试 ${MAX_TRANSIENT_RETRIES} 次仍没连上服务器。任务可能还在服务器上（保留 1 小时），请检查网络后再试`)
  err.code = badBody ? 'BAD_BODY_EXHAUSTED' : timeout ? 'TIMEOUT_EXHAUSTED' : 'NETWORK_EXHAUSTED'
  err.cause = lastErr
  return err
}

/**
 * 一个请求的「重试包装」：网络错、超时、5xx 重试；4xx 原样抛出。
 * beforeAttempt 用来数总轮询次数、检查全局上限。
 */
async function requestWithRetry(url, init, opts) {
  const timeoutMs = opts.timeoutMs || STATUS_TIMEOUT_MS
  const signal = opts.signal
  const beforeAttempt = opts.beforeAttempt
  const onRetry = opts.onRetry
  const read = opts.read || ((r) => r)

  let attempt = 0
  const deadline = opts.deadline
  while (true) {
    if (signal && signal.aborted) throw abortError()
    if (deadline && Date.now() >= deadline) {
      const e = new Error('识别超时（超过 20 分钟）')
      e.noRetry = true
      throw e
    }
    if (beforeAttempt) beforeAttempt()

    let lastErr = null
    try {
      // 读 body 也放在超时定时器里：只等响应头不算等完。
      // 单次超时不能超过整体截止时间，避免最后一次重试把 20 分钟拖长。
      const left = deadline ? Math.max(1, deadline - Date.now()) : timeoutMs
      return await fetchWithTimeout(url, { ...init, signal }, Math.min(timeoutMs, left), async (r) => {
        if (!r.ok) throw makeHttpError(r.status, await readErrorBody(r))
        return read(r)
      })
    } catch (e) {
      if (isAbortError(e) || (signal && signal.aborted)) throw abortError()
      if (e && e.noRetry) throw e
      if (e && e.httpStatus && e.httpStatus < 500) throw e
      lastErr = e || new Error('网络连接中断')
    }

    if (attempt >= MAX_TRANSIENT_RETRIES) {
      if (lastErr && lastErr.httpStatus) throw lastErr
      throw exhaustedError(lastErr)
    }
    const retryInMs = RETRY_BASE_MS * Math.pow(2, attempt)
    attempt += 1
    if (onRetry) onRetry(attempt, lastErr, retryInMs)
    await sleep(retryInMs, signal)
  }
}

function toUnit(v) {
  if (v == null) return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
}

function toPositiveInt(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function parseRecognisePhase(phase) {
  const m = /^recognise\s+(\d+)\s*\/\s*(\d+)$/i.exec(String(phase || ''))
  if (!m) return null
  const done = Number(m[1])
  const total = Number(m[2])
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done < 0 || done > total) return null
  return { done, total }
}

function readTimings(t) {
  if (!t || typeof t !== 'object') return null
  const keys = ['upload', 'queueWait', 'pageCount', 'preflight', 'recognise', 'export', 'parse', 'total']
  const out = {}
  let any = false
  for (const k of keys) {
    const raw = t[k]
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) continue
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) {
      out[k] = n
      any = true
    }
  }
  return any ? out : null
}

function pageCountOf(st, rec) {
  // timings.pageCount 是「数页花了多少毫秒」，不是页数，不能拿来当 total。
  // 页数只信服务端明确的 pages，或 "recognise X/Y" 里的 Y。
  return toPositiveInt(st.pages) || (rec && rec.total) || null
}

function nextPollDelay(st, fallbackPosition) {
  const status = st && st.status
  if (status === 'queued') {
    const pos = toPositiveInt(st.position) || toPositiveInt(fallbackPosition)
    if (pos && pos > 3) return QUEUED_SLOW_MS
    if (pos && pos > 1) return QUEUED_MS
    return NEXT_IN_QUEUE_MS
  }
  if (status === 'running') {
    const phase = String((st && st.phase) || '')
    const p = toUnit(st && st.progress)
    const rec = parseRecognisePhase(phase)
    const nearDone =
      /^(export|parse|done)\b/i.test(phase) ||
      (p != null && p >= NEAR_DONE_PROGRESS) ||
      (rec != null && rec.total - rec.done <= 1)
    if (nearDone) return NEAR_DONE_MS
    // 新服务器在 preflight/recognise 有明确阶段，1.2 秒够用；
    // 老服务器什么都看不到，保持原来的 1.5 秒。
    if (p != null || phase) return RUNNING_MS
    return POLL_MS
  }
  return POLL_MS
}

/**
 * 把一次 GET /omr/<id> 的响应整理成 UI 需要的状态。
 * 所有字段都做类型检查，老服务器缺字段时给 null，绝不把 undefined 传出去。
 */
function describeStatus(st, ctx, now = Date.now()) {
  const info = st && typeof st === 'object' ? st : {}
  const status = typeof info.status === 'string' ? info.status : ''
  const serverPhase = typeof info.phase === 'string' && info.phase ? info.phase.slice(0, 80) : null
  const progress = toUnit(info.progress)
  const timings = readTimings(info.timings)
  const rec = parseRecognisePhase(serverPhase)
  const pageCount = pageCountOf(info, rec)
  const position = toPositiveInt(info.position)

  const elapsedMs = Math.max(0, now - ctx.wallT0)

  // 进度速率只统计 running 阶段；排队时的 0 进度不能拿来稀释速率。
  if (status !== ctx.lastStatus) {
    ctx.samples = []
    ctx.lastStatus = status
  }
  if (status === 'running' && progress != null) {
    const samples = ctx.samples
    if (!samples.length) {
      samples.push({ at: now, p: progress })
    } else {
      const last = samples[samples.length - 1]
      // 服务端开新一轮 salvage 时可能把进度往回拨；旧的速率样本作废。
      if (progress < last.p - 0.02) {
        samples.length = 0
        samples.push({ at: now, p: progress })
      } else if (progress > last.p + 0.005) {
        samples.push({ at: now, p: progress })
        if (samples.length > 12) samples.shift()
      }
    }
  }

  let rateEtaMs = null
  if (status === 'running' && progress != null && ctx.samples.length >= 2) {
    const first = ctx.samples[0]
    const elapsed = now - first.at
    const dp = progress - first.p
    if (elapsed >= 3000 && dp >= 0.01) {
      const rate = dp / elapsed
      if (Number.isFinite(rate) && rate > 0) {
        rateEtaMs = Math.max(3000, Math.min(TIMEOUT_MS, (1 - progress) / rate))
      }
    }
  }

  // phase = "recognise X/Y" 时，recognise 是整轮/多轮识别的累计毫秒。
  // 服务端在 salvage 重试时会把 X 重置成 0（未必能正好被我们轮询到），
  // 所以记住重置点：本轮耗时 = timings.recognise - 重置点，除以本轮已完成页数。
  let recogniseEtaMs = null
  if (rec) {
    if (!Number.isFinite(ctx.recogniseHigh)) ctx.recogniseHigh = 0
    if (!Number.isFinite(ctx.recognisePassBaseMs)) ctx.recognisePassBaseMs = 0
    if (!Number.isFinite(ctx.recognisePassBaseDone)) ctx.recognisePassBaseDone = 0
    if (!Number.isFinite(ctx.lastRecogniseMs)) ctx.lastRecogniseMs = 0
    if (rec.done < ctx.recogniseHigh) {
      // 检测到新一轮。若正好看到 recognise 0/N，当前 recognise 就是最准的基线；
      // 若轮询跳过了 0（3/6 → 2/6），只能退回上一次观测值，把两次轮询之间的
      // 时间都算进新的一轮 —— 宁可把 ETA 估大一点，也不要估小。
      ctx.recognisePassBaseMs = rec.done === 0 ? (timings && timings.recognise) || 0 : ctx.lastRecogniseMs
      ctx.recognisePassBaseDone = 0
      ctx.recogniseHigh = rec.done
    } else {
      ctx.recogniseHigh = Math.max(ctx.recogniseHigh, rec.done)
    }
    if (timings && Number.isFinite(timings.recognise) && timings.recognise >= 0) {
      ctx.lastRecogniseMs = timings.recognise
    }
    const passSheets = rec.done - ctx.recognisePassBaseDone
    if (passSheets > 0 && rec.total > rec.done && timings && timings.recognise > 0) {
      const thisPassMs = timings.recognise - ctx.recognisePassBaseMs
      if (thisPassMs > 0) {
        const perSheet = thisPassMs / passSheets
        recogniseEtaMs = Math.max(1000, Math.min(TIMEOUT_MS, perSheet * (rec.total - rec.done)))
      }
    }
  }

  let etaMs = null
  let etaSource = null
  if (status === 'running') {
    // 有 "recognise X/Y" + timings 时优先用它：它是真实识别耗时，
    // 不会被某一页特别慢导致的进度条停顿带偏。单页/无 timings 时才用实测速率。
    if (recogniseEtaMs != null) {
      etaMs = recogniseEtaMs
      etaSource = 'timings'
    } else if (rateEtaMs != null && progress != null) {
      etaMs = rateEtaMs
      etaSource = 'rate'
    }
  } else if (status === 'queued') {
    // 服务端串行处理：排第 P 位意味着前面 P-1 个任务 + 自己这一份。
    // 用上一次成功任务的耗时粗估，页面刷新后就没有历史了，宁可不报也不乱报。
    const pos = position || toPositiveInt(ctx.fallbackPosition)
    if (lastJobMs != null && pos != null && pos >= 1) {
      etaMs = lastJobMs * pos
      etaSource = 'queue-history'
    }
  }

  return {
    status,
    serverPhase,
    progress,
    timings,
    pages: pageCount,
    position,
    page: rec ? rec.done : null,
    pageCount,
    etaMs: etaMs == null ? null : Math.round(etaMs),
    etaSource,
    recogniseEtaMs: recogniseEtaMs == null ? null : Math.round(recogniseEtaMs),
    elapsedMs,
    hasDetail: serverPhase != null || progress != null,
  }
}

function prettyMega(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return ''
  return (n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + ' MB'
}

async function readBlobHead(blob) {
  const part = blob.slice(0, 1024)
  if (typeof part.text === 'function') return part.text()
  if (typeof part.arrayBuffer === 'function') {
    if (typeof TextDecoder === 'function') return new TextDecoder().decode(await part.arrayBuffer())
  }
  return ''
}

/**
 * 上传前的本地检查：不花服务器流量，先挡住明显不对的文件。
 * 供 ScorePanel 在连接 /health 之前调用；omrConvert 自己也会调一次。
 */
export async function omrCheckFile(file) {
  const name = (file && file.name) || 'score.pdf'
  if (!/\.pdf$/i.test(name)) throw new Error('只支持 PDF（请选 .pdf 文件）')
  const size = Number(file && file.size)
  if (!Number.isFinite(size) || size <= 0) throw new Error('这个文件是空的，请换一份 PDF 再试')
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(`这个 PDF 有 ${prettyMega(size)}，加上上传表单会超过服务器 40 MB 上限。请先压缩，或按乐章/分册拆开再传。`)
  }
  // 有些安卓文件管理器会把别的文件改名成 .pdf；读前 1 KB 看 PDF 文件头。
  // 读不出来（极少见）就放行，让服务器做最终判断。
  if (file && typeof file.slice === 'function') {
    try {
      const head = await readBlobHead(file)
      if (head && !head.includes('%PDF-')) {
        throw new Error('这个文件不是有效的 PDF（文件头不对），请确认没有改过扩展名')
      }
    } catch (e) {
      if (e && /不是有效的 PDF/.test(e.message || '')) throw e
    }
  }
}

/** 服务是否活着。不需要 token，用于在导入面板里提示「没连上服务器」。 */
export async function omrHealth() {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 6000)
  try {
    const r = await fetch(BASE + '/health', { signal: ctl.signal })
    if (!r.ok) return { ok: false, reason: 'HTTP ' + r.status }
    const j = await r.json()
    return {
      ok: !!j.ok,
      audiveris: !!j.audiveris,
      queued: j.queued || 0,
      running: j.running || 0,
      maxQueue: j.maxQueue || 0,
    }
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? '连接超时' : (e.message || String(e)) }
  } finally {
    clearTimeout(t)
  }
}

/**
 * 用 XHR 上传，只为了拿到浏览器真实的上传字节进度。
 * fetch 本身不暴露上传进度；XHR 失败就把错误原样抛出去，不自动重传
 *（重传 POST 可能在服务端多建一个任务，还会多算一次限流）。
 */
function uploadWithXhr(body, fileSize, signal, onUpload) {
  return new Promise((resolve, reject) => {
    if (typeof XMLHttpRequest !== 'function') {
      const e = new Error('NO_XHR')
      e.code = 'NO_XHR'
      return reject(e)
    }
    const xhr = new XMLHttpRequest()
    let done = false
    const cleanup = () => {
      if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort)
    }
    const finish = (fn, value) => {
      if (done) return
      done = true
      cleanup()
      fn(value)
    }
    const fail = (err) => finish(reject, err)
    const onAbort = () => {
      try { xhr.abort() } catch (e) { /* 已经结束 */ }
      fail(abortError())
    }

    xhr.open('POST', BASE + '/omr', true)
    const headers = authHeaders()
    for (const k of Object.keys(headers)) {
      try { xhr.setRequestHeader(k, headers[k]) } catch (e) { /* 某些 WebView 限制自定义头 */ }
    }
    xhr.timeout = UPLOAD_TIMEOUT_MS
    xhr.upload.onprogress = (e) => {
      if (done) return
      const ratio = e && e.lengthComputable && e.total > 0 ? e.loaded / e.total : null
      onUpload({
        loaded: e && Number.isFinite(e.loaded) ? e.loaded : null,
        total: e && e.lengthComputable && e.total > 0 ? e.total : fileSize,
        ratio,
      })
    }
    xhr.upload.onload = () => {
      if (done) return
      onUpload({ loaded: fileSize, total: fileSize, ratio: 1 })
    }
    xhr.onload = () => {
      finish(resolve, {
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        text: xhr.responseText || '',
      })
    }
    xhr.onerror = () => {
      const e = new Error('上传时网络连接中断')
      e.code = 'NETWORK'
      fail(e)
    }
    xhr.ontimeout = () => {
      const e = new Error('上传超时')
      e.code = 'TIMEOUT'
      fail(e)
    }
    xhr.onabort = () => fail(abortError())

    if (signal && signal.aborted) return onAbort()
    if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true })
    if (signal && signal.aborted) return onAbort()
    onUpload({ loaded: 0, total: fileSize, ratio: 0 })
    try {
      xhr.send(body)
    } catch (e) {
      fail(e)
    }
  })
}

/** fetch 兜底上传：平台不提供上传进度，ratio 为 null，不假装有百分比。 */
async function uploadWithFetch(body, fileSize, signal, onUpload) {
  onUpload({ loaded: 0, total: fileSize, ratio: null })
  return fetchWithTimeout(
    BASE + '/omr',
    { method: 'POST', headers: authHeaders(), body, signal },
    UPLOAD_TIMEOUT_MS,
    async (r) => {
      onUpload({ loaded: fileSize, total: fileSize, ratio: 1 })
      return { status: r.status, ok: r.ok, text: await r.text() }
    },
  )
}

async function uploadPdf(body, fileSize, signal, onUpload) {
  if (typeof XMLHttpRequest === 'function') {
    try {
      return await uploadWithXhr(body, fileSize, signal, onUpload)
    } catch (e) {
      if (!e || e.code !== 'NO_XHR') throw e
    }
  }
  return uploadWithFetch(body, fileSize, signal, onUpload)
}

function rememberJobDuration(info, wallMs) {
  const timings = info && info.timings
  const total = timings && Number(timings.total)
  const seconds = info && Number(info.seconds)
  if (Number.isFinite(total) && total > 0) lastJobMs = total
  else if (Number.isFinite(seconds) && seconds > 0) lastJobMs = seconds * 1000
  else if (Number.isFinite(wallMs) && wallMs > 0) lastJobMs = wallMs
}

/**
 * 上传一个 PDF，等识别完，取回 MusicXML 文本。
 *
 * onProgress 收到的对象保持旧字段不变，并额外带：
 *   status / serverPhase / progress（0..1，旧服务器为 null）/ timings / pages
 *   position / page / pageCount / etaMs / etaSource / elapsedMs / hasDetail
 * upload 阶段另有 loaded / total / ratio（ratio 为 null 表示平台不报上传进度）。
 * 连接抖动时会收到 phase="retry"（attempt / maxAttempts / retryInMs / reason）。
 *
 * @param {File|Blob} file
 * @param {{ onProgress?: (s: object) => void, signal?: AbortSignal }} opts
 * @returns {Promise<{ xml: string, info: object }>}
 */
export async function omrConvert(file, opts = {}) {
  const onProgress = opts.onProgress || (() => {})
  const signal = opts.signal
  const name = (file && file.name) || 'score.pdf'
  const wallT0 = Date.now()

  if (signal && signal.aborted) throw abortError()
  await omrCheckFile(file)

  const body = new FormData()
  body.append('file', file, name)

  onProgress({ phase: 'upload', loaded: 0, total: Number(file && file.size) || 0, ratio: 0, elapsedMs: 0 })
  let uploaded
  try {
    uploaded = await uploadPdf(body, Number(file && file.size) || 0, signal, (p) => {
      onProgress({
        phase: 'upload',
        loaded: p.loaded,
        total: p.total,
        ratio: p.ratio,
        elapsedMs: Date.now() - wallT0,
      })
    })
  } catch (e) {
    if (isAbortError(e) || (signal && signal.aborted)) throw abortError()
    if (e && e.code === 'TIMEOUT') throw new Error('上传超时了，请检查网络后再试')
    if (e && e.code === 'NETWORK') throw new Error('上传时网络连接中断，请检查网络后再试')
    throw e
  }

  let job
  try {
    job = uploaded.text ? JSON.parse(uploaded.text) : {}
  } catch (e) {
    job = {}
  }
  if (!uploaded.ok) {
    const detail = job && (job.error || job.message)
    throw makeHttpError(uploaded.status, detail)
  }
  if (!job || typeof job.id !== 'string' || !job.id) {
    // 2xx 但拿不到 id：边界情况，任务可能已经建好却无法再查询。
    // 不假装能续上，明确告诉用户重试，同时说明可能已在服务器排队。
    const err = new Error('服务器接受了上传，但没有返回任务编号。请稍后重试；如果队列里已有你的任务，它仍会继续识别')
    err.code = 'NO_JOB_ID'
    throw err
  }

  const rateRemaining = job.rateRemaining
  const pollT0 = Date.now()
  let polls = 0
  let lastInfo = job
  const ctx = {
    wallT0,
    lastStatus: null,
    samples: [],
    fallbackPosition: job.position,
    recogniseHigh: 0,
    recognisePassBaseMs: 0,
    recognisePassBaseDone: 0,
    lastRecogniseMs: 0,
  }
  const initial = describeStatus(job, ctx)
  const initialPosition = initial.position || toPositiveInt(job.position)
  onProgress({
    phase: 'queued',
    id: job.id,
    position: initialPosition,
    remain: rateRemaining,
    info: job,
    ...initial,
  })

  while (true) {
    const before = Date.now()
    if (before - pollT0 >= TIMEOUT_MS) throw new Error('识别超时（超过 20 分钟）')
    const left = pollT0 + TIMEOUT_MS - before
    const wait = Math.min(nextPollDelay(lastInfo, job.position), left)
    await sleep(wait, signal)
    if (Date.now() - pollT0 >= TIMEOUT_MS) throw new Error('识别超时（超过 20 分钟）')

    let st
    try {
      st = await requestWithRetry(
        `${BASE}/omr/${job.id}`,
        { headers: authHeaders(), signal },
        {
          timeoutMs: STATUS_TIMEOUT_MS,
          deadline: pollT0 + TIMEOUT_MS,
          signal,
          read: readStatusResponse,
          beforeAttempt: () => {
            polls += 1
            if (polls > MAX_POLLS) {
              const e = new Error('查询次数达到上限，任务可能还在服务器上（保留 1 小时），请稍后再试')
              e.noRetry = true
              throw e
            }
          },
          onRetry: (attempt, err, retryInMs) => {
            const prev = describeStatus(lastInfo, ctx)
            onProgress({
              phase: 'retry',
              stage: 'status',
              attempt,
              maxAttempts: MAX_TRANSIENT_RETRIES,
              retryInMs,
              reason: retryReason(err),
              info: lastInfo,
              ...prev,
            })
          },
        },
      )
    } catch (e) {
      if (isAbortError(e) || (signal && signal.aborted)) throw abortError()
      throw e
    }

    const now = Date.now()
    const payload = describeStatus(st, ctx, now)
    lastInfo = st

    if (st.status === 'done') {
      onProgress({ phase: 'download', info: st, ...payload })
      let xml
      try {
        xml = await requestWithRetry(
          `${BASE}/omr/${job.id}/xml`,
          { headers: authHeaders(), signal },
          {
            timeoutMs: XML_TIMEOUT_MS,
            signal,
            read: readTextResponse,
            beforeAttempt: () => {
              polls += 1
              if (polls > MAX_POLLS) {
                const e = new Error('请求次数达到上限，任务可能还在服务器上（保留 1 小时），请稍后再试')
                e.noRetry = true
                throw e
              }
            },
            onRetry: (attempt, err, retryInMs) => {
              onProgress({
                phase: 'retry',
                stage: 'download',
                attempt,
                maxAttempts: MAX_TRANSIENT_RETRIES,
                retryInMs,
                reason: retryReason(err),
                info: st,
                ...payload,
                elapsedMs: Date.now() - wallT0,
              })
            },
          },
        )
      } catch (e) {
        if (isAbortError(e) || (signal && signal.aborted)) throw abortError()
        throw e
      }
      rememberJobDuration(st, Date.now() - wallT0)
      onProgress({ phase: 'done', info: st, ...payload, progress: 1, elapsedMs: Date.now() - wallT0 })
      return { xml, info: st }
    }

    if (st.status === 'error') {
      throw new Error('识别失败：' + friendlyServerError(st.error || '未知错误'))
    }
    if (st.status !== 'queued' && st.status !== 'running') {
      throw new Error(`服务器返回了未知的任务状态（${st.status}），请稍后再试或更新应用`)
    }

    if (st.status === 'queued') {
      onProgress({
        phase: 'queued',
        ...payload,
        id: job.id,
        position: payload.position || initialPosition,
        remain: rateRemaining,
        info: st,
      })
    } else {
      // 保持旧行为：把服务端 status 当作 phase 透传（running 等）。
      onProgress({ phase: st.status || 'running', info: st, ...payload })
    }
  }
}
