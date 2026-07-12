<template>
  <div class="subscription-updates">
    <header class="updates-header">
      <div class="updates-title">
        <h1>更新</h1>
        <p>来自 {{ podcastCount }} 个订阅 · 按发布时间从新到旧</p>
      </div>
      <button
        v-tip="'进入节目网格和订阅管理'"
        class="all-subscriptions-button"
        @click="goAllSubscriptions()"
      >
        <svg-icon icon-class="list" />
        <span>全部订阅</span>
      </button>
    </header>

    <section v-if="loaded && !podcastCount" class="updates-empty">
      <h2>还没有订阅</h2>
      <p>添加 RSS 或导入 OPML 后，新的单集会集中显示在这里。</p>
      <div class="empty-actions">
        <button class="primary-action" @click="goAllSubscriptions('add')">
          <svg-icon icon-class="square-plus" />
          添加 RSS
        </button>
        <button class="secondary-action" @click="goAllSubscriptions('import')">
          <svg-icon icon-class="download" />
          导入 OPML
        </button>
      </div>
    </section>

    <template v-else>
      <section class="updates-rail-section" aria-label="节目快速选择">
        <div
          class="updates-rail"
          :class="{
            'is-scrolling': railScrolling,
            'is-dragging': railDragging,
          }"
        >
          <button
            v-tip="'向左浏览节目'"
            class="rail-arrow"
            :disabled="!railMetrics.canPrev"
            aria-label="向左浏览节目"
            @click="scrollRail(-1)"
          >
            <svg-icon icon-class="arrow-left" />
          </button>
          <div
            ref="railViewport"
            class="rail-viewport"
            tabindex="0"
            role="listbox"
            aria-label="按节目筛选更新"
            @keydown.left.prevent="scrollRail(-1)"
            @keydown.right.prevent="scrollRail(1)"
            @scroll.passive="onRailScroll"
          >
            <button
              v-tip="'全部节目'"
              class="rail-item rail-all"
              :class="{ active: !selectedPodcastId }"
              :aria-selected="!selectedPodcastId"
              aria-label="全部节目"
              role="option"
              @click="selectPodcast('')"
            >
              <span class="rail-all-icon">
                <svg-icon icon-class="list" />
              </span>
            </button>
            <button
              v-for="podcast in railPodcasts"
              :key="podcast.id"
              ref="railItems"
              v-tip="podcast.title || '未命名节目'"
              ref-in-for
              class="rail-item"
              :class="{ active: selectedPodcastId === podcast.id }"
              :aria-selected="selectedPodcastId === podcast.id"
              :aria-label="podcast.title || '未命名节目'"
              :data-podcast-id="podcast.id"
              role="option"
              @click="selectPodcast(podcast.id)"
            >
              <span class="rail-cover">
                <span
                  class="rail-cover-halo"
                  :style="railHaloStyle(podcast)"
                ></span>
                <PodImage class="rail-cover-image" :src="podcast.coverUrl" />
              </span>
            </button>
          </div>
          <button
            v-tip="'向右浏览节目'"
            class="rail-arrow"
            :disabled="!railMetrics.canNext"
            aria-label="向右浏览节目"
            @click="scrollRail(1)"
          >
            <svg-icon icon-class="arrow-right" />
          </button>
        </div>
        <div
          ref="railTrack"
          class="rail-track"
          :class="{ 'is-hidden': !railMetrics.canScroll }"
          aria-hidden="true"
        >
          <div
            ref="railThumb"
            class="rail-thumb"
            :style="railThumbStyle"
            @pointerdown.prevent="startRailDrag"
          ></div>
        </div>
      </section>

      <div class="updates-tools">
        <div
          class="updates-segmented"
          :class="{ 'is-unfinished': unfinishedOnly }"
          role="tablist"
          aria-label="更新筛选"
        >
          <button
            :class="{ active: !unfinishedOnly }"
            :aria-selected="!unfinishedOnly"
            role="tab"
            @click="setUnfinishedOnly(false)"
          >
            全部
          </button>
          <button
            :class="{ active: unfinishedOnly }"
            :aria-selected="unfinishedOnly"
            role="tab"
            @click="setUnfinishedOnly(true)"
          >
            未听完
          </button>
        </div>
        <span v-if="filteredEpisodes.length" class="updates-count">
          {{ filteredEpisodes.length }} 集
        </span>
      </div>

      <button
        v-if="pendingNewCount"
        class="updates-new-banner"
        @click="applyPendingUpdates"
      >
        <svg-icon icon-class="refresh" />
        发现 {{ pendingNewCount }} 个新单集，点击查看
      </button>
      <div v-if="refreshFailures.length" class="updates-refresh-note">
        <svg-icon icon-class="info" />
        {{ refreshFailureText }}
      </div>

      <section v-if="loaded && !snapshot.episodes.length" class="updates-empty">
        <h2>订阅里还没有单集</h2>
        <p>订阅会继续在后台更新；你也可以进入全部订阅检查节目来源。</p>
      </section>
      <section
        v-else-if="loaded && !filteredEpisodes.length"
        class="updates-empty updates-filter-empty"
        :class="{ 'is-filter-switching': filterSwitching }"
      >
        <h2>{{ emptyFilterTitle }}</h2>
        <button class="secondary-action" @click="setUnfinishedOnly(false)">
          切回全部
        </button>
      </section>
      <section
        v-else
        class="updates-list"
        :class="{ 'is-filter-switching': filterSwitching }"
      >
        <div v-if="!loaded" class="updates-skeleton" aria-label="正在载入更新">
          <div v-for="index in 5" :key="index" class="skeleton-row"></div>
        </div>
        <div
          v-else
          ref="feedList"
          class="updates-window"
          :style="{
            paddingTop: virtualTopSpace + 'px',
            paddingBottom: virtualBottomSpace + 'px',
          }"
        >
          <div
            v-for="item in virtualItems"
            :key="item.key"
            class="update-virtual-item"
            :class="'is-' + item.type"
          >
            <div
              v-if="item.type === 'group'"
              class="update-date-group"
              role="heading"
              aria-level="2"
            >
              {{ item.group.label }}
            </div>
            <article
              v-else
              class="update-episode-row"
              :class="{
                'is-playing': isCurrentEpisode(item.episode) && playerPlaying,
              }"
              @contextmenu.prevent="openEpisodeMenu($event, item.episode)"
            >
              <button
                v-tip="'查看单集详情'"
                class="update-cover-button"
                @click="goEpisodeDetail(item.episode)"
              >
                <PodImage
                  class="update-cover"
                  :src="item.episode.coverUrl || item.episode.podcastCoverUrl"
                />
              </button>
              <div class="update-episode-main">
                <div class="update-episode-meta">
                  <button
                    class="update-podcast-link"
                    @click="goPodcastDetail(item.episode)"
                  >
                    {{ item.episode.podcastTitle || '未命名节目' }}
                  </button>
                  <span
                    v-if="isUnstarted(item.episode)"
                    v-tip="'未开始收听'"
                    class="unstarted-dot"
                  ></span>
                  <span class="update-published">{{
                    formatPublished(item.episode.pubTime)
                  }}</span>
                </div>
                <button
                  class="update-episode-title"
                  @click="goEpisodeDetail(item.episode)"
                >
                  {{ item.episode.title || '未命名单集' }}
                </button>
                <div class="update-episode-sub">
                  <span>{{ formatDuration(item.episode.duration) }}</span>
                  <span>{{ progressLabel(item.episode) }}</span>
                  <span
                    v-for="tag in capabilityTags(item.episode)"
                    :key="tag.key"
                    v-tip="tag.tip"
                    class="episode-capability"
                  >
                    <svg-icon :icon-class="tag.icon" />
                    <span>{{ tag.label }}</span>
                  </span>
                </div>
              </div>
              <div class="update-episode-actions">
                <button
                  v-tip="
                    isCurrentEpisode(item.episode) && playerPlaying
                      ? '暂停'
                      : '播放'
                  "
                  class="podcast-episode-action"
                  :aria-label="
                    isCurrentEpisode(item.episode) && playerPlaying
                      ? '暂停'
                      : '播放'
                  "
                  @click="playEpisode(item.episode)"
                  @dblclick.stop
                >
                  <svg-icon
                    :icon-class="
                      isCurrentEpisode(item.episode) && playerPlaying
                        ? 'pause'
                        : 'play-circle'
                    "
                  />
                </button>
                <button
                  v-tip="'更多操作'"
                  class="podcast-episode-action"
                  aria-label="更多操作"
                  @click="openEpisodeMenu($event, item.episode)"
                  @dblclick.stop
                >
                  <svg-icon icon-class="menu-dots-vertical" />
                </button>
              </div>
            </article>
          </div>
        </div>
      </section>
    </template>

    <transition name="updates-back-top">
      <button
        v-show="showBackTop"
        v-tip="'回到更新顶部'"
        class="updates-back-top"
        aria-label="回到更新顶部"
        @click="scrollFeedToTopSmooth"
      >
        <svg-icon icon-class="arrow-up" />
      </button>
    </transition>

    <ContextMenu ref="episodeMenu">
      <div v-if="menuEpisode" class="item" @click="playEpisode(menuEpisode)">
        <svg-icon icon-class="play-circle" />
        <span>{{
          isCurrentEpisode(menuEpisode) && playerPlaying ? '暂停' : '播放'
        }}</span>
      </div>
      <div v-if="menuEpisode" class="item" @click="toggleQueue(menuEpisode)">
        <svg-icon icon-class="layer-plus" />
        <span>{{
          isQueued(menuEpisode) ? '移出播放列表' : '加入播放列表'
        }}</span>
      </div>
      <div v-if="menuEpisode" class="item" @click="toggleFavorite(menuEpisode)">
        <svg-icon
          :icon-class="isFavorited(menuEpisode) ? 'heart-solid' : 'heart'"
        />
        <span>{{ isFavorited(menuEpisode) ? '取消收藏' : '收藏' }}</span>
      </div>
      <div
        v-if="menuEpisode"
        class="item"
        :class="{ danger: isDownloaded(menuEpisode) }"
        @click="toggleDownload(menuEpisode)"
      >
        <svg-icon :icon-class="downloadMenuIcon(menuEpisode)" />
        <span>{{ downloadMenuLabel(menuEpisode) }}</span>
      </div>
    </ContextMenu>

    <div
      v-if="deleteDownloadTarget"
      class="dialog-mask"
      @click.self="deleteDownloadTarget = null"
    >
      <div class="confirm-dialog">
        <div class="title">删除下载</div>
        <div class="msg">
          确定要删除已下载的
          <b>{{ deleteDownloadTarget.title }}</b>
          吗？单集进度和文字稿不会被删除。
        </div>
        <div class="dialog-actions">
          <button class="secondary-action" @click="deleteDownloadTarget = null">
            取消
          </button>
          <button class="danger-action" @click="confirmRemoveDownload">
            删除下载
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import ContextMenu from '@/components/ContextMenu.vue';
import PodImage from '@/components/PodImage.vue';
import SvgIcon from '@/components/SvgIcon.vue';
import {
  getListenStats,
  listenedPercentStepped,
} from '@/utils/podcast/listening';
import {
  cancelDownload,
  removeDownload,
  startDownload,
} from '@/utils/podcast/downloads';
import { ensureTinyCover, peekTinyCover } from '@/utils/podcast/coverHalo';
import { nasEpisodeGuidSet, normFeedUrl } from '@/utils/podcast/nasSource';
import {
  filterSubscriptionUpdates,
  flattenUpdateGroups,
  getRailArrowTarget,
  getRailMetrics,
  getRailThumbDragTarget,
  getStableVirtualRange,
  groupSortedSubscriptionUpdates,
} from '@/utils/podcast/subscriptionUpdatesRules';
import { getSubscriptionUpdatesSnapshot } from '@/utils/podcast/subscriptionUpdatesData';
import { refreshSubscribedPodcasts } from '@/utils/podcast/subscriptionRefresh';
import { markAllSubscriptionsEntryFromUpdates } from '@/utils/podcast/subscriptionNavigation';

