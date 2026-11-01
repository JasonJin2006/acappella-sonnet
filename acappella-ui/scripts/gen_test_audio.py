#!/usr/bin/env python3
# 生成回归测试用的合成音频。
#
# 真实录音做不了可重复的回归，所以各个场景都用合成音来测：
#   sing.wav        Bass 独唱，严格按谱（测跟谱精度、音高曲线方向）
#   sing_sharp.wav  同上但整体偏高 38 音分（测曲线"偏上"）
#   sing_flat.wav   同上但整体偏低 42 音分（测曲线"偏下"）
#   choir.wav       四声部齐唱（测团队定位）
#   noise.wav       环境噪声，没人唱（测静音锁定，期望全程不动）
#   jump.wav        前半段照谱唱，中途跳到别的段落（测失配后重新定位）
#
# 用法:
#   pip install numpy
#   python scripts/gen_test_audio.py [输出目录]      # 默认 /tmp

import math
import os
import struct
import sys

import numpy as np

SR = 48000
BPM = 100.0
SPB = 60.0 / BPM          # 每拍秒数

# 欢乐颂（与内置示例 demo2 一致）
S = [(0, 64, 1), (1, 64, 1), (2, 65, 1), (3, 67, 1), (4, 67, 1), (5, 65, 1), (6, 64, 1), (7, 62, 1),
     (8, 60, 1), (9, 60, 1), (10, 62, 1), (11, 64, 1), (12, 64, 1.5), (13.5, 62, 0.5), (14, 62, 2),
     (16, 64, 1), (17, 64, 1), (18, 65, 1), (19, 67, 1), (20, 67, 1), (21, 65, 1), (22, 64, 1), (23, 62, 1),
     (24, 60, 1), (25, 60, 1), (26, 62, 1), (27, 64, 1), (28, 62, 1.5), (29.5, 60, 0.5), (30, 60, 2)]
A = [(0, 60, 2), (2, 62, 2), (4, 60, 2), (6, 62, 2), (8, 55, 4), (12, 55, 2), (14, 59, 2),
     (16, 60, 2), (18, 62, 2), (20, 60, 2), (22, 62, 2), (24, 55, 4), (28, 59, 2), (30, 60, 2)]
T = [(0, 55, 2), (2, 59, 2), (4, 55, 2), (6, 59, 2), (8, 52, 4), (12, 52, 2), (14, 55, 2),
     (16, 55, 2), (18, 59, 2), (20, 55, 2), (22, 59, 2), (24, 52, 4), (28, 55, 2), (30, 60, 2)]
B = [(0, 48, 2), (2, 43, 2), (4, 48, 2), (6, 43, 2), (8, 48, 4), (12, 48, 2), (14, 43, 2),
     (16, 48, 2), (18, 43, 2), (20, 48, 2), (22, 43, 2), (24, 48, 4), (28, 43, 2), (30, 48, 2)]
PARTS = [(S, 0.30, 0.0), (A, 0.25, 1.1), (T, 0.25, 2.3), (B, 0.25, 3.7)]


def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def voice(freq, dur, amp, phase=0.0, nharm=5):
    """人声样音色：基频 + 一串谐波，带轻微颤音和 ADSR。"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for h in range(1, nharm + 1):
        y += (1.0 / h ** 1.1) * np.sin(2 * np.pi * freq * h * t + phase)
    y *= 1 + 0.006 * np.sin(2 * np.pi * 4.7 * t)
    env = np.ones(n)
    a, r = int(0.04 * SR), int(0.10 * SR)
    if n > a + r:
        env[:a] = np.linspace(0, 1, a)
        env[-r:] = np.linspace(1, 0, r)
    return y * env * amp


def write_wav(path, y):
    y = np.clip(y, -1, 1)
    y = (y / max(1e-9, np.max(np.abs(y))) * 32767 * 0.85).astype(np.int16)
    with open(path, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', 36 + len(y) * 2) + b'WAVEfmt ')
        f.write(struct.pack('<IHHIIHH', 16, 1, 1, SR, SR * 2, 2, 16))
        f.write(b'data' + struct.pack('<I', len(y) * 2))
        f.write(y.tobytes())
    print('  %-16s %.1f 秒' % (os.path.basename(path), len(y) / SR))


def render(beats_total, parts, cents=0.0, gap=0.035):
    out = np.zeros(int(beats_total * SPB * SR))
    shift = 2 ** (cents / 1200.0)
    for seq, amp, ph in parts:
        for (b, m, beats) in seq:
            i = int(b * SPB * SR)
            if i >= len(out):
                continue
            n = min(int((beats * SPB - gap) * SR), len(out) - i)
            out[i:i + n] += voice(mtof(m) * shift, beats * SPB, amp, ph)[:n]
    return out


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else '/tmp'
    os.makedirs(outdir, exist_ok=True)
    print('生成测试音频到', outdir)

    # 独唱（只 Bass）
    for name, cents in [('sing.wav', 0), ('sing_sharp.wav', 38), ('sing_flat.wav', -42)]:
        write_wav(os.path.join(outdir, name), render(32, [(B, 0.55, 0.0)], cents))

    # 四声部齐唱
    write_wav(os.path.join(outdir, 'choir.wav'), render(32, PARTS))

    # 环境噪声：空调低频嗡嗡 + 宽带噪声 + 几次突发响动（全程没人唱）
    t = np.arange(int(16 * SR)) / SR
    y = np.random.normal(0, 0.035, len(t))
    y += 0.05 * np.sin(2 * np.pi * 58 * t) + 0.03 * np.sin(2 * np.pi * 117 * t)
    for tp in [2.0, 5.3, 9.1, 12.0]:
        i, n = int(tp * SR), int(0.2 * SR)
        y[i:i + n] += np.random.normal(0, 0.15, n) * np.exp(-np.linspace(0, 7, n))
    write_wav(os.path.join(outdir, 'noise.wav'), y)

    # 跳段：前 12 拍照常唱，之后反复唱第 28–32 拍（和声与前面完全不同）
    mix = np.zeros(int(20 * SR))
    for seq, amp, ph in PARTS:
        for (b, m, beats) in seq:
            if b < 12:
                i = int(b * SPB * SR)
                n = min(int(beats * SPB * SR), len(mix) - i)
                mix[i:i + n] += voice(mtof(m), beats * SPB, amp, ph)[:n]
            elif b >= 28:
                for rep in range(4):
                    i = int((7.2 + rep * 2.4 + (b - 28) * SPB) * SR)
                    if i >= len(mix):
                        continue
                    n = min(int(beats * SPB * SR), len(mix) - i)
                    mix[i:i + n] += voice(mtof(m), beats * SPB, amp, ph)[:n]
    write_wav(os.path.join(outdir, 'jump.wav'), mix)


if __name__ == '__main__':
    main()
