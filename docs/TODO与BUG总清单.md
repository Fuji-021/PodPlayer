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
- 🔴 **统计「最近一周」>「全部」(如岩中花述)** — 数据模型不一致:"全部"读 episodeListenStats 累计、"周"读 listenDaily 按天=两套表,后者有记前者没记全则周>全部。正解=统一数据源(非trivial)。本轮已诊断未修。[listening.js:179]
- 🔴 《思文，败类》首页封面 ≠ 详情页封面 — 疑 name≠RSS title→subscribedMap 查不到 feedUrl→回落旧 logo。
- 🔴 头像二级菜单弹出锁全局滚动 — ContextMenu enableScrolling:false→#main overflow:hidden。
- 🔴 单集列表全量渲染无虚拟化(与机核同源,大档建数百行 DOM)。
- 🔴 「为你推荐」reroll 不换/池只剩 3 — reshuffle 没排除上一批 forYou。
- 🔴 单集详情「加入播放列表」按钮加入后图标过大 + 不能再点移出。[B67-BUG-5]
- 🔴 last.fm 子窗 nodeIntegration+webSecurity:false 历史高危(入口已删,建议收敛/移除)。

### P3（低/边缘/记录）
- 🔴 搜索栏再右移 + 宽度再缩对齐 navbar。[B67-BUG-7]
- 🔴 subscribedMap 以节目名为键→同名节目互相覆盖(评估暂不修)。[B56-5]
- 🔴 searchLocalEpisodes 全表 JS filter 无索引。[B69-F4]
- 🔴 本地搜单集混入未订阅预览(语义待定)。[B69-L1]
- 🔴 播放心跳每秒 2 次 Dexie 写(功耗,可降频)。[B69-F5]
- 🔴 _updateMprisState 监听器永不移除(休眠中,改 once)。[B69-L2]
- 🔴 Player.vue beforeDestroy 漏清 closeQueuePanel(影响≈0)。[B69-L3]
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
- 🔴 **[审P1-4]** 退出钩子不通知渲染端 flush + 无 `beforeunload`/`pagehide`；`app.exit()` 立即终止 → in-flight Dexie 写(进度/统计)可能半途夭折。`background.js:536-547`；`ipcMain.js:32/66/210` app.exit。**呼应数据丢失事故**。
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
- 🟠 **[审P2-10]** `tickListen` 每秒 `get→改→put` 非事务、`listenDaily` 第二段独立 R-M-W → seek/倍速快触发时后写覆盖前写、少计统计(丢更新)。`listening.js:34-101`。[待真机]
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
- 🟠 **#7** 本地"隐藏/显示播放器"快捷键(minimize，默认 Ctrl+M)UI 可设可存但**不生效**(`menu.js` 没注册 minimize accelerator，只全局列那格真生效)。`menu.js`/`settings.vue`。
- 🟡 **#6** treasure 切片口径 `splitSections`(先 slice 再 filter) vs `reshuffleSection`(先 excludeSubbed 再 slice)不一致 → 订阅越多偏差越大。`discover.js`。
- 🟡 **#8**（已定方案·删列表循环）repeat 改 **off↔one 两档**(播客随听随弃，列表循环无意义)：`Player.js switchRepeatMode` 改 `off↔one`、`Player.vue` 图标去中间 on 态、启动把遗留 `'on'` 归一化 `'off'`。**方案明确、可直接实现**。
- 🟡 **#9** 未加载 howler 时按 后退15/前进30 静默无反应(playOrPause 有懒加载兜底、seek 没)。`Player.vue seekBackward15/Forward30`。
- 🟡 **#12** 粘贴RSS/OPML/单档导入订阅后未 `commit('addSubscribedPodcast')`(只 loadPodcasts 刷本页)→ 另一标签已开的发现页绿勾不即时(切页 loadSubscribedMap 自愈)。`podcastLibrary.vue`。
- 🟡 **#15** 快捷键无冲突检测 + 保存恒提示成功(`globalShortcut.register` 对占用/非法键静默 false)。`settings.vue saveShortcut`。
- 🟡 **#16** NAS「测试连接」在总开关关闭时恒报失败(`probe` 开头 `if(!enabled) return false`)、与可达无关。`nasSource testCurrentNas`/`nasBridge probe`。

### ⚪ 已闭（非 bug）
- **#1** 后退15/前进30 用 `previous`/`next` 三角图标 —— **用户 2026-06-14 决定保留不换**(非命名错误，是选型)。

---

## ✅ TODO

### P1
- 🔴🔜 **NAS 订阅托管 + 智能回收（下一轮主攻 · 计划下周做）** — 声明式 + 对账模型：订阅成功自动托管到 ABS/NAS(autoDownload + 下最近100期)、6 个月未听冷藏(删 NAS 单集留最近1集+所有收藏)、取消订阅 7 天宽限后删整档、首连新 NAS 差异对账(只动我订阅过的)。**P0=订阅托管 + 无 NAS 降级**先看效果；P1=冷藏/对账/移除/差异/README 教程。执行提示词=`docs/NAS订阅托管-执行提示词.md`、设计=`docs/NAS订阅托管方案.md`；切分支 `feature/nas-handoff`。
- 🟡 **NAS P3 中途掉线续播** — 代码已落地(并入 master 3b1db90),**待真机断网验收**(≤5s 续 CDN/误差<2s + NAS 关闭态核心回归)。
- 🔴 桌面通知(新单集/下载完成,须合 Windows 通知框架)。
- 🔴 托盘菜单 + 任务栏缩略图三键(上一首/暂停/下一首)。
- 🔴 听完自动清理已下载单集释放空间。
- 🔴 我的下载页显示存储占用(仅提示)。
- 🔴 播放 bar 进度条用在播单集封面主色(已有 getCoverColor)。

### P2
- 🟡 机核 hover CHUNK→24 真机验收(残留则调 16)。
- 🔴 性能路线:L1 内存缓存→L2 hover 预取(先只对已订阅)→F2 prune→L2 放开未订阅→L3 空闲预热(每轮一步)。
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
- 🔴 音质(musicQuality) dormant mutation 待专门 dead-code 轮删除。
- 🔴 统计动画 v2「有等待」路线 git 锚点待确认锁定(版本溯源记账)。

---

## 关键状态锚点（接手先看）
- 分支:沉浸式在 **`feature/immersive-player`**(off master、已 push、待用户验收后并入);**下一轮 NAS 将切 `feature/nas-handoff`**;master=`c2cd29d`,仓库 `Fuji-021/PodPlayer`。
- 实例隔离:prod=PodPlayer/10754/27232 · dev=PodPlayerDev/10755/27233/devserver20201 · sandbox=PodPlayerSandbox/10756/27234/devserver20202。启动:scripts/start-dev.bat / start-sandbox.bat。
- 数据:用户真实数据在 dev(PodPlayerDev/20201);进度/统计/收藏曾因事故不可恢复、现有自动备份兜底。
- 打包:**正式版(prod=PodPlayer 身份)** 与 dev-serve 零冲突;**勿打包 dev 身份**。2026-06-15 已打 0.4.10 测试包(portable 免安装 + nsis 安装版)→ `D:\MyYesPlayerMusic\打包版本`;命令 `vue-cli-service electron:build -p never -w`(Node16 路径、**不带** NODE_OPTIONS=--openssl-legacy-provider，Node16 不认会 exit 9)。
- 关联记忆:[[known-bugs]] [[nas-feature-branch]] [[perf-optimization-goal]] [[dev-environment]] [[versioning-rules]] [[resource-pool-plan-status]] [[discover-redesign-spec]]。
