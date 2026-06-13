<template>
  <div class="podcast-library">
    <div class="header">
      <!-- [B-33] 标题 + 紧贴"阅"字的"更多"按钮 → 点击弹排序下拉（选项文字外显，自带方向） -->
      <div class="title-row">
        <h1>我的订阅</h1>
        <div ref="sortControl" class="sort-control">
          <button
            class="more-btn"
            :class="{ active: sortMenuOpen }"
            @click.stop="toggleSortMenu"
          >
            <svg-icon icon-class="menu-dots-vertical" />
          </button>
          <transition name="sort-pop">
            <div v-if="sortMenuOpen" class="sort-menu" @click.stop>
              <div class="sort-menu-head">排序方式</div>
              <div
                v-for="opt in sortOptions"
                :key="opt.key"
                class="sort-menu-item"
                :class="{ active: sortBy === opt.key }"
                @click="setSort(opt.key)"
              >
                <svg-icon :icon-class="opt.icon" class="lead" />
                <span class="label">{{ opt.label }}</span>
                <svg-icon
                  v-if="sortBy === opt.key"
                  class="dir"
                  :icon-class="
                    sortDir === 'asc'
                      ? 'arrow-up-small-big'
                      : 'arrow-down-small-big'
                  "
                />
              </div>
            </div>
          </transition>
        </div>
      </div>
      <!-- [播客改造 A-22] 添加订阅 + 导入 OPML 合并为 + 号按钮 + 弹窗。
           A-23 之后 podcast 详情已拆为独立路由，本页只在订阅列表显示。 -->
      <div class="actions">
        <!-- [B-80] 清理角标按钮(原刷新按钮)：刷新已移到后台静默自动跑。
             有角标→点击像刷子摇晃一下 + 清零全部角标(角标各自播离场动画)；
             无角标→点不动，只轻微缩小下沉反馈。 -->
        <button
          class="clean-button"
          :class="{
            active: hasBadges,
            shaking: cleaning,
            sinking: sinking,
          }"
          :title="hasBadges ? '清理“有更新”角标' : '没有可清理的角标'"
          @click="clearBadges"
        >
          <svg-icon icon-class="clean" />
        </button>
        <div ref="plusControl" class="plus-control" @click.stop>
          <!-- [播客改造] title 屏蔽（不要原生 tooltip），文案保留供后续恢复 -->
          <button
            class="plus-button"
            :class="{ active: plusMenuOpen }"
            @click="togglePlusMenu"
          >
            <svg-icon icon-class="square-plus" />
          </button>
          <transition name="fade-pop">
            <div v-if="plusMenuOpen" class="plus-menu" @click.stop>
              <div class="plus-item" @click="onClickAddRss">
                <div class="t">粘贴 RSS 链接</div>
                <div class="s">单档节目订阅</div>
              </div>
              <div class="plus-item" @click="onClickImportOpml">
                <div class="t">导入文件</div>
                <div class="s">OPML 批量 / 单档 RSS / XML</div>
              </div>
              <!-- [B-51] 导出订阅备份 -->
              <div class="plus-item" @click="onExportOpml">
                <div class="t">导出 OPML</div>
                <div class="s">备份我的订阅为文件</div>
              </div>
            </div>
          </transition>
        </div>
        <input
          ref="opmlInput"
          type="file"
          accept=".opml,.xml,.rss,text/xml,application/xml,application/rss+xml"
          style="display: none"
          @change="handleImportFile"
        />
      </div>
    </div>

    <!-- [A-23] 订阅列表（一级界面）。节目详情已拆为 /library/podcast/:feedUrlEncoded 独立路由，
         < > 自然作为浏览器前进后退使用 -->
    <div
      class="podcast-grid"
      :class="{ resizing: isResizing, scrolling: isScrolling }"
    >
      <div v-if="loaded && !sortedPodcasts.length" class="empty-tip">
        还没有订阅。点击右上角 + 号添加 RSS 链接或导入文件。
      </div>
      <div
        v-for="p in sortedPodcasts"
        :key="p.id"
        class="podcast-card"
        :class="{ 'unsub-mode': unsubModeId === p.id }"
        @click="onCardClick(p)"
        @mouseenter="onCardHover(p)"
        @mouseleave="onCardLeave"
        @contextmenu.prevent="onCardContextMenu($event, p)"
      >
        <div class="cover-box">
          <!-- [B-44] 封面虚化光晕：所有位置封面统一具备"背景的那个光" -->
          <div
            class="cover-shadow"
            :style="{ backgroundImage: `url(${haloBg(p)})` }"
          ></div>
          <div class="cover-wrap">
            <PodImage class="cover" :src="p.coverUrl" @error="onCoverError" />
            <!-- [B-35→暂停] 封面下载进度 ring 应用户要求暂时取消。
               逻辑(podcastDlProgress) + 样式(.dl-ring) 保留，恢复时还原这段 svg 即可。 -->
            <!-- eslint-disable-next-line vue/no-unused-vars -->
            <svg
              v-if="false"
              class="dl-ring"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
            >
              <rect
                class="dl-ring-bar"
                x="1.2"
                y="1.2"
                width="97.6"
                height="97.6"
                rx="11"
                ry="11"
                pathLength="100"
                :stroke-dashoffset="100 - podcastDlProgress(p)"
              />
            </svg>
            <!-- [B-25 / bug-3] 右键后在封面上叠加 overlay，而不是单独小弹窗 -->
            <div
              v-if="unsubModeId === p.id"
              class="unsub-overlay"
              @click.stop="askUnsubscribe(p)"
              @mouseenter="cancelUnsubAutoClose"
              @mouseleave="scheduleUnsubAutoClose"
            >
              <svg-icon icon-class="heart-crack" />
              <div class="label">取消订阅</div>
            </div>
          </div>
          <!-- [B-46 / D-3] 有更新角标：后台刷新发现新单集即显示，进详情/点清理角标后清零。
               [B-80] 包 transition：清零时角标渐隐缩小离场(不让用户看到突兀消失)。 -->
          <transition name="badge-pop">
            <div v-if="p.newCount > 0" class="new-badge">有更新</div>
          </transition>
        </div>
        <div class="title">
          {{ p.title || '(无标题)'
          }}<span
            v-if="p.source === 'discover'"
            class="src-dot dot-discover"
            title="来自首页发现页订阅"
          ></span
          ><span
            v-if="nasOn(p)"
            class="nas-dot"
            title="NAS 上有此节目（音源就近）"
            ><svg-icon icon-class="wifi"
          /></span>
        </div>
        <div class="author">{{ p.author || '' }}</div>
        <!-- [B-31] 按用户要求：累计听过时长不在卡片下显示，留待将来"统计"入口页 -->
      </div>
    </div>

    <!-- [B-25] 取消订阅确认弹窗（应用内，替换系统 confirm） -->
    <div
      v-if="unsubTarget"
      class="dialog-mask"
      @click.self="unsubTarget = null"
    >
      <div class="confirm-dialog">
        <div class="title">取消订阅</div>
        <div class="msg">
          确定要取消订阅 <b>"{{ unsubTarget.title }}"</b> 吗？<br />
          单集历史进度不会被删除。
        </div>
        <div class="actions">
          <button class="btn-secondary" @click="unsubTarget = null"
            >取消</button
          >
          <button class="btn-danger" @click="doUnsubscribe">
            确定取消订阅
          </button>
        </div>
      </div>
    </div>

    <!-- [播客改造 C-1c] 导入进度弹窗 -->
    <div v-if="importPhase !== 'idle'" class="dialog-mask">
      <div class="import-dialog">
        <div v-if="importPhase === 'running'" class="import-running">
          <div class="title">{{ importLabel }}</div>
          <div class="bar-wrap">
            <div
              class="bar-fill"
              :style="{
                width:
                  (importTotal > 0 ? (importDone / importTotal) * 100 : 0) +
                  '%',
              }"
            ></div>
          </div>
          <div class="status">
            <span>{{ importDone }} / {{ importTotal }}</span>
            <span class="current" :title="importCurrent">{{
              importCurrent
            }}</span>
          </div>
        </div>
        <div v-else-if="importPhase === 'done'" class="import-done">
          <svg-icon icon-class="check" class="check" />
          <div class="msg">{{ importSuccessMsg }}</div>
        </div>
      </div>
    </div>

    <!-- 添加订阅对话框 -->
    <div v-if="showAddDialog" class="dialog-mask" @click.self="closeAddDialog">
      <div class="dialog">
        <div class="dialog-title">添加订阅</div>
        <div class="dialog-body">
          <input
            v-model="newFeedUrl"
            class="input"
            type="text"
            placeholder="粘贴 RSS 链接，例如 https://feed.xyzfm.space/xxxx"
            @keydown.enter="confirmAdd"
          />
          <div v-if="addError" class="error">{{ addError }}</div>
          <div v-if="adding" class="hint">抓取中…</div>
        </div>
        <div class="dialog-actions">
          <button class="btn-secondary" @click="closeAddDialog">取消</button>
          <button class="btn-primary" :disabled="adding" @click="confirmAdd">
            确定
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import {
  subscribeByRssUrl,
  importOpmlText,
  importRssText,
  getSubscribedPodcasts,
  deletePodcast,
  getEpisodesByPodcast,
  refreshAllSubscriptions,
  exportSubscriptionsOpml,
} from '@/utils/podcast/service';
import { getPodcastListenSummary } from '@/utils/podcast/listening';
import { getLastListenedByPodcast, updatePodcast } from '@/utils/podcast/db';
import {
  nasPodcastSet,
  normFeedUrl,
  prefetchNasPodcast,
} from '@/utils/podcast/nasSource';
import { ensureTinyCover } from '@/utils/podcast/coverHalo';
import SvgIcon from '@/components/SvgIcon.vue';

