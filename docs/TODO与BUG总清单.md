# PodPlayer · TODO 与 BUG 总清单（持久·防记忆丢失）

> 2026-06-14 汇总 + 06-15 更新(沉浸式播放页 + 打包测试版 + **周末稳定性专项审查 24 条确认 bug 并入**，见下方专属段)。
> 单一参考清单;具体细节仍以各源文档为准。状态:🔴open / 🟡pending-verify(已做待真机验) / 🔵in-progress / 🟣paused / ✅done(留痕一轮后删)。
> ⚠️ 用户提醒:清单部分条目与现实有出入(碰到再据实核对、勿盲信);**把基础功能做好最重要**。
>
> ⚠️ **2026-06-20 审查 session 全局核对（请主 session 据此更新正文 + 留痕一轮）**：
> 1. **文末「关键状态锚点」严重过时**：`master=c2cd29d`、「沉浸在 off-master 分支」、「下轮 NAS 切分支」均不实——实际 **master 已并入沉浸页 P0/P1 + NAS 托管 P0/P1 + 全部审查修复（最新 `ee9d29d`）**。请据实更新分支/commit 锚点。
> 2. **NAS 暂停开发（用户 2026-06-20 定）**：维持主 session 上次修改现状、不再推进。TODO 的「NAS 订阅托管 P1 放量」「中途掉线续播」「第三板块」「从 NAS 下载」等转 🟣 暂停。
> 3. **「所有节目只剩 10 集」已三证查清+修复**（开发文档 06-19 轮 + `c6be7bc`/`9eef483`/`ee9d29d`），可记 ✅：三因叠加——① DELETE 缺 `?hard=1`=软删（只删 DB 不删盘文件、容量没释放）；② evict 用 item.size **缓存**（虚高 485GB vs 真实 59GB）判 total 永远超限 → 每轮删到 FLOOR=10 死循环；③ wifi 标识只用 guid 匹配（老集无 guid）显示残缺。修：hard=1 + 真实大小复核 + trim_per_podcast + guid∪url 双路。**待真机最终确认**（rescan 复活软删集、容量真释放、不再死循环）。〔审查 session 更正：我「evict 删库」最初方向对、上轮因 wifi 修复一度认错过头——实测证明 evict 确实删了，机制是 item.size 缓存虚高、非 freed=0。〕
> 4. **新增待录 BUG（本轮审查发现）**：单集详情页「播放」+ 节目详情页「订阅到我的」按钮，**封面取色失败/无封面时 `opacity:0` 永久隐形**（`a2ced91` 引入；`.ready` 门控仅 `getCoverColor` 非空才置 true）。修：取色失败也置 `*BtnReady=true` 回落默认底色（同 R13「别把可见性绑死取色成功」）。建议 **P2**。
> 5. 审查 session 上轮提的 UI 4 项主 session 已处理（进入沉浸左右对称 / tooltip 统一 / 单集双击播放 已做；沉浸页字色随深浅模式 **试后否决**、改回固定深色，合理）——可在对应段补 ✅ 留痕。

---

