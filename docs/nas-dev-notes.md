# NAS 音源接入 — 实施笔记（feature/nas-source 分支内）

> 配套用户方案 `docs/NAS音源方案-飞牛OS.md`。本文件是**实现侧**笔记：P1 spike 实测事实 + 工程纪律。**仅存在于 feature/nas-source 分支，验收全过才随特性合并。**

## 0. 工程纪律（硬性，全程遵守）

**禁碰清单**（这些一行不动，违反即回退）：
- `downloads.js` 及下载 IPC、`refreshAllSubscriptions`、统计页/动画、睡眠定时器；
- `_getAudioSource` 的 ①pathMap本地 / ③CDN 两级原文逻辑（NAS 只作②级插入其间）；
- 任何与 NAS 无关的现有行为。

**默认 OFF 双保险**：未配置 NAS 地址 = ②级代码路径不激活（代码级）；设置开关默认关（配置级）。合并后不开开关 = 等于没合并。

**回归红线**：每阶段在 **NAS 关闭态**跑一遍核心回归（在线播/已下载播/下载新集/进度恢复/统计 tick/睡眠/切集续播）证明"未启用=现状"，再 NAS 开启态跑一遍。

**Token 安全**：ABS API token **绝不入 git / 不写入任何受版本控制文件**；运行期存主进程 electron-store（userData，天然在 repo 外）。本文件不含 token。

## 1. P1 Spike 实测事实（2026-06-13，真机真 NAS，curl 实测）

- **ABS**：`http://192.168.2.108:13378`（根路径直连即通；`/audiobookshelf` 子路径亦通——用根路径）。库 id `c4379a59-72a4-4b8f-8f89-5170602f8469`（name=podcast，36 档）。
- **鉴权**：`Authorization: Bearer <token>`（API 调用，主进程用）；**`?token=<token>` query 参数同样有效**（媒体流用 → 渲染端 howler/html5 audio 可直接播，无需设 header）。
- **映射链（全部实测打通）**：
  1. `GET /api/libraries/{lib}/items?limit=200` → 每项 `media.metadata.feedUrl` = **app 的 `podcast.id`（订阅 feedUrl）**，`it.id` = ABS itemId。建 `feedUrl → itemId` 映射（容错：normalize http/https、去尾斜杠）。
  2. `GET /api/items/{itemId}?expanded=1` → `media.episodes[]`，每集含 `guid`（= app RSS guid，如 `xmly_track_982989431`）、`enclosure.url`（= app `episode.audioUrl`）、`audioTrack.contentUrl`、`audioTrack.ino`。建 `guid → ino`（首选 guid 匹配；兜底 enclosure.url 全等）。
  3. **流 URL** = `{base}/api/items/{itemId}/file/{ino}`，加 `?token=` 即可播。
- **Range/seek 实测**：`Range: bytes=0-1023` → `206 Partial Content` + `Accept-Ranges: bytes` + `Content-Range: …/37280635` + `Content-Type: audio/mp4`；中段 `Range: bytes=1000000-1000999` → `206`。**拖动/seek 原生支持**（优于部分播客 CDN）。
- **app 侧 track 已具备匹配所需**：`track.podcastId`(=feedUrl)、`track.podcastEpisodeId`(=`feedUrl::guid` → `.split('::').pop()` 取 guid)、`track.podcastAudioUrl`(=enclosure 原直链)。

## 2. 注入点（唯一硬改现有代码处，已读码核对）

`Player.js _getAudioSource(track)`（master @ :652-679）播客分支现状：①`pathMap[podcastEpisodeId]`→`file:///` → ③`return track.podcastAudioUrl`。NAS 作②级插其间（分支改 `async`，其余分支字节级不变）：
```
① pathMap 命中 → file:///         （原样，最高优先级）
② nasEnabled() && nasAlive → resolveNasUrl(track)（含缓存/超时，失败/不可用返回 null）→ 命中则用
③ return track.podcastAudioUrl     （原样，CDN 兜底）
```

## 3. 模块（全新文件，除注入点 + 设置页外不改既有文件）

