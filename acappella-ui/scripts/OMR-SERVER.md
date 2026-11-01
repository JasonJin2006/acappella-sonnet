# 谱面识别服务（sonnet-omr）

把 PDF 谱面识别成 MusicXML，给手机上的「十四行」用。**公网可用，手机不需要连电脑。**

## 现状

| 项 | 值 |
|---|---|
| 地址 | `https://101.43.109.115:443` |
| 服务 | `sonnet-omr.service`，systemd 开机自启 |
| 引擎 | Audiveris 5.11.0（自带宽 Java 25 运行时） |
| 鉴权 | 请求头 `X-Token`，口令在 `~/sonnet-omr/token.txt` |
| 队列 | 默认**串行**（worker=1），排队上限 20；可 `--workers 2` 开并发 |
| 限流 | 单 IP 每小时 20 个任务 |
| 体量 | 单文件 40MB，结果保留 1 小时 |
| 实测 | 单页四声部八小节 **12.6 秒**，音高 30/30 正确 |
| 进度 | `GET /omr/<id>` 带 `phase` / `progress` / `timings`，客户端显示真实 ETA |

与线上 `zhujian.service`（80 端口）完全独立，互不影响。
`sonnet-omr` 加了 `MemoryMax=3G` + `Nice=5`，识别时不会把线上服务挤掉。

## 为什么要排队

Audiveris 单进程峰值约 1GB 内存，这台机器 8GB 还要跑线上业务。
并发跑两个就可能把 `zhujian.service` 拖垮，所以默认同一时刻只放一个任务。
其余排队，客户端能看到自己在前几个。

要提吞吐用 `--workers 2`（或 `SONNET_OMR_WORKERS=2`），硬上限 4：

```bash
sudo systemctl edit sonnet-omr        # 在 [Service] 下加
# Environment=SONNET_OMR_WORKERS=2
sudo systemctl restart sonnet-omr
```

实测 2 个排队任务约 **1.45~1.5 倍**墙钟收益（不是 2 倍）。
**开之前先量内存**：`systemctl show sonnet-omr -p MemoryCurrent -p MemoryMax`，
基线约 1GB/进程，cgroup 只有 3G，两个 worker 的 3G 边界在真机上**尚未实测**。
不确定就留默认 1。

## 已知的性能坑（都已在代码里修掉，别再写回去）

1. **别为了数页数去启动 JVM**。旧代码用 `Audiveris -step LOAD` 数页数，
   每次 2~4 秒；现在 pypdf 优先（十几毫秒），页面结构损坏才退回字节正则。
   `/health` 的 `pageBackend` 能确认走的是快路径。
2. **别一页一页地重跑**。旧代码整本失败后退化成逐页调用，**每页重付一次 JVM 启动**，
   而且丢掉整本已经算完的识别结果。现在一次 `-transcribe -save` 跑完整本，
   失败页从已落盘的 `.omr` 里逐页捞，好页不会被一张坏页连累。
3. **坏页不要盲目重试**。引擎内部报错（如 `Voices.refineSystem` 的 NPE）
   在同一页上是确定性的，重试只多花约 21 秒仍然失败，所以直接跳过并报告。
4. **导出多份分谱会互相覆盖**。Audiveris 按 *book* 命名单页导出结果，
   多个无标题分谱会都叫 `<book>.mvtnull.mxl`。整本只有一个分谱时可以一次导出，
   多个分谱必须逐页导出，否则**后面的谱会覆盖前面的**（实测 28 小节只剩 14）。
   另外 `.omr` 作输入时 `-output` 会被忽略，`.mxl` 写在 `.omr` 旁边。
5. **别做 GRID 预检再转录**。实测 6.2 + 16.6 = 22.8 秒，比一次性 18.9 秒更慢：
   保存的 GRID 状态救不回转录时间。

## 为什么必须有 token

服务以前只绑 `127.0.0.1`，靠 SSH 隧道挡在外面。现在开到公网，
**任何人不带 token 都能上传 PDF 让服务器跑 Audiveris** —— 那是白送算力。
所以：

- `--host 0.0.0.0` 必须配 `--token-file`，否则服务拒绝启动（代码里硬性检查）
- 客户端把 token 放在 `src/lib/omr.js` 的 `TOKEN` 常量里，随 APK 分发

