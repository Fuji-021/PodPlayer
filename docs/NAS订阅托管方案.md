# PodPlayer NAS 订阅托管方案（订阅即下载 · 无感托管）

> 审查/方案 session 出品（2026-06-14）。本文档只做设计与技术拆解，落地由主 session 实施。
> 目标：在 PodPlayer 里**订阅一个节目** → NAS 上的 ABS **自动下载**该节目单集（最多 100 集），做到无感托管；**没有 NAS 也能独立使用、绝不报错**。

---

## 一、可行性结论：高 ✅

四条依据：

1. **ABS 原生就是为此设计**：播客 media 自带 `autoDownloadEpisodes`（自动下新集）/ `autoDownloadSchedule`（cron 定时检查）/ `maxNewEpisodesToDownload`（一次最多下 N 集，**对应你的"≤100"**）/ `maxEpisodesToKeep`（保留上限）。这些字段经 ABS API 文档坐实：可由 `PATCH /api/items/{id}/media` 设置；创建播客用 `POST /api/podcasts`；补下历史集 `POST /api/podcasts/{id}/download-episodes`；查进度 `GET /api/items/{id}?include=downloads`（返回 `episodesDownloading`）。
2. **项目基建齐全**：`nasBridge.js` 已有 axios + 多档配置（profiles）+ `authGet` + `ensureItems`（feedUrl→itemId 映射缓存）+ 一整套 `nas:*` IPC。现有是**只读消费**（解析流地址、列库、在线播放 NAS 音频），加"写"（创建/托管）是自然扩展，不推倒重来。
3. **订阅是单一入口**：`service.js` 的 `subscribeByRssUrl(feedUrl, source)` 是**所有订阅路径的唯一入口**（手动粘贴 RSS、OPML 导入、发现页订阅都走它）。托管钩子挂这里即全覆盖。
4. **优雅降级是现成范式**：`nasSource.js` 开篇就立了"低耦合铁律：未启用 / 不可用 → 直接 return null，播放零等待"。托管钩子照抄这条：`!isNasEnabled() || !nasAlive → return {skipped}`，**绝不报错、绝不阻塞订阅**。

---

## 二、现状（现有 NAS = 只读消费）

- `nasBridge.js` 现有 IPC：`getStatus / setConfig / probe / resolve / warmPodcast / podcastSet / episodeGuids / listLibraries / 多档 profile 管理`。
- 现有能力：探测连通、feedUrl→itemId 映射、解析单集流地址、在线播放 NAS 音频、标"NAS 上有此节目"。
- **缺的**：写能力（让 ABS 创建播客 / 触发下载）。
- 现有配置字段（每档 profile）：`baseUrl / token / libraryId`。**缺 `folderId`**（创建播客需要）。

---

## 三、ABS API 依据（已核实）

| 用途 | 接口 | 说明 |
|---|---|---|
| 设自动下载参数 | `PATCH /api/items/{id}/media` | ✅文档确认：`autoDownloadEpisodes` / `maxNewEpisodesToDownload` / `maxEpisodesToKeep` / `autoDownloadSchedule` |
| 创建播客 | `POST /api/podcasts` | libraryId + folderId + path + media{metadata.feedUrl,…}；端点存在，**精确 body 落地按本机 ABS 版本核实** |
| 补下历史集 | `POST /api/podcasts/{id}/download-episodes` | 传 episodes 数组（≤100） |
| 查下载进度 | `GET /api/items/{id}?include=downloads` | ✅返回 `episodesDownloading` |
| 取下载目录 | `GET /api/libraries/{id}` | → `library.folders[]{id, fullPath}`，取 folderId |
| **删单集(可删文件)** | `DELETE /api/podcasts/{id}/episode/{epId}` | **`?hard=1` 真删磁盘文件**、释放 NAS 存储（默认仅删记录）；精确参数本机核实 |
| **删节目** | `DELETE /api/items/{id}` | 删整档 library item；删盘文件需 hard delete |
| 权限 | — | 创建/删除等写操作需 **admin**；PATCH media 需 update 权限。**token 须有相应权限**，只读 token 会 403 |

---

## 四、方案设计

