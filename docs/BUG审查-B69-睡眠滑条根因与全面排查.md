# B-69 Bug 审查报告：睡眠滑条根因 + 全项目性能/逻辑排查

> 日期：2026-06-11 ｜ 审查方式：读码实证（Player.vue 睡眠链路逐行 + vue-slider-component@3.2.24 源码 + B-68 新增改动 diff + 三路并行子系统扫描后人工复核）
> 范围：睡眠弹窗滑条（重点）、B-68 新增功能（缓存优先跳转/统计 v1.3/头像菜单）、播放核心、播客数据层、视图层
> 原则：只收录读码验证过的问题；子代理报告中经复核**不成立**的已剔除（见附录）；不确定的单列"待验证"

---

## 一、睡眠弹窗滑条 bug 根因（用户报告"显示+操作 bug，原因未知"）

### S1【高·操作+显示】label 动态宽度挤压滑轨 + vue-slider 拖动比例尺只在按下瞬间缓存 → 拖动乱跳、松手跳位

**这是本轮要找的真凶，能同时解释"显示"和"操作"两类现象，且解释了为何多轮修复后仍在。**

#### 机制链（三段证据）

**① label 与滑轨同行、宽度随文案变**（Player.vue:1624-1648）：

```scss
.sleep-slider {
  display: flex;
  .sl-label { min-width: 64px; flex-shrink: 0; white-space: nowrap; ... }  // 只有下限、没有上限
  .sl-track { flex: 1; ... }   // 滑轨吃剩余宽度 → label 变宽，滑轨就变窄
}
```

`sleepLabel`（Player.vue:491-504）四种文案宽度差异巨大（12px 字号实测估算）：

| 状态 | 文案示例 | 近似宽度 |
|---|---|---|
| 关闭 / 拖动预览 | `关闭`、`45分钟`、`4小时15分` | ≤64px（被 min-width 兜住，**不变**） |
| min 模式 ≥1h 定时 | `剩余 1:29:59` | ~75px |
| **end 模式长单集** | `本集结束 · 4:24:31` | **~105px** |

弹窗总内宽 216px（244−2×14），label 从 64→105px 时滑轨从 ~142px 缩到 ~101px，**变化约 30%**。

**② vue-slider 的拖动换算比例尺（scale）只在 dragStart 时计算一次，拖动中不刷新**（node_modules/vue-slider-component/lib/vue-slider.tsx）：

```ts
setScale() {                       // :446 只在 dragStart(:581)/dragStartOnProcess(:565)/clickHandle(:666) 调用
  ... this.$refs.rail.offsetWidth ... // 缓存"按下瞬间"的轨道宽
}
private getPosByEvent(e) {         // :767 拖动每帧调用
  return getPos(e, this.$refs.rail, ...)[..] / this.scale;
  //     ↑ 轨道左缘是 getBoundingClientRect 实时取的     ↑ 比例尺却是按下瞬间的旧值
}
```

**③ 拖动的第一次 change 就会触发布局变化**：拖动一旦跨过一个步长档位 → `@change` → `onSleepChange`(Player.vue:722) 置 `sleepDragging=true` → `sleepLabel` 从宽文案（如 `本集结束 · 4:24:31`）切到窄预览（≤64px）→ label 缩窄 → **滑轨实时变宽且左缘左移**，而 scale 仍是旧的窄轨道值。

此后每帧：`pos = (鼠标pageX − 新左缘) / 旧scale`，分子偏大（左缘左移了 ~41px）、分母偏小（旧轨道窄）→ 计算出的百分比**系统性偏大 ~40%** → 把手猛跳到光标右侧、拖动比光标"跑得快"、滑轨右段约 1/3 全部映射到 max（拖到一半就顶头）。

#### 为什么时隐时现、多轮修复不掉

