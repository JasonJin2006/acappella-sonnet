#!/usr/bin/env python3
"""Sonnet OMR service — PDF 谱面 -> MusicXML，供手机端调用。

公网部署要点
============
1. **必须开鉴权**。这个服务以前只绑 127.0.0.1，靠 SSH 隧道挡在外面；
   一旦开到公网，任何人都能上传 PDF 让服务器跑 Audiveris（单进程约 1GB 内存、
   十几秒 CPU），不设防就是白送算力。
   做法：请求头 `X-Token` 必须匹配 ~/sonnet-omr/token.txt 里的口令。

2. **串行队列（默认）**。Audiveris 一个进程吃约 1GB 内存，这台机器 8GB 还跑着线上
   zhujian.service。所以默认同一时刻只跑一个任务，其余排队。
   排队者能通过 /omr/<id> 看到自己在第几位。
   确有余量时可 `--workers 2`（或 `SONNET_OMR_WORKERS=2`）开两个并发；
   这台 8GB / cgroup 3G 的机器上**推荐最多 2**，代码里硬性上限 4。
   并发数只影响吞吐，MAX_QUEUE / 限流 / position 的口径都不变。

3. **速率与体量限制**。单 IP 每小时最多 20 个任务，单文件 40MB，
   同时未完成任务上限 20 个，超了直接拒绝（而不是无限堆积）。

4. **纯 Python 数页数**。`pdf_page_count` 用 pypdf（毫秒级），不再为了
   数页数启动 JVM；Audiveris `-step LOAD` 只在 PDF 损坏且没有解析库时兜底。

接口
====
POST /omr              上传 PDF（multipart 字段 file），返回 {id, queue}
GET  /omr/<id>         查询 {status, position, phase, progress, timings, ...}
GET  /omr/<id>/xml     下载 MusicXML
GET  /health           存活与队列状态（不需要 token）

`phase` / `progress` / `timings` / `pages` / `warnings` 都是新增字段，
旧字段与状态码保持不变，老 APK 继续可用。

用法
====
    python3 omr_server.py --port 443 --host 0.0.0.0 \\
        --cert cert.pem --key key.pem --token-file token.txt [--workers 2]
"""
import argparse
import json
import os
import re
import shutil
import ssl
import sys
import threading
import time
import traceback
import uuid
from collections import deque, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

try:
    import pdf_to_score as conv
except Exception:  # pragma: no cover
    conv = None

# 简谱（电子版）解析器。可选依赖：没有它服务照常跑，只是少了快路径。
try:
    import jianpu_parser as conv_jianpu
except Exception:  # pragma: no cover
    conv_jianpu = None

# 预热纯 Python 页数后端（pypdf/pymupdf 的 import 约 0.4s）。放在模块加载时，
# 让这笔一次性成本落在服务启动而不是第一个上传任务的 pageCount 里。
PAGE_BACKEND = None
if conv is not None:
    try:
        PAGE_BACKEND = conv.warm_page_counter()
    except Exception:  # pragma: no cover
        PAGE_BACKEND = None

MAX_UPLOAD = 40 * 1024 * 1024
MAX_PAGES = 40            # 页数上限：40 页约 6~10 分钟
JOB_TTL = 3600
MAX_JOBS = 60
MAX_QUEUE = 20            # 排队上限，超过直接 503
RATE_PER_HOUR = 20        # 单 IP 每小时任务数

# 并发识别进程数。默认 1 = 与以前完全一致（串行）。
# 8GB 机器还跑着 zhujian.service，Audiveris 单进程约 1GB，cgroup 是 3G，
# 所以推荐最多 2；想开并发用 --workers 2 或 SONNET_OMR_WORKERS=2。
WORKERS = 1

AUDIVERIS = os.environ.get("AUDIVERIS", "/opt/audiveris/bin/Audiveris")

TOKEN = None              # 启动时从 token 文件读入