### 4.1 总流程（订阅即托管）
1. 用户订阅 → `subscribeByRssUrl` 成功（本地 `subscribed:true` 入库）。
2. 订阅成功后 **fire-and-forget** 调 `handoffToNas(feedUrl, title)`（不阻塞订阅返回）：
   - **渲染端**（`nasSource.js` 新增 `handoffToNas`）：`if (!isNasEnabled() || !nasAlive) return {skipped:'no-nas'}`；否则 `ipcRenderer.invoke('nas:handoffSubscription', {feedUrl, title, max:100})`。
   - **主进程**（`nasBridge.js` 新增 IPC `nas:handoffSubscription`）：
     1. `ready(c)` 不满足 → `return {skipped:'no-nas'}`（降级）。
     2. `ensureItems(c)` 查 feedUrl 是否已在 ABS 库：
        - **已存在** itemId → `PATCH /api/items/{itemId}/media` 确保 `autoDownloadEpisodes:true` + `maxNewEpisodesToDownload:100`（幂等，不重复创建）。
        - **不存在** → `GET /api/libraries/{lib}` 取 `folders[0]{id,fullPath}` → `POST /api/podcasts` 创建（libraryId + folderId + path=`fullPath/safeTitle` + media{metadata.feedUrl,title, autoDownloadEpisodes:true, maxNewEpisodesToDownload:100}）。ABS 创建后按设置抓取最近 ≤100 集。
     3. **下最近 100 期**（2026-06-14 已定）：订阅即下该档**最近 100 期**（最新的往前数 100 集）——解析 feed 取最近 100 期 → `POST /api/podcasts/{id}/download-episodes` 显式下载（比只靠 autoDownload 抓新更可控、确保补满）；同时 `autoDownloadEpisodes:true` 持续追新。
     4. 返回 `{ok, created|updated, queued:N}` / `{skipped}` / `{error}`（**error 不抛，仅记录**）。
3. 渲染端按结果 toast：成功"已交给 NAS 自动下载（最多 100 集）"；无 NAS 静默；失败轻提示"本地已订阅，NAS 托管失败，可稍后重试"。

### 4.2 无 NAS 优雅降级（硬约束）
- **三层防线**：渲染端 `isNasEnabled/nasAlive` 短路 → 主进程 `ready()` 短路 → 全程 try/catch 返回 `{skipped}/{error}`，**绝不 throw**。
- **托管与订阅完全解耦**：handoff 是订阅 await 完成**之后**的旁路，其失败/超时**不影响**本地订阅成功。
- 无 NAS 用户：钩子第一行就 return，零副作用、零报错。

### 4.3 幂等
- 已在 ABS 库的 feedUrl 不重复创建（`ensureItems` 映射 + `normFeed` 归一化匹配）；改走 PATCH 确保 autoDownload 开。重复订阅同一节目安全。

### 4.4 100 集上限
- `maxNewEpisodesToDownload = 100`（ABS 一次最多下 100，对应你的"最大 100 集"）。
- `maxEpisodesToKeep`：决策点（0=不限只增 / 100=滚动只留最近 100）。

### 4.5 批量订阅（OPML）节流
- `importOpmlText` 会多次调 `subscribeByRssUrl` → 多次 handoff。用项目已有的 `runLimited`（并发上限，如 3）排队推 ABS，避免灌爆主进程/ABS；或导入完成后批量推一次。

### 4.6 folderId 获取
- 一期**自动**：handoff 时主进程 `GET /api/libraries/{lib}` 取 `folders[0]`（单文件夹库最常见）并缓存。
- 可选：settings NAS 配置加"下载目标文件夹"下拉（多 folder 库时）。

### 4.7 开关
- settings 加"**订阅时自动托管到 NAS 下载**"（默认**开**，符合无感；给关）。关掉则 handoff 不触发。

### 4.8 取消订阅（联动移除）
- **联动移除**（2026-06-14 定）：取消订阅 → 期望态转"移除" → 由 §4.11 对账驱动 ABS 删整档（hard，真删文件），与"订阅=加"对称。
- **防误删**：加 N 天宽限期（标记后延迟真删，期间重订阅自动撤销）或取消时二次确认"是否同时删 NAS 下载"（方式见 §九）。
- 无 NAS / 断联时：本地照常取消，删除意图留待 NAS 恢复后对账执行（§4.11），不丢、不报错。

### 4.9 进度可见（二期增强）
- `GET /api/items/{id}?include=downloads` → `episodesDownloading`，节目页显示"NAS 下载中 N 集"+"重新托管"按钮。

