// 从已验证的单文件版本原样抽离，逻辑未做任何改动
/* ============ 跟谱：Online DTW ============ */
class Follower{
  constructor(notes, opts){
    this.notes = notes;                       // [{midi,beats}]
    this.n = notes.length;
    this.bpm = opts.bpm || 96;
    this.secPerBeat = 60/this.bpm;            // 用真实时间建模，与帧率无关
    this.W_STEP = 1.5;                        // 前进一音的基础惩罚
    this.W_SKIP = 3.0;                        // 一次跳两音的惩罚
    this.ONSET_BONUS = 0.35;                  // 起音时给"前进"的奖励（重复同音高靠它区分）
    this.reset();
  }
  reset(){
    this.cum = new Float64Array(this.n);
    this.hold = new Float64Array(this.n);
    for(let j=0;j<this.n;j++) this.cum[j] = j*0.25;   // 轻微偏好靠前
    this.prev = this.cum.slice();
    this.prevHold = this.hold.slice();
    this.pos = 0;
    this.trace = [];
    this.lastObsMidi = null;
    this.silentFrames = 0;
    this.mismatchFrames = 0;
    this.lastMatchCost = 0;
    this.voicedRun = 0;
  }
  // 单个音符的匹配代价
  cost(j, obs){
    const t = this.notes[j].midi;
    const clarity = obs.clarity;
    if(obs.midi == null){                      // 静音 / 检测不出
      return t == null ? 0.05 : 0.30;          // 谱上是休止 → 几乎不罚；否则轻罚
    }
    if(t == null) return 0.28;                 // 谱上休止，但你出声了
    let best = 1e9;
    for(let k=-1;k<=1;k++){                    // 八度容错
      const diff = Math.abs(obs.midi + 12*k - t);
      if(diff < best) best = diff;
    }
    let c = Math.min(best, 12) / 12 * 2.2;     // 差一个八度以内：0~2.2
    return c * (0.45 + 0.55*clarity);          // 检测越不确定，代价越"中庸"
  }
  // 停留时长足够后，前进惩罚衰减（semi-Markov 近似）；时长单位为秒
  // 相邻两个音音高相同时靠不出声是分不出来的，必须基本唱满才能切，
  // 否则会提前一两拍跳到下一个音（谱面上看着就像光标跑偏）
  stepPen(holdSec, beats, samePitch){
    const expect = Math.max(0.08, beats * this.secPerBeat);
    const frac = holdSec / ((samePitch ? 0.92 : 0.55) * expect);
    return this.W_STEP * Math.max(0, 1 - frac);
  }
  // onset: 0=无 1=弱(仅能量峰) 2=强(静音后重新出声 / 音高跳变)
  // opts: {lo, hi} —— 锁定态下只在 pos 附近这个小窗口里活动。
  // 锁定之后不该每帧都重新满谱搜索：那样唱到与前面重复的和声段时会被吸回去。
  push(obs, dt, onset, opts){
    if(!(dt > 0)) dt = 1/30;
    onset = onset | 0;
    const voiced = obs.voiced !== false;
    // 零星误判不算数，要连续几帧都判定为歌声才解锁，
    // 否则旁边人唱两句就会把光标拖着走
    this.voicedRun = voiced ? this.voicedRun + 1 : 0;
    // 没在唱、或听到的音跟整个声部都对不上时，锁住不许往前跑。
    // 否则安静时所有位置的代价都一样，光标会一路滑到谱子结尾。
    const frozen = this.voicedRun < 3 || this.mismatchFrames > 12;
    const n = this.n, prev = this.prev, prevHold = this.prevHold;
    const lo = opts && opts.lo != null ? Math.max(0, opts.lo) : 0;
    const hi = opts && opts.hi != null ? Math.min(n-1, opts.hi) : n-1;
    const cur = new Float64Array(n), curHold = new Float64Array(n);
    for(let j=0;j<n;j++){
      if(j < lo || j > hi){ cur[j] = Infinity; continue; }   // 窗口外不可达
      let best = prev[j], pred = j;                                  // 停留
      if(j>0 && prev[j-1] < Infinity){
        // 检测到重新起音时，前进变成"奖励"（连续同音高音的代价差为 0，只能靠这个推动）
        const a = this.notes[j-1].midi, b = this.notes[j].midi
        const same = a != null && b != null && a === b
        let pen = this.stepPen(prevHold[j-1], this.notes[j-1].beats, same)
        if(frozen) pen = this.W_STEP * 2
        // 弱起音（只是音量突一下）在前后同音高时不可信——唱一个长音时的音量波动
        // 会把它误判成"唱下一个音了"，导致提前跳格
        else if(onset === 2) pen = -this.ONSET_BONUS
        else if(onset === 1 && !same) pen = -this.ONSET_BONUS

        // 起音奖励不能随便给：合唱里认领到的音高会抖，频繁触发起音会让位置一路狂奔。
        // 没唱够六成时值就不给这份奖励，交给音高匹配自己决定（不加额外惩罚，免得 solo 也被拖慢）
        const expectSec = Math.max(0.08, this.notes[j-1].beats * this.secPerBeat)
        if(pen < 0 && prevHold[j-1] < expectSec * 0.6) pen = this.stepPen(prevHold[j-1], this.notes[j-1].beats, same)
        const v = prev[j-1] + pen;
        if(v < best){ best = v; pred = j-1; }
      }
      if(j>1 && prev[j-2] < Infinity){
        const v = prev[j-1-1] + (frozen ? this.W_SKIP*2 : (onset === 2 ? this.W_SKIP*0.5 : this.W_SKIP));
        if(v < best){ best = v; pred = j-2; }
      }
      cur[j] = best + this.cost(j, obs) * dt;   // 代价按时间积分 → 与帧率无关
      curHold[j] = (pred === j) ? prevHold[j] + dt : 0;
    }
    // 数值稳定：减去最小值
    let mn = Infinity;
    for(let j=lo;j<=hi;j++) if(cur[j] < mn) mn = cur[j];
    for(let j=lo;j<=hi;j++) if(isFinite(cur[j])) cur[j] -= mn;

    this.prev = cur; this.prevHold = curHold; this.hold = curHold;
    // 平局时偏好靠后的位置：连续同音高时停留与前进代价完全相等，
    // 若一律取靠前就会永远卡在重复音的第一个音上（音乐总是往前走的）
    let bj = lo, bv = Infinity;
    for(let j=lo;j<=hi;j++){
      const key = cur[j] - 1e-6*j;
      if(key < bv){ bv = key; bj = j; }
    }
    // 唱够时值就该往下走。多基频总有漏检，一旦代价差拉不开，
    // 光靠匹配会一直卡在原地（实测合唱里能慢出 20%）。
    // 有声时阈值 1.35 倍（团队比谱面慢三成以内不会被误伤）；
    // 听不见时放宽到 2.5 倍——低音本来就常检不出，那多半是漏检而不是真停了。
    const expect = Math.max(0.08, this.notes[bj].beats * this.secPerBeat)
    const lim = this.voicedRun >= 3 ? 1.35 : 2.5
    if (bj + 1 < n && this.hold[bj] > expect * lim) bj = bj + 1
    this.pos = bj;
    this.spread = bv;                          // 越小越确定

    if(obs.midi != null){
      this.lastObsMidi = obs.midi;
      this.silentFrames = 0;
    }else{
      this.silentFrames++;
    }

    // 听到的音跟这个声部整体差多远（八度归一后最远也就 6 个半音，对应代价 1.1）
    if(voiced){
      let bc = Infinity;
      for(let k=0;k<n;k++){ const c = this.cost(k, obs); if(c < bc) bc = c; }
      this.lastMatchCost = bc;
      this.mismatchFrames = bc > 0.85 ? this.mismatchFrames + 1 : 0;
    }else{
      this.mismatchFrames = 0;
    }
    // 顺手记下这一帧相对"当前这个音"的音分偏差，事后才能给唱过的音上色
    let cs = null;
    if(obs.midi != null && this.notes[bj].midi != null){
      let d = obs.midi - this.notes[bj].midi;
      while(d > 6) d -= 12;
      while(d < -6) d += 12;
      cs = d * 100;
    }
    this.trace.push({pos:bj, midi:obs.midi, c:obs.clarity, cs});
    if(this.trace.length > 320) this.trace.shift();
    return bj;
  }
  // 冷启动定位成功后直接把状态搬到第 pos 个音上。
  // 只给邻近几个位置开口子：既允许小幅前后修正，又不会一下子跳回别的乐段。
  jumpTo(pos, holdSec){
    pos = Math.max(0, Math.min(this.n-1, pos|0));
    const p = new Float64Array(this.n).fill(Infinity);
    for(let d=-1; d<=2; d++){
      const j = pos + d;
      if(j >= 0 && j < this.n) p[j] = Math.abs(d) * 0.7;
    }
    this.prev = p;
    this.prevHold = new Float64Array(this.n);
    this.hold = new Float64Array(this.n);
    // 必须把"已经在这个音上唱了多久"一起带过来。
    // 清零的话跟谱器会以为这个音才刚开始，要多等整整一个音的时长才肯往下走，
    // 于是冷启动那不到 1 秒的延迟会变成实打实的落后。
    this.hold[pos] = Math.max(0, holdSec || 0);
    this.prevHold[pos] = this.hold[pos];
    this.pos = pos;
    this.trace = [];
    this.mismatchFrames = 0;
    this.voicedRun = 3;          // 直接算"已在唱"，省掉三帧去抖
    this.silentFrames = 0;
    this.spread = 0;
  }
  // 置信度：最优与次优的差距
  confidence(){
    if(!this.prev) return 0;
    let b1 = Infinity, b2 = Infinity;
    for(let j=0;j<this.n;j++){
      const v = this.prev[j];
      if(v < b1){ b2 = b1; b1 = v; } else if(v < b2){ b2 = v; }
    }
    if(!isFinite(b2)) return 1;
    return Math.max(0, Math.min(1, (b2-b1)/1.2));
  }
}