const UPDATE_ROW_HEIGHT = 96;
const UPDATE_GROUP_HEIGHT = 34;
const VIRTUAL_BUFFER = 12;
const VIRTUAL_GUARD = 4;

function metricHeight(item) {
  return item.type === 'group' ? UPDATE_GROUP_HEIGHT : UPDATE_ROW_HEIGHT;
}

function findVirtualIndex(metrics, offset) {
  let low = 0;
  let high = metrics.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const metric = metrics[middle];
    if (metric.top + metric.height <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function emptySnapshot() {
  return {
    podcasts: [],
    episodes: [],
    podcastCount: 0,
    favoriteIds: [],
    downloadedIds: [],
  };
}

export default {
  name: 'SubscriptionUpdates',
  components: {
    ContextMenu,
    PodImage,
    SvgIcon,
  },
  data() {
    return {
      snapshot: emptySnapshot(),
      pendingSnapshot: null,
      pendingNewCount: 0,
      refreshFailures: [],
      selectedPodcastId: '',
      unfinishedOnly: false,
      filterSwitching: false,
      loaded: false,
      loadingError: '',
      listNow: Date.now(),
      winStart: 0,
      winEnd: 0,
      railMetrics: getRailMetrics(),
      railTrackWidth: 0,
      railScrolling: false,
      railDragging: false,
      railHaloMap: {},
      liveListenByEpisode: {},
      nasByPodcast: {},
      menuEpisode: null,
      deleteDownloadTarget: null,
      showBackTop: false,
    };
  },
  computed: {
    podcastCount() {
      return this.snapshot.podcastCount || 0;
    },
    railPodcasts() {
      return this.snapshot.podcasts || [];
    },
    filteredEpisodes() {
      return filterSubscriptionUpdates(this.snapshot.episodes, {
        podcastId: this.selectedPodcastId,
        unfinishedOnly: this.unfinishedOnly,
      });
    },
    updateGroups() {
      return groupSortedSubscriptionUpdates(
        this.filteredEpisodes,
        this.listNow
      );
    },
    flatItems() {
      return flattenUpdateGroups(this.updateGroups);
    },
    flatMetrics() {
      let top = 0;
      return this.flatItems.map(item => {
        const height = metricHeight(item);
        const metric = { ...item, top, height };
        top += height;
        return metric;
      });
    },
    totalVirtualHeight() {
      const last = this.flatMetrics[this.flatMetrics.length - 1];
      return last ? last.top + last.height : 0;
    },
    virtualItems() {
      return this.flatMetrics.slice(this.winStart, this.winEnd);
    },
    virtualTopSpace() {
      const first = this.flatMetrics[this.winStart];
      return first ? first.top : 0;
    },
    virtualBottomSpace() {
      const last = this.flatMetrics[this.winEnd - 1];
      const used = last ? last.top + last.height : 0;
      return Math.max(0, this.totalVirtualHeight - used);
    },
    favoriteIdSet() {
      const ids =
        (this.$store.state.podcastFavorites &&
          this.$store.state.podcastFavorites.episodeIds) ||
        [];
      return new Set([...(this.snapshot.favoriteIds || []), ...ids]);
    },
    downloadedIdSet() {
      const ids =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.doneIds) ||
        [];
      return new Set([...(this.snapshot.downloadedIds || []), ...ids]);
    },
    queueIdSet() {
      return new Set(
        (this.$store.state.podcastQueue || [])
          .filter(item => item && item.id)
          .map(item => item.id)
      );
    },
    playerPlaying() {
      return !!(this.$store.state.player && this.$store.state.player.playing);
    },
    currentEpisodeId() {
      const track =
        this.$store.state.player && this.$store.state.player.currentTrack;
      return (track && track.podcastEpisodeId) || '';
    },
    railThumbStyle() {
      const trackWidth = this.railTrackWidth;
      if (!trackWidth || !this.railMetrics.canScroll) {
        return { width: '0px', transform: 'translateX(0px)' };
      }
      const thumbWidth = Math.min(
        trackWidth,
        Math.max(36, trackWidth * this.railMetrics.visibleRatio)
      );
      const travel = Math.max(0, trackWidth - thumbWidth);
      const ratio = this.railMetrics.maxScroll
        ? this.railMetrics.scrollLeft / this.railMetrics.maxScroll
        : 0;
      return {
        width: thumbWidth + 'px',
        transform: 'translateX(' + travel * ratio + 'px)',
      };
    },
    refreshFailureText() {
      const count = this.refreshFailures.length;
      return count === 1
        ? '1 个节目更新失败，其它订阅不受影响'
        : count + ' 个节目更新失败，其它订阅不受影响';
    },
    emptyFilterTitle() {
      if (this.selectedPodcastId) {
        return this.unfinishedOnly
          ? '这个节目暂时没有未听完的单集'
          : '这个节目暂时没有单集';
      }
      return this.unfinishedOnly
        ? '已听完当前订阅中的所有单集'
        : '当前筛选没有单集';
    },
  },
  watch: {
    flatItems() {
      this.$nextTick(() => {
        this.recalcVirtualWindow(true);
      });
    },
    '$store.state.podcastListening.listenTick'() {
      this.syncListeningState();
    },
  },
  created() {
    this.loadInitialSnapshot();
  },
  mounted() {
    this.bindMainScroll();
    window.addEventListener('resize', this.onResize);
    if (typeof ResizeObserver !== 'undefined' && this.$refs.railViewport) {
      this.railResizeObserver = new ResizeObserver(() => {
        this.updateRailMetrics();
      });
      this.railResizeObserver.observe(this.$refs.railViewport);
      if (this.$refs.railTrack)
        this.railResizeObserver.observe(this.$refs.railTrack);
    }
    this.$nextTick(() => {
      this.recalcVirtualWindow(true);
      this.updateRailMetrics();
    });
  },
  activated() {
    this.bindMainScroll();
    if (this._wasActivated) {
      this.listNow = Date.now();
      this.$parent?.$refs?.scrollbar?.restorePosition();
      this.$nextTick(() => {
        this.recalcVirtualWindow(true);
        this.updateRailMetrics();
      });
      this.loadSnapshot().then(() => this.checkBackgroundRefresh());
    }
    this._wasActivated = true;
  },
  deactivated() {
    this.unbindMainScroll();
    if (this._virtualRaf) {
      cancelAnimationFrame(this._virtualRaf);
      this._virtualRaf = null;
    }
    if (this._railScrollRaf) {
      cancelAnimationFrame(this._railScrollRaf);
      this._railScrollRaf = null;
    }
    if (this._railScrollTimer) {
      clearTimeout(this._railScrollTimer);
      this._railScrollTimer = null;
    }
    this.railScrolling = false;
    this.stopRailAnimation();
    this.stopFeedScrollAnimation();
    this.finishRailDrag();
    if (this._filterRaf) {
      cancelAnimationFrame(this._filterRaf);
      this._filterRaf = null;
    }
    this.filterSwitching = false;
    this._listenSyncToken = (this._listenSyncToken || 0) + 1;
    this._refreshToken = (this._refreshToken || 0) + 1;
  },
  beforeDestroy() {
    this._isDestroyed = true;
    this._loadToken = (this._loadToken || 0) + 1;
    this._refreshToken = (this._refreshToken || 0) + 1;
    this._listenSyncToken = (this._listenSyncToken || 0) + 1;
    this.unbindMainScroll();
    window.removeEventListener('resize', this.onResize);
    if (this._virtualRaf) cancelAnimationFrame(this._virtualRaf);
    if (this._railScrollRaf) cancelAnimationFrame(this._railScrollRaf);
    if (this._railDragRaf) cancelAnimationFrame(this._railDragRaf);
    if (this._filterRaf) cancelAnimationFrame(this._filterRaf);
    this.stopRailAnimation();
    this.stopFeedScrollAnimation();
    this.finishRailDrag();
    if (this._railScrollTimer) clearTimeout(this._railScrollTimer);
    if (this.railResizeObserver) this.railResizeObserver.disconnect();
  },
  methods: {
    async loadInitialSnapshot() {
      await this.loadSnapshot();
      this.checkBackgroundRefresh();
    },
    async loadSnapshot() {
      const token = (this._loadToken || 0) + 1;
      this._loadToken = token;
      if (!this.loaded) this.loadingError = '';
      try {
        const snapshot = await getSubscriptionUpdatesSnapshot(this.listNow);
        if (this._isDestroyed || token !== this._loadToken) return null;
        this.applySnapshot(snapshot);
        return snapshot;
      } catch (error) {
        if (this._isDestroyed || token !== this._loadToken) return null;
        this.loadingError = '更新流暂时无法读取，已保留当前内容';
        return null;
      } finally {
        if (token === this._loadToken) this.loaded = true;
      }
    },
    applySnapshot(snapshot) {
      this.snapshot = snapshot || emptySnapshot();
      this.pendingSnapshot = null;
      this.pendingNewCount = 0;
      this.primeRailHalos();
      this.$nextTick(() => {
        this.recalcVirtualWindow(true);
        this.updateRailMetrics();
      });
    },
    async checkBackgroundRefresh() {
      const token = (this._refreshToken || 0) + 1;
      this._refreshToken = token;
      try {
        const result = await refreshSubscribedPodcasts();
        if (this._isDestroyed || token !== this._refreshToken) return;
        this.refreshFailures = (result.results || []).filter(
          item => item.error
        );
        if (result.skipped) return;
        const nextSnapshot = await getSubscriptionUpdatesSnapshot(this.listNow);
        if (this._isDestroyed || token !== this._refreshToken) return;
        const knownIds = new Set(
          (this.pendingSnapshot || this.snapshot).episodes.map(item => item.id)
        );
        const freshCount = nextSnapshot.episodes.filter(
          item => !knownIds.has(item.id)
        ).length;
        const main = this.getMainScrollElement();
        if (freshCount && main && main.scrollTop > 24) {
          this.pendingSnapshot = nextSnapshot;
          this.pendingNewCount = freshCount;
          this.$nextTick(() => this.recalcVirtualWindow(true));
          return;
        }
        this.applySnapshot(nextSnapshot);
      } catch (error) {
        if (this._isDestroyed || token !== this._refreshToken) return;
        this.loadingError = '订阅后台更新暂时不可用';
      }
    },
    applyPendingUpdates() {
      if (!this.pendingSnapshot) return;
      this.snapshot = this.pendingSnapshot;
      this.pendingSnapshot = null;
      this.pendingNewCount = 0;
      this.scrollFeedToTop();
      this.primeRailHalos();
      this.$nextTick(() => {
        this.recalcVirtualWindow(true);
        this.updateRailMetrics();
      });
    },
    getMainScrollElement() {
      return this._scrollEl || (this.$el && this.$el.closest('main'));
    },
    bindMainScroll() {
      const main = this.getMainScrollElement();
      if (main) {
        this.bindMainScrollTarget(main);
        return;
      }
      this.$nextTick(() => {
        if (this._isDestroyed || this._mainScrollBound) return;
        const delayedMain = this.getMainScrollElement();
        if (!delayedMain) return;
        this.bindMainScrollTarget(delayedMain);
        this.recalcVirtualWindow(true);
      });
    },
    bindMainScrollTarget(main) {
      if (!main || this._mainScrollBound === main) return;
      this.unbindMainScroll();
      this._scrollEl = main;
      this._mainScrollBound = main;
      main.addEventListener('scroll', this.onMainScroll, { passive: true });
      main.addEventListener('wheel', this.stopFeedScrollAnimation, {
        passive: true,
      });
      main.addEventListener('pointerdown', this.stopFeedScrollAnimation, {
        passive: true,
      });
      main.addEventListener('touchstart', this.stopFeedScrollAnimation, {
        passive: true,
      });
      this.showBackTop = main.scrollTop > 520;
    },
    unbindMainScroll() {
      const main = this._mainScrollBound;
      if (!main) return;
      main.removeEventListener('scroll', this.onMainScroll);
      main.removeEventListener('wheel', this.stopFeedScrollAnimation);
      main.removeEventListener('pointerdown', this.stopFeedScrollAnimation);
      main.removeEventListener('touchstart', this.stopFeedScrollAnimation);
      this._mainScrollBound = null;
    },
    onResize() {
      this.recalcVirtualWindow(true);
      this.updateRailMetrics();
    },
    onMainScroll() {
      if (this._virtualRaf) return;
      this._virtualRaf = requestAnimationFrame(() => {
        this._virtualRaf = null;
        const main = this.getMainScrollElement();
        this.showBackTop = !!(main && main.scrollTop > 520);
        this.recalcVirtualWindow();
      });
    },
    recalcVirtualWindow(forceMeasure = false) {
      const metrics = this.flatMetrics;
      const main = this.getMainScrollElement();
      const list = this.$refs.feedList;
      if (!metrics.length || !main || !list) {
        this.winStart = 0;
        this.winEnd = metrics.length;
        return;
      }
      if (forceMeasure || !Number.isFinite(this._feedListTop)) {
        const mainRect = main.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        this._feedListTop = main.scrollTop + listRect.top - mainRect.top;
      }
      const viewportStart = main.scrollTop - this._feedListTop;
      const visibleStart = Math.max(0, viewportStart);
      const visibleEnd = Math.max(
        visibleStart,
        viewportStart + main.clientHeight
      );
      const firstVisible = findVirtualIndex(metrics, visibleStart);
      const lastVisible = findVirtualIndex(
        metrics,
        Math.max(visibleStart, visibleEnd - 1)
      );
      const range = getStableVirtualRange({
        itemCount: metrics.length,
        firstVisible,
        lastVisible,
        currentStart: this.winStart,
        currentEnd: this.winEnd,
        buffer: VIRTUAL_BUFFER,
        guard: VIRTUAL_GUARD,
        force: forceMeasure,
      });
      if (!range.changed && !forceMeasure) return;
      this.winStart = range.start;
      this.winEnd = range.end;
      this.hydrateVisibleNasState();
    },
    selectPodcast(podcastId) {
      if (this.selectedPodcastId === podcastId) return;
      this.selectedPodcastId = podcastId;
      this.scrollFeedToTop();
      this.$nextTick(() => {
        this.recalcVirtualWindow(true);
        if (podcastId) this.ensureRailItemVisible(podcastId);
      });
    },
    setUnfinishedOnly(value) {
      if (this.unfinishedOnly === value) return;
      this.filterSwitching = true;
      this.unfinishedOnly = value;
      this.scrollFeedToTop();
      this.$nextTick(() => {
        this.recalcVirtualWindow(true);
        if (this._filterRaf) cancelAnimationFrame(this._filterRaf);
        this._filterRaf = requestAnimationFrame(() => {
          this._filterRaf = null;
          this.filterSwitching = false;
        });
      });
    },
    scrollFeedToTop() {
      const main = this.getMainScrollElement();
      this.stopFeedScrollAnimation();
      if (main) main.scrollTop = 0;
      this.showBackTop = false;
    },
    scrollFeedToTopSmooth() {
      const main = this.getMainScrollElement();
      if (!main || main.scrollTop <= 0) return;
      this.stopFeedScrollAnimation();
      const start = main.scrollTop;
      const duration = Math.min(420, Math.max(240, 180 + Math.sqrt(start) * 2));
      const startedAt = performance.now();
      const tick = now => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 4);
        main.scrollTop = start * (1 - eased);
        if (progress < 1) {
          this._feedScrollRaf = requestAnimationFrame(tick);
        } else {
          this._feedScrollRaf = null;
          main.scrollTop = 0;
          this.showBackTop = false;
        }
      };
      this._feedScrollRaf = requestAnimationFrame(tick);
    },
    stopFeedScrollAnimation() {
      if (!this._feedScrollRaf) return;
      cancelAnimationFrame(this._feedScrollRaf);
      this._feedScrollRaf = null;
    },
    goAllSubscriptions(action) {
      markAllSubscriptionsEntryFromUpdates();
      const query = action ? { action } : {};
      this.$router.push({ name: 'subscriptionLibrary', query });
    },
    goPodcastDetail(episode) {
      if (!episode || !episode.podcastId) return;
      this.$router.push({
        name: 'podcastDetail',
        params: {
          feedUrlEncoded: encodeURIComponent(episode.podcastId),
        },
      });
    },
    goEpisodeDetail(episode) {
      if (!episode || !episode.podcastId) return;
      this.$router.push({
        name: 'episodeDetail',
        params: {
          feedUrlEncoded: encodeURIComponent(episode.podcastId),
          guidEncoded: encodeURIComponent(episode.guid),
        },
      });
    },
    playEpisode(episode) {
      const player = this.$store.state.player;
      if (!player || !episode) return;
      if (this.isCurrentEpisode(episode)) {
        if (typeof player.playOrPause === 'function') player.playOrPause();
        return;
      }
      player.playPodcastEpisode(episode, episode.podcastTitle || '');
    },
    isCurrentEpisode(episode) {
      return !!(episode && this.currentEpisodeId === episode.id);
    },
    liveListenState(episode) {
      return episode && this.liveListenByEpisode[episode.id]
        ? this.liveListenByEpisode[episode.id]
        : null;
    },
    isUnstarted(episode) {
      if (!episode) return false;
      const live = this.liveListenState(episode);
      const listenStats = (live && live.listenStats) || episode.listenStats;
      const listenedSec = live
        ? live.listenedSec
        : Number(episode.listenedSec) || 0;
      return !!(
        episode &&
        !(live ? live.completed : episode.completed) &&
        !(listenStats && listenStats.listenedSec) &&
        !listenedSec
      );
    },
    progressLabel(episode) {
      const live = this.liveListenState(episode);
      if (live ? live.completed : episode.completed) return '已完成';
      const percent = listenedPercentStepped(
        (live && live.listenStats) || episode.listenStats
      );
      if (percent >= 5) return '已听 ' + percent + '%';
      return '未听';
    },
    formatDuration(value) {
      const total = Math.max(0, Number(value) || 0);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = Math.floor(total % 60);
      if (hours) {
        return (
          hours +
          ':' +
          String(minutes).padStart(2, '0') +
          ':' +
          String(seconds).padStart(2, '0')
        );
      }
      return minutes + ':' + String(seconds).padStart(2, '0');
    },
    formatPublished(value) {
      const time = Number(value) || 0;
      if (!time) return '发布时间未知';
      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return '发布时间未知';
      return date.toLocaleDateString('zh-CN');
    },
    isFavorited(episode) {
      return !!(episode && this.favoriteIdSet.has(episode.id));
    },
    isDownloaded(episode) {
      return !!(episode && this.downloadedIdSet.has(episode.id));
    },
    isQueued(episode) {
      return !!(episode && this.queueIdSet.has(episode.id));
    },
    downloadProgress(episode) {
      const map =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.progressMap) ||
        {};
      return episode ? map[episode.id] || null : null;
    },
    downloadMenuIcon(episode) {
      if (this.isDownloaded(episode)) return 'trash';
      const progress = this.downloadProgress(episode);
      return progress ? 'x' : 'download';
    },
    downloadMenuLabel(episode) {
      if (this.isDownloaded(episode)) return '删除下载';
      const progress = this.downloadProgress(episode);
      if (progress) {
        return progress.status === 'queued' ? '取消排队' : '取消下载';
      }
      return '下载';
    },
    capabilityTags(episode) {
      const tags = [];
      const progress = this.downloadProgress(episode);
      if (progress) {
        const percent =
          progress.bytesTotal > 0
            ? Math.min(
                99,
                Math.floor((progress.bytesDone / progress.bytesTotal) * 100)
              ) + '%'
            : '下载中';
        tags.push({
          key: 'download',
          icon: 'download',
          label: percent,
          tip: progress.status === 'queued' ? '已排队下载' : '正在下载本地音频',
        });
      } else if (this.isDownloaded(episode)) {
        tags.push({
          key: 'downloaded',
          icon: 'check-circle',
          label: '已下载',
          tip: '本集已下载',
        });
      }
      if (episode.transcriptReady) {
        tags.push({
          key: 'transcript',
          icon: 'notebook',
          label: '文稿',
          tip: '本集已有文字稿',
        });
      }
      if (this.hasNas(episode)) {
        tags.push({
          key: 'nas',
          icon: 'wifi',
          label: 'NAS',
          tip: 'NAS 上有此单集',
        });
      }
      if (this.isQueued(episode)) {
        tags.push({
          key: 'queue',
          icon: 'queue',
          label: '队列',
          tip: '已加入播放列表',
        });
      }
      if (this.isFavorited(episode)) {
        tags.push({
          key: 'favorite',
          icon: 'heart-solid',
          label: '收藏',
          tip: '已收藏',
        });
      }
      return tags.slice(0, 2);
    },
    openEpisodeMenu(event, episode) {
      if (!episode || !this.$refs.episodeMenu) return;
      this.menuEpisode = episode;
      this.$refs.episodeMenu.openMenu(event);
    },
    closeMenu() {
      this.menuEpisode = null;
    },
    toggleQueue(episode) {
      if (!episode) return;
      if (this.isQueued(episode)) {
        this.$store.commit('removeFromQueue', episode.id);
        return;
      }
      this.$store.dispatch('enqueueEpisode', {
        ...episode,
        podcastTitle: episode.podcastTitle || '',
        coverUrl: episode.coverUrl || episode.podcastCoverUrl || '',
      });
    },
    favoriteTrack(episode) {
      return {
        podcastEpisodeId: episode.id,
        podcastId: episode.podcastId,
        name: episode.title,
        al: {
          id: episode.podcastId,
          name: episode.podcastTitle || '',
          picUrl: episode.coverUrl || episode.podcastCoverUrl || '',
        },
        podcastAudioUrl: episode.audioUrl || '',
        dt: Math.round((Number(episode.duration) || 0) * 1000),
      };
    },
    toggleFavorite(episode) {
      if (!episode) return;
      this.$store.dispatch(
        'togglePodcastFavorite',
        this.favoriteTrack(episode)
      );
    },
    toggleDownload(episode) {
      if (!episode) return;
      if (this.isDownloaded(episode)) {
        this.deleteDownloadTarget = episode;
        return;
      }
      if (this.downloadProgress(episode)) {
        cancelDownload(episode.id);
        return;
      }
      startDownload(episode);
    },
    async confirmRemoveDownload() {
      const episode = this.deleteDownloadTarget;
      this.deleteDownloadTarget = null;
      if (!episode) return;
      await removeDownload(episode.id);
      this.$store.dispatch('showToast', '已删除下载');
    },
    onRailScroll() {
      this.railScrolling = true;
      if (!this._railScrollRaf) {
        this._railScrollRaf = requestAnimationFrame(() => {
          this._railScrollRaf = null;
          this.updateRailMetrics(false);
        });
      }
      if (this._railScrollTimer) clearTimeout(this._railScrollTimer);
      this._railScrollTimer = setTimeout(() => {
        this.railScrolling = false;
      }, 120);
    },
    updateRailMetrics(measureTrack = true) {
      const viewport = this.$refs.railViewport;
      if (!viewport) return;
      this.railMetrics = getRailMetrics({
        scrollLeft: viewport.scrollLeft,
        clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
      });
      if (measureTrack) {
        this.railTrackWidth = this.$refs.railTrack
          ? this.$refs.railTrack.clientWidth
          : 0;
      }
    },
    scrollRail(direction) {
      const viewport = this.$refs.railViewport;
      if (!viewport) return;
      const target = getRailArrowTarget({
        scrollLeft: viewport.scrollLeft,
        clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
        direction,
      });
      this.animateRailTo(target);
    },
    animateRailTo(target) {
      const viewport = this.$refs.railViewport;
      if (!viewport) return;
      this.stopRailAnimation();
      const start = viewport.scrollLeft;
      const distance = target - start;
      if (Math.abs(distance) < 1) return;
      const startedAt = performance.now();
      const duration = 210;
      const tick = now => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        viewport.scrollLeft = start + distance * eased;
        if (progress < 1) this._railAnimationRaf = requestAnimationFrame(tick);
        else this._railAnimationRaf = null;
      };
      this._railAnimationRaf = requestAnimationFrame(tick);
    },
    stopRailAnimation() {
      if (this._railAnimationRaf) {
        cancelAnimationFrame(this._railAnimationRaf);
        this._railAnimationRaf = null;
      }
    },
    ensureRailItemVisible(podcastId) {
      const viewport = this.$refs.railViewport;
      const items = this.$refs.railItems || [];
      const item = items.find(node => node.dataset.podcastId === podcastId);
      if (!viewport || !item) return;
      const left = item.offsetLeft;
      const right = left + item.offsetWidth;
      if (left < viewport.scrollLeft) this.animateRailTo(left);
      else if (right > viewport.scrollLeft + viewport.clientWidth) {
        this.animateRailTo(right - viewport.clientWidth);
      }
    },
    startRailDrag(event) {
      if (!event.isPrimary || !this.railMetrics.canScroll) return;
      this.stopRailAnimation();
      this.railDragging = true;
      const thumb = this.$refs.railThumb;
      this._railDrag = {
        pointerId: event.pointerId,
        startPointerX: event.clientX,
        startScrollLeft: this.railMetrics.scrollLeft,
        trackWidth: this.railTrackWidth,
        thumbWidth: thumb ? thumb.offsetWidth : 0,
        maxScroll: this.railMetrics.maxScroll,
        pendingScrollLeft: this.railMetrics.scrollLeft,
      };
      this._railDragTarget = event.currentTarget;
      if (this._railDragTarget.setPointerCapture) {
        this._railDragTarget.setPointerCapture(event.pointerId);
      }
      document.addEventListener('pointermove', this.onRailDragMove);
      document.addEventListener('pointerup', this.finishRailDrag);
      document.addEventListener('pointercancel', this.finishRailDrag);
    },
    onRailDragMove(event) {
      if (!this._railDrag || event.pointerId !== this._railDrag.pointerId)
        return;
      this._railDrag.pendingScrollLeft = getRailThumbDragTarget({
        startScrollLeft: this._railDrag.startScrollLeft,
        startPointerX: this._railDrag.startPointerX,
        pointerX: event.clientX,
        trackWidth: this._railDrag.trackWidth,
        thumbWidth: this._railDrag.thumbWidth,
        maxScroll: this._railDrag.maxScroll,
      });
      if (this._railDragRaf) return;
      this._railDragRaf = requestAnimationFrame(() => {
        this._railDragRaf = null;
        const viewport = this.$refs.railViewport;
        if (viewport && this._railDrag) {
          viewport.scrollLeft = this._railDrag.pendingScrollLeft;
        }
      });
    },
    finishRailDrag(event) {
      if (
        event &&
        this._railDrag &&
        event.pointerId !== this._railDrag.pointerId
      ) {
        return;
      }
      if (this._railDragRaf) {
        cancelAnimationFrame(this._railDragRaf);
        this._railDragRaf = null;
      }
      const viewport = this.$refs.railViewport;
      if (viewport && this._railDrag) {
        viewport.scrollLeft = this._railDrag.pendingScrollLeft;
      }
      if (
        this._railDragTarget &&
        this._railDrag &&
        this._railDragTarget.releasePointerCapture
      ) {
        try {
          this._railDragTarget.releasePointerCapture(this._railDrag.pointerId);
        } catch (e) {
          // 指针已在浏览器侧释放时无需再处理。
        }
      }
      this._railDrag = null;
      this._railDragTarget = null;
      this.railDragging = false;
      this.updateRailMetrics(false);
      document.removeEventListener('pointermove', this.onRailDragMove);
      document.removeEventListener('pointerup', this.finishRailDrag);
      document.removeEventListener('pointercancel', this.finishRailDrag);
    },
    primeRailHalos() {
      const token = (this._haloToken || 0) + 1;
      this._haloToken = token;
      this.railPodcasts.slice(0, 28).forEach(podcast => {
        if (!podcast || !podcast.coverUrl) return;
        const cached = peekTinyCover(podcast.coverUrl);
        if (cached) {
          this.$set(this.railHaloMap, podcast.id, cached);
          return;
        }
        ensureTinyCover(podcast.coverUrl).then(url => {
          if (
            !this._isDestroyed &&
            token === this._haloToken &&
            url &&
            this.railPodcasts.some(item => item.id === podcast.id)
          ) {
            this.$set(this.railHaloMap, podcast.id, url);
          }
        });
      });
    },
    railHaloStyle(podcast) {
      const url = podcast && this.railHaloMap[podcast.id];
      return url ? { backgroundImage: 'url("' + url + '")' } : {};
    },
    async hydrateVisibleNasState() {
      const visiblePodcastIds = [];
      this.virtualItems.forEach(item => {
        if (
          item.type === 'episode' &&
          item.episode.podcastId &&
          !this.nasByPodcast[item.episode.podcastId] &&
          !this._nasLoading?.has(item.episode.podcastId)
        ) {
          visiblePodcastIds.push(item.episode.podcastId);
        }
      });
      const unique = [...new Set(visiblePodcastIds)].slice(0, 4);
      if (!unique.length) return;
      if (!this._nasLoading) this._nasLoading = new Set();
      unique.forEach(podcastId => {
        this._nasLoading.add(podcastId);
        nasEpisodeGuidSet(podcastId)
          .then(set => {
            if (!this._isDestroyed)
              this.$set(this.nasByPodcast, podcastId, set);
          })
          .catch(() => {})
          .finally(() => {
            if (this._nasLoading) this._nasLoading.delete(podcastId);
          });
      });
    },
    hasNas(episode) {
      if (!episode) return false;
      const set = this.nasByPodcast[episode.podcastId];
      if (!set) return false;
      if (episode.guid && set.has(episode.guid)) return true;
      if (episode.audioUrl && set.has(normFeedUrl(episode.audioUrl)))
        return true;
      return !!(episode.pubTime && set.has(String(episode.pubTime)));
    },
    async syncListeningState() {
      const signal = this.$store.state.podcastListening || {};
      if (!signal.episodeId) return;
      const episodeId = signal.episodeId;
      const token = (this._listenSyncToken || 0) + 1;
      this._listenSyncToken = token;
      const index = this.snapshot.episodes.findIndex(
        episode => episode.id === episodeId
      );
      if (index < 0) return;
      try {
        const listenStats = await getListenStats(episodeId);
        if (this._isDestroyed || token !== this._listenSyncToken) return;
        const oldEpisode = this.snapshot.episodes[index];
        const completed = !!(listenStats && listenStats.completed);
        this.$set(this.liveListenByEpisode, episodeId, {
          listenStats,
          completed,
          listenedSec:
            Number(signal.listenedSec) || oldEpisode.listenedSec || 0,
        });
        if (completed !== oldEpisode.completed) {
          this.$set(this.snapshot.episodes, index, {
            ...oldEpisode,
            completed,
          });
        }
      } catch (e) {
        // 状态同步失败时保留当前列表，下一次播放广播会再校正。
      }
    },
  },
};
</script>