### 4.10 存储自动回收（按收听时间清理，防爆存储）★用户新需求
> 背景：NAS 存储有限，长期托管会越堆越满。ABS 自带的 `maxEpisodesToKeep` 只能"**按集数**"滚动（下满上限后删最旧的，**但它不知道你听没听**，可能删掉你还没听的）。你要的是"**按收听时间**"的智能回收：某节目 6 个月没听 → 删它在 NAS 上的单集。**这个 ABS 自己做不到，必须由 PodPlayer 驱动**（收听记录在 PodPlayer 本地库，ABS 不掌握）。

- **可行性：高**。ABS 支持 hard delete 真删盘文件（见 §三表）；PodPlayer 有完整收听数据（`episodeProgress` / `episodeListenStats` / `listenDaily`）可判"最后收听时间"。
- **机制**（PodPlayer 端，定期：启动 / 每日）：
  1. 扫描订阅节目，用本地收听数据算每档"最后收听时间"。
  2. 超阈值（**默认 6 个月**）→ hard delete 该档 NAS 单集，**只保留最近 1 集 + 所有收藏单集**（逐集 `DELETE …/episode/{id}?hard=1`）+ 关该档 autoDownload。
  3. 释放 NAS 存储；**PodPlayer 订阅保留**（节目还在，想听可"重新托管"重下 / 在线流）。
- **安全阀（已定 2026-06-14）**：
  - **冷藏力度**：只留**最近 1 集 + 所有收藏单集**，其余删。
  - **白名单 = 收藏的单集（单集级）**：被收藏的单集**永不删**，无论多旧。
  - **只删 NAS 文件**，不删本地订阅、不删本地收听记录。
  - 阈值 **6 个月**；执行 **纯自动**（无需确认）。
  - 与 ABS `maxEpisodesToKeep` 并存做集数兜底——⚠️ 它**不认收藏**，取值见 §4.11 末提醒。
- 执行细节（冷藏 = 删文件 + **停 autoDownload**，避免"白删又被 ABS 重下"）与断联处理，统一见 §4.11。
- 这块作为 **P1/独立阶段**（托管 P0 跑通后再做回收）。

### 4.11 NAS 生命周期与一致性（声明式 + 对账，应对断联与冲突）★逻辑完善
> 把"订阅托管 / 取消移除 / 6 个月冷藏"三条删改逻辑**统一**起来，避免即时命令在 NAS 断联时丢失、或彼此打架。核心思想：**本地状态是唯一真相，NAS 在线时"对账(reconcile)"把 ABS 逼近期望态**——而不是"每个操作即时发命令给 ABS"。

**每档节目的期望 NAS 态（由本地状态派生）：**

| 本地 subscribed | 活跃度（最后收听） | 期望 NAS 态 |
|---|---|---|
| true | 近期（< 6 个月） | **托管**：ABS 有此档 + autoDownload 开 |
| true | 6 个月没听 | **冷藏**：删 NAS 单集但**保留最近 1 集 + 所有收藏单集** + autoDownload 关（订阅保留） |
| false（已取消订阅） | — | **移除**：7 天宽限后 ABS 删整档（hard） |

> **白名单 = 收藏的单集（单集级）**：冷藏执行时被收藏的单集**永不删**（无论多旧），非整档豁免。

**对账（reconcile）：** 仅在 NAS 在线时（启动就绪 / 断线恢复 / 每日 / 操作后即时）遍历订阅，逐档比较"期望 vs ABS 实际"，只对不一致的执行：
- 期望托管、ABS 没有 → 创建 + autoDownload；ABS 有但 autoDownload 关 → PATCH 开。
- 期望冷藏、ABS 有文件 → hard delete 该档单集（**保留最近 1 集 + 所有收藏单集**）+ **PATCH autoDownload 关**。
- 期望移除、ABS 还有 → 7 天宽限后 DELETE 整档（hard）。
- 已符合 → 跳过（**幂等**，可反复跑）。

