<template>
  <div class="history-page">
    <div class="head">
      <h1>收听历史</h1>
      <!-- [B-37] 只看已听完（参考小宇宙），舍弃转发/评论 -->
      <label class="finished-toggle" :class="{ on: onlyFinished }">
        <input v-model="onlyFinished" type="checkbox" />
        <span>只看已听完</span>
      </label>
    </div>

    <div v-if="!shownList.length" class="empty">
      {{ onlyFinished ? '还没有已听完的单集' : '还没有收听记录' }}
    </div>

    <div
      v-for="item in shownList"
      :key="item.id"
      class="row"
      @click="play(item)"
      @contextmenu.prevent="openMenu($event, item)"
    >
      <PodImage class="cover" :src="item.coverUrl" @error="onCoverError" />
      <div class="meta">
        <div class="t">{{ item.title }}</div>
        <div class="s">
          <span>{{ item.podcastTitle }}</span>
          <span class="dot">·</span>
          <span :class="{ done: item.completed }">{{ remainText(item) }}</span>
          <span class="dot">·</span>
          <span class="ago">{{ formatAgo(item.lastPlayedAt) }}</span>
        </div>
      </div>
      <button class="play-btn" title="继续播放" @click.stop="play(item)">
        <svg-icon icon-class="play-circle" />
      </button>
    </div>

    <!-- 右键菜单（toggle） -->
    <div
      v-if="menu.open"
      ref="menu"
      class="ctx-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
    >
      <div class="ctx-item" @click="onMenuPlay">
        <svg-icon icon-class="play-circle" />
        <span>继续播放</span>
      </div>
      <div class="ctx-item" @click="onMenuQueue">
        <svg-icon icon-class="layer-plus" />
        <span>加入播放列表</span>
      </div>
      <div class="ctx-item" @click="onMenuFav">
        <svg-icon :icon-class="isFav(menu.target) ? 'heart-solid' : 'heart'" />
        <span>{{ isFav(menu.target) ? '取消收藏' : '收藏' }}</span>
      </div>
      <div class="ctx-item" @click="goPodcast">
        <svg-icon icon-class="radio-alt" />
        <span>进入节目</span>
      </div>
    </div>
  </div>
</template>

<script>
import { getRecentlyPlayed } from '@/utils/podcast/db';
import SvgIcon from '@/components/SvgIcon.vue';