<style lang="scss" scoped>
.subscription-updates {
  color: var(--color-text);
  padding-top: 28px;
}

.updates-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 20px;
  margin-bottom: 24px;
}

.updates-title {
  min-width: 0;

  h1 {
    margin: 0;
    font-size: 32px;
    line-height: 1;
  }

  p {
    margin: 9px 0 0;
    color: var(--color-text-secondary);
    font-size: 14px;
  }
}

.all-subscriptions-button,
.secondary-action,
.primary-action,
.danger-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 34px;
  padding: 7px 12px;
  border-radius: 7px;
  border: 0;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.all-subscriptions-button,
.secondary-action {
  background: var(--color-secondary-bg);

  &:hover {
    color: var(--color-primary);
    background: var(--color-primary-bg-for-transparent);
  }
}

.primary-action {
  color: #fff;
  background: var(--color-primary);
}

.danger-action {
  color: #fff;
  background: #d94f4f;
}

.all-subscriptions-button .svg-icon,
.secondary-action .svg-icon,
.primary-action .svg-icon,
.danger-action .svg-icon {
  width: 15px;
  height: 15px;
}

.updates-rail-section {
  width: 100%;
  margin-bottom: 17px;
}

.updates-rail {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 36px;
  gap: 10px;
  align-items: center;
}

