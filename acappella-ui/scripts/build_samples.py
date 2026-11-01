#!/usr/bin/env python3
"""把 MuseScore 4 自带的音源拆成 Web 端能用的单音采样包。

为什么要自己拆：
  应用原来的音色是 Web Audio 现场合成的（见 src/lib/cue.js），听感是「电子琴」。
  想换成真实采样，最省事的办法是从 MuseScore 的 GM 音源里取。但实测发现
  MuseScore 4 命令行导出时 <midi-program> 和 MusicXML 的 part-name 都不可靠
  （十几种乐器名导出来是同一段音频），只有 .mscx 的 instrumentId 能稳定生效，
  而 instrumentId 与音色库 preset 的对应关系没有公开文档。于是不走 MuseScore
  的渲染，直接解析 SoundFont 文件，按 sample 名挑采样，音高和音色都可控。

输入：
  MS Basic.sf3（MuseScore 4 自带，MIT 许可，内含 FluidR3 采样）
  默认路径 C:/Program Files/MuseScore 4/sound/MS Basic.sf3

输出：
  src/assets/samples/<timbre>/*.ogg  单音采样（Ogg Vorbis，浏览器原生可解码）
  src/assets/samples/manifest.json   采样表，运行时按它加载

用法：
  python scripts/build_samples.py                 # 生成全部音色
  python scripts/build_samples.py --timbre choir  # 只生成一个
  python scripts/build_samples.py --check         # 只打印可用的采样，不写文件

注意：
  - 采样是单声道单独存的，左右声道在运行时按声部摆位。
  - 每个音色按小三度（3 个半音）取一个采样，运行时变调覆盖全音域；
    变调超过 3 个半音会有明显的共振峰偏移，所以间隔不能再放大。
"""

from __future__ import annotations

import argparse
import gc
import io
import json
import mmap
import re
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "src" / "assets" / "samples"
DEFAULT_SF = Path(r"C:\Program Files\MuseScore 4\sound\MS Basic.sf3")