| 模块 | 进程 | 职责 |
|---|---|---|
| `electron/nasBridge.js` | 主 | 持 NAS 地址+token（electron-store，gitignore）；IPC：`nas:probe`(健康)、`nas:items`(列库映射)、`nas:episodes`(单档 guid→ino)、`nas:streamUrl`(拼流URL)。主进程 axios，规避渲染端代理拦截。 |
| `utils/podcast/nasSource.js` | 渲染 | `resolveNasUrl(track)`：熔断短路→Dexie 缓存(episodeId→{nasUrl,ts} TTL7d)→IPC 解析→落缓存；`prefetchPodcast(feedUrl)`(进详情页预取整档 guid→ino，对应用户"无感整档拉取"诉求) |
| 设置页区块 | 渲染 | 开关(默认关)+地址+token+测试连接+状态点(绿/灰/红) |

## 4. 熔断器（低耦合核心）

内存 `nasAlive`：启动探一次 + 5min 心跳 + 播放前距上次探 >30s 再探；**单次超时 800ms**；`nasAlive=false` → `resolveNasUrl` **同步返回 null**（零等待直落 CDN）。探测不只看 `/healthcheck`（§九事故：ABS 可 200 健康但下载子系统冻结）；取流后对"数据是否真在动"设超时（断联语义表"播放中途掉线"行）。

## 5. R1 待 P1 接 howler 时实测

渲染端 Chromium（若挂 Clash TUN）能否直连 `192.168.2.108`：curl `--noproxy` 直连已通；渲染端待实测。**若被代理/鉴权挡** → 走**本地反代**：在现有 `127.0.0.1:27233` express（已引 `express-http-proxy`）加 `/nas-stream` 路由，主进程带 token 反代 NAS、howler 播 `http://127.0.0.1:27233/nas-stream/...`（localhost 绕代理、无 CORS、token 服务端持有、Range 透传）。

## 6. 阶段（每段独立可验，出口不满足不进下一段）

- **P1** 解析链 + 熔断 + ②级注入（~150 行 / +反代 ~40）→ 断联语义表前 4 行过。
- **P2** 设置页（~80 行）→ 配置→生效→关闭→回现状，全程无重启。
- **P3** 中途断联：NAS 源 howler 错误 → CDN 重建 + seek 续播（~60 行，**仅 NAS 源激活**）→ 播放中停 ABS，5s 内续播、进度误差 <2s。
- **P4** 合并验收：禁碰清单 + 双态回归全过 → 合并 master，开关仍默认关。

## 7. UI：NAS 连接状态图标（用户 2026-06-13 规格，**功能跑通后再实现**）

- 图标：`router-wifi-alt.svg`（已拷入 `src/assets/icons/`，注意接入前确认其 path 用 `fill:currentColor` 才能随 `color` 变色）。
- 位置：播放条**标记(打点)键的右边**（Player.vue `.mark-control` 之后）。
- 三态（映射 nasSource 熔断状态 + 速度）：
  - **绿 + 缓慢闪动** = 连上 NAS 且在线（`nasAlive=true` 且正常速度）；
  - **黄 + 闪动** = 连上但慢（探测/取流偏慢，阈值待定）；
  - **红 + 不动** = 断联（`nasAlive=false`）。
- **功能开关(总开关)**：用户尚未决定要不要做，**先记着**，不急。
- 现状：P1 测试期用**临时 toast**「🛜 本集音源：NAS」(Player.js ②级) + `window.podNas` 控制台入口替代可视化；二者在图标接入时一并删除。

## 8. P1 临时调试物（接 UI 时清理）

- `Player.js` ②级命中 NAS 的 `showToast('🛜 本集音源：NAS')`——临时，删。
- `main.js` 的 `window.podNas`（setConfig/test/status/getConfig）——P2 设置页接管后删。
- `nas-config.json`（userData，非 repo）——用户配置，不删。

## 9. 概念澄清（给用户理解，决定后续功能的基础）