export default {
  name: 'HistoryList',
  components: { SvgIcon },
  data() {
    return {
      list: [],
      onlyFinished: false,
      menu: { open: false, x: 0, y: 0, target: null },
      menuListener: null,
    };
  },
  computed: {
    shownList() {
      return this.onlyFinished ? this.list.filter(i => i.completed) : this.list;
    },
  },
  async created() {
    await this.reload();
  },
  async activated() {
    await this.reload();
  },
  beforeDestroy() {
    this.closeMenu();
  },
  methods: {
    async reload() {
      this.list = await getRecentlyPlayed(150);
    },
    remainText(item) {
      if (item.completed) return '已听完';
      const total = item.duration || 0;
      const remain = Math.max(0, total - (item.position || 0));
      if (total <= 0) return '';
      if (remain < 60) return '即将听完';
      return `剩余 ${Math.floor(remain / 60)} 分钟`;
    },
    formatAgo(ts) {
      if (!ts) return '';
      const diff = Date.now() - ts;
      const day = 86400000;
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
      if (diff < day) return `${Math.floor(diff / 3600000)} 小时前`;
      const d = Math.floor(diff / day);
      if (d < 30) return `${d} 天前`;
      return `${Math.floor(d / 30)} 个月前`;
    },
    play(item) {
      const ep = {
        id: item.id,
        guid: item.guid || item.id.split('::').pop(),
        title: item.title,
        audioUrl: item.audioUrl,
        coverUrl: item.coverUrl,
        duration: item.duration,
        podcastId: item.podcastId,
      };
      this.$store.state.player.playPodcastEpisode(ep, item.podcastTitle || '');
    },
    isFav(item) {
      if (!item) return false;
      const ids =
        (this.$store.state.podcastFavorites &&
          this.$store.state.podcastFavorites.episodeIds) ||
        [];
      return ids.includes(item.id);
    },
    openMenu(e, item) {
      const isSame =
        this.menu.open && this.menu.target && this.menu.target.id === item.id;
      this.closeMenu();
      if (isSame) return;
      const w = 200;
      const h = 200;
      const x = Math.min(e.clientX, window.innerWidth - w - 10);
      const y = Math.min(e.clientY, window.innerHeight - h - 10);
      this.menu = { open: true, x, y, target: item };
      this.$nextTick(() => {
        this.menuListener = ev => {
          const root = this.$refs.menu;
          if (root && !root.contains(ev.target)) this.closeMenu();
        };
        document.addEventListener('click', this.menuListener);
      });
    },
    closeMenu() {
      this.menu.open = false;
      this.menu.target = null;
      if (this.menuListener) {
        document.removeEventListener('click', this.menuListener);
        this.menuListener = null;
      }
    },
    onMenuPlay() {
      const it = this.menu.target;
      this.closeMenu();
      if (it) this.play(it);
    },
    onMenuQueue() {
      const it = this.menu.target;
      this.closeMenu();
      if (!it) return;
      this.$store.dispatch('enqueueEpisode', {
        ...it,
        podcastTitle: it.podcastTitle || '',
      });
    },
    onMenuFav() {
      const it = this.menu.target;
      this.closeMenu();
      if (!it) return;
      const track = {
        id: `pod:${it.id}`,
        name: it.title,
        al: { id: 0, name: it.podcastTitle || '', picUrl: it.coverUrl || '' },
        dt: (it.duration || 0) * 1000,
        podcastAudioUrl: it.audioUrl,
        // [审操作#3] 带 podcastId(=feedUrl)，防收藏写空 → 被 prunePreviewOrphans 静默清理。
        podcastId: it.podcastId || (it.id || '').split('::')[0],
        podcastEpisodeId: it.id,
      };
      this.$store.dispatch('togglePodcastFavorite', track);
    },
    goPodcast() {
      const it = this.menu.target;
      this.closeMenu();
      if (!it || !it.podcastId) return;
      this.$router.push({
        name: 'podcastDetail',
        params: { feedUrlEncoded: encodeURIComponent(it.podcastId) },
      });
    },
    onCoverError(e) {
      e.target.style.opacity = 0;
    },
  },
};
</script>

<style lang="scss" scoped>
.history-page {
  color: var(--color-text);
  padding-top: 28px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
  h1 {
    font-size: 32px;
    font-weight: 700;
    margin: 0;
  }
}
.finished-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  opacity: 0.6;
  cursor: pointer;
  user-select: none;
  input {
    cursor: pointer;
  }
  &.on {
    opacity: 1;
    color: var(--color-primary);
  }
}
.empty {
  text-align: center;
  opacity: 0.4;
  padding: 80px 0;
  font-size: 14px;
}
.row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 8px;
  border-radius: 10px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
  .cover {
    width: 56px;
    height: 56px;
    border-radius: var(--radius-cover-sm);
    object-fit: cover;
    background: var(--color-secondary-bg);
    flex-shrink: 0;
  }
  .meta {
    flex: 1;
    min-width: 0;
    .t {
      font-weight: 600;
      font-size: 15px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .s {
      font-size: 12px;
      opacity: 0.6;
      margin-top: 3px;
      display: flex;
      align-items: center;
      gap: 5px;
      overflow: hidden;
      white-space: nowrap;
      .dot {
        opacity: 0.5;
      }
      .done {
        color: #27ae60;
        opacity: 1;
      }
      .ago {
        flex-shrink: 0;
      }
    }
  }
  .play-btn {
    background: transparent;
    color: var(--color-text);
    opacity: 0.5;
    padding: 8px;
    border-radius: 50%;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: 0.15s;
    .svg-icon {
      width: 20px;
      height: 20px;
    }
    &:hover {
      opacity: 1;
      color: var(--color-primary);
      background: var(--color-secondary-bg-for-transparent);
    }
  }
}

// 右键菜单
.ctx-menu {
  position: fixed;
  z-index: 200;
  min-width: 168px;
  background: var(--color-body-bg);
  color: var(--color-text);
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.2),
    0 0 0 1px var(--color-secondary-bg-for-transparent);
}
.ctx-item {
  padding: 9px 12px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
  transition: 0.15s;
  .svg-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
}
</style>