# 音色定义：id 会写进 manifest，也是界面上音色选项的 key。
# match 是 sf3 里 sample 名的匹配规则（可写多条，按顺序取）；root_range 是
# 允许当根音的 MIDI 范围；step 是采样间隔（半音）；sustain > 0 表示这个音色
# 要循环延音（合唱/弦乐/管风琴），0 表示打击类、让采样自然衰减。
#
# 采样间隔的取舍：间隔越大包体越小，但变调越多共振峰越偏。step=3（小三度）
# 是听感和体积的平衡点；钢琴这类宽音域、对音色敏感的乐器用 step=2。
TIMBRES = {
    # ---- 人声 ----
    "choir": {
        "name": "合唱 啊",
        "match": [r"^Ahh Choir (?:[A-G][#b]?\d)-[LR]$"],
        "strip": r"-[LR]$",
        "root_range": (53, 91),
        "step": 2,
        "sustain": 0.55,
        "gain": 1.0,
    },
    "voiceO": {
        "name": "合唱 哦",
        "match": [r"^Ohh Voices (?:[A-G][#b]?\d)$"],
        "root_range": (60, 96),
        "step": 2,
        "sustain": 0.55,
        "gain": 1.0,
    },
    "soloVoice": {
        "name": "独唱 啊",
        "match": [r"^Solo Vox (?:[A-G][#b]?\d)$"],
        "root_range": (40, 84),
        "step": 3,
        "sustain": 0.4,
        "gain": 1.0,
    },
    # ---- 键盘 ----
    "piano": {
        "name": "钢琴",
        # 只取 mf 层（力度层由运行时按音符力度选，界面还没暴露力度编辑）
        "match": [r"^Piano MF (?:[A-G][#b]?\d)\(L\)$"],
        "strip": r"\(L\)$",
        "root_range": (21, 93),
        "step": 2,
        "sustain": 0.0,
        "gain": 1.15,
    },
    "harpsichord": {
        "name": "大键琴",
        "match": [r"^Harpsichord (?:[A-G][#b]?\d)$"],
        "root_range": (45, 84),
        "step": 2,
        "sustain": 0.0,
        "gain": 1.1,
    },
    "celesta": {
        "name": "钢片琴",
        "match": [r"^Celesta (?:[A-G][#b]?\d)$"],
        "root_range": (55, 88),
        "step": 2,
        "sustain": 0.0,
        "gain": 1.1,
    },
    # ---- 风琴 ----
    "organ": {
        "name": "管风琴",
        "match": [r"^Church Organ (?:[A-G][#b]?\d)$"],
        "root_range": (43, 84),
        "step": 3,
        "sustain": 0.7,
        "gain": 1.05,
    },
    "rockOrgan": {
        "name": "摇滚风琴",
        "match": [r"^Rock Organ (?:[A-G][#b]?\d)$"],
        "root_range": (56, 92),
        "step": 3,
        "sustain": 0.6,
        "gain": 1.0,
    },
    # ---- 弦乐 ----
    "strings": {
        "name": "弦乐合奏",
        "match": [r"^(?:Violin|Viola|Cello) (?:[A-G][#b]?\d)$"],
        "root_range": (40, 84),
        "step": 3,
        "sustain": 0.5,
        "gain": 1.0,
    },
    "violin": {
        "name": "小提琴",
        "match": [r"^Violin (?:[A-G][#b]?\d)$"],
        "root_range": (55, 93),
        "step": 2,
        "sustain": 0.45,
        "gain": 1.0,
    },
    "cello": {
        "name": "大提琴",
        "match": [r"^(?:Cello|Viola) (?:[A-G][#b]?\d)$"],
        "root_range": (36, 76),
        "step": 2,
        "sustain": 0.45,
        "gain": 1.0,
    },
    "contrabass": {
        "name": "低音提琴",
        "match": [r"^(?:Bass|Picked Bass|Finger Bass) (?:[A-G][#b]?\d)$"],
        "root_range": (28, 60),
        "step": 3,
        "sustain": 0.35,
        "gain": 1.05,
    },
    "harp": {
        "name": "竖琴",
        "match": [r"^Harp (?:[A-G][#b]?\d)$"],
        "root_range": (36, 88),
        "step": 2,
        "sustain": 0.0,
        "gain": 1.1,
    },
    # ---- 木管 ----
    "flute": {
        "name": "长笛",
        "match": [r"^Flute (?:[A-G][#b]?\d)$"],
        "root_range": (60, 88),
        "step": 2,
        "sustain": 0.45,
        "gain": 1.0,
    },
    "clarinet": {
        "name": "单簧管",
        "match": [r"^Clarinet (?:[A-G][#b]?\d)$"],
        "root_range": (52, 88),
        "step": 2,
        "sustain": 0.4,
        "gain": 1.0,
    },
    "oboe": {
        "name": "双簧管",
        "match": [r"^Oboe (?:[A-G][#b]?\d)$"],
        "root_range": (58, 84),
        "step": 2,
        "sustain": 0.4,
        "gain": 1.0,
    },
    "recorder": {
        "name": "竖笛",
        "match": [r"^Recorder (?:[A-G][#b]?\d)$", r"^Flute (?:[A-G][#b]?\d)$"],
        "root_range": (72, 96),
        "step": 2,
        "sustain": 0.35,
        "gain": 1.0,
    },
    # ---- 铜管 ----
    "trumpet": {
        "name": "小号",
        "match": [r"^Trumpet (?:[A-G][#b]?\d)$"],
        "root_range": (55, 84),
        "step": 2,
        "sustain": 0.4,
        "gain": 0.95,
    },
    "trombone": {
        "name": "长号",
        "match": [r"^Trombone (?:[A-G][#b]?\d)$"],
        "root_range": (45, 80),
        "step": 2,
        "sustain": 0.4,
        "gain": 0.95,
    },
    "tuba": {
        "name": "大号",
        "match": [r"^Tuba (?:[A-G][#b]?\d)$"],
        "root_range": (33, 70),
        "step": 3,
        "sustain": 0.4,
        "gain": 1.0,
    },
    "frenchHorn": {
        "name": "圆号",
        "match": [r"^French Horns? (?:[A-G][#b]?\d)$"],
        "root_range": (40, 80),
        "step": 2,
        "sustain": 0.4,
        "gain": 1.0,
    },
    # ---- 打击 ----
    "marimba": {
        "name": "木琴",
        "match": [r"^(?:Marimba|Xylophone) (?:[A-G][#b]?\d)$"],
        "root_range": (48, 84),
        "step": 2,
        "sustain": 0.0,
        "gain": 1.1,
    },
    "vibraphone": {
        "name": "颤音琴",
        "match": [r"^(?:Vibraphone|Marimba) (?:[A-G][#b]?\d)$"],
        "root_range": (55, 88),
        "step": 2,
        "sustain": 0.0,
        "gain": 1.1,
    },
    "xylophone": {
        "name": "木琴条",
        "match": [r"^Xylophone (?:[A-G][#b]?\d)$"],
        "root_range": (60, 96),
        "step": 2,
        "sustain": 0.0,
        "gain": 1.1,
    },
    "glockenspiel": {
        "name": "钟琴",
        "match": [r"^Glocken(?:spiel)? (?:[A-G][#b]?\d)$", r"^Celesta (?:[A-G][#b]?\d)$"],
        "root_range": (79, 108),
        "step": 2,
        "sustain": 0.0,
        "gain": 1.05,
    },
    "kalimba": {
        "name": "卡林巴",
        "match": [r"^Kalimba (?:[A-G][#b]?\d)$", r"^Steel Drum (?:[A-G][#b]?\d)$"],
        "root_range": (60, 88),
        "step": 2,
        "sustain": 0.0,
        "gain": 1.1,
    },
}

