# PodPlayer NAS 订阅托管方案（订阅即下载 · 无感托管）

> 审查/方案 session 出品（2026-06-14）。本文档只做设计与技术拆解，落地由主 session 实施。
> 目标：**订阅一个节目 → NAS 上的 ABS 自动下载该档最近 100 期并持续追新**；**取消订阅 → NAS 即清，不留垃圾**；**总量不爆盘**；**没有 NAS 也能独立使用、绝不报错**。
> 存储原则（2026-06-14 定）：**无感 + 常听冗余多 + 不爆 + 取消即清**。**不做"按收听时间冷藏"**（见 §4.10）。

---

## 一、可行性结论：高 ✅

1. **ABS 原生就是为此设计**：播客 media 自带 `autoDownloadEpisodes` / `autoDownloadSchedule` / `maxNewEpisodesToDownload`（一次最多下 N，对应"≤100"）/ `maxEpisodesToKeep`。经 ABS API 文档坐实：`PATCH /api/items/{id}/media` 设参；`POST /api/podcasts` 创建；`POST /api/podcasts/{id}/download-episodes` 补历史集；`GET /api/items/{id}?include=downloads` 查进度。
2. **项目基建齐全**：`nasBridge.js` 已有 axios + 多档 profiles + `authGet` + `ensureItems`（feedUrl→itemId 缓存）+ 一整套 `nas:*` IPC。现有是只读消费，加"写"是自然扩展。
3. **订阅单一入口**：`service.js` 的 `subscribeByRssUrl(feedUrl, source)` 是所有订阅路径唯一入口（手动/OPML/发现页都走它）。
4. **优雅降级有现成范式**：`nasSource.js` 的"低耦合铁律：未启用/不可用 → 直接 return null"。托管钩子照抄：`!isNasEnabled() || !nasAlive → return {skipped}`。

---

## 二、现状（现有 NAS = 只读消费）

- 现有 IPC：`getStatus / setConfig / probe / resolve / warmPodcast / podcastSet / episodeGuids / listLibraries / 多档 profile`。
- 现有能力：探测、feedUrl→itemId 映射、解析流地址、在线播放、标"NAS 上有此节目"。
- **缺**：写能力（创建播客 / 触发下载 / 删除）；配置缺 `folderId`（创建播客需要）。

---

## 三、ABS API 依据（已核实）

| 用途 | 接口 | 说明 |
|---|---|---|
| 设自动下载参数 | `PATCH /api/items/{id}/media` | ✅ `autoDownloadEpisodes` / `maxNewEpisodesToDownload` / `maxEpisodesToKeep` |
| 创建播客 | `POST /api/podcasts` | libraryId + folderId + path + media{feedUrl,…}；精确 body 本机核实 |
| 补下历史集 | `POST /api/podcasts/{id}/download-episodes` | 传 episodes 数组（≤100） |
| 查下载进度 | `GET /api/items/{id}?include=downloads` | ✅ 返回 `episodesDownloading` |
| 取下载目录 | `GET /api/libraries/{id}` | → `library.folders[]{id, fullPath}` |
| 删整档（取消订阅用） | `DELETE /api/items/{id}` | 删 library item；删盘文件需 hard delete（`?hard=1`，本机核实） |
| 权限 | — | 创建/删除需 **admin**、PATCH 需 update；只读 token 会 403 |

---

## 四、方案设计

### 4.1 总流程（订阅即托管）
1. 用户订阅 → `subscribeByRssUrl` 成功（本地 `subscribed:true` 入库）。
2. 成功后 **fire-and-forget** 调 `handoffToNas(feedUrl, title)`（不阻塞订阅）：
   - **渲染端**（`nasSource.js` 新增 `handoffToNas`）：`if (!isNasEnabled() || !nasAlive) return {skipped:'no-nas'}`；否则 `invoke('nas:handoffSubscription', {feedUrl, title, max:100})`。
   - **主进程**（`nasBridge.js` 新增 IPC `nas:handoffSubscription`）：
     1. `ready(c)` 不满足 → `return {skipped:'no-nas'}`。
     2. `ensureItems` 查 feedUrl：**已存在** → `PATCH media` 确保 `autoDownloadEpisodes:true` + `maxNewEpisodesToDownload:100` + `maxEpisodesToKeep:100`（幂等）；**不存在** → `GET /api/libraries/{lib}` 取 `folders[0]` → `POST /api/podcasts` 创建（同上 media 参数）。
     3. **下最近 100 期**：解析 feed 取最近 100 期 → `POST /api/podcasts/{id}/download-episodes` 显式补满；`autoDownloadEpisodes:true` 持续追新。
     4. 返回 `{ok}` / `{skipped}` / `{error}`（**error 不抛，仅记录**）。
