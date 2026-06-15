# PodPlayer · TODO 与 BUG 总清单（持久·防记忆丢失）

> 2026-06-14 汇总 + 06-15 更新(沉浸式播放页 + 打包测试版 + **周末稳定性专项审查 24 条确认 bug 并入**，见下方专属段)。
> 单一参考清单;具体细节仍以各源文档为准。状态:🔴open / 🟡pending-verify(已做待真机验) / 🔵in-progress / 🟣paused / ✅done(留痕一轮后删)。
> ⚠️ 用户提醒:清单部分条目与现实有出入(碰到再据实核对、勿盲信);**把基础功能做好最重要**。

---

## ✅ 近期已完成（留痕一轮后删）
**2026-06-15 本会话（沉浸式播放页 + 打包测试版）**
- ✅ **沉浸式播放页 P0 + 6 轮批注打磨**：背景 C 混合(coverPalette 三色)/大封面 scale/胶囊进度/三组控制(倍速·列表·睡眠 ｜ 三大金刚 ｜ 标记·收藏·音量)/音量点击弹窗/点击进退冲突修复/进度标记刻度·缓冲·长按充能反馈·彩虹猫**两端一致**。分支 `feature/immersive-player` 已 push，**待用户验收 → 进 P1**。细节见主文档「沉浸式播放页」段。
- ✅ 打包**正式版(prod=PodPlayer 身份)** 测试包 → `D:\MyYesPlayerMusic\打包版本`(portable 免安装 + nsis 安装包)，供他人测试；与开发版(PodPlayerDev)零冲突。

**2026-06-14 上会话（已稳定，下轮可删）**：实例隔离根治+验收+并 master / 数据善后(relink·备份·resetApp) / 改名+品牌+README / Lucide 图标统一+点击反馈 / NAS hover 提示 / 进度条提示防越界 / 呼吸灯 v2(已满意)。

---

## 🐞 BUG

### P1
- 🔴 **机核等超大列表 hover 慢半拍 + 进入卡顿** — _startHydration 全量水合钉死主线程;唯一根治=窗口虚拟化(需专开一轮先对抗式设计;先解自绘滚动条/行高)。[known-bugs / 主文档 F1]
- 🔴 **统计页排行重排动画仍有问题** — 已连修 9 轮(v1.5.7);现象待细说,先定位路径(toggle=setRange vs 进页=enterWithAnimation),用 scripts/stats_toggle_repro.js 复现。[known-bugs]

### P2
- ✅ **统计「最近一周」>「全部」(如岩中花述)**（2026-06-15 修·分支 `feature/perf` round2）— 根因坐实:`resetEpisodeListening`(重播已听完单集)清 `episodeListenStats.bits/listenedSec` 却不动 `listenDaily` → 听完重听后「全部」(读 listenedSec)被清零重数、「周」(读 listenDaily.listenedSec)仍含旧值 → 周>全部。**修**(终极):「全部」= `max(Σ episodeListenStats.totalPlayContentSec, Σ listenDaily.contentSec 全天)`,「周」= listenDaily 7 天。因周⊆全天⊆全部 → **数学保证 全部≥周**(与两表是否一致无关),取 max 还兜住两表漂移。**已用用户真实备份模拟验证:旧口径 2 档违例→纯 contentSec 1 档→本方案 0 档**;另确认 totalPlayContentSec 历史一直在填、数据未丢。**待真机最终确认**。[listening.js getListenStatsByPodcast]
- 🔴 **[R13] 首页节目封面错/空白(d6325f8=假修复·方向错·已重开)** — 思文败类首页≠详情**仍没好**(d6325f8 只给单个节目加 coverFeedUrl、commit 自标边界未覆盖=没修；换 Nice Try 复现)+ Nice Try 首页空白。两点结构缺陷:①封面错误回落「目录旧 logoURL」(已订阅本应优先 DB coverUrl，但靠 subscribedMap[name] 反查、name≠RSS title 即失效，同 B56-5)；②PodImage 加载失败只 opacity 隐藏、无占位=整块空白。**根治(治本·一处统一·别每组件各写)**:①统一取值链 DB coverUrl→目录 logoURL→内置占位；②name 归一化再查/补 feedUrl/Apple id 关联本地库；③PodImage 内置默认占位+onImgError 显占位不隐藏(下载/历史/收藏/搜索/详情/订阅/播放条全局生效)；④封面 URL 统一 http→https。**本轮不修(用户 2026-06-15 驳回先消化)**·详见 `docs/BUG审查.md` R13 + [[known-bugs]]/[[debugging-methodology]]「PASS≠fixed」。真机验收:思文败类==详情、Nice Try 有封面、带标点名节目都对、故意断一个 URL 看是否出占位。
- ✅ 头像二级菜单弹出锁全局滚动（2026-06-15 修·`fix/buglist`）— `ContextMenu.openMenu` 加 `lockScrolling=true` 默认开关、头像菜单传 false 不锁；其余右键菜单默认锁、行为不变。**待真机**。
- 🔴 单集列表全量渲染无虚拟化(与机核同源,大档建数百行 DOM)。
- ✅ 「为你推荐」reroll 不换/池只剩 3（2026-06-15 修·`fix/buglist`）— 排除拆 hardExclude(已订阅)/softExclude(其它栏+**上一批 forYou**)，池不足从非订阅全池回填。reroll 真换一批 + 不再只剩三个。与操作#5 不同问题。**待真机**。
- ✅ 单集详情「加入播放列表」按钮加入后图标过大 + 不能再点移出 [B67-BUG-5]（2026-06-15 修·`fix/buglist`）— 改 `isQueued`(真实队列成员)驱动的持久 toggle + `check-circle` 图标(有边界);点击可移出。**待真机**。
- ✅ last.fm 子窗 nodeIntegration+webSecurity:false 历史高危（2026-06-15 修·`fix/buglist`）— `background.js` new-window 删整段 last.fm 高危内嵌子窗死分支，统一 `shell.openExternal` 走系统浏览器。behaviorChange=false。**待真机**(scrobble 仍正常)。