NOTE_PC = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5,
           "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}


def note_to_midi(name: str) -> int | None:
    """'C4' / 'F#5' / 'Bb3' → MIDI 音高。"""
    m = re.fullmatch(r"([A-G][#b]?)(-?\d)", name)
    if not m:
        return None
    return 12 * (int(m.group(2)) + 1) + NOTE_PC[m.group(1)]


def midi_of_record(rec: dict) -> int | None:
    """采样的真实 MIDI 音高。

    优先用 shdr 的 originalPitch（SoundFont 规范里就是「这个采样的音高」）。
    只有它为 0 或缺失时才退回文件名推断——originalPitch=0 在规范里
    表示「未指定」，有些老音源会这么填。
    """
    op = rec.get("originalPitch")
    if isinstance(op, int) and 1 <= op <= 127:
        return op
    return midi_from_sample_name(rec.get("name", ""))


def midi_from_sample_name(name: str) -> int | None:
    """从采样名里抓音高。

    sf3 的命名有几种变体：
      Ahh Choir C4-L      → C4
      Piano MF D#0(L)     → D#0
      Piano MF Bv1(L)     → B0（v1 是力度层，不是音高的一部分）
    先按「音名+八度」整体匹配一次；匹配不到再把 v<数字> 去掉重试。
    """
    # "Bv1" 是 B 音 + 力度层 1，去掉 v1 后只剩字母，补一个默认八度 0
    cleaned = re.sub(r"\b([A-G][#b]?)v\d+", r"\g<1>0", name)
    cleaned = re.sub(r"v\d+", "", cleaned)
    cleaned = cleaned.replace("(", " ").replace(")", " ")
    for tok in reversed(cleaned.replace("-", " ").split()):
        m = re.fullmatch(r"([A-G][#b]?)(-?\d)", tok)
        if m:
            return 12 * (int(m.group(2)) + 1) + NOTE_PC[m.group(1)]
    return None