// [A-28] 取一档节目最新一集的 pubTime（用于"节目更新时间"排序）
async function getLatestEpisodeTime(podcastId) {
  const eps = await getEpisodesByPodcast(podcastId);
  if (!eps.length) return 0;
  // getEpisodesByPodcast 已经 reverse 按 pubTime 排序，第一条就是最新
  return eps[0].pubTime || 0;
}

export default {
  name: 'PodcastLibrary',
  components: { SvgIcon },
  data() {
    return {
      // [B-51] 冷启动用 localStorage 缓存秒显，避免"第一次打开程序时订阅短暂全部消失"
      podcasts: (() => {
        try {
          return JSON.parse(
            localStorage.getItem('podcastLibrary.cache') || '[]'
          );
        } catch (e) {
          return [];
        }
      })(),
      showAddDialog: false,
      newFeedUrl: '',
      addError: '',
      adding: false,
      // [B-80] 清理角标按钮：cleaning=摇晃中(有角标点击)，sinking=下沉反馈(无角标点击)
      cleaning: false,
      sinking: false,
      // [NAS] "NAS 上有此节目"的归一化 feedUrl 集合（连上 NAS 才非空；空=不显示任何 wifi 标识）
      nasPodSet: new Set(),
      // [B-47 / 第3点] 是否已至少加载过一次（避免加载期间闪"还没有订阅"）
      loaded: false,
      // [播客改造 A-22] + 号弹窗开关
      plusMenuOpen: false,
      plusOutsideListener: null,
      // [播客改造 C-1c] 文件导入进度弹窗
      importPhase: 'idle', // 'idle' | 'running' | 'done'
      importLabel: '',
      importCurrent: '',
      importDone: 0,
      importTotal: 1,
      importSuccessMsg: '',
      // [B-25 / bug-3] 卡片 unsub-overlay 模式：当前激活的卡片 id
      unsubModeId: null,
      unsubModeOutsideListener: null,
      unsubModeKeyListener: null,
      unsubModeAutoTimer: null,
      unsubTarget: null,
      // [A-28] 排序：updatedAt(导入) / title(名称) / episodeTime(最新一集)；方向 asc/desc
      // [B-75] 删除"按节目名"排序后，旧存档若是 'title' 回落到默认(按订阅时间)
      sortBy: (() => {
        const s = localStorage.getItem('podcastLibrary.sortBy') || 'updatedAt';
        return s === 'title' ? 'updatedAt' : s;
      })(),
      sortDir: localStorage.getItem('podcastLibrary.sortDir') || 'desc',
      sortMenuOpen: false,
      sortOutsideListener: null,
      // [B-33] 排序下拉选项（文字外显，自带方向箭头）
      sortOptions: [
        { key: 'updatedAt', icon: 'sort-alt', label: '按订阅时间' },
        // [B-75] 删除"按节目名"：播客名个性化，A→Z 排序无意义，去掉减视觉冗余
        {
          key: 'episodeTime',
          icon: 'arrow-down-small-big',
          label: '按最新更新',
        },
        { key: 'listenWall', icon: 'time-past', label: '按累计听过时长' },
        { key: 'lastListen', icon: 'pending', label: '按最近收听' },
      ],
      // [S 级 bug 修] 窗口缩放时禁用 transition，避免大量 .podcast-card 动画排队卡顿
      isResizing: false,
      resizeTimer: null,
      // [B-71/H2] 滚动期间禁用封面光晕的 hover 形变(同 .resizing 思路)，避免卡片滑过指针时
      //   大位图光晕连环重光栅化 → 滚动卡顿。滚动停 150ms 复位。
      isScrolling: false,
      scrollTimer: null,
      // [B-71/H1] 封面光晕降采样底图：coverUrl -> 64px 小图 dataURL（异步填充，未就绪先用原图兜底）
      haloMap: {},
    };
  },
  computed: {
    // [A-28] 排序后的订阅列表
    sortedPodcasts() {
      const arr = [...this.podcasts];
      // [B-47 第6点] 按最近收听：听过的按最近时间降序在前；没听过的排后、按累计时长降序
      if (this.sortBy === 'lastListen') {
        const wall = p => (p.listenSummary && p.listenSummary.wallSec) || 0;
        arr.sort((a, b) => {
          const la = a.lastListenedAt || 0;
          const lb = b.lastListenedAt || 0;
          if (la && lb) return lb - la;
          if (la && !lb) return -1;
          if (!la && lb) return 1;
          return wall(b) - wall(a);
        });
        return arr;
      }
      const sign = this.sortDir === 'asc' ? 1 : -1;
      const byKey = {
        updatedAt: p => p.updatedAt || 0,
        episodeTime: p => p.latestEpisodeTime || 0,
        listenWall: p => (p.listenSummary && p.listenSummary.wallSec) || 0,
      };
      const getKey = byKey[this.sortBy] || byKey.updatedAt;
      arr.sort((a, b) => {
        const ka = getKey(a);
        const kb = getKey(b);
        if (ka < kb) return -1 * sign;
        if (ka > kb) return 1 * sign;
        return 0;
      });
      return arr;
    },
    // [B-80] 是否有"有更新"角标可清理（决定清理角标按钮是否可点 + 高亮态）
    hasBadges() {
      return this.podcasts.some(p => (p.newCount || 0) > 0);
    },
  },
  mounted() {
    // [S 级 bug 修] 窗口缩放监听，加 .resizing 暂时禁用动画
    window.addEventListener('resize', this.onWinResize);
    // [B-71/H2] 滚动监听挂在外层滚动容器 <main>(内层滚动、不冒泡 window)，加 .scrolling 暂禁光晕 hover 形变
    this._scrollEl = this.$el && this.$el.closest('main');
    if (this._scrollEl) {
      this._scrollEl.addEventListener('scroll', this.onMainScroll, {
        passive: true,
      });
    }
  },
  beforeDestroy() {
    this.closePlusMenu();
    this.closeUnsubMode();
    this.closeSortMenu();
    window.removeEventListener('resize', this.onWinResize);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this._scrollEl) {
      this._scrollEl.removeEventListener('scroll', this.onMainScroll);
    }
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    clearTimeout(this._cleanTimer); // [B-80]
    clearTimeout(this._sinkTimer);
    clearTimeout(this._nasHoverTimer); // [NAS] hover 预取防抖定时器
  },
  activated() {
    this.loadPodcasts();
    this.autoRefresh(); // [B-80] 进页后台静默刷新订阅(10 分钟节流，无打扰)
    this.refreshNasSet(); // [NAS] 刷新"哪些节目 NAS 上有"集合(未连上则空、无标识)
  },
  created() {
    this.loadPodcasts();
    this.autoRefresh(); // [B-80] 启动即后台静默刷新一次(节流保护)
    this.refreshNasSet(); // [NAS] 刷新"哪些节目 NAS 上有"集合
  },
  methods: {
    // [NAS] 拉取"NAS 上有哪些节目"集合(未连上/未启用则空集)；失败静默。
    async refreshNasSet() {
      try {
        this.nasPodSet = await nasPodcastSet();
      } catch (e) {
        /* 静默：保持空集，不显示标识 */
      }
    },
    // [NAS] 该节目在 NAS 上是否有归档(决定是否显示 wifi 标识)。
    nasOn(p) {
      return !!(p && p.id && this.nasPodSet.has(normFeedUrl(p.id)));
    },
    // [NAS·L2 预取] 悬停节目卡即后台暖该档 NAS 单集映射 → 点进详情页第一刻 wifi 标识即在(不再等加载)。
    //   每档只暖一次(dedup)；prefetchNasPodcast 内部 NAS 未启用/不可用则 no-op。
    onCardHover(p) {
      if (!p || !p.id) return;
      // [审查 R·闸1] 滚动期间一律不预取——滚动时卡片逐张滑过指针会狂触发 mouseenter，正是 IPC 风暴来源。
      if (this.isScrolling) return;
      if (!this._nasHovered) this._nasHovered = new Set();
      if (this._nasHovered.has(p.id)) return;
      // [审查 R·闸2] 停留防抖：mouseenter 后 180ms 仍停留(未滚动/未移开)才预取；快速滑过被持续清除、不触发。
      clearTimeout(this._nasHoverTimer);
      this._nasHoverTimer = setTimeout(() => {
        if (this.isScrolling || this._nasHovered.has(p.id)) return;
        this._nasHovered.add(p.id);
        prefetchNasPodcast(p.id); // 闸3(并发≤2/在途去重)在 nasSource 内
      }, 180);
    },
    onCardLeave() {
      clearTimeout(this._nasHoverTimer);
    },
    // [B-35] 该节目下载进度（0-100），无下载任务返 -1。
    //   episodeId 形如 `${feedUrl}::${guid}`，p.id = feedUrl，按前缀聚合属于该节目的下载中单集。
    podcastDlProgress(p) {
      const map =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.progressMap) ||
        {};
      const prefix = p.id + '::';
      let done = 0;
      let total = 0;
      let hasTask = false;
      for (const id in map) {
        if (!id.startsWith(prefix)) continue;
        const pr = map[id];
        if (!pr || pr.status !== 'downloading') continue;
        hasTask = true;
        done += pr.bytesDone || 0;
        total += pr.bytesTotal || 0;
      }
      if (!hasTask) return -1;
      if (!total) return 3; // 还没拿到 content-length，先显示一点点
      return Math.max(3, Math.min(99, (done / total) * 100));
    },
    async loadPodcasts() {
      let list;
      try {
        list = await getSubscribedPodcasts();
        // [B-47/B-51/D] 偶发空(冷启动 Dexie 未 ready / 偶发) → 重试最多 2 次，
        //   避免订阅列表短暂"全部消失"再恢复（尤其第一次打开程序时）。
        //   仅在首次加载(!this.loaded)时重试：冷启动 localStorage 无缓存时 podcasts.length===0
        //   也能重试，避免 Dexie 未 ready 偶发返回空而误判"还没有订阅"。
        //   已确实无订阅时只在首次多等 ~300ms，可接受。
        let tries = 0;
        while ((!list || !list.length) && !this.loaded && tries < 2) {
          await new Promise(r => setTimeout(r, 150));
          list = await getSubscribedPodcasts();
          tries++;
        }
      } catch (e) {
        // 读库异常：保留旧列表，不清空 UI
        console.warn('[播客库] loadPodcasts 失败，保留旧数据', e);
        this.loaded = true;
        return;
      }
      list = list || [];
      // [A-28] 每档"最新一集"时间(排序) [B-30] 累计收听摘要 [B-47] 最近收听映射
      const [latest, summaries, lastMap] = await Promise.all([
        Promise.all(list.map(p => getLatestEpisodeTime(p.id).catch(() => 0))),
        Promise.all(
          list.map(p => getPodcastListenSummary(p.id).catch(() => null))
        ),
        getLastListenedByPodcast().catch(() => ({})),
      ]);
      this.podcasts = list.map((p, i) => ({
        ...p,
        latestEpisodeTime: latest[i] || 0,
        listenSummary: summaries[i] || null,
        lastListenedAt: lastMap[p.id] || 0,
      }));
      this.loaded = true;
      this.primeHalos(); // [B-71/H1] 后台把各封面降采样成光晕小图
      // [B-51] 写缓存供下次冷启动秒显（避免第一次打开短暂空白）
      try {
        localStorage.setItem(
          'podcastLibrary.cache',
          JSON.stringify(this.podcasts)
        );
      } catch (e) {
        // localStorage 满/序列化异常 → 忽略，不影响功能
      }
      console.log('[播客库] loaded', this.podcasts.length, 'podcasts');
    },
    // [B-80] 后台静默自动刷新订阅(无打扰)：并发重抓所有 RSS，diff 新单集入库→更新角标。
    //   10 分钟节流(每次进页都跑会狂抓)；无 toast、无转圈，发现新集只让卡片角标静静出现。
    async autoRefresh() {
      const KEY = 'podcastLibrary.lastAutoRefresh';
      const last = Number(localStorage.getItem(KEY) || 0);
      if (Date.now() - last < 10 * 60 * 1000) return; // 节流
      if (this._autoRefreshing) return;
      this._autoRefreshing = true;
      localStorage.setItem(KEY, String(Date.now()));
      try {
        await refreshAllSubscriptions();
        await this.loadPodcasts(); // 重读，含更新后的 newCount → 角标自动出现
      } catch (e) {
        // 静默失败，不打扰用户(下次进页节流过期后会再试)
      } finally {
        this._autoRefreshing = false;
      }
    },
    // [B-80] 点清理角标按钮：有角标→像刷子摇晃一下 + 清零全部角标(角标各自播离场动画)；
    //   无角标→点不动，只给"轻微缩小下沉"反馈、不执行任何操作。
    async clearBadges() {
      if (this.cleaning) return;
      if (!this.hasBadges) {
        // 无可清理 → 下沉反馈
        this.sinking = true;
        clearTimeout(this._sinkTimer);
        this._sinkTimer = setTimeout(() => {
          this.sinking = false;
        }, 240);
        return;
      }
      // 摇晃反馈
      this.cleaning = true;
      clearTimeout(this._cleanTimer);
      this._cleanTimer = setTimeout(() => {
        this.cleaning = false;
      }, 600);
      // 本地先置 0 触发角标离场动画 + 持久化(不让用户看到"清理过程"，角标自己渐隐缩小走)
      const toClear = this.podcasts.filter(p => (p.newCount || 0) > 0);
      toClear.forEach(p => this.$set(p, 'newCount', 0));
      await Promise.all(
        toClear.map(p => updatePodcast(p.id, { newCount: 0 }).catch(() => {}))
      );
    },
    // [B-33] 选排序：同 key 再点 → 切方向（菜单保持开，看方向变化）；换 key → 设置并关闭
    setSort(key) {
      if (this.sortBy === key) {
        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        localStorage.setItem('podcastLibrary.sortDir', this.sortDir);
      } else {
        this.sortBy = key;
        this.sortDir = key === 'title' ? 'asc' : 'desc';
        localStorage.setItem('podcastLibrary.sortBy', this.sortBy);
        localStorage.setItem('podcastLibrary.sortDir', this.sortDir);
        this.closeSortMenu();
      }
    },
    // [B-33] "更多"按钮 toggle 下拉菜单；点击外部关闭（click 监听，与右键菜单同策略）
    toggleSortMenu() {
      if (this.sortMenuOpen) {
        this.closeSortMenu();
        return;
      }
      this.sortMenuOpen = true;
      this.$nextTick(() => {
        this.sortOutsideListener = ev => {
          const root = this.$refs.sortControl;
          if (root && !root.contains(ev.target)) this.closeSortMenu();
        };
        document.addEventListener('click', this.sortOutsideListener);
      });
    },
    closeSortMenu() {
      this.sortMenuOpen = false;
      if (this.sortOutsideListener) {
        document.removeEventListener('click', this.sortOutsideListener);
        this.sortOutsideListener = null;
      }
    },
    // [播客改造 A-22] + 号弹窗：点击外部关闭，与倍速面板同款策略
    togglePlusMenu() {
      if (this.plusMenuOpen) {
        this.closePlusMenu();
      } else {
        this.openPlusMenu();
      }
    },
    openPlusMenu() {
      this.plusMenuOpen = true;
      this.$nextTick(() => {
        this.plusOutsideListener = ev => {
          const root = this.$refs.plusControl;
          if (root && !root.contains(ev.target)) {
            this.closePlusMenu();
          }
        };
        document.addEventListener('mousedown', this.plusOutsideListener);
      });
    },
    closePlusMenu() {
      this.plusMenuOpen = false;
      if (this.plusOutsideListener) {
        document.removeEventListener('mousedown', this.plusOutsideListener);
        this.plusOutsideListener = null;
      }
    },
    onClickAddRss() {
      this.closePlusMenu();
      this.openAddDialog();
    },
    onClickImportOpml() {
      this.closePlusMenu();
      this.openImportOpml();
    },
    // [B-51] 导出订阅为 OPML 文件（备份 / 迁移）
    async onExportOpml() {
      this.closePlusMenu();
      if (!this.podcasts.length) {
        this.$store.dispatch('showToast', '还没有订阅，无需导出');
        return;
      }
      try {
        const text = await exportSubscriptionsOpml();
        const blob = new Blob([text], { type: 'text/xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'podplayer-subscriptions.opml';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.$store.dispatch('showToast', '已导出 OPML 订阅备份');
      } catch (e) {
        this.$store.dispatch(
          'showToast',
          '导出失败：' + ((e && e.message) || e)
        );
      }
    },
    openAddDialog() {
      this.newFeedUrl = '';
      this.addError = '';
      this.showAddDialog = true;
    },
    closeAddDialog() {
      this.showAddDialog = false;
    },
    async confirmAdd() {
      if (this.adding) return;
      this.adding = true;
      this.addError = '';
      try {
        const { podcast } = await subscribeByRssUrl(this.newFeedUrl);
        await this.loadPodcasts();
        this.$store.dispatch('showToast', `已添加：${podcast.title}`);
        this.showAddDialog = false;
      } catch (err) {
        this.addError = String(err?.message || err);
      } finally {
        this.adding = false;
      }
    },
    openImportOpml() {
      this.$refs.opmlInput.click();
    },
    // [播客改造 C-1c] 文件导入：嗅探 OPML/RSS，自动派发
    async handleImportFile(e) {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';
      const text = await file.text();
      // 嗅探：包含 <opml → OPML；包含 <rss 或 <feed → 单档 RSS/Atom
      const isOpml = /<opml\b/i.test(text);
      const isRss = /<rss\b/i.test(text) || /<feed\b/i.test(text);

      if (isOpml) {
        await this.runOpmlImport(text);
      } else if (isRss) {
        await this.runSingleRssImport(text, file.name);
      } else {
        this.$store.dispatch(
          'showToast',
          '无法识别的文件格式（既不是 OPML，也不是 RSS/XML）'
        );
      }
    },
    // OPML 批量导入：弹进度框，importOpmlText 回调更新
    async runOpmlImport(text) {
      this.importPhase = 'running';
      this.importLabel = 'OPML 导入';
      this.importDone = 0;
      this.importTotal = 1;
      this.importCurrent = '解析 OPML...';
      try {
        const { added, failed } = await importOpmlText(
          text,
          (done, total, t) => {
            this.importDone = done;
            this.importTotal = total || 1;
            this.importCurrent = t || '';
          }
        );
        await this.loadPodcasts();
        this.importPhase = 'done';
        this.importSuccessMsg =
          `导入完成：成功 ${added.length} 档` +
          (failed.length ? `，失败 ${failed.length} 档` : '');
        if (failed.length) console.warn('[OPML 导入失败明细]', failed);
        setTimeout(() => {
          this.importPhase = 'idle';
        }, 1600);
      } catch (err) {
        this.importPhase = 'idle';
        this.$store.dispatch(
          'showToast',
          'OPML 解析失败：' + (err?.message || err)
        );
      }
    },
    // 单档 RSS/XML 导入
    async runSingleRssImport(text, fileName) {
      this.importPhase = 'running';
      this.importLabel = '导入单档 RSS';
      this.importDone = 0;
      this.importTotal = 1;
      this.importCurrent = fileName || '';
      try {
        const { podcast } = await importRssText(text, fileName);
        await this.loadPodcasts();
        this.importDone = 1;
        this.importPhase = 'done';
        this.importSuccessMsg = `已添加：${podcast.title || podcast.feedUrl}`;
        setTimeout(() => {
          this.importPhase = 'idle';
        }, 1600);
      } catch (err) {
        this.importPhase = 'idle';
        this.$store.dispatch(
          'showToast',
          'RSS 解析失败：' + (err?.message || err)
        );
      }
    },
    // [A-23] 进节目详情 = 真 router push；URL 改变 → 历史栈增长 → <> 可用
    openPodcast(p) {
      this.$router.push({
        name: 'podcastDetail',
        params: { feedUrlEncoded: encodeURIComponent(p.id) },
      });
    },
    // [B-25] 右键封面卡片 → 弹小菜单"取消订阅"
    // [B-25 / bug-3] 卡片点击行为：unsub-overlay 模式时点卡片 = 关闭模式
    onCardClick(p) {
      if (this.unsubModeId === p.id) {
        this.closeUnsubMode();
        return;
      }
      this.openPodcast(p);
    },
    onCardContextMenu(e, p) {
      // 再次右键同一张卡 = 关闭模式（多一种关闭方式）
      if (this.unsubModeId === p.id) {
        this.closeUnsubMode();
        return;
      }
      this.unsubModeId = p.id;
      this.$nextTick(() => {
        // 点击外部任意位置关闭
        this.unsubModeOutsideListener = ev => {
          if (!ev.target.closest('.podcast-card')) {
            this.closeUnsubMode();
          }
        };
        // Esc 键关闭
        this.unsubModeKeyListener = ev => {
          if (ev.key === 'Escape') this.closeUnsubMode();
        };
        document.addEventListener('mousedown', this.unsubModeOutsideListener);
        document.addEventListener('keydown', this.unsubModeKeyListener);
        // [UI 改] 5s 不操作自动复原（用户不需要手动关）
        this.scheduleUnsubAutoClose();
      });
    },
    scheduleUnsubAutoClose() {
      if (this.unsubModeAutoTimer) clearTimeout(this.unsubModeAutoTimer);
      this.unsubModeAutoTimer = setTimeout(() => {
        this.closeUnsubMode();
      }, 5000);
    },
    cancelUnsubAutoClose() {
      if (this.unsubModeAutoTimer) {
        clearTimeout(this.unsubModeAutoTimer);
        this.unsubModeAutoTimer = null;
      }
    },
    closeUnsubMode() {
      this.unsubModeId = null;
      if (this.unsubModeOutsideListener) {
        document.removeEventListener(
          'mousedown',
          this.unsubModeOutsideListener
        );
        this.unsubModeOutsideListener = null;
      }
      if (this.unsubModeKeyListener) {
        document.removeEventListener('keydown', this.unsubModeKeyListener);
        this.unsubModeKeyListener = null;
      }
      this.cancelUnsubAutoClose();
    },
    askUnsubscribe(p) {
      this.closeUnsubMode();
      this.unsubTarget = p;
    },
    async doUnsubscribe() {
      if (!this.unsubTarget) return;
      const target = this.unsubTarget;
      await deletePodcast(target.id);
      // [B-44] 全局同步：发现页/二级页同名卡片实时回到"未订阅"
      this.$store.commit('removeSubscribedPodcast', {
        feedUrl: target.id,
        name: target.title,
      });
      this.$store.dispatch('showToast', '已取消订阅');
      this.unsubTarget = null;
      await this.loadPodcasts();
    },
    onCoverError(e) {
      e.target.style.opacity = 0;
    },
    // [S 级 bug 修] 窗口缩放时禁用 transition，结束后 250ms 复位
    onWinResize() {
      if (!this.isResizing) this.isResizing = true;
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.isResizing = false;
      }, 250);
    },
    // [B-71/H2] 滚动期间打 .scrolling（CSS 里据此暂禁光晕 hover 形变），停 150ms 复位。
    //   isScrolling 由 if 守卫只翻一次，复位定时器滚动期间不断重置 → 不抖动响应式。
    onMainScroll() {
      if (!this.isScrolling) this.isScrolling = true;
      if (this.scrollTimer) clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => {
        this.isScrolling = false;
      }, 150);
    },
    // [B-71/H1] 光晕底图：小图就绪用小图(64px)，未就绪先用原图兜底（光晕不闪空、就绪后无感升级）
    haloBg(p) {
      const url = p && p.coverUrl;
      if (!url) return '';
      return this.haloMap[url] || url;
    },
    // [B-71/H1] 后台把当前列表各封面降采样入 haloMap（模块级缓存去重，重进页不重算）
    primeHalos() {
      (this.podcasts || []).forEach(p => {
        const url = p && p.coverUrl;
        if (!url || this.haloMap[url]) return;
        ensureTinyCover(url).then(tiny => {
          if (tiny && this.haloMap[url] !== tiny) {
            this.$set(this.haloMap, url, tiny);
          }
        });
      });
    },
  },
};
</script>