### P3（低/边缘/记录）
- 🔴 搜索栏再右移 + 宽度再缩对齐 navbar。[B67-BUG-7]
- 🔴 subscribedMap 以节目名为键→同名节目互相覆盖(评估暂不修)。[B56-5]
- 🔴 searchLocalEpisodes 全表 JS filter 无索引。[B69-F4]
- 🔴 本地搜单集混入未订阅预览(语义待定)。[B69-L1]
- ✅ 播放心跳每秒 3 写 Dexie(进度+收听 stats/daily)(功耗) [B69-F5]（2026-06-15 修·分支 `feature/perf` round2）— Player 端内存累积每秒 tick、每 5s 批量 `tickListenBatch` 落盘(写事务 3/秒→~1.4/秒、bits 整段 put 每 5s);切集/暂停/退出 flush;进度仍逐秒。语义不变(逐位去重/completed/daily 全保留)。**待真机验证**。
- ✅ _updateMprisState 监听器永不移除 [B69-L2] —— 即 `saveLyricFinished` 监听，**已在审P2-5 修**(removeAllListeners+once，提交 `f3a7b5b`)。
- ✅ Player.vue beforeDestroy 漏清 closeQueuePanel [B69-L3] —— **沉浸式轮已补**(beforeDestroy 调 closeQueuePanel)。
- 🔴 软删记录(subscribed:false)长期堆积(数据量小)。
- 🔴 重启时下载中断成孤儿任务(edge case)。
- 🟡 统计 toggle 残留帧致差集闪现 — 疑 v1.5.7 已根治,留作回归边界。

---

## 🔬 周末稳定性专项审查 · 新增确认 bug（2026-06-15，本轮只记录未修）

> 来源 `docs/审查报告-周末稳定性专项.md`(对抗 session，4 子 agent 找 buglist 之外的新问题)。本 session 用 **24 个核验 agent 逐条对照真实代码核实 → 24 条全部 confirmed**(0 refuted/0 partial)，每条证据(file:line)见核验记录。**本轮按用户要求只记录、不修**。标 **[待真机]** 者=代码事实已确认、实际用户影响待真机验证。修复性价比序见报告 §三：**P1-1 / P1-2 成本极低收益极高，可任意一轮顺手修**。

