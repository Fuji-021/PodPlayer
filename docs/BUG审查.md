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

> （备注：资源池扩展属功能规划而非 bug，相关方案已移至 `docs/可探索资源池方案.md`。）

---
---

# 追加 · R6（2026-06-12）：统计页 FView Friday"出现后突然跳没"——第三方根因复盘

> 用户报告：全部→最近一周切换时，FView Friday 先出现（图1）随即跳没（图2）；主线 session 连修两轮（v1.5.3 display:none、v1.5.4 快照不上屏）仍未解决。要求第三方全面排查，疑似数据快照引起。

## 一、复盘结论（先说答案）

**v1.5.4 之后，这已经不是数据 bug，也不是快照 bug——是 v1.5 把离开动画整条砍掉后的必然观感**：切换瞬间，全场唯一的差集节目（FView Friday）在其他所有行丝滑动画的衬托下**零过渡地"啪"消失**。用户把这个"啪"持续报告为 bug，而 v1.5.3 的"修复"方向是让消失**更快更绝对**（display:none）——与用户在 B-72 轮明确表达的预期（"怎么来的就怎么回去"、条应当**边伸缩边移动地离场**）正好相反。越修越"瞬间"，用户就越觉得是 bug。

## 二、论证（读码 + 排除法）

1. **数据层是确定性的，周榜 fresh 列表不可能含 FView**（listening.js:190-199）：week 聚合 = `listenDaily.where('date').aboveOrEqual(cutoff)`，cutoff=本地日期键、同一天内恒定；FView 无窗内收听 → 必不在 fresh。**没有任何机制能让它"进入"周榜数据**。
2. 因此"在最近一周**出现**"只剩一种解释：点击 周 标签后，`loadRange` 在 `await getListenStatsByPodcast(7)` 期间（IndexedDB 聚合，几十~百余 ms），**屏上仍渲染着旧的全部榜列表**（含 FView），而 tab 高亮已切到"最近 1 周"——这就是图1。fresh 到达 → `animateTo` 重建列表 → FView 是 v-for 的移除项 → `.stat-leave-active{display:none}`（v1.5.3）**当帧隐藏** → 图2。"出现→跳没"完整闭环，全程与快照无关（toggle 路径从不读快照）。
3. **可证伪检查点**（请真机确认一次，若不符则推翻本诊断）：图1 那一刻 FView 行显示的时长应是**全部口径的旧值**（它是旧列表残留帧）。若显示的是"周口径"的小时长，说明它真进过周数据，本诊断作废。
4. v1.5.4（进页不再直接渲染陈旧周快照）**修的是真 bug、修得对**——但那只覆盖 created/enterWithAnimation 路径；用户两轮原话都是"**从全部切换到一周**"= toggle 路径（loadRange→animateTo），v1.5.4 没碰它。两个 session 一直在修"另一条路"。

### 五轮补丁的复盘表（为什么一直修不好）

| 版本 | 改动 | 对/错 |
|---|---|---|
| v1.4（采纳 B-72 钉坐标） | 离开行 absolute+内联钉 top/left/width | 方向对，但**漏了复活清理**：快速来回切时同 key 行复用 DOM、内联残留 → 布局崩。死因不是钉坐标本身，是缺 `beforeEnter` 里清内联（此点 B-72 方案当时未提示，本人之过，记录在案） |
| v1.5 | 砍掉整条 leave 路径 | **过度矫正**：把用户要的"优雅离场"一并砍掉，埋下本次"啪"的种子 |
| v1.5.1/v1.5.2 | padding 涂实/2px 光环 | 修的是 FLIP 细线/毛刺，与本案无关但本身成立 |
| v1.5.3 | display:none 让移除更瞬时 | **方向反了**：用户抱怨的恰是"突然跳没"，此举让它更突然 |
| v1.5.4 | 进页不渲染陈旧快照 | 真 bug 真修复 ✓，但不在用户报告的路径上 |

## 三、修复方案：数据驱动"软离场"（不碰 transition-group leave，规避全部历史雷区）

核心思路：**离开行不交给 Vue 的 leave 机制，而是作为数据保留在列表里完成"缩回去"的动画，结束后再真正剔除**。与现有"宽度由 `_w` 响应式驱动"的体系同构，正好是 enter（从 0 长出）的镜像 =「怎么来的怎么回去」。

```js
// animateTo 内（核心改动 ~15 行）：
const freshIds = new Set(freshList.map(x => x.podcastId));
const leaving = [];
this.list.forEach((it, idx) => {
  if (!freshIds.has(it.podcastId) && !it._leaving)
    leaving.push({ ...it, _leaving: true, _target: 0, _oldIdx: idx });
});
const next = freshList.map(/* 现状不变 */);
leaving.forEach(l => next.splice(Math.min(l._oldIdx, next.length), 0, l)); // 留在原相对位次
this.list = next;
// 双 rAF 统一过渡（现状不变，_leaving 行的 _w 会过渡到 0）
// 0.7s*animK 后真正剔除（高度已塌缩为 0，剔除零痕迹；display:none 兜底恰好保留）
setTimeout(() => { this.list = this.list.filter(x => !x._leaving); }, 700 * this.animK);
```
```html
<div class="stat-row" :class="{ leaving: item._leaving }" ...>
```
```scss
.stat-row { max-height: 54px; transition: max-height calc(0.6s*var(--stat-k,1)) cubic-bezier(0.22,1,0.36,1); }
.stat-row.leaving { max-height: 0; overflow: hidden; pointer-events: none; }
// .stat-leave-active{display:none} 保留——最终剔除时行高已 0，作零痕迹兜底
```

**为什么这套绕开了五轮踩过的全部雷**：
- 无 absolute、无内联钉坐标 → 无 v1.4 的复活残留崩坏面；
- 离开行仍在文档流中、高度平滑塌缩 → 留存行靠**布局流动**自然补位（不是 FLIP 跳变），无 v1.2.1 顶闪、无 B-72 跳位裁切；
- 全程不透明（条缩回 0 + 行高塌缩裁切），守住 v1.2 立的"无渐隐"教条；
- **快速来回切自愈**：切回时该 podcastId 重新出现在 fresh 里，animateTo 用 fresh 重建对象（无 `_leaving`）→ class 移除 → max-height 与 bar 从当前值平滑长回；挂起的 setTimeout 只剔除仍带 `_leaving` 的对象，新对象不受影响；
- toggle 的 await 窗口（图1 那 ~几十 ms）会被随后 0.6s 的离场动画整体吞掉，不再有"先停滞再瞬跳"的断裂感。

## 四、验证协议

1. Dev 2x 慢放：全部→周——FView 应**条缩回 0 + 行高收起**地离场（≈1.2s），下方行平滑上移补位；不再瞬间消失。
2. 全部↔周 1 秒内来回切 ×10：FView 行应能"半路折返"平滑长回，无布局畸形、无卡死行（v1.4 回归项）。
3. 进页（range 记忆为周）：FView 从头到尾不出现（v1.5.4 回归项）。
4. 周→全部：FView 正常从 0 长出（enter 路径不受影响）。
5. 可证伪检查（二-3）：若图1 时刻 FView 显示的是周口径时长，回报推翻本诊断。