3. 渲染端按结果 toast：成功"已交给 NAS 下载"；无 NAS 静默；失败轻提示可重试。

### 4.2 无 NAS 优雅降级（硬约束）
- 三层防线：渲染端 `isNasEnabled/nasAlive` 短路 → 主进程 `ready()` 短路 → 全程 try/catch 不 throw。
- 托管是订阅 await 完成**之后**的旁路，失败/超时**不影响**本地订阅与播放。

### 4.3 幂等
- 已在 ABS 库的 feedUrl 不重复创建（`ensureItems` + `normFeed` 匹配），改走 PATCH。重复订阅安全。

### 4.4 下载量与每档上限
- `maxNewEpisodesToDownload = 100`：订阅即下最近 100 期。
- `maxEpisodesToKeep = 100`：每档维持 ≤100 集滚动追新（ABS 按发布时间删最老）。每档稳定 ~100 集冗余；总量再由看门狗按容量兜底（§4.10）。

### 4.5 批量订阅（OPML）节流
- `importOpmlText` 多次调 `subscribeByRssUrl` → 多次 handoff。用项目已有 `runLimited`（并发上限）排队，避免灌爆 ABS。

### 4.6 folderId 获取
- 一期自动：handoff 时主进程 `GET /api/libraries/{lib}` 取 `folders[0]` 并缓存。可选：settings 加"目标文件夹"下拉（多 folder 库）。

### 4.7 开关
- settings 加"**订阅时自动托管到 NAS**"（默认**开**；给关）。关掉则 handoff 不触发。

### 4.8 取消订阅（联动移除 · 7 天宽限）
- **联动移除**：取消订阅 → 期望态转"移除" → 由 §4.11 对账驱动 ABS 删整档（hard，真删文件），与"订阅=加"对称，**取消即清、不留垃圾**。
- **防误删**：**7 天宽限期**——标记后延迟到 7 天才真删；期间重新订阅**自动撤销**。纯自动、无需确认。
- 无 NAS / 断联：本地照常取消，删除意图留待恢复后对账执行，不丢、不报错。
- **多设备共享模式**（§4.13）：取消订阅 **只删本地、不删 NAS**（别端可能还订阅），NAS 清理交容量驱逐。
- **⚠️ 谁跑这 7 天定时 / 不开软件行不行（关键，2026-06-15 澄清）**：
  - **默认 = PodPlayer 对账跑**（启动 / 每日 / 操作时）。标记 `removedAt` 存本地。**它不是 NAS 上的墙钟定时器**——**若这 7 天一次没开 PodPlayer，删除不执行、推迟到下次打开**（"≥7 天 且 下次打开时"删，非精确第 7 天）。**无害**：节目一直在 NAS（没误删）、容量驱逐兜底防爆、你没开软件也不在乎 NAS 即时清。
  - **要"不依赖开软件、NAS 自己按时删" = 交看门狗**：取消订阅时 PodPlayer 给 ABS 该档打"待删 tag + 时间戳"（`PATCH media` tag，如 `podplayer:unsub:<ts>`；NAS 在线即时、离线则下次对账补打）；**看门狗每轮（20min）查标记超 7 天的 → DELETE 整档**；7 天内重订阅 → PodPlayer 撤 tag → 不删。删除由 NAS 常驻执行，开不开 PodPlayer 都按时。看门狗本就在删集（容量驱逐），加这条很自然。
  - **第一版取舍**：你日常常开软件 → **PodPlayer 对账够用**（推迟极少、且无害）；要"真·按时、不依赖开软件"再上看门狗版（P1 增强）。