### 🔴 P1（8 条，全部确认）
- ✅ **[审P1-1]**（2026-06-15 已修，提交 `ecd422f`）下载 `writeStream` 补 `.on('error')` + 统一失败收尾 `failDownload`(settled 去重 + 停 res/writeStream 两端流 + 删半成品 + 上报 download:error) + 完成信号改挂 `writeStream 'finish'` + 主进程 `uncaughtException`/`unhandledRejection` 兜底(只 log)→ 磁盘满(ENOSPC)/目录不可写(EACCES/ENOENT)不再崩主进程、单集不再卡 downloading。原 `podcastDownload.js:146`。electron:build 通过 + 对抗审查无回归。
- ✅ **[审P1-2]**（2026-06-15 已修，提交 `f3a7b5b`）每秒/拖动/切歌三处 `saveEpisodeProgress` 均补 `.catch(()=>{})` + `main.js` 加全局 `window.unhandledrejection`(log + preventDefault) → IndexedDB 异常态不再每秒刷未捕获 rejection、不被当致命错误。`Player.js:249/341/1408` + `main.js`。
- 🔴 **[审P1-3]** 全工程无 `powerMonitor`(suspend/resume) + 无 `mediaDevices.devicechange` → 睡眠唤醒本地/CDN 源可能卡死、下载卡死无重试、拔输出设备(蓝牙断)不回落默认。`src` 全工程零命中。
- ✅ **[审P1-4]**（2026-06-15 已修·分支 `fix/buglist` → 并 master）退出优雅 flush：`ipcMain.js` 新增 `gracefulExit(win)`，真正退出前 `send('app:before-exit-flush')` → 渲染端 `ipcRenderer.js` `player.flushBeforeExit()`(收听缓冲+最后进度 flush)+`db.close()` → `send('app:flush-done')` ack；主进程 `ipcMain.once('app:flush-done')`+`setTimeout 800ms` 兜底后 `app.exit()`(绝不卡死退出)。三处"直接退出"分支(exitAsk/exitAskWithoutMac/close.exit)接入；minimizeToTray 不动。`Player._flushListenBuf` 改返回 Promise + 新增 `flushBeforeExit`。1 调查+2 对抗核验 SAFE-TO-MERGE。eslint 0。**待真机验证**(✕/退出能正常退、退出前进度/收听落盘)。MVP 边界：tray/mpris/background 裸 app.exit 二期统一接入(行为未回归)。
- ✅ **[数据安全·maybeAutoRestore 放宽]**（2026-06-15 已修·同上）原只判 podcasts 空、被"先手动导 OPML"绕过 → 新增"合并恢复"：订阅在但**进度+统计都空**且备份有 → confirm → 只 bulkPut 历史五表(不 db.delete、不动订阅)。守卫下沉进 `mergeRestoreHistoryFromLatestBackup`(进度/统计非空则拒绝、留 force 逃生口)+五表一个 `db.transaction` 原子包裹。`backup.js`+`main.js window.mergeRestoreHistory`。**正好自动救回用户重订阅后统计=0**。
- 🔴 **[审P1-5]** 物理媒体键(MediaPlayPause/Next/Prev)未注册 globalShortcut，仅 `Player.vue` 页内 keydown(聚焦才有效) → 最小化到托盘用媒体键控制大概率失灵；无系统"正在播放"卡片。`globalShortcut.js`/`shortcuts.js`。[待真机]
- ✅ **[审P1-6]**（2026-06-15 已修，提交 `f3a7b5b`）RSS `fetchText` 加 `maxContentLength`/`maxBodyLength=25MB`(超限 axios 抛错→IPC try/catch 接住返回 {ok:false} 优雅降级)。`podcastFetch.js`。
- 🔴 **[审P1-7]** `parseRss` 渲染端主线程**同步**执行，大 feed 数百 ms 独占主线程，批量刷新/大 OPML 导入掉帧。`service.js:41/131/176` + `rssParser.js:62`。建议移 Worker/分片。[待真机]
- 🔴 **[审P1-8]** 沉浸页背景叠两层重型滤镜(底层封面 `blur(64px)` + frost 全屏 `backdrop-filter:blur(24px)` + 噪点 mix-blend) → 页内动画(封面 scale/进度/nyancat/充能)触发 frost **每帧重采样模糊**，低端/4K 发烫掉帧。`Player.vue .imm-bg-cover/.imm-bg-frost`。建议去二次 backdrop-filter 或降半径。[待真机·新功能引入]