class Job:
    __slots__ = ("id", "status", "created", "started", "finished", "name",
                 "pdf", "xml", "parts", "bars", "notes", "error", "log", "ip",
                 "phase", "progress", "pages", "timings", "warnings", "_lock")

    def __init__(self, jid, name, ip=""):
        self.id = jid
        self.status = "queued"
        self.created = time.time()
        self.started = None
        self.finished = None
        self.name = name
        self.pdf = None
        self.xml = None
        self.parts = None
        self.bars = None
        self.notes = None
        self.error = None
        self.log = ""
        self.ip = ip
        self.phase = "queued"
        self.progress = 0.0
        self.pages = None
        self.warnings = []
        self._lock = threading.Lock()
        # 毫秒，任务级（不是每页）。先全部置 0，跑起来后逐项填。
        self.timings = {
            "upload": 0,
            "queueWait": 0,
            "pageCount": 0,
            "preflight": 0,
            "recognise": 0,
            "export": 0,
            "parse": 0,
            "total": 0,
        }

    # ---- 增量更新（worker 线程写，HTTP 线程读） ----
    def set_timing(self, key, ms):
        with self._lock:
            self.timings[key] = int(ms)

    def add_timing(self, key, ms):
        with self._lock:
            self.timings[key] = int(self.timings.get(key) or 0) + int(ms)

    def set_phase(self, phase, progress=None):
        with self._lock:
            self.phase = phase
            if progress is not None:
                self.progress = max(0.0, min(1.0, float(progress)))

    def timing_snapshot(self):
        with self._lock:
            return dict(self.timings)

    def public(self, position=None):
        with self._lock:
            phase, progress = self.phase, round(self.progress, 3)
            timings = dict(self.timings)
            warnings = list(self.warnings)
        d = {
            "id": self.id,
            "status": self.status,
            "name": self.name,
            "created": int(self.created),
            "phase": phase,
            "progress": progress,
            "timings": timings,
        }
        if self.pages:
            d["pages"] = self.pages
        if warnings:
            # Additive. Pages that were dropped are called out here so the app
            # can tell the user "N pages skipped" without parsing `error`.
            d["warnings"] = warnings
        if position is not None and self.status == "queued":
            d["position"] = position
        if self.started:
            d["started"] = int(self.started)
        if self.finished:
            d["finished"] = int(self.finished)
            d["seconds"] = round(self.finished - (self.started or self.created), 1)
        if self.status == "done":
            d.update(parts=self.parts, bars=self.bars, notes=self.notes,
                     xml=f"/omr/{self.id}/xml")
        if self.error:
            d["error"] = self.error
        return d