.rail-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--color-text);
  background: var(--color-secondary-bg);

  .svg-icon {
    width: 16px;
    height: 16px;
  }

  &:hover:not(:disabled) {
    color: var(--color-primary);
    background: var(--color-primary-bg-for-transparent);
  }

  &:disabled {
    opacity: 0.3;
    cursor: default;
  }
}

.rail-viewport {
  --rail-gap: 12px;

  display: flex;
  min-width: 0;
  gap: var(--rail-gap);
  overflow-x: auto;
  overflow-y: hidden;
  padding: 6px 3px 8px;
  contain: layout paint style;
  scrollbar-width: none;
  scroll-behavior: auto;

  &::-webkit-scrollbar {
    height: 0;
  }

  &:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 7px;
  }
}

.rail-item {
  position: relative;
  display: inline-flex;
  flex: 0 0 clamp(84px, 8vw, 124px);
  align-items: center;
  justify-content: center;
  height: 80px;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--color-text-secondary);
  background: transparent;
  text-align: left;

  &:hover {
    color: var(--color-text);
    background: var(--color-secondary-bg);
  }

  &.active {
    color: var(--color-text);
    border-color: var(--color-primary);
    background: var(--color-primary-bg-for-transparent);
  }
}

.rail-cover,
.rail-all-icon {
  position: relative;
  display: inline-flex;
  width: 72px;
  height: 72px;
  align-items: center;
  justify-content: center;
  overflow: visible;
  border-radius: 8px;
}