## 五、方法论沉淀

连续五个版本都在"上一轮可见症状"上打补丁（残影→细线→毛刺→滞留→快照），没人退一步问：**这条 leave 路径的存在形态是否符合用户的预期语义？** 用户从 B-72 起反复说的是同一句话——"怎么来的就怎么回去"。当一个动画 bug 修了五轮修不死时，该怀疑的不是参数，而是路径本身的设计与诉求错位。

---
---

# 追加 · R7（2026-06-12）：v1.5.5 软离场为何反而更糟 —— R6 方案缺陷复盘与修正

> 用户反馈：v1.5.5（采纳 R6 的数据驱动软离场）落地后，退场动画（全部→周）**表现反而更糟糕**。要求审查最新改动并分析。

## 一、最新动画改动清单（commit `32f1c57`，读码核对 = 工作区现状）

| # | 改动 | 位置 |
|---|---|---|
| 1 | 行绑定 `:class="{ leaving: item._leaving }"` | 模板 :51 |
| 2 | animateTo：差集条标 `_leaving + _target:0`、splice 回原位次；双 rAF 后 `_w→0`；`700ms×animK` 定时剔除 | :258-289 |
| 3 | **所有 `.stat-row` 常驻 `max-height:60px` + `transition: max-height 0.6s`**；`.leaving{ max-height:0; overflow:hidden }` | CSS :504-511 |
| 4 | `.stat-leave-active{display:none}` 降为剔除兜底；beforeDestroy 清定时器 | :496, :136 |

实现与 R6 给的骨架一致——**v1.5.5 没有实现走样，变糟的根源在 R6 方案本身**。以下认领并修正。

## 二、为什么更糟（四个机制，按权重）

### W1【主因·美学】max-height 塌缩 = 把用户最厌恶的"裁切带"做成了 0.6~1.2 秒的常驻演出

`max-height→0 + overflow:hidden` 的全过程是：40px 的条+不缩放的文字+封面，被从底边往上**逐渐压扁成一条窄横带**，文字齐腰斩断、封面裁半——这正是 B-72 以来用户每一轮截图圈出来的"裁切/细线"形态。区别只是这次发生在原位、且持续 0.6s（Dev 2x = 1.2s）。对比 v1.5.3/v1.5.4 的瞬时消失：暴露时长从 0 帧变成 ~70 帧，丑的形态从"闪一下"变成"慢放表演"。**反而更糟，符合预期。**

### W2【根源·设计错误，R6 之过】"行高渐变"根本不是 enter 的镜像

R6 声称软离场是"enter 从 0 长出的镜像"，这个论断**不准确**。逐项对照 enter 的真实形态（读码）：

| 维度 | enter（来） | R6 的 leave（去） | 真镜像应该是 |
|---|---|---|---|
| 行高 | **瞬时全高占位**，从不渐变 | 0.6s 渐变塌缩 ← 错 | 保持全高，最后瞬时移除 |
| 下方行让位 | FLIP transform 平滑推开 | 布局流动（reflow）挤合拢 ← 错 | FLIP transform 平滑合拢 |
| 条宽 | 0→target 过渡 | target→0 过渡 ✓ | target→0 过渡 ✓ |
| 行位移 | translateX(-12)→0 滑入 | 无 | 0→translateX(-12) 滑出（可选） |

行高渐变是 enter 里**不存在**的运动维度——R6 不是镜像，是发明了第三种形态，"压扁"观感由此而来。

### W3【次因·运动学】留存行被两套系统同时驱动，轨迹非单调

FLIP 的 newPos 在 patch 后立即测量——那一刻离场行还接近全高 → FLIP 只补偿"重排"位移（transform, 0.65s 曲线）；随后 0.6s 里离场行高度塌缩，又让下方行经**布局回流**二次漂移（另一条 0.6s 曲线）。同一行的实际轨迹 = 两条不同步 ease 曲线之和 → 非单调、可见"先动一截又滑一截/微回弹"的发飘感。enter 方向从来只有 FLIP 一套系统，所以"来"丝滑、"去"发飘。

### W4【代价·性能与地雷】全行常驻 `transition: max-height`

a) max-height 是布局属性，0.6s 内**每帧整列表 reflow**，叠加本就存在的 bar width（也是布局属性）+ FLIP transform + v1.5.2 合成层光环 → Dev 2x 下 1.2s 持续布局抖动，可能掉帧；b) 声明在所有行上意味着未来任何行高样式变更都会被意外动画化（同 B-33 `transition:all` 的旧教训，隐性地雷）；c) `.leaving` class 当帧生效而 `_w→0` 要等双 rAF（2~3 帧后），高度先动、宽度后动，起步不同步。

## 三、修正方案 v1.5.6：回到"真镜像"（两阶段，删多于加）

**阶段 1（0.45s×k）——条缩回，行不动**：保留 `_leaving/_target:0` 数据机制（不变），**删掉全部 max-height 相关 CSS（三处）**。`.leaving` 只保留 `pointer-events:none`，可选加 `.leaving .label { transform: translateX(-12px); opacity 不动; transition: transform 0.45s }`（与 enter 的 translateX 镜像，纯 transform，不违反"无渐隐"教条）。视觉：FView 的条在原位、全高地缩回 0——与"来时从 0 长出"严格对称。

**阶段 2（缩完瞬间）——移除 + FLIP 合拢**：定时器从 `700×k` 改 `500×k`，剔除 `_leaving` 条 → Vue leave 触发 → 既有 `.stat-leave-active{display:none}` 零痕迹移除 → **下方行作为留存元素获得 `.stat-move` FLIP transform，平滑上移合拢**——与 enter 时"下方行被 FLIP 平滑推开"完全对称，单一运动系统，无 W3。此刻被移除的行只剩一行文字（条已为 0，若采用 label 滑出则文字也已离场），瞬时消失的视觉冲击趋近于零。

```scss
// v1.5.6 净改动：
.stat-row { /* 删 max-height:60px、删 transition:max-height */ }
.stat-row.leaving { pointer-events: none; /* 删 max-height:0、删 overflow:hidden */
  .label { transform: translateX(-12px); transition: transform calc(0.45s*var(--stat-k,1)) cubic-bezier(0.22,1,0.36,1); }
}
// JS：仅把 700 * this.animK 改为 500 * this.animK，其余不动
```

**风险面评估**：不新增任何动画系统——阶段 2 完全复用既有 FLIP move 与 display:none 兜底；自愈性保持（半路切回 fresh 重建无 `_leaving`，label transform 复位、条长回）；W4 的常驻 reflow 与隐性地雷随 max-height 删除而消失。

## 四、验证协议（Dev 2x）

1. 全部→周：FView 的条**全高原位缩回**（无任何压扁/裁切带），缩完后下方行平滑上移合拢；总时长 ≈0.9s×k。
2. 周→全部：enter 不受影响（条从 0 长出、下方行被推开）——两方向应呈肉眼可辨的镜像感。
3. 全部↔周 1 秒内快切 ×10：半路折返条平滑长回，无畸形、无残留（v1.4 回归项）。
4. 进页（range 记忆=周）：FView 不出现（v1.5.4 回归项）。

## 五、复盘归因（记录在案）

