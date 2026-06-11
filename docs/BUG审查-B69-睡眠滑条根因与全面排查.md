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

---
---

# 追加 · B-69bis（2026-06-11 第二轮）：睡眠滑条真凶实锤 —— 滑轨宽度塌缩为 0

> 背景：S1（label 挤压+scale 缓存）已按建议修复（commit `d165aee`，拆行恒宽），用户实测**仍然**"拖不动、数值对不上、短/长单集都坏、哪哪都不对"。说明 S1 是真实但**次要**因素。本轮放弃继续读码推演，改为**搭 1:1 复现环境实测**，已锁定主因并复现全部症状。

## S0【致命·根因】vue-slider 根元素内联 `width:auto` 在 flex 容器内塌缩 → 滑轨实际宽度 = 0px

### 机制（三步，每步都已对源码/规范核实）

1. **vue-slider 给自己的根元素写内联 `width: auto`**（lib/vue-slider.tsx:217-240 `containerStyles`：未传 `width` prop 且水平方向时 `containerWidth='auto'`，随 `:style` 渲染成内联样式）。
2. **内联样式在层叠中压过样式表**：Player.vue 里 `.sleep-slider .vue-slider { width: 100% }`（无 `!important`）**完全失效**。
3. **`.sl-track` 是 `display:flex`**：滑条作为 flex 项、无 `flex-grow`、basis=auto → 按**内容宽度**收缩；而它唯一的流内子元素 `.vue-slider-rail` 是 `width:100%`（百分比在内在尺寸计算中按 auto 处理），rail 的子元素（process/dot/marks）**全部绝对定位、不贡献内容宽度** → max-content = 0 → **整个滑条收缩为 0px 宽**。

0 宽轨道下的交互数学：`setScale()` → `scale = floor(0)/100 = 0`；任何按下/拖动 `getPosByEvent` → `偏移px / 0 = Infinity` → 钳到 100% → **值瞬移到 max**。把手渲染在 0 宽轨道的任意百分比都是同一个点（轨道左缘）→ 视觉上**永远不动**。

### 复现实证（脚本：`scripts/sleep_slider_repro.js`，jsdom + 真实 vue-slider@3.2.24 + Player.vue 原版睡眠逻辑）

| 场景 | 期望 | 轨道=216px（健康几何） | 轨道=0px（真实现状） |
|---|---|---|---|
| 短单集(剩25min)拖到 50% | ≈25 | **25 ✓**（change 逐档 1→25） | **50=max ✗**（一次 change 直达 max，mode 误成 min） |
| 短单集拖到蓝标 | end 模式 | **end ✓** | 50≠endStop(25)，**进错 min 模式 ✗** |
| 长单集(剩264min)拖到 30% | ≈81 | **75 ✓**（差在步长 15 取整，正常） | **270=max ✗**（直接误触发"本集结束"） |
| 已设 60min 后再拖到 70% | ≈189 | **195 ✓** | **270 ✗** |
| 点击轨道 25% 处 | ≈13 | **13 ✓** | **50=max ✗** |
| 拖把手到 75% | ≈38 | **38 ✓** | **50 ✗** |

两组对照说明：**JS 逻辑层（computeSleepRange/onSleepChange/onSleepCommit/吸附/步长/边界）全部正确**，唯一变量是轨道宽度。0 宽组的行为——任何操作瞬移 max、中间档位永远取不到、短长全坏——与用户描述逐字吻合。

### 时间线统一解释（为什么五轮修复都无效）

`git show 10ffdb2`（B-63 睡眠弹窗重做）确凿显示：**该轮删掉了 `.vue-slider { flex: 1 }`**、为放蓝标新增 `.sl-track{flex:1; display:flex}` 包裹层，滑条改用 `width:100%` 托底——**0 宽塌缩自 B-63 起引入**。对照：倍速滑条 `.rate-slider .vue-slider { flex: 1 }`（flex-basis:0+grow，由 flex 算法分配宽度、**不经过 width 属性**）→ 一直正常，这就是"同款弹窗为什么倍速好的"的答案。