<style lang="scss" scoped>
.podcast-library {
  color: var(--color-text);
  padding-top: 28px; // [bug 修复] 与 podcastDetail 一致，避开顶栏过紧
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 24px;
}
// [B-33] 标题 + 紧贴的"更多"按钮（"我的订阅 ⋮"）
.title-row {
  display: flex;
  align-items: center;
  gap: 4px;
  h1 {
    font-size: 32px;
    font-weight: 700;
    line-height: 1;
    margin: 0;
  }
}
.actions {
  display: flex;
  gap: 10px;
}

// [B-46 / D-3] 刷新订阅按钮（点击旋转）
// [B-80] 清理角标按钮(原刷新按钮位置)
.clean-button {
  align-self: center;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.35; // 默认(无角标)较暗=不可用感
  transition: opacity 0.2s, transform 0.18s ease, background 0.2s;
  .svg-icon {
    width: 20px;
    height: 20px;
    transition: transform 0.2s;
  }
  // 有角标 → 点亮、可用
  &.active {
    opacity: 0.8;
    cursor: pointer;
    &:hover {
      opacity: 1;
      background: var(--color-secondary-bg-for-transparent);
    }
  }
  // 无角标点击 → 轻微缩小下沉反馈(像按了一下没东西可刷)
  &.sinking {
    transform: translateY(1px) scale(0.9);
  }
  // 有角标点击 → 像拿刷子刷：图标快速摇晃几下
  &.shaking .svg-icon {
    animation: brushShake 0.55s cubic-bezier(0.36, 0.07, 0.19, 0.97);
  }
}
@keyframes brushShake {
  0% {
    transform: rotate(0);
  }
  15% {
    transform: rotate(-16deg);
  }
  30% {
    transform: rotate(13deg);
  }
  45% {
    transform: rotate(-10deg);
  }
  60% {
    transform: rotate(7deg);
  }
  75% {
    transform: rotate(-4deg);
  }
  100% {
    transform: rotate(0);
  }
}
// [B-80] 角标离场动画：清零时渐隐 + 缩小弹出(不让用户看到突兀消失)
.badge-pop-leave-active {
  transition: opacity 0.3s ease, transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.badge-pop-leave-to {
  opacity: 0;
  transform: scale(0.4) translateY(-4px);
}
// 角标出现(后台刷到新集)也轻微弹入
.badge-pop-enter-active {
  transition: opacity 0.3s ease, transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.badge-pop-enter {
  opacity: 0;
  transform: scale(0.4);
}

// [B-33] "更多"按钮：紧贴"阅"字，点击弹排序下拉
.sort-control {
  position: relative;
  align-self: center;
}
.more-btn {
  background: transparent;
  color: var(--color-text);
  opacity: 0.5;
  border-radius: 6px;
  padding: 4px 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: 0.15s;
  .svg-icon {
    width: 18px;
    height: 18px;
  }
  &:hover {
    opacity: 0.9;
    background: var(--color-secondary-bg-for-transparent);
  }
  &.active {
    opacity: 1;
    color: var(--color-primary);
    background: var(--color-primary-bg-for-transparent);
  }
}
// [B-33] 排序下拉菜单
.sort-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  min-width: 188px;
  background: var(--color-body-bg);
  border-radius: 12px;
  padding: 6px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18),
    0 0 0 1px var(--color-secondary-bg-for-transparent);
  z-index: 80;
}
.sort-menu-head {
  font-size: 11px;
  opacity: 0.5;
  padding: 6px 10px 4px;
  font-weight: 600;
}
.sort-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  transition: 0.15s;
  .lead {
    width: 15px;
    height: 15px;
    opacity: 0.7;
    flex-shrink: 0;
  }
  .label {
    flex: 1;
  }
  .dir {
    width: 14px;
    height: 14px;
    color: var(--color-primary);
    flex-shrink: 0;
  }
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
  &.active {
    color: var(--color-primary);
    background: var(--color-primary-bg-for-transparent);
    .lead {
      opacity: 1;
      color: var(--color-primary);
    }
  }
}
// [B-33] 排序下拉出现动画（origin 左上，区别于 + 号菜单的 fade-pop）
.sort-pop-enter-active,
.sort-pop-leave-active {
  transition: opacity 0.15s, transform 0.15s;
  transform-origin: top left;
}
.sort-pop-enter,
.sort-pop-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
}

