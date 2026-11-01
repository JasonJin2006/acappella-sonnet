// 从已验证的单文件版本原样抽离，逻辑未做任何改动
/* ============ 基础乐理 ============ */
const STEP = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const SOLFEGE = {0:"Do",1:"Di",2:"Re",3:"Ri",4:"Mi",5:"Fa",6:"Fi",7:"Sol",8:"Si",9:"La",10:"Li",11:"Ti"};
const LETTER = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const FLAT   = {1:"Db",3:"Eb",6:"Gb",8:"Ab",10:"Bb"};

function nameToMidi(s){
  const m = /^([A-Ga-g])([#b]|is|es)?(-?\d+)$/.exec(String(s).trim());
  if(!m) return null;
  const step = STEP[m[1].toUpperCase()];
  let acc = 0;
  if(m[2]==="#"||m[2]==="is") acc = 1;
  else if(m[2]==="b"||m[2]==="es") acc = -1;
  return (parseInt(m[3],10)+1)*12 + step + acc;
}
function midiToFreq(m){ return 440*Math.pow(2,(m-69)/12); }
function midiToName(m){
  if(m==null) return "—";
  const r = Math.round(m), pc = ((r%12)+12)%12;
  const oct = Math.floor(r/12)-1;
  return (FLAT[pc]||LETTER[pc]) + oct;
}
function midiToSolf(m){
  if(m==null) return "—";
  const r = Math.round(m);
  return SOLFEGE[((r%12)+12)%12] + (Math.floor(r/12)-1);
}

/* ============ 谱面解析：文本 ============ */
const PART_NAMES = {S:"Soprano 女高",A:"Alto 女中",T:"Tenor 男高",B:"Bass 男低",
                    S1:"Soprano 1",S2:"Soprano 2",A1:"Alto 1",A2:"Alto 2",
                    T1:"Tenor 1",T2:"Tenor 2",B1:"Bass 1",B2:"Bass 2",VP:"Vocal Percussion"};

/* ============ 力度 ============ */
// 力度用意大利语标记，映射到 0..1 的相对强度。
// 数值取「听感上大致等距」，不是线性：p 到 f 的响度差远大于 f 到 ff。
const DYNAMICS = {
  ppp: 0.16, pp: 0.24, p: 0.34, mp: 0.46, mf: 0.58, f: 0.72, ff: 0.84, fff: 0.94,
}
// 注意：不接受数字简写。文本记谱里 1 已经是「一拍」，再让 1 当力度
// 会把 C4 1 D4 1 解析成「C4 力度 p、D4 力度 p」。

// 默认力度：mf。没写力度的谱面和以前的听感一致（以前是固定 0.88 速度 / 固定增益）。
const DEFAULT_VELOCITY = 0.58

// 0..1 的力度 → MIDI 力度值 1..127。
// 用平方根而不是线性：MIDI 力度本身感知上就不线性，
// 直接线性映射会让 p 到 mp 的差别几乎听不出来。
function velocityToMidi(v) {
  const x = Math.max(0, Math.min(1, v == null ? DEFAULT_VELOCITY : v))
  return Math.max(1, Math.min(127, Math.round(Math.pow(x, 0.6) * 127)))
}

// 反向：MIDI 力度 → 0..1，用于解析 MusicXML 的 <velocity>
function midiToVelocity(n) {
  const x = Math.max(1, Math.min(127, n == null ? 74 : n))
  return Math.pow(x / 127, 1 / 0.6)
}

const isDynamics = (tok) => Object.prototype.hasOwnProperty.call(DYNAMICS, String(tok).toLowerCase())

// 文本记谱里的力度标记：
//   C4 1 mf        单个音标力度
//   !f / !mf       整行（整个声部）从这个位置开始换力度，之后的音都跟着变
// 力度也可以写在时值前面：C4 mf 1
function parseNoteList(body){
  const toks = String(body).replace(/\|/g," ").split(/[\s,]+/).filter(Boolean);
  const notes = [];
  let i = 0;
  // 行级力度：遇到 !f 这类标记就改，后面的音都用它
  let lineVel = DEFAULT_VELOCITY;
  while(i < toks.length){
    const t = toks[i];
    // 行级力度标记 !f / !mf
    if(t.length > 1 && t[0] === "!"){
      const key = t.slice(1).toLowerCase();
      if(isDynamics(key)) lineVel = DYNAMICS[key];
      i++;
      continue;
    }
    if(t === "-" || t === "_" || t === "~"){
      let b = 1;
      if(i+1 < toks.length && /^\d+(\.\d+)?$/.test(toks[i+1])){ b = parseFloat(toks[i+1]); i++; }
      i++;
      if(notes.length) notes[notes.length-1].beats += b;
      continue;
    }
    if(/^\d+(\.\d+)?$/.test(t)){ i++; continue; }   // 孤立数字，跳过
    // 音名后面可以直接跟力度：C4 mf 1
    let vel = lineVel;
    let beats = 1;
    let hasBeats = false;
    if(i+1 < toks.length && isDynamics(toks[i+1])){ vel = DYNAMICS[toks[i+1].toLowerCase()]; i++; }
    if(i+1 < toks.length && /^\d+(\.\d+)?$/.test(toks[i+1])){
      const v = parseFloat(toks[i+1])
      // 时值必须为正。0 会让下游的时间轴不前进（排期错位、导出幽灵音、
      // 编配可能死循环），当作非法输入丢弃，音符本身仍保留为 1 拍。
      if(v > 0) beats = v
      i++
      hasBeats = true
    }
    // 力度写在时值后面：C4 1 mf
    if(i+1 < toks.length && isDynamics(toks[i+1])){ vel = DYNAMICS[toks[i+1].toLowerCase()]; i++; }
    i++;
    if(t === "r" || t === "R" || t === "0"){ notes.push({midi:null, beats}); }
    else{
      const midi = nameToMidi(t);
      if(midi != null) notes.push({midi, beats, vel});
    }
  }
  return notes;
}

function parseTextScore(text){
  let bpm = 96, bar = 4, title = "自定义谱面";
  const parts = [];
  for(const raw of text.split(/\r?\n/)){
    const line = raw.trim();
    if(!line || line.startsWith("#")) continue;
    let m;
    if((m = /^(?:title|标题)\s*[：:]?\s*(.+)$/i.exec(line))){ title = m[1].trim(); continue; }
    if((m = /^bpm\s*[：:]?\s*(\d+(?:\.\d+)?)$/i.exec(line))){ bpm = parseFloat(m[1]); continue; }
    if((m = /^(?:bar|拍号)\s*[：:]?\s*(\d+)$/i.exec(line))){ bar = parseInt(m[1],10); continue; }
    if((m = /^([A-Za-z][A-Za-z0-9]{0,3}|[\u4e00-\u9fa5]{1,6})\s*[:：]\s*(.+)$/.exec(line))){
      const id = m[1].toUpperCase();
      const notes = parseNoteList(m[2]);
      if(notes.length) parts.push({id, name:(PART_NAMES[id]||m[1]), notes});
      continue;
    }
  }
  // 传统跟着曲目走（见 lib/traditions.js）。文本谱可以写 `传统: dong` / `tradition: dong` 指定。
  let tradition = "western";
  const trLine = /^(?:tradition|传统)\s*[:：]\s*(\w+)\s*$/im.exec(text);
  if (trLine) tradition = trLine[1].toLowerCase();
  return {title, bpm, bar, parts, tradition};
}

/* ============ 谱面解析：MusicXML ============ */
function parseMusicXML(xmlText){
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if(doc.querySelector("parsererror")) throw new Error("XML 解析失败");
  const score = doc.querySelector("score-partwise") || doc.querySelector("score-timewise");
  if(!score) throw new Error("不是 MusicXML（需要 score-partwise）");

  let bpm = 96, bar = 4;
  // 速度标记两种写法都要认：<metronome><per-minute> 和 <sound tempo="">
  const met = score.querySelector("metronome per-minute");
  if(met && parseFloat(met.textContent)) bpm = parseFloat(met.textContent);
  else{
    const snd = score.querySelector("sound[tempo]");
    if(snd && parseFloat(snd.getAttribute("tempo"))) bpm = parseFloat(snd.getAttribute("tempo"));
  }
  const beatsEl = score.querySelector("time beats");
  if(beatsEl && parseInt(beatsEl.textContent,10)) bar = parseInt(beatsEl.textContent,10);

  const partEls = Array.from(score.querySelectorAll("part"));
  const parts = [];
  for(const pe of partEls){
    const pid = pe.getAttribute("id") || ("P"+(parts.length+1));
    const sp = score.querySelector('part-list score-part[id="'+cssEsc(pid)+'"]');
    const pn = sp ? (sp.querySelector("part-name")||sp.querySelector("part-abbreviation")) : null;
    const rawName = pn ? pn.textContent.trim() : pid;
    const id = normPartId(rawName) || pid.toUpperCase();

    let divisions = 4;
    const notes = [];
    // divisions（每个四分音符的 tick 数）写在 <attributes> 里，不在 <note> 里。
    // 必须逐小节读取，否则整份谱的音符时值都会按错误基准换算（常见值有 1/2/4/8）
    for(const me of Array.from(pe.querySelectorAll("measure"))){
      const dvEl = me.querySelector("attributes divisions");
      if(dvEl) divisions = Math.max(1, parseInt(dvEl.textContent,10) || divisions);
      for(const ne of Array.from(me.querySelectorAll("note"))){
        const durEl = ne.querySelector("duration");
        let beats = 1;
        if(durEl) beats = (parseInt(durEl.textContent,10) || divisions) / divisions;
        if(ne.querySelector("chord")) continue;             // 和弦内音：只保留第一个
        if(ne.querySelector("grace")) continue;             // 装饰音不计入节奏
        const rest = ne.querySelector("rest");
        if(rest){ notes.push({midi:null, beats}); continue; }
        const p = ne.querySelector("pitch");
        if(!p) continue;
        const step = (p.querySelector("step")||{}).textContent;
        const oct  = parseInt((p.querySelector("octave")||{}).textContent,10);
        const altEl = p.querySelector("alter");
        const alter = altEl ? (parseInt(altEl.textContent,10)||0) : 0;
        if(!step || isNaN(oct)) continue;
        const midi = (oct+1)*12 + STEP[step.toUpperCase()] + alter;
        // 读 <velocity>：我们自己导出的 MusicXML 会写它，
        // 其它软件导出的谱多半没有，没有就走默认力度。
        const velEl = ne.querySelector("velocity");
        const vel = velEl ? midiToVelocity(parseInt(velEl.textContent,10)) : undefined;
        const tied = ne.querySelector('tie[type="stop"]') ||
                     ne.querySelector('notations tied[type="stop"]');
        if(tied && notes.length && notes[notes.length-1].midi === midi){
          notes[notes.length-1].beats += beats;
        }else{
          notes.push(vel == null ? {midi, beats} : {midi, beats, vel});
        }
      }
    }
    if(notes.length) parts.push({id, name:(PART_NAMES[id]||rawName), notes});
  }
  let title = "导入的谱面";
  const tEl = score.querySelector("work work-title");
  if(tEl && tEl.textContent.trim()) title = tEl.textContent.trim();
  // 传统是曲目属性。导入的 MusicXML 一般不带这个信息，默认西方四部和声，
  // 用户可以在谱库里对单首曲子改。若 <miscellaneous-field> 里写了就取它。
  let tradition = "western";
  for(const f of Array.from(score.querySelectorAll("miscellaneous-field"))){
    if((f.getAttribute("name")||"").toLowerCase() === "tradition" && f.textContent.trim())
      tradition = f.textContent.trim().toLowerCase();
  }
  return {title, bpm, bar, parts, tradition};
}
/* ===== .mxl 支持：MuseScore 默认导出的是压缩后的 zip，需要解开 ===== */
async function readScoreFile(file){
  const name = (file.name || "").toLowerCase();
  if(name.endsWith(".mscz") || name.endsWith(".mscx"))
    throw new Error("这是 MuseScore 工程文件，不是乐谱交换格式。请用 MuseScore 打开它，再「文件 → 导出 → Uncompressed MusicXML」");
  if(name.endsWith(".pdf"))
    throw new Error("PDF 里没有音符数据，要先做光学识别。单选中一个 PDF 时会自动送到服务器识别（需要先建好端口转发）；多选时请一次只选一个 PDF");
  let xml;
  if(name.endsWith(".mxl") || name.endsWith(".zip")){
    xml = await unzipScoreXml(new Uint8Array(await file.arrayBuffer()));
  } else {
    xml = await file.text();
  }
  const score = parseMusicXML(xml);
  // 留住原始 XML：渲染时直接用它，能保留原谱的歌词、连线、力度等排版信息
  score._xml = xml;
  return score;
}

async function unzipScoreXml(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u32 = (o) => dv.getUint32(o, true), u16 = (o) => dv.getUint16(o, true);
  const SIG_CD = 0x02014b50, SIG_EOCD = 0x06054b50;
  let eocd = -1;
  for(let i = u8.length - 22; i >= 0 && i >= u8.length - 65558; i--){
    if(u32(i) === SIG_EOCD){ eocd = i; break; }
  }
  if(eocd < 0) throw new Error("不是有效的 .mxl 压缩包");
  const count = u16(eocd + 10);
  let cd = u32(eocd + 16);
  const entries = [];
  for(let n = 0; n < count; n++){
    if(u32(cd) !== SIG_CD) break;
    const method = u16(cd+10), csize = u32(cd+20), usize = u32(cd+24);
    const nlen = u16(cd+28), elen = u16(cd+30), clen = u16(cd+32), lho = u32(cd+42);
    const fname = new TextDecoder().decode(u8.subarray(cd+46, cd+46+nlen));
    const lnlen = u16(lho+26), lelen = u16(lho+28);
    entries.push({fname, method, csize, usize, off: lho + 30 + lnlen + lelen});
    cd += 46 + nlen + elen + clen;
  }
  if(!entries.length) throw new Error("压缩包是空的");

  // 规范做法：先看 META-INF/container.xml 指明的乐谱路径
  let target = null;
  const cont = entries.find(e => /META-INF\/container\.xml$/i.test(e.fname));
  if(cont){
    try{
      const txt = await inflateEntry(u8, cont);
      const m = /full-path\s*=\s*"([^"]+)"/.exec(txt);
      if(m) target = entries.find(e => e.fname === m[1]) || null;
    }catch(e){ /* container 读不了就退回按文件名猜 */ }
  }
  if(!target){
    const cands = entries.filter(e => !/^META-INF\//i.test(e.fname) && /\.(xml|musicxml)$/i.test(e.fname));
    if(!cands.length) throw new Error("包里没找到乐谱 xml");
    cands.sort((a,b) => b.csize - a.csize);   // 乐谱文件通常远大于元数据
    target = cands[0];
  }
  return await inflateEntry(u8, target);
}

async function inflateEntry(u8, e){
  const raw = u8.subarray(e.off, e.off + e.csize);
  if(e.method === 0) return new TextDecoder("utf-8").decode(raw);
  if(e.method !== 8) throw new Error("不支持的压缩方式（method=" + e.method + "）");
  if(typeof DecompressionStream === "undefined")
    throw new Error("当前浏览器不支持解压 .mxl，请在 MuseScore 里改导出「Uncompressed MusicXML (*.xml)」");
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

function cssEsc(s){ return String(s).replace(/["\\]/g,"\\$&"); }
function normPartId(name){
  const s = String(name).trim();
  const direct = s.toUpperCase().replace(/[^A-Z0-9]/g,"");
  if(PART_NAMES[direct]) return direct;
  // 分部要保住编号：Bass 1 / Bass 2 不能都并成 B
  const m = /(?:^|\D)([1-9])(?:\D|$)/.exec(s);
  const n = m ? m[1] : "";
  if(/sop|女高|高音/i.test(s)) return "S" + n;
  if(/alt|女中|中音|次高/i.test(s)) return "A" + n;
  if(/ten|男高|次中/i.test(s)) return "T" + n;
  if(/bas|男低|低音/i.test(s)) return "B" + n;
  return direct.slice(0,3) || null;
}

/* ============ 内置示例 ============ */
const DEMOS = {
  // 传统是曲目属性（见 lib/traditions.js），示例曲目都是西方功能和声。
  demo1: {title:"卡农和声垫（C大调 8小节）", bpm:84, bar:4, tradition:"western",
    parts:[
      {id:"S",name:PART_NAMES.S,notes:[
        {midi:nameToMidi("G4"),beats:4},{midi:nameToMidi("G4"),beats:4},
        {midi:nameToMidi("A4"),beats:4},{midi:nameToMidi("G4"),beats:4},
        {midi:nameToMidi("A4"),beats:4},{midi:nameToMidi("G4"),beats:4},
        {midi:nameToMidi("A4"),beats:4},{midi:nameToMidi("G4"),beats:4}]},
      {id:"A",name:PART_NAMES.A,notes:[
        {midi:nameToMidi("E4"),beats:4},{midi:nameToMidi("D4"),beats:4},
        {midi:nameToMidi("E4"),beats:4},{midi:nameToMidi("B3"),beats:4},
        {midi:nameToMidi("F4"),beats:4},{midi:nameToMidi("E4"),beats:4},
        {midi:nameToMidi("C4"),beats:4},{midi:nameToMidi("D4"),beats:4}]},
      {id:"T",name:PART_NAMES.T,notes:[
        {midi:nameToMidi("C4"),beats:4},{midi:nameToMidi("B3"),beats:4},
        {midi:nameToMidi("C4"),beats:4},{midi:nameToMidi("E3"),beats:4},
        {midi:nameToMidi("C4"),beats:4},{midi:nameToMidi("C4"),beats:4},
        {midi:nameToMidi("F3"),beats:4},{midi:nameToMidi("B3"),beats:4}]},
      {id:"B",name:PART_NAMES.B,notes:[
        {midi:nameToMidi("C3"),beats:4},{midi:nameToMidi("G2"),beats:4},
        {midi:nameToMidi("A2"),beats:4},{midi:nameToMidi("E2"),beats:4},
        {midi:nameToMidi("F2"),beats:4},{midi:nameToMidi("C3"),beats:4},
        {midi:nameToMidi("F2"),beats:4},{midi:nameToMidi("G2"),beats:4}]}
    ]},
  demo2: {title:"欢乐颂（Ode to Joy，示范四部和声）", bpm:100, bar:4, tradition:"western",
    parts:[
      {id:"S",name:PART_NAMES.S,notes:parseNoteList(
        "E4 1 E4 1 F4 1 G4 1 | G4 1 F4 1 E4 1 D4 1 | C4 1 C4 1 D4 1 E4 1 | E4 1.5 D4 0.5 D4 2 | E4 1 E4 1 F4 1 G4 1 | G4 1 F4 1 E4 1 D4 1 | C4 1 C4 1 D4 1 E4 1 | D4 1.5 C4 0.5 C4 2")},
      {id:"A",name:PART_NAMES.A,notes:parseNoteList(
        "C4 2 D4 2 | C4 2 D4 2 | G3 4 | G3 2 B3 2 | C4 2 D4 2 | C4 2 D4 2 | G3 4 | B3 2 G3 2")},
      {id:"T",name:PART_NAMES.T,notes:parseNoteList(
        "G3 2 B3 2 | G3 2 B3 2 | E3 4 | E3 2 D3 2 | G3 2 B3 2 | G3 2 B3 2 | E3 4 | D3 2 E3 2")},
      {id:"B",name:PART_NAMES.B,notes:parseNoteList(
        "C3 2 G2 2 | C3 2 G2 2 | C3 4 | C3 2 G2 2 | C3 2 G2 2 | C3 2 G2 2 | C3 4 | G2 2 C3 2")}
    ]}
};


// 整谱移调：返回一份音高都加了 semitones 的副本，其余字段（时值、力度、
// 分句）原样保留。谱面是只读数据，不能就地改——撤销历史和「我的谱」
// 里存的都是原调，改了会把原谱也一起改掉。
//
// 休止符 midi 为 null，原样跳过。
function transposeScore(score, semitones) {
  const st = Math.round(semitones || 0)
  if (!st || !score || !Array.isArray(score.parts)) return score
  return {
    ...score,
    // 移过调的谱不能再当作原始 XML 渲染：_xml 记的是原调，直接用会
    // 出现「声音变了、谱面没变」的错位
    _xml: null,
    parts: score.parts.map((p) => ({
      ...p,
      notes: (p.notes || []).map((n) =>
        n.midi == null ? n : { ...n, midi: n.midi + st }
      ),
    })),
  }
}

export { nameToMidi, midiToName, midiToSolf, midiToFreq, PART_NAMES,
         parseNoteList, parseTextScore, parseMusicXML, readScoreFile, DEMOS,
         DYNAMICS, DEFAULT_VELOCITY, velocityToMidi, midiToVelocity,
         transposeScore };