R6 的错误在于：提出"镜像"主张时**没有先逐维度核对 enter 的真实运动构成**就引入了行高渐变这个新维度——和主线五轮"对着症状打补丁"是同一类错误（对着"瞬时消失"这个症状补了个"渐变消失"，而没有核对"来"的形态）。修正后的 v1.5.6 每个运动维度都能在 enter 中找到一一对应的逆操作，"怎么来的怎么回去"第一次在机制层面成立，而不只是口号。

---
---

# 追加 · R8（2026-06-13）：shownotes 被"折叠"——真实 feed 实测定案 + B-82 为何无效

> 用户报告：时间戳 seek 修复后，部分单集 shownotes 不再完整（野声宝库、接触印相 Vol.48"牵着骆驼穿行肯尼亚700公里"——后者连时间戳都被折叠），只剩"去小宇宙看完整"；罗永浩的十字路口、半拿铁完整如常。主 session 修了一轮（B-82 补读 content:encoded）仍未解决，要求第三方排查 + 分析 B-82 为何无效。

## 一、实测定案（2026-06-13，iTunes Search 取 feedUrl → 直拉真实 feed 解剖，PowerShell 于本机执行）

| 节目 | feed 托管 | 前 3 集 description 长度 | content:encoded 长度 | 截断尾巴 |
|---|---|---|---|---|
| 罗永浩的十字路口 | **feed.xyzfm.space（小宇宙）** | 2399 / 2060 / 2344 | **与 description 完全相同** | 无 |
| 野声宝库 | feed.xyzfm.space | 777 / 828 / 795 | **与 description 完全相同（同为截断版）** | "在小宇宙查看该单集文稿" |
| 接触印相（含 Vol.48 骆驼那期，descLen=759） | feed.xyzfm.space | 759 / 777 / 777 | **与 description 完全相同（同为截断版）** | 同上 |
| 半拿铁 | proxy.wavpub.com | （显示正常，未解剖） | — | 无 |

**结论 1（根因，数据侧）**：小宇宙对**部分节目**（按节目设置，非全局——罗永浩同为小宇宙托管却是全文）在 RSS 输出里把 shownotes **截断到 ~800 字** + 加"去小宇宙查看"尾巴；且 **content:encoded 也是同一份截断文本**。受影响节目的完整文稿**根本不在 RSS 里**。这就是"个别现象"的分界线：与是否小宇宙托管无关，与该节目 feed 是否被截断有关。

**结论 2（触发器，为什么"之前完整现在不完整"）**：B-80 新增的**后台自动刷新** + `refreshAllSubscriptions` 全量 `bulkPut` 整条覆盖 → 把库里早期抓取时存下的完整版覆盖成现在 feed 里的截断版。主 session B-82 对这半边的诊断**正确**。时间戳 seek 代码本身与此无关（B-82 这点也说对了）——"引入新问题"的因果在同批工作里的 B-80，不在 seek。

**结论 3（B-82 为何无效）**：`longerText(content:encoded, description)` 的前提假设是"完整文本在 content:encoded"——这个假设**没有实测就写进了修复**（他们自己在文档里也标了"待确认，需 feedUrl 验证"，但修复先行合入了）。实测三档 feed：enc 与 desc **字节级相等**，`longerText` 取到的还是截断版 → 修复对受影响节目空转。方向不算错（对真正带完整 encoded 的源有益、无副作用），但对本案无效。

**结论 4（损失评估）**：被 B-80 刷新覆盖掉的历史完整 description **本地不可追回**（bulkPut 无历史、无备份表）。唯一恢复途径见下。

## 二、修复建议（按优先级）

### ① 防降级 upsert（必做，~10 行，防止继续丢数据）

B-82 文档里列了"备选加固"但未做，应立刻做：刷新 upsert 时，**若新 description 以"在小宇宙查看"类尾巴结尾、或长度 < 库内旧值的 50%，保留旧值**（其余字段照常更新）。代价（合法变短不更新）远小于收益。注意：这只能保住"还没被覆盖的"，本轮已丢的救不回。

### ② 小宇宙单集页补全（可选增强，恢复已丢内容的唯一途径——已实测可行）

RSS item 的 `<link>` 就指向小宇宙**公开单集网页**（无需登录、SSR 直出）。实测 Vol.48 骆驼那期：页面 `__NEXT_DATA__` JSON 里 `"shownotes"` 字段为**完整 HTML 全文（~8627 字符）**，而 RSS 里只有 759 字。可做按需 enrichment：

- 触发条件：description 匹配截断尾巴模式（精准、不误伤）；
- 链路：主进程 ipcFetch 抓 `item.link` 页 → 正则/JSON 提取 `__NEXT_DATA__` 的 shownotes → 走现有 sanitizeHtml → 回写 db.episodes（一集一次、入库即缓存，配合①不再被刷掉）；
- 副产物：接触印相这类"被折叠的时间戳"随全文恢复，seek 功能自动回归；
- 风险标注（与 B-73 口径一致）：公开网页轻度抓取，无鉴权、比逆向 App API 低一档，但页面结构可能变 → 解析失败要静默降级回截断版；限流（仅打开单集详情时按需抓）。

### ③ UI 兜底（顺手）：检测到截断尾巴时，把尾巴链接渲染成显式的"在小宇宙查看完整文稿"按钮，替代现在混在正文里的样子。

## 三、给主 session 的复盘意见

诊断对了一半（B-80 覆盖链路 ✓、与 seek 无关 ✓），败在**关键假设未验证先合入**："完整文本在 content:encoded"只需一次 `Invoke-WebRequest` + 比对两个字段长度即可证伪（本轮实际耗时 <2 分钟）。这与 R6 的教训同构：方案里每一个"应该如此"的断言，都要么有实测、要么显式标成待验证并**阻塞合入**。另外"下次刷新自动救回"的承诺对受影响节目不成立，文档相应段落应修正，避免后续轮次误信。

---
---

# 追加 · R9（2026-06-13）：v1.5.4 黄金版"差集节目闪现/连点常驻"——实验复现定案

> 用户报告（基于回滚后的 v1.5.4 黄金版 + 测试床 0.5x/12 档数据）：① 全部→周切换，不该在周榜的节目**短暂出现又消失**；② **连续来回切换时这些节目"一直存在"**（不符合功能逻辑）；③ 它们消失时是"从上一个动画结束态瞬间消失，该在的节目立马补位"。动画本身 95 分，要求复现并找根源。

## 一、版本现状核对（读码 + git）

工作区 = v1.5.4 黄金版（`74bf3a5` 回滚后未再动 statsPage），`.stat-leave-active{display:none}`（:473）与 `_loadSeq` seq 守卫（:145/150）均在位，与归档描述一致。**用户记忆正确：当前是 .4**。开发文档已把"toggle await 残留帧"列为已知遗留，但**没有解释"连点常驻"**——后者正是本轮实验的核心收获。

## 二、实验设计（`scripts/stats_toggle_repro.js`，jsdom + 真实 Vue 2.7 transition-group）

