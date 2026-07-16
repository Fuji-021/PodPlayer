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

    <section
      v-if="loadingError && !hasSnapshot"
      class="updates-empty updates-error"
    >
      <h2>更新流暂时无法读取</h2>
      <p>{{ loadingError }}</p>
      <button class="secondary-action" @click="retryLoad">重试</button>
    </section>

    <section v-else-if="loaded && !podcastCount" class="updates-empty">
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
      <SubscriptionProgramRail
        :podcasts="railPodcasts"
        :selected-podcast-id="selectedPodcastId"
        @select="selectPodcast"
      />

      <div class="updates-tools">
        <div class="updates-segmented" role="tablist" aria-label="更新筛选">
          <button
            :class="{ active: listenFilter === 'all' }"
            :aria-selected="listenFilter === 'all'"
            role="tab"
            @click="setListenFilter('all')"
          >
            全部
          </button>
          <button
            :class="{ active: listenFilter === 'completed' }"
            :aria-selected="listenFilter === 'completed'"
            role="tab"
            @click="setListenFilter('completed')"
          >
            已听完
          </button>
        </div>
        <span v-if="currentView.episodes.length" class="updates-count">
          {{ currentView.episodes.length }} 集
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
      <div v-if="loadingError && hasSnapshot" class="updates-refresh-note">
        <svg-icon icon-class="info" />
        {{ loadingError }}
      </div>

      <section
        v-if="!loaded"
        class="updates-skeleton"
        aria-label="正在载入更新"
      >
        <div v-for="index in 5" :key="index" class="skeleton-row"></div>
      </section>
      <section v-else-if="!snapshot.episodes.length" class="updates-empty">
        <h2>订阅里还没有单集</h2>
        <p>订阅会继续在后台更新；你也可以进入全部订阅检查节目来源。</p>
      </section>
      <section
        v-else-if="!currentView.episodes.length"
        class="updates-empty updates-filter-empty"
      >
        <h2>{{ emptyFilterTitle }}</h2>
        <button class="secondary-action" @click="setUnfinishedOnly(false)">
          切回全部
        </button>
      </section>
      <SubscriptionEpisodeFeed
        v-else
        ref="episodeFeed"
        :view="currentView"
        :get-episode-state="getEpisodeState"
        @open-episode="goEpisodeDetail"
        @open-podcast="goPodcastDetail"
        @play="playEpisode"
        @menu="openEpisodeMenu"
        @visible-episodes="hydrateVisibleNasState"
      />
    </template>

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
          isQueued(menuEpisode) ? '移出播放队列' : '加入播放队列'
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
          <button class="secondary-action" @click="deleteDownloadTarget = null"
            >取消</button
          >
          <button class="danger-action" @click="confirmRemoveDownload"
            >删除下载</button
          >
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import ContextMenu from '@/components/ContextMenu.vue';
import SvgIcon from '@/components/SvgIcon.vue';
import SubscriptionProgramRail from '@/components/podcast/SubscriptionProgramRail.vue';
import SubscriptionEpisodeFeed from '@/components/podcast/SubscriptionEpisodeFeed.vue';
import {
  getListenStats,
  listenedPercentStepped,
} from '@/utils/podcast/listening';
import {
  cancelDownload,
  removeDownload,
  startDownload,
} from '@/utils/podcast/downloads';
import { nasEpisodeGuidSet, normFeedUrl } from '@/utils/podcast/nasSource';
import {
  applySubscriptionUpdateCompletion,
  getSubscriptionUpdatesSnapshot,
  getSubscriptionUpdateView,
  markSubscriptionUpdatesDirty,
} from '@/utils/podcast/subscriptionUpdatesData';
import { refreshSubscribedPodcasts } from '@/utils/podcast/subscriptionRefresh';
import {
  countPendingSubscriptionEpisodes,
  resolveSubscriptionSelection,
} from '@/utils/podcast/subscriptionUpdatesRules';
import {
  markAllSubscriptionsEntryFromUpdates,
  onSubscriptionUpdatesChanged,
} from '@/utils/podcast/subscriptionNavigation';

const EMPTY_VIEW = Object.freeze({
  episodes: Object.freeze([]),
  groups: Object.freeze([]),
  flatItems: Object.freeze([]),
  metrics: Object.freeze([]),
  totalHeight: 0,
});

function emptySnapshot() {
  return {
    podcasts: Object.freeze([]),
    episodes: Object.freeze([]),
    podcastCount: 0,
    favoriteIds: Object.freeze([]),
    downloadedIds: Object.freeze([]),
  };
}