| 轮次 | 当时修的 | 为什么没用 |
|---|---|---|
| B-64 | `:lazy` 防抖动 | 改的是事件时序，轨道仍 0 宽 |
| B-65 | 动态步长+去自缩 | 步长再合理，0 宽轨道上任何拖动→max |
| B67-BUG-1 | `:height=8`+轨道加色 | "看不到托条"的真因是 **0 宽**不是 4px 高/浅色——0×8px 还是看不见 |
| B-69 S1 | label 拆行恒宽 | S1 机制真实存在，但被 S0 完全遮蔽（"首拖正常"的推断在 0 宽下不成立，此处修正前文） |

### 真机一行验证（建议修复前先做，钉死结论）

弹窗开着时 DevTools Console 执行：
```js
document.querySelector('.sleep-menu .vue-slider').offsetWidth   // 预期输出 0
```

### 修复（一行，二选一）

```scss
// 方案A（推荐，与倍速滑条同款、已被真机验证的模式）：
.sleep-slider .sl-track .vue-slider { flex: 1; }   // 替换现在的 width:100%
```
```html
<!-- 方案B：模板上把宽度交给组件自己内联（同样绕开层叠问题） -->
<vue-slider :width="'100%'" ... >
```
修复后：S1 拆行（已做）保证交互期几何恒定，逻辑层已被 216px 对照组证明正确，蓝标 `left:%` 与满宽 rail 坐标系一致（前文"对位精确"结论在宽度恢复后成立）→ 预期整条链路直接工作。回归脚本 `scripts/sleep_slider_repro.js`（需 `npm i -D jsdom@22`，`node scripts/sleep_slider_repro.js`）。

---

## S0-spec【功能未对齐】量程/蓝标规则与产品诉求不一致（用户口径："不是 bug，是功能没做好"）

用户本轮明确的诉求 vs 当前 `computeSleepRange`（Player.vue:674-707）实现：

| 项 | 用户诉求 | 当前实现 | 差异 |
|---|---|---|---|
| 短单集量程 | 剩余 < 100/120min → max **固定 100 或 120**，坐标轴稳定 | 剩余 ≤90 → `max = 2×endStop`（随剩余变，如剩 10min 轴只有 0–20） | **轴不稳定、跨单集不可比** |
| 蓝标位置 | 在**剩余时长**对应的比例位置 | 短单集分支恒在 **50% 正中**（max=2×endStop 的副作用） | 蓝标不反映真实剩余 |
| 长单集量程 | 剩余 ≥ 100/120 → max = 剩余，蓝标最右 | 剩余 >90 → max=endStop，蓝标最右 | 基本一致（阈值 90 vs 100/120 不同） |

### 对齐建议（改动集中在 computeSleepRange，~5 行）

```js
const CAP = 120;  // 或 100，待拍板；以"剩余"为基准（用户原话先说"单集时长"后说"剩余时长"，按剩余更合理，需确认）
if (dur > 0 && remainMin >= 1) {
  const step = this.sleepStepFor(remainMin);
  const endStop = Math.max(step, Math.ceil(remainMin / step) * step);
  const max = remainMin >= CAP ? endStop : Math.ceil(CAP / step) * step;
  // 蓝标：endStop/max → 短单集按真实剩余比例落位；剩余≥CAP 时 endStop===max → 自然最右
}
```
整除性验算：CAP=120 时可能的步长为 1/2/5（剩余<120 才用 CAP，对应 sleepStepFor ≤120 区间），120%1=120%2=120%5=0 ✓；剩余≥CAP 分支 max=endStop 本就是步长整数倍 ✓。蓝标"剩余=max 时在最右"由 `endStop===max` 自然满足 ✓。

### 留给拍板的两个点

1. CAP 取 **100 还是 120**（用户原话两者皆提）。
2. 阈值基准用**单集总时长**还是**当前剩余**（建议剩余：暂停点重开弹窗时轴随剩余收敛，蓝标位置始终真实）。

---

## 修订后的修复顺序（替代前文第六节）

