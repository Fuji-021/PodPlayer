# 事故调查报告：IndexedDB 无法打开 / 本地数据清零

> 报告类型：严重事故根因分析（RCA） ｜ 日期：2026-06-13 ｜ 调查方：审查 session
> 错误特征：`UnknownError: Internal error opening backing store for indexedDB.open.`（订阅/导入全失败）；先于此出现数据清零（`[DB Health]` podcasts/episodes/favorites = 0、收听统计丢失）。
> 调查原则：读码实证 + 联网确证 + 沙箱实测 + 真机复现路径；**结论分「确证 / 最可能（推断）/ 未排除」三档，不口说无凭**。

---

## 0. 摘要（TL;DR）

- **不是业务代码、不是 Dexie 配置、不是 prune 清理**——这三者经读码 + 沙箱实测**双重排除**。
- 报错 `Internal error opening backing store` 是 **Chromium 的 IndexedDB 后端 LevelDB 打开磁盘 backing store 失败**（文件层），与 JS 逻辑无关（联网确证）。
- **最可能根因**：本机**多个同身份应用**（dev-serve / 正式版安装包 / 最新构建产物，全部 `YesPlayMusicPodcast` + 端口 27233）**共用同一个 LevelDB 库**，抢 LevelDB 的独占 `LOCK` → 后开者打不开 backing store。
- **两个放大隐患（之前无人注意）**：① `src/background.js` 源码被**截断损坏**，导致单实例保护实际失效；② 曾做过的"开发版独立身份隔离（`PodPlayerDev`/27244）"被**回退**成与正式版同身份同端口，使三者共库。
- **可复现**：给出真机确定步骤（见 §6）；沙箱因属逻辑层无法复现磁盘错误，已诚实声明。
- **数据**：订阅可从 NAS 的 ABS 导 OPML 重灌；收听进度/统计/收藏无备份则不可追回（app 的 Dexie 数据一直无备份机制，是缺口）。

---

## 1. 事故现象与影响

| 项 | 内容 |
|---|---|
| 现象一（数据清零） | 启动诊断 `[DB Health]` 显示：表结构完整（11 张），但 `podcasts rows: 0`、`episodes rows: 0`、`favorites rows: 0`、`episodeProgress rows: 2`；用户报"收听统计也没了"。 |
| 现象二（升级为打不开） | 导入节目 / 首页订阅全部失败，弹 `订阅失败:UnknownError Internal error opening backing store for indexedDB.open.`；console 内 `indexedDB.databases()` 也被 reject（`UnknownError`）。 |
| 影响 | 订阅、导入、收听数据等核心功能不可用；本地数据疑似丢失，用户决定放弃找回、转为定位根因。 |
| 关键旁证 | `episodeProgress` 残留 2 行而非全空 → 该库不是"全新空库"，更像"被清空/受损后又写入了 2 条进度"。 |

---

## 2. 调查方法

- **多代理并行取证**：为避免单一视角偏差，启 4 个独立子代理分头查不同假设，各自只给"文件:行号 / 实测输出"级证据，最后交叉验证。
- **联网确证**：`Internal error opening backing store` 是特定的 Chromium/Electron 错误，其本质用 WebSearch 核实（不凭记忆）。
- **沙箱实测**：用 Node + `fake-indexeddb` 真跑项目的 Dexie 版本链，验证/排除配置层问题。

| 子代理 | 职责 | 关键产出 |
|---|---|---|
| A（读码·open/版本） | 全项目 `new Dexie`/`indexedDB.open`/版本链/blocked | 代码层唯一 Dexie 实例、版本链健康、主进程不碰 IDB |
| B（多实例/锁·最近改动） | 单实例锁、userData、身份/端口、共库可能 | **发现 background.js 截断 + 三应用共库 + 身份隔离回退** |
| C（文档时间线） | 主开发文档最近若干轮改了什么 | 最后两轮 NAS/UI 不碰 db；曾怀疑 prune（后被证否） |
| D（沙箱复现） | fake-indexeddb 真跑版本链 | Dexie 配置层健康，非真凶；声明无法复现磁盘错 |