// [播客改造 A-22] + 号按钮 + 弹窗
.plus-control {
  position: relative;
}
.plus-button {
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
  transition: 0.2s;
  .svg-icon {
    width: 26px;
    height: 26px;
  }
  &:hover {
    opacity: 1;
    background: var(--color-secondary-bg-for-transparent);
  }
  &.active {
    opacity: 1;
    color: var(--color-primary);
  }
}
.plus-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  background: var(--color-body-bg);
  border-radius: 12px;
  padding: 6px;
  width: 240px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18),
    0 0 0 1px var(--color-secondary-bg-for-transparent);
  z-index: 80;
}
.plus-item {
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    background: var(--color-primary-bg-for-transparent);
  }
  .t {
    font-weight: 600;
    font-size: 14px;
    color: var(--color-text);
  }
  .s {
    font-size: 11px;
    opacity: 0.55;
    margin-top: 2px;
  }
}
.fade-pop-enter-active,
.fade-pop-leave-active {
  transition: opacity 0.15s, transform 0.15s;
  transform-origin: top right;
}
.fade-pop-enter,
.fade-pop-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
}

// [B-25] 取消订阅确认弹窗
.confirm-dialog {
  background: var(--color-body-bg);
  color: var(--color-text);
  border-radius: 14px;
  padding: 24px 26px;
  min-width: 360px;
  max-width: 440px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
  .title {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 12px;
  }
  .msg {
    font-size: 14px;
    line-height: 1.6;
    opacity: 0.85;
    margin-bottom: 18px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
}
.btn-danger {
  background: #e74c3c;
  color: #fff;
  padding: 8px 16px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    transform: scale(1.04);
  }
}