**三条逻辑的冲突 → 这样化解：**
1. **取消订阅删 vs 6 个月没听删**：天然**互斥**——`subscribed=false` 命中"移除整档"；`subscribed=true 且不活跃` 命中"冷藏（删文件、留订阅）"。一档同时只满足一条，不打架。语义也不同：取消=连订阅都不要了（删整档）；冷藏=还订阅着、只是腾空间（删文件、留订阅，想听可重托管）。
2. **冷藏删了文件、但 ABS autoDownload 还开着会继续下** → 冷藏动作**同时关 autoDownload**，根除"白删又重下"。（这是最隐蔽的冲突）
3. **重新听了被冷藏的节目** → 活跃度刷新 → 下次对账自动回到"托管"（重开 autoDownload、重下）→ **自愈**。
4. **取消后又重新订阅** → subscribed 回 true → 对账重新托管。

**NAS 断联（你问的关键）：**
- 对账**只在 NAS 在线时跑**；断联就**跳过、不报错、不丢状态**（本地订阅/收听照常变）。
- NAS **恢复** → 跑一次**全量对账**，把断联期间的所有变化一次性同步。
- **断联 6 个月也稳**：因为是"看当前期望 vs 现状"的声明式对账、**不靠命令队列**，所以不存在"积压的删除/下载命令丢失或错乱"。NAS 回来后用**当前真相**重算即可——断联期间你订的、退订的、听过的，全部以回来那一刻的状态为准。
- NAS **永久弃用**：设置里清空 NAS 配置 → 停止对账；本地订阅与收听完全不受影响（**无 NAS 独立可用**）。

**防误删（已定）：** 取消订阅 → 标记移除 + **7 天宽限期**，对账延迟到 7 天后才真删；期间重新订阅**自动撤销**。纯自动，无需确认。

**`maxEpisodesToKeep` = 100（已定，冲突以 ABS 为准）：** 启用做集数硬上限兜底、设 **100**（与下载范围一致，ABS 维持每档 ≤100 集滚动追新）。ABS 按发布时间删最旧、**不认 PodPlayer 收藏**——某档超 100 集后极旧的收藏单集可能被 ABS 滚动删；**此冲突以 ABS 为准**（用户 2026-06-14 定，不为它牺牲集数兜底）。即"收藏单集永不删"仅在 **PodPlayer 冷藏逻辑**内成立，ABS 的集数滚动不另行豁免收藏。

---

### 4.12 首次连接（新）NAS 的差异对账 ★新增考量
> 场景：连接一个**已有内容**的 NAS（ABS 库里已有节目），它和你 PodPlayer 的订阅**不一致**。原则：**期望态只对"你的订阅"定义；对账只作用于你订阅过的节目，绝不碰 NAS 上你从没订阅的内容。**

| 差异 | 处理 |
|---|---|
| **我订阅 ∩ NAS 已有** | 已托管 → 确保 autoDownload 开、补齐最近 100 期 |
| **我订阅 − NAS 没有**（我有 NAS 无） | 对账 → 托管（创建 + 下最近 100 期） |
| **NAS 有 − 我订阅**（NAS 有我无） | **默认不动**：不下载、**不冷藏、不删除**；只可选弹一次"发现 NAS 上有 N 档你未订阅的节目，是否导入订阅？"，**经你确认**才导入（之后纳入正常生命周期），不确认就放着 |

- **为何"NAS 有我无"不自动删/冷藏**：NAS 可能是**多用途 / 多设备共享**的，PodPlayer 无权对"自己没订阅、可能属于别处"的内容做破坏性操作——安全底线。
- **冷藏 / 移除永远只针对 `subscribed` 过的节目**（本地订阅是真相），天然不误伤未订阅的 NAS 内容——这是声明式模型的自然结论。
- 导入提示**一次性、可关**（设置开关"连接新 NAS 时提示导入未订阅节目"）。

---

## 五、数据流

```
订阅 subscribeByRssUrl
  └─ 本地入库(subscribed:true)        ← 订阅照常完成（无 NAS 也到此为止，正常）
  └─ handoffToNas(feedUrl,title)      ← 渲染端：!enabled||!alive → return（降级）
       └─ IPC nas:handoffSubscription ← 主进程：!ready → return（降级）
            ├─ 已在库 → PATCH media (autoDownload+100)   ← 幂等
            └─ 不在库 → 取 folder → POST /api/podcasts (autoDownload+100)
                 └─（可选）download-episodes 补最近100集
       └─ ABS 后台自动下载 →（可选）include=downloads 查进度
```

---

## 六、边界与风险