| 顺序 | 项 | 说明 |
|---|---|---|
| 1 | **S0 滑轨 flex:1** | 一行根治"拖不动/数值对不上"，先真机 `offsetWidth` 验证再改 |
| 2 | **S0-spec 量程对齐** | 同文件同函数，顺手一起做，CAP/基准先拍板 |
| 3 | S2 end 模式重开贴蓝标 | 一行 |
| 4 | P1 startPreview 守卫 | 不变 |
| 5 | F3 → F1 → F2 → L1~L3 | 不变 |

> 方法论教训（自我修正）：B-69 第一轮对 S1 的"首拖正常"推断，建立在"轨道有宽度"这个未验证前提上——读码推演给出的根因可以是真实的（S1 确实存在）但不一定是**主导**的。本轮先用可控几何证明逻辑无错、再用真实几何复现症状，对照定位，这才把层级排出来。后续遇"多轮修复无效"的 bug，优先怀疑所有轮次都没碰过的那一层（这次是布局），并尽早上复现环境。

---
---

# 追加 · B-71（2026-06-11 第三轮）：我的订阅页滚动卡顿排查 + 节目预加载可行性

> 用户报告：我的订阅页滚动最近变卡，比首页还不流畅；问是否因"开屏页设置成首页"。另问：现有框架能否做 preload 预加载，优化点进节目的加载速度。

## 一、先回答：开屏页设置不是直接原因

读码核实：代码中**不存在**任何把"启动页设置"与订阅页渲染/滚动耦合的路径。但存在一个**间接的可能性**（H3 访问顺序效应，见下），可用 1 分钟自测排除/坐实，先别下结论。

## 二、排查事实（全部读码验证）

1. **最近 7 个 commit（d165aee→f2ad34d，睡眠修复/P1守卫/F3/B-70红点）无一触及 podcastLibrary.vue 或其数据路径**。`git log --follow` 显示订阅页最后一次实质改动是 B-64（d11b29e，仅 loadPodcasts 重试判据+死样式删除）。"最近引入"的感受**没有对应的最近代码改动**——所以原因在数据增长、访问模式变化或一直存在但近期被放大的成本里。
2. **关键差异点（首页流畅 vs 订阅页卡的最合理机制）**：两页卡片都有常驻封面光晕 `.cover-shadow { filter: blur(16px) }`（B-44），但**底图来源不同**——
   - 首页 DiscoverCard：`hiResLogo(url, 600)`（discover.js:90），Apple 封面**封顶 600×600**；
   - 订阅页：直接用 RSS 原图 `p.coverUrl`（podcastLibrary.vue:108），播客封面行业规范 **≥1400×1400、常见 3000×3000**。
   同样的 blur，订阅页每张卡的位图解码+光栅化面积是首页的 **5~25 倍**；滚动重合成时这是两页体感差异的头号嫌疑。且**随订阅数量增长持续恶化**（近期一直在订阅新节目测试）——与"最近变卡"吻合，与开屏页设置无关。
3. **滚动中 hover 连环动画**：鼠标停在网格上滚轮滚动 → 卡片依次滑过指针 → 每张触发 `:hover` 的 blur 强度/transform/top **三属性 0.25s 过渡**（podcastLibrary.vue:1152-1158）→ 滚动期间连环重光栅化。两页都有此机制，但订阅页因底图大而代价更高。
4. **进页瞬间的 churn（不是持续掉帧）**：`activated()` 每次进页全量 `loadPodcasts()`——2N+1 个 Dexie 查询 + 整个列表对象替换（全卡重渲）+ **同步 `JSON.stringify` 整库写 localStorage**（podcastLibrary.vue:369-445）。开屏改首页后，每次都是"导航进入"订阅页（activated 必触发），进页即滚正撞上这段；以前开屏直落订阅页时，首屏加载完才开始滚。**这是"开屏页设置"唯一说得通的间接关联。**
5. **已排除**（防误修）：下载进度环 `dl-ring` 是 `v-if="false"`（B-35 暂停），progressMap 高频更新**不会**驱动订阅页网格重渲染；B-70 红点只在 DiscoverCard（首页），订阅页不读 `podcastBroken`；两页滚动走同一个 `main@scroll`（仅更新自绘滚动条，成本相同）。