// [播客改造 C-1c] 导入进度/成功弹窗
.import-dialog {
  background: var(--color-body-bg);
  color: var(--color-text);
  border-radius: 14px;
  padding: 26px 28px;
  min-width: 360px;
  max-width: 460px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
}
.import-running {
  .title {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 14px;
  }
  .bar-wrap {
    height: 6px;
    background: var(--color-secondary-bg);
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 10px;
  }
  .bar-fill {
    height: 100%;
    background: var(--color-primary);
    transition: width 0.25s ease-out;
  }
  .status {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 12px;
    opacity: 0.65;
    .current {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 280px;
    }
  }
}
.import-done {
  display: flex;
  align-items: center;
  gap: 14px;
  .check {
    width: 28px;
    height: 28px;
    color: #27ae60;
    flex-shrink: 0;
  }
  .msg {
    font-size: 15px;
    font-weight: 600;
  }
}
.btn-primary,
.btn-secondary {
  font-weight: 600;
  font-size: 14px;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: 0.2s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  .svg-icon {
    width: 14px;
    height: 14px;
  }
}
.btn-primary {
  background: var(--color-primary);
  color: var(--color-primary-bg);
  &:hover {
    transform: scale(1.04);
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }
}
.btn-secondary {
  background: var(--color-secondary-bg);
  color: var(--color-text);
  &:hover {
    background: var(--color-primary-bg-for-transparent);
  }
}