### 4.9 进度可见（二期增强）
- `GET /api/items/{id}?include=downloads` → 节目页显示"NAS 下载中 N 集"+"重新托管"按钮。

### 4.10 存储管理（容量驱逐 + 取消移除，**不做收听冷藏** · 2026-06-14 定）
> 目标平衡：**无感 + 常听冗余多 + 不爆盘 + 取消即清**。结论：**砍掉"按收听时间 6 月冷藏"**——它"删到只留 1 集"与"冗余多"直接矛盾、最复杂、且与看门狗打架。存储只靠三条：

1. **平时不删、全留**：总量没到上限就什么都不动 → 所有订阅档的集都在，**冗余拉满、覆盖日常**。
2. **取消订阅 → 移除整档**（7 天宽限，§4.8）：你不要的，NAS 即清。PodPlayer 端驱动（看门狗不认订阅状态，管不了）。
3. **容量触顶兜底 → 看门狗按全局最老驱逐**：NAS 端看门狗（`docs/docker-compose.watchdog.yml` 新版）已实现——总占用超 `STORAGE_CAP_GB` 删全局最老集到 `STORAGE_TARGET_GB`、每档保底 `KEEP_MIN_PER_PODCAST` 集、`DELETE episode` 真释放。**防爆盘的硬上限**。

**为什么砍掉 6 月冷藏**：① 与"冗余多"矛盾；② 容量驱逐已防爆、取消移除已清垃圾，冷藏多余；③ 它最复杂（收听时间计算 + 收藏白名单 + 留 1 集）；④ 当前 NAS 约 220G、满载 330G，离 500G 上限还远，平时根本不触发；⑤ 砍掉后 PodPlayer **不再主动关 autoDownload** → **与看门狗不再打架**。

**与看门狗的分工（清爽、无交集）**：看门狗 = 卡死重启 + 容量硬上限兜底（NAS 端常驻、可靠）；PodPlayer = 订阅托管 + 取消移除（按订阅态）。两者各管各。

**将来后路（暂不做）**：若日后"订阅着但再也不听的僵尸档"挤占空间，再给容量驱逐加一条"优先删最久没听的档"（收听感知驱逐，比冷藏温和），而非现在上冷藏。

**参数（用户可调）**：`STORAGE_CAP_GB` 按硬盘留余量（如 1T 盘 600~700）；`KEEP_MIN_PER_PODCAST` 10~20。

> ⚠️ 看门狗文件：`docs/abs-watchdog.py` 是**旧版（无存储驱逐）**，新版在 `docs/docker-compose.watchdog.yml` 内嵌 base64；需把内嵌新版同步回 `.py`（可读单一真相）或标 `.py` 废弃。

### 4.11 NAS 生命周期与一致性（声明式 + 对账，应对断联）
> **本地订阅状态是唯一真相，NAS 在线时对账(reconcile) 把 ABS 逼近期望态**，而非"即时发命令"（断联会丢/冲突）。砍掉冷藏后只剩**两态**，模型很轻。

**每档期望 NAS 态：**

| 本地 subscribed | 期望 NAS 态 |
|---|---|
| true | **托管**：ABS 有此档 + autoDownload 开 + 维持最近 100 期 |
| false（已取消） | **移除**：标记 + 7 天宽限后 ABS 删整档（hard） |

> 容量超限的删集**不在对账内**——交看门狗按总量兜底；PodPlayer 不掺和单集级删除。

**对账（reconcile）：** 仅 NAS 在线时（启动就绪 / 断线恢复 / 每日 / 操作后即时）遍历订阅，只对不一致的执行：
- 期望托管、ABS 没有 → 创建 + autoDownload + 下最近 100；ABS 有但 autoDownload 关 → PATCH 开。
- 期望移除、ABS 还有 → 7 天宽限到期后 DELETE 整档（hard）。
- 已符合 → 跳过（幂等，可反复跑）。

