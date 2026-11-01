#!/usr/bin/env python3
"""Stage 1 of the import-pack pipeline.

Walks a folder of MuseScore (.mscx) or MusicXML files, converts whatever needs
converting with the local MuseScore CLI, extracts the top voice line of each
score, and writes melodies.json for build_pack.mjs (stage 2, which runs the
project's own arranger).

Only the vocal line is used: the accompaniment is dropped, because the pack is
meant for a cappella practice with generated four-part harmony.

Usage:
    python scripts/build_pack.py --src <scores dir> --work <scratch dir> --out melodies.json
"""

import argparse
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import xml.etree.ElementTree as ET

VOICE_RE = re.compile(r"voice|vocal|sopran|singer|chant|solo|mezzo|tenor|alto", re.I)
GRID = 0.25          # the renderer uses divisions=4, i.e. a sixteenth-note grid
MAX_BARS = 140
MIN_NOTE_COUNT = 24
DEFAULT_BPM = 84


def find_musescore(explicit=None):
    if explicit:
        return explicit
    candidates = [
        r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe",
        r"C:\Program Files\MuseScore 4\bin\MuseScore4",
        "/Applications/MuseScore 4.app/Contents/MacOS/mscore",
        "/usr/bin/musescore4",
        "/usr/bin/mscore4",
        "/usr/bin/musescore",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


def convert_one(exe, src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and dst.stat().st_size > 0:
        return True, None
    try:
        proc = subprocess.run([exe, "-o", str(dst), str(src)],
                              capture_output=True, text=True, timeout=180)
    except Exception as exc:                      # noqa: BLE001
        return False, str(exc)
    if dst.exists() and dst.stat().st_size > 0:
        return True, None
    tail = (proc.stderr or "").strip().splitlines()
    return False, tail[-1] if tail else "conversion produced no output"


def convert_all(src, work, exe, jobs):
    files = sorted(src.rglob("*.mscx"))
    if not files:
        return []
    print(f"converting {len(files)} .mscx files with {exe} ({jobs} at a time)")
    pairs = [(f, work / f.relative_to(src).with_suffix(".musicxml")) for f in files]
    failed = []
    done = 0
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(convert_one, exe, s, d): s for s, d in pairs}
        for fut, s in futures.items():
            ok, err = fut.result()
            done += 1
            if not ok:
                failed.append((s, err))
            if done % 100 == 0:
                print(f"  {done}/{len(files)}")
    if failed:
        print(f"  {len(failed)} failed to convert")
        for s, err in failed[:5]:
            print(f"    {s.name}: {err}")
    return [d for _, d in pairs if d.exists() and d.stat().st_size > 0]


def text(el, path, default=""):
    if el is None:
        return default
    found = el.find(path)
    if found is None or found.text is None:
        return default
    return found.text.strip()


def pick_voice_part(root):
    names = {}
    for sp in root.findall("./part-list/score-part"):
        names[sp.get("id")] = text(sp, "part-name", "")
    parts = root.findall("./part")
    for p in parts:
        if VOICE_RE.search(names.get(p.get("id"), "")):
            return p
    return parts[0] if parts else None


def leading_int(value):
    """MuseScore writes things like '4(2)' for double time signatures."""
    m = re.match(r"\s*(\d+)", value or "")
    return int(m.group(1)) if m else None


def read_meta(root, part):
    work = text(root, "./work/work-title") or text(root, "./movement-title") or ""
    movement = text(root, "./movement-title")
    # A cycle shares one work title, the individual song lives in movement-title
    title = movement if movement and movement != work else work
    composer = ""
    for c in root.findall("./identification/creator"):
        if c.get("type") == "composer" and c.text:
            composer = c.text.strip()
            break
    fifths = 0
    for el in part.iter("fifths"):
        try:
            fifths = int(el.text)
        except (TypeError, ValueError):
            fifths = 0
        break

    beats, beat_type = 4, 4
    for el in part.iter("time"):
        b = leading_int(el.findtext("beats"))
        bt = leading_int(el.findtext("beat-type"))
        if b and bt:
            beats, beat_type = b, bt
            break

    bpm = None
    for el in part.iter("sound"):
        if el.get("tempo"):
            try:
                bpm = float(el.get("tempo"))
                break
            except ValueError:
                pass
    return title, composer, fifths, beats, beat_type, bpm


def collect_notes(part):
    """Timeline of the main voice in the part.

    MuseScore exports cue notes and editorial voices through <backup>/<forward>,
    so walk the measure children in order, keep the voice with the most notes,
    and ignore cue-sized notes. Returns [midi_or_None, beats] with every gap
    filled by a rest.
    """
    divisions = 4
    bar_beats = 4.0
    pos = 0.0
    by_voice = {}
    for measure in part.findall("measure"):
        attrs = measure.find("attributes")
        if attrs is not None:
            d = attrs.findtext("divisions")
            if d:
                try:
                    divisions = max(1, int(d))
                except ValueError:
                    pass
            t = attrs.find("time")
            if t is not None:
                b, bt = t.findtext("beats"), t.findtext("beat-type")
                if b and bt:
                    bar_beats = int(b) * 4 / int(bt)
        start = pos
        for child in measure:
            if child.tag == "backup":
                pos -= int(child.findtext("duration") or 0) / divisions
                continue
            if child.tag == "forward":
                pos += int(child.findtext("duration") or 0) / divisions
                continue
            if child.tag != "note":
                continue
            dur_txt = child.findtext("duration")
            if dur_txt is None:
                continue
            beats = int(dur_txt) / divisions
            if child.find("chord") is not None or child.find("grace") is not None:
                continue
            voice = child.findtext("voice") or "1"
            if child.find("cue") is None:
                if child.find("rest") is not None:
                    by_voice.setdefault(voice, []).append((pos, None, beats, False))
                else:
                    pitch = child.find("pitch")
                    if pitch is not None:
                        step = pitch.findtext("step")
                        octave = pitch.findtext("octave")
                        if step and octave is not None:
                            base = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
                            alter = pitch.findtext("alter")
                            midi = (int(octave) + 1) * 12 + base[step.upper()] + int(float(alter or 0))
                            tie_stop = child.find("tie[@type='stop']") is not None
                            if not tie_stop:
                                notations = child.find("notations")
                                tie_stop = notations is not None and notations.find("tied[@type='stop']") is not None
                            by_voice.setdefault(voice, []).append((pos, midi, beats, tie_stop))
            pos += beats
        pos = start + bar_beats

    if not by_voice:
        return None
    voice = max(by_voice, key=lambda v: len(by_voice[v]))
    events = sorted(by_voice[voice], key=lambda e: e[0])
    if not events:
        return None

    # merge ties first, then turn the timeline into a contiguous note list
    merged = []
    for onset, midi, beats, tie_stop in events:
        if merged and midi is not None and tie_stop and merged[-1][1] == midi \
                and abs(merged[-1][0] + merged[-1][2] - onset) < 1e-6:
            merged[-1][2] += beats
        else:
            merged.append([onset, midi, beats])

    notes = []
    cursor = round(merged[0][0], 4)
    for onset, midi, beats in merged:
        if onset > cursor + 1e-6:
            notes.append([None, round(onset - cursor, 4)])
            cursor = onset
        if midi is None and beats <= 0:
            continue
        notes.append([midi, beats])
        cursor = onset + beats
    return notes


def normalise(notes, bar):
    """Trim outer rests, snap onsets to the sixteenth grid, pad to whole bars."""
    start, end = 0, len(notes)
    while start < end and notes[start][0] is None:
        start += 1
    while end > start and notes[end - 1][0] is None:
        end -= 1
    notes = notes[start:end]
    if not notes:
        return None

    onsets, t = [], 0.0
    for midi, beats in notes:
        onsets.append(t)
        t += beats
    total = t

    # Snap every onset to the grid, then rebuild durations from the differences.
    snapped = []
    drift = 0.0
    for on in onsets:
        s = round(on / GRID) * GRID
        drift += abs(s - on)
        snapped.append(s)
    if drift / len(notes) > 0.06:
        return None                                    # tuplet-heavy, would sound wrong
    total = round(total / GRID) * GRID
    out = []
    for i, (midi, _) in enumerate(notes):
        nxt = snapped[i + 1] if i + 1 < len(snapped) else total
        beats = round((nxt - snapped[i]) / GRID) * GRID
        if beats <= 0:
            continue
        out.append([midi, round(beats, 4)])
    if not out:
        return None

    # pad with rests so every bar is complete
    rest = round(total % bar, 4) if bar else 0
    if rest > 1e-9:
        out.append([None, round(bar - rest, 4)])
        total += bar - rest
    return out, total


def scale_for_meter(beats, beat_type):
    """beats/bar in quarter notes; compound meters that land on a half beat are
    rescaled to an eighth-note pulse so `bar` stays an integer."""
    quarter = beats * 4 / beat_type
    if abs(quarter - round(quarter)) < 1e-9:
        return 1, int(round(quarter))
    if abs(quarter * 2 - round(quarter * 2)) < 1e-9:
        return 2, int(round(quarter * 2))
    return None, None


def parse_score(path):
    root = ET.parse(path).getroot()
    part = pick_voice_part(root)
    if part is None:
        return None, "no part"
    title, composer, fifths, beats, beat_type, bpm = read_meta(root, part)
    notes = collect_notes(part)
    if not notes:
        return None, "multi-voice or empty"

    factor, bar = scale_for_meter(beats, beat_type)
    if not factor:
        return None, f"unsupported meter {beats}/{beat_type}"
    if factor == 2:
        notes = [[m, b * 2] for m, b in notes]
        bpm = bpm * 2 if bpm else None

    packed = normalise(notes, bar)
    if not packed:
        return None, "unusable rhythm"
    melody, total = packed
    bars = round(total / bar)
    if bars > MAX_BARS:
        return None, f"too long ({bars} bars)"
    if sum(1 for m, _ in melody if m is not None) < MIN_NOTE_COUNT:
        return None, "too few notes"

    return {
        "title": title or path.stem,
        "composer": composer,
        "bpm": round(bpm) if bpm else DEFAULT_BPM,
        "bar": bar,
        "fifths": fifths,
        "bars": bars,
        "melody": melody,
        "file": str(path),
    }, None


def main():
    global DEFAULT_BPM
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--musescore")
    ap.add_argument("--default-bpm", type=int, default=DEFAULT_BPM,
                    help="tempo used when the score carries no tempo marking")
    args = ap.parse_args()

    DEFAULT_BPM = args.default_bpm

    src = Path(args.src)
    work = Path(args.work)
    out = Path(args.out)

    xml_files = sorted(src.rglob("*.musicxml")) + sorted(src.rglob("*.xml"))
    if not xml_files:
        exe = find_musescore(args.musescore)
        if not exe:
            sys.exit("MuseScore CLI not found; pass --musescore")
        xml_files = convert_all(src, work, exe, args.jobs)

    entries, reasons = [], {}
    for f in xml_files:
        if f.suffix.lower() not in (".musicxml", ".xml"):
            continue
        try:
            entry, why = parse_score(f)
        except ET.ParseError as exc:
            entry, why = None, f"xml error: {exc}"
        except Exception as exc:                    # noqa: BLE001
            entry, why = None, f"parse error: {type(exc).__name__}"
        if entry:
            entries.append(entry)
        else:
            reasons[why] = reasons.get(why, 0) + 1

    entries.sort(key=lambda e: (e["composer"], e["title"]))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
    print(f"parsed {len(entries)} melodies -> {out}")
    for why, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"  skipped {n}: {why}")


if __name__ == "__main__":
    main()
