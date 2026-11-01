#!/usr/bin/env python3
"""Convert PDF sheet music into MusicXML (and optionally a sonnet pack).

PDF pages carry no note data, so this is optical music recognition (OMR).
Audiveris does the recognition; this script drives it, repairs the result
enough for the app to import it, and reports what it is unsure about.

The repair pass is deliberately defensive: scores differ in meter, clefs,
chord writing and repeat marks, and OMR output follows the page, not the app's
model. Anything that cannot be represented is reported rather than dropped in
silence.

Usage:
    python scripts/pdf_to_score.py --src "D:/scores" --out "D:/scores/xml" --jobs 3
    python scripts/pdf_to_score.py --src one.pdf --pack packs/mine.json

Output per PDF: <out>/<name>.musicxml, ready to drag into the app's import
button, plus a one-line summary on stdout. Pages or notes that cannot be
recognised are skipped and reported, never silently dropped.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import xml.etree.ElementTree as ET

GRID = 0.25                     # the app renders on a sixteenth-note grid
STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
PART_IDS = ["S", "A", "T", "B"]
PART_NAMES = {
    "S": "Soprano", "A": "Alto", "T": "Tenor", "B": "Bass",
}
GENERIC_PART_NAMES = {"", "voice", "voices", "staff", "part", "music", "melody",
                      "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"}
DEFAULT_BPM = 84
MAX_EXPANDED_BARS = 2000        # guard against pathological repeat structures

AUDIVERIS_CANDIDATES = [
    Path(r"D:\Softwares\Audiveris\app\Audiveris\Audiveris.exe"),
    Path(r"C:\Program Files\Audiveris\Audiveris.exe"),
    Path(r"C:\Program Files\Audiveris\Audiveris\Audiveris.exe"),
    Path("/Applications/Audiveris.app/Contents/MacOS/Audiveris"),
    Path("/usr/bin/audiveris"),
]


def find_audiveris(explicit=None):
    if explicit:
        p = Path(explicit)
        return p if p.exists() else None
    env = os.environ.get("AUDIVERIS")
    if env and Path(env).exists():
        return Path(env)
    for c in AUDIVERIS_CANDIDATES:
        if c.exists():
            return c
    found = shutil.which("audiveris")
    return Path(found) if found else None


_PAGE_COUNT_BACKENDS = []          # populated by _page_count_attempts(), for tests


def _page_count_attempts():
    """Yield (name, fn) page-count implementations, cheapest first.

    Kept as a generator so tests can prove pypdf is consulted before any JVM
    is spawned, and so `_PAGE_COUNT_BACKENDS` records which one answered.
    """
    def pypdf_count(path):
        from pypdf import PdfReader          # optional soft dependency
        reader = PdfReader(str(path), strict=False)
        n = len(reader.pages)
        if n > 0:
            return n
        raise ValueError("pypdf reported 0 pages")

    def pymupdf_count(path):
        import pymupdf                        # optional soft dependency
        with pymupdf.open(str(path)) as doc:
            n = doc.page_count
        if n > 0:
            return n
        raise ValueError("pymupdf reported 0 pages")

    yield "pypdf", pypdf_count
    yield "pymupdf", pymupdf_count


def warm_page_counter():
    """Import the PDF backend now so the first job's page count isn't charged
    for a one-off ~400 ms module import. Best-effort; returns the backend name
    that is available, or None."""
    for name, _fn in _page_count_attempts():
        try:
            if name == "pypdf":
                import pypdf  # noqa: F401
            elif name == "pymupdf":
                import pymupdf  # noqa: F401
            return name
        except Exception:
            continue
    return None


def _audiveris_page_count(pdf, exe, timeout=180):
    """Last-resort page count: let Audiveris parse the PDF and report sheets."""
    scratch = Path(pdf).parent / ".pages"
    scratch.mkdir(parents=True, exist_ok=True)
    out = subprocess.run(
        [str(exe), "-batch", "-output", str(scratch), "-step", "LOAD", "--", str(pdf)],
        capture_output=True, text=True, timeout=timeout,
    )
    blob = (out.stdout or "") + (out.stderr or "")
    # 实际输出：`Book 560 | 24 sheets in /tmp/echo.pdf`
    m = re.search(r"(\d+)\s+sheets?\s+in\b", blob, re.I) or \
        re.search(r"(\d+)\s+sheets?\b", blob, re.I)
    if m and int(m.group(1)) > 0:
        return int(m.group(1))
    raise ValueError("no sheet count in Audiveris output")


def pdf_page_count(pdf, exe=None, timings=None, allow_jvm=True):
    """Page count, cheaply. Returns an int >= 1.

    顺序：
      1. pypdf / pymupdf —— 纯 Python。PDF 页树藏在 ObjStm 压缩流里也能读，
         一份 24 页的谱约 20-50ms。这是常态路径，不启动 JVM。
      2. 原始字节正则 —— 软依赖缺失时兜底。`/Count N` 取最大值，否则数
         `/Type /Page`。现代 PDF 可能把页树压进对象流而数错（曾把 24 页
         看成 1 页），所以这一层只在没有解析库时用。
      3. Audiveris `-step LOAD` —— 最后手段（PDF 损坏 / 解析库都没有）。
         一次要 2.4 秒以上，只在 allow_jvm=True 时尝试。

    注意 `exe` 仍保留在签名里：老的调用方（omr_server）会传，且第 3 步需要它。
    find_audiveris() 在不带参数时依赖 `which audiveris`，而 deb 装的是
    /opt/audiveris/bin/Audiveris，不在 PATH 里，所以能用显式 exe 就用。
    """
    path = Path(pdf)

    for name, fn in _page_count_attempts():
        try:
            n = int(fn(path))
            if n > 0:
                _PAGE_COUNT_BACKENDS.append(name)
                return n
        except Exception:
            continue

    # 2) 字节层面：只解析 cross-reference 之外的明文结构，够快但不保证正确。
    try:
        raw = path.read_bytes()
    except OSError:
        raw = b""
    best = 0
    for m in re.finditer(rb"/Count\s+(\d+)", raw):
        best = max(best, int(m.group(1)))
    if best:
        _PAGE_COUNT_BACKENDS.append("bytes:/Count")
        return best
    n = len(re.findall(rb"/Type\s*/Page[^s]", raw))
    if n:
        _PAGE_COUNT_BACKENDS.append("bytes:/Type/Page")
        return n

    # 3) last resort: 让 Audiveris 完整解析一次。慢，但只在前面全失败时才走。
    if allow_jvm:
        try:
            exe = exe or find_audiveris()
            if exe:
                n = _audiveris_page_count(path, exe)
                _PAGE_COUNT_BACKENDS.append("audiveris")
                return n
        except Exception:
            pass

    _PAGE_COUNT_BACKENDS.append("fallback:1")
    return 1


def _bump(timings, key, ms):
    """Additive timing helper; safe when the caller does not collect timings."""
    if timings is not None:
        timings[key] = int(timings.get(key) or 0) + int(ms)


def _set(timings, key, ms):
    """Absolute timing helper (used for a phase whose live value we publish)."""
    if timings is not None:
        timings[key] = int(ms)


def _elapsed_ms(t0):
    return int(round((time.perf_counter() - t0) * 1000))


def _mxl_outputs(out_dir, stem):
    """All .mxl files Audiveris may have written for a book called `stem`.

    The exported name is not always `<stem>.mxl`: when the score has no
    movement title Audiveris writes `<stem>.mvtnull.mxl`. Match both shapes
    (`<stem>.mxl`, `<stem>.something.mxl`) without letting `sheet1` match
    `sheet10`.
    """
    pattern = re.compile(r"^" + re.escape(stem) + r"(?:\.[^.]*)?\.mxl$", re.I)
    if stem == "*":
        pattern = re.compile(r"^.*\.mxl$", re.I)
    try:
        return [p for p in Path(out_dir).glob("*.mxl")
                if pattern.match(p.name) and p.is_file()]
    except OSError:
        return []


def _natural_key(text):
    return [int(t) if t.isdigit() else t.lower()
            for t in re.split(r"(\d+)", str(text))]


def _fresh_mxls(*dirs, since=0.0, stem=None):
    """All .mxl files matching `stem` in `dirs` written after `since`.

    Sorted naturally by name (mvt2 before mvt10). Audiveris names per-score
    exports `<book>.mvt1.mxl`, `<book>.mvt2.mxl`, ... in sheet order when a
    book holds several scores.
    """
    seen, out = set(), []
    for d in dirs:
        d = Path(d)
        if not d.is_dir():
            continue
        for p in _mxl_outputs(d, stem or "*"):
            try:
                if p.stat().st_mtime >= since - 0.05:
                    key = p.resolve()
                    if key not in seen:
                        seen.add(key)
                        out.append(p)
            except OSError:
                continue
    return sorted(out, key=lambda p: _natural_key(p.name))


def _fresh_mxl(*candidates, since=0.0, stem=None):
    """Newest existing .mxl among candidates that was (re)written after `since`.

    Audiveris writes the export next to the input when the input is a saved
    `.omr` book (it ignores `-output` in that case), so both locations must be
    checked. When a directory is passed instead of a file, every matching
    `<stem>*.mxl` in it is considered. The mtime guard keeps a stale export
    from a previous pass from being reported as this pass's result.
    """
    best = None
    for c in candidates:
        c = Path(c)
        pool = _mxl_outputs(c, stem) if (stem and c.is_dir()) else [c]
        for p in pool:
            try:
                if p.exists() and p.stat().st_mtime >= since - 0.05:
                    if best is None or p.stat().st_mtime > best.stat().st_mtime:
                        best = p
            except OSError:
                continue
    return best


class _LiveTimer:
    """Publish a phase's elapsed ms while a blocking subprocess.run runs.

    `subprocess.run` blocks the worker thread, so a plain timer around it would
    only update `timings` when the JVM exits — too late for a client ETA. This
    trickles the running total every `interval` seconds; the final value is
    exact. It accumulates onto whatever the key already holds.
    """

    def __init__(self, timings, key, interval=0.5):
        self.timings = timings
        self.key = key
        self.interval = interval
        self.base = int((timings or {}).get(key) or 0) if timings is not None else 0
        self.t0 = None
        self.stop = None
        self.thread = None

    def __enter__(self):
        if self.timings is None:
            return self
        self.t0 = time.perf_counter()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *exc):
        if self.timings is None:
            return
        self.stop.set()
        self.thread.join(timeout=2)
        _set(self.timings, self.key, self.base + _elapsed_ms(self.t0))

    def _run(self):
        while not self.stop.wait(self.interval):
            _set(self.timings, self.key, self.base + _elapsed_ms(self.t0))


def run_audiveris(exe, pdf, out_dir, sheets=None, timeout=1800, transcribe=False,
                  save=True):
    """Run one recognition pass. Returns (mxl_path or None, tail of the log).

    `transcribe=True` asks Audiveris to reach PAGE without exporting; the
    per-book `.omr` left behind by `-save` then holds the recognition result.

    The log tail is intentionally large (200 KB): the caller parses
    `[book#N] ... StepException/NPE` lines to tell "cover page, no music" from
    "engine error on a music page". A small tail drops those diagnostics when
    a later sheet's stack trace is long.

    NOTE: if the input is an `.omr` book, Audiveris ignores `-output` and
    writes the `.mxl` next to the `.omr`. Both locations are checked (see
    `_fresh_mxl`); do not "simplify" this to one path, or salvage silently
    misses the export and re-recognises every page.
    """
    pdf = Path(pdf)
    out_dir = Path(out_dir)
    cmd = [str(exe), "-batch"]
    if transcribe:
        cmd += ["-transcribe"]
    else:
        cmd += ["-export"]
    if save:
        cmd += ["-save"]
    cmd += ["-output", str(out_dir)]
    if sheets:
        cmd += ["-sheets", sheets if isinstance(sheets, str) else " ".join(map(str, sheets))]
    cmd += ["--", str(pdf)]
    started = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        log = (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError as exc:
        return None, f"cannot run Audiveris: {exc}"
    mxl = _fresh_mxl(out_dir, pdf.parent, since=started, stem=pdf.stem)
    return mxl, log[-200_000:]


# ---------------------------------------------------------------- .omr inspection

_OMR_ERROR_HINTS = (
    "No system found",
    "does not seem to contain multi-line staves",
    "No regularly spaced lines found",
    "Sheet removed",
    "Sheet ignored",
    "empty sheet",
)


def read_book_info(omr_path):
    """Read sheet status out of a saved `.omr` book without touching Audiveris.

    Returns {sheet_number: {"invalid": bool, "steps": [..], "error": str|None}}
    or None when the file is missing / not a readable Audiveris book.
    """
    try:
        with zipfile.ZipFile(omr_path) as z:
            data = z.read("book.xml")
        root = ET.fromstring(data)
    except (OSError, KeyError, zipfile.BadZipFile, ET.ParseError):
        return None
    info = {}
    for sheet in root.findall("sheet"):
        try:
            num = int(sheet.get("number"))
        except (TypeError, ValueError):
            continue
        steps = (sheet.findtext("steps") or "").split()
        info[num] = {
            "invalid": (sheet.get("invalid") or "").lower() == "true",
            "steps": steps,
        }
    return info or None


def parse_sheet_errors(log, fallback_sheet=None):
    """Map sheet number -> short failure reason, from Audiveris' own log.

    Audiveris prefixes sheet-scoped lines with `[book#N]`; errors useful to a
    user are StepExceptions / NPE messages on those lines.

    A single-sheet book is logged as just `[book]` with no `#N` at all, so when
    `fallback_sheet` is given and no sheet-scoped error was found, a global
    engine failure (NPE / "Error processing stub") is attributed to it. Without
    that, a page lost to the upstream NPE would be reported as a vague
    "transcription incomplete" instead of an engine error.
    """
    errors = {}
    if not log:
        return errors
    if "\x00" in log:
        # PowerShell `*>` fixtures are UTF-16LE; Audiveris' own log is UTF-8.
        # Stripping NULs keeps the ASCII diagnostics readable either way.
        log = log.replace("\x00", "")
    global_reason = None
    for line in log.splitlines():
        m = re.search(r"\[[^\]#]+#(\d+)\]", line)
        if not m:
            if "NullPointerException" in line:
                global_reason = global_reason or "engine error (NullPointerException)"
            elif "Could not export since transcription did not complete" in line:
                global_reason = global_reason or "transcription did not complete"
            continue
        num = int(m.group(1))
        for hint in _OMR_ERROR_HINTS:
            if hint in line:
                errors.setdefault(num, hint)
                break
        else:
            if "Exception" in line or "Error processing stub" in line:
                msg = line.split("|")[-1].strip()
                errors.setdefault(num, msg[:160] or "processing failed")
    if not errors and fallback_sheet and global_reason:
        errors[int(fallback_sheet)] = global_reason
    return errors


def read_book_scores(omr_path):
    """Sheet numbers grouped per exported score, in book order.

    `<score>` in book.xml holds one `<page sheet-number=.../>` per page that
    belongs to that score. Audiveris writes ONE `.mxl` per score, so this is
    how a batched export maps back to pages (e.g. sheets 2+3 may be a single
    score -> a single .mxl containing both pages).
    Returns [[sheet_no, ...], ...] or None if unreadable.
    """
    try:
        with zipfile.ZipFile(omr_path) as z:
            root = ET.fromstring(z.read("book.xml"))
    except (OSError, KeyError, zipfile.BadZipFile, ET.ParseError):
        return None
    scores = []
    for score in root.findall("score"):
        pages = []
        for page in score.findall("page"):
            try:
                pages.append(int(page.get("sheet-number")))
            except (TypeError, ValueError):
                continue
        if pages:
            scores.append(pages)
    return scores or None


def split_pdf_pages(pdf, out_dir, only=None):
    """Extract single-page PDFs. Returns [(page_no, Path|None)].

    Used only as a last-resort retry for a sheet whose recognition left no
    `.omr` at all (rare: a page selected inside a larger book can fail where a
    standalone copy succeeds). Normal multi-sheet work uses `-sheets` on the
    original PDF instead, so a 40 MB book does not become 40 x 40 MB of scratch
    files on a box with a 3 G cgroup.

    `only` restricts extraction to those 1-based page numbers. Uses pypdf
    first, then pymupdf; both are optional soft dependencies. A page that
    cannot be extracted comes back as (n, None) so the caller can report it.
    Returns [] when no backend can split at all.
    """
    pdf = Path(pdf)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    wanted = ({int(n) for n in only} if only else None)

    def keep(n):
        return wanted is None or n in wanted

    try:
        from pypdf import PdfReader, PdfWriter
        reader = PdfReader(str(pdf), strict=False)
        total = len(reader.pages)
        made = []
        for i in range(total):
            n = i + 1
            if not keep(n):
                continue
            target = out_dir / f"sheet{n:03d}.pdf"
            try:
                writer = PdfWriter()
                writer.add_page(reader.pages[i])
                with target.open("wb") as fh:
                    writer.write(fh)
                made.append((n, target if target.exists() and target.stat().st_size else None))
            except Exception:
                made.append((n, None))
        return made
    except Exception:
        pass
    try:
        import pymupdf
        with pymupdf.open(str(pdf)) as doc:
            made = []
            for i in range(doc.page_count):
                n = i + 1
                if not keep(n):
                    continue
                target = out_dir / f"sheet{n:03d}.pdf"
                try:
                    one = pymupdf.open()
                    one.insert_pdf(doc, from_page=i, to_page=i)
                    one.save(str(target))
                    one.close()
                    made.append((n, target if target.exists() else None))
                except Exception:
                    made.append((n, None))
            return made
    except Exception:
        return []


def _emit_progress(progress, done, total, phase=None):
    """Call a 3-arg progress callback, tolerating older 2-arg callbacks."""
    if not progress:
        return
    try:
        progress(int(done), int(total), phase)
    except TypeError:
        progress(int(done), int(total))


class _ProgressTail:
    """Tail Audiveris' per-book log and report sheets/books finished.

    Audiveris writes `<book>-TIMESTAMP.log` next to the `.omr`. The main
    `subprocess.run` call is blocking, so a small reader thread is what turns
    "recognise 0/N" into real progress while the JVM is still working. The
    thread only ever calls the callback with an integer count.
    """

    def __init__(self, out_dir, callback, lag=0.5):
        self.out_dir = Path(out_dir)
        self.callback = callback
        self.lag = lag
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.seen_sheets = set()
        self.seen_books = set()
        self.offsets = {}
        self.last_reported = -1
        # Ignore logs left over from an earlier pass in the same work dir;
        # otherwise their "End of Stub" lines inflate progress to 100% at once.
        try:
            self.offsets = {p: p.stat().st_size for p in self.out_dir.glob("*.log")}
        except OSError:
            self.offsets = {}

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.thread.join(timeout=2)

    def _run(self):
        while not self.stop.wait(self.lag):
            self._report()
        self._report()

    def _report(self):
        done = self._scan()
        if done and done != self.last_reported:
            self.last_reported = done
            try:
                self.callback(done)
            except Exception:
                pass

    def _scan(self):
        for log in self.out_dir.glob("*.log"):
            try:
                offset = self.offsets.get(log, 0)
                with log.open("r", encoding="utf-8", errors="replace") as fh:
                    fh.seek(offset)
                    chunk = fh.read()
                    self.offsets[log] = fh.tell()
            except OSError:
                continue
            for m in re.finditer(r"End of Stub#(\d+)", chunk):
                self.seen_sheets.add((log.stem.split("-")[0], int(m.group(1))))
            for m in re.finditer(r"End of Book\{([^}]+)\}", chunk):
                self.seen_books.add(m.group(1))
        return max(len(self.seen_sheets), len(self.seen_books))


def _export_salvage(exe, omr, sheet_numbers, work, timings, notes, timeout=600,
                    contiguous=False):
    """Export already-transcribed sheets from a saved `.omr` book.

    Two modes, both without re-recognition:

    * `contiguous=True` (only valid when the surviving sheets belong to ONE
      score): a single cheap export pass. Audiveris writes one `.mxl` holding
      every page of that score.
    * otherwise: one cheap JVM per sheet (~2.6 s each). This is not just a
      fallback, it is required: Audiveris names each per-score export after the
      book, so two untitled scores both become `<book>.mvtnull.mxl` and the
      second silently overwrites the first. Only one-JVM-per-sheet guarantees
      one MusicXML per page. A sheet that cannot be exported is reported and
      skipped, never fatal to the others.

    Returns [(sheet_no, mxl_path)]. For a single-score export the sheet_no is
    the first page of that score; the .mxl covers all its pages.
    """
    sheet_numbers = sorted(set(sheet_numbers))
    if not sheet_numbers:
        return []

    def one_sheet(n, tag=None):
        out_dir = work / "salvage" / (tag or f"sheet{n:03d}")
        out_dir.mkdir(parents=True, exist_ok=True)
        with _LiveTimer(timings, "export"):
            mxl, log = run_audiveris(exe, omr, out_dir, sheets=[n], timeout=timeout,
                                     transcribe=False, save=False)
        if not mxl:
            tail = (log or "").strip().splitlines()[-1:] or ["no MusicXML produced"]
            notes.append(f"sheet {n}: saved recognition could not be exported "
                         f"({tail[0][:120]})")
            return None
        return mxl

    if contiguous and len(sheet_numbers) > 1:
        # Only a single-score book reaches here (caller checks score_groups).
        out_dir = work / "salvage" / f"book-{sheet_numbers[0]}-{sheet_numbers[-1]}"
        out_dir.mkdir(parents=True, exist_ok=True)
        with _LiveTimer(timings, "export"):
            _single, log = run_audiveris(exe, omr, out_dir, sheets=sheet_numbers,
                                         timeout=timeout, transcribe=False, save=False)
        files = _fresh_mxls(out_dir, Path(omr).parent, stem=Path(omr).stem)
        if len(files) == 1:
            notes.append(f"salvaged sheet(s) {sheet_numbers[0]}-{sheet_numbers[-1]} "
                         f"in one export pass")
            return [(sheet_numbers[0], files[0])]
        if files:
            notes.append(f"batched export returned {len(files)} file(s) for one "
                         f"score; falling back to per-sheet export")

    results = []
    for n in sheet_numbers:
        mxl = one_sheet(n)
        if not mxl:
            continue
        dest = work / f"book-sheet{n:03d}.mxl"
        try:
            shutil.copyfile(mxl, dest)
        except OSError:
            dest = mxl
        results.append((n, dest))
    if results:
        sheets = ", ".join(str(n) for n, _m in results)
        notes.append(f"salvaged sheet(s) {sheets} from saved recognition")
    return results


def _book_path(out_dir, pdf_stem):
    """Audiveris writes `<stem>.omr` next to where it was told to output."""
    return Path(out_dir) / (pdf_stem + ".omr")


def _map_exports(omr_path, out_dir, wanted):
    """Map fresh .mxl files in out_dir back to sheet numbers.

    Audiveris writes one `.mxl` per score. `read_book_scores` lists the pages
    of each score in book order; if the number of fresh files and the number of
    score groups agree, they pair up positionally. Returns [(sheet, mxl)] or
    None when the mapping is ambiguous (never guess: a wrong pairing silently
    merges or drops pages).
    """
    files = _fresh_mxls(out_dir, Path(omr_path).parent, stem=Path(omr_path).stem)
    groups = read_book_scores(omr_path) if Path(omr_path).exists() else None
    wanted = set(wanted)
    if not files:
        return []
    if not groups:
        return None
    groups = [g for g in groups if g and set(g) & wanted]
    if not groups or len(groups) != len(files):
        return None
    used = [n for g in groups for n in g if n in wanted]
    if len(set(used)) != len(used) or set(used) != wanted:
        return None
    return [(g[0], f) for g, f in zip(groups, files)]


def _retry_sheets(exe, pdf, numbers, work, timings, notes, callback,
                  total, batch_size=8, timeout=1200):
    """Transcribe sheets that pass 1 never got to, in bounded batches.

    Uses `-sheets` on the ORIGINAL PDF (no page splitting: a 40 MB book would
    become 40 x 40 MB of scratch files on a box with a 3 G cgroup). For each
    batch:

      1. one `-export -save` invocation;
      2. map the exported `.mxl` files back to sheets via the saved `.omr`;
      3. for sheets that transcribed but did not export, reuse the cheap
         `_export_salvage` path instead of re-running recognition;
      4. bisect ONLY if the invocation left no readable `.omr` at all (crash or
         timeout), which is the only case where splitting the work can help.

    The number of invocations is hard-bounded so a pathological file cannot
    trigger an unbounded retry cascade. Returns [(sheet_no, mxl_path)].
    """
    numbers = sorted(set(int(n) for n in numbers))
    if not numbers:
        return []
    batch_size = max(1, int(batch_size or 1))
    chunks = [numbers[i:i + batch_size] for i in range(0, len(numbers), batch_size)]
    results = []
    calls = {"n": 0}
    # One recognition call per chunk, plus a small allowance for bisect/salvage.
    max_calls = max(4, 2 * len(chunks) + 2)
    omitted = []

    def attempt(nums, depth=0):
        if not nums:
            return
        if calls["n"] >= max_calls:
            omitted.extend(nums)
            return
        calls["n"] += 1
        tag = f"{nums[0]:03d}-{nums[-1]:03d}-d{depth}"
        out_dir = work / "retry" / tag
        out_dir.mkdir(parents=True, exist_ok=True)
        with _LiveTimer(timings, "recognise"):
            _found, log = run_audiveris(exe, pdf, out_dir, sheets=nums,
                                        timeout=timeout, save=True)
        omr = _book_path(out_dir, Path(pdf).stem)
        if not omr.exists():
            # Nothing persisted: the invocation itself died. Splitting the work
            # is the only remaining lever. As a last resort for a single sheet,
            # extract it as a standalone one-page PDF and try that (some PDFs
            # fail when a page is selected inside a larger book).
            if len(nums) > 1 and depth < 4 and calls["n"] < max_calls:
                mid = len(nums) // 2
                attempt(nums[:mid], depth + 1)
                attempt(nums[mid:], depth + 1)
            elif len(nums) == 1 and calls["n"] < max_calls:
                split = split_pdf_pages(pdf, work / "retry-pages",
                                        only=nums)
                page_pdf = next((p for n, p in split if n == nums[0] and p), None)
                if page_pdf:
                    calls["n"] += 1
                    page_dir = work / "retry" / f"page-{nums[0]:03d}"
                    page_dir.mkdir(parents=True, exist_ok=True)
                    with _LiveTimer(timings, "recognise"):
                        run_audiveris(exe, page_pdf, page_dir, timeout=timeout,
                                      save=True)
                    page_omr = _book_path(page_dir, page_pdf.stem)
                    mapping = _map_exports(page_omr, page_dir, [1]) if page_omr.exists() else None
                    if mapping:
                        results.extend((nums[0], m) for _n, m in mapping)
                        if callback:
                            callback(len(results), total)
                        return
                omitted.extend(nums)
            else:
                omitted.extend(nums)
            return

        book = read_book_info(omr) or {}
        errors = parse_sheet_errors(log, fallback_sheet=nums[0] if len(nums) == 1 else None)
        done, invalid = [], []
        for n in nums:
            info = book.get(n) or {}
            steps = info.get("steps") or []
            if info.get("invalid") or not steps:
                invalid.append(n)
            elif "PAGE" in steps:
                done.append(n)
            else:
                invalid.append(n)
        for n in invalid:
            reason = errors.get(n, "")
            if any(h in reason for h in _OMR_ERROR_HINTS):
                notes.append(f"第 {n} 页无谱面，已跳过（sheet {n} skipped: no music）")
            elif reason:
                notes.append(f"第 {n} 页识别失败，已跳过（sheet {n} skipped: {reason}）")
            else:
                notes.append(f"第 {n} 页无谱面，已跳过（sheet {n} skipped: no music recognised）")

        if not done:
            return
        mapping = _map_exports(omr, (work / "retry" / tag), done)
        if mapping is None:
            # Ambiguous filename mapping; the cheap per-sheet export resolves it
            # without paying for another recognition pass.
            groups = read_book_scores(omr) or []
            single = (len(groups) == 1 and set(groups[0]) == set(done))
            mapping = _export_salvage(exe, omr, done, work / "retry" / tag,
                                      timings, notes, timeout=timeout,
                                      contiguous=single)
        results.extend(mapping)
        if callback:
            callback(len(results), total)

    for chunk in chunks:
        attempt(chunk)
    if omitted:
        notes.append(f"{len(omitted)} sheet(s) not retried (retry budget reached): "
                     f"{', '.join(str(n) for n in sorted(set(omitted)))}")
    return sorted(results, key=lambda kv: kv[0])


def recognise(pdf, work, exe, force=False, progress=None, timings=None,
              batch_size=None, pages=None):
    """Recognise a PDF, salvaging per-sheet results from a failed book.

    The old code ran the whole book once and, on any failure, threw that work
    away and started a fresh JVM for every page. This version keeps the whole
    book as a single JVM, asks Audiveris to `-save` its per-sheet `.omr`
    results, and then exports those saved results in one more (cheap) batched
    invocation. A page that cannot be transcribed is reported and skipped; it
    no longer invalidates the pages that did work.

    `progress(done, total)` is called with sheet counts while recognition runs.
    `timings` accumulates wall-ms under "preflight", "recognise" and "export".
    Returns (list of MusicXML paths, notes).
    """
    notes = []
    pdf = Path(pdf)
    work = Path(work)
    whole_dir = work / "book"
    whole_dir.mkdir(parents=True, exist_ok=True)
    mxl = whole_dir / (pdf.stem + ".mxl")
    if mxl.exists() and not force:
        _emit_progress(progress, 1, 1, "done")
        return [mxl], notes

    t0 = time.perf_counter()
    if pages is None or pages < 1:
        pages = pdf_page_count(pdf, exe, allow_jvm=False)
    _bump(timings, "preflight", _elapsed_ms(t0))

    whole_omr = whole_dir / (pdf.stem + ".omr")
    _emit_progress(progress, 0, pages, "recognise")

    def on_sheet(done):
        _emit_progress(progress, max(0, min(int(done), pages)), pages, "recognise")

    # ---- pass 1: one JVM for the whole book, saving per-sheet work ---------
    # `-export -save` is the fast path: when every sheet is usable it produces
    # the .mxl directly. When one sheet is not, Audiveris aborts the export but
    # the `-save` .omr still holds every completed sheet's recognition work.
    t0 = time.perf_counter()
    tail = None
    timer = _LiveTimer(timings, "recognise")
    started = time.time()
    if progress:
        tail = _ProgressTail(whole_dir, on_sheet)
        tail.__enter__()
    timer.__enter__()
    try:
        found, log = run_audiveris(exe, pdf, whole_dir, timeout=1800,
                                   transcribe=False, save=True)
    finally:
        if tail is not None:
            tail.__exit__()
        timer.__exit__()
    _emit_progress(progress, pages, pages, "recognise")

    if found:
        # A book with several scores writes one .mxl PER SCORE, all named after
        # the book. Untitled scores all become `<book>.mvtnull.mxl`, so the
        # later ones silently overwrite earlier ones. Only trust the fast path
        # when every page of the book is covered by the files that were
        # actually written.
        exports = _fresh_mxls(whole_dir, pdf.parent, since=started, stem=pdf.stem)
        groups = read_book_scores(whole_omr) if whole_omr.exists() else None
        if groups is None or len(exports) >= len(groups):
            return [found], notes
        notes.append(f"book export produced {len(exports)} file(s) for "
                     f"{len(groups)} score(s) (same-name overwrite); salvaging per sheet")

    book = read_book_info(whole_omr) if whole_omr.exists() else None
    sheet_errors = parse_sheet_errors(log, fallback_sheet=1 if pages == 1 else None)
    invalid = sorted(n for n, s in (book or {}).items() if s.get("invalid"))
    known = set(book or {}) or set(range(1, pages + 1))

    # A sheet can be perfectly valid yet stop short of PAGE (Audiveris' own
    # transcription error): it is NOT "no music", and it is deterministic, so
    # it must be reported as an engine failure instead of silently skipped.
    stalled = sorted(n for n in known
                     if n not in set(invalid)
                     and "GRID" in ((book or {}).get(n, {}).get("steps") or [])
                     and "PAGE" not in ((book or {}).get(n, {}).get("steps") or []))

    for n in invalid:
        reason = sheet_errors.get(n, "")
        if any(h in reason for h in _OMR_ERROR_HINTS):
            notes.append(f"第 {n} 页无谱面，已跳过（sheet {n} skipped: no music）")
        elif reason:
            notes.append(f"第 {n} 页识别失败，已跳过（sheet {n} skipped: {reason}）")
        else:
            notes.append(f"第 {n} 页无谱面，已跳过（sheet {n} skipped: no music recognised）")

    for n in stalled:
        reason = sheet_errors.get(n, "") or "engine error"
        notes.append(f"第 {n} 页识别失败已跳过（引擎内部错误：{reason}），"
                     f"其余页已保留（sheet {n} skipped: {reason}）")

    candidates = sorted(n for n in known
                        if n not in set(invalid) and n not in set(stalled))
    if not candidates:
        notes.append("no page could be recognised")
        return [], notes

    # ---- pass 2: cheap export of saved recognition, per sheet if needed ----
    # Salvage path. Audiveris ignores `-output` when the input is an `.omr`
    # book: the .mxl is written NEXT TO the .omr. run_audiveris checks both
    # locations (see _fresh_mxl) — do not "simplify" that to one path, or the
    # salvage result is silently missed while the good pages' work is thrown
    # away and every page is re-recognised.
    if book and whole_omr.exists():
        completed = [n for n in candidates
                     if "PAGE" in (book.get(n, {}).get("steps") or [])]
        if completed:
            notes.append(
                f"whole-book export failed; exporting {len(completed)} completed "
                f"sheet(s) from saved recognition")
            _emit_progress(progress, 0, pages, "export")
            # Audiveris writes ONE .mxl per score and names every one after the
            # book; two untitled scores both land on `<book>.mvtnull.mxl` and
            # the later silently overwrites the earlier. So the single fast
            # export pass is only safe when all surviving sheets are one score.
            score_groups = read_book_scores(whole_omr) or []
            evidence = [g for g in score_groups if g and set(g) <= set(completed)]
            single_score = (len(evidence) == 1
                            and set(evidence[0]) == set(completed)
                            or (not evidence and completed == list(
                                range(completed[0], completed[-1] + 1))))
            if len(evidence) > 1:
                notes.append(f"book has {len(evidence)} separate scores; "
                             f"exporting them one at a time so none is overwritten")
            salvage = _export_salvage(exe, whole_omr, completed, work, timings,
                                      notes, timeout=600,
                                      contiguous=single_score)
            if salvage:
                _emit_progress(progress, pages, pages, "export")
                return [m for _n, m in salvage], notes

    # Sheets Audiveris already took through GRID and then lost to an upstream
    # failure are deterministic: a per-sheet retry re-pays the full JVM and
    # produces the same error (verified: 21 s per NPE sheet, no MusicXML). They
    # are reported, not retried. Only sheets that never reached GRID are worth
    # the one bounded batched retry below.
    retryable = []
    for n in candidates:
        steps = (book or {}).get(n, {}).get("steps") or []
        if steps and "GRID" in steps:
            reason = sheet_errors.get(n, "")
            if "NullPointerException" in reason or "Error" in reason:
                notes.append(f"第 {n} 页识别失败已跳过（引擎内部错误："
                             f"{reason or 'internal error'}），其余页已保留")
            else:
                notes.append(f"第 {n} 页识别未完成，已跳过（transcription incomplete）")
            continue
        retryable.append(n)

    # ---- pass 3: ONE bounded batched retry for sheets that never reached GRID
    # Only sheets pass 1 never attempted get here (a sheet that reached GRID and
    # then failed is deterministic and is reported above, not retried). Uses
    # `-sheets` on the original PDF, so no page-splitting and no extra disk.
    # The retry itself is hard-bounded (see _retry_sheets): no cascade.
    if retryable:
        _emit_progress(progress, 0, pages, "recognise")
        notes.append(f"whole-book recognition incomplete; retrying "
                     f"{len(retryable)} unattempted sheet(s) in bounded batches")
        size = batch_size or int(os.environ.get("OMR_BATCH_SIZE") or 8)
        found = _retry_sheets(
            exe, pdf, retryable, work, timings, notes,
            (lambda d, t: _emit_progress(progress, d, pages,
                                         "recognise")) if progress else None,
            total=pages, batch_size=size)
        if found:
            _emit_progress(progress, pages, pages, "recognise")
            return [m for _n, m in found], notes

    notes.append("no page could be recognised")
    return [], notes


# ---------------------------------------------------------------- parsing

def _pitch(el):
    step = el.findtext("step", "").strip().upper()
    if step not in STEP:
        return None
    alter_el = el.find("alter")
    alter = int(float(alter_el.text)) if alter_el is not None else 0
    octave = int(el.findtext("octave", "4"))
    return {
        "step": step,
        "alter": alter,
        "octave": octave,
        "midi": (octave + 1) * 12 + STEP[step] + alter,
    }


def _tie_types(note):
    kinds = {t.get("type") for t in note.findall("tie")}
    kinds |= {t.get("type") for t in note.findall("notations/tied")}
    return kinds


def _measure_meter(measure, current):
    """Beats per bar in quarter notes, honouring meter changes."""
    for t in measure.findall("attributes/time"):
        beats = t.findtext("beats")
        beat_type = t.findtext("beat-type")
        if beats and beat_type:
            try:
                return float(beats) * 4.0 / float(beat_type)
            except (ValueError, ZeroDivisionError):
                pass
    return current


def _measure_clef_shift(measure, current):
    """Sounding offset implied by an octave clef (treble 8 below etc.)."""
    for clef in measure.findall("attributes/clef"):
        change = clef.findtext("clef-octave-change")
        if change is not None:
            try:
                return 12 * int(float(change))
            except ValueError:
                pass
        if clef.find("sign") is not None:
            return 0
    return current


def _measure_repeats(measure):
    forward = False
    backward = 0
    for barline in measure.findall("barline"):
        for rep in barline.findall("repeat"):
            direction = (rep.get("direction") or "").lower()
            if direction == "forward":
                forward = True
            elif direction == "backward":
                try:
                    backward = max(2, int(rep.get("times") or 2))
                except ValueError:
                    backward = 2
    return forward, backward


def _empty_measure(limit):
    return {"limit": limit, "events": [], "repeat_forward": False, "repeat_backward": 0}


def parse_musicxml(root):
    """MusicXML -> {title, bpm, bar, parts:[{id,name,clef,measures:[...]}]}.

    Voices are kept apart: a staff carrying two voices becomes two parts, which
    is what a close score (SA on one staff) needs. Meter, octave clefs and
    repeat marks are carried per measure, because real scores change them.
    """
    title = (root.findtext("work/work-title") or root.findtext("movement-title") or "").strip()
    if not title:
        for w in root.iter("credit-words"):
            if (w.text or "").strip():
                title = w.text.strip()
                break

    bpm = None
    for s in root.iter("sound"):
        if s.get("tempo"):
            bpm = round(float(s.get("tempo")))
            break
    if not bpm:
        for pm in root.iter("per-minute"):
            try:
                bpm = round(float(pm.text))
                break
            except (TypeError, ValueError):
                pass

    parts_raw = []
    for part_el in root.findall("part"):
        pid = part_el.get("id") or f"P{len(parts_raw) + 1}"
        name_el = root.find(f"part-list/score-part[@id='{pid}']/part-name")
        pname = (name_el.text or "").strip() if name_el is not None else ""
        parts_raw.append((pid, pname, part_el))

    parts = []
    chord_drops = 0
    for _pid, pname, part_el in parts_raw:
        divisions = 4.0
        meter = 4.0
        octave_shift = 0
        voices = {}
        voice_order = []
        meter_history = []
        measures = part_el.findall("measure")

        for mi, measure in enumerate(measures):
            div_el = measure.find("attributes/divisions")
            if div_el is not None:
                try:
                    divisions = max(1.0, float(div_el.text))
                except (TypeError, ValueError):
                    pass
            meter = _measure_meter(measure, meter)
            octave_shift = _measure_clef_shift(measure, octave_shift)
            repeat_forward, repeat_backward = _measure_repeats(measure)
            meter_history.append(meter)

            t = 0.0
            buffers = {}
            for el in measure:
                if el.tag == "backup":
                    t -= float(el.findtext("duration", "0") or 0) / divisions
                elif el.tag == "forward":
                    t += float(el.findtext("duration", "0") or 0) / divisions
                elif el.tag == "note":
                    if el.find("grace") is not None:
                        continue
                    dur_el = el.findtext("duration")
                    dur = float(dur_el) / divisions if dur_el else 0.0
                    voice = el.findtext("voice", "1")
                    if el.find("chord") is not None:
                        # keep the top note of the chord: that is the line a singer follows
                        chord_drops += 1
                        info = _pitch(el.find("pitch")) if el.find("pitch") is not None else None
                        held = buffers.get(voice) or []
                        if info and held and not held[-1]["rest"] and info["midi"] > held[-1]["midi"]:
                            if octave_shift:
                                info = dict(info, octave=info["octave"] + octave_shift // 12,
                                            midi=info["midi"] + octave_shift)
                            held[-1].update(info)
                        continue
                    if voice not in voices:
                        voices[voice] = [_empty_measure(meter_history[k])
                                         for k in range(mi)]
                        voice_order.append(voice)
                    onset = t
                    t += dur
                    is_rest = el.find("rest") is not None
                    ev = {
                        "onset": onset,
                        "beats": dur,
                        "midi": None,
                        "rest": is_rest,
                        "tie": _tie_types(el),
                    }
                    if not is_rest:
                        p = el.find("pitch")
                        if p is None:
                            continue
                        info = _pitch(p)
                        if info is None:
                            continue
                        ev.update(info)
                        if octave_shift:
                            ev["octave"] += octave_shift // 12
                            ev["midi"] += octave_shift
                    buffers.setdefault(voice, []).append(ev)

            for v in voices:
                if len(voices[v]) < mi:
                    voices[v].extend(_empty_measure(meter_history[k])
                                     for k in range(len(voices[v]), mi))
                voices[v].append({
                    "limit": meter,
                    "events": buffers.get(v, []),
                    "repeat_forward": repeat_forward,
                    "repeat_backward": repeat_backward,
                })

        for v in voice_order:
            parts.append({
                "id": None,
                "name": pname,
                "voice": v,
                "measures": merge_ties(voices[v]),
            })

    if not parts:
        return None

    # Name the parts. Four unnamed staves are almost always a choral score;
    # anything else keeps the names the page gave us.
    generic = all(p["name"].strip().lower() in GENERIC_PART_NAMES for p in parts)
    if len(parts) == 4 and generic:
        for i, p in enumerate(parts):
            p["id"] = PART_IDS[i]
            p["name"] = PART_NAMES[PART_IDS[i]]
    else:
        for i, p in enumerate(parts):
            p["id"] = f"P{i + 1}"
            p["name"] = p["name"] or f"Voice {i + 1}"

    # two staves labelled "Piano" or "Voice" would be indistinguishable in the app
    counts = Counter(p["name"] for p in parts)
    if any(c > 1 for c in counts.values()):
        used = Counter()
        for p in parts:
            if counts[p["name"]] > 1:
                used[p["name"]] += 1
                p["name"] = f"{p['name']} {used[p['name']]}"

    # the app carries a single meter; use the one most bars agree on
    first = parts[0]["measures"] if parts and parts[0]["measures"] else []
    limits = [m["limit"] for m in first if m["limit"]]
    score_bar = max(set(limits), key=limits.count) if limits else 4.0

    return {
        "title": title,
        "bpm": bpm,
        "bar": score_bar,
        "chord_drops": chord_drops,
        "parts": parts,
    }


def merge_ties(measures):
    """Join notes that a tie carries across a barline.

    Works on the whole part, not one measure at a time: a half note held over a
    barline is a tie stop in the next measure, and only the measure-level onsets
    tell us it continues the note we just emitted.
    """
    out = []
    last = None
    for measure in measures:
        seq = []
        for ev in sorted(measure["events"], key=lambda e: e["onset"]):
            if ("stop" in ev["tie"] and not ev["rest"] and ev["onset"] <= 1e-6
                    and last is not None and last.get("midi") == ev.get("midi")):
                last["beats"] += ev["beats"]
                if "start" not in ev["tie"]:
                    continue
            seq.append(ev)
            last = ev
        measure = dict(measure)
        measure["events"] = seq
        out.append(measure)
    return out


def expand_repeats(parts, warnings):
    """Apply simple forward/backward repeat marks to every part."""
    if not parts or not parts[0]["measures"]:
        return parts
    plan_measures = parts[0]["measures"]
    plan, start, expanded = [], 0, False
    for i, measure in enumerate(plan_measures):
        if measure.get("repeat_forward"):
            start = i
        plan.append(i)
        times = measure.get("repeat_backward") or 0
        if times:
            for _ in range(times - 1):
                plan.extend(range(start, i + 1))
            start = i + 1
            expanded = True
    if not expanded:
        return parts
    if len(plan) > MAX_EXPANDED_BARS:
        warnings.append(f"repeat marks would give {len(plan)} bars, left unexpanded")
        return parts
    for part in parts:
        src = part["measures"]
        if len(src) != len(plan_measures):
            warnings.append(f"part {part['id']}: bar count differs, repeats not expanded")
            continue
        part["measures"] = [dict(src[i]) for i in plan]
    warnings.append(f"repeats expanded: {len(plan_measures)} bars -> {len(plan)} bars")
    return parts


def concat_pages(scores, warnings=None):
    """Join per-sheet scores into one, measure by measure."""
    scores = [s for s in scores if s]
    base = scores[0]
    n = max(len(s["parts"]) for s in scores)
    for idx, s in enumerate(scores[1:], 2):
        if len(s["parts"]) != n:
            if warnings is not None:
                warnings.append(
                    f"sheet {idx}: {len(s['parts'])} part(s) vs {n} on sheet 1, extra parts dropped")
        for i in range(min(n, len(s["parts"]))):
            base["parts"][i]["measures"].extend(s["parts"][i]["measures"])
    return base


# ---------------------------------------------------------------- writing

def normalise(score, warnings, default_bar=4):
    """Fill each measure to its own meter and split notes at barlines, keeping ties."""
    bar = score.get("bar")
    if not bar or not (0.5 <= bar <= 12):
        bar = default_bar
        warnings.append(f"no usable time signature, assumed {default_bar}/4")
    if abs(bar - round(bar)) > 1e-6:
        warnings.append(f"meter of {bar:g} quarter notes cannot be shown exactly, rounded")
    bar = max(1, min(12, int(round(bar))))
    score["bar"] = bar
    score["bpm"] = score.get("bpm") or DEFAULT_BPM

    for part in score["parts"]:
        pending = []            # events carried over from the previous bar
        out = []
        for mi, measure in enumerate(part["measures"]):
            limit = float(measure.get("limit") or bar)
            if limit <= 0:
                limit = float(bar)
            if mi == 0:
                span = max((e["onset"] + e["beats"] for e in measure["events"]), default=0.0)
                if 0 < span < limit - 1e-6:       # pickup bar: keep it short
                    limit = _snap(span)
            queue = sorted(pending + measure["events"], key=lambda e: e["onset"])
            pending = []
            filled = []
            cursor = 0.0
            for ev in queue:
                onset = max(_snap(ev["onset"]), cursor)
                dur = max(GRID, _snap(ev["beats"]))
                if onset >= limit - 1e-6:        # starts in a later bar
                    pending.append({**ev, "onset": onset - limit})
                    continue
                if onset > cursor + 1e-6:
                    filled.append({"rest": True, "midi": None, "beats": onset - cursor})
                    cursor = onset
                room = limit - onset
                if dur > room + 1e-6:
                    keep = max(GRID, _snap(room)) if room > GRID / 2 else room
                    filled.append(_note(ev, keep, tie_start=True, tie_stop=ev.get("tie_stop", False)))
                    pending.append({**ev, "onset": 0.0, "beats": dur - keep, "tie_stop": not ev["rest"]})
                    cursor = onset + keep
                else:
                    filled.append(_note(ev, dur, tie_stop=ev.get("tie_stop", False)))
                    cursor = onset + dur
            if not filled:
                filled.append({"rest": True, "midi": None, "beats": limit})
            elif limit - cursor > 1e-6:
                filled.append({"rest": True, "midi": None, "beats": limit - cursor})
            measure = dict(measure)
            measure["events"] = filled
            measure["limit"] = limit
            measure["content_end"] = cursor
            out.append(measure)
        if pending:
            warnings.append(f"part {part['id']}: {len(pending)} note(s) past the last bar dropped")
        part["measures"] = out

    detect_short_bars(score, warnings)
    trim_trailing_empty(score)
    return score


def detect_short_bars(score, warnings):
    """Flag runs of bars that end early: usually a meter change OMR did not read."""
    parts = score["parts"]
    n = min((len(p["measures"]) for p in parts), default=0)
    if n < 3:
        return
    short = []
    for i in range(n):
        limit = parts[0]["measures"][i].get("limit") or score["bar"]
        ends = [p["measures"][i].get("content_end", limit) for p in parts]
        gap = limit - max(ends)
        short.append(round(gap, 3) if gap > 0.5 else 0)
    i = 0
    while i < n:
        if short[i] <= 0:
            i += 1
            continue
        j = i
        while j + 1 < n and abs(short[j + 1] - short[i]) < 1e-6:
            j += 1
        if j - i + 1 >= 3:
            warnings.append(
                f"bars {i + 1}-{j + 1} end {short[i]:g} beat(s) early, "
                "a meter change may not have been read")
            return
        i = j + 1


def _note(ev, beats, tie_start=False, tie_stop=False):
    return {
        "rest": ev["rest"],
        "midi": ev.get("midi"),
        "step": ev.get("step"),
        "alter": ev.get("alter"),
        "octave": ev.get("octave"),
        "beats": beats,
        "tie_start": tie_start,
        "tie_stop": tie_stop,
    }


def trim_trailing_empty(score):
    """Drop bars where every part is silent (OMR sometimes adds a blank one)."""
    parts = score["parts"]
    if not parts:
        return
    while len(parts[0]["measures"]) > 1:
        last = len(parts[0]["measures"]) - 1
        if any(any(not e["rest"] for e in p["measures"][last]["events"])
               for p in parts if len(p["measures"]) > last):
            break
        for p in parts:
            if len(p["measures"]) > last:
                p["measures"].pop()


def _clef_for(part):
    """Pick a clef that keeps the notes near the staff, whatever the source used."""
    pitches = [e["midi"] for m in part["measures"] for e in m["events"]
               if not e["rest"] and e.get("midi") is not None]
    if not pitches:
        return "<clef><sign>G</sign><line>2</line></clef>"
    pitches.sort()
    median = pitches[len(pitches) // 2]
    if median < 57:                       # below A3: bass clef
        return "<clef><sign>F</sign><line>4</line></clef>"
    return "<clef><sign>G</sign><line>2</line></clef>"


def to_musicxml(score):
    bar = score["bar"]
    bpm = score["bpm"]
    div = 4
    title = _esc(score["title"] or "Imported score")

    part_list = "\n".join(
        f'    <score-part id="{p["id"]}"><part-name>{_esc(p["name"])}</part-name></score-part>'
        for p in score["parts"]
    )
    body = []
    for p in score["parts"]:
        chunk = [f'  <part id="{p["id"]}">']
        prev_limit = None
        for mi, measure in enumerate(p["measures"]):
            limit = measure.get("limit") or bar
            chunk.append(f'    <measure number="{mi + 1}">')
            attrs = []
            if mi == 0:
                attrs.append(f"<divisions>{div}</divisions>")
                attrs.append(f"<key><fifths>{_fifths_of(score.get('key'))}</fifths></key>")
            if mi == 0 or abs(limit - (prev_limit if prev_limit is not None else limit)) > 1e-6:
                attrs.append(f"<time><beats>{_fmt(limit)}</beats><beat-type>4</beat-type></time>")
            if mi == 0:
                attrs.append(_clef_for(p))
            if attrs:
                chunk.append("      <attributes>" + "".join(attrs) + "</attributes>")
            if mi == 0:
                chunk.append(
                    '<direction placement="above"><direction-type><metronome>'
                    f'<beat-unit>quarter</beat-unit><per-minute>{bpm}</per-minute>'
                    f'</metronome></direction-type><sound tempo="{bpm}"/></direction>'
                )
            prev_limit = limit
            for ev in measure["events"]:
                beats = max(GRID, _snap(ev["beats"]))
                dur = max(1, round(beats * div))
                kind, dots = _type_of(beats)
                tie = ""
                if not ev["rest"]:
                    if ev.get("tie_start") and ev.get("tie_stop"):
                        tie = ('<tie type="stop"/><tie type="start"/>'
                               '<notations><tied type="stop"/><tied type="start"/></notations>')
                    elif ev.get("tie_start"):
                        tie = '<tie type="start"/><notations><tied type="start"/></notations>'
                    elif ev.get("tie_stop"):
                        tie = '<tie type="stop"/><notations><tied type="stop"/></notations>'
                if ev["rest"]:
                    chunk.append(f'      <note><rest/><duration>{dur}</duration>'
                                 f'<type>{kind}</type>{"<dot/>" * dots}</note>')
                else:
                    alter = ev.get("alter") or 0
                    alt = f"<alter>{alter}</alter>" if alter else ""
                    chunk.append(
                        f'      <note><pitch><step>{ev["step"]}</step>{alt}'
                        f'<octave>{ev["octave"]}</octave></pitch>'
                        f'<duration>{dur}</duration><type>{kind}</type>{"<dot/>" * dots}{tie}</note>'
                    )
            chunk.append("    </measure>")
        chunk.append("  </part>")
        body.append("\n".join(chunk))

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<score-partwise version="3.1">\n'
        f'  <work><work-title>{title}</work-title></work>\n'
        '  <part-list>\n' + part_list + '\n  </part-list>\n'
        + "\n".join(body) + "\n</score-partwise>\n"
    )


def _fmt(x):
    return str(int(x)) if abs(x - round(x)) < 1e-6 else f"{x:g}"


def _snap(x):
    return round(round(x / GRID) * GRID, 6)


def _type_of(beats):
    table = [(4, "whole"), (2, "half"), (1, "quarter"),
             (0.5, "eighth"), (0.25, "16th")]
    for value, name in table:
        if beats >= value - 1e-9:
            rest = beats - value
            if rest < 1e-9:
                return name, 0
            if abs(rest - value / 2) < 1e-9:
                return name, 1
            return name, 0
    return "quarter", 0


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


# 调号 -> MusicXML <fifths>。简谱用 `1=Bb` 这类写法，而 MusicXML 要的是
# 升降号个数；写错会让客户端移调时调号与音高脱节。
_FIFTHS = {
    "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F#": 6, "C#": 7,
    "F": -1, "BB": -2, "EB": -3, "AB": -4, "DB": -5, "GB": -6, "CB": -7,
}


def _fifths_of(key) -> int:
    """`1=Bb` / `Bb` / `bb` -> 调号升降号个数。未知一律当作 C（0）。"""
    if not key:
        return 0
    s = str(key).strip().replace("♯", "#").replace("♭", "b")
    if not s:
        return 0
    letter = s[0].upper()
    acc = s[1:]
    if "#" in acc:
        cand = letter + "#"
    elif "b" in acc:
        cand = letter + "B"
    else:
        cand = letter
    return _FIFTHS.get(cand, 0)


def to_pack_entry(score):
    return {
        "title": score["title"] or "Untitled",
        "bpm": score["bpm"],
        "bar": score["bar"],
        "parts": [
            {
                "id": p["id"],
                "name": p["name"],
                "notes": [[ev.get("midi"), _snap(ev["beats"])] for ev in
                          [e for m in p["measures"] for e in m["events"]]],
            }
            for p in score["parts"]
        ],
    }


def read_mxl(path):
    if path.suffix.lower() == ".mxl":
        with zipfile.ZipFile(path) as z:
            root_file = None
            try:
                cont = ET.fromstring(z.read("META-INF/container.xml"))
                for rf in cont.iter():
                    if rf.tag.endswith("rootfile"):
                        root_file = rf.get("full-path")
            except KeyError:
                pass
            names = [n for n in z.namelist() if n.lower().endswith((".xml", ".musicxml"))]
            if not root_file or root_file not in names:
                names = [n for n in names if not n.startswith("META-INF/")]
                root_file = max(names, key=lambda n: z.getinfo(n).file_size)
            return ET.fromstring(z.read(root_file))
    return ET.parse(path).getroot()


def convert(pdf, work, out_dir, exe, force, warnings, bpm=None, repeats=True,
            progress=None, timings=None, batch_size=None, pages=None):
    """PDF -> (score dict, MusicXML path). Same contract as before.

    `progress(done, total)` and `timings` are optional instrumentation hooks
    used by the server; callers that pass neither get the old behaviour.
    `pages` lets a caller that already counted the PDF (the server does, for
    its MAX_PAGES check) avoid counting it twice.
    """
    if timings is not None:
        timings.setdefault("parse", 0)
    mxls, notes = recognise(pdf, work, exe, force=force, progress=progress,
                            timings=timings, batch_size=batch_size, pages=pages)
    warnings.extend(notes)
    if not mxls:
        _emit_progress(progress, done=1, total=1, phase="parse")
        return None
    t0 = time.perf_counter()
    scores = []
    for m in mxls:
        try:
            scores.append(parse_musicxml(read_mxl(m)))
        except ET.ParseError as exc:
            warnings.append(f"{m.name}: bad MusicXML ({exc})")
    score = concat_pages([s for s in scores if s], warnings)
    if not score:
        _bump(timings, "parse", _elapsed_ms(t0))
        _emit_progress(progress, done=1, total=1, phase="parse")
        return None
    if not score["title"]:
        score["title"] = pdf.stem
    if len(score["parts"]) > 8:
        warnings.append(f"{len(score['parts'])} parts found, kept the top 8 (the app's limit)")
        score["parts"] = score["parts"][:8]
    if score.get("chord_drops"):
        warnings.append(f"{score['chord_drops']} chord note(s) dropped, top line kept")
    if repeats:
        expand_repeats(score["parts"], warnings)
    normalise(score, warnings)
    if bpm:
        score["bpm"] = bpm
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / (pdf.stem + ".musicxml")
    target.write_text(to_musicxml(score), encoding="utf-8")
    _bump(timings, "parse", _elapsed_ms(t0))
    _emit_progress(progress, done=1, total=1, phase="parse")
    return score, target


def collect(src):
    p = Path(src)
    if p.is_file():
        return [p] if p.suffix.lower() == ".pdf" else []
    return sorted(q for q in p.rglob("*.pdf") if q.is_file())


def process(pdf, args, exe, out_dir, work_root):
    warnings = []
    try:
        got = convert(pdf, work_root / pdf.stem, out_dir, exe, args.force, warnings,
                      bpm=args.bpm, repeats=not args.no_repeats,
                      batch_size=getattr(args, "batch_size", None))
    except Exception as exc:                       # noqa: BLE001
        return pdf, None, [f"failed: {exc}"]
    return pdf, got, warnings


def main():
    ap = argparse.ArgumentParser(description="PDF -> MusicXML via Audiveris OMR")
    ap.add_argument("--src", required=True, help="a PDF file or a folder of PDFs")
    ap.add_argument("--out", default="omr-out", help="folder for the MusicXML files")
    ap.add_argument("--work", default=None, help="scratch folder (default: <out>/.work)")
    ap.add_argument("--pack", default=None, help="also write these scores into a sonnet pack")
    ap.add_argument("--audiveris", default=None, help="path to Audiveris executable")
    ap.add_argument("--bpm", type=int, default=None, help="tempo to use when the PDF has none")
    ap.add_argument("--jobs", type=int, default=2, help="how many PDFs to recognise at once (default 2)")
    ap.add_argument("--batch-size", type=int, default=8,
                    help="how many sheets to put in one Audiveris JVM invocation (default 8)")
    ap.add_argument("--force", action="store_true", help="re-run OMR even if output exists")
    ap.add_argument("--no-repeats", action="store_true", help="keep repeat marks unexpanded")
    args = ap.parse_args()

    exe = find_audiveris(args.audiveris)
    if not exe:
        sys.exit("Audiveris not found. Install it and pass --audiveris, or set AUDIVERIS.")

    pdfs = collect(args.src)
    if not pdfs:
        sys.exit("No PDF found in " + args.src)

    out_dir = Path(args.out)
    work_root = Path(args.work) if args.work else out_dir / ".work"
    work_root.mkdir(parents=True, exist_ok=True)

    jobs = max(1, min(8, args.jobs))
    if jobs > 1:
        print(f"{len(pdfs)} PDF(s), up to {jobs} at once", flush=True)

    entries, failures = [], 0
    done = 0
    order = {pdf: i for i, pdf in enumerate(pdfs)}
    collected = {}
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(process, pdf, args, exe, out_dir, work_root): pdf for pdf in pdfs}
        for fut in as_completed(futures):
            pdf, got, warnings = fut.result()
            done += 1
            print(f"[{done}/{len(pdfs)}] {pdf.name}", flush=True)
            if not got:
                failures += 1
                print("    NOT CONVERTED: " + "; ".join(warnings[-2:] or ["unknown error"]))
                continue
            score, target = got
            notes = sum(1 for p in score["parts"] for m in p["measures"]
                        for e in m["events"] if not e["rest"])
            measures = len(score["parts"][0]["measures"]) if score["parts"] else 0
            print(f"    -> {target.name}  {len(score['parts'])} part(s)  {measures} bar(s)  {notes} note(s)")
            for w in warnings[:3]:
                print("    note: " + w)
            if len(warnings) > 3:
                print(f"    note: ... {len(warnings) - 3} more")
            collected[order[pdf]] = to_pack_entry(score)

    entries = [collected[i] for i in sorted(collected)]

    if args.pack and entries:
        pack_path = Path(args.pack)
        pack_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "format": "sonnet-pack",
            "version": 1,
            "name": pack_path.stem,
            "source": "Audiveris OMR",
            "license": "check the source edition",
            "count": len(entries),
            "songs": entries,
        }
        pack_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\npack: {pack_path} ({len(entries)} score(s))")

    print(f"\ndone: {len(entries)} converted, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
