# 十四行 Sonnet — 源码

阿卡贝拉实时跟谱提示工具。戴耳机排练时听整个团队唱到哪，告诉你现在该唱什么音、自己偏了多少。内置分类曲库 368 首，含 345 首巴赫四部众赞歌与公版民歌、颂歌、练习曲。

名字取自 sonnet：一首小而完整的歌；「行」也是谱面上你负责的那一行。

在线版：<https://a0de0714a7bcd96bd.app.workbuddy.host>

## 两个目录

| 目录 | 说明 |
|---|---|
| `acappella-ui/` | **主线源码**，Vite + React。开发从这里开始，细节见它的 `README.md` |
| `acappella-pilot/` | 早期单文件原型（`index.html`，零构建、可离线双击打开）。功能落后于主线，留着做参考，不需要可以直接删 |

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
- 怎么跑测试（`scripts/gen_test_audio.py` 造合成音频 + Playwright 假麦克风）

调试时浏览器控制台可以直接访问 `__pilot` 看引擎内部状态。