class Store:
    def __init__(self, work: Path, workers=1):
        self.work = work
        self.lock = threading.Lock()
        self.jobs = {}
        self.queue = deque()
        self.workers = []          # 存活的 worker Thread 列表
        self.max_workers = max(1, int(workers or 1))
        self.rate = defaultdict(list)   # ip -> [timestamps]

    # ---- 限流 ----
    def allow(self, ip):
        now = time.time()
        with self.lock:
            hits = [t for t in self.rate[ip] if now - t < 3600]
            self.rate[ip] = hits
            if len(hits) >= RATE_PER_HOUR:
                return False, RATE_PER_HOUR
            hits.append(now)
            return True, RATE_PER_HOUR - len(hits)

    def queue_position(self, jid):
        with self.lock:
            try:
                return list(self.queue).index(jid) + 1
            except ValueError:
                return None

    def get(self, jid):
        with self.lock:
            return self.jobs.get(jid)

    def submit(self, name, data: bytes, ip="", upload_ms=None) -> Job:
        jid = uuid.uuid4().hex[:12]
        job = Job(jid, name, ip)
        if upload_ms is not None:
            job.set_timing("upload", upload_ms)
        d = self.work / jid
        d.mkdir(parents=True, exist_ok=True)
        p = d / "input.pdf"
        p.write_bytes(data)
        job.pdf = p
        with self.lock:
            self.jobs[jid] = job
            self.queue.append(jid)
            self._gc()
        self._ensure_workers()
        return job

    def _gc(self):
        now = time.time()
        for jid, j in list(self.jobs.items()):
            if j.finished and now - j.finished > JOB_TTL:
                self.jobs.pop(jid, None)
                shutil.rmtree(self.work / jid, ignore_errors=True)
            elif now - j.created > JOB_TTL * 4:
                self.jobs.pop(jid, None)
                shutil.rmtree(self.work / jid, ignore_errors=True)
        if len(self.jobs) > MAX_JOBS:
            for jid, j in sorted(self.jobs.items(), key=lambda kv: kv[1].created):
                if j.status in ("done", "error") and len(self.jobs) > MAX_JOBS:
                    self.jobs.pop(jid, None)
                    shutil.rmtree(self.work / jid, ignore_errors=True)

    def _prune_workers(self):
        # Worker 在队列空时自己退出；这里只是把死掉的线程从列表里清掉。
        self.workers = [t for t in self.workers if t.is_alive()]

    def _ensure_workers(self):
        """Keep up to max_workers alive while there is queued work.

        Caller may or may not hold self.lock; the check/append is atomic with
        the same lock. Idle workers exit on their own, so this never leaves a
        permanent thread per configured worker with no jobs.
        """
        with self.lock:
            self.workers = [t for t in self.workers if t.is_alive()]
            while (self.queue and len(self.workers) < self.max_workers):
                t = threading.Thread(target=self._run, daemon=True)
                self.workers.append(t)
                t.start()

    def _run(self):
        while True:
            with self.lock:
                if not self.queue:
                    self.workers = [t for t in self.workers
                                    if t is not threading.current_thread() and t.is_alive()]
                    return
                jid = self.queue.popleft()
                job = self.jobs.get(jid)
            if not job:
                continue
            try:
                self._process(job)
            except BaseException:
                # _process already catches Exception; this guards the worker
                # itself. A silently dead worker with jobs still queued would
                # stall the whole service, so record the job as failed and
                # keep the loop alive for the next one.
                if job.status not in ("done", "error"):
                    job.status = "error"
                    job.error = "internal worker error"
                    job.log = traceback.format_exc()[-2000:]
                    job.finished = time.time()

    def _process(self, job: Job):
        job.status = "running"
        job.started = time.time()
        job.set_timing("queueWait", int(round((job.started - job.created) * 1000)))
        job.set_phase("preflight", 0.02)
        out_dir = job.pdf.parent / "out"
        warnings = []
        t_job = time.perf_counter()
        try:
            # ---- 简谱快路径（放在最前面）------------------------------------
            # 电子版简谱的音高是**文字**（数字），调号拍号也是明文，八度点和
            # 减时线是矢量图元。整条路是确定性解析：毫秒级、不启 JVM、
            # 不占 1GB 内存，和 Audiveris 完全不同的成本曲线。
            #
            # 位置很关键：必须在"找 Audiveris"**之前**。简谱根本不需要 Audiveris，
            # 先检查它会导致——比如服务端没装 Audiveris 时——纯简谱也被拒。
            # 一旦解析失败或没认出谱面，就安静回退给 Audiveris 主流程。
            if conv is not None and conv_jianpu is not None:
                t_jp = time.perf_counter()
                try:
                    jp_score, jp_notes = conv_jianpu.try_parse(job.pdf)
                    if jp_score and jp_score.get("parts"):
                        jp_elapsed = int(round((time.perf_counter() - t_jp) * 1000))
                        job.set_timing("pageCount", 0)
                        job.set_timing("preflight", 0)
                        job.set_timing("recognise", 0)
                        job.set_phase("export", 0.85)
                        jp_score["title"] = jp_score.get("title") or Path(job.name).stem
                        jp_warn = []
                        conv.normalise(jp_score, jp_warn)
                        warnings.extend(jp_notes + jp_warn)
                        xml_text = conv.to_musicxml(jp_score)
                        job.xml = job.pdf.parent / "score.musicxml"
                        job.xml.write_text(xml_text, encoding="utf-8")
                        parts = jp_score.get("parts") or []
                        job.parts = len(parts)
                        job.bars = max((len(p.get("measures") or [])
                                        for p in parts), default=0)
                        job.notes = sum(
                            1 for p in parts
                            for m in (p.get("measures") or [])
                            for e in (m.get("events") or [])
                            if not e.get("rest") and e.get("midi") is not None
                        )
                        job.set_timing("export", jp_elapsed)
                        job.set_timing("parse", 0)
                        if warnings:
                            job.log = "; ".join(str(w) for w in warnings[:8])[:2000]
                        job.set_phase("done", 1.0)
                        job.status = "done"
                        return
                except Exception as exc:      # noqa: BLE001
                    # 简谱解析出任何意外都不能挡住主流程：记一笔然后走 Audiveris
                    warnings.append(f"简谱解析未采用（{type(exc).__name__}: {exc}）")

            if conv is None:
                raise RuntimeError("pdf_to_score.py 没找到，无法调用 Audiveris")
            exe = conv.find_audiveris(AUDIVERIS)
            if not exe:
                raise RuntimeError(f"找不到 Audiveris：{AUDIVERIS}")

            # 页数上限。纯 Python 计数（pypdf），毫秒级，不再启动 JVM。
            t0 = time.perf_counter()
            try:
                pages = conv.pdf_page_count(job.pdf, exe)
                job.pages = pages
                job.set_timing("pageCount", int(round((time.perf_counter() - t0) * 1000)))
                if pages > MAX_PAGES:
                    raise RuntimeError(
                        f"这份 PDF 有 {pages} 页，超过上限 {MAX_PAGES} 页。请按乐章或分册拆开再传。"
                    )
            except RuntimeError:
                raise
            except Exception:
                # 探测失败就放行，让识别阶段自己报错
                job.set_timing("pageCount", int(round((time.perf_counter() - t0) * 1000)))

            out_dir.mkdir(parents=True, exist_ok=True)

            # 识别进度：把 (已处理页, 总页数) 折算成 0.05..0.78 的进度条。
            pages_total = job.pages or 1
            phase_box = {"name": "preflight"}

            def on_progress(done, total, phase=None):
                phase = phase or phase_box["name"]
                phase_box["name"] = phase
                total = max(1, int(total or pages_total))
                done = max(0, min(int(done), total))
                if phase == "parse":
                    job.set_phase("export", 0.92)
                    return
                if phase == "export":
                    job.set_phase("export", 0.80 + 0.12 * (done / total))
                    return
                if phase == "done":
                    job.set_phase("done", 1.0)
                    return
                frac = float(done) / total
                job.set_phase(f"recognise {done}/{total}", 0.05 + 0.73 * frac)

            conv_timings = _TimingBridge(job)
            res = conv.convert(
                job.pdf, job.pdf.parent / ".work", out_dir, exe,
                force=False, warnings=warnings,
                progress=on_progress, timings=conv_timings,
                batch_size=int(os.environ.get("OMR_BATCH_SIZE") or 0) or None,
                pages=job.pages,
            )
            # _TimingBridge already mirrored preflight/recognise/export onto the
            # job while recognition ran; parse is added below with copy time.
            if not res:
                # `error` goes straight to the phone's toast, so keep it short
                # and user-facing. Per-page detail stays in `warnings` and
                # `log` for support (see job.public()).
                detail = "; ".join(str(w) for w in warnings[:3]) or "没有产出"
                if any(("无谱面" in str(w)) or ("识别失败" in str(w)) for w in warnings):
                    raise RuntimeError(f"没有可识别的乐谱内容（{detail}）")
                raise RuntimeError(f"识别失败：{detail}")
            score, xml_path = res
            if not xml_path or not Path(xml_path).exists():
                raise RuntimeError("没有生成 MusicXML")

            job.set_phase("export", 0.90)
            t_parse = time.perf_counter()
            job.xml = job.pdf.parent / "score.musicxml"
            shutil.copyfile(xml_path, job.xml)
            parse_ms = int(conv_timings.get("parse") or 0)
            parse_ms += int(round((time.perf_counter() - t_parse) * 1000))
            job.add_timing("parse", parse_ms)

            parts = score.get("parts") or []
            job.parts = len(parts)
            job.bars = max((len(p.get("measures") or []) for p in parts), default=0)
            job.notes = sum(
                1 for p in parts
                for m in (p.get("measures") or [])
                for e in (m.get("events") or [])
                if not e.get("rest") and e.get("midi") is not None
            )
            if warnings:
                job.log = "; ".join(str(w) for w in warnings[:8])[:2000]
                # Surface per-page decisions to the phone (additive field).
                with job._lock:
                    job.warnings = [str(w)[:300] for w in warnings[:12]]
            job.status = "done"
            job.set_phase("done", 1.0)
        except Exception as e:
            job.status = "error"
            job.error = f"{type(e).__name__}: {e}"
            job.log = traceback.format_exc()[-2000:]
            if warnings:
                with job._lock:
                    job.warnings = [str(w)[:300] for w in warnings[:12]]
            job.set_phase("error", job.progress)
        finally:
            job.finished = time.time()
            # 处理耗时（不含排队）；total 与 seconds 口径一致，便于客户端对账
            job.set_timing("total", int(round((time.perf_counter() - t_job) * 1000)))
            for junk in ("out", ".work"):
                shutil.rmtree(job.pdf.parent / junk, ignore_errors=True)


