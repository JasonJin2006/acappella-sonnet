# 导入包

这里放的是给自己导入用的谱面包，不随应用打包，也不参与构建。装应用的人默认看不到这些内容。

两份包可以单独导入，也可以都导入，互不冲突。导入方式：谱库页 →「导入或手写谱面」→「整包」→ 选文件。导入后出现在「我的谱」，可以按曲名或作曲家搜索。

## sonnet-pack-art-songs.json

1235 首艺术歌曲的四声部练习编配，覆盖 124 位作曲家，7.0 MB。

- 旋律来自 OpenScore Lieder 语料的人声部，该语料以 CC0 1.0 释出，原始作品均为公版。
- 女高是原旋律（必要时整体移八度），女中、男高、男低由项目里的 `arranger.js` 按小节推定和弦后生成，属于练习编配，不是作曲家写的伴奏。
- 统一柱式织体，一小节一个和弦，适合排练时跟谱，不适合当演出谱。
- 拍号、速度取自原谱；速度限制在 50 到 200 BPM。
- 音域过宽或素材不完整的曲目已剔除，共 117 首。

## sonnet-pack-pop-standards.json

341 首公有领域流行曲，1.6 MB，时间跨度从 1890 年代到 1920 年代，涵盖 Tin Pan Alley、拉格泰姆、布鲁斯、灵歌与民歌。

包含《Alexander's Ragtime Band》《After You've Gone》《Bill Bailey, Won't You Please Come Home?》《St. Louis Blues》《Shenandoah》《Turkey in the Straw》这一类曲子。

- 旋律与和弦记号来自 The Public Domain Song Anthology（David Berger、Chuck Israels 编，2020，CC0），原书 348 首，这里收了能解析的 341 首。
- 织体用应用里的默认方案（独唱、三度、长音、节奏、柱式、敲钟），比艺术歌曲那包更有律动。
- 原书标注的爵士和声没有采用，四声部仍由 `arranger.js` 按旋律推定，所以听着比原版简单，是练习编配。
- 原谱没有速度标记，统一填 92 BPM。跟谱按实际演唱推进，速度只影响节拍器与提示音的提前量。
- 三首因音域不适合四部合唱被剔除。

### 一处地域差异

美国按出版年份判定公有领域（1929 年前出版即为公版），中国按作者死亡时间算（终生加死后五十年）。两套规则并不重合，所以这个包里有 13 首属于「美国公版、中国仍在保护期」：

- Irving Berlin（1989 年去世）10 首，例如《Alexander's Ragtime Band》《A Pretty Girl Is Like a Melody》
- Eubie Blake（1983 年去世）与 Noble Sissle 合作的 2 首
- Edgar Leslie（1976 年去世）参与作词的《For Me And My Gal》，今年年底到期

自己导入、自己排练属于私人使用，不必处理。把包转发给别人，或者内置进应用随安装包分发，就是另一回事了。艺术歌曲那一包没有这个问题，作曲家最晚的是 Richard Strauss（1949 年去世）。

## 关于现代流行歌

还在版权保护期内的词曲（中文或英文都算）没有放进来，也不建议用转写的方式绕过：旋律本身受词曲版权保护，和录音版权是两层权利。

想排某首当代作品，正规做法是拿授权的谱（买谱、找编曲，或团里已有的 MusicXML），用「文件夹」入口整目录导入。这一步只在你自己机器上发生，包也不会随应用分发。

## 换成自己的谱

如果手上是 MusicXML 或 MuseScore 文件，可以直接把整个文件夹打成包，不用逐首导入。

如果手上只有 PDF，先做光学识别转成 MusicXML，再走下面这套流程。识别用 Audiveris，脚本和精度说明见 `acappella-ui/README.md` 的「从 PDF 导入」。

```bash
cd acappella-ui

# 0. 只有 PDF 才需要：先转成 MusicXML，放回自己的谱目录
python scripts/pdf_to_score.py --src "D:/我的谱" --out "D:/我的谱/xml"

# 1. 抽出每首的旋律（.mscx 会先调用本机 MuseScore 4 转换；已有 MusicXML 就直接读）
python scripts/build_pack.py --src "D:/我的谱" --work /tmp/pack-work --out /tmp/melodies.json

# 2. 生成四声部并打包
node scripts/build_pack.mjs --in /tmp/melodies.json --out "packs/my-pack.json" --name "我的曲目"

# 3. 检查
node scripts/check_pack.mjs "packs/my-pack.json"
```

常用参数：`--textures plan` 用默认织体方案（流行曲、民歌合适），不加就是全柱式；`--default-bpm 92` 指定原谱没有速度时的默认值；`--index out.md` 顺带生成曲目清单。

不加参数时只取主旋律那一声部。如果原谱本来就是四声部，更省事的做法是在应用里用「文件夹」直接选目录，那个入口会逐首读原谱，保留原有和声与排版。

## 包格式

纯 JSON，一次导入写进本机 IndexedDB，不上传。字段如下，`notes` 用 `[音高, 拍数]` 表示，音高为 `null` 表示休止。

```json
{
  "format": "sonnet-pack",
  "version": 1,
  "name": "流行金曲四声部",
  "source": "The Public Domain Song Anthology",
  "license": "CC0-1.0",
  "count": 341,
  "songs": [
    {
      "title": "Shenandoah（民歌）",
      "bpm": 92,
      "bar": 4,
      "parts": [
        { "id": "S", "notes": [[60, 1], [null, 3]] },
        { "id": "A", "notes": [[57, 1], [null, 3]] }
      ]
    }
  ]
}
```

`bar` 是每小节的拍数，按四分音符计。同名曲目会覆盖旧记录，重复导入同一个包不会产生副本。

## 许可

- 艺术歌曲：OpenScore Lieder，CC0 1.0。
- 流行曲：The Public Domain Song Anthology，编纂者已放弃全部权利，可自由使用、改编、传播。
- 两份包里由本项目的编配器生成的四个声部同样不受限制。

代码本身见 `acappella-ui/README.md`。