---

## 3. 调查过程（事无巨细，含走过的弯路与自我更正）

**步骤 1 · 广搜危险操作**：`grep` 全 src 的 `clear()/delete/deleteDatabase/prune`，命中：`main.js:20 indexedDB.deleteDatabase('yesplaymusic')`、`db.js:230 clearDB()`、`podcast/db.js:98 prunePreviewOrphans`、`updateApp.js:53 deleteDatabase('tracks')`。初看 `main.js` 的 deleteDatabase 像元凶。

**步骤 2 · 读上下文，自我更正**：读 `main.js:18-27` 发现 `deleteDatabase('yesplaymusic')` 包在 `window.resetApp = () => {...}` 手动函数里（console 提示"出问题可输入 resetApp() 重置"），**不会自动触发**；`clearDB()`（`db.js:230`）同为待调用函数。→ **撤回"main.js 自动删库"的初判**。

**步骤 3 · 证否 prune（关键判据）**：读 `prunePreviewOrphans`（`podcast/db.js:98-135`）——只删 `subscribed === false` 的预览孤儿，且**显式跳过**有 `episodeProgress`/`episodeListenStats`/`favorites`/`episodeDownloads` 的节目；再 `grep` 其调用方 → **全项目无任何调用**。而本次 `favorites` 与收听统计 `episodeListenStats` **也归零**，prune 根本不碰这两张表。→ **prune 被排除**（子代理 C 曾凭文档怀疑 B-85 prune，在此被证否）。

**步骤 4 · 看主 session 最近动作**：读主文档末尾——最后两轮是「NAS 就近音源」与「UI 打磨（胶囊按钮/圆角/iOS 开关）」，**均不碰数据库**；并发现 `main.js:48-73` 的 `[DB Health]` 探针是主 session 为排查"用户报告节目丢失"**新加的诊断代码**（注释原话佐证）→ 说明主 session 也已发现丢失、正在查、**尚未定位**。

**步骤 5 · 用户取证升级**：用户在 app console 跑 `indexedDB.databases()` → `rejected: UnknownError`；随后导入/订阅报 `Internal error opening backing store for indexedDB.open`。→ 事故从"数据清零"升级为"**库根本打不开**"，矛头转向 **Chromium LevelDB 文件层**，而非业务逻辑。

**步骤 6 · 四代理并行 + 联网**：据此分派 §2 的四代理 + WebSearch，产出 §4 证据。

---

## 4. 证据

### 4.1 联网确证：这是 Chromium LevelDB 后端层错误

`Internal error opening backing store for indexedDB.open` 来自 Chromium IndexedDB 后端打开磁盘上的 LevelDB backing store 失败。已知高频成因：LevelDB 文件损坏（IO error / "Could not rename file"）、profile/目录损坏、**多实例并发占用**、磁盘满、同步盘（OneDrive）占位锁、权限/杀软。社区与官方通用缓解：重启关闭所有连接、删除该 IndexedDB 目录、**用 `app.requestSingleInstanceLock()` 防多开**。来源见 §附录 B。→ **本质是文件/锁层，与 JS 业务代码无关。**

### 4.2 代码层排除（读码 + 沙箱实测，双证）

**读码（子代理 A）**：
- 全项目**唯一** `new Dexie('yesplaymusic')`（`utils/db.js:7`）；
- 版本链 `v1→v9`（`db.js:11-83`）**单调、无重复、无"同表改主键"** → 不会触发删表重建；
- 主进程（`electron/`、`background.js`）**完全不碰 IndexedDB**（仅用 electron-store 写 JSON）；无 sqlite/leveldb npm 依赖；
- `prunePreviewOrphans` 是普通 `delete`、且**无调用方** → 不可能损坏 backing store。

