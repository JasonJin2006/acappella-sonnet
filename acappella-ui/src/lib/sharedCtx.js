// 录音、哼唱、混音共用一个 AudioContext。
// 每次录音都 new 一个的话，反复录十几次就会碰到浏览器的 AudioContext 数量上限。
let ctx = null

export function sharedCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)()
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}
