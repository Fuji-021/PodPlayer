<template>
  <!-- [B-52] 播客搜索结果页：本地（我的订阅/单集）+ 在线发现（iTunes） -->
  <div class="search-podcast">
    <h1 class="sp-title">搜索 “{{ keywords }}”</h1>

    <!-- 本地：已订阅节目 -->
    <section v-if="localPods.length" class="sp-section">
      <div class="sp-head">我的订阅</div>
      <div class="sp-grid">
        <div
          v-for="p in localPods"
          :key="p.id"
          class="local-card"
          @click="openLocalPodcast(p)"
        >
          <div class="lc-cover-box">
            <div
              class="lc-shadow"
              :style="{ backgroundImage: `url(${p.coverUrl})` }"
            ></div>
            <img class="lc-cover" :src="p.coverUrl" @error="onImgErr" />
          </div>
          <div class="lc-name">{{ p.title }}</div>
        </div>
      </div>
    </section>

    <!-- 本地：单集（标准单集卡片：节目封面 + 节目名·日期·时长(状态点) + 播放/更多 + 右键菜单） -->
    <section v-if="localEps.length" class="sp-section">
      <div class="sp-head">单集</div>
      <div class="ep-list">
        <div
          v-for="ep in localEps"
          :key="ep.id"
          class="ep-row"
          @click="onRowClick(ep)"
          @contextmenu.prevent="openMenu($event, ep)"
        >
          <!-- 左侧=节目封面(非单集封面，便于认出来源)；卡片整体已有动作反馈，封面不再单独加光晕 -->
          <PodImage
            class="ep-cover"
            :src="ep.podcastCoverUrl"
            @error="onImgErr"
          />
          <div class="ep-meta">
            <div class="ep-t">{{ ep.title }}</div>
            <div class="ep-s">
              <span class="ep-pod">{{ ep.podcastTitle }}</span>
              <!-- 分隔点 call back 状态点：绿=已订阅 / 黄=听过 -->
              <span class="ep-dot" :class="dotClass(ep)"></span>
              <span>{{ formatDate(ep) }}</span>
              <template v-if="ep.duration">
                <span class="sep">·</span>
                <span>{{ formatDuration(ep.duration) }}</span>
              </template>
            </div>
          </div>
          <button class="ep-act" title="立即播放" @click.stop="playEpisode(ep)">
            <svg-icon icon-class="play-circle" />
          </button>
          <button
            class="ep-act"
            title="更多"
            @click.stop="openMenu($event, ep)"
          >
            <svg-icon icon-class="menu-dots-vertical" />
          </button>
        </div>
      </div>
    </section>

    <!-- 在线发现 -->
    <section class="sp-section">
      <div class="sp-head">在线发现</div>
      <div v-if="loadingOnline" class="sp-state">正在搜索在线播客…</div>
      <div v-else-if="errorOnline" class="sp-state">{{ errorOnline }}</div>
      <div v-else-if="!onlineItems.length" class="sp-state">
        没有找到相关播客
      </div>
      <div v-else class="sp-grid">
        <DiscoverCard v-for="p in onlineItems" :key="p.id" :podcast="p" />
      </div>
    </section>

    <!-- [B-63] 单集右键菜单（与其它页一致） -->
    <div
      v-if="menu.open"
      ref="menu"
      class="ctx-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
    >
      <div class="ctx-item" @click="onMenuPlay">
        <svg-icon icon-class="play-circle" />
        <span>立即播放</span>
      </div>
      <div class="ctx-item" @click="onMenuQueue">
        <svg-icon icon-class="layer-plus" />
        <span>加入播放列表</span>
      </div>
      <div class="ctx-item" @click="onMenuFav">
        <svg-icon :icon-class="isFav(menu.target) ? 'heart-solid' : 'heart'" />
        <span>{{ isFav(menu.target) ? '取消收藏' : '收藏' }}</span>
      </div>
      <div class="ctx-item" @click="onMenuGoPodcast">
        <svg-icon icon-class="radio-alt" />
        <span>进入节目</span>
      </div>
    </div>
  </div>
</template>

<script>
import { mapState } from 'vuex';
import { searchPodcasts } from '@/utils/podcast/discover';
import { searchLocalPodcasts, searchLocalEpisodes } from '@/utils/podcast/db';
import { getListenStatsBulk } from '@/utils/podcast/listening';
import DiscoverCard from '@/components/DiscoverCard.vue';
import SvgIcon from '@/components/SvgIcon.vue';