### 🟠 P2（11 条，全部确认）
- 🟠 **[审P2-1]** mediaSession 从不设 `playbackState` → 暂停后系统卡片仍显"播放中"，部分 Windows 版不展示卡片。`Player.js` _initMediaSession/_updateMediaSessionPositionState。[待真机]
- 🟠 **[审P2-2]** mediaSession handler 注册两遍，生效的 `Player.vue:1788` 版把 play/pause **都绑 playOrPause(toggle)** → 系统已暂停时发 pause 反被 toggle 成播放。`Player.js:862` vs `Player.vue:1788`。[待真机]
- 🟠 **[审P2-3]** 主进程无 `nativeTheme.on('updated')`，运行时切系统深浅色靠渲染端 matchMedia → "自动"模式下应用主体+托盘图标不实时跟随、常要重启。`common.js`/`store/index.js`。[待真机]
- ✅ **[审P2-4]**（2026-06-15 已修，提交 `86d5a3b`）新增 `saveWindowState()`：最大化只记 `isMaximized:true` 保留 prev bounds、非最大化存真实 bounds；createWindow 末尾按 isMaximized 调 `maximize()` 恢复。最大化不再污染还原尺寸、最大化状态可恢复。`background.js`。
- ✅ **[审P2-5]**（2026-06-15 已修，提交 `f3a7b5b`）`saveLyricFinished` 改 `removeAllListeners + once` → 监听不再每次切歌累积、无 MaxListeners 警告。`Player.js`。
- ✅ **[审P2-6]**（2026-06-15 已修，提交 `f3a7b5b`）`upsertEpisodes` 整体包 try/catch(失败 log + return undefined 不抛，防御纵深)；成功路径不变。`db.js`。
- ✅ **[审P2-7]**（2026-06-15 已修，提交 `86d5a3b`）parseRss 加 item 数上限(`MAX_ITEMS=50000`，纯防失控、不丢真实集) + 单集 description `capLen 100KB`(挡内嵌大 base64 灌爆 DB/v-html)。`rssParser.js`。
- ✅ **[审P2-8]**（2026-06-15 已修，提交 `86d5a3b`）parseOpmlLenient 加 `8MB` 输入护栏(`scan=slice`)→ 防 `[^>]*` 在数十 MB 畸形 OPML 上 O(n·m) 回溯卡 UI；主 DOMParser 路径不变。`rssParser.js`。
- ✅ **[审P2-9]**（2026-06-15 已修，提交 `d4d0df4`）OPML 导入串行改并发 `runLimited(≤5)` → 2000 档不再不可用；进度改完成计数。`service.js`。(source 经核为本文件设计 manual 即涵盖 OPML，不引入新值；审查 false-positive)
- ✅ **[审P2-10]**（2026-06-15 已修，提交 `9c78b43`）`tickListen` 两表 R-M-W 各用 `db.transaction('rw',table,…)` 包住 → 同表 rw 事务自动串行、并发 tick 不再丢更新；listenDaily 仍独立 try/catch(隔离不变)。统计行为不变。`listening.js`。对抗审查 CLEAN。
- ✅ **[审P2-11]**（2026-06-15 已修，提交 `86d5a3b`）NAS `ensureItems`/`ensureEps` 加在途去重(并发复用同一 promise) + 按 `total` 分页拉全(原 `limit=500` 漏档；满页无 total→Infinity 靠短页 break 收尾)。`nasBridge.js`。[NAS 待真机]

### 🟡 P3（5 条，全部确认）
- 🟡 **[审P3-1]** 关闭策略分散 5 处 + Mac `exitAsk` 用 `minimize()` 而非 `hide()`(Windows 路径正确，Mac 托盘语义不一致)。`background.js`/`ipcMain.js:201-218`。
- ✅ **[审P3-2]**（2026-06-15 已修，提交 `f3a7b5b`）多显示器越界判定 `- bounds.height` 改 `+ bounds.height` → 副屏窗口重启不再被拉回主屏。`background.js`。[改后逻辑对，定位仍宜真机多屏验]
- ✅ **[审P3-3]**（2026-06-15 已修，提交 `f3a7b5b`）`coverColor.js`/`coverPalette.js` 取色缓存加 LRU(cap 100，命中提最新+超量淘汰)，套 `episodeCache.js` 模式。
- ✅ **[审P3-4]**（2026-06-15 已修，提交 `86d5a3b`）NAS 心跳加模块级 `beforeunload` 卸载清理 → 渲染端重载不再叠加游离 interval。`nasSource.js`。
- ✅ **[审P3-5]**（2026-06-15 已修，提交 `f3a7b5b`）Howl 补 `onplayerror`：NAS 源→切 CDN、否则提示+跳下一集，播放期失败不再静默卡住。`Player.js`。