组件逻辑**原样复制** v1.5.4 的 `loadRange / setRange / animateTo / enterWithAnimation`（含 seq 守卫、双 rAF、快照起点宽），仅把数据源换成可注入延迟的 fake（全部=12 档、周=5 档、**差集 7 档**，模拟测试床）。两个实验变量：**L** = `getListenStatsByPodcast` 聚合延迟，**T** = 来回点击间隔。每 20ms 采样 DOM 中实际存在的行。

> 局限声明：jsdom 不执行 CSS 过渡，本实验测的是**数据/DOM 存在性时间线**——而用户报的"不该出现的节目出现/常驻"恰好就是存在性问题，工具与问题对口；动画渲染层（display:none 瞬时消失的观感）属 v1.5.4 既定设计，不在本实验范围。

## 三、实验结果（原始时间线见脚本输出，此处摘要）

| 场景 | 条件 | 周态下差集节目在屏时间 | animateTo 提交/fetch 发起 | 对应用户描述 |
|---|---|---|---|---|
| S1 单次切换 | L=80ms | **100ms（≈L+1帧）后清零** | 1 / 1 | "短暂出现马上消失" ✓ |
| S2 来回快切 | T=250ms，L=80（L<T） | 每个周窗口前 ~100ms 有差集，随后清掉（占周态 46%） | 8 / 8 | 闪烁感 |
| **S3 来回快切** | **T=250ms，L=400（L>T）** | **100%——整个连点期间差集 7 档全程在屏，12 行原封不动** | **1 / 8**（仅停手后最后一次提交） | **"连续点击会一直存在" ✓✓** |
| S4 修复版 | 同 S3 恶劣条件 | ~12%（即每次切换 ≤1 个采样帧，是采样粒度噪声） | 8 / 8 | 根除 |

S3 时间线（节选）：`21ms→week/7差集/12行 | 263ms→all/7差集/12行 | 505ms→week/7差集/12行 | …` —— 8 次点击、8 次取数，**0 次在连点期间提交**，列表全程冻结在旧的全部榜。

## 四、根因（两层，都不在动画）

**根因 1（闪现）**：toggle 路径**没有任何同步可用的数据**——范围切换的唯一数据源是异步 Dexie 聚合，await 期间屏上必然是旧榜残留帧，可见时长 = 聚合耗时 L。**测试床更明显的原因之一**：种子数据量大 → `getListenStatsByPodcast('all')` 全表扫描更慢 → L 更长（0.5x 慢放只放大动画、不放大 L，但拉长了视觉混杂期）。

**根因 2（连点常驻，本轮新发现）**：`_loadSeq` 守卫的语义是"**过期请求只丢弃、不兜底**"。当点击间隔 T < 聚合耗时 L 时，每次取数都在下一次点击后才返回 → 全部被判过期丢弃 → **连点期间一次 animateTo 都不提交，列表彻底冻结**，差集节目自然"一直存在"；停手后最后一次取数落地，它们才"从上一个动画结束态瞬间消失（display:none）、该在的立马补位（FLIP/生长）"——与用户描述③逐字吻合。seq 守卫本身没错（防串台必需），错在它是该路径**唯一**的数据供给策略。

## 五、修复方案（S4 已验证；零改动黄金版动画形态，遵守"别动 leave 路径"的归档铁律）

**双范围内存缓存 + 同步切换 + 后台校正**（只动 `setRange/loadRange` 的数据供给，~25 行）：

```js
// setRange 改：
async setRange(r) {
  if (this.range === r) return;
  this.range = r;
  const seq = (this._loadSeq = (this._loadSeq || 0) + 1);
  const cached = (this._rangeCache || {})[r];
  if (cached) { this.rangeTotal = cached.totalWall; this.animateTo(cached.list); } // ① 同步应用缓存：await 窗口=0
  const fresh = await getListenStatsByPodcast(r === 'week' ? 7 : 'all');
  if (seq !== this._loadSeq) { (this._rangeCache ||= {})[r] = fresh; return; }      // ② 过期也回填缓存(供下次同步用)
  (this._rangeCache ||= {})[r] = fresh;
  if (!cached) { this.rangeTotal = fresh.totalWall; this.animateTo(fresh.list); this.saveSnapshot(r, fresh.list); }
  else if (changed(fresh.list, cached.list)) { this.rangeTotal = fresh.totalWall; this.animateTo(fresh.list); this.saveSnapshot(r, fresh.list); } // ③ 数据真变才校正
},
// enterWithAnimation 末尾顺手预热另一范围：getListenStatsByPodcast(另一范围).then(d => (this._rangeCache ||= {})[另一范围] = d)
```

要点：① 缓存命中 → animateTo **同步执行**，黄金版动画在两份正确数据之间过渡，差集节目从点击那一帧起就不在列表里——闪现与常驻同时根除（S4 实证：100%→采样噪声级）；② **过期请求不再白扔**，回填缓存让下一次切换更新；③ 页面生命周期内数据基本不变（统计页无播放中实时写入该聚合的场景），后台校正命中"无变化"时零重渲。组件无 keepAlive、每次进页重建，缓存无陈旧跨页风险——与 v1.5.4"先 fresh 再建列表"的进页原则不冲突。

**回归脚本**：`scripts/stats_toggle_repro.js`（`npm i -D jsdom` 后 `node scripts/stats_toggle_repro.js`），S1-S4 四场景断言可重跑。

## 六、真机验证协议（测试床 Dev）

1. 先量 L：`loadRange` 里临时 `console.time('agg')`/`timeEnd` 一次，确认测试床聚合耗时（预期 ≥100ms，若 <30ms 则真机现象会比实验温和，需回报重估）。
2. 修后单次 全部→周：差集节目**点击当帧即不在列表**，无闪现（对照修前 ≈L 的残留）。
3. 连点 T≈250ms ×8 停手：连点期间每次落在周态都只显示 5 档周榜（对照修前 12 行冻结）；停手无"瞬间消失+补位"的二段跳。
4. 黄金版动画回归：周↔全部各方向 FLIP/生长/瞬时离场观感与修前完全一致（本修不碰任何动画 CSS/机制）。
5. 快照/进页路径回归（v1.5.4 行为不变）：进页仍"先 fresh 再建列表"。

## 七、备注

- 用户描述的三个现象（闪现/常驻/瞬消补位）在实验里全部按预期复现并定位，**动画层 95 分的评价成立**——问题全部出在数据供给层，修复不需要也不应该再碰动画形态。
- 本轮与 R6 的关系：R6 当时定位了"闪现=await 残留帧"（正确）但给的治法（软离场）跑偏到了动画层；R9 实验补上了缺失的另一半（连点常驻=seq 丢弃饥饿），并把治法收敛到数据层——这才是与"95 分动画"兼容的最小修复。

---
---

# 闭环状态追踪（2026-06-13 · 接手审查 session 逐条读码核对）

> **本表为各编号项最新权威状态**。上文各轮报告（B-69 / B-69bis / B-71 / B-72 / R6 / R7 / R8 / R9）是**过程档案**——论证、复现、修复方案，原文保留不动以备溯源；但其中"待修 / 修复方向"字样**不代表当前状态**。下一轮排查请以本表为准。证据列均为本轮一手读码所得（文件:行号 / 轮次 commit）。

## ✅ 已闭环（读码确认，主 session 已采纳修复）