export { Follower };

// 团队跟谱器：不拆声部，直接拿"此刻听到的所有音高"去比对
// "谱面此刻应该同时响着哪些音"。
//
// 为什么不用"每个声部各跟一个再投票"：多基频总会有漏检，
// 谁被检出就谁说了算，团队位置会来回跳甚至倒退。
// 改成整体和弦匹配后，漏检一两个音也只是让匹配度略降，不会带偏位置。
export class EnsembleFollower {
  constructor(parts, opts) {
    this.bpm = opts && opts.bpm ? opts.bpm : 96
    this.secPerBeat = 60 / this.bpm
    this.W_STEP = 1.5
    this.W_SKIP = 3.0

    // 事件边界 = 所有声部音符起止点的并集
    const bounds = new Set([0])
    for (const p of parts) {
      let acc = 0
      for (const n of p.notes) { acc += n.beats; bounds.add(acc) }
    }
    const bs = [...bounds].sort((a, b) => a - b)
    this.events = []
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i]
      const pitches = []
      for (const p of parts) {
        let acc = 0
        for (const n of p.notes) {
          if (acc <= b + 1e-9 && b < acc + n.beats - 1e-9) {
            if (n.midi != null) pitches.push(n.midi)
            break
          }
          acc += n.beats
        }
      }
      this.events.push({
        beat: b,
        beats: i + 1 < bs.length ? bs[i + 1] - b : 1,
        pitches,
      })
    }
    this.n = this.events.length
    this.mismatchFrames = 0
    this.voicedRun = 0
    this.reset()
  }

  reset() {
    this.cum = new Float64Array(this.n)
    this.hold = new Float64Array(this.n)
    for (let j = 0; j < this.n; j++) this.cum[j] = j * 0.25
    this.prev = this.cum.slice()
    this.prevHold = this.hold.slice()
    this.pos = 0
  }

  // obs：此刻听到的所有音高（浮点 MIDI 数组）
  cost(j, obs) {
    const ev = this.events[j]
    if (!ev.pitches.length) return obs && obs.length ? 0.28 : 0.30
    if (!obs || !obs.length) return 0.30
    let total = 0
    for (const m of ev.pitches) {
      let best = 12
      for (const o of obs) {
        let d = o - m
        while (d > 6) d -= 12
        while (d < -6) d += 12
        const a = d < 0 ? -d : d
        if (a < best) best = a
      }
      total += Math.min(best, 12) / 12
    }
    return (total / ev.pitches.length) * 2.2
  }

  stepPen(holdSec, beats) {
    const expect = Math.max(0.08, beats * this.secPerBeat)
    return this.W_STEP * Math.max(0, 1 - holdSec / (0.55 * expect))
  }

  push(obs, dt, voiced) {
    if (!(dt > 0)) dt = 1 / 30
    this.voicedRun = voiced ? this.voicedRun + 1 : 0
    const frozen = this.voicedRun < 3
    const n = this.n, prev = this.prev, prevHold = this.prevHold
    const cur = new Float64Array(n), curHold = new Float64Array(n)
    for (let j = 0; j < n; j++) {
      let best = prev[j], pred = j
      if (j > 0) {
        let pen = this.stepPen(prevHold[j - 1], this.events[j - 1].beats)
        if (frozen) pen = this.W_STEP * 2
        const v = prev[j - 1] + pen
        if (v < best) { best = v; pred = j - 1 }
      }
      if (j > 1) {
        const v = prev[j - 2] + (frozen ? this.W_SKIP * 2 : this.W_SKIP)
        if (v < best) { best = v; pred = j - 2 }
      }
      cur[j] = best + this.cost(j, obs) * dt
      curHold[j] = pred === j ? prevHold[j] + dt : 0
    }
    let mn = Infinity
    for (let j = 0; j < n; j++) if (cur[j] < mn) mn = cur[j]
    for (let j = 0; j < n; j++) cur[j] -= mn
    this.prev = cur; this.prevHold = curHold; this.hold = curHold
    let bj = 0, bv = Infinity
    for (let j = 0; j < n; j++) { const k = cur[j] - 1e-6 * j; if (k < bv) { bv = k; bj = j } }

    // 音乐是往前走的：偶尔一两帧想往回跳是匹配抖动，忽略掉；
    // 只有连续多帧都坚持要回去（比如真的从头重来）才放行
    if (bj < this.pos - 1) {
      this.backFrames = (this.backFrames || 0) + 1
      if (this.backFrames < 15) bj = this.pos
      else this.backFrames = 0
    } else {
      this.backFrames = 0
    }
    this.pos = bj

    if (voiced && obs && obs.length) {
      let bc = Infinity
      for (let k = 0; k < n; k++) { const c = this.cost(k, obs); if (c < bc) bc = c }
      this.mismatchFrames = bc > 1.4 ? this.mismatchFrames + 1 : 0
    } else {
      this.mismatchFrames = 0
    }
    return bj
  }

  get beat() { return this.events[this.pos] ? this.events[this.pos].beat : 0 }

  confidence() {
    let b1 = Infinity, b2 = Infinity
    for (let j = 0; j < this.n; j++) {
      const v = this.prev[j]
      if (v < b1) { b2 = b1; b1 = v } else if (v < b2) b2 = v
    }
    if (!isFinite(b2)) return 1
    return Math.max(0, Math.min(1, (b2 - b1) / 1.2))
  }
}