1. **token 权限**：创建/PATCH 需 admin/update 权限，只读 token 403。配置时可探测权限并提示。
2. **`POST /api/podcasts` 精确 body / path**：不同 ABS 版本字段略异；path 需 `folder.fullPath/safeTitle`，ABS 自动建目录。**落地用本机 ABS 版本实测一次**坐实。
3. **feedUrl 一致性**：本地与 ABS 存的 feedUrl 用 `normFeed` 归一化匹配（已有）。
4. **网络/超时**：handoff 失败不影响订阅；建议节目页给"重新托管到 NAS"手动重推入口。
5. **历史集与带宽**：download-episodes 传 100 集，ABS 后台排队下；注意 NAS 带宽/存储；`maxEpisodesToKeep` 控制滚动留存。
6. **某些源 ABS 下不动**（特殊 UA/被墙 feed）：属 ABS/NAS 侧网络能力（之前 watchdog 处理过卡死），非本功能 bug。

---

## 七、不破坏现有 / 不影响无 NAS（硬约束）

- handoff 是订阅成功后的**附加旁路**：失败 / 无 NAS 都**不回滚订阅、不报错**。
- **不改** `subscribeByRssUrl` 现有返回与行为，只在其后挂一个 `.catch` 化的 handoff。
- 新增 IPC **不动**现有 `nas:*` 逻辑，复用 `getCfg/ready/ensureItems/authGet`。
- **切分支** + feature flag 包裹，可一键回退。

---

## 八、落地步骤（主 session）

1. **切分支**：`feature/nas-handoff`（或在 NAS 分支上），开工前 git 快照。
2. `nasBridge.js`：新增 `ipcMain.handle('nas:handoffSubscription', …)`——幂等查库 → 创建(`POST /api/podcasts`) 或 `PATCH media` 设 autoDownload+100 + 取 folder + 全程 try/catch 不抛。
3. `nasSource.js`：新增 `export async function handoffToNas(feedUrl, title)`——降级短路 + invoke。
4. `service.js`：`subscribeByRssUrl` 成功后 `handoffToNas(url, podcast.title).catch(()=>{})`（不 await 阻塞）；OPML 批量走 `runLimited`。
5. `settings.vue`：加"订阅自动托管 NAS"开关 +（可选）目标文件夹选择；配置时探测 token 权限。
6. （二期）节目页：NAS 下载状态 + 重新托管按钮。
7. **本机 ABS 实测** `POST /api/podcasts` body + 权限，坐实字段后再放量。

---

## 九、决策

**已定（2026-06-14）：**
- 自动托管开关：**默认开** + 设置页留开关入口。✅
- 取消订阅：**联动移除**——驱动 ABS 删整档（hard）。✅（**更新**：由上一轮"不联动"改为"联动"，使"订阅=加 / 取消=删"对称）
- 生命周期统一走 **§4.11 声明式 + 对账**（应对断联、三逻辑冲突自愈）。✅
- 存储回收走 **§4.10 + §4.11 冷藏**（删文件 + 停自动下载、留订阅）。✅
- 订阅下载范围：订阅即下该档**最近 100 期**（最新往前数 100 集）+ 持续追新。✅（2026-06-14；用 `download-episodes` 显式传最近 100 期，比只靠 autoDownload 更可控）

- 冷藏阈值：**6 个月没听**。✅
- 冷藏力度：删该档 NAS 单集，**只留最近 1 集 + 所有收藏单集**。✅
- 取消订阅：**7 天宽限期**后 hard delete 整档（期间重订阅自动撤销）。✅
- 白名单：**收藏的单集**（单集级豁免，永不删）。✅
- 回收 / 对账执行：**纯自动**。✅
- ABS `maxEpisodesToKeep`：**启用、设 100**；与"收藏永不删"的冲突**以 ABS 为准**（极旧收藏单集可能被 ABS 滚动删，接受）。✅
- 首次连接新 NAS：**差异对账**，只管我订阅的；NAS 上我未订阅的内容**一律不动**，仅可选提示导入（见 §4.12）。✅

**全部已定，无待拍板 —— 可转落地提示词。**

---

## 参考来源
- ABS API（PATCH items/media 的 autoDownloadEpisodes/maxNewEpisodesToDownload/maxEpisodesToKeep、items?include=downloads、podcasts 创建与 download-episodes）：api.audiobookshelf.org、DeepWiki audiobookshelf-api-docs。
- 项目代码：`src/electron/nasBridge.js`、`src/utils/podcast/nasSource.js`、`src/utils/podcast/service.js`。