## 三、四个假设 × 一分钟自测（按嫌疑排序，建议按序做）

| # | 假设 | 自测方法（DevTools Console / 操作） | 坐实后的修法 |
|---|---|---|---|
| H1 | 原图级 blur 光晕（×N 卡）滚动重合成开销 | 订阅页执行：`document.head.appendChild(Object.assign(document.createElement('style'),{textContent:'.podcast-card .cover-shadow{display:none!important}'}))` 再滚——**立刻顺滑即坐实** | 光晕底图降采样：canvas 缩到 ~64px 出 objectURL 缓存（blur(16px) 下与原图视觉无差、成本降 99%）；做进公共组件/工具一处修，首页同收益 |
| H2 | 滚动中 hover 过渡连环触发 | 把鼠标移到窗口最边缘（不压网格），用键盘 PgDn/拖滚动条滚——顺滑即坐实 | 滚动期间给网格加 `.is-scrolling` 禁 hover 过渡（项目已有 `.resizing` 同款先例，main scroll 防抖 150ms 摘除） |
| H3 | keep-alive 页面堆积/访问顺序效应（开屏改首页后，到订阅页时已挂着 home 等多页大量 blur 层，GPU 内存压力让后访问页吃亏） | 重启应用，**不去首页**直接进订阅页滚——顺滑即坐实（此时用户的开屏页直觉=对的，机制是间接的） | keep-alive 加 `max`；或隐藏页容器加 `content-visibility:auto` |
| H4 | activated() 重载 churn（只在进页头 1~2 秒卡） | 进订阅页后**等 3 秒**再滚——顺滑即坐实 | 软刷新：先用现列表渲染，Dexie 重载放 `requestIdleCallback`，diff 后再替换；stringify 防抖 500ms |

附加检查（与 F2 相关）：Console 跑 `const{db}=await import('@/utils/podcast/db');await db.episodes.count()`（或在任意页面打断点看），若已到数万级，说明预览垃圾膨胀（F2）开始拖慢 Dexie 路径，进一步支持尽快做 prune。

> 注：四者不互斥，H1+H2 大概率同时成立（机制上耦合：hover 过渡重光栅化的就是 H1 的大位图）。最优修复组合 = 光晕底图降采样（一处修、两页收益）+ 滚动禁 hover 过渡。

## 四、节目预加载（preload）可行性分析

> 术语澄清：Electron 语境的 "preload script" 是主/渲染进程桥接脚本，与本需求无关；这里指**数据预取（prefetch）+ 内存缓存**。

### 现状成本拆解（点进节目都花在哪）

- **已订阅节目**：`load()` = Dexie 读 podcast + 全部 episodes + 2×bulkGet（进度/统计）→ **一次性渲染全部单集 DOM**。数据读取通常 <100ms，大档节目（500+ 集）的瓶颈在 **DOM 渲染（=F1）**。
- **未订阅节目**：B-68 已做骨架+后台抓 RSS（网络 1~5s 不可消除，只能提前）。

### 框架支持度：完全可行，且改动小

数据层早已具备预取友好的性质：`previewPodcast` 幂等且 TOCTOU 安全（B-67 #7 修过）；`load()` 只读 Dexie，任何"提前写入/提前读取"都直接转化为点击时的命中。建议三层，按性价比排序：