## ✅ 近期已完成（留痕一轮后删）
**2026-06-23~24 本会话（设置/播放/导航/资源池/发现页 一连串打磨 + 0.4.11 发布）**
- ✅ 设置页：下拉框随字收窄(width:auto+max160)、播客改造项 i18n(48+key×4 包 en/zh-CN/zh-TW/tr)、托盘图标对齐外观(🌞🌚)、NAS 文案弱化、提示/标题主次分明、快捷键名/连接历史等补 i18n。
- ✅ 进度条：时间满 1 小时进位「时:分:秒」(formatTrackTime)；**重开软件进度条直接显示上次进度**(vue-slider 3.2.24 无 refresh()=空转 → 改 `:key` 重挂，底栏+沉浸页)。
- ✅ 导航滚动：跨页统一复位滚动到顶部(App.vue 进场钩子)；我的订阅返回保留滚动位(keepAlive+restore)；**点首页节目进详情"旧页一闪"根治**——两个并存 router-view 合并为单 RV + keep-alive:include(唯一 transition、out-in 真正生效，缓存集合等价、零回归)。
- ✅ 资源池"连接失效"根治：`resolveAndFetch` **逐候选真抓、返回第一个能抓通的源**(自带→Apple→iTunes 按名→PodcastIndex)，自愈《她山石》《旺仔信箱》；接入 **PodcastIndex**(主进程 searchIndex sha1 鉴权 + resolveFeedByIndex + `podNameMatch` 兼容"不开玩笑 Jokes Aside"双语名 + 软耦合 + 设置页 key/secret 输入 UI)。失效页返回改"返回上一级"。
- ✅ 发现页：热门/新上线 **去「换一批」改分页**(确定序 + keepAlive，分页条钉死页脚、任意页互跳全程不动、末页提醒在分页条上方、返回不重排)。
- ✅ 加载动效：新增可复用 `BouncingDots`(三点波浪跳动)→ 详情单集载入 + 搜索 + 发现页二级页 + 首页榜单 全部替换静态"加载中"文案。
- ✅ **打包发布 0.4.11**：版本 0.4.10→0.4.11，`electron:build-win` 出 portable+nsis → 复制到 `D:\打包版本`；创建 GitHub Release **v0.4.11**(资产连字符命名匹配 latest.yml=自更新链路可用)。
- 〔清单核对发现以下旧条目实已完成：**#2b** globalShortcut 失败回馈(渲染端已接 toast)、**B67-BUG-7** 搜索框右对齐(Navbar 已做、剩 px 待真机)、**操作#4** 二级页换一批(已被分页取代)、**C3 播放音量渐入**(早前会话已做)、**单集列表虚拟化**(F1 方案C 已落地待真机)、**下载孤儿**(.part+sweep 已治)。〕

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
- ✅ 单集列表虚拟化(F1·方案C 固定行高窗口虚拟化已落地·待真机)。
- ✅ 「为你推荐」reroll 不换/池只剩 3（2026-06-15 修·`fix/buglist`）— 排除拆 hardExclude(已订阅)/softExclude(其它栏+**上一批 forYou**)，池不足从非订阅全池回填。reroll 真换一批 + 不再只剩三个。与操作#5 不同问题。**待真机**。
- ✅ 单集详情「加入播放列表」按钮加入后图标过大 + 不能再点移出 [B67-BUG-5]（2026-06-15 修·`fix/buglist`）— 改 `isQueued`(真实队列成员)驱动的持久 toggle + `check-circle` 图标(有边界);点击可移出。**待真机**。
- ✅ last.fm 子窗 nodeIntegration+webSecurity:false 历史高危（2026-06-15 修·`fix/buglist`）— `background.js` new-window 删整段 last.fm 高危内嵌子窗死分支，统一 `shell.openExternal` 走系统浏览器。behaviorChange=false。**待真机**(scrobble 仍正常)。