.rail-cover-image {
  position: relative;
  z-index: 1;
  width: 72px;
  height: 72px;
  overflow: hidden;
  border-radius: 8px;
}

.rail-cover-halo {
  position: absolute;
  inset: 7px;
  z-index: 0;
  border-radius: 8px;
  background-position: center;
  background-size: cover;
  filter: blur(8px);
  opacity: 0.36;
  transform: scale(1.16);
  transition: opacity 150ms ease-out;
}

.rail-item:hover .rail-cover-halo {
  opacity: 0.54;
}

.updates-rail.is-scrolling .rail-cover-halo,
.updates-rail.is-dragging .rail-cover-halo {
  filter: none;
  opacity: 0;
  transition: none;
}

.rail-all-icon {
  color: var(--color-primary);
  background: var(--color-secondary-bg);

  .svg-icon {
    width: 17px;
    height: 17px;
  }
}

.rail-track {
  position: relative;
  width: min(360px, calc(100% - 92px));
  height: 16px;
  margin: 0 auto;

  &.is-hidden {
    visibility: hidden;
    pointer-events: none;
  }

  &::before {
    position: absolute;
    top: 6px;
    right: 0;
    left: 0;
    height: 4px;
    border-radius: 999px;
    background: var(--color-secondary-bg);
    content: '';
  }
}

