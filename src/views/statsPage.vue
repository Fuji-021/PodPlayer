<template>
  <div class="stats-page" data-selection="ui">
    <!-- [B-38] 顶部：彩虹猫跑步彩蛋（替代火星天）。文案宽度 = 彩虹条长度，末端 nyancat 在跑 -->
    <div class="hero">
      <div class="run-line">
        <span class="prefix">{{ catName }} 跑了</span>
        <span class="num">{{ totalHours }}</span>
        <span class="unit">小时</span>
        <span class="num">{{ totalMins }}</span>
        <span class="unit">分钟</span>
        <span class="prefix">，{{ mood }}</span>
      </div>
      <div class="rainbow-wrap">
        <div class="rainbow-bar"></div>
        <img class="nyan" src="/img/logos/nyancat.gif" alt="" />
      </div>
    </div>

    <!-- 范围切换：最近 1 周 / 全部（高亮块滑动跟手，非直接跳变） -->
    <div class="range-tabs" :class="{ 'is-all': range === 'all' }">
      <div class="tab-slider"></div>
      <div
        class="tab"
        :class="{ active: range === 'week' }"
        @click="setRange('week')"
      >
        最近 1 周
      </div>
      <div
        class="tab"
        :class="{ active: range === 'all' }"
        @click="setRange('all')"
      >
        全部
      </div>
    </div>

    <div class="range-total"> 共 {{ fmtDur(rangeTotal) }} </div>

    <div v-if="loaded && !visibleList.length" class="empty">
      这段时间还没有收听记录
    </div>

    <!-- [统计动画 v1.5] 时长矩形条统一动画：宽度由响应式 _w 驱动，走同一条 CSS width 过渡。
         留存条伸缩(俯视缩小)+FLIP 移动；新增条从 0 长出(从左)；离开条瞬时消失(v1.5)。全程不透明、无渐隐。 -->
    <transition-group name="stat" tag="div" class="stat-list">
      <div
        v-for="item in visibleList"
        :key="item.podcastId"
        class="stat-row"
        :style="{
          '--stat-bar-duration': item.barDuration + 'ms',
          '--stat-move-duration': item.moveDuration + 'ms',
        }"
      >
        <div
          class="bar"
          :style="{ width: item._w + '%', background: barColor(item) }"
        >
          <span
            v-if="barTexture(item)"
            class="bar-texture"
            :class="{ 'bar-texture-ready': barTexture(item).ready }"
            aria-hidden="true"
          >
            <span
              class="bar-texture-fill"
              :style="barTextureFillStyle(item)"
            ></span>
          </span>
          <span
            v-if="barTexture(item)"
            class="bar-texture-bridge-external"
            :class="{
              'bar-texture-bridge-ready': barTexture(item).ready,
            }"
            :style="barTextureBridgeStyle(item)"
            aria-hidden="true"
          ></span>
          <!-- [点击区收窄] 只封面可点跳转，进度条空白区不可点 -->
          <span class="thumb-shell">
            <PodImage
              class="thumb"
              :src="item.coverUrl"
              @error="onCoverError"
              @load="onStatsCoverLoad(item, $event)"
              @click.native="goPodcast(item)"
            />
            <span
              v-if="barTexture(item)"
              class="bar-texture-ingress"
              :class="{
                'bar-texture-bridge-ready': barTexture(item).ready,
              }"
              :style="barTextureBridgeStyle(item)"
              aria-hidden="true"
            ></span>
          </span>
        </div>
        <!-- [点击区收窄] 名字/时长区可点跳转 -->
        <!-- [文字渐隐·与进度条分开] opacity 只挂在文字(label)上 → 幽灵行只文字淡出，
             进度条(bar)只走自身 width 过渡自然伸缩、不淡出(符合物理) -->
        <div
          class="label"
          :style="{ opacity: item._op == null ? 1 : item._op }"
          @click="goPodcast(item, $event)"
        >
          <div class="name" data-selection="content">{{ item.title }}</div>
          <div class="dur">{{ fmtDur(item.wallSec) }}</div>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<script>
import { getListenStatsByPodcast } from '@/utils/podcast/listening';
import { getCoverColor } from '@/utils/podcast/coverColor';
import { shouldPreserveSelection } from '@/utils/selectionIntent';
import {
  isCurrentStatsBarAnimation,
  statsBarCleanupDelayMs,
  withStatsBarMotion,
} from '@/utils/podcast/statsBarAnimation';
import {
  STATS_BAR_TEXTURE_CONFIG,
  cancelStatsBarTextureRequests,
  collectStatsBarTextureResults,
  getStatsBarTexture,
  isStatsBarTextureValue,
  peekStatsBarTexture,
  shouldPrepareStatsBarTextures,
} from '@/utils/podcast/statsBarTexture';

