// 共享的 IndexedDB 定义。
//
// 为什么会单独出来
// ----------------
// myScores.js 和 project.js 打开的是同一个 'sonnet' 库，但各自写死了版本号
// （1 和 2）。IndexedDB 的规则是：用比现有版本低的版本号 open() 会直接失败，
// 于是「先用过工程，再回谱库」就报
//   The requested version (1) is less than the existing version (2)
// 「我的谱」整个不可用。
//
// 现在版本号和建表逻辑都收在这里，两边共用，升级时只改一处。
// 加新 store 时：DB_VER 加 1，并在 ensureStores 里建表（要写成幂等的）。

export const DB_NAME = 'sonnet'
export const DB_VER = 2

/** 建表。onupgradeneeded 里调用；必须幂等，因为可能是从任意旧版本升上来。 */
export function ensureStores(db) {
  if (!db.objectStoreNames.contains('myScores')) {
    db.createObjectStore('myScores', { keyPath: 'id' })
  }
  if (!db.objectStoreNames.contains('projects')) {
    db.createObjectStore('projects', { keyPath: 'id' })
  }
}