### P3（低/边缘/记录）
- ✅ **[启动竞态·2026-06-16 修]** ① `setTitle`(`Player.js`)启动期 `store`(@/store 默认导出·循环依赖)仍 undefined → `store.commit` 报 `commit of undefined`:改 **`store?.commit`**(顺带让 `_loadCurrentPodcastEpisode` 不再中断在 setTitle)。② Dexie `not a valid key`:临时给原生 `IDBObjectStore.get` 包 DIAG 实测定位=**`store=lyric key=NaN`**——`getLyricFromCache(id)` 对播客(当前曲)非数字 id 做 `db.lyric.get(Number(id))`=NaN;`getTrackSource`/`getAlbumFromCache` 同 `db.x.get(Number(id))` 模式同病 → 三处加 `Number.isFinite` 守卫(非数字 id 返 null/undefined=未命中)。**Dev `Ctrl+R` 重载实测控制台干净**(两条红 unhandledRejection 全消、eslint 0;DIAG 已删、误加的 podcast/db.js 守卫已回退)。PRE-EXISTING(上游 fork)。详见主文档同名 round。
- ✅ **[启动·噪声 2026-06-16 修]** discord-rpc 连不上(Discord 没开)的启动 unhandledRejection:`ipcMain.js:112` 模块级 `require('discord-rich-presence')(id)` import 时即连,内部 EventEmitter `emit('error')` 无监听→抛。**修**:创建包 try/catch + 挂静默 `client.on('error',()=>{})` + 两个 `*DiscordPresence` 处理器加 `if(!client)return` 守卫。**全量重启 dev 实测启动日志已无 `Could not connect`、0 报错**。eslint 0。
- 🟡 搜索栏右对齐已做(`Navbar .search-box` flex-end 贴头像 + container 150px)；剩"宽度再缩"纯 px 待真机微调。[B67-BUG-7]
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
- 🟡 **[审P1-5·物理媒体键 2026-06-16 实现·待真机]** `globalShortcut.js registerGlobalShortcut` 末尾**并行注册** `MediaPlayPause`/`MediaNextTrack`/`MediaPreviousTrack` 三个系统级媒体键 → 复用既有 IPC 通道(play=playOrPause toggle / next / previous),最小化/失焦也能控制(原先只 `Player.vue` 页内 keydown、需聚焦)。每键 try/catch + 查 register 返回值(被网易云/Spotify/系统占用则记日志跳过、不影响其余键);生命周期跟随 registerGlobalShortcut(改设置时 unregisterAll 后重注册)。eslint 0、electron-safe(无 ?.)。**已全量重启 dev 实测**:registerGlobalShortcut 跑通、3 键全注册成功(无"注册失败"日志)、启动 0 报错。**仍待真机**:物理键硬件不可自动化测,真机最小化态按播放/暂停/上下首验证(若网易云/Spotify 占键会出"注册失败"日志、已跳过不影响)。**SMTC「正在播放」卡片另算**(属 mediaSession，见审P2-1/2)。
- ✅ **[审P1-6]**（2026-06-15 已修，提交 `f3a7b5b`）RSS `fetchText` 加 `maxContentLength`/`maxBodyLength=25MB`(超限 axios 抛错→IPC try/catch 接住返回 {ok:false} 优雅降级)。`podcastFetch.js`。
- 🔴 **[审P1-7]** `parseRss` 渲染端主线程**同步**执行，大 feed 数百 ms 独占主线程，批量刷新/大 OPML 导入掉帧。`service.js:41/131/176` + `rssParser.js:62`。建议移 Worker/分片。[待真机]
- 🔴 **[审P1-8]** 沉浸页背景叠两层重型滤镜(底层封面 `blur(64px)` + frost 全屏 `backdrop-filter:blur(24px)` + 噪点 mix-blend) → 页内动画(封面 scale/进度/nyancat/充能)触发 frost **每帧重采样模糊**，低端/4K 发烫掉帧。`Player.vue .imm-bg-cover/.imm-bg-frost`。建议去二次 backdrop-filter 或降半径。[待真机·新功能引入]