class _TimingBridge(dict):
    """dict pdf_to_score writes into; mirrors values onto the live Job.

    `convert()` updates `timings` in place, but it runs in the worker thread
    and the HTTP thread polls the Job. Without this bridge, `timings.recognise`
    would only appear when recognition has already finished — useless for the
    client's ETA. Keys not listed here (e.g. "parse") are handled by _process,
    which needs to add its own copy time.
    """

    LIVE_KEYS = ("preflight", "recognise", "export")

    def __init__(self, job):
        super().__init__({k: 0 for k in self.LIVE_KEYS})
        self.job = job

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        if key in self.LIVE_KEYS:
            self.job.set_timing(key, value)


class Handler(BaseHTTPRequestHandler):
    server_version = "SonnetOMR/2.0"
    store = None

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---- 工具 ----
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Token")

    def _send(self, code, body):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _authed(self):
        if not TOKEN:
            return True          # 没配置 token 时（本机调试）放行
        got = self.headers.get("X-Token") or ""
        return got == TOKEN

    def _client_ip(self):
        # 只在内网反代场景信任 X-Forwarded-For；这里直接用对端地址
        return self.client_address[0]

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            with self.store.lock:
                jobs = list(self.store.jobs.values())
            return self._send(200, {
                "ok": True,
                "audiveris": Path(AUDIVERIS).exists(),
                "queued": sum(1 for j in jobs if j.status == "queued"),
                "running": sum(1 for j in jobs if j.status == "running"),
                "jobs": len(jobs),
                "maxQueue": MAX_QUEUE,
                "ratePerHour": RATE_PER_HOUR,
                "workers": self.store.max_workers,
                # Which page-count backend is live (pypdf/pymupdf/None). Additive:
                # lets ops see that the fast path is really enabled on the server.
                "pageBackend": PAGE_BACKEND,
            })

        if not self._authed():
            return self._send(401, {"error": "unauthorized：缺少或错误的 X-Token"})

        m = re.fullmatch(r"/omr/([a-f0-9]{12})", path)
        if m:
            jid = m.group(1)
            job = self.store.get(jid)
            if not job:
                return self._send(404, {"error": "no such job"})
            return self._send(200, job.public(self.store.queue_position(jid)))

        m = re.fullmatch(r"/omr/([a-f0-9]{12})/xml", path)
        if m:
            job = self.store.get(m.group(1))
            if not job:
                return self._send(404, {"error": "no such job"})
            if job.status != "done" or not job.xml or not job.xml.exists():
                return self._send(409, {"error": f"job is {job.status}"})
            data = job.xml.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.recordare.musicxml+xml")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition",
                             f'attachment; filename="{Path(job.name).stem}.musicxml"')
            self._cors()
            self.end_headers()
            self.wfile.write(data)
            return

        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/omr":
            return self._send(404, {"error": "not found"})
        if not self._authed():
            return self._send(401, {"error": "unauthorized：缺少或错误的 X-Token"})

        ip = self._client_ip()
        ok, remain = self.store.allow(ip)
        if not ok:
            return self._send(429, {
                "error": f"每小时最多 {RATE_PER_HOUR} 个任务，稍后再试",
                "retryAfter": 3600,
            })

        with self.store.lock:
            # Count by status, not len(queue): a worker pops the queue *before*
            # it sets status="running", so len(queue)+running can under-count by
            # up to `workers` and over-admit. Counting every job that is not yet
            # finished/done/error is conservative and exact with any worker
            # count, so MAX_QUEUE stays honest.
            active = sum(1 for j in self.store.jobs.values()
                         if j.status not in ("done", "error"))
            queued = sum(1 for j in self.store.jobs.values() if j.status == "queued")
            running = sum(1 for j in self.store.jobs.values() if j.status == "running")
        if active >= MAX_QUEUE:
            return self._send(503, {
                "error": f"队列已满（{MAX_QUEUE}），稍后再试",
                "queued": queued, "running": running,
            })

        t_upload = time.perf_counter()
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self._send(400, {"error": "empty body"})
        if length > MAX_UPLOAD:
            return self._send(413, {"error": f"too large (>{MAX_UPLOAD} bytes)"})
        body = self.rfile.read(length)

        name, data = self._parse_multipart(body)
        if data is None:
            return self._send(400, {"error": "multipart field 'file' not found"})
        if not data.startswith(b"%PDF"):
            return self._send(400, {"error": "not a PDF"})

        upload_ms = int(round((time.perf_counter() - t_upload) * 1000))
        job = self.store.submit(name or "upload.pdf", data, ip, upload_ms=upload_ms)
        self.log_message("job %s queued from %s (%s, %d bytes), remain=%d",
                         job.id, ip, job.name, len(data), remain)
        d = job.public(self.store.queue_position(job.id))
        d["rateRemaining"] = remain
        d["maxPages"] = MAX_PAGES
        self._send(202, d)

    def _parse_multipart(self, body: bytes):
        ctype = self.headers.get("Content-Type", "")
        m = re.search(r'boundary="?([^";]+)"?', ctype)
        if not m:
            if body[:4] == b"%PDF":
                return "upload.pdf", body
            return None, None
        boundary = ("--" + m.group(1)).encode()
        for part in body.split(boundary):
            if b'name="file"' not in part:
                continue
            head, _, rest = part.partition(b"\r\n\r\n")
            if not rest:
                continue
            data = rest.rstrip(b"\r\n-")
            fn = re.search(rb'filename="([^"]*)"', head)
            name = fn.group(1).decode("utf-8", "replace") if fn else "upload.pdf"
            return name, data
        return None, None