| 项 | 原诊断（轮次） | 落地方式 | 闭环证据（读码） |
|---|---|---|---|
| S0 睡眠滑轨塌缩 0px | B-69bis | `flex:1` 替 `width:100%`，绕开 vue-slider 内联 width:auto 塌缩 | `Player.vue:1906-1917` `.sl-track .vue-slider{flex:1}` + 原因注释在位 |
| S1 label 挤压滑轨 + scale 缓存 | B-69 §一 | label 与滑轨拆成上下行、几何恒定 | `Player.vue:300/303` `.sl-label` 与 `.sl-track` 已分离 |
| S2 end 模式重开不贴蓝标 | B-69 §一 | computeSleepRange 加 end 特判 | `Player.vue:845` `if(sleepMode==='end')` 分支 |
| P1 startPreview 无守卫（导航劫持/串台） | B-69 §二 | 递增 token + 销毁/路由守卫 | `podcastDetail.vue:416-420` `_previewToken`+`_isDestroyed`+route 校验 |
| F1 单集列表全量渲染卡顿 | B-69 §三 | 后台渐进水合：首屏 50 条 + rAF 逐帧补满全量 | `podcastDetail.vue:365-388`（B-75，commit 8a6b55a） |
| F3 下载页 N+1 串行 IndexedDB | B-69 §三 | 改 `bulkGet` 批量取 | `downloads.js:240-252` 注释 `[B69-F3]` |
| R8 shownotes 截断 | R8 | content:encoded 补读 + 小宇宙单集页补全 + 防降级 upsert + 后台预取去闪烁 | B-82/83/83.1（commit 567f1d8/71cd14a/97d3868）；`rssParser.js`+`shownotesEnrich.js` |
| R9 统计"闪现 / 连点常驻" | R9 | 双范围内存缓存 + 同步切换 + 过期回填 + 进页预热（动画形态一字未动） | B-84 v1.5.7（commit 1f13fe7）；`statsPage.vue:312-326`，**关键加固 `cache[r]=fresh`(:320) 确在 seq 校验 `return`(:321) 之前**——与 R9 方案逐条对齐，无走样 |

> **V1**（statsPage 错排窗口）随 R9 数据层根治应已消解、**V2**（长单集拖动精度）随 S0/S1 满宽轨道恢复应已达标——两者属"应已解决"，留真机回归一次即可销项。

## 🔴 仍开放（按优先级；本轮读码确认未修）

| 项 | 危害 | 状态 / 证据 | 修复方向 |
|---|---|---|---|
| **F2 预览数据无 prune** | **主要遗留（慢性病）** | `service.js:72` 预览未订阅节目整档 episodes 永久 `subscribed:false` 入库；全项目无清理逻辑（grep 无 previewedAt/prune/cleanup）。发现页多点几十张卡 = 几千条孤儿 episode 永久滞留，单调拖慢所有全表扫描路径 | 订阅时转正；预览数据打 `previewedAt`，启动清理超期(如7天)且无下载/无进度的孤儿档。**NAS / 资源池方案都会放大此问题（点卡片即涨垃圾），建议优先做** |
| F4 本地搜单集全表 JS filter | 低危 | `db.js` searchLocalEpisodes 无索引全扫；仅回车触发、当前量级可接受 | 先修 F2；随 F2 一并 |
| L1 本地搜混入未订阅预览 | 低危·语义 | searchLocalEpisodes 不按 subscribed 过滤，随 F2 增长越混越多 | join podMap 按 `subscribed!==false` 筛（若非有意设计） |
| L2 _updateMprisState 监听累积 | 低危·休眠 | 每次切歌注册 `saveLyricFinished` 永不移除；播客 track 取词必失败提前 return，**当前实际休眠** | 改 `once`（上游代码债，顺手） |
| L3 beforeDestroy 漏 closeQueuePanel | 微危 | 播放条常驻不销毁，现实影响≈0 | 补一行保持对称 |
| F5 播放心跳每秒 2 写 Dexie | 设计取舍·非 bug | 未改、无需改 | 未来功耗优化可把进度保存降到 3~5s/次（统计 tick 须保持 1s） |

## 统计动画方案演进线（收口）

B-72(钉坐标) → R6(软离场提案) → v1.5.5 落地 → **用户实测更糟** → R7 复盘认错 → **回滚 v1.5.4 黄金版** → R9(数据供给层根因) → **B-84 v1.5.7 = 黄金版动画形态 + R9 数据层修复**。被否的 v1.5.5 / 未落地的 v1.5.6 不再启用。**铁律：闪现/常驻已从数据层根治，今后不为它动 leave 路径 / 动画形态。**

---
---

# 追加 · R10（2026-06-13）：NAS 音源接入审查（feature/nas-source）—— 读码 + 真流实测

> 用户报告：主 session 已在 `feature/nas-source` 落地 NAS 接入、实测能播，但客户端只见一个「🛜 本集音源：NAS」toast，不确定是真打通还是占位，"几轮就做好太神奇"，要求完整审查 + 抓 bug。

## 一、结论：真接入，非占位。toast 诚实，音频真从 NAS 流式取且可拖动。

四条证据链（读码 + 实测，非推断）：

1. **三级解析链真串联**（`Player.js _getAudioSource` :654-691）：①本地 `file://`(pathMap) → ②`resolveNasUrl(track)` 命中即 `return nasUrl` → ③`track.podcastAudioUrl`(CDN)。①③为现状**原文未动**（守住禁碰清单）；②的 `try/catch` 任何异常都落 ③，绝不阻断播放。
2. **toast 诚实**（:680）：`store.dispatch('showToast','🛜 本集音源：NAS')` 位于 `if (nasUrl){…}` 内、`return nasUrl` 前——**只在 resolveNasUrl 真返回 NAS 流 URL（且该 URL 就是交给 howler 的源）时才弹**。NAS 离线/解析失败 → 返回 null → 跳过 → 落 CDN → 不弹。注释标「R1 临时验证·便于无 DevTools 肉眼确认音源，接状态图标后删」。
3. **主进程真打 ABS**：`background.js:424 registerNasIpc()` 注册；`nasBridge.js` 用 axios（主进程，规避渲染端代理坑）走 `feedUrl→/api/libraries/{lib}/items 取 itemId → /api/items/{id}?expanded=1 取 audioFile.ino → 流URL /api/items/{id}/file/{ino}?token=`。`main.js:93` 启动调 `initNas()`。
4. **决定性·真流实测**（浏览器按同逻辑拼真实流地址 + Range 拉取）：`status 206` / `content-type audio/mp4` / `accept-ranges bytes` / `content-range bytes 0-100/28309797` → **真音频、支持拖动 seek、`?token=` 查询参数鉴权通过**。

**为何"几轮就做好"不神奇**：注入点收敛到一处（`_getAudioSource` 本就返回 Promise、契约不变），新增全是独立文件（nasBridge/nasSource/Navbar 状态点），不改既有逻辑；ABS 是现成开源软件、提供标准 HTTP Range 流。低耦合设计的预期结果，不是魔术。**额外亮点**：流 URL 用 `?token=` 而非 Authorization 头——正是 howler `html5:true` 流式播放下唯一可行的鉴权方式（context7 查证 howler 的 `xhr.headers` 仅 Web Audio 生效），主 session 踩对了。