.rail-thumb {
  position: absolute;
  left: 0;
  top: 6px;
  height: 4px;
  border-radius: inherit;
  background: var(--color-primary);
  cursor: default;
  touch-action: none;

  &::after {
    position: absolute;
    top: -6px;
    right: 0;
    bottom: -6px;
    left: 0;
    content: '';
  }
}

.updates-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 36px;
  margin-bottom: 8px;
}

.updates-segmented {
  position: relative;
  display: inline-flex;
  overflow: hidden;
  padding: 3px;
  border-radius: 7px;
  background: var(--color-secondary-bg);

  &::before {
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 3px;
    width: calc((100% - 6px) / 2);
    border-radius: 5px;
    background: var(--color-primary);
    content: '';
    pointer-events: none;
    transform: translateX(0);
    transition: transform 160ms cubic-bezier(0.2, 0.75, 0.25, 1);
  }

  &.is-unfinished::before {
    transform: translateX(100%);
  }

  button {
    position: relative;
    z-index: 1;
    min-width: 60px;
    min-height: 28px;
    padding: 4px 10px;
    border: 0;
    border-radius: 5px;
    color: var(--color-text-secondary);
    background: transparent;
    font-size: 13px;
    font-weight: 600;
    transition: color 130ms ease-out;

    &.active {
      color: #fff;
    }
  }
}

