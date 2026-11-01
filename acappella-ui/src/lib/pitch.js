// 从已验证的单文件版本原样抽离，逻辑未做任何改动
/* ============ 音高检测：YIN ============ */
class YinDetector{
  constructor(sampleRate, bufSize){
    this.sr = sampleRate;
    this.N = bufSize || 2048;
    this.minLag = Math.max(2, Math.floor(this.sr/1200));
    this.maxLag = Math.min(Math.floor(this.N/2), Math.floor(this.sr/60));
    this.W = this.N - this.maxLag;
    this.d = new Float32Array(this.maxLag+1);
    this.cmnd = new Float32Array(this.maxLag+1);
  }
  detect(buf){
    const N=this.N, W=this.W, minLag=this.minLag, maxLag=this.maxLag, d=this.d, c=this.cmnd;
    let energy = 0;
    for(let i=0;i<N;i++) energy += buf[i]*buf[i];
    const rms = Math.sqrt(energy/N);
    if(rms < 1e-5) return {freq:0, clarity:0, rms:0};

    for(let lag=1; lag<=maxLag; lag++){
      let s = 0;
      for(let i=0;i<W;i++){
        const diff = buf[i] - buf[i+lag];
        s += diff*diff;
      }
      d[lag] = s;
    }
    // 累积均值归一化差分（标准 YIN：从 lag=1 起累积）
    let run = 0;
    for(let lag=1; lag<=maxLag; lag++){
      run += d[lag];
      c[lag] = run > 0 ? (d[lag]*lag)/run : 1;
    }
    const THRESH = 0.12;
    let chosen = -1;
    for(let lag=minLag; lag<maxLag-1; lag++){
      if(c[lag] < THRESH && c[lag] <= c[lag+1]){ chosen = lag; break; }
    }
    if(chosen < 0){
      let best = 1e9, bl = -1;
      for(let lag=minLag; lag<=maxLag; lag++){ if(c[lag] < best){ best = c[lag]; bl = lag; } }
      if(bl < 0 || best > 0.35) return {freq:0, clarity:0, rms};
      chosen = bl;
    }
    // 抛物线插值
    let lagF = chosen;
    const x0 = c[Math.max(minLag,chosen-1)], x1 = c[chosen], x2 = c[Math.min(maxLag,chosen+1)];
    const denom = (x0 - 2*x1 + x2);
    if(Math.abs(denom) > 1e-12) lagF = chosen + 0.5*(x0 - x2)/denom;
    const freq = this.sr / lagF;
    return {freq, clarity: Math.max(0, 1 - c[chosen]), rms};
  }

  // 多候选：把累积均值差分曲线上所有够深的谷都取出来。
  // 单声部只有一个谷，多声部混音会有好几个（各声部的基频及其低八度），
  // 交给上层做连续性跟踪，比每帧只取最强的那一个好得多。
  detectMulti(buf, opts){
    const N=this.N, W=this.W, minLag=this.minLag, maxLag=this.maxLag, d=this.d, cmnd=this.cmnd;
    const maxCost = (opts && opts.maxCost) || 0.42;
    let energy=0;
    for(let i=0;i<N;i++) energy += buf[i]*buf[i];
    const rms = Math.sqrt(energy/N);
    if(rms < 1e-5) return {freq:0, clarity:0, rms, candidates:[]};
    for(let lag=1; lag<=maxLag; lag++){
      let s=0;
      for(let i=0;i<W;i++){ const diff = buf[i]-buf[i+lag]; s += diff*diff; }
      d[lag]=s;
    }
    let run=0;
    for(let lag=1; lag<=maxLag; lag++){
      run += d[lag];
      cmnd[lag] = run>0 ? (d[lag]*lag)/run : 1;
    }
    const out=[];
    for(let lag=minLag+1; lag<maxLag; lag++){
      if(!(cmnd[lag] <= cmnd[lag-1] && cmnd[lag] < cmnd[lag+1])) continue;
      if(cmnd[lag] > maxCost) continue;
      const x0=cmnd[lag-1], x1=cmnd[lag], x2=cmnd[lag+1];
      const denom = x0 - 2*x1 + x2;
      let lagF = lag + (Math.abs(denom) > 1e-12 ? 0.5*(x0-x2)/denom : 0);
      const freq = this.sr / lagF;
      if(freq < 45 || freq > 1300) continue;
      out.push({
        freq,
        midi: 69 + 12*Math.log2(freq/440),
        clarity: Math.max(0, 1 - cmnd[lag]),
      });
    }
    out.sort((a,b)=> b.clarity - a.clarity);
    return {
      freq: out[0] ? out[0].freq : 0,
      clarity: out[0] ? out[0].clarity : 0,
      rms,
      candidates: out.slice(0, 10),
    };
  }
}


// Analysis window length in samples. YIN's lowest detectable pitch is set by
// N/2 lags, so a fixed 2048-sample window raises the floor with the sample
// rate: 93.8 Hz at 96 kHz, 187.5 Hz at 192 kHz, which loses the bass part.
// Scale the window with sr to keep roughly 43 ms of signal in view.
export function yinWindowSize(sr){
  return Math.min(4096, Math.max(2048, Math.ceil((sr * 2) / 60)));
}

export { YinDetector };