def main():
    global TOKEN, WORKERS
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--work", default=str(Path.home() / "omr-data"))
    ap.add_argument("--cert", default=None)
    ap.add_argument("--key", default=None)
    ap.add_argument("--token-file", default=None,
                    help="口令文件；不给则不需要鉴权（仅适合本机调试）")
    ap.add_argument("--workers", type=int, default=None,
                    help="并发识别进程数（默认 1 = 串行；这台 8GB/3G cgroup 的机器推荐最多 2）")
    args = ap.parse_args()

    # 默认 1，保持上线行为完全不变。显式 --workers 优先于环境变量。
    env_workers = os.environ.get("SONNET_OMR_WORKERS")
    workers = args.workers
    if workers is None:
        try:
            workers = int(env_workers) if env_workers else 1
        except ValueError:
            sys.exit(f"SONNET_OMR_WORKERS 不是整数：{env_workers!r}")
    if workers < 1:
        sys.exit("--workers 至少为 1")
    if workers > 4:
        sys.exit("--workers 最多 4：Audiveris 单进程约 1GB，这台机器的 cgroup 只有 3G")
    WORKERS = workers

    if args.token_file:
        tf = Path(args.token_file)
        if not tf.exists():
            sys.exit(f"token 文件不存在：{tf}")
        TOKEN = tf.read_text(encoding="utf-8").strip()
        if not TOKEN:
            sys.exit("token 文件是空的")
    elif args.host not in ("127.0.0.1", "localhost"):
        sys.exit("警告：监听非回环地址却没给 --token-file，拒绝启动。"
                 "公网服务必须有鉴权。")

    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)

    # 先把 pypdf 导入预热：否则第一个任务的 pageCount 会把这 ~0.4s 的
    # 一次性 import 记进去，看起来像「数页数还是很慢」。
    page_backend = PAGE_BACKEND
    if page_backend is None and conv is not None:
        try:
            page_backend = conv.warm_page_counter()
        except Exception:
            page_backend = None

    store = Store(work, workers=WORKERS)
    Handler.store = store

    srv = ThreadingHTTPServer((args.host, args.port), Handler)

    scheme = "http"
    if args.cert or args.key:
        if not (args.cert and args.key):
            sys.exit("--cert 和 --key 要一起给")
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(args.cert, args.key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        scheme = "https"

    sys.stderr.write(f"sonnet-omr {scheme}://{args.host}:{args.port}\n")
    sys.stderr.write(f"work: {work}\n")
    sys.stderr.write(f"audiveris: {AUDIVERIS} exists={Path(AUDIVERIS).exists()}\n")
    sys.stderr.write(f"auth: {'token required' if TOKEN else 'OPEN (loopback only)'}\n")
    sys.stderr.write(f"limits: {MAX_UPLOAD//1024//1024}MB/file, queue {MAX_QUEUE}, "
                     f"{RATE_PER_HOUR}/ip/hour, workers {WORKERS}\n")
    sys.stderr.write(f"page counter: {page_backend or 'byte fallback (no pypdf/pymupdf)'}\n")
    sys.stderr.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