.updates-count {
  color: var(--color-text-secondary);
  font-size: 13px;
}

.updates-new-banner,
.updates-refresh-note {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 34px;
  margin: 0 0 10px;
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  color: var(--color-text);
  text-align: left;
  font-size: 13px;
}

.updates-new-banner {
  color: var(--color-primary);
  background: var(--color-primary-bg-for-transparent);

  &:hover {
    background: var(--color-secondary-bg);
  }
}

.updates-refresh-note {
  color: var(--color-text-secondary);
  background: var(--color-secondary-bg);
}

.updates-new-banner .svg-icon,
.updates-refresh-note .svg-icon {
  width: 15px;
  height: 15px;
}

.updates-list {
  border-top: 1px solid var(--color-secondary-bg);
  opacity: 1;
  transition: opacity 130ms ease-out;
}

.updates-filter-empty {
  opacity: 1;
  transition: opacity 130ms ease-out;
}

.updates-list.is-filter-switching,
.updates-filter-empty.is-filter-switching {
  opacity: 0.62;
}

.update-virtual-item.is-group {
  height: 34px;
}

.update-virtual-item.is-episode {
  height: 96px;
}

.update-date-group {
  display: flex;
  align-items: flex-end;
  height: 34px;
  padding: 0 2px 7px;
  box-sizing: border-box;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 700;
}