这挡住的是扫端口的爬虫和随手试试的人，**挡不住专门逆向 APK 的人**。
真要防住后者，得做账号体系。当前的取舍是「够用就好」。

## 接口

```
POST /omr              multipart 字段 file，body 必须是 PDF
                       需要 X-Token
                       202 -> {id, status, position?, rateRemaining, maxPages}
                       401 无 token / 429 超频 / 503 队列满 / 413 太大 / 400 不是 PDF
GET  /omr/<id>         查询，需要 X-Token
                       status: queued | running | done | error
                       queued 时带 position（前面还有几个）
                       进度（新增，老客户端忽略即可）：
                         phase    "queued|preflight|recognise 4/24|export|done|error"
                         progress 0..1
                         timings  {upload,queueWait,pageCount,preflight,
                                   recognise,export,parse,total} 毫秒
                         pages    这份 PDF 的页数
                         warnings 被跳过的页（无谱面 / 引擎报错），便于提示用户
GET  /omr/<id>/xml     下载 MusicXML，需要 X-Token
GET  /health           存活与队列状态，**不需要 token**
                       含 pageBackend（确认页数走的是快路径）、workers
```

字段**只增不减**：已经发出去的 APK 只认老字段，新字段一律是附加的。

## 手机端

App 里「创作 → 谱库 → 导入或手写谱面 → 导入」选一个 PDF 即可。
网络请求走 `src/lib/omr.js`，识别中会显示排队位次。

证书是自签的（`CN=sonnet-omr`，SAN 含 `101.43.109.115`，有效期到 2036），
已经打进 APK：`android/app/src/main/res/raw/sonnet_omr_ca.pem` +
`res/xml/network_security_config.xml`。**手机上不用手动装证书。**

## 运维

```bash
sudo systemctl status sonnet-omr
sudo systemctl restart sonnet-omr
journalctl -u sonnet-omr -n 50 --no-pager
curl -sk https://127.0.0.1/health
cat ~/sonnet-omr/token.txt          # 查看口令
```

换 token：改 `token.txt` → `systemctl restart sonnet-omr` → 同步改 APK 里的 `TOKEN` 重新打包。

### ⚠️ 上线前必须核对一次：客户端可能根本不发 token

`src/lib/omr.js` 的 `authHeaders()` 里有一行**老守卫**：

```js
if (TOKEN && TOKEN !== '3901b08123ffd3c6c63fef2e188e05bf27d47a5eab48ef82') h['X-Token'] = TOKEN
```

也就是说：如果 APK 里的 `TOKEN` 仍是那串默认值，客户端**不发** `X-Token`。
而服务端 `_authed()` 在配了 `token.txt` 时是 `got == TOKEN` 严格比较，空串必 401。

判据只有两种，都必须亲手确认：

```bash
cat ~/sonnet-omr/token.txt        # 和服务端日志里的 auth 行为一起看
curl -sk https://127.0.0.1/health # 不需要 token，先确认服务活着
```

- 若 `token.txt` **等于**上面那串默认值 → 线上 App 每次都会 401，
  用户看到的是「识别失败」，很容易被误当成「服务器慢」。
  修法是删掉 `&& TOKEN !== '...'` 这个条件（非空就发），重新打包 APK。
- 若用 `--token-file` 起服务且口令不同 → 同样 401，症状一致。
- 只有**没配 `token-file`**（`_authed()` 直接放行）时才不会发作，
  这也正是这个问题能一直藏着的原因。

这条和性能无关，所以本次没有顺手改（改鉴权要单独评审 + 重新打包），
但**部署前请务必核对**，否则再快也是「快着失败」。

换证书（重签 / 换域名）：替换 `cert.pem`/`key.pem`，同时替换 APK 里的
`res/raw/sonnet_omr_ca.pem` 并重新打包，否则手机连不上。这是刻意的证书固定。

手工转换（不经过服务）：

```bash
cd ~/sonnet-omr
python3 pdf_to_score.py --src 谱面.pdf --out out --audiveris /opt/audiveris/bin/Audiveris
```

## 简谱（电子版）识别

服务现在支持**电子版简谱**，走的是和五线谱完全不同的路径：

| | 五线谱 | 简谱（电子版） |
|---|---|---|
| 引擎 | Audiveris + JVM | 纯 Python 解析（`jianpu_parser.py`） |
| 耗时 | 十几秒/页 | **几十毫秒/首** |
| 内存 | 约 1GB | 几乎为零 |
| 排队 | 要排队 | 不占识别队列 |