**L1 内存缓存（先做，~40 行）**：模块级 LRU `Map<feedUrl, {podcast, episodes, ts}>`（容量 ~10 档）。`podcastDetail.load()` 命中 → **同步首帧渲染**，后台重读 Dexie diff 后 reconcile。失效钩子：订阅/取消订阅/刷新订阅/下载完成时 invalidate 对应 feedUrl。
**L2 hover 意图预取（次做，~50 行）**：订阅页/发现页卡片 `mouseenter` 停留 ≥150ms（防抖）→ 已订阅：预读 Dexie 灌 L1；未订阅：提前触发 `previewPodcast`。并发上限 2 + 在途令牌去重。用户"看到想点"到"点下去"通常有 300ms~1s，足够把 Dexie 读完、甚至把 RSS 网络请求抢跑半程。
**L3 空闲预热（可选）**：`requestIdleCallback` 把"最近收听前 N 档"episodes 预灌 L1 + `new Image()` 预热封面（Electron 磁盘缓存接管重复请求）。

### 约束与依赖（重要，决定做的顺序）

1. **L2 对未订阅节目会加剧 F2**（每次 hover 预取=整档 episodes 永久入库）→ **F2 prune 落地前，L2 只对已订阅节目启用**。
2. **不做 F1，大档节目预取了数据仍卡在渲染**：L1 命中后 500 行 DOM 一次性建立照样顿挫。**F1（首屏 50~100 条+滚动加载）是"秒开"的必要条件**，且它同时是 B-71 滚动卡顿的兄弟问题。
3. 推荐顺序：**F1 → L1 → L2(限已订阅) → F2 prune → L2 放开未订阅 → L3**。前三步合计 ~150 行，即可覆盖"点进节目秒开"的主观体验目标。

---
---

# 追加 · B-72（2026-06-11 第四轮）：统计动画"全部→周"方向裁切残影 —— 第三方诊断

> 用户报告：统计页范围切换动画，周→全部丝滑满意（图1）；**全部→周**则相邻行互相"裁切"（图2/3，心理研究所封面与名称上下都被切）。疑问："怎么来的就怎么回去"才符合直觉，为何两个方向表现完全不同？（数据来自 Dev 测试床，动画同一套代码。）

## 一、先回答核心疑问：两个方向走的根本不是同一种动画

用户截图自证（周总量 26h = 深度对话 2h + 历史的温度 7h + 商业内参 4h59m + 电影夜话 3h + 科技早知道 9h）：**周榜（5 档）是全部榜（12 档）的子集**。于是：

- **周→全部**：只有"进入"（7 行 enter）+ 留存行 FLIP 移动，**零离开行** → 走的是 enter 动画（bar 从 0 长出 + 轻微滑入），这条路线打磨了多轮，自然丝滑。
- **全部→周**：**7 行同时"离开"**（leave）+ 5 行 FLIP 上移 → 走的是 leave 动画（absolute + max-height 塌缩 + overflow:hidden 裁切）。

而当前实现里 **leave 不是 enter 的镜像**（enter=宽度生长+滑入；leave=高度裁切塌缩），且 leave 路径有一个独立的定位缺陷（见下）——"怎么来的怎么回去"的直觉之所以落空，是因为回去时执行的是一套**从未在"来"的方向上被检验过**的代码路径。这也解释了为何多轮打磨没发现：打磨时主要观察的是有 enter 的方向。

## 二、裁切的具体机制（读码定位，statsPage.vue v1.3 / HEAD 2077f94）

1. **离开行瞬移到错误位置（主因）**：`.stat-leave-active { position:absolute }` **没有钉坐标**（无 top/left）。Vue transition-group 的离开行脱离文档流后，其 absolute 静态位置按**新布局**重算——12→5 行时，7 个离开行不再停留在各自原来的 y，而是**集体跳挤到新列表的上部区域**，与正在 FLIP 上移的留存行大面积重叠。截图证据：图2/3 中显示**旧数据**（财经观察 105h、心理研究所 78h = 全部榜的值，周值早已不可能是它们）的行就是这些跳位的离开副本。
   - 历史呼应：v1.2.1 修过"离开行瞬移顶部一闪"，当时把 JS onLeave 钩子整个删了改纯 CSS——方向是对的（不该用 transform+强制 reflow 抢 FLIP 的定位权），但把"钉坐标"也一并丢了，**位置跳变只是从'弹到左上角'缓解成'挤到上部'**，离开行多时（本例 7 行）就原形毕露。