- **现在是"流式播放(streaming)"，不是下载**：播 NAS 单集时，howler 通过 HTTP Range **边播边拉**(从 NAS)，**本地一个字节都不存**。所以 **NAS 播放完全不增加本地存储负担**，"听完即弃"无需做(根本没存)。
- 与现有「下载」的区别：现有「下载」功能是把 CDN 音频**存到本地磁盘**(file://，离线可听)——那是另一条链，不变。NAS 是第三种来源：**就近流式、不落盘**。
- "托管(hosting)"指**NAS(ABS) 在帮你下载并保存**节目(归档)；app 只是**按需流式取用**。所以存储压力在 NAS 侧，PC 侧零增加。
- **三级音源现状**：① 本地已下载(file://) → ② NAS 流式(就近) → ③ 原始 CDN(在线)。播一集时按此序，命中即用、不可用自动落下一级。

## 10. 用户 7 点诉求 × 方案对照 + 决议（feature/nas-source 分支 TODO，**勿带回 master 重溯**）

> 本节为分支内规划，记录已做/待做与设计取舍。合并 master 时只带代码，本规划保留在分支笔记。

| # | 诉求 | 方案文档是否提及 | 现状/决议 |
|---|---|---|---|
| 0 | navbar NAS 状态图标(头像左) | §3.3 状态点(原在设置页) | ✅ **本轮已做**(绿呼吸/红静止/点击重连)。黄=慢、长断联换图标=待做(见#7) |
| 1 | 原则：用 NAS 价值 + 更丝滑 | §六 收益 | 原则，非功能。已贯彻(就近流式) |
| 2 | 「我的NAS」栏(NAS 有、订阅无的节目) | 未提及(新) | **TODO·中**。读 ABS items 过滤掉已订阅 feedUrl → 我的订阅页下方新栏目；连上才显示、无则隐藏。难点：这类节目本地无 episode 记录，播放需用 ABS episodes 现构 track(无 CDN 兜底)。设计后再做 |
| 3 | 首页 NAS 来源 | §一 总架构(原想全托管) | 用户改主意：暂不做、留接口。现状解析链已是"接口"(任意已播单集都会 NAS 优先)。首页"NAS 来源板块"**留 TODO·低**，要做也与现有分类隔离 |
| 4 | 状态点表"该节目/单集 NAS 上有"，呼吸、与右上图标同步 | 未提及(新) | **TODO·中高(需设计)**。难点:现有订阅页状态点语义=来源(手动/发现)，**单一圆点别塞两义**。建议:NAS-在档用**独立小标识**(如小 wifi 点)而非复用来源点，避免语义冲突;单集级状态点是全新(现无)。先出设计再做 |
| 5 | 流式 vs 本地存储/听完即弃 | §六 "重听零流量" | **已澄清(§9)**:现在就是流式、不落盘、零本地负担 → **听完即弃无需做**。无功能待做 |
| 6 | NAS 收听纳入统计 + 下载 + 收藏 | 未明说 | 统计/收藏**已天然兼容**(都按 episodeId 走，与音源无关，NAS 收听已计入 tick)。**下载**目前从 CDN 拉;"**从 NAS 下载**(局域网更快)"=**TODO·低**(增强,非必需) |
| 7 | 断连重连开关 + 原因提示 + 长断联换 wifi-password 图标 + 是否常驻 | §3.5 断联语义 | 部分:**点图标手动重连已做**。自动重试/原因提示/`wifi-password.svg`(已备否?待拷)/常驻决策=**TODO·中**。另 P3「播放中途掉线自动续 CDN」仍未做(方案 §3.5) |

**本分支 TODO 汇总(优先级)**：
- **P2** 设置页 NAS 区块(开关/地址/token/测试/状态点) — 替代 `window.podNas` 临时入口。**高**。
- **P3** 播放中途 NAS 掉线 → CDN 重建 + seek 续播(仅 NAS 源激活)。**高**(目前缺它，中途掉线会卡)。
- 状态图标黄(慢)态 + 长断联换 `wifi-password.svg` + 自动重试/原因(#7)。**中**。
- 「我的NAS」栏目(#2) / 单集·节目 NAS-在档标识(#4，需设计)。**中**。
- 从 NAS 下载(#6 增强) / 首页 NAS 板块(#3，留接口)。**低**。
- 清理临时物(toast / window.podNas)——随 P2 状态图标/设置页落地一并删。