为什么能这么快：电子版简谱的音高就是**文字里的数字**，调号 `1=C`、拍号 `4/4`
都是明文；八度点、减时线、小节线是**矢量图元**，pymupdf 直接给坐标。
所以整件事是确定性解析，不需要任何图像识别或机器学习。

### 支持范围

- 调号：`1=C`、`1=G`、`1=Bb`、`1=bB`、`1=B♭`、`1=Eb`、`1=F#` 等写法
- 拍号：`2/4`、`3/4`、`4/4`、`6/8` 等
- 时值：增时线 `－`、减时线（下划线）、附点
- 八度：高音点 / 低音点
- 多声部：一行一个声部（`女高音 S:` 这类写法），最多按出现顺序全收
- 休止符 `0`

**不支持**：扫描件/拍照（没有文字层，会回退给 Audiveris 并失败）。
扫描的简谱需要字形识别，是另一个量级的工作，目前不做。

### 判定逻辑（重要）

服务先判断"是不是电子版简谱"，命中才走快路径，否则原样交给 Audiveris。
判据刻意保守——**认错比不认更糟**：把五线谱当简谱解析会产出一份
"看起来成功、其实音高全错"的谱。

具体判据（三条同时满足）：
1. 有文字层（扫描件直接放弃）
2. 出现 `1=X` 调号写法
3. 存在**几何行**里数字占比 ≥60% 且至少 4 个数字的谱面行

第 3 条是踩坑加上的：只看"有 `1=X` + 数字够多"时，
**带调性标注的五线谱**（歌词里有 `1.` `2.` 序号）会被误判。

### 简谱特有的坑（都已处理）

1. **减时线不折增时线**：`1 -` 加一根下划线是 `0.5 + 1 = 1.5` 拍，
   不是 `(1+1)/2 = 1` 拍。算错会让后面所有音整体偏移。
2. **降号写法**：`Bb` 的第二个字符是降号，不是大小写变体。
   `B` 与 `Bb` 差一个半音，弄错全曲偏调。
3. **文字被拆散**：简谱里每个数字常各自成行，且同一行的声部名与数字**基线不同**。
   必须按几何 y 带聚成行，不能依赖 `get_text("text")` 的行。
4. **附点 vs 低八度点**：两者都在数字下方，区别是附点**偏右**、下加点**居中**。
5. **调号要写进 MusicXML**：`<fifths>` 写死 0 会让客户端移调时调号与音高脱节。

### 测试

```bash
python .qa/jianpu/test_jianpu.py          # 全部通过
```
覆盖时值规则、调号写法、八度、四声部端到端，以及
**五线谱不能被误判成简谱**的负向用例。

## 装 Audiveris 时踩过的坑

1. **官方 deb 自带 JRE**，不用另外 `apt install openjdk`。
2. **服务器直连 GitHub 只有 1.3KB/s**（`github.com` 被墙，但 `api.github.com`
   和 `objects.githubusercontent.com` 通）。78MB 的包要在本机走代理下好再 `scp`。
3. **`dpkg -i` 报错不等于装失败**：postinst 里的 `xdg-desktop-menu` 在无桌面
   服务器上 `exit 3`，包状态卡在 `iF`。补目录再 configure：
   ```bash
   sudo mkdir -p /etc/xdg/menus/applications-merged /usr/share/desktop-directories
   sudo dpkg --configure audiveris
   ```
4. 日志里的 `TesseractOCR: supported languages is empty` 只影响歌词/标题识别。

## 防火墙

Lighthouse 防火墙需要放行 **TCP 443**（源 `0.0.0.0/0`）。
当前放行：22、80、443、ICMP。

> 注意：这是 Lighthouse 防火墙，不是 CVM 安全组。两者接口相似但位置不同。

## 精度预期

这是 OMR，不是读数字谱。干净四行谱面（MuseScore / Finale 导出 PDF）
音高接近 100%；扫描件、倾斜、低分辨率会明显变差。已知失效模式：

- 某处时值认错导致整段错位
- 每首末尾少 1 到 3 个音
- 变拍号读不出来
- 和弦只留最高音

**导入后必须对着原谱校一遍。** App 会提示识别出的声部数、小节数、音符数，方便对照。