export default {
  name: 'StatsPage',
  data() {
    return {
      catName: 'Fujii',
      // [B-40] 跑步趣味提示词随机池，每次进来随机一个（词别太长，免得撑破彩虹条）
      mood: '我还能跑～',
      moods: [
        '我还能跑～',
        '加油，干就完了！',
        '不想再跑了 qvq',
        '好累啊…',
        '好想睡觉啊～',
        '待会吃什么呢？',
        '也没看到终点啊…',
        '腿快不是我的了',
        '风里雨里都在跑',
        '再跑亿点点',
        '今天也很努力呢',
        '喵？还要跑吗',
        '坚持住，冲鸭！',
        '路还长着呢…',
      ],
      // [B-63] 默认"全部"；记忆用户上次选择(localStorage)，离开再回来保持
      range:
        localStorage.getItem('statsPage.range') === 'week' ? 'week' : 'all',
      totalWall: 0, // 全部累计（顶部大数字始终显示总量）
      rangeTotal: 0, // 当前范围合计
      list: [],
      // Only small data URLs and their ready flag are reactive. Canvas and image
      // objects stay inside the module scheduler so Vue never tracks bitmaps.
      barTextures: {},
      // [v1.5.4] 首次 fresh 取数完成前不渲染"暂无记录"空态(改先取数后建列表，取数窗口很短但要防空态闪现)
      loaded: false,
    };
  },
  computed: {
    totalHours() {
      return Math.floor(this.totalWall / 3600);
    },
    totalMins() {
      return Math.floor((this.totalWall % 3600) / 60);
    },
    // [B-47 第5点] 统计页不显示已屏蔽节目（取消屏蔽后恢复；数据不删，仅不显示）
    blockedNames() {
      return new Set(
        (this.$store.state.podcastBlocked.items || []).map(b =>
          (b.name || '').trim()
        )
      );
    },
    visibleList() {
      return this.list.filter(
        it => !this.blockedNames.has((it.title || '').trim())
      );
    },
    nyancatStyle() {
      return !!(
        this.$store &&
        this.$store.state &&
        this.$store.state.settings &&
        this.$store.state.settings.nyancatStyle
      );
    },
  },
  watch: {
    nyancatStyle() {
      this.prepareStatsTextures(this.list);
    },
  },
  async created() {
    this._statsTextureActive = true;
    await this.enterWithAnimation();
  },
  activated() {
    this._statsTextureActive = true;
    this.prepareStatsTextures(this.list);
  },
  deactivated() {
    this.invalidateStatsTextures();
  },
  beforeDestroy() {
    this.invalidateStatsTextures();
  },
  methods: {
    // [B-40] 每次进来随机一条跑步提示词
    pickMood() {
      this.mood = this.moods[Math.floor(Math.random() * this.moods.length)];
    },
    async loadTotal() {
      const { totalWall } = await getListenStatsByPodcast('all');
      this.totalWall = totalWall;
    },
    statsTextureRows(rows) {
      const blocked = this.blockedNames;
      return (rows || []).filter(
        item =>
          item &&
          !item._leaving &&
          item.coverUrl &&
          !blocked.has((item.title || '').trim())
      );
    },
    barTexture(item) {
      const entry = item && this.barTextures[item.podcastId];
      if (
        !entry ||
        entry.url !== item.coverUrl ||
        !isStatsBarTextureValue(entry.value)
      ) {
        return null;
      }
      return entry;
    },
    barTextureFillStyle(item) {
      const entry = this.barTexture(item);
      return entry ? { backgroundImage: `url("${entry.value.fillUrl}")` } : {};
    },
    barTextureBridgeStyle(item) {
      const entry = this.barTexture(item);
      return entry
        ? {
            backgroundImage: `url("${entry.value.bridgeUrl}")`,
            '--stats-texture-bridge-width': `${STATS_BAR_TEXTURE_CONFIG.bridgeWidth}px`,
            '--stats-texture-bridge-outer-width': `${STATS_BAR_TEXTURE_CONFIG.bridgeOuterWidth}px`,
            '--stats-texture-bridge-cover-ingress': `${STATS_BAR_TEXTURE_CONFIG.bridgeCoverIngress}px`,
          }
        : {};
    },
    hasCurrentStatsTexture(item, generation) {
      if (!this._statsTextureActive || !this.nyancatStyle) return false;
      if (generation !== this._statsTextureGeneration) return false;
      return this.isCurrentStatsTextureItem(item);
    },
    isCurrentStatsTextureItem(item) {
      return this.list.some(
        current =>
          current &&
          !current._leaving &&
          current.podcastId === item.podcastId &&
          current.coverUrl === item.coverUrl
      );
    },
    hotStatsTextures(rows) {
      const entries = {};
      const seen = new Set();
      const activeRows = this.statsTextureRows(rows);
      if (!activeRows.length) return entries;
      for (let index = 0; index < activeRows.length; index += 1) {
        const item = activeRows[index];
        const texture = peekStatsBarTexture(item.coverUrl);
        if (!isStatsBarTextureValue(texture)) return null;
        if (!seen.has(item.podcastId)) {
          entries[item.podcastId] = {
            url: item.coverUrl,
            value: texture,
            ready: true,
          };
          seen.add(item.podcastId);
        }
      }
      return entries;
    },
    invalidateStatsTextures() {
      this._statsTextureActive = false;
      this._statsTextureGeneration = (this._statsTextureGeneration || 0) + 1;
      const invalidGeneration = this._statsTextureGeneration;
      cancelStatsBarTextureRequests(task => {
        const token = task.options && task.options.token;
        return token && token < invalidGeneration;
      });
      if (this._statsTexturePublishFrame) {
        cancelAnimationFrame(this._statsTexturePublishFrame);
        this._statsTexturePublishFrame = null;
      }
      this._pendingStatsTextures = null;
      this._statsTextureImages = null;
      this.barTextures = {};
    },
    publishStatsTextures(generation, entries, immediate) {
      if (
        !this._statsTextureActive ||
        !this.nyancatStyle ||
        generation !== this._statsTextureGeneration
      ) {
        return;
      }
      const validEntries = {};
      Object.keys(entries || {}).forEach(key => {
        const entry = entries[key];
        const item = this.list.find(
          current =>
            current &&
            !current._leaving &&
            current.podcastId === key &&
            current.coverUrl === entry.url
        );
        if (item && entry && entry.value) validEntries[key] = entry;
      });
      if (!Object.keys(validEntries).length) return;
      const next = Object.assign({}, this.barTextures);
      Object.keys(validEntries).forEach(key => {
        next[key] = Object.assign({}, validEntries[key], {
          ready: !!immediate || this.prefersReducedMotion(),
        });
      });
      this.barTextures = next;
      if (immediate || this.prefersReducedMotion()) return;
      this.$nextTick(() => {
        if (
          !this._statsTextureActive ||
          !this.nyancatStyle ||
          generation !== this._statsTextureGeneration
        ) {
          return;
        }
        const ready = Object.assign({}, this.barTextures);
        Object.keys(validEntries).forEach(key => {
          if (ready[key] && ready[key].url === validEntries[key].url) {
            ready[key] = Object.assign({}, ready[key], { ready: true });
          }
        });
        this.barTextures = ready;
      });
    },
    queueStatsTexturePublish(generation, entries) {
      if (!entries || !Object.keys(entries).length) return;
      const pending = this._pendingStatsTextures || {
        generation,
        entries: {},
      };
      if (pending.generation !== generation) return;
      Object.assign(pending.entries, entries);
      this._pendingStatsTextures = pending;
      if (this._statsTexturePublishFrame) return;
      this._statsTexturePublishFrame = requestAnimationFrame(() => {
        this._statsTexturePublishFrame = null;
        const batch = this._pendingStatsTextures;
        this._pendingStatsTextures = null;
        if (batch)
          this.publishStatsTextures(batch.generation, batch.entries, false);
      });
    },
    prepareStatsTextures(rows) {
      const generation = (this._statsTextureGeneration || 0) + 1;
      this._statsTextureGeneration = generation;
      cancelStatsBarTextureRequests(task => {
        const token = task.options && task.options.token;
        return token && token < generation;
      });
      if (
        !shouldPrepareStatsBarTextures(
          this.nyancatStyle,
          this._statsTextureActive
        )
      ) {
        this.barTextures = {};
        return;
      }
      const activeRows = this.statsTextureRows(rows);
      const activeImageKeys = new Set(
        activeRows.map(item => item.podcastId + '|' + item.coverUrl)
      );
      const images = this._statsTextureImages || {};
      Object.keys(images).forEach(key => {
        const imageEntry = images[key];
        if (!imageEntry || !activeImageKeys.has(key + '|' + imageEntry.url)) {
          delete images[key];
        }
      });
      const hot = this.hotStatsTextures(activeRows);
      if (hot) {
        this.barTextures = hot;
        return;
      }
      this.barTextures = {};
      const startedAt = Date.now();
      const requests = activeRows.map(item =>
        getStatsBarTexture(item.coverUrl, {
          sourceImage:
            images[item.podcastId] &&
            images[item.podcastId].url === item.coverUrl
              ? images[item.podcastId].image
              : null,
          isValid: () => this.hasCurrentStatsTexture(item, generation),
          options: { token: generation, seed: item.coverUrl },
        }).then(value => ({ item, value }))
      );
      Promise.all(requests)
        .then(results => {
          if (
            !this._statsTextureActive ||
            generation !== this._statsTextureGeneration
          ) {
            return;
          }
          const entries = collectStatsBarTextureResults(results, item =>
            this.hasCurrentStatsTexture(item, generation)
          );
          // Keep this non-reactive for a later repeatable performance audit.
          this._statsTextureMetrics = {
            generation,
            visibleCount: activeRows.length,
            preparedCount: Object.keys(entries).length,
            totalMs: Date.now() - startedAt,
          };
          this.publishStatsTextures(generation, entries, false);
        })
        .catch(() => {});
    },
    onStatsCoverLoad(item, event) {
      const generation = this._statsTextureGeneration;
      const image = event && event.target;
      if (!this.isCurrentStatsTextureItem(item) || !image) return;
      this._statsTextureImages = this._statsTextureImages || {};
      this._statsTextureImages[item.podcastId] = {
        url: item.coverUrl,
        image,
      };
      if (!this.hasCurrentStatsTexture(item, generation)) return;
      if (this.barTexture(item)) return;
      getStatsBarTexture(item.coverUrl, {
        sourceImage: image,
        isValid: () => this.hasCurrentStatsTexture(item, generation),
        options: { token: generation, seed: item.coverUrl },
      })
        .then(value => {
          if (!value || !this.hasCurrentStatsTexture(item, generation)) return;
          this.queueStatsTexturePublish(generation, {
            [item.podcastId]: { url: item.coverUrl, value },
          });
        })
        .catch(() => {});
    },
    // [统计动画 v1 路线] 进入页面：以上次快照(各自宽度)为起点 → animateTo(fresh) 平滑过渡。
    //   留存条**同时**位移+伸缩(无等待)、新增条从左长出、离开条收走，即用户认可的"重排"动画。
    //   (v1=重排；v1.1=消残影；v1.2=去渐隐塌缩；v1.2.1=塌缩改纯CSS修顶部闪现；
    //    v1.3=整行不透明底色根治半透明条交叉透叠+文字叠糊残影；
    //    v1.4=离开行钉坐标+镜像[已废弃：快速切换时内联残留致崩]；
    //    v1.5=离开行**瞬时消失**(砍掉整条 leave 路径) + .bar overflow:hidden 修封面越界；
    //    v1.5.1=行间隙 margin→padding(涂实透明窗口) + 容器实底 + 去 isolation，修 FLIP 交叉漏出的细线；
    //    v1.5.2=行加页面同色 2px 光环(box-shadow spread)，盖死 FLIP 合成层亚像素发丝缝的"毛刺"；
    //    v1.5.3=.stat-leave-active{display:none} 让离开行真正即时消失；
    //    v1.5.4=enterWithAnimation 改"先取 fresh 再建列表"，根治"周快照里已过期节目(FView Friday)
    //           先渲染上屏(图1)→fresh 到了再移除(图2)=先出现后跳没"。快照仅作起点宽度、过期条永不上屏。
    //    规则见开发文档「版本命名规则」。)
    async enterWithAnimation() {
      // [C] 并发守卫：锁定本次加载序号与 range，每个 await 后校验，避免初次加载期间切范围导致旧 fresh 覆盖/存错键
      const seq = (this._loadSeq = (this._loadSeq || 0) + 1);
      const range = this.range;
      this.pickMood();
      // [v1.5.4 根治] 先取 fresh，再据它建列表 —— **绝不直接渲染快照**。
      //   旧逻辑先把快照渲染上屏：而"周快照"是上次存的，里面可能有现已过期(7 天前听过、出窗)的节目
      //   (如 FView Friday) → 先渲染快照=图1、fresh 到了再移除=图2，即用户报的"先出现后跳没"。
      const fresh = await getListenStatsByPodcast(range === 'week' ? 7 : 'all');
      // [perf·数据层整档重复读 + STATS-1 修] 顶部"全部累计"(totalWall)是全时段总量、与当前 range/列表无关，
      //   必须**无条件设置、不受下面列表 seq 守卫拦截**——否则初载期间切 tab 会让 totalWall 永停 0(master 无此回归)。
      //   range==='all'：fresh 本身即全量统计，直接复用(省一次 episodeListenStats 全表扫=本次 perf 目标)。
      //   range==='week'：顶部需全时段总量 → 独立 loadTotal()，**不 await**(其内部赋值与列表渲染解耦，等价 master 旧行为)。
      if (range === 'all') {
        this.totalWall = fresh.totalWall;
      } else {
        this.loadTotal().catch(() => {});
      }
      if (seq !== this._loadSeq) return;
      this.rangeTotal = fresh.totalWall;
      // 快照仅用来给"仍在 fresh 里的条目"提供**起点宽度**(返回页时各条从上次宽度平滑过渡)；
      //   不在 fresh 里的快照条目(过期/已变动)**永不上屏**。
      const snap = this.loadSnapshot(range) || [];
      const sMax = snap.length ? snap[0].wallSec || 1 : 1;
      const startW = {};
      snap.forEach(s => {
        startW[s.podcastId] = this.barTargetPct(s, sMax);
      });
      const maxWall = fresh.list.length ? fresh.list[0].wallSec : 1;
      const snapshotIndexes = new Map(
        snap.map((item, index) => [item.podcastId, index])
      );
      const next = fresh.list.map((it, newIndex) => {
        const target = this.barTargetPct(it, maxWall);
        // 在快照里→从上次宽度平滑过渡；新条→从 0 长出。
        const start = startW[it.podcastId] != null ? startW[it.podcastId] : 0;
        return withStatsBarMotion(it, start, target, {
          oldIndex: snapshotIndexes.has(it.podcastId)
            ? snapshotIndexes.get(it.podcastId)
            : newIndex,
          newIndex,
        });
      });
      this.list = next;
      // Textures are strictly visual overlays. Preparing them after assigning the
      // next list keeps the accepted width/FLIP state untouched and lets hot
      // texture hits join the first Vue paint.
      this.prepareStatsTextures(next);
      this.loaded = true;
      this.extractColors();
      // 双 rAF：先让起点宽度绘制一帧，再统一过渡到目标宽。写本次捕获的 next(非 this.list) → 防快速切换串写。
      this.$nextTick(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            next.forEach(it => {
              it._w = it._target;
            });
          });
        });
      });
      this.saveSnapshot(range, fresh.list);
      // [统计动画 R9] 把本范围 fresh 存入内存缓存 + 后台预热另一范围 →
      //   之后 setRange 切换即可"同步应用缓存"零 await 窗口，根治闪现/连点常驻(详见 setRange)。
      (this._rangeCache = this._rangeCache || {})[range] = fresh;
      this.prewarmRange(range === 'week' ? 'all' : 'week');
    },
    // [统计动画 R9] 后台预取某范围数据进内存缓存(失败静默)，供 setRange 同步切换。
    prewarmRange(r) {
      const cache = (this._rangeCache = this._rangeCache || {});
      if (cache[r]) return;
      getListenStatsByPodcast(r === 'week' ? 7 : 'all')
        .then(d => {
          cache[r] = d;
        })
        .catch(() => {});
    },
    // [统计动画 R9] 两份榜单是否实质不同(按 podcastId+wallSec)，决定后台校正要不要重渲。
    rangeListChanged(a, b) {
      const key = list =>
        (list || []).map(x => x.podcastId + ':' + x.wallSec).join('|');
      return key(a) !== key(b);
    },
    // [B-39] 异步提取每个节目封面主色填充矩形条（不阻塞渲染，到了再刷新该行）
    extractColors() {
      this.list.forEach(item => {
        if (item.colorHsl) return; // [B-61] 已沿用上次的色 → 跳过，避免重排时闪色(也=只对新增行取色)
        getCoverColor(item.coverUrl).then(hsl => {
          if (!hsl) return;
          // [B 位移修·放大器] 按 podcastId 查当前对象再写(而非闭包索引 i)：二次 animateTo 后 list 整体
          //   换过、索引会错位；按 id 查更稳，且只写还没色的，避免动画期多余响应式 patch 抬高撞帧概率。
          const cur = this.list.find(x => x.podcastId === item.podcastId);
          if (cur && !cur.colorHsl) this.$set(cur, 'colorHsl', hsl);
        });
      });
    },
    // [B-61/比例优化 2026-06-21] 单条目标宽度%（相对最长条；最长占 60% 留右侧给名字）。
    //   纯线性 *60 时短条(5分钟/17分钟)都 <7% 被 max(7) 兜底成等宽=不可区分；纯线性又让 5分钟≈0 太极端。
    //   方案:**KNEE(14%) 以上保持线性**(靠前长条满意、一字不变)；**KNEE 以下用 sqrt 把真实比例放大映射到
    //   [FLOOR, KNEE]**——短条之间按真实大小拉开区分(5分钟<17分钟)、又都 ≥FLOOR(放得下封面)、且不极端。
    barTargetPct(item, maxWall) {
      const linear = (item.wallSec / Math.max(1, maxWall)) * 60;
      const KNEE = 14; // 拐点(%)：此值以上线性不变(靠前长条满意方向)
      const FLOOR = 7; // 最短可见(放得下封面)
      if (linear >= KNEE) return linear;
      const t = linear / KNEE; // 0~1：本条在拐点内的真实占比
      return FLOOR + (KNEE - FLOOR) * Math.sqrt(t);
    },
    // [B-61] 把当前 list 平滑过渡到 freshList（统一动画核心）：
    //   留存条：保持当前宽 → 下一帧过渡到新宽(最长条变长→其余整体变细=俯视抬高缩小) + FLIP 移动
    //   新增条：宽度从 0 长出(从左边长出来)，不透明(v1.2 去淡入)
    //   [统计动画·筛出缩回 2026-06-21] 离开条(切到新范围后被筛掉、新 fresh 里没有的节目，如"全部→一周"
    //     里一周没听过的"三个火呛手")：不再瞬时消失，而是造一个保留原 podcastId 的"幽灵行"(_leaving)
    //     继续留在列表里，_target=0 → 下一帧 width 缩回到 0，缩回过渡(0.6s×animK)结束后定时器再真正移除。
    //     反方向"一周→全部"ghosts 为空、merged===next，逐帧与现状一致(用户满意方向不动)。
    animateTo(freshList) {
      // 本次切换的动画守卫：连点/快速来回切换时，旧的"清理幽灵定时器"作废、不误删新一轮列表。
      //   [B 位移修·改用 1A] 不再用 _animBusy 串行化(那会让连点排队=不跟手)；改为在 setRange 把"缓存命中后
      //   的 fresh 校正"推迟一帧执行，避免一帧内二次 this.list 赋值撞帧。连点每次都立即 animateTo=跟手。
      const myTurn = (this._animSeq = (this._animSeq || 0) + 1);
      const maxWall = freshList.length ? freshList[0].wallSec : 1;
      // prevList 先剔除上一轮还没清完的幽灵，避免叠加 + 污染留存判定
      const prevList = this.list.filter(it => !it._leaving);
      const prev = {};
      prevList.forEach((it, oldIndex) => {
        prev[it.podcastId] = { item: it, oldIndex };
      });
      const next = freshList.map((it, newIndex) => {
        const previous = prev[it.podcastId];
        const p = previous && previous.item;
        const target = this.barTargetPct(it, maxWall);
        return withStatsBarMotion(it, p ? p._w : 0, target, {
          // 留存沿用色，避免闪色；新增条从 0 起。
          colorHsl: p ? p.colorHsl : undefined,
          oldIndex: p ? previous.oldIndex : newIndex,
          newIndex,
        });
      });
      // 差集"将被筛掉的节目"(新范围 fresh 里没有)→ 造幽灵行 _leaving、_target=0：保留原 podcastId 作 key
      //   使其仍在列表里(transition-group 不触发瞬时 leave)，下一帧 width 从当前宽缩回到 0。
      const freshIds = new Set(freshList.map(x => x.podcastId));
      const ghosts = prevList
        .filter(it => !freshIds.has(it.podcastId))
        .map((g, ghostIndex) => {
          const previous = prev[g.podcastId];
          return withStatsBarMotion(g, g._w, 0, {
            _leaving: true,
            _op: 1,
            oldIndex: previous ? previous.oldIndex : ghostIndex,
            newIndex: next.length + ghostIndex,
          });
        });
      const merged = next.concat(ghosts);
      this.list = merged;
      this.prepareStatsTextures(merged);
      // [兜底] 取色同步异常不能中断后面的双 rAF 过渡调度 + 幽灵清理定时器注册
      //   (否则当次切换进度条不伸缩/幽灵不清)；取色失败不影响动画。
      try {
        this.extractColors();
      } catch (e) {
        /* ignore */
      }
      // 双 rAF：先让"起点宽度"真正绘制一帧，再统一过渡到目标宽 → 必触发 width 过渡
      //   (留存条变宽 / 新增条从 0 长出 / 幽灵条缩回到 0)。
      // [v1.5/B69-V1 消除] 写的是本次捕获的 merged(每次 animateTo 都新建对象)而非 this.list：
      //   快速切换时旧 rAF 不会把"瞬时到位"误写进新一轮列表。
      this.$nextTick(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!isCurrentStatsBarAnimation(myTurn, this._animSeq)) return;
            merged.forEach(it => {
              it._w = it._target;
              // [名字渐隐] 幽灵行整行淡出(opacity 1→0)，与进度条缩回同步 → 名字不再"硬消失"
              if (it._leaving) it._op = 0;
            });
          });
        });
      });
      // 缩回(width)+文字淡出(label opacity)过渡跑完后真正移除幽灵；
      //   _animSeq 守卫:连点时旧定时器作废、不误删新一轮列表(连点每次 animateTo 都 _animSeq++)。
      if (ghosts.length) {
        const D = statsBarCleanupDelayMs(ghosts);
        const removeGhosts = () => {
          if (!isCurrentStatsBarAnimation(myTurn, this._animSeq)) return;
          this.list = this.list.filter(it => !it._leaving);
        };
        if (this.prefersReducedMotion()) {
          this.$nextTick(removeGhosts);
        } else {
          setTimeout(removeGhosts, D);
        }
      }
    },
    prefersReducedMotion() {
      return (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    },
    // [B-54] 上次进入时的排行快照（localStorage，按 range 分键），作为下次动画起点
    loadSnapshot(range) {
      try {
        return JSON.parse(
          localStorage.getItem('statsPage.snap.v2.' + range) || '[]'
        );
      } catch (e) {
        return [];
      }
    },
    saveSnapshot(range, list) {
      try {
        const slim = (list || []).map(x => ({
          podcastId: x.podcastId,
          title: x.title,
          coverUrl: x.coverUrl,
          wallSec: x.wallSec,
          colorHsl: x.colorHsl,
        }));
        localStorage.setItem(
          'statsPage.snap.v2.' + range,
          JSON.stringify(slim)
        );
      } catch (e) {
        // localStorage 满/异常忽略
      }
    },
    async setRange(r) {
      if (this.range === r) return;
      this.range = r;
      // [B-63] 记忆选择：离开再回来保持上次的范围
      try {
        localStorage.setItem('statsPage.range', r);
      } catch (e) {
        /* 忽略 */
      }
      // [统计动画 R9] 数据供给层根治"差集节目闪现 / 连点常驻"（动画形态=黄金版，一字未动）：
      //   ① 有缓存 → 同步 animateTo：await 窗口=0，切换当帧列表即正确，差集节目不再残留一帧(闪现)；
      //   ② 再后台取 fresh：**过期请求也回填缓存**，不再白扔 → 连点不再因 seq 守卫饥饿而冻结列表(常驻)；
      //   ③ 仅当本范围无缓存 或 数据实质变化时才用 fresh 校正，否则零重渲。
      const seq = (this._loadSeq = (this._loadSeq || 0) + 1);
      const cache = (this._rangeCache = this._rangeCache || {});
      const cached = cache[r];
      if (cached) {
        this.rangeTotal = cached.totalWall;
        this.animateTo(cached.list);
      }
      const fresh = await getListenStatsByPodcast(r === 'week' ? 7 : 'all');
      cache[r] = fresh; // 过期与否都回填缓存（供下次切换同步用）
      if (seq !== this._loadSeq) return; // 已被更晚的切换接替 → 不提交本次（防串台）
      if (!cached || this.rangeListChanged(fresh.list, cached.list)) {
        this.rangeTotal = fresh.totalWall;
        if (cached) {
          // [B 位移修 1A] 缓存命中已同步 animateTo 过一次；fresh 校正**推迟到下一帧**再做，避免与首次
          //   在同一帧内二次 this.list 赋值 → transition-group 据合并中间态算"旧位≈新位"丢 FLIP 直接跳。
          //   不串行化连点(连点每次走第一次的同步 animateTo)→ 快速连点仍立即跟手。
          await this.$nextTick();
          requestAnimationFrame(() => {
            if (seq !== this._loadSeq) return; // rAF 内再守卫，防被更晚切换接替
            this.animateTo(fresh.list);
          });
        } else {
          this.animateTo(fresh.list); // 无缓存 → 本就只此一次
        }
      }
      this.saveSnapshot(r, fresh.list);
    },
    barColor(item) {
      // [B-41] 封面主色 → 低饱和纯色 + 半透明（透明度低于实色封面，参考小宇宙：
      // 封面是实色焦点，时长条用同色系的"淡一档"衬托，不抢封面）。
      let c;
      if (item.colorHsl) {
        const [h, s, l] = item.colorHsl;
        c = `hsla(${h}, ${s}%, ${l}%, 0.6)`;
      } else {
        const str = item.podcastId || item.title || '';
        let h = 0;
        for (let i = 0; i < str.length; i++) {
          h = (h * 31 + str.charCodeAt(i)) % 360;
        }
        c = `hsla(${h}, 30%, 52%, 0.6)`;
      }
      // [裁切修 2026-06-26] 条用「半透明色 ×2 + body-bg 不透明底」双层背景：视觉与原半透明条
      //   完全一致(半透明色压在页面色上)，但整条变**不透明** → 重排交叉时条只用自身宽度干净
      //   覆盖下层条，不再依赖"整行铺不透明底"去盖(那会把相邻条按整行宽裁掉=用户截图的裁切)。
      return `linear-gradient(${c}, ${c}), var(--color-body-bg)`;
    },
    fmtDur(sec) {
      sec = Math.floor(sec || 0);
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      if (h > 0) return `${h} 小时 ${m} 分钟`;
      if (m > 0) return `${m} 分钟`;
      return `${sec} 秒`;
    },
    goPodcast(item, event) {
      if (shouldPreserveSelection(event, event && event.currentTarget)) return;
      if (!item.podcastId) return;
      this.$router.push({
        name: 'podcastDetail',
        params: { feedUrlEncoded: encodeURIComponent(item.podcastId) },
      });
    },
    onCoverError(e) {
      e.target.style.opacity = 0;
    },
    // [统计动画 v1.5] v1.4 的 pinLeave 已删除：内联钉的 top/left/width 在离开动画被**中途取消**
    //   (用户周/全部快速来回切，同 key 行复活)时不会被清掉 → 布局永久畸形、离开行卡死不走
    //   (Dev 实测"切换直接崩、周显示全部 12 行")。leave 路径自 v1~v1.4 五版皆出 bug(残影/顶闪/
    //   切割/越界/卡死)，v1.5 决定性收敛：**离开行瞬时消失**(无 leave 动画、无钩子、无内联残留)，
    //   留存行 FLIP + 新增行从左长出保持不变。
  },
};
</script>