---

## 🔧 操作逻辑与功能符合性审查（2026-06-15）

> 来源 `docs/审查报告-操作逻辑与功能符合性.md`(对抗 session，4 agent 查"交互逻辑/图标-文案-意图是否相符")，共 17 条。本轮**修了 8 条**(提交 `2708a9d`，均 electron/渲染 build + 8 agent 对抗审查；#3/#10 经审查补正)。

### ✅ 本轮已修（8）
- ✅ **#3**（★数据安全）收藏入口补 `podcastId`(=feedUrl)：原 **7 处**收藏构造 track 不带 podcastId → 写空 → `prunePreviewOrphans` 把"收藏过单集的未订阅节目"连同单集静默删。补 podcastDetail×2 / episodeDetail / downloadsList / favoritesList / **historyList / searchPodcast**(后两处审查补出)。
- ✅ **#11** 重订阅已存在档改"合并"(保留 newCount 角标 / 原 source / 已存在字段)，不再 put 整覆盖清零。`service.js`。
- ✅ **#10** OPML 导入按 `cleanUrl` 归一化去重 → "成功 N 档"不再虚高(审查指出尾斜杠漏判已补)。`service.js`。
- ✅ **#5** forYou reroll 排除集并入「新上线」→ 三栏不再撞车。`home.vue`。
- ✅ **#2** 「按最近收听」不显方向箭头(其固定多键序不读 sortDir)→ 消除"箭头翻转列表不动"矛盾。`podcastLibrary.vue`。
- ✅ **#14** 「按最新更新」lead 图标 `arrow-down-small-big`→`refresh`(中性)→ 消除与右侧方向箭头矛盾。`podcastLibrary.vue`。
- ✅ **#13** 详情页剩余时长 `Math.max(0,…)` → position 超 RSS 时长不再显示 "-1:-50"。`podcastDetail.vue`。
- ✅ **#17** 沉浸页弹窗(倍速/队列/睡眠/音量)就地重定义主题变量为深色 → 主题隔离，不再随浅色模式漂白。`Player.vue`。

### 🔧 待办（8，本轮未做）
- 🟠 **#4** 二级页 `discoverList`「换一批」无 shuffle(hot/new/treasure 确定性返回)→ treasure 点了完全不变；hot/new 叫"换一批"语义不当(应"刷新")。`discover.js getSectionFull`。
- ✅ **#7** 本地"隐藏/显示播放器"快捷键不生效（2026-06-15 修·`fix/buglist`）— `menu.js` Controls 子菜单补 minimize 菜单项(accelerator 取本地键、click 做窗口 hide/show)，改键后重建菜单即时生效。**待真机**。
- ✅ **#6** treasure 切片口径不一致（2026-06-15 修·`fix/buglist`）— `reshuffleSection` treasure 分支改先 `slice(TREASURE_START)` 再排已订阅,与 getSectionFull/splitSections 同序(该分支当前不可达,预防性对齐)。
- ✅ **#8** repeat 改 **off↔one 两档**（2026-06-15 修·`fix/buglist`）— `switchRepeatMode` 改 off↔one、启动归一化遗留 `'on'→'off'`;图标模板天然正确无需改;核验确认无音乐回归('on' 分支退化为无害死代码)。**待真机**。
- ✅ **#9** 未加载 howler 时 后退15/前进30 静默无反应（2026-06-15 修·`fix/buglist`）— `Player.js seek` 加 playOrPause 同款兜底(load+autoplay)，**不带 startAt → 保留续播位**。**待真机**。
- ✅ **#12** 导入订阅后发现页绿勾不即时（2026-06-15 修·`fix/buglist`）— 粘贴RSS/OPML/单档三处订阅成功补 `commit('addSubscribedPodcast')`(键=title、值=feedUrl);`importOpmlText` 多返回 `subscribed[]` 供逐条 commit。**待真机**。
- 🟡 **#15** 快捷键冲突检测/保存反馈 — **#2a 已修**(2026-06-15·`fix/buglist`：saveShortcut 同列撞键检测+修饰键归一化,撞则拒存提示)；**#2b 待办**:globalShortcut.register 占用/非法键静默 false 无回馈(需 on→handle 通信契约改,med)。
- ✅ **#16** NAS「测试连接」总开关关闭时恒报失败（2026-06-15 修·`fix/buglist`）— 新增 `nas:probeActive` IPC(不看 enabled 只测可达) + `testNasReachable()`，settings 改用之;`testNasConnection`(Navbar 手动重连，更新 nasAlive)保留不动。**待真机**。

### ⚪ 已闭（非 bug）
- **#1** 后退15/前进30 用 `previous`/`next` 三角图标 —— **用户 2026-06-14 决定保留不换**(非命名错误，是选型)。

---

## ✅ TODO

### P1
- 🟡🔜 **NAS 订阅托管 + 智能回收** — 声明式 + 对账模型：订阅成功自动托管到 ABS/NAS(autoDownload + 下最近100期)、6 个月未听冷藏(删 NAS 单集留最近1集+所有收藏)、取消订阅 7 天宽限后删整档、首连新 NAS 差异对账(只动我订阅过的)。执行提示词=`docs/NAS订阅托管-执行提示词.md`、设计=`docs/NAS订阅托管方案.md`。
  - **✅ P0 已落地（2026-06-15·分支 `feature/nas-handoff`·未并 master）**：订阅成功 fire-and-forget 托管到 NAS（已存在 PATCH / 不存在 POST 创建+autoDownload）+ 无 NAS 全程降级 + `settings.nasHandoffEnabled` 可回退开关。**P0 走路 A**(靠 autoDownload、不放量 download-episodes/DELETE)。2 对抗核验 SAFE-TO-MERGE、eslint 0。`nasBridge.js`/`nasSource.js`/`service.js`/`initLocalStorage.js`/`settings.vue`。
  - **⚠️ 放量前必做真机 ABS 实测**：① `POST /api/podcasts` body 形态 + folder 解析 + admin/update token 权限；② 路 A 坐实——autoDownload 实际抓几集？不足「最近 100 历史」则 P1 接 `download-episodes`（**记账：别误以为 100 集已落地**）。实测通过→并 master。
  - **P1+ 待做(规格已备 `docs/NAS订阅托管-P1规格.md`·待 P0 实测过后落地)**：声明式对账(启动/恢复/每日/操作后即时·断联跳过恢复全量)、取消订阅 7 天宽限删整档(DELETE ?hard=1)、6 个月冷藏、多设备「仅本机/共享」开关、首连差异对账、README 教程。破坏性四闸=feature-flag(默认关)+宽限+多设备 scope(默认 local)+`nasDestructiveArmed` dry-run gating(默认关)；时间戳存 `podcasts.nasRemoveAt`(非索引免升版本)；契约收口于抽取的 `ensureManaged()`(随 P0 实测对齐一处)。
- 🟡 **NAS P3 中途掉线续播** — 代码已落地(并入 master 3b1db90),**待真机断网验收**(≤5s 续 CDN/误差<2s + NAS 关闭态核心回归)。
- 🔴 桌面通知(新单集/下载完成,须合 Windows 通知框架)。
- 🔴 托盘菜单 + 任务栏缩略图三键(上一首/暂停/下一首)。
- 🔴 听完自动清理已下载单集释放空间。
- 🔴 我的下载页显示存储占用(仅提示)。
- 🔴 播放 bar 进度条用在播单集封面主色(已有 getCoverColor)。

### P2
- 🟡 机核 hover CHUNK→24 真机验收(残留则调 16)。
- 🔵 **性能优化路线(2026-06-15 全代码库审计后更新·分支 `feature/perf`)** — 详见 [性能审计报告](性能审计报告.md)(原始 57→对抗核实存活 56;3 高/10 中/41 低)。新落地序:①数据层「整档重复读」(podcasts 冗余 `latestPubTime` 去 `getLatestEpisodeTime` 整档读 + episodes `[podcastId+pubTime]` 复合索引免内存 sortBy + 统计页去重全表扫,**性价比最高·含 schema bump**)→②B69-F5 心跳降频(每秒 3 写 Dexie→节流)→③刷新条件请求 ETag/304 + shownotes 预取节流→④F1 真窗口虚拟化(专开一轮)→⑤审P1-7 parseRss 移 Worker。原 L1→L2→F2→L3 内存缓存路线并入④之后。
- 🔵 定期 OPML+JSON 自动备份(userData\backups 已就绪,定期导出待做)。
- 🔴 **NAS 源节目「第三大板块」** — navbar 第三板块(首页/我的订阅之外),排版区别于二者(样式未定);是 nas §10 #2「我的NAS栏」升级设想。用户 2026-06-14 提,优先级低、设计未定。
- 🔴 NAS-在档标识(#4:单集/节目「NAS 上有」呼吸点,需设计,别复用来源点)。
- 🔵 NAS 图标黄(慢)态 + 长断联换 wifi-password 图标 + 自动重试/原因提示(#7)。
- 🟡 沉浸式播放页：**P0 已完成**(分支 feature/immersive-player，6 轮打磨，已 push、待用户验收)；剩 **P1**(全屏 maximize+隐顶栏 + ESC 单击退/双击最小化 + 顶部跟随鼠标退出气泡 + 快捷键)、P2 动态流体背景、P3 图标 FLIP 飞入飞出。
- 🔴 设置页完善(导出收听数据 CSV/JSON、全局媒体热键、同时下载集数1-10 UI、键盘可达)。
- 🔴 睡眠「本集结束」与自动续播队列边界。
- 🟣 多源资源池·Apple 官方榜 adapter(首页板块,paused)。

### P3
- 🔴 重订阅 **15/34 下载未挂回**(文件在 PodPlayerDev\podcasts,需要时精确挂回)。
- 🔴 OPML 重订阅 **28 档 vs ABS 36 档**,差 8 档待核对。
- 🔴 **自动更新源 + in-app GitHub 链接**仍指 qier222/YesPlayMusic(你说后面统一改)。
- 🔴 承重标识彻底自托管/换 logo(Dexie 名/userData 身份/迁移前缀/UA/logo 资源)。
- 🔴 从 NAS 下载(#6,局域网更快,增强)。
- 🟣 首页 NAS 来源板块(#3,留接口,paused)。
- 🔵 清理 NAS 临时调试物(window.podNas 已删,剩余随设置页/图标落地清)。
- 🔴 播放音量渐入(久未播+音量>50% 时 3s 渐大)。
- 🔴 发现页缓存大方向评估(封面/信息/单集/音频)。
- 🟣 多源发现资源池整方案(paused,**唯一阻塞=注册 PodcastIndex 免费 key**)→ ②命中率spike / ③adapter+解析链 / ④搜索双源 / ⑤推荐池扩容 / ⑥RSSHub兜底。
- ✅ 音质(musicQuality) dormant mutation 删除（2026-06-15·`fix/buglist`）— 删 `mutations.js changeMusicQuality`(无调用方);保留 state key + initLocalStorage 种子 + track.js 读路径(网易云 legacy 不回归)。
- 🔴 统计动画 v2「有等待」路线 git 锚点待确认锁定(版本溯源记账)。

---

## 关键状态锚点（接手先看）
- 分支:沉浸式在 **`feature/immersive-player`**(off master、已 push、待用户验收后并入);**下一轮 NAS 将切 `feature/nas-handoff`**;master=`c2cd29d`,仓库 `Fuji-021/PodPlayer`。
- 实例隔离:prod=PodPlayer/10754/27232 · dev=PodPlayerDev/10755/27233/devserver20201 · sandbox=PodPlayerSandbox/10756/27234/devserver20202。启动:scripts/start-dev.bat / start-sandbox.bat。
- 数据:用户真实数据在 dev(PodPlayerDev/20201);进度/统计/收藏曾因事故不可恢复、现有自动备份兜底。
- 打包:**正式版(prod=PodPlayer 身份)** 与 dev-serve 零冲突;**勿打包 dev 身份**。2026-06-15 已打 0.4.10 测试包(portable 免安装 + nsis 安装版)→ `D:\MyYesPlayerMusic\打包版本`;命令 `vue-cli-service electron:build -p never -w`(Node16 路径、**不带** NODE_OPTIONS=--openssl-legacy-provider，Node16 不认会 exit 9)。
- 关联记忆:[[known-bugs]] [[nas-feature-branch]] [[perf-optimization-goal]] [[dev-environment]] [[versioning-rules]] [[resource-pool-plan-status]] [[discover-redesign-spec]]。