export default {
  name: 'SearchPodcast',
  components: { DiscoverCard, SvgIcon },
  data() {
    return {
      localPods: [],
      localEps: [],
      onlineItems: [],
      loadingOnline: false,
      errorOnline: '',
      // [B-63] 单集右键菜单
      menu: { open: false, x: 0, y: 0, target: null },
      menuListener: null,
    };
  },
  computed: {
    ...mapState(['player']),
    keywords() {
      return this.$route.params.keywords || '';
    },
  },
  watch: {
    keywords: {
      immediate: true,
      handler() {
        this.doSearch();
      },
    },
  },
  beforeDestroy() {
    this.closeMenu();
  },
  methods: {
    async doSearch() {
      const kw = this.keywords;
      // [B] 防竞态：记录本次搜索关键词，旧响应回来后若已切词则丢弃
      const myKw = this.keywords;
      if (!kw) return;
      // 本地（快）：已订阅节目 + 单集标题
      try {
        const [pods, eps] = await Promise.all([
          searchLocalPodcasts(kw).catch(() => []),
          searchLocalEpisodes(kw).catch(() => []),
        ]);
        if (this.keywords !== myKw) return;
        this.localPods = pods;
        // [B-63] 标记每集"听过"状态（供状态点显黄色）
        try {
          const stats = await getListenStatsBulk(eps.map(e => e.id));
          eps.forEach((e, i) => {
            const s = stats[i];
            e._listened = !!(s && (s.completed || (s.listenedSec || 0) > 0));
          });
        } catch (err) {
          /* 忽略：拿不到统计不影响列表 */
        }
        if (this.keywords !== myKw) return;
        this.localEps = eps;
      } catch (e) {
        if (this.keywords !== myKw) return;
        this.localPods = [];
        this.localEps = [];
      }
      // 在线（慢）：iTunes Search
      this.loadingOnline = true;
      this.errorOnline = '';
      this.onlineItems = [];
      try {
        const items = await searchPodcasts(kw);
        if (this.keywords !== myKw) return;
        this.onlineItems = items;
      } catch (e) {
        if (this.keywords !== myKw) return;
        this.errorOnline = '在线搜索失败：' + ((e && e.message) || e);
      } finally {
        if (this.keywords === myKw) this.loadingOnline = false;
      }
    },
    openLocalPodcast(p) {
      this.$router.push({
        name: 'podcastDetail',
        params: { feedUrlEncoded: encodeURIComponent(p.id) },
      });
    },
    onRowClick(ep) {
      // [B] 右键菜单打开时左键点行只关菜单，不误播
      if (this.menu.open) {
        this.closeMenu();
        return;
      }
      this.playEpisode(ep);
    },
    playEpisode(ep) {
      if (this.player && this.player.playPodcastEpisode) {
        this.player.playPodcastEpisode(ep, ep.podcastTitle);
      }
    },
    onImgErr(e) {
      e.target.style.opacity = 0.15;
    },
    // [B-63] 状态点：黄=听过 / 绿=已订阅 / 默认灰
    dotClass(ep) {
      if (ep._listened) return 'listened';
      if (ep.podcastSubscribed) return 'subbed';
      return '';
    },
    formatDate(ep) {
      const val = ep.pubDate || ep.pubTime;
      if (!val) return '';
      const d = new Date(val);
      if (isNaN(d.getTime())) return '';
      const m = d.getMonth() + 1;
      const day = d.getDate();
      return d.getFullYear() === new Date().getFullYear()
        ? `${m}月${day}日`
        : `${d.getFullYear()}年${m}月${day}日`;
    },
    formatDuration(sec) {
      sec = Math.floor(Number(sec) || 0);
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      if (h > 0) return m > 0 ? `${h}时${m}分` : `${h}时`;
      if (m > 0) return `${m}分钟`;
      return `${sec}秒`;
    },
    isFav(ep) {
      if (!ep) return false;
      const ids =
        (this.$store.state.podcastFavorites &&
          this.$store.state.podcastFavorites.episodeIds) ||
        [];
      return ids.includes(ep.id);
    },
    openMenu(e, ep) {
      const same =
        this.menu.open && this.menu.target && this.menu.target.id === ep.id;
      this.closeMenu();
      if (same) return;
      const w = 200;
      const h = 190;
      const x = Math.min(e.clientX, window.innerWidth - w - 10);
      const y = Math.min(e.clientY, window.innerHeight - h - 10);
      this.menu = { open: true, x, y, target: ep };
      this.$nextTick(() => {
        this.menuListener = ev => {
          const root = this.$refs.menu;
          if (root && !root.contains(ev.target)) this.closeMenu();
        };
        document.addEventListener('click', this.menuListener);
        // [D] 空白处再次右键也能关闭菜单
        document.addEventListener('contextmenu', this.menuListener);
      });
    },
    closeMenu() {
      this.menu.open = false;
      this.menu.target = null;
      if (this.menuListener) {
        document.removeEventListener('click', this.menuListener);
        document.removeEventListener('contextmenu', this.menuListener);
        this.menuListener = null;
      }
    },
    onMenuPlay() {
      const it = this.menu.target;
      this.closeMenu();
      if (it) this.playEpisode(it);
    },
    onMenuQueue() {
      const it = this.menu.target;
      this.closeMenu();
      if (!it) return;
      this.$store.dispatch('enqueueEpisode', {
        ...it,
        podcastTitle: it.podcastTitle || '',
      });
      // [E] enqueueEpisode action 内部已 toast，不再手动重复
    },
    onMenuFav() {
      const it = this.menu.target;
      this.closeMenu();
      if (!it) return;
      const track = {
        id: `pod:${it.id}`,
        name: it.title,
        al: {
          id: 0,
          name: it.podcastTitle || '',
          picUrl: it.podcastCoverUrl || it.coverUrl || '',
        },
        dt: (it.duration || 0) * 1000,
        podcastAudioUrl: it.audioUrl,
        // [审操作#3] 带 podcastId(=feedUrl)，防收藏写空 → 被 prunePreviewOrphans 静默清理。
        podcastId: it.podcastId || (it.id || '').split('::')[0],
        podcastEpisodeId: it.id,
      };
      this.$store.dispatch('togglePodcastFavorite', track);
    },
    onMenuGoPodcast() {
      const it = this.menu.target;
      this.closeMenu();
      if (!it || !it.podcastId) return;
      this.$router.push({
        name: 'podcastDetail',
        params: { feedUrlEncoded: encodeURIComponent(it.podcastId) },
      });
    },
  },
};
</script>