**沙箱实测（子代理 D，Node + fake-indexeddb 真跑）**：
- 逐行照抄 db.js 版本链，**全新打开稳定到 v9、读写正常**；
- Dexie 4 对"代码版本 < 磁盘版本"走 SchemaDiff **静默兼容、不抛错**（实测 disk 压到 native 110、v9 app 仍 open 成功）；
- 并发两连接升级时 Dexie 4 默认自动关旧连接、**不卡死、blocked=false**。
- **结论：Dexie 配置链健康，非真凶。** 诚实边界：fake-indexeddb 是纯内存逻辑层，**无法复现** Chromium 磁盘 LevelDB 的 backing store 错误（需真 Electron）。

### 4.3 重大发现一：`src/background.js` 源码被截断损坏

子代理 B 实测：`src/background.js` 仅 **504 行**，文件末尾停在半行 `globalShortcut.unregiste`（无闭合分号）；`grep` 全 src **找不到** `new Background()` 实例化、`will-quit`、`app.on('second-instance')`。对比旧构建 `dist_electron/bundled/background.js` **含** second-instance。→ 推断：该文件被某次操作截断/回退、丢了尾部。

**后果**：① 这份源码无法正常构建/运行；② `requestSingleInstanceLock()`（约 :120）实际执行不到 → **单实例保护形同虚设**；③ 无 second-instance → 不会把已有窗口前置、反而放任第二个实例继续启动去抢库。

### 4.4 重大发现二：三套同身份应用共用同一 LevelDB + 身份隔离被回退

- `background.js:113-117`：`app.setName('YesPlayMusicPodcast')` + `app.setPath('userData', %APPDATA%\YesPlayMusicPodcast)`。→ IndexedDB 落在 `…\YesPlayMusicPodcast\IndexedDB\http_localhost_27233.indexeddb.leveldb`。
- 本机至少三个入口都以**同身份 + 端口 27233** 写**同一个库**：① `dev-serve`；② 正式版安装包 `PodPlayer Setup 0.4.10.exe`（productName 只改安装名、**不改 userData**）；③ 最新主构建 `dist_electron/index.js`（6/13）。
- 曾为隔离把开发版改成**独立身份 `PodPlayerDev` + 端口 10766/27244**（见主文档 :2433-2435 "双重独立"实测记录），**当前源码与最新构建已回退**成同身份同端口 → 隔离失效。
- `scripts/start-dev.bat:13` 只 `taskkill electron.exe`，**杀不掉正式版 `PodPlayer.exe`**。

→ **多个同身份进程同时打开同一 `…indexeddb.leveldb`，抢 LevelDB 独占 `LOCK` → 后开者 backing store 打不开。** 与 §4.1 的教科书成因吻合。

---

## 5. 根因分析

| 级别 | 判断 | 依据 |
|---|---|---|
| **确证·排除** | 业务代码 / Dexie 版本链 / prune / upsert **不是元凶** | 子代理 A 读码 + 子代理 D 沙箱实测 |
| **最可能根因（推断）** | 多个同身份 app（dev/正式/构建，皆 `YesPlayMusicPodcast`+27233）共开同一 LevelDB → `LOCK` 争用；或残留进程占锁。`background.js` 截断使单实例保护失效，是放大器 | 子代理 B + §4.1 联网 |
| **未排除（需真机查）** | LevelDB 文件物理损坏（断电/强杀/同步盘 OneDrive 占用/杀软扫描）、磁盘满、userData 权限 | §4.1 列为高频诱因；现场尚未取证 |

**机制链（最可能）**：背景里残留/并存的同身份进程持有 `LOCK` → 新启动的 app 渲染进程 `indexedDB.open('yesplaymusic')` 抢不到独占锁 → Chromium 抛 `Internal error opening backing store`。