.podcast-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 24px;
}
// [S 级 bug 修] 缩放期间禁用所有 transition，避免动画累积导致卡顿
.podcast-grid.resizing,
.podcast-grid.resizing * {
  transition: none !important;
  animation: none !important;
}
// [B-71/H2] 滚动期间：把光晕 hover 形变(blur/scale/top 三属性 0.25s 过渡)按住在基态，
//   避免卡片滑过指针时大位图光晕连环重光栅化拖垮帧率。选择器多一个 .scrolling → 特异性更高，
//   盖过 .podcast-card:hover .cover-shadow。滚动停 150ms 后 .scrolling 摘除，hover 辉光恢复。
.podcast-grid.scrolling {
  .cover-shadow {
    transition: none !important;
  }
  .podcast-card:hover .cover-shadow {
    filter: blur(16px) opacity(0.45);
    transform: scale(0.9);
    top: 10px;
  }
}
.empty-tip {
  grid-column: 1 / -1;
  text-align: center;
  opacity: 0.5;
  padding: 60px 0;
}
.podcast-card {
  cursor: pointer;
  transition: 0.2s;
  &:hover {
    transform: translateY(-2px);
  }
  &:hover .cover-shadow {
    filter: blur(20px) opacity(0.6);
    transform: scale(0.95);
    top: 16px;
  }
  // [B-44] 封面外层：承载方形尺寸，且不裁切光晕
  .cover-box {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1;
  }
  // [B-44] 封面虚化光晕（在 cover-wrap 之外，可超出不被裁切）
  .cover-shadow {
    position: absolute;
    left: 0;
    top: 10px;
    width: 100%;
    height: 100%;
    border-radius: 12px;
    background-size: cover;
    background-position: center;
    filter: blur(16px) opacity(0.45);
    transform: scale(0.9);
    z-index: 0;
    transition: filter 0.25s, transform 0.25s, top 0.25s;
  }
  .cover-wrap {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    border-radius: 12px;
    overflow: hidden;
    background: var(--color-secondary-bg);
  }
  // [B-35] 下载进度边框：SVG rect 从顶边左端顺时针描边一圈，细度≈播放bar，蓝色
  .dl-ring {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 2;
    .dl-ring-bar {
      fill: none;
      stroke: var(--color-primary);
      stroke-width: 1.2;
      stroke-dasharray: 100;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.4s ease;
    }
  }
  .cover {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.25s ease-out;
  }
  // [bug-3 / UI 改] unsub mode：封面更暗 + 微微放大
  &.unsub-mode {
    .cover {
      transform: scale(1.06);
      filter: brightness(0.3);
    }
    .title,
    .author {
      opacity: 0.4;
    }
  }
  .title {
    margin-top: 10px;
    font-weight: 600;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    transition: opacity 0.2s;
  }
  .author {
    margin-top: 4px;
    font-size: 12px;
    opacity: 0.6;
    transition: opacity 0.2s;
  }
  // [B-48 第1点] 来源溯源点：紧挨节目名的实心小圆点（句号大小）
  .src-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-left: 5px;
    vertical-align: middle;
  }
  .dot-discover {
    background: #f1c40f; // 黄 = 首页发现页添加
  }
  // [NAS] "NAS 上有此节目"标识：小 wifi 图标，略低饱和绿 + 呼吸(与 navbar 状态图标同节奏)
  .nas-dot {
    display: inline-flex;
    align-items: center;
    margin-left: 5px;
    vertical-align: middle;
    color: #3fa06a;
    animation: nas-breathe 2.6s ease-in-out infinite;
    .svg-icon {
      width: 13px;
      height: 13px;
    }
  }
}
// [NAS] 呼吸灯（节目/单集 NAS 标识共用；与 navbar 状态图标同节奏）
@keyframes nas-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
// [B-46 / D-3] 新单集角标（红底白字，封面右上角）
.new-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  background: #e74c3c;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 10px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  pointer-events: none;
}
// [bug-3] 取消订阅 overlay：贴在封面上的居中"取消订阅"按钮
.unsub-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  cursor: pointer;
  color: #fff;
  transition: 0.2s;
  .svg-icon {
    width: 38px;
    height: 38px;
  }
  .label {
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0.5px;
  }
  &:hover {
    color: #ff7a6b;
  }
}

