// 撤销 / 重做。
//
// 只管「谱面编辑」这一条线（钢琴卷帘、力度自动化、整首力度、和弦轨套用、
// 换谱）。不含录音轨、不含设置——那些各有自己的生命周期，
// 混进一个历史栈会让「撤销」的行为变得难以预测。
//
// 设计取舍
// --------
// 1. 存快照而不是存操作（command pattern）。
//    谱面对象通常只有几 KB 到几百 KB，存快照换来的是「任何编辑都不用
//    单独写 undo 逻辑」，加新编辑功能时不用改这里。存操作要写反向操作，
//    容易漏，一旦漏了就是数据损坏。
//
// 2. 合并连续编辑。拖一个音高会连续触发几十次 onChange，
//    如果每次都入栈，用户按一次撤销只退一个像素。用 debounce：
//    同一个 key 的编辑在 MERGE_MS 内合并成一步。
//
// 3. 上限 MAX_STEPS 步。手机上内存有限，谱面又可能很大。

const MAX_STEPS = 50
const MERGE_MS = 700

/**
 * 创建一个历史记录器。
 *
 * 用法：
 *   const h = createHistory()
 *   h.push(score)              // 编辑前先记一笔
 *   h.undo(current) -> prev    // 返回上一步的谱面，没有则 null
 *   h.redo(current) -> next
 */
export function createHistory() {
  let past = []
  let future = []
  let lastKey = null
  let lastAt = 0

  return {
    /**
     * 记录一次编辑前的状态。
     * @param {object} snapshot 编辑前的谱面（会被浅拷贝后存起来）
     * @param {string} [key] 合并键：同一个 key 的连续编辑会合并成一步
     */
    push(snapshot, key) {
      const now = Date.now()
      // 同一个连续操作（比如拖动同一个音）在时间窗内只记第一次
      if (key && key === lastKey && now - lastAt < MERGE_MS) {
        lastAt = now
        // 但未来的栈必须清空：一旦有了新编辑，重做就不该还留着旧分支
        future = []
        return
      }
      past.push(snapshot)
      if (past.length > MAX_STEPS) past.shift()
      future = []
      lastKey = key || null
      lastAt = now
    },

    /** 撤销。传入当前状态，返回上一步；没有可撤销的返回 null。 */
    undo(current) {
      if (!past.length) return null
      const prev = past.pop()
      future.push(current)
      if (future.length > MAX_STEPS) future.shift()
      // 撤销后清掉合并键，下一次编辑一定是新的一步
      lastKey = null
      lastAt = 0
      return prev
    },

    /** 重做。 */
    redo(current) {
      if (!future.length) return null
      const next = future.pop()
      past.push(current)
      if (past.length > MAX_STEPS) past.shift()
      lastKey = null
      lastAt = 0
      return next
    },

    canUndo() { return past.length > 0 },
    canRedo() { return future.length > 0 },
    get size() { return past.length },
    clear() { past = []; future = []; lastKey = null; lastAt = 0 },
  }
}

// 谱面快照：只留会影响「谱面内容」的字段。
// _xml 不进快照（它是导入时的原始串，撤销后由渲染层按 parts 重新生成）。
export function snapshotScore(score) {
  if (!score) return null
  const { _xml, ...rest } = score
  return structuredClone(rest)
}
