# PodPlayer NAS 就近音源 + 订阅托管 · 总文档

> **本文档是 NAS 功能的唯一权威文档**，由 5 份历史文档合并去重而成（2026-06-20）：
> `NAS音源方案-飞牛OS.md`（音源架构+实测）、`NAS订阅托管方案.md`（托管权威设计）、`NAS订阅托管-P1规格.md`（P1 实现规格）、`NAS订阅托管-执行提示词.md`（落地提示词）、`nas-dev-notes.md`（开发笔记+各轮进展）。
>
> **统一口径（2026-06-16 拍板）**：**「6 个月未听冷藏」已彻底砍掉**。容量只靠 ① 平时全留 ② 取消订阅移除 ③ NAS 端看门狗按容量驱逐。下文凡涉及历史"冷藏/coldStore"均标注【已砍】仅作决策留痕。
>
> **⏸️ 当前状态（2026-06-20）**：用户**搁置 NAS 功能**（觉得还不完善）。已落地的修复保留；不主动推进新开发，除非用户重启。

---

## 一、概述与硬约束

- **是什么**：NAS（飞牛 fnOS）上跑 Audiobookshelf(ABS) 归档播客 → PodPlayer 局域网就近流式播放 + 订阅时自动交 NAS 托管下载。
- **用户约束（硬性）**：仅局域网用（在外用小宇宙，无移动端计划）；NAS=`192.168.2.108`（fnOS，Web 5666）；ABS 端口 `13378`；盘 900G、播客配额早期 400G/后期 cap 500G。
- **低耦合铁律**：NAS 断网/断电/服务挂掉时，**体验必须等于没有 NAS 的今天**，绝不"这里挂了全部挂"。最坏可整体回溯。
- **默认 OFF 双保险**：未配置地址=代码路径不激活；设置开关默认关。合并后不开开关=等于没合并。

---

## 二、总架构：两个独立系统 + 一条可熔断的薄胶水

```
┌─ NAS 侧（独立运行，app 不依赖）──────────────┐
│ fnOS Docker → Audiobookshelf(ABS)            │
│ 订阅托管 → 自动下载最近 N 期 + 24h 追新       │
│ 产出：纯 m4a/mp3 文件目录 + HTTP 流式 API     │
│ + abs-watchdog 容器（卡死重启 + 容量驱逐）    │
└──────────────────────────────────────────────┘
                 ↑ 唯一交点（可熔断）
┌─ App 侧（现有系统，行为不变）─────────────────┐
│ _getAudioSource 三级解析链：                  │
│ ① 本地已下载(pathMap→file://)  ←现状，不动    │
│ ② NAS 命中(探测+映射，超时即跳过) ←唯一新增级 │
│ ③ 原始 CDN(podcastAudioUrl)    ←现状，不动    │
└──────────────────────────────────────────────┘
```

解耦三重保证：(a) ABS 是现成开源软件、与 app 零代码耦合，归档以纯文件存在（ABS 挂了文件还在、可 SMB 访问）；(b) app 只插一级解析，前后两级是今天的现状；(c) 开关默认关，未配置时新路径完全不激活。