.update-episode-row {
  position: relative;
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  height: 100%;
  padding: 10px 4px;
  border-top: 1px solid var(--color-secondary-bg);
  box-sizing: border-box;

  &.is-playing .update-episode-title {
    color: var(--color-primary);
  }
}

.update-cover-button {
  width: 58px;
  height: 58px;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: 6px;
  background: var(--color-secondary-bg);
}

.update-cover {
  width: 58px;
  height: 58px;
}

.update-episode-main {
  min-width: 0;
}

.update-episode-meta,
.update-episode-sub {
  display: flex;
  min-width: 0;
  gap: 6px;
  align-items: center;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.2;
}

.update-podcast-link,
.update-episode-title {
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
}

.update-podcast-link {
  overflow: hidden;
  max-width: 52%;
  color: var(--color-text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    color: var(--color-primary);
  }
}

.unstarted-dot {
  width: 5px;
  height: 5px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--color-primary);
}

.update-published {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.update-episode-title {
  display: -webkit-box;
  max-width: 100%;
  min-height: 32px;
  margin: 4px 0;
  overflow: hidden;
  color: var(--color-text);
  font-size: 14px;
  font-weight: 650;
  line-height: 16px;
  text-overflow: ellipsis;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;

  &:hover {
    color: var(--color-primary);
  }
}

.update-episode-sub {
  overflow: hidden;
  white-space: nowrap;
}

.episode-capability {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  overflow: hidden;
  color: var(--color-text-secondary);
  text-overflow: ellipsis;

  .svg-icon {
    width: 13px;
    height: 13px;
  }
}

.update-episode-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 0;
  align-items: center;
}

.updates-back-top {
  position: fixed;
  right: clamp(24px, 4vw, 64px);
  bottom: 108px;
  z-index: 24;
  display: inline-flex;
  width: 42px;
  height: 42px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--color-text);
  background: var(--color-body-bg);
  box-shadow: 0 5px 18px rgba(0, 0, 0, 0.18);

  .svg-icon {
    width: 18px;
    height: 18px;
  }

  &:hover {
    color: var(--color-primary);
    background: var(--color-secondary-bg);
  }
}

.updates-back-top-enter-active,
.updates-back-top-leave-active {
  transition: opacity 120ms ease-out, transform 120ms ease-out;
}

.updates-back-top-enter,
.updates-back-top-leave-to {
  opacity: 0;
  transform: translateY(5px);
}

.updates-empty {
  min-height: 230px;
  padding: 48px 0;
  text-align: center;

  h2 {
    margin: 0 0 8px;
    font-size: 20px;
  }

  p {
    max-width: 420px;
    margin: 0 auto;
    color: var(--color-text-secondary);
    font-size: 14px;
    line-height: 1.6;
  }
}

.updates-filter-empty {
  min-height: 150px;

  .secondary-action {
    margin-top: 12px;
  }
}

.empty-actions,
.dialog-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 18px;
}

.updates-skeleton {
  padding-top: 8px;
}

.skeleton-row {
  height: 96px;
  border-top: 1px solid var(--color-secondary-bg);
  background: linear-gradient(
    90deg,
    transparent 0,
    var(--color-secondary-bg) 45%,
    transparent 80%
  );
  background-size: 220% 100%;
  animation: updates-skeleton 1.35s ease-in-out infinite;
}

.dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.34);
  -webkit-app-region: no-drag;
}

.confirm-dialog {
  width: min(390px, calc(100vw - 40px));
  padding: 22px;
  border-radius: 8px;
  color: var(--color-text);
  background: var(--color-body-bg);
  box-shadow: 0 16px 50px rgba(0, 0, 0, 0.2);

  .title {
    font-size: 17px;
    font-weight: 700;
  }

  .msg {
    margin-top: 10px;
    color: var(--color-text-secondary);
    font-size: 14px;
    line-height: 1.6;
  }

  .dialog-actions {
    justify-content: flex-end;
  }
}

@keyframes updates-skeleton {
  0%,
  100% {
    background-position: 100% 0;
  }
  50% {
    background-position: 0 0;
  }
}

@media (max-width: 760px) {
  .updates-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .all-subscriptions-button {
    align-self: flex-end;
  }

  .rail-item {
    flex-basis: 56px;
    min-width: 56px;
    height: 56px;
  }

  .rail-cover,
  .rail-cover-image,
  .rail-all-icon {
    width: 48px;
    height: 48px;
  }

  .update-episode-row {
    grid-template-columns: 50px minmax(0, 1fr) auto;
    gap: 9px;
  }

  .update-cover-button,
  .update-cover {
    width: 50px;
    height: 50px;
  }

  .episode-capability span {
    display: none;
  }

  .update-podcast-link {
    max-width: 44%;
  }
}
</style>