## 二、Bug / 缺口清单（读码抓到）

| # | 级别 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| **B-NAS-1** | **中·缺口** | **设置页无 NAS 配置 UI**（方案 P2 未落地） | `settings.vue` NAS 命中=0；配置靠手写 `nas-config.json` | 后果：app 内无法查看/改/关 NAS、不能换 token、无"测试连接"。个人预览可暂接受，但应补开关+地址+token+库+测试按钮 |
| **B-NAS-2** | 中·断联缺口 | 中途掉线只覆盖 `loaderror`，未覆盖 `playerror`/静默 stall | `Player.js:513` 仅 `on('loaderror')`；方案 P3 要 loaderror+playerror 双覆盖 | loaderror 走重建+seek 会自动落 CDN（OK）；但"播放中数据流静默停住不抛 error"无 recovery → 卡住。补 playerror + stall 看门狗 |
| **B-NAS-3** | 轻 | 验证 toast 注释说"弹一次"但**无 once 守卫** | `:677-684` 每播一集 NAS 都弹，loaderror 重建路径(:524→_getAudioSource)会再弹 | Navbar 状态图标已做（绿/红 wifi），此 toast 可直接删或加 once 标志 |
| **B-NAS-4** | 轻 | 熔断 30s 窗内 NAS 死，切集最坏等 ~6s | `nasSource ensureProbed` 30s 不重探 + `nas:resolve` 走 API 6s 超时才落 CDN | 快路（probe 800ms）只在 >30s 窗生效；可在 resolve 前并发一个轻探测，或缩短 resolve 超时 |
| **B-NAS-5** | 记录·安全取舍 | token 进了渲染端 URL（`?token=`） | `nasBridge.streamUrl` 含明文 token，交 howler，会现于 DevTools Network | howler html5 流式的唯一可行法、LAN token 风险低；**勿把含 token 的 URL 打进持久日志** |

非问题（复核排除、防误修）：①③ 原文未动 ✓；默认 OFF 双保险（store `enabled` 默认 false + nasSource `enabled` gate）✓；缓存 TTL 10min（新归档集最多 10min 后可解析，合理）；主进程 nasBridge.js 遵守"不用 `?.`/`??`"约束 ✓（`Player.js` 的 `??` 在渲染端、合规）。

## 三、给用户："如何自证真用了 NAS"（回应核心疑问）

1. **toast「本集音源：NAS」= 铁证**：代码层面只在真取 NAS 流时弹（见一-2）。
2. **导航栏 wifi 状态点**（你可能没注意）：绿色呼吸=NAS 在线·音源就近；红色静止=断联走 CDN；点击=手动重连探测。
3. **终极对照实验**（最直观）：停掉 ABS 容器 → 再播同一集 → toast 不再出现、导航点变红、但**播放照常（落 CDN）** → 同时证明「真用 NAS」+「熔断真生效、NAS 挂了不影响听」。

## 四、合并前建议（按方案第四节回归纪律）

P2 设置页（B-NAS-1）+ playerror 断联补强（B-NAS-2）是合并 master 前最该补的两项；B-NAS-3/4/5 可凑轮次顺手。回归清单（方案四节）建议在 **NAS 关闭态**跑一遍证明=现状，再 **NAS 开启态**跑一遍，重点验：停容器中途掉线能否自动续播（当前仅 loaderror 路径覆盖）。

---
---

# 追加 · R11（2026-06-13）：hover 预取性能回归 —— 订阅页滚动卡顿 + 详情页慢 + wifi 不秒出

> 用户报告：上一轮主 session 为"单集 wifi 图标进页第一刻没有"加了「我的订阅」节目卡 hover 预取（L2 意图预取）。结果**引入更严重的回归**：① 订阅页滚动卡顿（不如之前流畅）；② 点进节目页加载很久；③ wifi 标识反而**没有**秒出。要求着重排查、不放过细节。

## 一、根因（读码坐实）：hover 预取在滚动场景退化为"首次全档并发 NAS 请求风暴"，打爆主进程单一瓶颈

`onCardHover`（`podcastLibrary.vue:448-454`）：
```js
onCardHover(p) {
  if (!p || !p.id) return;
  if (!this._nasHovered) this._nasHovered = new Set();
  if (this._nasHovered.has(p.id)) return;   // 仅"重复 hover 同档"去重
  this._nasHovered.add(p.id);
  prefetchNasPodcast(p.id);                  // → 主进程 warmPodcast：拉整档 expanded
}
```

三个缺口（与 `docs/可探索资源池方案.md`/路线图里 L2 应有的"停留防抖 + 并发上限 + 在途令牌"相比，主 session 只做了 dedup）：

1. **无停留判定**：绑定 `@mouseenter`，鼠标**滑过即触发**，不是停住 ≥150ms 才触发。
2. **无 `isScrolling` 守卫**：组件**已有** `isScrolling`（B-71/H2 用来禁光晕 hover 形变，:868-873），但 `onCardHover` 完全没引用它。滚动时鼠标固定、卡片逐张从指针下滑过 → 每张触发 `mouseenter`（与 B-71/H2 同一机制）。
3. **`prefetchNasPodcast` 无并发上限**（`nasSource.js:152-159`，仅 `ensureProbed().then(invoke 'nas:warmPodcast')`）；主进程 `warmPodcast`（`nasBridge.js:178-190`）亦无在途去重，两个并发同档都会各拉一次 `ensureEps`。

**dedup 的局限是关键**：它只挡"同一张卡第二次 hover"，**挡不住进页后第一次滚动一次性扫过 ~36 档各发一个 `nas:warmPodcast`**。每个 warm = 主进程 `GET /api/items/{id}?expanded=1`（整档单集列表，几百 KB~MB）。**36 个并发请求挤进主进程单一 IPC/axios 瓶颈**，且此刻 NAS 还在跑 watchdog 重新入队的 2000+ 集下载（I/O 竞争）→ 响应更慢、在途堆积。

## 二、一次解释全部三现象（且都是本轮新增成本，故"比之前严重"）

| 现象 | 机制 |
|---|---|
| ① 滚动卡顿 | 滚动扫过卡片 → 每张 `onCardHover` → 首次全档 36× `invoke`；渲染端 Promise 回调串行 + 主进程被 36 个 expanded 拉取占满 → 两端 event loop 都忙 → 掉帧。叠加 B-71 既有光晕成本（光晕本身他们已按 H2 用 `.scrolling` 压住，但**预取 IPC 风暴是新的、未被任何节流覆盖**）。 |
| ② 点进节目页久 | 点进时主进程 IPC 通道正被 warmPodcast 队列 + NAS axios 在途塞满 → 详情页的 `nasEpisodeGuidSet` / 播放路径的 `nas:resolve`（`_getAudioSource`②级）全部排在风暴后面 → 解析/取流变慢。 |
| ③ wifi 不秒出（适得其反） | 详情页 `nasEpisodeGuidSet(feedUrl)` 的 IPC 卡在风暴后面 → guid 集合迟到 → 绿点迟出。**预取本为加速，却因灌爆同一个主进程瓶颈反而拖慢了它要加速的东西。** |

