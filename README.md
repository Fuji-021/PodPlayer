<p align="center">
  <h1 align="center">PodPlayer</h1>
  <p align="center">一个为自己打造的桌面播客客户端 · <em>DESIGN BY FUJII</em></p>
</p>

PodPlayer 是基于 [YesPlayMusic](https://github.com/qier222/YesPlayMusic) 深度改造的**个人自用桌面播客客户端**——把一个网易云音乐播放器，改造成专注「订阅 / 收听 / 管理」播客的工具。

> ⚠️ 这是个人项目，按自己的使用习惯打磨，不保证通用性。欢迎 fork 自用。

## ✨ 特性

- 🎙️ **播客订阅**：粘贴 RSS 链接订阅；OPML 批量导入 / 导出
- 📚 **我的订阅 / 发现页**：本地订阅管理 + 热门榜单 / 资源池发现
- ⏯️ **收听进度自动保存**：关掉再开从上次位置继续，同集不打断
- 📊 **真实收听统计**：按「天 × 节目」聚合收听时长 + 排行 + 统计页可视化
- ⬇️ **单集下载 → 离线播放**：本地保存，离线可听
- 🛜 **NAS 就近流式音源（可选）**：接入 [Audiobookshelf](https://www.audiobookshelf.org/)，局域网就近流式播放；三级音源「本地下载 → NAS → 原始 CDN」自动回落；**默认关闭、零耦合**，NAS 故障绝不影响在线播放，中途掉线自动切回 CDN 续播
- 🌙 睡眠定时器、倍速播放、播客化全局快捷键（快进 / 快退 / 收藏单集）
- 🌈 彩虹猫进度条彩蛋
- 🌗 浅色 / 深色主题自动切换
- 🧱 **多实例隔离**：正式版 / 开发版 / 测试床各自独立数据库，可同时运行、互不干扰
- 💾 **本地数据自动备份**：订阅 / 进度 / 统计 / 收藏定期落盘，防意外丢失

## 🧰 技术栈

Vue 2（Options API） · Electron 13 · howler.js · Dexie / IndexedDB · Vuex · Vue Router（hash 模式）

## 🚀 开发与运行

> 需要 **Node 16** + **yarn**。

```sh
yarn install
cp .env.example .env

# 开发版（dev 实例）—— Windows，已封装 Node16 + 端口清理 + electron:serve
scripts/start-dev.bat

# 或手动启动
yarn electron:serve
```

### 多实例隔离

用环境变量 `PODPLAYER_PROFILE` 驱动「身份 → 用户数据目录 → 数据库 → 端口」整套隔离，三个实例可同时运行、互不抢占同一个数据库：

| 实例 | `PODPLAYER_PROFILE` | app 名 / 用户数据目录 | 端口（neapi / express / devserver） |
| --- | --- | --- | --- |
| 正式版 | `prod`（默认） | `PodPlayer` | 10754 / 27232 / — |
| 开发版 | `dev` | `PodPlayerDev` | 10755 / 27233 / 20201 |
| 测试床 | `sandbox` | `PodPlayerSandbox` | 10756 / 27234 / 20202 |

启动脚本：`scripts/start-dev.bat`（开发版）、`scripts/start-sandbox.bat`（测试床）。

## 📦 打包

```sh
yarn electron:build-win    # Windows
yarn electron:build-mac    # macOS
yarn electron:build-linux  # Linux
```

打包产物在 `dist_electron/` 目录下。

## 🙏 致谢

- 基于 [qier222/YesPlayMusic](https://github.com/qier222/YesPlayMusic)。
- NAS 就近音源对接 [Audiobookshelf](https://www.audiobookshelf.org/)。

## 📜 许可

沿用上游 [MIT License](https://opensource.org/licenses/MIT)。仅供个人学习研究与自用，请勿用于商业及非法用途。