- **首次设定**（mode=off，label=`关闭`=64px 下限）：拖动全程 label 宽度不变 → **完全正常**。B-65 重做后验证手感好，正是验证的这条路径。
- **已设 ≥1h 定时或"本集结束"后再调整**：label 是宽文案 → 按下后第一次跨档 label 缩窄 → **必现乱跳**。长单集（264min 那类）必进 end 模式宽文案，所以长单集测试最容易撞上——但根因与时长无关，与 B-65/B67-BUG-1 修的两个问题（lazy、4px 高度）也无关，所以那两轮修完仍复现。
- **纯显示侧**：即使不二次拖动——松手提交瞬间 label 从窄预览换成宽文案 → 滑轨缩短 → **把手和蓝标肉眼可见地整体左跳**；min 模式倒计时跨过 1:00:00→59:59 等位数变化时也会抖一下。这就是"显示 bug"。

#### 复现步骤（供真机确认）

1. 播放一个 >90 分钟的单集，打开睡眠弹窗，拖到最右设"本集结束"（或设一个 ≥60 分钟定时）。
2. 观察松手瞬间：滑轨变短、把手+蓝标左移（显示 bug）。
3. 不关弹窗，再次按住把手向左拖：把手立刻跳到光标右侧、移动比例失真（操作 bug）。
4. 对照组：mode=off 时首次拖动，全程正常。

#### 修复方向

**核心原则：交互期间滑轨几何必须恒定。**
- 推荐：label 与滑条**拆成上下两行**（label 单独一行，滑条独占整行 ~216px）。一并缓解长单集每档像素过小的老问题，且所有文案宽度变化不再影响滑轨。
- 或：`.sl-label` 给**固定宽度**（≥110px，容纳 `本集结束 · 4:24:31`）。代价是滑轨恒定偏窄（~96px），不推荐。
- 不建议只在拖动中冻结 label 文案——提交瞬间的跳位仍在，治标不治本。

---

### S2【中·显示/逻辑】end 模式下重开弹窗，把手不再贴蓝标，且滚轮微调语义漂移

`computeSleepRange`（Player.vue:694-699）对已激活定时只做"按新步长就近规整"：

```js
if (this.sleepMode !== 'off') {
  this.sleepSliderVal = Math.min(max, Math.round(this.sleepSliderVal / step) * step);
}
```

end 模式没有特判。例：剩余 80min 时设"本集结束"（endStop=80）→ 播放推进到剩余 50min 再打开弹窗 → 新量程 step=2/endStop=50/max=100，旧值 80 被规整为 80 → **把手停在 80、蓝标在 50%（50）处**，两者脱开；label 却显示"本集结束 · …"。此时滚轮 −1 档会从 78 开始按 min 模式重设墙钟，而用户视觉上以为在"本集结束"附近微调。

**修复方向**：`computeSleepRange` 里 `if (this.sleepMode === 'end') this.sleepSliderVal = this.sleepEndStop;`（一行）。

### 睡眠链路其余检查结论（无问题，免重查）

- 蓝标对位：vue-slider 默认 `contained=false` 水平方向无内边距（lib/vue-slider.tsx:217-240），rail 占满 `.sl-track`，`left:%` + `translateX(-50%)` 与把手中心**精确对齐**，无半把手偏差。
- `(max-min)%interval` 整除：computeSleepRange 已强制（B-68 修），各分支验算通过。
- click 与 drag 不冲突：dragEnd 在 setTimeout 内删 Drag 态，原生 click 先于其触发被 `states.has(Drag)` 拦截（lib:624-672），无双触发。
- end 模式触发改用播放进度比较（非墙钟）逻辑正确；`fmtClock` 小时进位正确。

---

## 二、B-68 新增功能点

### P1【高·逻辑】startPreview 在途请求无守卫：用户已离开仍被强制 replace/back，导航被劫持

podcastDetail.vue:340-368（commit c1efa1d 新增）：