<style lang="scss" scoped>
.stats-page {
  color: var(--color-text);
  padding-top: 28px;
}
// [B-38] 彩虹猫彩蛋：hero 宽度由文案决定，彩虹条同宽，末端猫在跑
.hero {
  // [B-39] block + fit-content：独占一行（范围 tab 换到下方），宽度仍=文案宽（彩虹条同宽）。
  // 原来 inline-block + tab 的 inline-flex 挤在同一行 → tab 挡住彩虹条末端的猫。
  display: block;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 46px; // 加大与下方 tab 的间距
}
.run-line {
  display: flex;
  align-items: baseline;
  gap: 4px;
  white-space: nowrap;
  .prefix {
    font-size: 18px;
    opacity: 0.7;
    font-weight: 600;
  }
  .num {
    font-size: 52px;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -1px;
  }
  .unit {
    font-size: 18px;
    opacity: 0.55;
  }
}
.rainbow-wrap {
  position: relative;
  width: 100%;
  height: 10px;
  margin-top: 12px;
}
.rainbow-bar {
  width: 100%;
  height: 10px; // ≈ "小时"字号(18px)的一半多一点，醒目的彩虹条
  border-radius: 5px;
  // 经典 nyancat 彩虹（厚度方向分层），复用 slider.css 的配色
  background: linear-gradient(
    to bottom,
    #f00 0%,
    #f90 17%,
    #ff0 33%,
    #3f0 50%,
    #09f 67%,
    #63f 83%
  );
}
.nyan {
  position: absolute;
  right: -18px; // 猫探出条末端在跑
  top: 50%;
  transform: translateY(-50%);
  width: 40px;
  height: 27px;
  image-rendering: pixelated;
}
.range-tabs {
  position: relative;
  display: inline-flex;
  background: var(--color-secondary-bg);
  border-radius: 10px;
  padding: 3px;
  margin-bottom: 12px;
  // [toggle 滑动跟手] 高亮块绝对定位，切换时 transform 平滑滑过去(替代原 active 背景直接跳变)。
  //   两 tab 等宽(flex:1)，slider 占内容区一半，is-all 时 translateX(100%) 滑到"全部"。
  .tab-slider {
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 3px;
    width: calc((100% - 6px) / 2);
    background: var(--color-body-bg);
    border-radius: 8px;
    transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
    z-index: 0;
  }
  &.is-all .tab-slider {
    transform: translateX(100%);
  }
  .tab {
    position: relative;
    z-index: 1;
    flex: 1;
    text-align: center;
    white-space: nowrap;
    padding: 6px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.18s, color 0.18s;
    &:hover {
      opacity: 0.9;
    }
    &.active {
      opacity: 1;
      color: var(--color-primary); // 背景由 .tab-slider 提供，不再直接切
    }
  }
}
.range-total {
  font-size: 13px;
  opacity: 0.55;
  margin-bottom: 18px;
}
.empty {
  text-align: center;
  opacity: 0.4;
  padding: 60px 0;
  font-size: 14px;
}
// [B-54] 排行重排动画：move=FLIP 位移（节目被刷上/刷下），enter=新增补入，leave=移除
.stat-list {
  position: relative;
  // [v1.5.1] 容器自身涂不透明底色：行下方/行间的一切区域都有"自己人"的实底，
  //   FLIP 重绘期间不会留下未失效的残影细线。isolation 已删(v1.5 起无 z-index:-1 离开行，
  //   独立层叠上下文反而徒增合成层、提高重绘残留概率)。
  background: var(--color-body-bg);
}
.stat-move,
.stat-enter-active,
.stat-row {
  transition: transform var(--stat-move-duration, 300ms)
    cubic-bezier(0.16, 1, 0.3, 1);
}
/* [统计动画 v1.2] 新增条：不再淡入。时间条"从左长出"由 .bar 的 width 过渡(0→目标宽)驱动，
   整条始终不透明 = 实心条生长；行级仅加「轻微左移→归位」让文字不硬蹦，无 opacity。 */