**冲突/边界自然化解：**
1. 取消后又重新订阅（7 天宽限内）→ subscribed 回 true → 期望态回"托管"，移除标记自动撤销。
2. 取消订阅删整档 vs 看门狗容量驱逐：互不干扰——取消是删 ABS item（整档没了，看门狗 requeue 遍历现有 items 不会把它加回）；看门狗只在总量超限时删"现存档的最老集"。
3. 砍掉冷藏后，**不再有"冷藏关 autoDownload 被看门狗重开"那个坑**。

**NAS 断联：**
- 对账只在 NAS 在线时跑；断联跳过、不报错、不丢状态。
- 恢复 → 跑一次全量对账，用"当前真相"重算（不靠命令队列），断联多久都稳。
- 永久弃用 NAS：设置清空配置 → 停对账；本地订阅与收听完全不受影响。

---

### 4.12 首次连接（新）NAS 的差异对账
> 场景：连接一个**已有内容**的 NAS，它和你的订阅不一致。原则：**对账只作用于你订阅过的节目，绝不碰 NAS 上你从没订阅的内容。**

| 差异 | 处理 |
|---|---|
| 我订阅 ∩ NAS 已有 | 确保托管（autoDownload 开、补齐最近 100 期） |
| 我订阅 − NAS 没有 | 托管（创建 + 下最近 100 期） |
| **NAS 有 − 我订阅**（NAS 有我无） | **默认不动**：不下载、**不删除**；只可选弹一次"发现 NAS 上有 N 档未订阅节目，是否导入？"，**经你确认**才导入，不确认就放着 |

- **为何"NAS 有我无"不自动删**：NAS 可能多用途/多设备共享，无权对未订阅内容做破坏性操作——安全底线。
- **移除只针对 `subscribed` 过的节目**（本地订阅是真相），天然不误伤未订阅内容。
- 导入提示一次性、可关（设置开关）。

### 4.13 多设备共享同一 NAS（多端同步 · 2026-06-15）
> 场景：多台机器各跑 PodPlayer、共享同一 NAS。诉求："本地有 NAS 没有的→托管上去；NAS 有本地没有的→能同步下来。"

**读方向（订阅并集，可完美做到）：**
- 本地有、NAS 无 → 正常托管（`handoffToNas`）。
- NAS 有、本地无 → 新机接入时**可选导入到本地订阅**（§4.12 的导入提示；多设备模式可设"自动导入"，让各端订阅并集化）。

**删方向（有内在矛盾，靠"模式开关"务实解决）：**
> 难点：单机取消订阅时**不知道别的机器是否还订阅这档**。直接删 NAS 整档会误删别端还在用的下载。完美解需"引用计数"（NAS 记每端订阅、最后一端取消才删），成本高 → 留 P3。第一版用开关绕开：

- **设置开关「此 NAS 仅本机使用 / 多设备共享」**：
  - **仅本机（默认）**：取消订阅 → 7 天宽限删 NAS 整档（**取消即清**，安全，无别端）。
  - **多设备共享**：取消订阅 → **只删本地订阅、不删 NAS**（别端可能还要）；NAS 清理**全交容量驱逐**（看门狗超 CAP 删全局最老）。代价是"取消后 NAS 不立即清"，但多端安全、容量兜底不爆盘。

**为什么够用**：多设备本质是"NAS = 各端订阅的并集仓库"。读靠并集导入（完美）；删在多端下本就不该单机说了算（你取消 ≠ 别人取消），交容量驱逐统一回收最安全。真要"多设备也取消即清"，再上引用计数（P3）。

---

## 五、数据流

```
订阅 subscribeByRssUrl
  └─ 本地入库(subscribed:true)        ← 订阅照常完成（无 NAS 也到此为止）
  └─ handoffToNas(feedUrl,title)      ← 渲染端：!enabled||!alive → return（降级）
       └─ IPC nas:handoffSubscription ← 主进程：!ready → return（降级）
            ├─ 已在库 → PATCH media (autoDownload + 100 + keep100)   ← 幂等
            └─ 不在库 → 取 folder → POST /api/podcasts → download-episodes 补最近100
       └─ ABS 后台自动下载 →（可选）include=downloads 查进度

取消订阅 → 标记移除 → 对账(7天宽限到期) → DELETE item(hard)
容量超限 → 看门狗 → 删全局最老集到 TARGET（PodPlayer 不参与）
```