.episode-view {
  .back-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }
  .link-btn {
    background: transparent;
    color: var(--color-text);
    cursor: pointer;
    font-size: 14px;
    opacity: 0.7;
    &:hover {
      opacity: 1;
    }
    &.danger:hover {
      color: #e74c3c;
    }
  }
}
.podcast-detail {
  display: flex;
  gap: 24px;
  margin-bottom: 32px;
  .cover-lg {
    width: 180px;
    height: 180px;
    border-radius: 16px;
    object-fit: cover;
    flex-shrink: 0;
    background: var(--color-secondary-bg);
  }
  .meta {
    flex: 1;
    overflow: hidden;
    .t {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .a {
      opacity: 0.7;
      margin-bottom: 12px;
    }
    .d {
      font-size: 14px;
      opacity: 0.7;
      line-height: 1.6;
      max-height: 100px;
      overflow: hidden;
    }
  }
}
.episode-list {
  border-top: 1px solid var(--color-secondary-bg);
}
.episode-row {
  padding: 14px 4px;
  cursor: pointer;
  border-bottom: 1px solid var(--color-secondary-bg);
  transition: 0.15s;
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
    padding-left: 12px;
  }
  .ep-title {
    font-weight: 600;
    font-size: 15px;
    margin-bottom: 4px;
  }
  .ep-sub {
    font-size: 12px;
    opacity: 0.6;
    display: flex;
    gap: 16px;
  }
}

.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.dialog {
  background: var(--color-body-bg);
  color: var(--color-text);
  border-radius: 12px;
  padding: 24px;
  width: 460px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
.dialog-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 16px;
}
.dialog-body {
  margin-bottom: 16px;
  .input {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--color-secondary-bg);
    background: var(--color-secondary-bg-for-transparent);
    color: var(--color-text);
    font-size: 14px;
    &:focus {
      outline: none;
      border-color: var(--color-primary);
    }
  }
  .error {
    color: #e74c3c;
    margin-top: 8px;
    font-size: 13px;
  }
  .hint {
    color: var(--color-primary);
    margin-top: 8px;
    font-size: 13px;
  }
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