```js
async startPreview() {
  ...
  try {
    const { feedUrl } = await previewPodcast(seed.raw);   // 网络抓 RSS，可达数秒
    this.$router.replace({ name: 'podcastDetail', params: {...} });  // ← 无任何守卫
  } catch (e) {
    ...
    this.$router.back();                                  // ← 同样无守卫
  }
}
```

`$router` 是全局对象，组件销毁后调用依然生效。两条触发路径：

1. **劫持回拉**：点未订阅卡片 A → 骨架页 → 用户等不及按返回回首页 → 数秒后 A 的 RSS 抓完 → `replace` 把用户**强行拉回 A 的详情页**（失败路径则 `back()` 多弹一层历史，落点不可预期）。
2. **串台竞态**：进 A 骨架 → 返回 → 点卡片 B → B 骨架加载中，A 的旧 promise 先/后完成 → 谁后 resolve 谁赢，用户可能看着 B 却被切到 A。

**修复方向**：await 后加守卫——`if (this._isDestroyed || this.$route.params.feedUrlEncoded !== '__preview__') return;` 再补一个递增 token（同 searchPodcast 的 myKw 模式）防 A/B 串台；失败路径同样守卫且建议用 `replace('/library')` 替代 `back()`。

### 其余 B-68 项检查结论

- 统计 v1.3（`.stat-row` 不透明底色）：方向正确，未发现新副作用；残影是否根除待真机慢放确认（Dev 2x 钩子已备）。
- 头像菜单重排（Navbar.vue）：纯顺序调整，无逻辑问题。
- 预览成功后 replace 到真实 feedUrl → watcher 重走 load()：这是设计内行为，非 bug；`_loading` 随 load() 整体替换 podcast 对象被清除，无残留。

---

## 三、性能问题（按影响排序）

### F1【中】podcastDetail 单集列表全量渲染，无分页/虚拟化

podcastDetail.vue:381-392：`getEpisodesByPodcast` 取**全部**单集后一次性 `v-for` 渲染。大档节目（500~1500 集的长青播客）进页一次性建数百行 DOM（每行含按钮/状态点/菜单挂点）。读侧已用 bulkGet 优化（B-36），瓶颈在 DOM 数量。骨架流（B-68）只消了网络等待，**没消这个渲染成本**——大档节目"进节目卡"会残留此因素。
**修向**：首屏渲染 50~100 条 + 滚动加载（IntersectionObserver 哨兵即可，不必上虚拟滚动库）。

### F2【中】预览入库无清理 → db.episodes 无限增长

service.js previewByRssUrl：每次预览未订阅节目，整档 podcast + **全部 episodes** 永久写入 Dexie，全项目无任何 prune/cleanup 逻辑（已全局 grep 确认）。发现页随便点几十张卡片 = 几千~几万条孤儿 episode 永久滞留，拖慢所有全表扫描路径（F4、二-L1），库体积单调增长。
**修向**：订阅时转正；未订阅的预览数据打 `previewedAt` 时间戳，启动时清理超期（如 7 天）且无下载/无进度记录的孤儿档。

### F3【中】getDownloadedEpisodes N+1 串行 await

downloads.js:238-261：循环内逐条 `await db.episodes.get(r.id)` + `await db.podcasts.get(...)`，100 个下载 = 200 次串行 IndexedDB 往返，"我的下载"页打开明显变慢。
**修向**：`db.episodes.bulkGet(ids)` + podcasts 一次性取成 Map（项目里 B-36 已有同款模式可抄）。`getDownloadingEpisodes`（:264）同款写法，但 N 小、优先级低。

### F4【低】searchLocalEpisodes 全表 JS filter

db.js:39-47：`db.episodes.filter(title.includes)` 无索引全扫。仅回车提交时触发（已确认 Navbar 是 `@keydown.enter`，非每键），当前量级可接受；但与 F2 叠加会持续恶化。先修 F2 即可。