export default {
  name: 'SubscriptionUpdates',
  components: {
    ContextMenu,
    SvgIcon,
    SubscriptionProgramRail,
    SubscriptionEpisodeFeed,
  },
  data() {
    return {
      snapshot: emptySnapshot(),
      pendingSnapshot: null,
      pendingNewCount: 0,
      refreshFailures: [],
      selectedPodcastId: '',
      listenFilter: 'all',
      loaded: false,
      loadingError: '',
      listNow: Date.now(),
      liveListenByEpisode: {},
      nasByPodcast: {},
      menuEpisode: null,
      deleteDownloadTarget: null,
    };
  },
  computed: {
    hasSnapshot() {
      return !!(this.snapshot && this.snapshot.version);
    },
    podcastCount() {
      return this.snapshot.podcastCount || 0;
    },
    railPodcasts() {
      return this.snapshot.podcasts || [];
    },
    currentView() {
      return (
        getSubscriptionUpdateView(this.snapshot, {
          podcastId: this.selectedPodcastId,
          listenFilter: this.listenFilter,
          now: this.listNow,
        }) || EMPTY_VIEW
      );
    },
    favoriteIdSet() {
      const storeIds =
        (this.$store.state.podcastFavorites &&
          this.$store.state.podcastFavorites.episodeIds) ||
        [];
      return new Set([...(this.snapshot.favoriteIds || []), ...storeIds]);
    },
    downloadedIdSet() {
      const storeIds =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.doneIds) ||
        [];
      return new Set([...(this.snapshot.downloadedIds || []), ...storeIds]);
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
    refreshFailureText() {
      const count = this.refreshFailures.length;
      return count === 1
        ? '1 个节目更新失败，其他订阅不受影响'
        : count + ' 个节目更新失败，其他订阅不受影响';
    },
    emptyFilterTitle() {
      if (this.selectedPodcastId) {
        return this.listenFilter === 'completed'
          ? '这个节目还没有已听完的单集'
          : '这个节目暂时没有单集';
      }
      return this.listenFilter === 'completed'
        ? '当前订阅中还没有已听完的单集'
        : '当前筛选没有单集';
    },
  },
  watch: {
    '$store.state.podcastListening.listenTick'() {
      this.syncListeningState();
    },
  },
  created() {
    this._destroyed = false;
    this._isActive = true;
    this._removeSubscriptionUpdatesChanged = onSubscriptionUpdatesChanged(
      () => {
        markSubscriptionUpdatesDirty();
        if (!this._isActive || this._destroyed) return;
        this.listNow = Date.now();
        this.loadSnapshot({ preserveNewItems: true });
      }
    );
    this.loadInitialSnapshot();
    this.scheduleLocalDayRefresh();
  },
  activated() {
    this._isActive = true;
    if (this._wasActivated) {
      this.listNow = Date.now();
      this.$parent?.$refs?.scrollbar?.restorePosition();
      // Cached snapshots return synchronously without reading Dexie again.
      this.loadSnapshot({ preserveNewItems: true });
      this.checkBackgroundRefresh();
    }
    this._wasActivated = true;
    this.scheduleLocalDayRefresh();
  },
  deactivated() {
    this._isActive = false;
    this._refreshToken = (this._refreshToken || 0) + 1;
    if (this._dayRefreshTimer) clearTimeout(this._dayRefreshTimer);
  },
  beforeDestroy() {
    this._destroyed = true;
    this._loadToken = (this._loadToken || 0) + 1;
    this._refreshToken = (this._refreshToken || 0) + 1;
    this._listenSyncToken = (this._listenSyncToken || 0) + 1;
    if (this._removeSubscriptionUpdatesChanged) {
      this._removeSubscriptionUpdatesChanged();
      this._removeSubscriptionUpdatesChanged = null;
    }
    if (this._dayRefreshTimer) clearTimeout(this._dayRefreshTimer);
  },
  methods: {
    async loadInitialSnapshot() {
      await this.loadSnapshot();
      this.checkBackgroundRefresh();
    },
    async loadSnapshot(options = {}) {
      const token = (this._loadToken || 0) + 1;
      this._loadToken = token;
      if (!this.loaded) this.loadingError = '';
      try {
        const snapshot = await getSubscriptionUpdatesSnapshot({
          now: this.listNow,
          force: !!options.force,
        });
        if (this._destroyed || token !== this._loadToken) return null;
        this.applyIncomingSnapshot(snapshot, {
          preserveNewItems: !!options.preserveNewItems,
        });
        this.loadingError = '';
        return snapshot;
      } catch (error) {
        if (this._destroyed || token !== this._loadToken) return null;
        this.loadingError = this.hasSnapshot
          ? '更新流暂时无法刷新，已保留当前内容'
          : '请检查本地数据是否可用后重试';
        return null;
      } finally {
        if (token === this._loadToken) this.loaded = true;
      }
    },
    retryLoad() {
      this.loaded = false;
      this.loadSnapshot({ force: true }).then(() =>
        this.checkBackgroundRefresh()
      );
    },
    applySnapshot(snapshot) {
      this.snapshot = snapshot || emptySnapshot();
      this.selectedPodcastId = resolveSubscriptionSelection(
        this.railPodcasts,
        this.selectedPodcastId
      );
      this.pendingSnapshot = null;
      this.pendingNewCount = 0;
    },
    freshEpisodeCount(snapshot) {
      if (!snapshot || !this.snapshot || !this.snapshot.episodes) return 0;
      return countPendingSubscriptionEpisodes(
        this.snapshot.episodes,
        snapshot.episodes
      );
    },
    applyIncomingSnapshot(snapshot, { preserveNewItems = false } = {}) {
      const freshCount = this.freshEpisodeCount(snapshot);
      const main = this.getMainScrollElement();
      if (
        preserveNewItems &&
        this.hasSnapshot &&
        freshCount > 0 &&
        main &&
        main.scrollTop > 24
      ) {
        this.pendingSnapshot = snapshot;
        this.pendingNewCount = freshCount;
        return false;
      }
      this.applySnapshot(snapshot);
      return true;
    },
    async checkBackgroundRefresh() {
      const token = (this._refreshToken || 0) + 1;
      this._refreshToken = token;
      try {
        const result = await refreshSubscribedPodcasts();
        if (this._destroyed || token !== this._refreshToken) return;
        this.refreshFailures = (result.results || []).filter(
          item => item.error
        );
        if (result.skipped || !result.changed) return;
        const nextSnapshot = await getSubscriptionUpdatesSnapshot({
          now: this.listNow,
        });
        if (this._destroyed || token !== this._refreshToken) return;
        this.applyIncomingSnapshot(nextSnapshot, { preserveNewItems: true });
      } catch (error) {
        if (this._destroyed || token !== this._refreshToken) return;
        this.loadingError = '订阅后台刷新暂时不可用，当前列表未受影响';
      }
    },
    applyPendingUpdates() {
      if (!this.pendingSnapshot) return;
      this.applySnapshot(this.pendingSnapshot);
      this.$nextTick(() => this.$refs.episodeFeed?.resetToTop());
    },
    getMainScrollElement() {
      return this.$el && this.$el.closest('main');
    },
    scheduleLocalDayRefresh() {
      if (this._dayRefreshTimer) clearTimeout(this._dayRefreshTimer);
      const now = new Date();
      const next = new Date(now.getTime());
      next.setHours(24, 0, 1, 0);
      this._dayRefreshTimer = setTimeout(() => {
        this.listNow = Date.now();
        this.loadSnapshot({ preserveNewItems: true });
        this.scheduleLocalDayRefresh();
      }, Math.max(1000, next.getTime() - now.getTime()));
    },
    selectPodcast(podcastId) {
      if (this.selectedPodcastId === podcastId) return;
      this.selectedPodcastId = podcastId;
      this.$nextTick(() => this.$refs.episodeFeed?.resetToTop());
    },
    setListenFilter(value) {
      const nextFilter = value === 'completed' ? 'completed' : 'all';
      if (this.listenFilter === nextFilter) return;
      this.listenFilter = nextFilter;
      this.$nextTick(() => this.$refs.episodeFeed?.resetToTop());
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
        params: { feedUrlEncoded: encodeURIComponent(episode.podcastId) },
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
      player.playPodcastEpisode(
        {
          ...episode,
          coverUrl: episode.episodeCoverUrl || episode.podcastCoverUrl || '',
        },
        episode.podcastTitle || ''
      );
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
      return percent >= 5 ? '已听 ' + percent + '%' : '未听';
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
      return this.downloadProgress(episode) ? 'x' : 'download';
    },
    downloadMenuLabel(episode) {
      if (this.isDownloaded(episode)) return '删除下载';
      const progress = this.downloadProgress(episode);
      if (progress)
        return progress.status === 'queued' ? '取消排队' : '取消下载';
      return '下载';
    },
    capabilityTags(episode) {
      const tags = [];
      const progress = this.downloadProgress(episode);
      if (progress) {
        const label =
          progress.bytesTotal > 0
            ? Math.min(
                99,
                Math.floor((progress.bytesDone / progress.bytesTotal) * 100)
              ) + '%'
            : '下载中';
        tags.push({
          key: 'download',
          icon: 'download',
          label,
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
          tip: '已加入播放队列',
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
    getEpisodeState(episode) {
      return {
        isPlaying: this.isCurrentEpisode(episode) && this.playerPlaying,
        isUnstarted: this.isUnstarted(episode),
        progressText: this.progressLabel(episode),
        capabilityTags: this.capabilityTags(episode),
      };
    },
    openEpisodeMenu(event, episode) {
      if (!episode || !this.$refs.episodeMenu) return;
      this.menuEpisode = episode;
      this.$refs.episodeMenu.openMenu(event);
    },
    toggleQueue(episode) {
      if (!episode) return;
      if (this.isQueued(episode)) {
        this.$store.commit('removeFromQueue', episode.id);
        return;
      }
      this.$store.dispatch('enqueueEpisode', {
        ...episode,
        coverUrl: episode.episodeCoverUrl || episode.podcastCoverUrl || '',
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
          picUrl: episode.episodeCoverUrl || episode.podcastCoverUrl || '',
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
      startDownload({
        ...episode,
        coverUrl: episode.episodeCoverUrl || episode.podcastCoverUrl || '',
      });
    },
    async confirmRemoveDownload() {
      const episode = this.deleteDownloadTarget;
      this.deleteDownloadTarget = null;
      if (!episode) return;
      const result = await removeDownload(episode.id);
      if (result && result.ok) this.$store.dispatch('showToast', '已删除下载');
      else this.$store.dispatch('showToast', '删除下载失败');
    },
    hydrateVisibleNasState(episodes, viewToken) {
      if (!episodes || !episodes.length) return;
      const token = (this._nasHydrationToken || 0) + 1;
      this._nasHydrationToken = token;
      if (!this._nasLoading) this._nasLoading = new Set();
      const ids = [...new Set(episodes.map(episode => episode.podcastId))]
        .filter(id => id && !this.nasByPodcast[id] && !this._nasLoading.has(id))
        .slice(0, 4);
      ids.forEach(podcastId => {
        this._nasLoading.add(podcastId);
        nasEpisodeGuidSet(podcastId)
          .then(set => {
            if (
              !this._destroyed &&
              token === this._nasHydrationToken &&
              viewToken
            ) {
              this.$set(this.nasByPodcast, podcastId, set);
            }
          })
          .catch(() => {})
          .finally(() => {
            if (this._nasLoading) this._nasLoading.delete(podcastId);
          });
      });
    },
    hasNas(episode) {
      const set = episode && this.nasByPodcast[episode.podcastId];
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
      const oldEpisode = this.snapshot.episodes.find(
        episode => episode.id === episodeId
      );
      if (!oldEpisode) return;
      const token = (this._listenSyncToken || 0) + 1;
      this._listenSyncToken = token;
      try {
        const listenStats = await getListenStats(episodeId);
        if (this._destroyed || token !== this._listenSyncToken) return;
        const completed = !!(listenStats && listenStats.completed);
        this.$set(this.liveListenByEpisode, episodeId, {
          listenStats,
          completed,
          listenedSec:
            Number(signal.listenedSec) || oldEpisode.listenedSec || 0,
        });
        if (completed !== oldEpisode.completed) {
          this.snapshot = applySubscriptionUpdateCompletion(
            this.snapshot,
            episodeId,
            completed,
            this.listNow
          );
        }
      } catch (error) {
        // Keep the cached row; the next listening signal can reconcile it.
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
  align-items: flex-end;
  justify-content: space-between;
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
  min-height: 34px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 7px 12px;
  border: 0;
  border-radius: 7px;
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

.updates-tools {
  display: flex;
  min-height: 45px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.updates-segmented {
  display: inline-flex;
  padding: 3px;
  border-radius: 7px;
  background: var(--color-secondary-bg);

  button {
    min-width: 68px;
    padding: 7px 12px;
    border: 0;
    border-radius: 5px;
    color: var(--color-text-secondary);
    background: transparent;
    font-size: 13px;
    font-weight: 600;

    &.active {
      color: #fff;
      background: var(--color-primary);
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
  margin: 8px 0;
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  color: var(--color-text-secondary);
  background: var(--color-secondary-bg);
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

.updates-new-banner .svg-icon,
.updates-refresh-note .svg-icon {
  width: 15px;
  height: 15px;
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

.updates-error .secondary-action {
  margin-top: 14px;
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
  border-top: 1px solid var(--color-secondary-bg);
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
}

@keyframes updates-skeleton {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}

@media (max-width: 640px) {
  .updates-header {
    align-items: flex-start;
  }

  .updates-title h1 {
    font-size: 27px;
  }

  .updates-title p {
    max-width: 240px;
    line-height: 1.4;
  }

  .all-subscriptions-button span {
    display: none;
  }
}
</style>
