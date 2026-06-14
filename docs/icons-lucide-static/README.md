# PodPlayer 图标替换 · Lucide 官方 svg（全静态 · 零改引用）

> 审查 session 交付。本目录 25 个 svg 全部取自 **Lucide 官方包 `lucide-static` v1.18.0（ISC 许可，可商用）**，**非手绘**。
> 每个文件名 = 项目 `src/assets/icons/` 里的**原文件名**，主 session **直接覆盖同名文件即可，组件里的 `icon-class` 一行都不用改**。
>
> 本轮原则（用户 2026-06-14 定）：
> - **图标静态、点击有反馈**：不做常驻动画、不做逐图标花哨动效（弃用 `icons-v3/` 那套）；但**保留一套统一、克制的点击微反馈**（按压回弹，见 §六）。
> - 项目**原自带图标不换**；**NAS**（`router-wifi-alt`/`wifi`）、**logo**（`on-air-square`）、首页**瓶盖**（`bottle-cap`）不换。
> - 其余"改造期新增、风格不统一"的图标，按功能语义换成 Lucide 官方对应。

## 一、着色已验证可行（关键，无需改组件）

- SvgIcon 组件：`<svg class="svg-icon"><use/></svg>` + scoped `.svg-icon{fill:currentColor}`。
- Lucide 是**描边型**（`fill="none" stroke="currentColor" stroke-width="2"`）；项目原图标多是 fill 实心型。
- `vue.config.js` 的 svg-sprite-loader **没有 svgo 删属性配置**，Lucide 的 `fill/stroke` 属性会**原样进 symbol**。
- symbol 自带的 `fill="none"`（元素自身属性，优先级高于从 `.svg-icon` 继承来的 `fill:currentColor`）→ 描边**不会被填实**；`stroke="currentColor"` 跟随 `color` → **正常显色**。
- **结论：直接覆盖即可正常显示，无需引入 npm 包、无需改 SvgIcon 组件、无需任何 CSS。**
- 落地后建议真机扫一眼这几个"闭合型"确认未被异常填实：`check-circle` / `duration` / `ban` / `play-circle` / `checkbox` / `square-plus`。

## 二、映射表（项目文件名 ← Lucide 官方名 · 用途）

| 项目文件（覆盖） | Lucide 官方源 | 用途 |
|---|---|---|
| square-plus.svg | square-plus | 订阅 |
| checkbox.svg | square-check | 已订阅 |
| heart-crack.svg | heart-crack | 取消订阅 |
| check.svg | check | 选中 |
| check-circle.svg | circle-check | 已完成 / 已下载 |
| queue.svg | list-video | 播放队列 |
| queue-alt.svg | list-video | 队列（详情页） |
| play-circle.svg | circle-play | 插播 |
| layer-plus.svg | list-plus | 加入播放列表 |
| duration.svg | clock | 单集时长 |
| sort-alt.svg | arrow-up-down | 排序（订阅时间·双向） |
| arrow-up-small-big.svg | arrow-up-narrow-wide | 更新时间·升序 |
| arrow-down-small-big.svg | arrow-down-narrow-wide | 更新时间·降序 |
| arrow-right.svg | arrow-right | 进入 / 更多 |
| compass-alt.svg | compass | 发现 |
| menu-dots-vertical.svg | ellipsis-vertical | 三点菜单（**可选**，见下） |
| download.svg | download | 下载 |
| trash.svg | trash-2 | 删除 |
| clean.svg | eraser | 清理角标 |
| refresh.svg | refresh-cw | 刷新 |
| time-past.svg | history | 收听历史 |
| ban.svg | ban | 屏蔽 |
| radio-alt.svg | podcast | 节目（播客） |
| social-network.svg | bookmark | 播放条·时间标记 |
| moon.svg | moon | 睡眠定时 |

## 三、落地步骤（主 session）

1. 用本目录 25 个 svg **覆盖** `src/assets/icons/` 同名文件。零改引用（`icon-class` 不动）。
2. 不需 `npm i lucide`、不需改 `SvgIcon.vue`。把本目录 `tap-feedback.css` 并入全局样式，给可点击的图标加 `class="tap"`（点击微反馈，见 §六）。
3. **`menu-dots-vertical`（三点菜单）**：你 2026-06-13 曾定"三点菜单保留原样"。本轮给了对应的 `ellipsis-vertical`，**若不想换就删掉这个文件、别覆盖**；想统一成 Lucide 风格就照覆盖。
4. **`seek-backward-15` / `seek-forward-30`（±15/30 秒）**：Lucide **没有带数字的版本**，**保留项目现有自绘**，不在本批内。
5. **孤儿文件**（无引用，可删，见 `docs/图标审计.md`）：`info` / `sort-alpha-down-alt` / `sort-alpha-up-alt` / `cardinal-compass` / `sleeping-cat` / `waveform` / `quality` / `pending` 等——本批不含，按需清理。
6. 提交前 `git` 快照；落地后真机看一眼第 1 节列的 6 个闭合型图标。

## 四、保留不换

- **NAS**：`router-wifi-alt.svg` / `wifi.svg`
- **品牌**：`on-air-square.svg`（logo）
- **首页"再来一瓶"**：`bottle-cap.svg`（瓶盖，呼应文案趣味）
- 以及全部**原网易云自带**图标。

## 五、状态色（不写进 svg，由使用处着色，沿用旧约定）

- 已订阅 / 已完成 = `--color-success`（绿）
- 收藏「已」态 = `--color-danger`（红）——注：收藏 `heart` 是**原自带**，本批未换。

## 六、点击微反馈（统一、克制）

图标本身不做常驻动画、不做逐图标花哨动效；**只在用户点击时给一次轻微的按压回弹**，提供触感。一套规则通吃所有可点击图标（成熟 App 的通行做法），不逐图标定制。

- 文件：本目录 `tap-feedback.css`，并入全局样式即可。
- 用法：给**可点击的图标载体**加 `class="tap"`——可以是 `svg-icon` 组件本身（`<svg-icon class="tap" .../>`，会拼到 `svg-icon tap`），也可以是包裹它的 `button`/`a`/`div`。
- 效果：`:active` 时 `transform: scale(0.88)`、`0.12s` 回弹；**只缩放，无位移、无变色**；零 JS。
- 参数可调：嫌弱就把 `scale(0.88)` 调到 `0.84`，嫌慢就缩短 `0.12s`。
- 可选「点完回弹一次」：用 `.tap-bounce`（JS 点击时加、`animationend` 移除），比 `:active` 略活泼，仍克制。一般用 `:active` 足够。
- 无障碍：系统开启「减弱动画」时自动关闭反馈（已内置 `prefers-reduced-motion`）。
- 适用范围：交互图标（下载/删除/订阅/加入列表/排序/插播/三点菜单等）。纯展示性图标（如时长 `duration`、节目 `radio-alt` 作标识时）不必加 `tap`。
