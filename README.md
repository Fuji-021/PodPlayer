<p align="center">
  <h1 align="center">PodPlayer</h1>
  <p align="center">一个为自己打造的桌面播客客户端 · <em>DESIGN BY FUJII</em></p>
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue">
  <img alt="electron" src="https://img.shields.io/badge/Electron-13-47848F?logo=electron&logoColor=white">
  <img alt="vue" src="https://img.shields.io/badge/Vue-2-42b883?logo=vuedotjs&logoColor=white">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="based on" src="https://img.shields.io/badge/based%20on-YesPlayMusic-c5283d">
</p>

PodPlayer 是基于 [YesPlayMusic](https://github.com/qier222/YesPlayMusic) 深度改造的个人自用桌面播客客户端——把一个网易云音乐播放器，改造成专注「订阅 / 收听 / 管理」播客的工具，定位类似桌面版小宇宙 / Apple Podcasts。

> 这是个人项目，按自己的使用习惯打磨，不保证通用性。欢迎 fork 自用。

---

## 目录

- [特性](#特性)
- [技术栈](#技术栈)
- [开发与运行](#开发与运行)
- [多实例隔离](#多实例隔离)
- [键盘快捷键](#键盘快捷键)
- [NAS 就近音源（可选）](#nas-就近音源可选)
- [数据与备份](#数据与备份)
- [打包](#打包)
- [常见问题](#常见问题)
- [致谢](#致谢)
- [许可](#许可)

---

## 特性

- **播客订阅**：粘贴 RSS 链接订阅；OPML 批量导入 / 导出。
- **我的订阅 / 发现页**：本地订阅管理 + 发现页（热门排行 / 新上线 / 播客寻宝 / 为你推荐）。数据源含 xyzrank 与 Apple 中国区官方榜，多级 feedUrl 解析逐源验证、自动找到可用订阅源。
- **单集详情页**：富文本简介，续播 / 从头 / 已听完状态一目了然。
- **收听进度自动保存**：关掉再开从上次位置继续；听完自动归零、再点从头播。
- **真实收听统计**：按「天 × 节目」聚合收听时长，统计页可视化（最近一周 / 全部两种范围）+ 排行重排动画，可在设置页导出为 CSV / JSON。
- **单集下载与离线播放**：本地保存离线可听；下载页显示总存储占用；可选「听完自动清理已下载文件」。
- **多级缓存**：封面、发现榜单、节目详情持久化缓存，单集音频按听满时长自动缓存（体积 LRU + TTL 淘汰）——点开秒显、再听省流量。
- **NAS 就近流式音源（可选）**：接入 [Audiobookshelf](https://www.audiobookshelf.org/)，把已归档单集放在局域网 NAS 上就近流式播放；三级音源「本地下载 → NAS → 原始 CDN」自动回落，默认关闭、零耦合，NAS 故障不影响在线播放，中途掉线自动切回 CDN 续播。
- **睡眠定时器**：X 分钟后 / 本集结束后自动暂停，播放条与沉浸式播放页两端一致。
- **倍速播放**：0.5–3 倍滑条无级调节（步进 0.1），两端一致。
- **沉浸式播放页**：点播放条展开全屏，封面三色渐变背景 + 进度刻度 + 标记打点。
- **快捷键与物理媒体键**：快进 30 秒 / 快退 15 秒 / 收藏单集 / 播放暂停 / 音量 / 显示隐藏窗口，本地 + 全局两套可改键，并注册键盘与耳机线控的物理媒体键。
- **桌面通知**：订阅成功、自动清理下载等关键操作有系统通知反馈。
- **主题与托盘**：浅色 / 深色主题自动切换，托盘图标主题可选。
- **多实例隔离**：正式版 / 开发版 / 测试床各自独立数据库，可同时运行、互不干扰。
- **本地数据自动备份**：订阅 / 进度 / 统计 / 收藏 / 下载记录定期落盘（含订阅 OPML），「空库不备份」防误覆盖。
- **两个隐藏彩蛋**：彩虹猫进度条（设置可开）；单集「标记此刻」标记数达到阈值后图标 / 进度条变色、彩虹流转。

## 技术栈

Vue 2（Options API） · Electron 13 · howler.js · Dexie / IndexedDB（podcasts / episodes / episodeProgress / 收听统计 / 下载 / 缓存 等多张播客表，schema 随功能持续演进） · Vuex · Vue Router（hash 模式）。

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

## NAS 就近音源（可选）

接入 [Audiobookshelf](https://www.audiobookshelf.org/)（ABS），把已归档单集放在局域网内的 NAS 上就近流式播放，更快、零公网流量。

- **三级音源自动回落**：本地下载 → NAS → 原始 CDN，任一级不可用自动落到下一级，中途掉线自动切回 CDN 续播。
- **默认关闭、零耦合**：在设置页「NAS 就近音源」开启；不开就完全不影响在线播放，NAS 故障也绝不拖累在线收听。
- **订阅自动托管（可选）**：新订阅的节目可自动在 NAS 上创建并开启自动下载；未连接 NAS 时此项无效，可随时关闭回退。
- **危险删档（默认关，双重保险）**：取消订阅满 7 天后从 NAS 删除该节目及下载文件——需同时打开设置项与内部 armed 开关才会真正执行。

## 数据与备份

- **数据库**：本地 IndexedDB（Dexie），按实例隔离在各自的用户数据目录下（如 `%APPDATA%\PodPlayerDev\IndexedDB\…`）。
- **自动备份**：导出为全保真 JSON + 订阅 OPML，落在用户数据目录的 `backups\` 下，保留最近 3 份；为瘦身不含 `episodes` 全表（可由 OPML 重订阅重抓）。内置「空库不备份」安全阀，避免清空事故后用空数据覆盖历史好备份。
- **导出收听数据**：设置页可把收听进度 / 统计 / 每日记录导出为 CSV（Excel 可读）或 JSON（完整备份），用于数据分析或迁移。
- **日志**：出问题时排查用，落在用户数据目录的 `logs\main.log`。

## 打包

```sh
yarn electron:build-win    # Windows（portable 免安装 + nsis 安装包）
yarn electron:build-mac    # macOS（dmg）
yarn electron:build-linux  # Linux（AppImage / deb / rpm 等）
```

打包产物在 `dist_electron/` 目录下。

## 常见问题

- **启动后「数据没了」？** 多半是开发 devserver 端口被残留进程占用导致换了端口（IndexedDB 按端口隔离）。先用启动脚本清理端口残留再启动，数据会回来。
- **启动时弹防火墙询问？** 因本机起了回环服务（neapi / express）。本机回环即可，允许 / 取消都不影响使用。
- **必须 Node 16 吗？** 是。系统若装了更高版本 Node，请用 nvm 切到 16 再 `yarn install`，否则原生模块可能编译失败。
- **能和网易云版 YesPlayMusic 同时开吗？** 能。PodPlayer 用独立应用身份 / 数据目录 / 端口，与上游正式版互不干扰。

## 致谢

- 基于 [qier222/YesPlayMusic](https://github.com/qier222/YesPlayMusic)。
- NAS 就近音源对接 [Audiobookshelf](https://www.audiobookshelf.org/)。

## 许可

沿用上游 [MIT License](https://opensource.org/licenses/MIT)。仅供个人学习研究与自用，请勿用于商业及非法用途。