### 🟠 P2（11 条，全部确认）
- ✅ **[审P2-1·SMTC 2026-06-16 修]** mediaSession 不设 `playbackState`:`Player._setPlaying` 同步 `playbackState`(playing/paused)+ 播放刷位置锚点;`_updateMediaSessionPositionState` 加守卫/clamp/真实倍速/try-catch(原写死 rate=1.0、越界会抛 DOMException);恢复/续播路径 `_loadCurrentPodcastEpisode` 补 `setMetaData`(原只"点新单集"入口 set 过→重启 resume 卡片缺标题封面)。Dev 重载实测:启动 metaTitle 已填、play→'playing'、pause→'paused'、控制台 0 报错。系统卡片视觉 [待真机]。
- ✅ **[审P2-2·SMTC 2026-06-16 修]** mediaSession handler 注册两遍(Vue setupMediaControls 把 play/pause 都绑 playOrPause toggle、又覆盖 Player.js 正确版→系统暂停反被 toggle 成播放):删 Vue setupMediaControls + 其 mounted 调用,`_initMediaSession` 改无条件注册=唯一来源(play/pause 分开、next/prev 与 UI 按钮等价[已核 `_playNextTrack(isPersonalFM)`===Vue playNextTrack]、含 stop/seek*)。eslint 0。**⚠️实测发现(WinRT)**:PodPlayer 在 Windows **没注册 SMTC 浮窗**(系统里只有 Spotify)→ Electron 13/Chromium 91 没把 mediaSession 桥接到 Windows;**本轮 mediaSession 改动 Windows 不显**(对 Linux MPRIS 有效、启用 SMTC 才生效),用户先前以为的"正在播放卡片"是 Spotify 的。**用户实际指「任务栏托盘右键菜单」**(`tray.js` 应用自建)→ 已把其「上一首/下一首」label 改「快退 15 秒/快进 30 秒」(click 仍 seek、行为未变),与 menu.js/媒体键/底栏一致;主进程改动需 app 重启生效。**遗留(已试·失败)**:用户要求试启用 Windows SMTC——`background.js` 加 `enable-features=HardwareMediaKeyHandling,MediaSessionService`+`setAppUserModelId`,全量重启+手势播放,**WinRT 仍查不到 PodPlayer 会话(只 Spotify)**;flag 确认已进命令行 → **Electron 13 就是不支持 Windows SMTC,光开 flag 不够**,已回退。要真做需升级 Electron / 原生模块,大改另议。
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
- ✅ **#4** 二级页 `discoverList`「换一批」——2026-06-24 **改造取代**：去掉"换一批"改**分页**(hot/new 确定序+keepAlive、分页条钉底返回不变)；treasure 已改首页 reroll-in-place、不走二级页。`discover.js getSectionFull`/`discoverList.vue`。
- ✅ **#7** 本地"隐藏/显示播放器"快捷键不生效（2026-06-15 修·`fix/buglist`）— `menu.js` Controls 子菜单补 minimize 菜单项(accelerator 取本地键、click 做窗口 hide/show)，改键后重建菜单即时生效。**待真机**。
- ✅ **#6** treasure 切片口径不一致（2026-06-15 修·`fix/buglist`）— `reshuffleSection` treasure 分支改先 `slice(TREASURE_START)` 再排已订阅,与 getSectionFull/splitSections 同序(该分支当前不可达,预防性对齐)。
- ✅ **#8** repeat 改 **off↔one 两档**（2026-06-15 修·`fix/buglist`）— `switchRepeatMode` 改 off↔one、启动归一化遗留 `'on'→'off'`;图标模板天然正确无需改;核验确认无音乐回归('on' 分支退化为无害死代码)。**待真机**。
- ✅ **#9** 未加载 howler 时 后退15/前进30 静默无反应（2026-06-15 修·`fix/buglist`）— `Player.js seek` 加 playOrPause 同款兜底(load+autoplay)，**不带 startAt → 保留续播位**。**待真机**。
- ✅ **#12** 导入订阅后发现页绿勾不即时（2026-06-15 修·`fix/buglist`）— 粘贴RSS/OPML/单档三处订阅成功补 `commit('addSubscribedPodcast')`(键=title、值=feedUrl);`importOpmlText` 多返回 `subscribed[]` 供逐条 commit。**待真机**。
- 🟡 **#15** 快捷键冲突检测/保存反馈 — **#2a 已修**(2026-06-15·`fix/buglist`：saveShortcut 同列撞键检测+修饰键归一化,撞则拒存提示)；**#2b ✅已修**:globalShortcut.js 收集 failedKeys → `send('globalShortcutRegisterFailed')` → `ipcRenderer.js:130` 接住 dispatch toast。占用/非法键现有回馈。
- ✅ **#16** NAS「测试连接」总开关关闭时恒报失败（2026-06-15 修·`fix/buglist`）— 新增 `nas:probeActive` IPC(不看 enabled 只测可达) + `testNasReachable()`，settings 改用之;`testNasConnection`(Navbar 手动重连，更新 nasAlive)保留不动。**待真机**。