### F5【低·设计取舍记录】播放心跳每秒 2 次 Dexie 写

Player.js:295-372：每秒 `saveEpisodeProgress` + `tickListen` 各一次写。单写很小，Electron 下可接受；若未来做功耗优化，进度保存可降到 3~5 秒一次（统计 tick 保持 1s 不动，精度依赖它）。

---

## 四、操作逻辑问题（睡眠/B-68 之外）

### L1【低-中·语义待定】本地搜索"单集"混入未订阅预览数据

db.js：`searchLocalPodcasts` 显式过滤 `subscribed !== false`（:34），但 `searchLocalEpisodes`（:39-47）**不过滤**——预览过（未订阅）的节目单集会出现在"本地"搜索结果里，且随 F2 增长越混越多。B-63 单集卡片有订阅状态点，若"可发现未订阅集"是有意设计请在文档标注；若无意，加同款过滤（join podMap 后按 `pod.subscribed !== false` 筛）。

### L2【低·上游遗留】_updateMprisState 每次切歌累积 ipcRenderer 监听器

Player.js:860-862：`ipcRenderer.on('saveLyricFinished', ...)` 在每次切歌路径注册且永不移除。触发需 `enableOsdlyricsSupport=true` 且歌词存在——播客 track（`pod:` id）取词必失败提前 return，**当前实际休眠**。属上游 YesPlayMusic 代码债，顺手改 `once` 即可。

### L3【低·理论】Player.vue beforeDestroy 漏清队列面板外点监听

beforeDestroy（Player.vue:546-554）清理了 rate/sleep 两组，未调 `closeQueuePanel()`。播放条组件常驻 App 根部、实际不销毁，现实影响≈0；补一行保持对称。

---

## 五、待验证（证据不足，不下结论）

| # | 疑点 | 验证方法 |
|---|---|---|
| V1 | statsPage `_loadSeq` 守卫之外，`enterWithAnimation` 与 `setRange` 仍可能在动画帧间隙交错写 `this.list`（子代理报告，复核未找到明确窗口） | Dev 2x 慢放下加载中快速切换范围 ×10，观察是否错排/错快照 |
| V2 | S1 修复后长单集拖动精度是否达标（每档 ≥8px 假设基于 216px 全宽轨道） | 真机 266min 单集逐档拖动验证 |

---

## 六、修复优先级建议

| 顺序 | 项 | 理由 |
|---|---|---|
| 1 | S1 滑轨恒宽（label 拆行） | 用户明确报告的现行 bug，根因已锁定，改动小 |
| 2 | P1 startPreview 守卫 | 高频路径（发现页点卡片）+ 导航劫持体验恶劣，三行守卫 |
| 3 | S2 end 模式重开贴蓝标 | 一行修，顺手 |
| 4 | F3 下载页 bulkGet | 模式现成，收益直接 |
| 5 | F1 单集列表分批渲染 | "进节目卡"的最后一块残留 |
| 6 | F2 预览数据清理 | 慢性病，越早越便宜 |
| 7 | L1~L3 | 低危，凑轮次顺手修 |

---

## 附录：子代理报告中经复核剔除的项（防止以讹传讹）

- "_setIntervals 不存句柄=高危泄漏"：Player 为单例（store/index.js:54 仅 new 一次），interval 与应用同生命周期，**设计如此**，非泄漏。
- "progress setter 拖动风暴写 DB"：主进度条 `:lazy="true"`（Player.vue:26），setter 仅松手触发一次，**不成立**。
- "howler fade 竞态丢事件"：已有 220ms setTimeout 兜底 + done 幂等，属防御已到位，不立案。
- "tickListen dt=0 统计丢失"：B-64 #17 已修，残余窗口仅 howler 未 loaded 的最初几秒，影响可忽略。
- "搜索每键全表扫致输入延迟"：搜索仅回车提交（Navbar:47），**触发频率前提错误**，降级并入 F4。
