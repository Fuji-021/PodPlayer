<p align="center">
  <h1 align="center">PodPlayer</h1>
  <p align="center">一个为自己打造的桌面播客客户端 · <em>DESIGN BY FUJII</em></p>
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue">
  <img alt="electron" src="https://img.shields.io/badge/Electron-13-47848F?logo=electron&logoColor=white">
  <img alt="vue" src="https://img.shields.io/badge/Vue-2-42b883?logo=vuedotjs&logoColor=white">
  <img alt="source license" src="https://img.shields.io/badge/source%20license-MIT-green">
</p>

PodPlayer 是一个深度改造的个人自用桌面播客客户端——由一个开源网易云音乐播放器改造而来，聚焦「订阅 / 收听 / 管理」播客，定位类似桌面版小宇宙 / Apple Podcasts。

> 这是个人项目，按自己的使用习惯打磨，不保证通用性。欢迎 fork 自用。

---

## 目录

- [特性](#特性)
- [技术栈](#技术栈)
- [开发与运行](#开发与运行)
- [多实例隔离](#多实例隔离)
- [键盘快捷键](#键盘快捷键)
- [本地转文字稿](#本地转文字稿)
- [NAS 就近音源（可选）](#nas-就近音源可选)
- [数据与备份](#数据与备份)
- [打包](#打包)
- [常见问题](#常见问题)
- [致谢](#致谢)
- [许可](#许可)

---

## 特性

- **播客订阅**：粘贴 RSS 链接订阅；OPML 批量导入 / 导出。
- **我的订阅 / 发现页**：我的订阅默认进入按发布时间聚合的更新流，支持节目快速筛选、全部 / 未听完筛选、稳定虚拟列表和回到顶部；完整节目网格仍作为二级管理页保留。发现页提供热门排行 / 新上线 / 播客寻宝 / 为你推荐。数据源含 xyzrank 与 Apple 中国区官方榜，多级 feedUrl 解析逐源验证、自动找到可用订阅源。
- **单集详情页**：富文本简介，续播 / 从头 / 已听完状态一目了然。
- **收听进度自动保存**：关掉再开从上次位置继续；听完自动归零、再点从头播。
- **真实收听统计**：按「天 × 节目」聚合收听时长，统计页可视化（最近一周 / 全部两种范围）+ 排行重排动画，可在设置页导出为 CSV / JSON。
- **单集下载与离线播放**：本地保存离线可听；下载页显示总存储占用；可选「听完自动清理已下载文件」。
- **本地转文字稿（Windows x64）**：用 SenseVoiceSmall 在本机生成带时间戳的逐段文稿，支持取消、续转、删除、导出、词典纠错、拼音归一与段落重组；长文稿使用虚拟列表。
- **可选联网 AI 层**：仅在用户配置兼容 OpenAI 的服务并明确点击后联网。可做保守的段内词汇精修，也可手动生成当前单集总结；音频不会上传，原始转写与本地规则优化层始终保留，可随时切回。
- **多级缓存**：封面、发现榜单、节目详情持久化缓存，单集音频按听满时长自动缓存（体积 LRU + TTL 淘汰）——点开秒显、再听省流量。
- **NAS 就近流式音源（可选）**：接入 [Audiobookshelf](https://www.audiobookshelf.org/)，把已归档单集放在局域网 NAS 上就近流式播放；三级音源「本地下载 → NAS → 原始 CDN」自动回落，默认关闭、零耦合，NAS 故障不影响在线播放，中途掉线自动切回 CDN 续播。
- **睡眠定时器**：X 分钟后 / 本集结束后自动暂停，播放条与沉浸式播放页两端一致。
- **倍速播放**：0.5–3 倍滑条无级调节（步进 0.1），两端一致。
- **沉浸式播放页**：点播放条展开全屏，封面三色渐变背景 + 进度刻度 + 标记打点；已有文稿的播客可点击封面开关背景式跟随文稿。
- **快捷键与物理媒体键**：快进 30 秒 / 快退 15 秒 / 收藏单集 / 播放暂停 / 音量 / 显示隐藏窗口，本地 + 全局两套可改键，并注册键盘与耳机线控的物理媒体键。
- **桌面通知**：订阅成功、自动清理下载等关键操作有系统通知反馈。
- **主题与托盘**：浅色 / 深色主题自动切换，托盘图标主题可选。
- **多实例隔离**：正式版 / 开发版 / 测试床各自独立数据库，可同时运行、互不干扰。
- **本地数据自动备份**：订阅 / 进度 / 统计 / 收藏 / 下载记录定期落盘（含订阅 OPML），「空库不备份」防误覆盖。
- **两个隐藏彩蛋**：彩虹猫进度条（设置可开）；单集「标记此刻」标记数达到阈值后图标 / 进度条变色、彩虹流转。

## 技术栈

Vue 2（Options API） · Electron 13 · howler.js · Dexie / IndexedDB v16（含 transcripts / transcriptDict / transcriptAi / transcriptSummaries） · sherpa-onnx-node / SenseVoiceSmall · ffmpeg-static · Vuex · Vue Router（hash 模式）。

> 主进程随启动还带一个轻量 express 服务与网易云 API 兼容服务（上游遗留），各自占用端口——这也是下方多实例端口表里两列的来源。

## 开发与运行

> 需要 **Node 16** + **yarn**。本机系统 Node 若是更高版本，请用 nvm 切到 16 再安装依赖（老工具链在新 Node 下易编译失败）。

```sh
yarn install

# 复制环境变量文件（直接用默认值即可）
# PowerShell：Copy-Item .env.example .env
# macOS / Linux：cp .env.example .env
```

> `.env` 里的 last.fm / 网易云 API 相关变量是上游遗留，播客功能用不到、保持默认即可，无需填写。

```sh
# 开发版（dev 实例）—— Windows，已封装 Node16 + 端口清理 + electron:serve
scripts/start-dev.bat

# 或手动启动
yarn electron:serve
```

> 多 worktree 的 GUI 验收请先部署 `scripts/dev-launcher/`，再用其 source selector 固定目标 worktree、分支和完整 HEAD；不要以 `scripts/start-dev.bat` 作为跨 worktree 的验收入口。启动后的 `runtime-receipt.json` 是运行来源证据，不等同于 GUI 功能验收。

## 多实例隔离

用环境变量 `PODPLAYER_PROFILE` 驱动「身份 → 用户数据目录 → 数据库 → 端口」整套隔离，三个实例可同时运行、互不抢占同一个数据库：

| 实例 | `PODPLAYER_PROFILE` | app 名 / 用户数据目录 | 端口（neapi / express / devserver） |
| --- | --- | --- | --- |
| 正式版 | `prod`（默认） | `PodPlayer` | 10754 / 27232 / — |
| 开发版 | `dev` | `PodPlayerDev` | 10755 / 27233 / 20201 |
| 测试床 | `sandbox` | `PodPlayerSandbox` | 10756 / 27234 / 20202 |

启动脚本：`scripts/start-dev.bat`（开发版）、`scripts/start-sandbox.bat`（测试床）。脚本会按端口精确清理本实例残留进程、切到 Node 16、再 `yarn electron:serve`，绝不一锅端误杀其它实例。

> 注意：IndexedDB 按 origin（host + port）隔离，所以开发用 devserver 端口被锁死、被占即报错（不会悄悄换端口造成「数据丢失」的假象）。

## 键盘快捷键

每个动作有「本地（窗口聚焦时）」与「全局（任意前台）」两套默认键，均可在设置页改键；此外还注册了键盘 / 耳机线控的物理媒体键。

| 动作 | 本地默认键 | 全局默认键 |
| --- | --- | --- |
| 播放 / 暂停 | `Ctrl/Cmd + P` | `Alt + Ctrl/Cmd + P` |
| 快进 30 秒 | `Ctrl/Cmd + →` | `Alt + Ctrl/Cmd + →` |
| 快退 15 秒 | `Ctrl/Cmd + ←` | `Alt + Ctrl/Cmd + ←` |
| 增加音量 | `Ctrl/Cmd + ↑` | `Alt + Ctrl/Cmd + ↑` |
| 减少音量 | `Ctrl/Cmd + ↓` | `Alt + Ctrl/Cmd + ↓` |
| 收藏单集 | `Ctrl/Cmd + L` | `Alt + Ctrl/Cmd + L` |
| 隐藏 / 显示播放器 | `Ctrl/Cmd + M` | `Alt + Ctrl/Cmd + M` |

物理媒体键：`播放/暂停`、`下一首（快进）`、`上一首（快退）`——最小化到托盘或失焦时也能控制；若被其它播放器 / 系统先占则自动跳过。

## 本地转文字稿

PodPlayer 0.6.0 的本地 ASR 已在 **Windows x64** 验证。安装包不内置模型；第一次使用前，在设置页「本地转文字稿」手动点击「一键部署模型」，联网下载约 240 MB 的 SenseVoiceSmall 模型文件。部署模型不会自动生成文稿。

- **下载与完整性**：优先使用官方 HuggingFace；不可达时可回落到 `hf-mirror.com`。Silero VAD 来自 sherpa-onnx 官方 GitHub release。三个文件都必须通过固定 size + SHA256，ASR 首次使用前还会 deep verify；镜像不是信任根。
- **断点与并发**：模型下载支持 `.part` 续传、取消、多源 fallback 和跨实例安装锁。异常退出后可立即回收孤儿锁并继续下载。
- **音频前置条件**：ASR 只处理本地音频。单集详情页内如果对未下载单集明确点击转录按钮，会先下载该集，再加入单任务转录队列；不会批量下载历史单集。
- **文稿数据**：正文写到 `D:\MyYesPlayerMusic\PodPlayerData\<profile>\transcripts\<episode-sha1>\`，索引、词典、精修和本集总结写入当前 profile 的 Dexie。删除文稿会一并删除该集精修稿与总结，但不会删除音频；删除模型也不会删除既有文稿或音频。
- **联网 AI 边界**：模型部署与本地转写都不会调用联网 AI。精修和本集总结默认不运行，只有用户自行配置 key 并明确点击后，才会把该集文字稿发送到所配置的兼容 OpenAI endpoint；音频不会上传。远程 HTTP endpoint 会被拒绝，仅允许 HTTPS 或本机回环 HTTP。
- **平台边界**：macOS / Linux 客户端仍可构建和使用其它功能，但 0.6.0 不宣称本地 ASR 已在这些平台验证；设置页会把当前平台明确降级为不支持。

模型、原生运行时和 FFmpeg 适用各自许可证，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## NAS 就近音源（可选）

接入 [Audiobookshelf](https://www.audiobookshelf.org/)（ABS），把已归档单集放在局域网内的 NAS 上就近流式播放，更快、零公网流量。

- **三级音源自动回落**：本地下载 → NAS → 原始 CDN，任一级不可用自动落到下一级，中途掉线自动切回 CDN 续播。
- **默认关闭、零耦合**：在设置页「NAS 就近音源」开启；不开就完全不影响在线播放，NAS 故障也绝不拖累在线收听。
- **订阅自动托管（可选）**：新订阅的节目可自动在 NAS 上创建并开启自动下载；未连接 NAS 时此项无效，可随时关闭回退。
- **危险删档（默认关，双重保险）**：取消订阅满 7 天后从 NAS 删除该节目及下载文件——需同时打开设置项与内部 armed 开关才会真正执行。

## 数据与备份

- **数据库**：本地 IndexedDB（Dexie），按 profile 固定隔离在 `D:\MyYesPlayerMusic\PodPlayerData\PodPlayer*\` 下，不再依赖 `%APPDATA%`。
- **自动备份**：导出为全保真 JSON + 订阅 OPML，落在当前 profile 的 `backups\` 下，保留最近 3 份；为瘦身不含 `episodes` 全表（可由 OPML 重订阅重抓）。备份包含文稿索引、词典、AI 精修层和本集总结，但文稿正文仍保留在 profile 的 `transcripts\`。内置「空库不备份」安全阀，避免清空事故后用空数据覆盖历史好备份。
- **导出收听数据**：设置页可把收听进度 / 统计 / 每日记录导出为 CSV（Excel 可读）或 JSON（完整备份），用于数据分析或迁移。
- **日志**：出问题时排查用，落在用户数据目录的 `logs\main.log`。

## 打包

```sh
yarn electron:build-win    # Windows（portable 免安装 + nsis 安装包）
yarn electron:build-mac    # macOS（dmg）
yarn electron:build-linux  # Linux（AppImage / deb / rpm 等）
```

打包产物在 `dist_electron/` 目录下。

> 0.6.0 的本地 ASR 发布验证范围是 Windows x64。其它平台构建不应因 ASR 缺失而阻止应用启动，但不提供已验证的本地转录承诺。Windows 安装包当前未做 Authenticode 签名，首次运行可能显示 SmartScreen 提示。

## 常见问题

- **启动后「数据没了」？** 多半是开发 devserver 端口被残留进程占用导致换了端口（IndexedDB 按端口隔离）。先用启动脚本清理端口残留再启动，数据会回来。
- **启动时弹防火墙询问？** 因本机起了回环服务（neapi / express）。本机回环即可，允许 / 取消都不影响使用。
- **必须 Node 16 吗？** 是。系统若装了更高版本 Node，请用 nvm 切到 16 再 `yarn install`，否则原生模块可能编译失败。
- **模型部署会自动转写或调用 AI 吗？** 不会。部署只下载并校验模型；转写和 DeepSeek 精修都必须分别由用户明确点击。
- **为什么未下载单集点转录后出现下载任务？** 本地 ASR 需要本地音频。节目详情列表里的转录按钮采用「明确点击即先下载、完成后转录」；普通文稿面板会提示先下载。
- **能和原网易云音乐播放器版同时开吗？** 能。PodPlayer 用独立应用身份 / 数据目录 / 端口，与它互不干扰。

## 致谢

- 由一个开源的网易云音乐播放器深度改造而来；上游版权与许可见 [LICENSE](./LICENSE)。
- NAS 就近音源对接 [Audiobookshelf](https://www.audiobookshelf.org/)。
- 本地转写使用 SenseVoiceSmall、sherpa-onnx、Silero VAD 与 FFmpeg；来源和归属见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 许可

PodPlayer 源码采用 [MIT License](./LICENSE)。安装包内的 sherpa-onnx、FFmpeg 等运行时，以及应用下载的 SenseVoiceSmall / Silero VAD 模型，分别适用其自身许可证与归属要求；完整说明和固定许可证快照见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

仅供个人学习研究与自用，请勿用于商业及非法用途。