### ⚪ 已闭（非 bug）
- **#1** 后退15/前进30 用 `previous`/`next` 三角图标 —— **用户 2026-06-14 决定保留不换**(非命名错误，是选型)。

---

## ✅ TODO

### P1
- 🟡🔜 **NAS 订阅托管 + 智能回收** — 声明式 + 对账模型：订阅成功自动托管到 ABS/NAS(autoDownload + 下最近100期)、6 个月未听冷藏(删 NAS 单集留最近1集+所有收藏)、取消订阅 7 天宽限后删整档、首连新 NAS 差异对账(只动我订阅过的)。执行提示词=`docs/NAS订阅托管-执行提示词.md`、设计=`docs/NAS订阅托管方案.md`。
  - **✅ P0 已落地并真机验证 + 已并 master（2026-06-16）**：订阅成功 fire-and-forget 托管到 NAS（已存在 PATCH / 不存在 POST 创建）+ 无 NAS 全程降级 + `settings.nasHandoffEnabled` 可回退开关。**真正触发下载靠** `PATCH .../media {lastEpisodeCheck:1}` + `GET .../checknew?limit=100`（仅 autoDownloadEpisodes 不回填历史=之前"建档却 0 下载"的真因；checknew 与用户 ABS 看门狗 requeue 同机制）。真机复测 ABS 下载队列 94 集在下 ✓;POST body/folder/token 权限均通过。`nasBridge.js`/`nasSource.js`/`service.js`/`initLocalStorage.js`/`settings.vue`。
  - **终检通过**：4 对抗核验 SAFE-TO-MERGE(含**密钥未泄露**确认:全分支 grep `eyJ`/JWT 0 命中)、eslint 0。非阻断记账(留 P1 加固)：重订阅 checknew 幂等节流、大 OPML 批量 handoff 限流、POST body 随 ABS 版本浮动。
  - **🟡 P1 核心落地（2026-06-16，feature/review-fixes）**：① `ensureManaged()` 从 handoffSubscription 提取 → 供 P0 和 P1 共用；② `nas:ensureManaged` IPC（P1 对账专用幂等 ensure）；③ `nas:removeItem` IPC（四重保险：armed flag + ready + 查不到即 skip）；④ `reconcileNas()` 渲染端声明式对账（ensure bucket 并发 3 + remove bucket 并发 2）；⑤ probe() false→true 触发对账 + 每日心跳；⑥ `deletePodcast` 写 `nasRemoveAt`、重订阅清零；⑦ settings.vue 新增「从 NAS 删档」开关（默认关+红色警告）。冷藏(P1-e)已按规格取消，容量管理交 NAS 侧 watchdog。**P1-d 放量**：真机测试 ensure 无误后在 localStorage 设 `nasDestructiveArmed=true` 解锁真实删档。