## 三、主 session 本轮做对的部分（balance，避免误删）

- B-71/H2 滚动禁光晕 hover 形变（`.scrolling` + :868-873）**已正确实现**，方向对；
- `onCardHover` 的 dedup（`_nasHovered`）本身**应保留**（防长期重复），只是不足以挡首次突发。
- 问题**不在"要不要预取"，而在"预取没有节流/守卫"**。修复是给预取加保护，不是回退预取。

## 四、修复方向（按 L2 应有保护补齐；最小改动即可消除风暴）

按性价比排序，前两条就能根治：

1. **加 `isScrolling` 守卫（一行，收益最大）**：`onCardHover` 开头 `if (this.isScrolling) return;`——滚动期间一律不预取（滚动正是风暴来源）。组件已有 `isScrolling`，零新状态。
2. **加停留防抖（~8 行）**：`mouseenter` 起一个 150–200ms `setTimeout` 后才 `prefetchNasPodcast`，`mouseleave`/再次滚动清除——只对"真的停在某卡上想点"的意图预取，滑过不触发。
3. **`prefetchNasPodcast` 并发上限 + 在途令牌（~15 行）**：模块级在途计数 ≤2、同档在途去重；即使有突发也被限流（belt-and-suspenders）。
4. **（可选）主进程 `warmPodcast` 在途去重**：同 itemId 正在 warm 则复用同一 Promise，避免并发重复 `ensureEps`。

> 验证协议（Dev 真机）：① 进「我的订阅」连续上下滚动 ×5 → 应顺滑、无首滚顿挫；② 滚动中用 DevTools Network/主进程日志看 `expanded` 请求数 → 修前首滚 ≈档数、修后应仅在"停留某卡"时零星出现；③ 停在某档卡 ~200ms 再点进 → wifi 标识秒出（预取意图达成）；④ 直接快速点进未 hover 的档 → 不卡（其 episodeGuids 单发、不再与风暴竞争）。

## 五、方法论小结

L2 意图预取的**全部价值在"节流"二字**：预取是用"空闲时提前做一点"换"点击时快"，一旦没有 dwell/scroll/并发 三道闸，它就从"提前一点"退化成"滑过即全量并发"，把本该加速的瓶颈反向灌爆。dedup ≠ 节流——dedup 防的是"重复"，节流防的是"突发密度"，本案缺的是后者。这与 B-71 当时给的 H2（滚动禁 hover 过渡）是同一类"滚动放大 hover 成本"的问题，只是这次放大的是 IPC/网络而非光栅化。

---
---

# 追加 · R12（2026-06-13）：IndexedDB 打不开 / 数据丢失 —— 四代理并行取证 + 联网确证

> 用户报告：数据库内容清零（`[DB Health]` podcasts/episodes/favorites 全 0，仅 episodeProgress 残 2 行），随后恶化为订阅/导入全失败 `UnknownError: Internal error opening backing store for indexedDB.open`、`indexedDB.databases()` 也 reject。要求"全面排查 + 力求复现 + 不口说无凭"。本轮启 4 个并行子代理（读码 / 多实例锁 / 文档时间线 / 沙箱复现）+ WebSearch 交叉验证。

## 一、结论：不是业务代码 / Dexie / prune，是 Chromium LevelDB 文件锁/损坏层；最可能"多个同身份 app 共开同一库"

`Internal error opening backing store for indexedDB.open` 是 Chromium IndexedDB 后端 **LevelDB 打开磁盘 backing store 失败**抛的底层错（联网确证：electron#39132/#42645、chromium#340398745），与 JS 业务逻辑无关。已**双重排除**代码侧：

- **读码（子代理A）**：全项目唯一 `new Dexie('yesplaymusic')`（`db.js:7`）；版本链 v1–v9 单调、无重复、无"同表改主键"故不会删表重建；主进程（`electron/`、`background.js`）**完全不碰 IndexedDB**（只用 electron-store JSON）；无 sqlite/leveldb 依赖。`prunePreviewOrphans` 是普通 `delete` 且**当前无任何调用方**——不可能损坏 backing store。
- **沙箱实测（子代理D，fake-indexeddb 真跑）**：逐行照抄 db.js 版本链，全新打开稳定到 v9、读写正常；Dexie 4 对"代码版本<磁盘版本"会 SchemaDiff **静默兼容而非抛错**；并发升级默认自动关旧连接、不卡死。**Dexie 配置层健康，非真凶。** （诚实边界：fake-indexeddb 是逻辑层，无法复现真实磁盘 backing store 错，那必须真 Electron。）

## 二、两个重大发现（之前无人注意，是埋雷的根因放大器）

**发现 1 —— `src/background.js` 源码被截断/损坏（子代理B 实证）**：文件仅 504 行，末尾停在 `globalShortcut.unregiste`（半行、无闭合分号）；`new Background()` 实例化、`will-quit`、**`app.on('second-instance')`** 全部缺失（grep 全 src 无 `new Background`/`second-instance`）。对比旧构建 `dist_electron/bundled/background.js` 是**有** second-instance 的——说明后来回退/损坏丢了。**后果**：① 这份源码无法正常构建/运行；② `requestSingleInstanceLock()`(:120) 实际跑不到、单实例保护形同虚设；③ 没有 second-instance 把已有窗口前置。

