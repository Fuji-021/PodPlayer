<template>
  <div class="favorites-page">
    <h1>我的收藏</h1>
    <div v-if="!list.length" class="empty">还没有收藏的单集</div>
    <div
      v-for="item in list"
      :key="item.id"
      class="row"
      @click="play(item)"
      @contextmenu.prevent="openMenu($event, item)"
    >
      <PodImage class="cover" :src="item.coverUrl" @error="onCoverError" />
      <div class="meta">
        <div class="t">{{ item.title }}</div>
        <div class="s">{{ item.podcastTitle }}</div>
      </div>
      <!-- [B-33] 专属页：单集右边只显示「已收藏」状态按钮（点击取消收藏） -->
      <button class="unfav" title="取消收藏" @click.stop="unfav(item)">
        <svg-icon icon-class="heart-solid" />
      </button>
    </div>

    <!-- [B-33] 右键菜单（toggle：再次右键关闭） -->
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
      <div class="ctx-item danger" @click="onMenuUnfav">
        <svg-icon icon-class="heart-crack" />
        <span>取消收藏</span>
      </div>
    </div>
  </div>
</template>

<script>
import { getAllFavorites } from '@/utils/podcast/db';
import SvgIcon from '@/components/SvgIcon.vue';

export default {
  name: 'FavoritesList',
  components: { SvgIcon },
  data() {
    return {
      list: [],
      menu: { open: false, x: 0, y: 0, target: null },
      menuListener: null,
    };
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
      this.list = await getAllFavorites();
    },
    // [B-33] 右键菜单 toggle
    openMenu(e, item) {
      const isSame =
        this.menu.open && this.menu.target && this.menu.target.id === item.id;
      this.closeMenu();
      if (isSame) return;
      const w = 200;
      const h = 160;
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
        id: it.id,
        guid: it.id.split('::').pop(),
        title: it.title,
        audioUrl: it.audioUrl,
        coverUrl: it.coverUrl,
        duration: it.duration,
        podcastId: it.podcastId,
        podcastTitle: it.podcastTitle || '',
      });
    },
    async onMenuUnfav() {
      const it = this.menu.target;
      this.closeMenu();
      if (it) await this.unfav(it);
    },
    play(item) {
      const ep = {
        id: item.id,
        guid: item.id.split('::').pop(),
        title: item.title,
        audioUrl: item.audioUrl,
        coverUrl: item.coverUrl,
        duration: item.duration,
        podcastId: item.podcastId,
      };
      this.$store.state.player.playPodcastEpisode(ep, item.podcastTitle || '');
    },
    async unfav(item) {
      // 复用 toggle action，构造 track 对象
      const track = {
        id: `pod:${item.id}`,
        name: item.title,
        al: {
          id: 0,
          name: item.podcastTitle || '',
          picUrl: item.coverUrl || '',
        },
        dt: (item.duration || 0) * 1000,
        podcastAudioUrl: item.audioUrl,
        // [审操作#3] 带 podcastId(=feedUrl)，与其它入口一致(此处为取消收藏、不写入，仅防御性补全)。
        podcastId: item.podcastId || (item.id || '').split('::')[0],
        podcastEpisodeId: item.id,
      };
      await this.$store.dispatch('togglePodcastFavorite', track);
      await this.reload();
    },
    onCoverError(e) {
      e.target.style.opacity = 0;
    },
  },
};
</script>

<style lang="scss" scoped>
.favorites-page {
  color: var(--color-text);
  padding-top: 28px;
}
h1 {
  font-size: 32px;
  font-weight: 700;
  margin-bottom: 24px;
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
    }
  }
  .unfav {
    background: transparent;
    color: #e74c3c;
    padding: 8px;
    border-radius: 50%;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    .svg-icon {
      width: 18px;
      height: 18px;
    }
    &:hover {
      background: rgba(231, 76, 60, 0.12);
    }
  }
}

// [B-33] 右键菜单
.ctx-menu {
  position: fixed;
  z-index: 200;
  min-width: 168px;
  background: var(--color-body-bg);
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
  &.danger {
    color: #e74c3c;
    &:hover {
      background: rgba(231, 76, 60, 0.12);
    }
  }
}
</style>