- 🟡 **NAS P3 中途掉线续播** — 代码已落地(并入 master 3b1db90, 已 merge 进 feature/review-fixes),**待真机断网验收**(≤5s 续 CDN/误差<2s + NAS 关闭态核心回归)。
- ✅ **桌面通知(新单集/下载完成)** — 2026-06-16 落地：`notifications.js`(主进程 IPC 桥) + `notify.js`(渲染端 helper) + `autoRefresh()` 前后 newCount diff 触发新单集通知 + podcastDownload.js 下载完成直接 `new Notification()` 推 Toast；Windows Toast / 系统通知关闭时静默降级。
- ✅ 任务栏缩略图三键（快退15/播放暂停/快进30）— 2026-06-16 落地，commit `677543a`。
- ✅ 听完自动清理已下载单集释放空间 — 2026-06-16 落地，commit `677543a`。
- ✅ 我的下载页显示存储占用（仅提示）— 2026-06-16 落地，commit `677543a`。
- ✅ **播放 bar 进度条用在播单集封面主色**(2026-06-16,**进度条配色 v1.0**,落地旧账 B-19)：**仅播放 bar**——已播段=`getCoverColor` 封面主色(`coverFillColor`+CSS 变量 `--prog-fill`,取不到回退 #335eea);**标记点改用封面主色的撞色(互补色 `markContrastColor`)**——蓝封面会算出金标、永不蓝配蓝(用户定,初版用固定蓝被否)。**沉浸页按用户要求保持上一轮原样不动**(进度条仍 `--imm-accent`、标记点仍 `markColor`;曾误改已 `git diff` 逐行还原)。Dev DevTools 实测(bar coverFill=hsl(47,46,50)/markContrast=hsl(227,85,55);沉浸 process=rgba(38,38,42,.9) 原值)、eslint 0。详见主文档同名 round。

### P2
- 🟡 机核 hover CHUNK→24 真机验收(残留则调 16)。
- 🔵 **性能优化路线(2026-06-15 全代码库审计后更新·分支 `feature/perf`)** — 详见 [性能审计报告](性能审计报告.md)。**已落地①②③**（2026-06-16·commit `a01cf4e`）：①db v10 `[podcastId+pubTime]` 复合索引+`getEpisodesByPodcast`改 DB 排序+`getEpisodeIdsByPodcast` primaryKeys；②B69-F5 心跳降频（上轮已做）；③ETag/304 条件请求（refreshAllSubscriptions 304 skip 解析）+stats `.each()` 聚合。剩：④F1 真窗口虚拟化（专开一轮）、⑤parseRss Worker。
- ✅ **定期 OPML+JSON 自动备份(2026-06-16·T8)** — 启动 30s 后首次 + 每 6 小时自动备份；空库跳过；**保留最近 3 份**（超出自动覆盖最旧，原 10 份→3 份）；`podcastDownload.js` + `backup.js` + `main.js` 注释同步。
- 🔴 **NAS 源节目「第三大板块」** — navbar 第三板块(首页/我的订阅之外),排版区别于二者(样式未定);是 nas §10 #2「我的NAS栏」升级设想。用户 2026-06-14 提,优先级低、设计未定。
- ✅ **NAS 在档标识(2026-06-16·已满意)** — NAS 在档呼吸点已落地(podcastDetail/podcastLibrary)，用户满意，不再扩展。
- ✅ **NAS 图标黄(慢)态(2026-06-16·已优化取消)** — 局域网 NAS 不存在慢速连接，黄态无实际意义；状态图标简化为在线=绿/断联=红两态（Navbar.vue 注释已更新）。P2/P3 图标换图+提示待 NAS 需求明确后另议。
- 🟡 沉浸式播放页：**P0 已完成**(分支 feature/immersive-player，6 轮打磨，已 push、待用户验收)；剩 **P1**(全屏 maximize+隐顶栏 + ESC 单击退/双击最小化 + 顶部跟随鼠标退出气泡 + 快捷键)；~~P2 动态流体背景/P3 图标 FLIP 飞入飞出(用户 2026-06-16 取消，暂不做)~~。
- 🔴 设置页完善(导出收听数据 CSV/JSON、全局媒体热键、同时下载集数1-10 UI、键盘可达)。
- ✅ **睡眠「本集结束」队列边界(2026-06-16·修)** — `player.js` 新增 `_sleepEndMode` 标志 + `setSleepEndMode()`；`_nextTrackCallback` 检测到 end 模式时跳过自动续播，让 Vue 1s 轮询检测 leftSec≤2→`fireSleep()` 暂停并 toast；`applySleep('end')` 置 true，`cancelSleep`/`fireSleep` 置 false。
- 🟣 多源资源池·Apple 官方榜 adapter(首页板块,paused)。

### P3
- 🔴 重订阅 **15/34 下载未挂回**(文件在 PodPlayerDev\podcasts,需要时精确挂回)。
- 🔴 OPML 重订阅 **28 档 vs ABS 36 档**,差 8 档待核对。
- 🔴 **自动更新源 + in-app GitHub 链接**仍指 qier222/YesPlayMusic(你说后面统一改)。
- 🔴 承重标识彻底自托管/换 logo(Dexie 名/userData 身份/迁移前缀/UA/logo 资源)。
- 🔴 从 NAS 下载(#6,局域网更快,增强)。
- 🟣 首页 NAS 来源板块(#3,留接口,paused)。
- 🔵 清理 NAS 临时调试物(window.podNas 已删,剩余随设置页/图标落地清)。
- ✅ 播放音量渐入(久未播 >45min/隔天打开 + 音量>50% → ~1.2s 渐入；`Player.js` C3，早前会话已做·待真机)。
- 🔴 发现页缓存大方向评估(封面/信息/单集/音频)。
- 🟣 多源发现资源池整方案(paused,**唯一阻塞=注册 PodcastIndex 免费 key**)→ ②命中率spike / ③adapter+解析链 / ④搜索双源 / ⑤推荐池扩容 / ⑥RSSHub兜底。
- ✅ 音质(musicQuality) dormant mutation 删除（2026-06-15·`fix/buglist`）— 删 `mutations.js changeMusicQuality`(无调用方);保留 state key + initLocalStorage 种子 + track.js 读路径(网易云 legacy 不回归)。
- 🔴 统计动画 v2「有等待」路线 git 锚点待确认锁定(版本溯源记账)。

---

## 关键状态锚点（接手先看）
- **分支/进度(2026-06-24 更新)**：**全部已在 `master`**(最新 `d419dcd` 附近)——含 2026-06-20 之前全部 + 本会话(2026-06-23~24)：设置页打磨/i18n、进度条进位+重开显示、跨页滚动复位、资源池逐候选回退+PodcastIndex、热门/新上线分页、加载动效 BouncingDots、**路由单 RV 根治闪页**。**已发布 0.4.11**(GitHub Release v0.4.11 + 打包版本目录)。仓库 `Fuji-021/PodPlayer`。**勿再用 off-master 分支 / `c2cd29d`、`ee9d29d` 等旧锚点**。
- **NAS：用户 2026-06-20 搁置**(觉得不完善)，不再主动推进；已落地修复保留。真源 `docs/NAS总文档.md`(原 5 文档已合并)。
- **本轮(2026-06-20)修复留痕**：✅ 取色按钮取色失败永久隐形(审查#4，episodeDetail/podcastDetail) · ✅ PodImage 加载失败占位防空白+http→https(R13 安全子项) · ✅ discoverList new/treasure「换一批」shuffle(操作#4 部分，hot 保持排行)。
- 实例隔离:prod=PodPlayer/10754/27232 · dev=PodPlayerDev/10755/27233/devserver20201 · sandbox=PodPlayerSandbox/10756/27234/devserver20202。启动:scripts/start-dev.bat / start-sandbox.bat。
- 数据:用户真实数据在 dev(PodPlayerDev/20201);进度/统计/收藏曾因事故不可恢复、现有自动备份兜底。
- 打包:**正式版(prod=PodPlayer 身份)** 与 dev-serve 零冲突;**勿打包 dev 身份**。2026-06-15 已打 0.4.10 测试包(portable 免安装 + nsis 安装版)→ `D:\MyYesPlayerMusic\打包版本`;命令 `vue-cli-service electron:build -p never -w`(Node16 路径、**不带** NODE_OPTIONS=--openssl-legacy-provider，Node16 不认会 exit 9)。
- 关联记忆:[[known-bugs]] [[nas-feature-branch]] [[perf-optimization-goal]] [[dev-environment]] [[versioning-rules]] [[resource-pool-plan-status]] [[discover-redesign-spec]]。