---

## 六、边界与风险

1. **token 权限**：创建/删除/PATCH 需 admin/update，只读 403。配置时探测权限并提示。
2. **`POST /api/podcasts` body / path / `?hard`**：不同 ABS 版本略异，**本机实测一次**坐实。
3. **feedUrl 一致性**：用 `normFeed` 归一化匹配（已有）。
4. **网络/超时**：handoff 失败不影响订阅；节目页给"重新托管"手动重推。
5. **某些源 ABS 下不动**（特殊 UA/被墙 feed）：属 ABS/NAS 侧网络能力（看门狗处理卡死），非本功能 bug。

---

## 七、不破坏现有 / 不影响无 NAS（硬约束）

- handoff / 移除都是旁路：失败 / 无 NAS 都**不回滚订阅、不报错**。
- **不改** `subscribeByRssUrl` 现有返回与行为，只在其后挂 `.catch` 化的 handoff。
- 新增 IPC **不动**现有 `nas:*`，复用 `getCfg/ready/ensureItems/authGet`。
- 切分支 + feature flag 包裹，可一键回退。

---

## 八、落地步骤（主 session）

1. **在 `master` 上做**（master 已含沉浸页 + 全部审查修复；**勿切回 `feature/nas-source`**——它落后到图标轮、缺沉浸页与所有修复，可废弃）。从 master 切 `feature/nas-handoff`，开工前 git 快照。
2. `nasBridge.js`：新增 `nas:handoffSubscription`（幂等查库 → 创建/PATCH 设 autoDownload+100+keep100 + 取 folder + try/catch 不抛）。
3. `nasSource.js`：新增 `handoffToNas`（降级短路 + invoke）；新增 `reconcile`（对账：托管/移除两态 + 7 天宽限）。
4. `service.js`：`subscribeByRssUrl` 成功后 `handoffToNas(...).catch(()=>{})`；取消订阅处标记移除；OPML 走 `runLimited`。
5. `settings.vue`：加"订阅自动托管 NAS"开关 +（可选）目标文件夹；配置时探测 token 权限。
6. 看门狗：把 `docker-compose.watchdog.yml` 内嵌新版同步回 `abs-watchdog.py` 或标其废弃。
7. **本机 ABS 实测** `POST /api/podcasts` body + `DELETE ?hard` 后再放量。

---

## 九、决策（全部已定 2026-06-14）

- 自动托管开关：**默认开** + 设置页入口。
- 订阅下载范围：订阅即下**最近 100 期** + autoDownload 持续追新；`maxEpisodesToKeep=100` 每档滚动。
- 取消订阅：**联动移除**，标记 + **7 天宽限**后 hard delete 整档（期间重订阅自动撤销），纯自动。
- **存储管理：不做收听冷藏**；只靠 ① 平时全留 ② 取消移除 ③ 看门狗容量驱逐（超 CAP 删全局最老、每档保底 N）。满足"无感 + 冗余多 + 不爆 + 取消即清"。
- 生命周期：**声明式 + 对账**（托管↔移除两态、断联恢复全量对账）。
- 首次连接新 NAS：差异对账只管我订阅的；NAS 有我无一律不动，仅可选提示导入。
- **多设备共享**：设置开关「仅本机 / 多设备共享」。仅本机(默认)=取消删整档；多设备=取消只删本地、NAS 交容量驱逐回收、NAS 有→可选导入(订阅并集)。引用计数(多设备也取消即清)留 P3。
- git：NAS 托管在 **master** 做，勿切回 nas-source。
- 看门狗 `.py` 旧版需同步内嵌新版或标废弃。
- 参数：CAP 按硬盘留余量（如 1T 盘 600~700G）、每档保底 N 10~20。

---

## 参考来源
- ABS API：api.audiobookshelf.org、DeepWiki audiobookshelf-api-docs。
- 项目代码：`src/electron/nasBridge.js`、`src/utils/podcast/nasSource.js`、`src/utils/podcast/service.js`、`docs/abs-watchdog.py`、`docs/docker-compose.watchdog.yml`。