.stat-enter {
  transform: translateX(-12px);
}
/* [统计动画 v1.5/v1.5.3] 离开条：**瞬时消失**。
   leave 路径(absolute/钉坐标/max-height 塌缩/条回缩)自 v1~v1.4 五个版本反复出 bug：
   残影(v1.1)→顶部闪现(v1.2.1)→交叉透叠(v1.3)→跳位切割(v1.4)→快速切换内联残留崩坏(v1.4 实测)。
   v1.5 砍掉整条 leave 路径；但 v1.5.3 发现"删掉 leave CSS"≠ 真正瞬时——Vue transition-group 在
   FLIP move 阶段仍会把离开行**滞留约 0.6s**(显示陈旧内容)再移除：Dev 测试床 7 条离开被 FLIP 互相
   遮掩没暴露，master 上"唯一在全部不在本周"的单条节目(如 FView Friday)就露出"先显示→再跳走"。
   v1.5.3 显式 `display:none`：离开行即刻移出布局、不可见(无论 Vue 等不等过渡)，且不引入任何内联样式/
   绝对定位 → 不会重蹈 v1.4 覆辙。留存行 FLIP + 新增行从左长出保持原样。 */
.stat-leave-active {
  display: none;
}
.stat-row {
  display: flex;
  align-items: center;
  gap: 12px;
  // [v1.5.1/细线修] 行间隙由 margin 改 padding：margin 不涂背景=透明窗口，FLIP 交叉时
  //   下层行的文字/封面阴影会从 14px 窗口里漏出 1~2px 横向细线(用户截图"莫名其妙不干净的细线")。
  //   padding 属于行盒、被 v1.3 的不透明底色一并涂实 → 行与行无缝全覆盖，细线无处可漏。
  padding-bottom: 14px;
  // [点击区收窄] 整行不再可点(进度条空白处不跳转)，cursor 交给 .thumb(封面)/.label(名字)
  // .stat-move、.stat-enter-active 与 .stat-row 共用同一条 transform 过渡，避免后声明的
  // 行级 transition 覆盖 transition-group 的 FLIP 规则。
  //   [进度条不渐隐] opacity 过渡已移到 .label(只文字淡出)，进度条 .bar 只走自身 width 过渡自然伸缩。
  // [裁切修 2026-06-26] 去掉原「整行不透明底色 + 2px 同色描边」——它们为盖半透明条而**铺满整行**，
  //   副作用=重排交叉时按整行宽把相邻条裁掉(用户截图"卡片宽度被裁、形状不完整")。
  //   改由「条自带 body-bg 不透明底(见 barColor 双层背景) + 文字自带 body-bg 底」承担覆盖：
  //   覆盖只发生在条/文字各自宽度内 → 空白区透明、相邻条**完整透出不被裁**；条/文字不透明仍能
  //   干净自盖、不糊叠、不留残影(原 v1.3 残影根治的目的达成，方式从整行铺底改为元素自带底)。
  // [B-38] bar 宽度=时长比例（不再 flex:1），封面叠在条右端
  .bar {
    position: relative;
    height: 40px;
    border-radius: 8px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    // [B-61] min-width:0 → 新条能从 0 长出；静止态最窄=barTargetPct 的 7% 兜底(常规窗口 ≈ 40px+ 放得下封面)。
    min-width: 0;
    // [v1.5/越界修] 裁掉超出条框的内容：条窄于 40px 封面时(新增条从 0 长出的前几帧 / 极窄窗口的 7% 兜底条)，
    //   右对齐的封面会从条**左缘**溢出、捅出页面左边界(用户截图红圈"全部越界")。裁切后封面随条变宽逐渐露出，
    //   观感正是"从左长出带出封面"。
    overflow: hidden;
    // 伸长和缩回都使用同一条明显 ease-out 曲线；时长由本次宽度变化距离计算。
    transition: width var(--stat-bar-duration, 280ms)
      cubic-bezier(0.16, 1, 0.3, 1);
    .bar-texture {
      position: absolute;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      opacity: 0;
      transition: opacity 130ms cubic-bezier(0.16, 1, 0.3, 1);

      .bar-texture-fill {
        position: absolute;
        top: 0;
        bottom: 0;
        pointer-events: none;
        background-repeat: no-repeat;
        background-size: 100% 100%;
      }

      .bar-texture-fill {
        right: 0;
        left: 0;
      }
    }
    .bar-texture-ready {
      opacity: 1;
    }
    // The outer bridge is a separate, non-interactive paint layer. The
    // ingress segment itself lives inside .thumb-shell so the cover radius
    // clips its corners instead of leaving square overlay blocks visible.
    .bar-texture-bridge-external {
      position: absolute;
      z-index: 1;
      top: 0;
      bottom: 0;
      right: 40px;
      width: var(--stats-texture-bridge-outer-width);
      pointer-events: none;
      opacity: 0;
      background-repeat: no-repeat;
      background-size: var(--stats-texture-bridge-width) 100%;
      background-position: left top;
      transition: opacity 130ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .bar-texture-bridge-ready {
      opacity: 1;
    }
  }
  .thumb-shell {
    position: relative;
    z-index: 2;
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: var(--radius-cover-sm);
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    background: var(--color-secondary-bg);

    .thumb {
      position: relative;
      z-index: 0;
      display: block;
      width: 100%;
      height: 100%;
      border-radius: inherit;
      object-fit: cover;
      cursor: pointer; // [点击区收窄] 封面可点跳转
    }

    .bar-texture-ingress {
      position: absolute;
      z-index: 1;
      top: 0;
      bottom: 0;
      left: 0;
      width: var(--stats-texture-bridge-cover-ingress);
      pointer-events: none;
      opacity: 0;
      background-repeat: no-repeat;
      background-size: var(--stats-texture-bridge-width) 100%;
      background-position: right top;
      transition: opacity 130ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .bar-texture-bridge-ready {
      opacity: 1;
    }
  }
  // [B-38] 名字紧跟 bar（=与各自进度条右端对齐），不再固定右列对齐
  .label {
    min-width: 0;
    flex-shrink: 1;
    cursor: pointer; // [点击区收窄] 名字/时长可点跳转
    // [裁切修 2026-06-26] 文字自带 body-bg 不透明底：交叉时上行文字干净盖住下行文字(替代原整行铺底)，
    //   只占文字自身宽度、不裁邻条；静态下与页面同色=隐形。幽灵行随 _op 淡出时底色一并淡出，符合预期。
    background: var(--color-body-bg);
    // [文字渐隐] 幽灵行文字 opacity 1→0 淡出，与 .bar 缩回同一时长和曲线。
    transition: opacity var(--stat-bar-duration, 280ms)
      cubic-bezier(0.16, 1, 0.3, 1);
    &:hover .name {
      color: var(--color-primary);
    }
    .name {
      font-size: 14px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: color 0.15s;
    }
    .dur {
      font-size: 12px;
      opacity: 0.55;
      margin-top: 2px;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .stat-move,
  .stat-enter-active,
  .stat-row,
  .stat-row .bar,
  .stat-row .label {
    transition-duration: 0ms;
  }
  .stat-row .bar-texture {
    transition-duration: 0ms;
  }
  .stat-row .bar-texture-bridge-external,
  .stat-row .bar-texture-ingress {
    transition-duration: 0ms;
  }
}
</style>