**发现 2 —— 三套同身份应用共用同一 LevelDB + 身份隔离被回退（子代理B 实证）**：`background.js:113-117` 把 userData 重定向到 `%APPDATA%\YesPlayMusicPodcast\`，IndexedDB 落在 `…\YesPlayMusicPodcast\IndexedDB\http_localhost_27233.indexeddb.leveldb`。本机至少三个入口都以 `setName('YesPlayMusicPodcast')` + 端口 27233 写同一库：① dev-serve；② 正式版安装包 `PodPlayer Setup 0.4.10.exe`（productName=PodPlayer 只改安装名、**不改 userData**）；③ 最新主构建 `dist_electron/index.js`(6/13)。**而曾为隔离把开发版改成独立身份 `PodPlayerDev`/10766/27244（见主文档 :2433-2435 实测双重独立），当前源码与最新构建已回退成同身份同端口** → 隔离失效。`start-dev.bat:13` 只 `taskkill electron.exe`，杀不掉正式版 `PodPlayer.exe`。

→ **多个同身份进程同时打开同一 `…indexeddb.leveldb` → LevelDB 独占 LOCK 争用 → 后开者 backing store 打不开**。这正是该 UnknownError 的教科书成因（WebSearch 印证：Chromium 建议用 requestSingleInstanceLock 缓解多实例）。

## 三、根因分级

| 级别 | 判断 | 证据 |
|---|---|---|
| 确证·排除 | 业务代码 / Dexie 版本链 / prune / upsert **不是元凶** | 子代理 A 读码 + D 沙箱实测 |
| **最可能根因** | 多个同身份 app（dev/正式/构建，皆 `YesPlayMusicPodcast`+27233）共开同一 LevelDB → LOCK 争用；或残留进程占锁；background.js 损坏使单实例保护失效、放大此雷 | 子代理 B + WebSearch |
| 未排除（需真机查） | LevelDB 文件物理损坏（断电/强杀/同步盘 OneDrive 占用/杀软扫描）、磁盘满、userData 权限 | WebSearch 列为高频诱因；现场未查 |

## 四、可复现（真机确定步骤，不口说无凭）

沙箱无法复现磁盘层（子代理D 已诚实声明），但给出**用户机器可执行的确定复现**：

- **复现 A（正式版 × dev-serve 共库）**：先运行已装的 PodPlayer 正式版（持 `…YesPlayMusicPodcast\IndexedDB\…27233…leveldb` 的 LOCK）→ 不关，再跑 `scripts\start-dev.bat`（同身份同端口同库）→ 第二个 `indexedDB.open` 抢不到 LOCK → 报 backing store。`start-dev.bat` 杀不掉正式版进程，故二者真并存。
- **复现 C（残留进程，最日常）**：关窗口但 `electron.exe`/`PodPlayer*.exe` 没退干净（残留持 LOCK）→ 立刻再启 → 同错。**清干净所有相关进程后再启动若恢复正常 = 坐实锁冲突。**

## 五、修复建议（交主 session，按急→缓）

1. **紧急：修复 `src/background.js` 截断损坏**——补回 `new Background()`/`will-quit`/`second-instance`，否则当前源码无法正常构建运行（头等）。
2. **恢复开发/正式身份+端口隔离**：开发版用独立 `PodPlayerDev` + 10766/27244（主文档 :2433-2435 原方案），保证 dev 与正式版/构建产物**永不共库**。
3. **加 backing-store 兜底**：`db.open().catch()` 检测 `UnknownError`/`InvalidStateError` → 给用户明确提示与"重建库"引导（别白屏卡死）；并补 `db.on('blocked'/'versionchange')`。
4. **`start-dev.bat` 清进程要含 `PodPlayer*.exe`**（不只 electron.exe）；userData 切勿置于 OneDrive/同步盘。
5. 数据备份缺口：app 的 Dexie（订阅/收藏/进度/统计）**一直无任何备份**——建议加定期自动导出（OPML + JSON）。本次订阅可从 NAS 的 ABS 导 OPML 重灌，进度/统计/收藏若无备份不可追回。

> 方法论：四代理并行（读码×2 + 文档 + 沙箱实测）+ 联网，各自独立取证再交叉——子代理C 凭文档曾怀疑"B-85 prune 删库"，被 A（prune 无调用方、是普通 delete）与 D（Dexie 层健康）证否；这正是多代理交叉的价值：单一视角的"看起来可疑"经实证被推翻，根因收敛到无人留意的 background.js 损坏 + 共库锁争用。

---

# 追加 · R13（2026-06-15）：首页节目封面"假修复"复盘 —— 思文败类没修好 + Nice Try 空白，根因是修复方向错

> 用户报：① 思文败类首页封面 ≠ 详情页（d6325f8 修过、仍不一致）；② Nice Try 首页根本不显示封面。读码定位：两者同一条链路，d6325f8 是典型"假修复"。

## 一、结论：不是个例，是"封面取值"结构性混乱 + 一次没打到点的补丁

- 首页播客封面**只走 `DiscoverCard`**（CoverRow 那几个是网易云遗留、`showLegacyHome=false` 已隐藏，无关）。
- `DiscoverCard.cover = dbCover || hiResLogo(podcast.logoURL)`；dbCover 靠 `coverFeedUrl = this.feedUrl || podcast.feedUrl` 查本地 DB 的 coverUrl。
- `this.feedUrl` 靠 `subscribedMap[name]` 反查 → **name≠RSS title（"思文，败类"带逗号）→ 反查失败 → feedUrl=''**；目录卡又不带 feedUrl → `coverFeedUrl=''` → 不查 DB → 回落 `hiResLogo(logoURL)` = **目录旧封面** → 与详情页（DB 真实 coverUrl）不一致。
- **Nice Try**：回落的 logoURL 本身加载失败（http 混合内容 / 防盗链 / CORS / 404），而 `onImgError` 只设 `opacity:0.15`（隐藏）、**无占位兜底** → 空白。

## 二、为什么"一直修不好 / 假修复"（方向错在哪）

1. **症状驱动、单点打补丁**：d6325f8 只为"思文败类"一个节目加了 `coverFeedUrl` 路径，没抽象出"封面取值统一规则" → 换个节目（Nice Try）立刻复现。
2. **没有复现验证闭环**：commit 写"核验 agent 两条全 PASS、eslint 0"——那是**代码逻辑层 PASS**，不等于"拿思文败类真实数据跑一遍真的好了"。**"agent PASS / eslint 0 / 待真机" 被当成 fixed，实则从未复现验证** → 假修复。
3. **修复建在错误前提上**：根问题是"回落目录 logoURL（旧/坏）"，d6325f8 却在错误地基上**再加一条查询路径**，而非纠正"封面真相应是 DB coverUrl、目录 logo 不可信"。它自己 commit 都标了"已知边界：无 feedUrl 仍回落 logoURL 本修不覆盖"——**思文败类恰落在这个没覆盖的边界里**，明知没修全却当修好。
4. **无失败兜底**：任何封面 URL 一坏就空白 → "修了 A，B 一坏又空白"，永远修不完。

## 三、暗藏的同类问题（不止这两个节目）

- **所有"目录名≠RSS title"或目录无 feedUrl 的发现卡节目**：首页都回落目录旧 logo → 不一致 / 旧 logo 坏则空白。普遍。
- **PodImage 全局无加载失败兜底**：下载 / 历史 / 收藏 / 搜索 / 详情 / 订阅 / 播放条都用它，`@error` 一律只 opacity 隐藏 → 任何节目 coverUrl 失效（防盗链 / http / 404）在这些页都空白。
- **http 封面未 https 化**：只有隐藏的 CoverRow 做了 `http→https`，DiscoverCard / PodImage 没做 → http 封面易被混合内容拦。

## 四、根治建议（治本，别再单点补丁）

1. **统一封面取值规则**（一处、全组件共用）：**DB coverUrl 为唯一封面真相** → 查不到再用目录 logoURL → 都失败用**占位图**。别每组件 / 每节目各写各的。
2. **关联别再靠 name**：name 先归一化（去标点 / 空格 / 大小写）再查 subscribedMap，救一批 name≠title；彻底是目录数据补 feedUrl 或用 Apple id 关联本地库。
3. **加载失败占位兜底**：`PodImage` 内置默认占位（默认封面 / 节目首字母），`onImgError` 不再 opacity 隐藏 → 一处生效、全局杜绝空白。
4. **http→https**：封面 URL 统一升级（至少 DiscoverCard + PodImage）。

## 五、方法论（给主 session，避免再"假修复"）

- **先复现、后修、再用同输入验证**：拿触发 bug 的**真实数据**（节目 name/feedUrl/logoURL/coverUrl）复现，修完用**同一数据**确认真没了。**"agent PASS / eslint 0 / 待真机" ≠ fixed**。
- **第二次出现就抽规则**：同一现象第二次复现（思文败类 → Nice Try）应停下抽统一规则，而非再加一条 if。
- **先质疑前提**：修之前先问"现在这条路本身对不对"（此处=该不该回落目录旧 logo），别在错误地基上加补丁。
