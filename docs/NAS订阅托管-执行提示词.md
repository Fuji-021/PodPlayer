# NAS 订阅托管 + 智能回收 · 执行提示词（审查 session 给，2026-06-15 存档，计划下周做）

> 完整设计方案见 `docs/NAS订阅托管方案.md`。本文件存「执行提示词」原文，防 compact 丢失，下周开工直接照此执行。
> **当前未开工**；本轮(2026-06-15)只做了 push + 打包测试版，NAS 这轮没碰。

---

任务：实现 PodPlayer「NAS 订阅托管 + 智能回收」完整功能。完整方案见 docs/NAS订阅托管方案.md，按下述执行；先做 P0 给我看效果。

【先切分支】从当前 NAS 分支切 feature/nas-handoff，开工前 git 快照。

【铁律·不干扰原逻辑 / 无 NAS 可独立用】
- 复用现有 nasBridge 的 axios / 配置(profiles) / authGet / ensureItems，不重写、不动现有只读 IPC。
- 无 NAS 或断联：渲染端 !isNasEnabled()||!nasAlive 短路、主进程 ready() 短路、全程 try/catch 不抛错；托管/回收都是订阅成功后的旁路，失败绝不影响本地订阅与播放。
- feature flag 包裹、可一键回退。

【核心模型：声明式 + 对账(reconcile)】本地状态是唯一真相，NAS 在线时对账把 ABS 逼近期望态（不要"即时发命令"，断联会丢/会冲突）。期望态：
- subscribed=true 且近期(<6月)在听 → 托管：ABS 有此档 + autoDownloadEpisodes:true + 下最近100期。
- subscribed=true 且 6 个月没听 → 冷藏：hard delete 该档 NAS 单集，但保留「最近1集 + 所有收藏单集」，并 PATCH autoDownloadEpisodes:false。
- subscribed=false（取消订阅）→ 移除：标记 + 7天宽限期后 hard delete 整档；宽限期内重新订阅自动撤销。
对账时机：启动就绪 / 断线恢复 / 每日 / 操作后即时。全程幂等、纯自动。断联跳过不丢状态，恢复后全量对账用当前真相重算。

【订阅托管】service.js 的 subscribeByRssUrl 成功后 fire-and-forget 调 handoffToNas（不阻塞订阅）→ 主进程新 IPC nas:handoffSubscription：ready 检查 → ensureItems 幂等查库 → 已有则 PATCH /api/items/{id}/media、没有则 POST /api/podcasts 创建(libraryId+folderId+path)，设 autoDownloadEpisodes:true + maxNewEpisodesToDownload:100；解析 feed 取最近100期 → POST /api/podcasts/{id}/download-episodes 显式补满。folderId 用 GET /api/libraries/{lib} 取 folders[0]。OPML 批量走 runLimited 节流。

【6月冷藏回收】PodPlayer 端定期(启动/每日)：用本地 episodeProgress/episodeListenStats 算每档最后收听时间；>6个月 → 冷藏(删 NAS 单集留最近1集+所有收藏单集、停 autoDownload)。纯自动。收藏单集=单集级白名单永不删。

【maxEpisodesToKeep】启用、设 100。它按发布时间滚动删、不认收藏，此冲突以 ABS 为准（不为它特殊豁免收藏）。

【首次连接新 NAS 的差异对账】对账只作用于"我订阅过的"：我订阅∩NAS→确保托管；我订阅−NAS→托管；NAS有我无→默认不动(不下载/不删/不冷藏)，仅可选一次性提示"是否导入未订阅节目"，确认才导入。绝不自动删/冷藏未订阅内容(NAS 可能多用途共享)。

【权限 / 落地核实】创建/删除/PATCH 需 admin 或 update 权限的 token(只读会 403)，配置时探测权限并提示。POST /api/podcasts 精确 body 与 hard delete 的 ?hard 参数在本机 ABS 实测坐实后再放量。

【设置页】加开关：① 订阅时自动托管 NAS(默认开) ② 连接新 NAS 时提示导入未订阅节目；NAS 配置加目标 folder 选择 + 探测 token 权限。

【README 教程（重要，给新用户写详细）】
1. PodPlayer 连接 NAS：设置→NAS 配置→填 ABS 地址(http://NAS_IP:13378)/ API token / 选 library / folder →测试连接。
2. NAS 端 ABS 设置：Docker 安装 ABS、新建"播客"类型 library 并指定下载文件夹、在 ABS 设置生成 admin 权限 API Token、填回 PodPlayer。
3. 看门狗容器：据现有 docs/abs-watchdog.py 与 docs/docker-compose.watchdog.yml 写部署教程(作用=监测 ABS 下载卡死自动处理、compose 部署步骤、配置项、日志查看)。
4. 强调：不连 NAS 也能正常使用，只是没有自动托管下载。

【分期】P0：订阅托管 + 无 NAS 降级（先给我看效果）。P1：6月冷藏 + 声明式对账 + 取消移除(7天宽限) + 首次差异对账 + README 教程。