**两阶段关系（推断，标注）**：早期"数据清零"可能是 dev 端口漂移/换 origin 连到另一个空库，或 `resetApp()` 被误触（console 显眼提示，排查时极易手滑）；随后多开/残留进程导致 `LOCK` 争用或文件受损，恶化为"完全打不开"。两阶段都指向**多实例/锁/磁盘层**，而非业务代码。此关系为推断，需 §6 真机取证坐实。

---

## 6. 复现

### 6.1 真机确定复现（不口说无凭）

- **复现 A（正式版 × dev-serve 共库）**：先运行已装的 PodPlayer 正式版（它持有 `…YesPlayMusicPodcast\IndexedDB\…27233…leveldb` 的 `LOCK`）→ 不关，再运行 `scripts\start-dev.bat`（同身份同端口同库）→ 第二个 `indexedDB.open` 抢不到锁 → 报 backing store 错。（`start-dev.bat` 只杀 electron.exe、杀不掉正式版，故二者真并存。）
- **复现 C（残留进程，最日常）**：关闭窗口但 `electron.exe`/`PodPlayer*.exe` 进程未退干净（残留持锁）→ 立即再启 app → 同错。

### 6.2 一分钟确认法（区分锁冲突 vs 文件损坏）

1. 任务管理器看是否**同时存在多于一个** `PodPlayer*.exe` / `electron.exe`；
2. **结束全部相关进程**后再启动 app：
   - 错误**消失** → 坐实"多开/残留进程锁争用"；
   - 错误**仍在** → 转查文件层：`%APPDATA%\YesPlayMusicPodcast\IndexedDB\` 下 leveldb 目录是否有残留 `LOCK`、文件是否损坏、该目录是否位于 OneDrive 同步盘。把该 IndexedDB 目录改名移走再启（Dexie 会重建空库）→ 能开 = 那份磁盘库已损坏。

### 6.3 沙箱为何不能真复现（诚实边界）

`fake-indexeddb` 是纯内存 JS 实现，只能验证 Dexie/IndexedDB **逻辑层**（schema 链、版本协商、blocked 语义）；**无法复现** Chromium 磁盘 LevelDB 的 `Internal error opening backing store`（文件锁/损坏/IO），那必须在真实 Electron + 真实 userData 目录上构造（§6.1）。

---

## 7. 数据恢复评估

| 数据 | 能否恢复 | 途径 |
|---|---|---|
| 订阅列表 | **可** | NAS 上的 ABS 有全部 36 档 → 导出 OPML → app 重新导入；或当初导入用的 OPML |
| 收听进度 / 统计 / 收藏 | **大概率不可**（若非 origin/端口问题、且无备份/卷影） | 先按 §6.2 确认是否锁冲突（数据可能仍在原库）；否则查 Windows"以前的版本"/卷影副本 |
| 根因若为"换 origin/端口" | 数据可能仍在旧 origin 的 leveldb 里 | 改回原端口（20201/原约定）后该库可读 |

**缺口**：app 的 Dexie（订阅/收藏/进度/统计）**一直无任何备份机制**（此前 watchdog/NAS 备的是音频，不含 app 数据）。

---

## 8. 修复建议（交主 session，按急 → 缓）

1. **【头等】修复 `src/background.js` 截断损坏**：补回 `new Background()` 实例化、`will-quit`、`app.on('second-instance')`（参考 `dist_electron/bundled/background.js` 旧完整版）。源码不完整本身就是阻断性问题。
2. **恢复并制度化多实例隔离**：测试床 / 开发版 / 正式版 各用独立 app name → 独立 userData → 独立库 + 独立端口，三者永不共库。**完整方案见 `docs/实例隔离规范.md`**（含命名表、端口表、`PODPLAYER_PROFILE` 落地代码、验收）。
3. **加 backing-store 兜底**：`db.open().catch()` 检测 `UnknownError`/`InvalidStateError` → 给用户明确提示 + "安全重建库"引导（而非白屏/卡死）；补 `db.on('blocked')` 与渲染端 `versionchange` 处理。
4. **`start-dev.bat` 进程清理含 `PodPlayer*.exe`**（不只 electron.exe）；**userData 切勿置于 OneDrive/同步盘**。
5. **数据自动备份**：定期导出 OPML（订阅）+ JSON（收藏/进度/统计）到本地文件，实现真正"可溯源/可回退"。
6. **`resetApp()` 降危**：移除 console 显眼提示或加二次确认/改名，避免排查时误触清库。

---

## 9. 预防与方法论沉淀

- **多代理交叉取证的价值**：子代理 C 凭文档曾把"B-85 prune 删库"列为最可疑，但被子代理 A（prune 无调用方、仅普通 delete、不碰 favorites/统计）与子代理 D（Dexie 层实测健康）**证否**。单一视角的"看起来可疑"经独立实证被推翻，根因最终收敛到**无人留意的 background.js 损坏 + 共库锁争用**。
- **分层下结论**：全程区分"确证 / 最可能（推断）/ 未排除"，避免把推断当结论。
- **磁盘层错误别在逻辑层找**：`backing store` 是 Chromium 文件/锁层信号，第一时间应查"多实例/进程/磁盘/同步盘"，而非业务代码。

---

## 附录 A · 四子代理结论摘要

- **A（读码）**：唯一 Dexie 实例；版本链健康不删表；主进程不碰 IDB；prune 无调用方。代码层做不出 backing store 错。
- **B（多实例/锁）**：background.js 截断损坏（504 行、缺 new Background/second-instance）；三套同身份应用（dev/正式/构建，皆 YesPlayMusicPodcast+27233）共库；身份隔离（PodPlayerDev/27244）被回退；start-dev.bat 杀不掉正式版。→ LevelDB LOCK 争用。
- **C（文档）**：最后两轮 NAS/UI 不碰 db；[DB Health] 是主 session 排查"丢失"加的诊断。曾疑 prune，被证否。
- **D（沙箱）**：fake-indexeddb 真跑——版本链全新打开正常到 v9、Dexie4 版本不匹配静默兼容、并发不卡死。Dexie 配置非真凶。无法复现磁盘错（诚实声明）。

## 附录 B · 联网来源

- electron#39132 — Internal error opening backing store for indexedDB：https://github.com/electron/electron/issues/39132
- electron#42645 — Internal error opening backing store for indexedDB.open：https://github.com/electron/electron/issues/42645
- Chromium issue 340398745 — IndexedDB LevelDB backing store open failure：https://issues.chromium.org/issues/340398745
- Obsidian 论坛 — Internal error opening backing store for indexedDB.open：https://forum.obsidian.md/t/internal-error-opening-backing-store-for-indexeddb-open/91070

## 附录 C · 关键代码位置索引

| 位置 | 内容 |
|---|---|
| `src/utils/db.js:7` | 唯一 `new Dexie('yesplaymusic')` |
| `src/utils/db.js:11-83` | 版本链 v1–v9（健康） |
| `src/utils/db.js:230` | `clearDB()`（手动、无调用方） |
| `src/utils/podcast/db.js:98-135` | `prunePreviewOrphans`（无调用方、不碰 favorites/统计） |
| `src/main.js:18-27` | `window.resetApp()`（手动重置：清 localStorage + deleteDatabase + cookie） |
| `src/main.js:48-73` | `[DB Health]` 诊断探针（主 session 为排查丢失新加） |
| `src/background.js:113-117` | `setName('YesPlayMusicPodcast')` + userData 重定向 |
| `src/background.js`（约 :120 / 末尾 :504） | `requestSingleInstanceLock()`；文件在 `globalShortcut.unregiste` 处截断 |
| `scripts/start-dev.bat:13` | 仅 `taskkill electron.exe` |
| 主文档 `播客改造开发文档.md:2433-2435` | 开发版独立身份 PodPlayerDev/10766/27244（已被回退） |
