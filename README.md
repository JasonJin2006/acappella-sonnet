# 十四行 Sonnet — 源码

阿卡贝拉实时跟谱提示工具。戴耳机排练时，它听**整个团队**唱到哪，然后告诉你现在该唱什么音、自己唱得准不准。

名字取自 sonnet：一首小而完整的歌；「行」也是谱面上你负责的那一行。一句话版本：听见整队，唱准自己。

在线版：<https://a0de0714a7bcd96bd.app.workbuddy.host>

## 目录

| 目录 | 说明 |
|---|---|
| `acappella-ui/` | **应用源码**，Vite + React 18 + Capacitor 8。开发从这里开始，细节见它的 `README.md` |
| `packs/` | 两份现成的导入包：1235 首艺术歌曲、341 首公有领域流行曲。不参与构建，也不随 APK 分发，格式见 `packs/README.md` |

内置曲库只留《欢乐颂》一首示例。曲目走「我的谱」导入（MusicXML / 文本记谱 / 整包），存在本机 IndexedDB，不上传。

## 快速开始

```bash
cd acappella-ui
npm install
npm run dev          # http://localhost:5173
npm run build        # 产出 dist/
```

麦克风权限要求安全上下文：**localhost 或 HTTPS**，直接双击打开构建产物不行。

Android APK 的构建与安装步骤见 `acappella-ui/README.md` 的「打包成 Android APK」。

## 给接手开发的人

`acappella-ui/README.md` 里有：

- 目录结构与各模块职责
- 数据流（麦克风 → 每帧 → 界面）
- **改代码前必须知道的 8 条**（都是踩过的坑，比如和弦匹配不能做八度归一、OSMD 按容器宽度决定排几行）
- 已知限制（单麦克风无法真正分离声音；和声完全相同的段落存在本征歧义）
- 怎么跑测试：`tests/` 下是纯 Node 的离线分析，端到端用 `scripts/gen_test_audio.py` 造合成音频 + Playwright 假麦克风

调试时浏览器控制台可以直接访问 `__pilot` 看引擎内部状态。

## 许可

代码本身没有额外的授权限制。第三方内容与曲库的版权边界见 `acappella-ui/README.md` 的「许可」一节，众赞歌数据的许可见 `acappella-ui/CHORALES-LICENSE.txt`。