2. **每个离开行自带裁切**：max-height 52→0 + overflow:hidden = 从下往上裁（封面/名称先被切下半），这正是"上下都被裁切"里的"下"。
3. **v1.3 不透明底色让所有重叠都变成硬切边**："上"则来自压在它上面经过的留存行/相邻离开行——v1.3 给每行加了不透明底色（治残影是对的，不要回退），副作用是任何 mid-flight 重叠不再是半透明透叠，而是实打实的横向切割带。
4. **方向不对称的最后一块**：12→5 后新布局行距稀疏、有大段空隙（图2 商业内参与电影夜话之间），z-index:-1 的离开行从空隙里**露出来**；反方向 5→12 时新列表更高更密，不透明的新行几乎盖满旧位置——即使有同类乱象也被全程遮住。**不是反方向没问题，是反方向看不见问题。**

## 三、修复方案（保持 v1 重排路线与 v1.3 不透明底色，两步）

### 第 1 步（核心，~6 行）：离开行"钉在原地"再塌缩

```vue
<transition-group name="stat" tag="div" class="stat-list" @before-leave="pinLeave">
```
```js
// 只钉坐标，不碰 transform、不强制 reflow —— 与 v1.2 被否决的 onLeave 有本质区别，
// 不与 FLIP 抢定位权。before-leave 在 leave-active(absolute) 生效前触发，offsetTop 还是旧布局值。
pinLeave(el) {
  el.style.top = el.offsetTop + 'px';
  el.style.left = el.offsetLeft + 'px';
  el.style.width = el.offsetWidth + 'px';
},
```
CSS：`.stat-leave-active` 去掉 `width:100%`（由内联接管）。`.stat-list` 已是 `position:relative`，offsetTop 坐标系正确。效果：7 个离开行**在自己原来的位置**原地塌缩，不再跳挤到留存行身上——"心理研究所被上下裁切"类的串行重叠当场消失；留存行从它们身上方/下方滑过时，因不透明底色+z-index:-1，看到的是"上层行盖过正在原地收起的旧行"，层次自然。

### 第 2 步（对称性，可选但推荐，纯 CSS ~4 行）：让 leave 成为 enter 的镜像

enter = bar 宽 0→目标 + 行 translateX(-12px)→0；镜像的 leave = bar 宽→0（已有 `.stat-leave-to .bar{width:0}`）+ 行归位→translateX(-12px) 滑出 + **max-height 塌缩延后**，让"条先缩回去、行再收起"，视觉上正是进入动画倒放：

```scss
.stat-leave-active {
  transition: max-height calc(0.3s * var(--stat-k,1)) cubic-bezier(0.22,1,0.36,1)
              calc(0.18s * var(--stat-k,1)),   // 延迟：先让 bar 缩
              transform calc(0.42s * var(--stat-k,1)) cubic-bezier(0.22,1,0.36,1);
}
.stat-leave-to { max-height: 0; transform: translateX(-12px); }
```
（transform 写在 CSS 过渡里与 FLIP 无冲突——v1.2.1 踩的坑是 **JS 里设 transform + 强制 reflow**，不是 transform 本身。）

### 验证协议（Dev 2x 慢放）

全部→周连续切换 ×5：① 不再出现任何"上下被切的横条带"；② 不再出现显示旧时长（105h/78h 等全部榜数值）的行串到错误位置；③ 离开行应在**原位置**收起；④ 反方向（周→全部）回归确认无变化。若仍见轻微交叉切边=留存行互相 crossing（图1 中其实已有、用户可接受），属 FLIP 重排的固有现象，可不处理；要进一步弱化可给 `.stat-move` 加 0.05s 过渡延迟让离开行先行。

## 四、结论一句话

不是"全部→周"的数据或参数问题，而是：**该方向独占的 leave 路径既不镜像 enter、又因 absolute 未钉坐标导致离开行集体跳位**，叠加 v1.3 不透明底色把重叠渲染成硬切边。钉坐标（第 1 步）即可消除主症状，镜像化（第 2 步）补齐"怎么来的怎么回去"的直觉对称。