def read_sf3(path: Path):
    """解析 SoundFont 2/3 的 RIFF 结构，返回 (smpl 偏移, shdr 记录列表)。

    sf3 与 sf2 的区别只在于 smpl 里存的是 Ogg Vorbis 压缩流而不是 PCM，
    每个 sample 的 start/end 是它自己那段 Ogg 流的字节范围。
    """
    d = path.read_bytes()
    if d[:4] != b"RIFF":
        raise SystemExit(f"{path} 不是 RIFF 文件")
    chunks = []
    i = 12
    while i + 8 <= len(d):
        cid = d[i:i + 4]
        size = struct.unpack("<I", d[i + 4:i + 8])[0]
        chunks.append((cid, size, i + 8))
        i += 8 + size + (size & 1)

    def find_list(kind: bytes):
        for cid, size, start in chunks:
            if cid == b"LIST" and d[start:start + 4] == kind:
                return size, start + 4
        raise SystemExit(f"{path} 里没有 {kind!r} 列表")

    sd_size, sd_start = find_list(b"sdta")
    smpl_off = smpl_len = None
    j = sd_start
    while j + 8 <= sd_start + sd_size:
        cid = d[j:j + 4]
        size = struct.unpack("<I", d[j + 4:j + 8])[0]
        if cid == b"smpl":
            smpl_off, smpl_len = j + 8, size
            break
        j += 8 + size + (size & 1)
    if smpl_off is None:
        raise SystemExit(f"{path} 里没有 smpl 采样块")

    pd_size, pd_start = find_list(b"pdta")
    j = pd_start
    sub = {}
    while j + 8 <= pd_start + pd_size:
        cid = d[j:j + 4]
        size = struct.unpack("<I", d[j + 4:j + 8])[0]
        sub[cid] = d[j + 8:j + 8 + size]
        j += 8 + size + (size & 1)

    shdr = sub.get(b"shdr")
    if not shdr:
        raise SystemExit(f"{path} 里没有 shdr 采样头")
    records = []
    for r in range(len(shdr) // 46):
        rec = shdr[r * 46:(r + 1) * 46]
        name = rec[:20].rstrip(b"\x00").decode("latin1")
        start, end, loop_start, loop_end, rate = struct.unpack("<IIIII", rec[20:40])
        # shdr 第 40 字节是 originalPitch：采样真实录制的 MIDI 音高。
        # 这是权威值——文件名里的「八度」是音源作者的书写习惯，
        # 和实际音高不一定一致（实测 MS Basic 里 choir/violin 全部差 -12，
        # piano 有 78/80 个差 +12）。之前只从文件名推断，导致整组音色差一个八度。
        original_pitch = rec[40]
        pitch_correction = struct.unpack("<b", rec[41:42])[0]
        records.append({
            "id": r, "name": name, "start": start, "end": end,
            "loop_start": loop_start, "loop_end": loop_end, "rate": rate,
            "originalPitch": original_pitch,
            "pitchCorrection": pitch_correction,
        })
    return smpl_off, smpl_len, records, d


def decode_sample(d, smpl_off: int, rec: dict) -> tuple[np.ndarray, int] | None:
    """解出单个 sample。sf3 里是 Ogg，sf2 里是 16-bit PCM。

    d 可以是 bytes，也可以是 mmap；按 rec 的 start/end 只切这一段，
    不会把整块 51MB 采样数据重复拷进内存。
    """
    raw = bytes(d[smpl_off + rec["start"]:smpl_off + rec["end"]])
    if not raw:
        return None
    if raw[:4] == b"OggS":
        try:
            data, rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
        except Exception:
            return None
        if data.ndim > 1:
            data = data.mean(axis=1)
        return data.astype(np.float32), int(rate)
    # PCM 16-bit 小端
    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return pcm, int(rec["rate"]) or 44100


def pick_samples(records: list[dict], spec: dict) -> list[dict]:
    """按音色规则挑一组采样，同一音高只留一个（立体声采样取左声道那条）。

    match 可以写多条正则，任意一条命中即可；这样「弦乐合奏」能同时收
    Violin / Viola / Cello，一个音色覆盖更宽的音域。
    """
    patterns = [re.compile(p) for p in (spec["match"] if isinstance(spec["match"], list) else [spec["match"]])]
    strip = re.compile(spec["strip"]) if spec.get("strip") else None
    lo, hi = spec["root_range"]
    best: dict[int, dict] = {}
    for rec in records:
        if not any(p.match(rec["name"]) for p in patterns):
            continue
        base = strip.sub("", rec["name"]) if strip else rec["name"]
        midi = midi_of_record(rec)
        if midi is None or not (lo <= midi <= hi):
            continue
        # 立体声采样里 L 是左声道，优先用它；-R 只在缺 -L 时补位
        is_left = rec["name"].endswith("(L)") or rec["name"].endswith("-L")
        is_right = rec["name"].endswith("(R)") or rec["name"].endswith("-R")
        prev = best.get(midi)
        if prev is None or (is_left and not (prev["name"].endswith("(L)") or prev["name"].endswith("-L"))):
            if prev is not None and is_right:
                continue
            best[midi] = rec
        elif prev is not None and is_right:
            continue
    return [best[k] for k in sorted(best)]


def thin_by_step(samples: list[dict], step: int) -> list[dict]:
    """按音高间隔抽稀：保留两端，中间每隔 step 个半音取一个。"""
    if len(samples) <= 2:
        return samples
    out = [samples[0]]
    last = samples[0]["midi"]
    for s in samples[1:-1]:
        if s["midi"] - last >= step:
            out.append(s)
            last = s["midi"]
    if out[-1] is not samples[-1]:
        # 末尾补上最后一个采样，避免最高音区变调过多
        out.append(samples[-1])
    return out


def coarse_trim(data: np.ndarray, rate: int, keep: float = 0.8) -> np.ndarray:
    """解码后的第一道裁剪：按 -40 dB 找尾巴，只留最后一点余量。

    钢琴/竖琴这类采样尾部很长（单个 10 秒以上），如果直接进 trim_and_fade，
    20 多个音色一起解码会把内存吃光（实测 OOM）。这里用一次 max 滤波找包络，
    不逐样本比较，几百毫秒就能处理几十万帧。
    """
    if data.size == 0:
        return data
    peak = float(np.max(np.abs(data)))
    if peak <= 1e-6:
        return data
    thr = peak * 0.01          # -40 dB
    # 每 512 帧取一个峰值，做包络
    win = 512
    n = (len(data) // win) * win
    if n == 0:
        return data
    env = np.abs(data[:n]).reshape(-1, win).max(axis=1)
    idx = np.where(env > thr)[0]
    if not len(idx):
        return data
    end = min(len(data), (idx[-1] + 1) * win + int(rate * keep))
    return data[:end]


def trim_and_fade(data: np.ndarray, rate: int, sustain: float) -> np.ndarray:
    """去掉采样尾部的静音，加短淡入淡出，避免拼接时爆音。"""
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if peak <= 1e-6:
        return data
    # 以 -60 dB 为界裁掉尾部静音，再留 30ms 余量
    thr = peak * 1e-3
    nz = np.where(np.abs(data) > thr)[0]
    if len(nz):
        end = min(len(data), nz[-1] + int(rate * 0.03))
        data = data[:end]
    fade_in = min(len(data), int(rate * 0.005))
    fade_out = min(len(data), int(rate * 0.04))
    if fade_in:
        data[:fade_in] *= np.linspace(0, 1, fade_in, dtype=np.float32)
    if fade_out:
        data[-fade_out:] *= np.linspace(1, 0, fade_out, dtype=np.float32)
    # 峰值归一化到 -3 dB，运行时再按声部数量调总音量
    peak = float(np.max(np.abs(data)))
    if peak > 0:
        data = data * (0.7 / peak)
    return data.astype(np.float32)


def render_one(sf_path: Path, tid: str, rec: dict, out_dir: Path) -> dict | None:
    """把一个 sample 解码、裁剪、写成 OGG，返回 manifest 条目。

    单独成函数是为了能在**独立子进程**里跑：libsndfile 在同一个进程里
    连续解码几十个 Ogg 之后会崩（Windows 上表现为 0xC0000409 / 大负数退出码），
    每次开一个新进程就没问题。批量构建走 batch_build()。
    """
    spec = TIMBRES[tid]
    smpl_off, smpl_len, _, _ = read_sf3(sf_path)
    f = sf_path.open("rb")
    try:
        blob = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        got = decode_sample(blob, smpl_off, rec)
    finally:
        try:
            blob.close()
        except Exception:
            pass
        f.close()
    if not got:
        return None
    data, rate = got
    data = coarse_trim(data, rate, keep=0.8)
    if len(data) < rate * 0.12:
        return None
    data = trim_and_fade(data, rate, spec["sustain"])
    if len(data) < rate * 0.12:
        return None
    name = f"{rec['midi']}.ogg"
    size = write_ogg(out_dir / tid / name, data, rate)
    return {
        "ok": True,
        "entry": {
            "midi": rec["midi"],
            "file": name,
            "rate": rate,
            "frames": int(len(data)),
            "seconds": round(len(data) / rate, 3),
        },
        "bytes": size,
    }


# libsndfile 的 Vorbis 编码器单次写入超过约 50 万帧会直接崩进程
# （Windows 上 0xC0000409 / -1073741571）。实测 632k 帧崩、500k 帧正常，
# 所以留一点余量，超过就降采样——低音钢琴采样本来也不含 16 kHz 以上的信息。
VORBIS_MAX_FRAMES = 450_000


def write_ogg(path: Path, data: np.ndarray, rate: int, quality: float = 0.35) -> int:
    """写 Ogg Vorbis。长采样自动降采样到能一次写完的帧数。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    if len(data) > VORBIS_MAX_FRAMES:
        try:
            from scipy.signal import resample_poly
            new_rate = max(16000, int(rate * VORBIS_MAX_FRAMES / len(data) / 1000) * 1000)
            new_rate = min(new_rate, rate)
            if new_rate < rate:
                data = resample_poly(data, new_rate, rate).astype(np.float32)
                rate = new_rate
        except Exception:
            # 没有 scipy 就退化成截断，总比崩掉好
            data = data[:VORBIS_MAX_FRAMES]
    sf.write(path, data, rate, format="OGG", subtype="VORBIS", compression_level=quality)
    return path.stat().st_size


def build(timbre_ids: list[str], sf_path: Path, check_only: bool = False) -> dict:
    smpl_off, smpl_len, records, _ = read_sf3(sf_path)
    manifest_path = OUT_DIR / "manifest.json"
    # 每次都从空 manifest 开始重建，避免旧音色残留（比如删掉的音色）
    manifest = {}
    # 只 mmap 采样块，不把整个 51MB 读成 bytes；逐个 sample 切片解码
    # 必须留住文件对象：临时的 file 对象被回收后 fileno 会失效
    sf_file = sf_path.open("rb")
    blob = mmap.mmap(sf_file.fileno(), 0, access=mmap.ACCESS_READ)

    for tid in timbre_ids:
        spec = TIMBRES[tid]
        picked = pick_samples(records, spec)
        if not picked:
            print(f"[{tid}] 没有匹配的采样，跳过", file=sys.stderr)
            continue
        with_midi = []
        for rec in picked:
            base = re.sub(spec["strip"], "", rec["name"]) if spec.get("strip") else rec["name"]
            midi = midi_of_record(rec)
            if midi is not None:
                with_midi.append({**rec, "midi": midi})
        with_midi.sort(key=lambda r: r["midi"])
        chosen = thin_by_step(with_midi, spec["step"])
        if check_only:
            print(f"[{tid}] {len(with_midi)} 个候选，抽稀后 {len(chosen)}：",
                  [r["name"] for r in chosen])
            continue

        entries = []
        total = 0
        for rec in chosen:
            got = decode_sample(blob, smpl_off, rec)
            if not got:
                continue
            data, rate = got
            # 先粗剪：钢琴等长尾采样单个 10 秒以上，31 个一起解码会吃掉 1.6 GB。
            # 在归一化之前先按 -40 dB 找到结尾，只留 0.8 秒余量。
            data = coarse_trim(data, rate, keep=0.8)
            if len(data) < rate * 0.12:
                del data
                continue
            data = trim_and_fade(data, rate, spec["sustain"])
            if len(data) < rate * 0.12:
                del data
                continue
            name = f"{rec['midi']}.ogg"
            size = write_ogg(OUT_DIR / tid / name, data, rate)
            total += size
            entries.append({
                "midi": rec["midi"],
                "file": name,
                "rate": rate,
                "frames": int(len(data)),
                "seconds": round(len(data) / rate, 3),
            })
            # 写盘后立刻释放这一份 PCM：钢琴 31 个采样每个几十万帧，
            # 全留在内存里要 1.6 GB（实测 OOM）
            del data
        if not entries:
            print(f"[{tid}] 解码失败，跳过", file=sys.stderr)
            continue
        manifest[tid] = {
            "name": spec["name"],
            "sustain": spec["sustain"],
            "gain": spec["gain"],
            "samples": entries,
        }
        lo = entries[0]["midi"]
        hi = entries[-1]["midi"]
        print(f"[{tid}] {len(entries)} 个采样，{lo}..{hi}，"
              f"{total / 1024:.0f} KB，"
              f"{sum(e['seconds'] for e in entries):.1f} 秒音频")
        # 每个音色写完就把 manifest 落盘并回收内存，
        # 20 多个音色一起解码会把几 GB 采样同时留在内存里（实测 OOM）
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
        gc.collect()

    if check_only:
        return manifest
    try:
        blob.close()
        sf_file.close()
    except Exception:
        pass
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1, sort_keys=True),
        encoding="utf-8",
    )
    print(f"写入 {manifest_path}（{len(manifest)} 个音色）")
    return manifest


def batch_build(timbre_ids: list[str], sf_path: Path, out_dir: Path) -> dict:
    """批量构建：每个 sample 开一个子进程解码+编码。

    为什么不在一个进程里做：libsndfile 连续解码几十个 sf3 里的 Ogg 流之后
    会崩（Windows 上是 0xC0000409 或 -1073741571），钢琴那种 14 秒的长采样
    几个就会触发。子进程隔离之后稳定，代价是每个采样多几十毫秒启动开销。
    """
    import tempfile

    # 合并已有 manifest：单独跑 --timbre piano 时不能把别的音色记录抹掉
    mp0 = out_dir / "manifest.json"
    manifest = {}
    if mp0.exists():
        try:
            manifest = json.loads(mp0.read_text(encoding="utf-8"))
        except Exception:
            manifest = {}
    for tid in timbre_ids:
        spec = TIMBRES[tid]
        smpl_off, smpl_len, records, _ = read_sf3(sf_path)
        picked = pick_samples(records, spec)
        wm = []
        for rec in picked:
            base = re.sub(spec["strip"], "", rec["name"]) if spec.get("strip") else rec["name"]
            midi = midi_of_record(rec)
            if midi is not None:
                wm.append({**rec, "midi": midi})
        wm.sort(key=lambda r: r["midi"])
        chosen = thin_by_step(wm, spec["step"])
        entries = []
        total = 0
        for rec in chosen:
            # 子进程入口：python build_samples.py --one <tid> --rec <json>
            payload = json.dumps({**rec, "tid": tid})
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fp:
                fp.write(payload)
                tmp = fp.name
            try:
                r = subprocess.run(
                    [sys.executable, __file__, "--one", tmp, "--sf", str(sf_path)],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
                )
                out = (r.stdout or "").strip().splitlines()
                line = next((x for x in out if x.startswith("{")), None)
                if r.returncode != 0 or not line:
                    err = (r.stderr or "").strip().splitlines()
                    print(f"  {rec['name']}: FAIL rc={r.returncode} {(err[-1] if err else '')}", file=sys.stderr)
                    continue
                got = json.loads(line)
                if not got:
                    continue
                entries.append(got["entry"])
                total += got["bytes"]
            finally:
                try:
                    Path(tmp).unlink()
                except Exception:
                    pass
        if not entries:
            print(f"[{tid}] 没有生成任何采样，跳过", file=sys.stderr)
            continue
        entries.sort(key=lambda e: e["midi"])
        manifest[tid] = {
            "name": spec["name"],
            "sustain": spec["sustain"],
            "gain": spec["gain"],
            "samples": entries,
        }
        # 每个音色写完都落盘，中途失败也不会把已完成的丢掉
        mp = out_dir / "manifest.json"
        mp.parent.mkdir(parents=True, exist_ok=True)
        mp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
        print(f"[{tid}] {len(entries)} 个采样，{entries[0]['midi']}..{entries[-1]['midi']}，"
              f"{total / 1024:.0f} KB，{sum(e['seconds'] for e in entries):.1f} 秒音频")
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(description="从 MuseScore 音源拆出 Web 采样包")
    ap.add_argument("--sf", type=Path, default=DEFAULT_SF, help="SoundFont 文件路径")
    ap.add_argument("--timbre", action="append", default=None,
                    help=f"只生成指定音色，可多次指定。可选：{', '.join(TIMBRES)}")
    ap.add_argument("--check", action="store_true", help="只打印可用采样，不写文件")
    ap.add_argument("--batch", action="store_true",
                    help="每个采样开独立子进程构建（默认；单进程连解多个 Ogg 会崩）")
    ap.add_argument("--no-batch", action="store_true", help="强制单进程构建（调试用）")
    ap.add_argument("--one", type=Path, default=None,
                    help="内部用：只处理一个 sample，参数是 JSON 文件")
    args = ap.parse_args()

    if not args.sf.exists():
        print(f"找不到音源：{args.sf}", file=sys.stderr)
        print("MuseScore 4 默认在 C:/Program Files/MuseScore 4/sound/MS Basic.sf3", file=sys.stderr)
        return 1

    # 子进程模式：只解一个 sample，把结果打到 stdout
    if args.one:
        spec = json.loads(args.one.read_text(encoding="utf-8"))
        tid = spec.pop("tid")
        res = render_one(args.sf, tid, spec, OUT_DIR)
        print(json.dumps(res, ensure_ascii=False) if res else "null")
        return 0

    ids = args.timbre or list(TIMBRES)
    unknown = [t for t in ids if t not in TIMBRES]
    if unknown:
        print(f"未知音色：{unknown}", file=sys.stderr)
        return 1
    if args.check:
        build(ids, args.sf, check_only=True)
        return 0
    if args.no_batch:
        build(ids, args.sf, check_only=False)
        return 0
    batch_build(ids, args.sf, OUT_DIR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