**概念澄清（流式 ≠ 下载）**：播 NAS 单集时 howler 通过 HTTP Range 边播边拉、**本地零落盘** → NAS 播放不增加本地存储、"听完即弃"无需做。现有「下载」是把 CDN 存本地(file://)的另一条链，不变。"托管"= NAS(ABS) 帮你下载保存，app 只按需流式取用，存储压力在 NAS 侧。

---

## 三、App 侧实现

### 3.1 注入点（唯一硬改现有代码处）

`Player.js _getAudioSource(track)` 播客分支，NAS 作②级插入（分支改 `async`，①③字节不变）：
```
① pathMap 命中 → file:///                         （原样，最高优先级）
② nasEnabled() && nasAlive → resolveNasUrl(track)  （含缓存/超时，失败/不可用返回 null）
③ return track.podcastAudioUrl                     （原样，CDN 兜底）
```

### 3.2 模块

| 模块 | 进程 | 职责 |
|---|---|---|
| `electron/nasBridge.js` | 主 | 持 NAS 地址+token（electron-store @ userData，**不入 git**）；多档 profiles；全套 `nas:*` IPC。主进程 axios 规避渲染端代理拦截。**本文件禁可选链 `?.`/`??`，用 `&&` 守卫**。 |
| `utils/podcast/nasSource.js` | 渲染 | `resolveNasUrl(track)` 熔断短路→IPC 解析；`reconcileNas()` 对账；状态/配置 API。 |
| `settings.vue` NAS 区块 | 渲染 | 总开关 + 多档管理（地址/token/测试/发现库）+ 状态点。 |

### 3.3 熔断器（低耦合核心）

内存 `nasAlive`：启动探一次 + 5min 心跳 + 播放前距上次探 >30s 再探；**单次超时 800ms**；`nasAlive=false` → `resolveNasUrl` **同步返回 null**（零等待落 CDN），后台心跳恢复后自动回 NAS。探测**不只看 `/healthcheck`**（见运维事件①：ABS 可 200 健康但下载子系统冻结）。

### 3.4 episode → NAS 文件映射（可靠性关键，全部实测打通）

**不猜文件名**，走 ABS API：
1. `GET /api/libraries/{lib}/items?limit=N&page=P`（分页拉全）→ `media.metadata.feedUrl` = app 的 `podcast.id`，`it.id` = ABS itemId。建 `feedUrl→itemId`（normFeed 归一化：去协议+去尾斜杠）。
2. `GET /api/items/{itemId}?expanded=1` → `media.episodes[]`，每集含 `guid`、`enclosure.url`、`audioFile.ino`、`publishedAt`、`audioFile.metadata.size`。
3. **流 URL** = `{base}/api/items/{itemId}/file/{ino}?token=<token>`（`?token=` query 即可播，howler/html5 audio 无需设 header）。

**三路匹配键**（`ensureEps` 建 byGuid/byUrl/byPub；`resolveStream` 与 wifi 标识同口径）：
- ① `guid`（首选）② `enclosure.url` 归一化 ③ `publishedAt` 时间戳（兜底）。
- **为何要三路**：软删+rescan 重建的集会丢 guid+enclosure、只剩 publishedAt（见 §九事故）；publishedAt 与 PodPlayer 单集 `pubTime=Date.parse(RSS pubDate)` 同毫秒值，精确匹配。
- **Range/seek 实测**：`Range: bytes=0-1023` → `206 Partial Content` + `Accept-Ranges: bytes`，拖动 seek 原生支持（优于部分播客 CDN）。

### 3.5 断联语义表（每种失败的行为，验收逐条过）

| 场景 | 行为 | 用户感知 |
|---|---|---|
| 未启用/未配置 | ②级不执行 | 与今天相同 |
| NAS 关机/断网（播放前） | 探测失败→nasAlive=false→落 CDN | 相同（仅首次探测多 ≤800ms）|
| 映射查不到该集 | resolve 返回 null→落 CDN | 无感 |
| **播放中途 NAS 掉线** | 看门狗（位置连续~3s 不前进）/loaderror → `_failoverNasToCdn()`：记 progress→markNasDown 熔断→CDN 重建 howler→seek 续播 | 短暂缓冲后续播，进度不丢 |
| token 失效/接口变动 | resolve 报错按"查不到"→落 CDN，状态点变红 | 无感 |
| NAS 恢复 | 心跳探活→下一集自动回 NAS | 无感 |

> 中途掉线续播**仅对 NAS 源激活**（CDN/本地源错误处理保持现状）。

### 3.6 渲染端直连备选（R1）

若渲染端 Chromium（挂 Clash TUN）直连 `192.168.2.108` 被代理/鉴权挡 → 走本地反代：现有 `127.0.0.1:27233` express 加 `/nas-stream` 路由，主进程带 token 反代 NAS、howler 播 localhost（绕代理、无 CORS、Range 透传）。当前直连可用，未启用反代。

---

## 四、订阅托管（订阅即下载 · 无感）

### 4.1 总流程

1. 用户订阅 → `service.js subscribeByRssUrl` 成功（本地 `subscribed:true` 入库）。
2. 成功后 **fire-and-forget** `handoffToNas(feedUrl,title)`（不阻塞订阅）：
   - 渲染端 `nasSource.handoffToNas`：`!isNasEnabled()||!nasAlive → {skipped}`；否则 invoke `nas:handoffSubscription`。
   - 主进程 `nasBridge.ensureManaged()`（handoff 与对账共用的收口函数）：`ready(c)` 短路 → `ensureItems` 查 feedUrl：**已存在** → `PATCH /api/items/{id}/media` 确保 `autoDownloadEpisodes:true + maxNewEpisodesToDownload:100 + maxEpisodesToKeep:100`（幂等）；**不存在** → `getFirstFolder` 取 `folders[0]` → `POST /api/podcasts` 创建 → `PATCH lastEpisodeCheck:1` + `GET /api/podcasts/{id}/checknew?limit=100` 触发回灌下载。
3. 渲染端按结果 toast：成功「已交给 NAS 下载」；无 NAS 静默；失败轻提示可重试。

> **关键坑（实测）**：`autoDownloadEpisodes:true` 只追"未来新集"、**不回填历史**。回灌历史必须 `PATCH lastEpisodeCheck=1`（回溯到 1970）+ `checknew?limit=100`（返回的集自动入队，无需再调 download-episodes）。这是早期"建档却 0 下载"的真因。

### 4.2 硬约束

- **无 NAS 优雅降级**：三层防线（渲染端短路→主进程 `ready()` 短路→全程 try/catch 不抛）；托管是订阅完成**之后**的旁路，失败/超时不影响本地订阅与播放。
- **幂等**：已在库的 feedUrl 不重复创建（ensureItems + normFeed），改走 PATCH。重复订阅安全。
- **OPML 批量节流**：`importOpmlText` 多次 handoff → `runLimited`（并发≤5）排队，避免灌爆 ABS。
- **folderId**：handoff 时 `GET /api/libraries/{lib}` 取 `folders[0]` 缓存。
- **开关**：settings「订阅时自动托管到 NAS」`nasHandoffEnabled` 默认开（`!==false`）。

### 4.3 取消订阅（联动移除 · 7 天宽限）

- 取消订阅 → 期望态转"移除" → 对账驱动 ABS 删整档（hard，真删文件），与"订阅=加"对称、取消即清。
- **7 天宽限防误删**：`deletePodcast` 写 `nasRemoveAt=Date.now()`；对账只对超 7 天的执行删除；期间重订阅清 `nasRemoveAt:null` 自动撤销。
- **谁跑这 7 天**：默认 = PodPlayer 对账（启动/每日/操作时）跑，时间戳存本地 IndexedDB。**若 7 天没开 PodPlayer，删除推迟到下次打开**（"≥7 天且下次打开时"删，非精确第 7 天）——无害（节目一直在 NAS、容量驱逐兜底防爆）。要"不依赖开软件按时删"可交看门狗打 tag（P3 增强，未做）。

---

## 五、声明式对账（生命周期一致性，应对断联）

> **本地订阅状态是唯一真相，NAS 在线时对账(reconcile) 把 ABS 逼近期望态**，而非"即时发命令"（断联会丢/冲突）。砍冷藏后只剩两态，模型很轻。

| 本地 `subscribed` | 期望 NAS 态 | 动作 |
|---|---|---|
| `true` | **托管** | ABS 没有→创建+autoDownload+下最近100；有但 autoDownload 关→PATCH 开 |
| `false`（已取消） | **移除** | 记 `nasRemoveAt`；7 天宽限到期→`DELETE /api/items/{id}?hard=1` 删整档 |

> 【已砍】历史曾设计第三态"冷藏"（6 个月没听→删单集留最近 1+收藏、关 autoDownload）。2026-06-16 砍掉：与"冗余多"矛盾、最复杂、与看门狗打架。容量回收全交看门狗，app 侧**不删单集**。

**对账触发**：启动就绪（`main.js initNas()` 后）/ 断线恢复（probe false→true）/ 每日（心跳内判 >24h，记 `nasLastReconcileAt`）/ 操作后即时（取消订阅）。断联跳过不丢（门禁 `ready()`/`ensureProbed()`，恢复后用当前真相重算、不靠命令队列）。

**对账分层**：渲染端 `reconcileNas()` 薄壳编排（所有 IndexedDB 读在渲染端）→ 派生期望态 → 按桶分别 invoke 主进程 `nas:ensureManaged`（幂等托管）/ `nas:removeItem`（移除整档）。`runLimited` 在 nasSource **自带私有副本**（避免 service→nasSource 反向 import 成环）。

**破坏性四闸（删整档缺一不删）**：① 7 天宽限（渲染端判）② feature flag `nasRemoveEnabled` 默认关（主进程 electron-store 也存一份独立判）③ 多设备 `scope==='local'` 才删 ④ dry-run gating `nasDestructiveArmed` 默认关 → 走 dry-run 只 log 不发 DELETE。本机实测确认后手动置 true 放量。

**新增 helper `authDelete(c,path)`**（照 authPost 形态，禁 `?.`）。

---

## 六、存储管理（容量驱逐 + 取消移除，**不做冷藏**）

> 目标平衡：**无感 + 常听冗余多 + 不爆盘 + 取消即清**。三条策略：

1. **平时不删、全留**：总量没到上限就什么都不动 → 冗余拉满。
2. **取消订阅 → 移除整档**（7 天宽限，§4.3）：PodPlayer 端驱动（看门狗不认订阅状态）。
3. **容量触顶 → 看门狗按全局最老驱逐**：NAS 端看门狗实现，硬上限防爆盘。

**与看门狗分工（无交集）**：看门狗=卡死重启 + 容量硬上限兜底（NAS 端常驻可靠）；PodPlayer=订阅托管 + 取消移除（按订阅态）。砍冷藏后 PodPlayer **不再主动关 autoDownload** → 与看门狗不打架。

**参数**：`STORAGE_CAP_GB` 按硬盘留余量；`KEEP_MIN_PER_PODCAST` 10~20。

---

## 七、多设备 + 首次连接差异对账

### 7.1 多设备共享同一 NAS（`nasDeviceScope`，默认 `local`）

| 场景 | `local`（仅本机） | `shared`（多设备共享） |
|---|---|---|
| 取消订阅 | 软删本地 + 宽限到期删 NAS 整档 | 软删本地，**NAS 不删**（别端可能还订阅）|
| 确保托管 | 照常 | 照常（幂等无害）|
| NAS 有我无 | 默认不动 + 可选提示导入 | 同左 |

> 多设备本质=NAS 是各端订阅的并集仓库。读靠并集导入（完美）；删在多端不该单机说了算 → `shared` 下 NAS 清理全交容量驱逐。"多设备也取消即清"需引用计数（留 P3）。

### 7.2 首次连接新 NAS（差异对账只管我订阅的，绝不碰未订阅内容）

| 差异 | 处理 |
|---|---|
| 我订阅 ∩ NAS 有 | 确保托管（PATCH autoDownload）|
| 我订阅 − NAS 没有 | 托管（POST 创建 + 下最近 100）|
| **NAS 有 − 我没订阅** | **默认不动**（不下/不删）；可选一次性提示「发现 N 档未订阅，是否导入?」，确认才导入 |

> 对账只遍历 `getAllPodcasts()`（本地真相），NAS 上我没有的不在循环里 → 声明式自然结论，天然不误伤。

---

## 八、ABS API 依据（已实测）

| 用途 | 接口 | 实测结论 |
|---|---|---|
| 列库/节目 | `GET /api/libraries` `…/{lib}/items?limit=&page=` | `media.metadata.{title,feedUrl}` 作映射键；分页拉全 |
| 单档详情 | `GET /api/items/{id}?expanded=1` | `media.episodes[]` 含 guid/enclosure/audioFile.ino/publishedAt/size |
| 设自动下载 | `PATCH /api/items/{id}/media` | 写 `lastEpisodeCheck`(置 1=回溯 1970 全量回灌)/`autoDownloadEpisodes`/`maxNewEpisodesToDownload`/`maxEpisodesToKeep` |
| 创建播客 | `POST /api/podcasts` | libraryId+folderId+path+media{feedUrl,…}；需 admin |
| 查/触发新集 | `GET /api/podcasts/{id}/checknew?limit=N` | 只查 `lastEpisodeCheck` 之后发布的集；返回的集**自动入队**，无需再调 download-episodes |
| 下载队列 | `GET /api/libraries/{lib}/episode-downloads` | currentDownload + queue；**队列是内存态，容器重启即清** |
| 删单集 | `DELETE /api/podcasts/{itemId}/episode/{epId}?hard=1` | 路由存在（`/api/items/{id}/episode/…` 不存在）；**默认软删只删 DB 记录，`?hard=1` 才删磁盘文件**（见 §九） |
| 删整档 | `DELETE /api/items/{id}?hard=1` | 删 library item；需 admin |
| 单档重扫 | `POST /api/items/{id}/scan` | 从磁盘文件重建 episode 记录（恢复软删，但丢 guid/enclosure）|
| 全库重扫 | `POST /api/libraries/{id}/scan` | 后台扫全部文件夹 |
| 权限 | — | 创建/删除需 admin、PATCH 需 update；只读 token 403 |

**鉴权**：API 用 `Authorization: Bearer <token>`；媒体流用 `?token=<token>` query 同样有效。**token 绝不入 git**，运行期存主进程 electron-store。

---

## 九、运维事件与事故（实测处理，是"app 必须熔断"的实证依据）

### ① 下载卡死 + watchdog 兜底（2026-06-13）

**现象**：`currentDownload` 卡在某集（喜马拉雅源）605 分钟不动，`startedAt` 恒 null。**根因**：ABS 播客下载单线程逐集、无硬超时；某集源"连上不吐数据"的半开连接 → 请求无限挂起 → 唯一下载槽被僵尸占死 → 全队列堵塞。软手段（UI 取消/clear-queue）全无效，只有重启进程能解。**恢复**：`docker restart` 清内存死锁+队列 → 逐档 `PATCH lastEpisodeCheck=1 + checknew` 精准补回。**落地兜底**：abs-watchdog（见 §十）。**对 app 的启示**：ABS 会"看似健康(200)、实则下载冻结"，故 app 熔断不能只看 `/healthcheck`，取流后还要对"数据是否真在动"设防（断联语义表"中途掉线"行）。

### ② 存储驱逐（2026-06-13）

用户诉求总量限 500G；ABS 只有"每档保留集数"无全库上限 → 并入看门狗外部管。每 item 自带 `size`，求和即总占用。删除接口安全探测坐实 `DELETE /api/podcasts/{itemId}/episode/{epId}` 路由存在、与 maxEpisodesToKeep 同机制。

### ③ 🚨 Btrfs 快照撑爆 + 软删事故（2026-06-19/20，最底层根因）

**事故链**：
1. **看门狗 DELETE 缺 `?hard=1` = 软删**：只删 ABS 数据库记录、不删磁盘文件。导致空间不释放、rescan 又复活、`item.size` 缓存不降。
2. **evict 用 item.size 缓存判 total → 永远"超限" → 每轮删到 FLOOR=10 → 全库削成每档 10 集**（=ABS/wifi 都只显示 10 集的根因）。
3. **Btrfs CoW 快照保留所有被删/被改数据块**：900GB 盘被快照逻辑撑到 5TB；删文件+清回收站空间不降（快照钉着旧块）；看门狗频繁删改 episode 加速快照膨胀 → 撑爆致 Docker 起不来。

**实测坐实**：rescan 一档 → numEp 10→288 复活（文件都在磁盘）；item.size 缓存 485GB vs libraryFiles 真实（软删态）；恢复后真实占用 586GB。

**处置**：
- 软件侧修复（master）：DELETE 加 `?hard=1` 真删；`check_storage` 用 libraryFiles 真实大小复核（不信 item.size 缓存）；wifi 标识/就近播放加 publishedAt 第三路兜底（修 rescan 重建集丢 guid/enclosure）。
- 数据恢复：全库 + 残档 rescan → 1377→9437 集，0 档卡 10。
- 止血：API 批量关 43 档 `autoDownloadEpisodes=False`（删的被当缺失集下回来、占用涨~38GB/h）；用户关 ABS 音频共享快照 + 删旧 snapshot + btrfs balance。
- 容量策略：用户定 `KEEP_PER_PODCAST=200 + TRIM_ENABLED=1`（dry-run 测 KEEP=100 删 6280/KEEP=200 删 4284），**但快照彻底解决前 trim 先别开**（删了被快照保留不释放）。

**教训**：① ABS 删集释放磁盘**必须 `?hard=1`**；② 判容量用 libraryFiles 真实大小、不用 item.size 缓存（删后不实时更新）；③ 软删+rescan 会永久丢 RSS 关联元数据（guid/enclosure），只能 publishedAt 兜底；④ **播客音频卷不该开 Btrfs 自动快照**（可重下、频繁增删=快照最坏负载）——config/metadata 小可低频快照，音频卷关快照或放独立不快照子卷。

---

## 十、NAS 端看门狗（abs-watchdog）

**部署**：飞牛 Docker → Compose，粘 `docs/docker-compose.watchdog.yml` 全文，只改 `ABS_TOKEN`。脚本内嵌 base64；可读单一真相在 `docs/abs-watchdog.py`（**改一边须重新 base64 同步另一边**，回环验证 decode==body）。挂 `docker.sock` 用于重启 ABS。

**功能**：
1. **下载卡死兜底**：`currentDownload` 存活超 `STALL_MINUTES` → docker.sock 重启 ABS → 等 healthcheck → 全档 `PATCH autoDownload + checknew` 重新入队（幂等）。每日重启上限 `MAX_RESTARTS_PER_DAY` 防风暴。
2. **每档裁剪（trim，治本）**：每档主动裁到 `KEEP_PER_PODCAST` 集（ABS 的 maxEpisodesToKeep 不回溯历史 → 只增不减逼近上限；主动维持每档 N 集后总量自然远低于 CAP）。**默认 `TRIM_ENABLED=0` = dry-run 只报 `would delete N` 不删**，观察满意后置 1。
3. **容量驱逐兜底（evict）**：总占用超 `STORAGE_CAP_GB` → 删全局最老集到 `STORAGE_TARGET_GB`，每档保底 `KEEP_MIN_PER_PODCAST` 集、不删空。

**关键加固（2026-06-19）**：① trim+evict 的 DELETE 一律 `?hard=1` 真删文件；② `check_storage` 用 `item.size` 缓存快筛 + libraryFiles 真实大小复核（缓存虚高不删，根治死循环误删）；③ evict sanity：连续 20 个 size=0 删除即中止，绝不无脑删全库。

**环境变量**：`STALL_MINUTES=30` `INTERVAL_SECONDS=1200` `MAX_RESTARTS_PER_DAY=4` `KEEP_PER_PODCAST=100` `STORAGE_CAP_GB=500` `STORAGE_TARGET_GB=480` `KEEP_MIN_PER_PODCAST=10` `EVICT_ENABLED=1` `TRIM_ENABLED=0`。

**验证新版生效**：日志首行 banner 含 `evict=X trim=Y`（旧版无 `trim=`）；storage 行是 `storage(cache):`+`storage(real):` 两行（旧版单行 `storage:`）。

---

## 十一、已落地状态与 TODO

### 已落地（P0~P3 + 配置中心，均真机实测）

- **P0 音源 spike**（2026-06-13）：ABS v2.35.1 部署、Podcast 库（id `c4379a59-72a4-4b8f-8f89-5170602f8469`）、OPML 全量导入、API token、映射链/Range 实测。
- **P1 解析链**：三级 `_getAudioSource`②级注入 + 熔断（nasAlive 800ms 探测 + 5min 心跳）。
- **P2 配置中心**：多档 profiles（`{enabled,activeProfileId,profiles[]}` + 向后兼容迁移）；nasBridge 全套 IPC；settings NAS 区块（总开关/测试/发现库/连接历史）；navbar 状态图标（绿呼吸/红静止/点击重连）。
- **P3 中途掉线续播**（代码完成，待真机断网验收）：`_nasSourceActive` 标记 + 1s 看门狗（位置连续~3s 不前进）+ loaderror 分支 → `_failoverNasToCdn()`（markNasDown 熔断 + seek 续播，仅 NAS 源激活）。
- **订阅托管 P0/P1**：handoff + 对账（ensureManaged/removeItem + 四闸）+ NAS 在档 wifi 标识（三路匹配）。
- **看门狗**：卡死重启 + trim + evict + hard=1 + 真实大小复核。

### TODO（用户搁置中，重启再做）

| 优先级 | 项 | 说明 |
|---|---|---|
| 高 | P3 续播真机验收 | 真 NAS 放一集 → 拔网 → ≤5s 续 CDN、误差 <2s |
| 高 | NAS 容量策略落地 | 快照解决后开 trim（KEEP=200）；P1-d 删档放量需 `nasDestructiveArmed=true` |
| 中 | 「我的 NAS」栏目 | NAS 有、订阅无的节目（需 ABS episodes 现构 track，无 CDN 兜底）|
| 中 | 状态图标黄(慢)态 / 长断联换图标 / 自动重试 | 见历史七诉求 #7 |
| 低 | 从 NAS 下载（局域网更快）/ 首页 NAS 板块（留接口）| 增强 |

---

## 十二、工程纪律

**禁碰清单**（违反即回退）：`downloads.js` 及下载 IPC、`refreshAllSubscriptions`、统计页/动画、睡眠定时器、`_getAudioSource` 的①③两级原文、任何与 NAS 无关的现有行为。

**回归红线**：每阶段在 **NAS 关闭态**跑核心回归（在线播/已下载播/下载新集/进度恢复/统计 tick/睡眠/切集续播）证明"未启用=现状"，再 NAS 开启态跑一遍。

**Token 安全**：ABS API token 绝不入 git / 不写任何受版本控制文件；运行期存主进程 electron-store（userData，repo 外）。

**禁可选链**：`src/electron/` 与 NAS 相关 `src/utils/podcast/` 新增代码禁 `?.`/`??`，用 `&&` 守卫 + `|| 默认值`。

---

## 附录 A：README 教程要点（给新用户，待写）

1. **PodPlayer 连 NAS**：设置→NAS 配置→填 ABS 地址(`http://NAS_IP:13378`)/API token/选 library/folder→测试连接。
2. **NAS 端 ABS**：Docker 装 ABS、建"播客"库指定下载文件夹、设置生成 admin API Token。
3. **看门狗容器**：据 `docker-compose.watchdog.yml` 部署（作用/配置项/日志查看）。
4. **强调**：不连 NAS 也能正常用，只是没有自动托管下载。

## 附录 B：飞牛 ABS 部署 compose 参考

```yaml
services:
  audiobookshelf:
    image: ghcr.io/advplyr/audiobookshelf:latest
    ports: ["13378:80"]
    volumes:
      - /vol1/podcasts:/podcasts      # ⚠️ 此卷建议关闭 Btrfs 快照（见 §九③）
      - /vol1/abs/config:/config
      - /vol1/abs/metadata:/metadata
    restart: unless-stopped
```
- 固定 IP（路由器 DHCP 保留），防地址漂移致"莫名失效"。

## 附录 C：设置页改造清单（历史，源自 nas-dev-notes §12；非 NAS 专属，待办项宜迁入 TODO与BUG总清单）

> 2026-06-13 随 NAS 分支起做的设置页清理（PodPlayer 由网易云客户端改造而来，大量音乐设置对播客无意义）。**已落地**：删 UnblockNeteaseMusic 段 / 缓存段 / 歌词段（模板移除）；made-by 改 `DESIGN BY FUJII`（粗衬线）；彩虹猫项标题换 nyancat.gif（开关保留）。

| 现项 | 决议 | 状态 |
|---|---|---|
| 语言 / 托盘 / 音频输出设备 | 保留（通用）| — |
| 音质(musicQuality) | 删（网易云码率，播客无意义）| 待删 item |
| 缓存（自动缓存/上限/清理）| 删 | ✅已删模板 |
| 歌词（翻译/背景/字号）| 删（沉浸页另设计）| ✅已删模板 |
| UnblockNeteaseMusic 整段 | 删（解锁灰色歌曲，与播客无关）| ✅已删模板 |
| Last.fm 连接 | 删（音乐 scrobble）| 待删 |
| Discord Rich Presence | 删（niche）| 待删 |
| 启动后显示音乐库 | 改「首页/我的订阅」二选一（background.js showLibraryDefault）| 待改 |
| 倒序播放 | 删 | 待删 |
| 彩虹猫（进度条样式）| 保留开关 + 名换 nyancat.gif | ✅已做 |
| 代理 / realIP | 待评估多半删（RSS 走主进程 axios）| 待评估 |
| 快捷键 | 保留 + 改造贴合播放器（播放/快进退/切集/睡眠）| 待改造 |
| made by(Vercel) | 换 `DESIGN BY FUJII` 粗衬线 | ✅已做 |
| 死代码清理 | 删模板后对应 computed/method/import（musicQuality/cacheLimit/lyric*/unm*）暂留 dormant，待专轮 script 清理 | 待清理 |

---

## 参考来源
- ABS API：api.audiobookshelf.org、DeepWiki audiobookshelf-api-docs。
- 项目代码：`src/electron/nasBridge.js`、`src/utils/podcast/nasSource.js`、`src/utils/podcast/service.js`、`src/utils/Player.js`、`docs/abs-watchdog.py`、`docs/docker-compose.watchdog.yml`。
