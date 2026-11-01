"""电子版简谱（numbered notation）解析器。

为什么这条路比五线谱便宜得多
============================
五线谱的音高藏在**符头位置**里，必须做图像识别（Audiveris：单页十几秒、要 JVM）。
电子版简谱不一样：

  * 音高数字、调号 `1 = C`、拍号 `4/4` 都在**文字层**里，直接读
  * 八度点、减时线、小节线是**矢量图元**，pymupdf 能拿到坐标
  * 所以整条链路是确定性的解析，没有机器学习、没有 OMR 引擎，几毫秒跑完

简谱记法速查（本解析器覆盖的）
==============================
  1-7        音级（首调唱名，相对调号）
  0          休止
  高八度      数字上方的点
  低八度      数字下方的点
  －  (增时线) 每根延长一拍
  下划线      每根缩短一半（1 根=八分，2 根=十六分）
  附点        . 延长该音时值的一半
  |          小节线

设计要点：先按"行/声部"把文字分组，再用**几何位置**把矢量图元挂到具体数字上。
不用正则硬猜，因为下划线和八度点只有坐标，没有语义。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

import pymupdf

# ---------------------------------------------------------------- 调号

# 简谱 1=X 的 X 是**大调主音**。转成绝对音高时先按 X 定基准，
# 之后 App 的 transposeScore 负责移调（用户要求：调调就用移调就行）。
KEY_PC = {
    "C": 0, "C#": 1, "DB": 1, "D": 2, "D#": 3, "EB": 3, "E": 4, "FB": 5,
    "F": 5, "F#": 6, "GB": 6, "G": 7, "G#": 8, "AB": 8, "A": 9, "A#": 10,
    "BB": 10, "B": 11, "CB": 11,
}


def normalise_key(raw: str | None) -> str:
    """把 `Bb` / `bB` / `B♭` / `bb` 之类统一成 KEY_PC 的键。

    出版方的写法很杂：`1=Bb`、`1=bB`、`1=B♭` 都见过。
    坑在哪：`Bb` 的第二个字符是**降号 b**，不是大小写变体。
    所以不能 `s[1].lower() == 'b'` 就当成降号——`B` + `b` 是降 B，
    但 `B` 单独出现时是高音 B，两者差一个半音，弄错整首谱就全偏。

    规则：首字符取字母，其后只要出现 `b`/`♭` 就是降号，
    `#`/`♯` 是升号；统一成 ASCII 后查表。
    """
    if not raw:
        return "C"
    s = raw.strip().replace("♯", "#").replace("♭", "b")
    if not s:
        return "C"
    # 少数出版方把降号写在字母前面：`bB` / `bE`
    if s[0] == "b" and len(s) > 1 and s[1].isalpha():
        letter = s[1].upper()
        acc = "b"
    elif s[0] == "#" and len(s) > 1 and s[1].isalpha():
        letter = s[1].upper()
        acc = "#"
    else:
        letter = s[0].upper()
        acc = s[1:]
    if "#" in acc:
        cand = letter + "#"
    elif "b" in acc:
        cand = letter + "b"
    else:
        cand = letter
    if cand.upper() in KEY_PC:
        return cand.upper()
    return letter if letter in KEY_PC else "C"

# 1=C 时，简谱 1..7 对应的 MIDI 半音偏移（大调音节）
MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]

# 1=C 时 `1` 落在哪个八度。简谱没有绝对八度，取 C4 为基准，
# 与 App 里 midiToName 的习惯一致（C4 = 60）。
BASE_MIDI = 60


@dataclass
class Token:
    """一个谱面事件（数字或休止）及其修饰。"""
    digit: int                       # 0..7
    x: float
    y: float
    w: float = 10.0                  # 数字的宽度：点/线的锚点要用中心
    octave: int = 0                  # 上方点 +1，下方点 -1
    dashes: int = 0                  # 增时线根数
    underlines: int = 0              # 减时线根数
    dotted: bool = False             # 附点
    bar: int = 0                     # 属于第几小节（0 起）


@dataclass
class Voice:
    name: str
    short: str
    tokens: list[Token] = field(default_factory=list)


# ---------------------------------------------------------------- 文字层

_PART_RE = re.compile(
    r"^\s*(?P<cn>[\u4e00-\u9fa5]{2,6})\s*[:：]\s*"
    r"|^\s*(?P<cn2>[\u4e00-\u9fa5]{2,6})\s+(?P<short>[A-Za-z]{1,4})\s*[:：]?"
)
_PART_LABEL_RE = re.compile(
    r"^\s*(?P<cn>[\u4e00-\u9fa5]{2,6})\s*(?:(?P<short>[A-Za-z]{1,4})\s*)?[:：]\s*"
)
_KEY_RE = re.compile(r"1\s*=\s*([A-Ga-g][#b♯♭]?)")
_METER_RE = re.compile(r"(\d+)\s*/\s*(\d+)")


def _norm_digit_word(w: str) -> int | None:
    """Accept ASCII digits and full-width digits as a single note digit."""
    if not w:
        return None
    m = re.fullmatch(r"[0-9０-９]", w.strip())
    if not m:
        return None
    return int(w.strip().translate(str.maketrans("０１２３４５６７８９", "0123456789")))


def _rows(page) -> list[list[dict]]:
    """按行分组文字。用 dict 模式的坐标而不是 words：

    简谱一行里声部名和数字的**基线不同**（声部名字号小、基线低），
    words 逐词匹配会把它们拆到不同行，导致整行声部识别失败。
    按 y 中心聚成一簇再排序，才能稳定地还原"一行就是一个声部"。

    注意：同一个 span 里常出现 `5 －` 这种"数字+增时线"连写，
    所以要**按字符再拆一层**，否则数字会被整块吞掉。
    """
    raw = page.get_text("dict")
    items = []
    for block in raw.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                txt = span.get("text", "")
                if not txt.strip():
                    continue
                x0, y0, x1, y1 = span["bbox"]
                size = span.get("size", 10)
                # 把一个 span 拆成单个字符，按比例分配 x 范围
                chars = [c for c in txt]
                if len(chars) == 1:
                    pieces = [(txt, x0, x1)]
                else:
                    # 用等宽近似（中文/数字混排够用），只影响相邻字符的 x 精度
                    span_w = max(x1 - x0, 1.0)
                    cw = span_w / len(chars)
                    pieces = [(c, x0 + i * cw, x0 + (i + 1) * cw)
                              for i, c in enumerate(chars)]
                for ch, cx0, cx1 in pieces:
                    if not ch.strip():
                        continue
                    items.append({
                        "x": cx0, "y": (y0 + y1) / 2.0, "y0": y0, "y1": y1,
                        "w": max(cx1 - cx0, 1.0),
                        "text": ch, "size": size,
                    })
    if not items:
        return []

    # 按字号估一个行高阈值：同一行的文字中心 y 差异不会超过最大字号
    max_size = max(i["size"] for i in items) or 12.0
    tol = max_size * 1.2

    items.sort(key=lambda i: i["y"])
    rows, cur, cur_y = [], [], None
    for it in items:
        if cur_y is None or abs(it["y"] - cur_y) <= tol:
            cur.append(it)
            cur_y = it["y"] if cur_y is None else (cur_y + it["y"]) / 2.0
        else:
            rows.append(cur)
            cur, cur_y = [it], it["y"]
    if cur:
        rows.append(cur)
    return [sorted(r, key=lambda i: i["x"]) for r in rows]


def parse_text_layer(page) -> tuple[str | None, int, int, list[Voice]]:
    """Extract key, meter and per-voice digit positions from the text layer."""
    rows = _rows(page)
    if not rows:
        return None, 4, 4, []

    key = None
    meter_beats, meter_type = 4, 4
    voices: list[Voice] = []
    cur: Voice | None = None

    for row in rows:
        row_text = "".join(it["text"] for it in row).strip()

        # 调号 / 拍号（通常只在标题行）
        if key is None:
            mk = _KEY_RE.search(row_text)
            if mk:
                key = normalise_key(mk.group(1))
        mm = _METER_RE.search(row_text)
        if mm and 1 <= int(mm.group(1)) <= 32 and int(mm.group(2)) in (2, 4, 8, 16):
            meter_beats, meter_type = int(mm.group(1)), int(mm.group(2))

        # 声部名：本行最左边连续的汉字，后面可选 S/A/T/B 这类缩写和冒号。
        # 字符已被拆开，所以先收集行首的汉字字符再拼回名字。
        lead_cn = []
        idx = 0
        while idx < len(row) and re.fullmatch(r"[\u4e00-\u9fa5]", row[idx]["text"]):
            lead_cn.append(row[idx]["text"])
            idx += 1
        if 2 <= len(lead_cn) <= 6:
            # 后面允许跟一个短缩写和冒号
            j = idx
            short = None
            if j < len(row) and re.fullmatch(r"[A-Za-z]{1,4}", row[j]["text"]):
                short = row[j]["text"].upper()
                j += 1
            has_colon = j < len(row) and row[j]["text"] in ":："
            if has_colon or short:
                cur = Voice("".join(lead_cn), short or "".join(lead_cn)[0].upper())
                voices.append(cur)

        d_tokens = [it for it in row if _norm_digit_word(it["text"]) is not None]
        if not d_tokens:
            continue

        # 排除非谱面行：标题行的 `1 = C` / `4/4`、页脚的 `第 1 页` 里的数字
        # 不是音符。判据是这一行里出现了调号、拍号、或页码/曲名文字。
        if _KEY_RE.search(row_text) or _METER_RE.search(row_text):
            continue
        if re.search(r"第\s*\d+\s*页|页\s*\d+|page", row_text, re.I):
            continue
        if len(d_tokens) / max(len(row), 1) < 0.25 and len(d_tokens) <= 2:
            # 一行里绝大多数是文字，只有一两个孤零零的数字 -> 不是谱面行
            continue

        if cur is None:
            # 完全没有声部名：整份当单声部旋律
            cur = Voice("旋律", "M")
            voices.append(cur)

        for it in d_tokens:
            d = _norm_digit_word(it["text"])
            cur.tokens.append(Token(digit=d, x=it["x"], y=it["y"], w=it["w"]))

        # 增时线挂在**最后一个数字之后**：找出位于该数字右侧的 "－"
        last_x = max(it["x"] for it in d_tokens)
        if cur.tokens:
            tail_dashes = sum(
                1 for it in row
                if it["x"] > last_x and ("－" in it["text"] or "—" in it["text"]
                                         or it["text"].strip() in ("-", "一"))
            )
            if tail_dashes:
                cur.tokens[-1].dashes += tail_dashes

    return key, meter_beats, meter_type, voices


# ---------------------------------------------------------------- 矢量层


def _horizontal_segments(page) -> list[tuple[float, float, float]]:
    """纵向找水平线段：减时线（下划线）和小节线都是矢量图元。"""
    out = []
    for d in page.get_drawings():
        for item in d.get("items", []):
            if item[0] == "l":
                p1, p2 = item[1], item[2]
                if abs(p1.y - p2.y) < 0.8:            # 水平
                    out.append((min(p1.x, p2.x), max(p1.x, p2.x), p1.y))
    return out


def _vertical_segments(page) -> list[tuple[float, float]]:
    """竖直线段 = 小节线，返回 (x, y)。"""
    out = []
    for d in page.get_drawings():
        for item in d.get("items", []):
            if item[0] == "l":
                p1, p2 = item[1], item[2]
                if abs(p1.x - p2.x) < 0.8 and abs(p1.y - p2.y) > 6:
                    out.append((p1.x, (p1.y + p2.y) / 2.0))
    return out


def _dot_blobs(page) -> list[tuple[float, float]]:
    """八度点 / 附点：小的实心圆或方。"""
    out = []
    for d in page.get_drawings():
        r = d.get("rect")
        if r is None:
            continue
        w, h = r.x1 - r.x0, r.y1 - r.y0
        if 0.8 <= w <= 6.0 and 0.8 <= h <= 6.0:
            out.append(((r.x0 + r.x1) / 2.0, (r.y0 + r.y1) / 2.0))
    return out


def attach_vector_marks(page, voices: Iterable[Voice], x_tol: float = 9.0,
                        y_up: float = 26.0, y_down: float = 16.0) -> None:
    """把矢量图元按几何位置挂到最近的数字上。

    这是整个解析器唯一"需要判断"的地方：下划线和八度点只有坐标，
    必须靠 x 邻近 + y 的相对位置判定它属于哪个数字。

    判定规则（简谱通行写法）：
      * 上加点   -> 高八度；点在数字**正上方**
      * 下加点   -> 低八度；点在数字**正下方**
      * 附点     -> 延长一半；点在数字**右侧**、与数字中心大致同高
      * 下划线   -> 缩短一半；线段在数字下方、水平覆盖数字
    附点与低八度点都在下方，区别在水平位置：附点偏右，下加点居中。
    """
    segs = _horizontal_segments(page)
    dots = _dot_blobs(page)

    for voice in voices:
        if not voice.tokens:
            continue
        for tok in voice.tokens:
            # --- 减时线：线段落在数字下方、水平覆盖数字 ---
            n_under = 0
            for x0, x1, y in segs:
                # 线段需要横向覆盖该数字的水平范围
                if x1 >= tok.x - 1 and x0 <= tok.x + tok.w + 1:
                    if 0 < y - tok.y <= y_down:
                        n_under += 1
            tok.underlines = min(n_under, 2)

        # --- 八度点 / 附点 ---
        for tok in voice.tokens:
            cx_tok = tok.x + tok.w / 2.0      # 点的锚点是数字中心
            for cx, cy in dots:
                dx, dy = cx - cx_tok, cy - tok.y
                if not (-x_tol <= dx <= x_tol * 1.6):
                    continue
                if -y_up <= dy < -2.0:
                    tok.octave += 1            # 上方点 -> 高八度
                elif 2.0 < dy <= y_down:
                    # 下方：偏右是附点，居中/偏左是低八度
                    if dx > x_tol * 0.6:
                        tok.dotted = True
                    else:
                        tok.octave -= 1


# ---------------------------------------------------------------- 语义


def _digit_to_midi(digit: int, octave: int, key_pc: int) -> int | None:
    """简谱音级 → 绝对 MIDI。digit=0 是休止，返回 None。"""
    if digit <= 0 or digit > 7:
        return None
    return BASE_MIDI + key_pc + MAJOR_STEPS[digit - 1] + 12 * octave


def _beats_of(tok: Token) -> float:
    """时值（拍）。

    简谱的时值规则不是简单连乘：
      * 减时线（下划线）只作用于**基础的一拍**，减半/减到四分之一
      * 增时线（－）在基础时值之外**追加整拍**，不参与减半
      * 附点延长的是（基础时值 + 增时线）的**一半**

    所以 `1 -` 下加一根减时线是 0.5 + 1 = 1.5 拍，而不是 (1+1)/2 = 1 拍。
    这个区别一开始算错过了，会让跨小节的位置整体偏移。
    """
    base = 1.0
    for _ in range(tok.underlines):
        base /= 2.0
    beats = base + tok.dashes
    if tok.dotted:
        beats *= 1.5
    return max(beats, 0.125)


_SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_STEP_OF_PC = {0: ("C", 0), 1: ("C", 1), 2: ("D", 0), 3: ("D", 1), 4: ("E", 0),
               5: ("F", 0), 6: ("F", 1), 7: ("G", 0), 8: ("G", 1), 9: ("A", 0),
               10: ("A", 1), 11: ("B", 0)}


def midi_to_step_octave(midi: int) -> tuple[str, int, int]:
    """MIDI -> (step, octave, alter)。

    服务端的 `to_musicxml()` 按 `step/octave/alter` 写谱，不是按 midi。
    简谱只给音级，所以这里统一用升号拼写；简谱本来没有等音选择的问题。
    """
    pc = midi % 12
    octave = midi // 12 - 1
    step, alter = _STEP_OF_PC[pc]
    return step, octave, alter


def tokens_to_part(voice: Voice, key_pc: int, bar: int) -> dict:
    """Voice tokens → App 服务端的 part 结构（measures/events）。"""
    events = []
    cursor = 0.0
    measure_events = []
    for tok in voice.tokens:
        beats = _beats_of(tok)
        midi = _digit_to_midi(tok.digit, tok.octave, key_pc)
        ev = {"onset": round(cursor, 4), "beats": round(beats, 4),
              "rest": midi is None, "midi": midi}
        if midi is not None:
            step, octave, alter = midi_to_step_octave(midi)
            ev.update({"step": step, "octave": octave, "alter": alter, "cents": 0})
        # 小节边界：当前音跨过 bar 就切成两小节
        while cursor + beats > bar + 1e-9 and bar > 0:
            room = bar - cursor
            if room > 1e-9:
                measure_events.append({**ev, "beats": round(room, 4)})
            events.append(measure_events)
            measure_events = []
            beats -= room
            cursor = 0.0
            ev = {**ev, "onset": 0.0, "beats": round(beats, 4)}
            # 跨小节的后半段要标连音，否则会被读成两个独立的音
            if not ev["rest"]:
                ev["tie_stop"] = True
                if measure_events:
                    measure_events[-1]["tie_start"] = True
        measure_events.append(ev)
        cursor += beats
        if abs(cursor - bar) < 1e-9:
            events.append(measure_events)
            measure_events = []
            cursor = 0.0
    if measure_events:
        events.append(measure_events)

    measures = [{"index": i + 1, "events": evs, "limit": float(bar)}
                for i, evs in enumerate(events)]
    return {
        "id": voice.short,
        "name": voice.name,
        "measures": measures,
    }


def parse_jianpu_pdf(path: str | Path) -> dict:
    """电子版简谱 PDF → 服务端 score 结构。"""
    doc = pymupdf.open(str(path))
    try:
        key, beats, beat_type, voices = None, 4, 4, []
        for page in doc:
            k, b, bt, vs = parse_text_layer(page)
            if k and key is None:
                key = k
            if vs:
                beats, beat_type = b, bt
                attach_vector_marks(page, vs)
                _merge_voices(voices, vs)
    finally:
        doc.close()

    if key is None:
        key = "C"
    key_pc = KEY_PC.get(key, 0)

    # 拍号换算成"每小节几拍"（四分音符为一拍）
    bar = beats * 4.0 / beat_type

    parts = [tokens_to_part(v, key_pc, bar) for v in voices if v.tokens]
    return {
        "title": "",
        "bpm": 96,
        "bar": bar,
        "key": key,
        "parts": parts,
    }


def _merge_voices(dst: list[Voice], src: Iterable[Voice]) -> None:
    """多页谱：同名声部跨页接起来。"""
    by_name = {v.name: v for v in dst}
    for v in src:
        if v.name in by_name:
            by_name[v.name].tokens.extend(v.tokens)
        else:
            dst.append(v)


def looks_like_jianpu(path: str | Path) -> tuple[bool, str]:
    """判定一份 PDF 是不是"电子版简谱"。

    判据刻意保守：宁可不认，也不要认错 —— 认错会把五线谱当简谱解析，
    产出一份音高全错的谱，比直接失败更糟。

    踩过的坑：只看 `1=X` + 数字数量会把**带调性标注的五线谱**误判成简谱
    （五线谱 PDF 里 `Key: 1 = G` 很常见，歌词里又有 `1.` `2.` 这类序号）。
    所以判据必须是**行级**的：简谱的谱面行是一条几乎纯数字的长串，
    而歌词/序号只是一行里零星几个数字。实测这个区分度足够稳。
    """
    try:
        doc = pymupdf.open(str(path))
    except Exception as exc:                  # noqa: BLE001
        return False, f"打不开 PDF：{exc}"
    try:
        if doc.page_count == 0:
            return False, "空 PDF"
        pages = [doc[i] for i in range(min(doc.page_count, 3))]
        text = "\n".join((p.get_text("text") or "") for p in pages)
        if not text.strip():
            return False, "没有文字层（可能是扫描件），交给 Audiveris"
        if not _KEY_RE.search(text):
            return False, "没找到 1=X 调号，不像简谱"

        # 行级判据：找"数字为主"的行。
        # 注意不能用 get_text("text") 的行：简谱里每个数字常常各自成行，
        # 一行谱会被拆散。必须按**几何行**（同一 y 带）聚合，才能还原
        # "一行谱面 = 一串数字"。这正是 _rows() 做的事。
        #
        # 两个反例逼出来的规则：
        #  * 四声部简谱行首有「女高音」这类声部名 + 字母缩写 + 冒号，
        #    会把数字占比压到 60% 以下 -> 必须先剥掉行首标签再算比例。
        #  * 五线谱歌词里 `1. A - ma - zing grace` 也可能凑出几个数字，
        #    但它短且分散 -> 要求**一行里连续数字达到一定数量**才算谱面。
        note_lines = 0
        total_notes = 0
        for page in pages:
            for row in _rows(page):
                chars = [it["text"] for it in row if not it["text"].isspace()]
                if not chars:
                    continue
                # 剥掉行首的声部名（汉字 + 可选短字母 + 冒号）
                i = 0
                while i < len(chars) and re.fullmatch(r"[\u4e00-\u9fa5]", chars[i]):
                    i += 1
                if 2 <= i <= 6:
                    j = i
                    if j < len(chars) and re.fullmatch(r"[A-Za-z]{1,4}", chars[j]):
                        j += 1
                    if j < len(chars) and chars[j] in ":：":
                        j += 1
                    if j > i:
                        chars = chars[j:]
                note_chars = [c for c in chars if re.fullmatch(r"[0-7０-７]", c)]
                dash_chars = [c for c in chars if c in "－—"]
                content = len(chars) - len(dash_chars)
                if content <= 0:
                    continue
                ratio = len(note_chars) / content
                # 简谱一行谱面：数字占比高，且数字个数成规模。
                # 歌词序号 `1. 2. 3.` 这种一行只有零星数字，够不到 4。
                if ratio >= 0.6 and len(note_chars) >= 4:
                    note_lines += 1
                    total_notes += len(note_chars)

        if note_lines < 1:
            return False, "没有以数字为主的谱面行，不像简谱"
        if total_notes < 8:
            return False, f"数字谱面行里音符太少（{total_notes} 个），不像简谱"

        return True, (f"识别为电子版简谱（{note_lines} 行谱面，"
                      f"{total_notes} 个数字音符）")
    finally:
        doc.close()


def try_parse(path: str | Path):
    """服务端入口：是简谱就解析，否则返回 (None, [])。

    绝不抛异常给调用方 —— 简谱这条快路径只是优化，
    任何失败都应安静地回退给 Audiveris 主流程。
    """
    try:
        ok, reason = looks_like_jianpu(path)
        if not ok:
            return None, []
        score = parse_jianpu_pdf(path)
        if not score.get("parts"):
            return None, [f"简谱解析没有产出谱面（{reason}）"]
        notes = [f"简谱识别：{reason}"]
        skipped = [v for v in score.get("_skipped", [])]
        if skipped:
            notes.append(f"{len(skipped)} 行没能解析：" + ", ".join(skipped[:3]))
        score.pop("_skipped", None)
        return score, notes
    except Exception as exc:                   # noqa: BLE001
        return None, [f"简谱解析失败（{type(exc).__name__}: {exc}）"]


if __name__ == "__main__":
    import json
    import sys

    pdf = sys.argv[1] if len(sys.argv) > 1 else "samples/jianpu-4voice.pdf"
    score = parse_jianpu_pdf(pdf)
    print(json.dumps(score, ensure_ascii=False, indent=1)[:2000])
