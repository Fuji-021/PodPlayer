# PodPlayer · TODO 与 BUG 总清单（持久·防记忆丢失）

> 2026-06-14 汇总 + 06-15 更新(沉浸式播放页 + 打包测试版)。
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