<style lang="scss" scoped>
.search-podcast {
  color: var(--color-text);
  padding-top: 28px;
  animation: spEnter 0.3s ease;
}
@keyframes spEnter {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.sp-title {
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 24px;
}
.sp-section {
  margin-bottom: 32px;
}
.sp-head {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 14px;
  opacity: 0.85;
}
.sp-state {
  opacity: 0.5;
  font-size: 14px;
  padding: 24px 0;
}
.sp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 24px;
}
// 本地已订阅卡片（含虚化光晕，与发现页一致观感）
.local-card {
  cursor: pointer;
  &:hover .lc-cover-box {
    transform: translateY(-4px) scale(1.02);
  }
  .lc-cover-box {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1;
    transition: transform 0.25s;
  }
  .lc-shadow {
    position: absolute;
    left: 0;
    top: 12px;
    width: 100%;
    height: 100%;
    border-radius: 12px;
    background-size: cover;
    background-position: center;
    filter: blur(16px) opacity(0.45);
    transform: scale(0.92);
    z-index: 0;
  }
  .lc-cover {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: var(--radius-cover);
    object-fit: cover;
    background: var(--color-secondary-bg);
    z-index: 1;
  }
  .lc-name {
    margin-top: 10px;
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
// [B-63] 标准单集卡片：节目封面 + 标题 + 节目名·状态点·日期·时长 + 播放/更多
.ep-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ep-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s;
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
  .ep-cover {
    width: 48px;
    height: 48px;
    border-radius: 8px;
    object-fit: cover;
    flex-shrink: 0;
    background: var(--color-secondary-bg);
  }
  .ep-meta {
    flex: 1;
    min-width: 0;
  }
  .ep-t {
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ep-s {
    font-size: 12px;
    opacity: 0.6;
    margin-top: 3px;
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    overflow: hidden;
    .ep-pod {
      min-width: 0;
      max-width: 50%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sep {
      opacity: 0.5;
    }
  }
  // 状态点：call back 来源点设计（绿=已订阅 / 黄=听过 / 默认灰）
  .ep-dot {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-text);
    opacity: 0.3;
    &.subbed {
      background: #27ae60;
      opacity: 1;
    }
    &.listened {
      background: #f1c40f;
      opacity: 1;
    }
  }
  // 常驻播放 + 更多
  .ep-act {
    flex-shrink: 0;
    background: transparent;
    color: var(--color-text);
    opacity: 0.55;
    cursor: pointer;
    padding: 5px;
    border-radius: 50%;
    display: inline-flex;
    transition: opacity 0.15s, background 0.15s;
    .svg-icon {
      width: 20px;
      height: 20px;
    }
    &:hover {
      opacity: 1;
      background: var(--color-secondary-bg-for-transparent);
    }
  }
}
// [B-63] 单集右键菜单（与详情页同款）
.ctx-menu {
  position: fixed;
  z-index: 220;
  background: var(--color-body-bg);
  border-radius: 10px;
  padding: 4px;
  width: 180px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22),
    0 0 0 1px var(--color-secondary-bg-for-transparent);
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 7px;
  font-size: 13px;
  cursor: pointer;
  color: var(--color-text);
  .svg-icon {
    width: 16px;
    height: 16px;
    opacity: 0.8;
  }
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
}
</style>
