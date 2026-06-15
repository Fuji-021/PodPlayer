<template>
  <div class="downloads-page">
    <h1>我的下载</h1>
    <div v-if="!list.length" class="empty">还没有下载的单集</div>
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
      <!-- [B-33] 专属页：单集右边只显示「已下载」状态按钮（点击删除） -->
      <button
        v-tip="'已下载（点击删除）'"
        class="dl-btn"
        @click.stop="askDelete(item)"
      >
        <svg-icon icon-class="check-circle" />
      </button>
    </div>

    <!-- [B-35] 正在下载区：最新已下载的下方；复用单集背景进度条 -->
    <div v-if="downloadingItems.length" class="downloading-section">
      <div class="section-head">正在下载（{{ downloadingItems.length }}）</div>
      <div
        v-for="item in downloadingItems"
        :key="'dl-' + item.id"
        class="row downloading"
      >
        <div
          class="dl-progress-bg"
          :style="{ width: dlPercent(item) + '%' }"
        ></div>
        <PodImage class="cover" :src="item.coverUrl" @error="onCoverError" />
        <div class="meta">
          <div class="t">{{ item.title }}</div>
          <div class="s"
            >{{ item.podcastTitle }} · {{ dlPercentText(item) }}</div
          >
        </div>
      </div>
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
      <div class="ctx-item" @click="onMenuFav">
        <svg-icon :icon-class="isFav(menu.target) ? 'heart-solid' : 'heart'" />
        <span>{{ isFav(menu.target) ? '取消收藏' : '收藏' }}</span>
      </div>
      <div class="ctx-item danger" @click="onMenuDelete">
        <svg-icon icon-class="trash" />
        <span>删除下载</span>
      </div>
    </div>

    <!-- 删除确认弹窗 -->
    <div v-if="delTarget" class="dialog-mask" @click.self="delTarget = null">
      <div class="confirm-dialog">
        <div class="title">删除下载</div>
        <div class="msg">
          确定要删除已下载的
          <b>"{{ delTarget.title }}"</b>
          吗？<br />本地音频文件会被删除，单集听过的进度不会被删除。
        </div>
        <div class="actions">
          <button class="btn-secondary" @click="delTarget = null">取消</button>
          <button class="btn-danger" @click="confirmDelete">确定删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import {
  getDownloadedEpisodes,
  getDownloadingEpisodes,
  removeDownload,
} from '@/utils/podcast/downloads';
import SvgIcon from '@/components/SvgIcon.vue';

export default {
  name: 'DownloadsList',
  components: { SvgIcon },
  data() {
    return {
      list: [],
      // [B-35] 正在下载列表（最新已下载的下方）
      downloadingItems: [],
      menu: { open: false, x: 0, y: 0, target: null },
      menuListener: null,
      delTarget: null,
    };
  },
  watch: {
    // [B-35] 下载进度/项变化 → 刷新「正在下载」区；完成（doneIds 变）→ 刷新已下载区
    '$store.state.podcastDownloads.progressMap'() {
      this.refreshDownloading();
    },
    '$store.state.podcastDownloads.doneIds'() {
      this.reload();
    },
  },
  async created() {
    await this.reload();
    await this.refreshDownloading();
  },
  async activated() {
    await this.reload();
    await this.refreshDownloading();
  },
  beforeDestroy() {
    this.closeMenu();
  },
  methods: {
    async reload() {
      this.list = await getDownloadedEpisodes();
    },
    async refreshDownloading() {
      this.downloadingItems = await getDownloadingEpisodes();
    },
    // [B-35] 下载百分比（响应式读 store.progressMap）
    dlPercent(item) {
      const map =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.progressMap) ||
        {};
      const p = map[item.id];
      if (!p) return 0;
      if (!p.bytesTotal) return 2;
      return Math.max(2, Math.min(99, (p.bytesDone / p.bytesTotal) * 100));
    },
    dlPercentText(item) {
      const map =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.progressMap) ||
        {};
      const p = map[item.id];
      if (!p || !p.bytesTotal) return '下载中…';
      return Math.floor((p.bytesDone / p.bytesTotal) * 100) + '%';
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
    // [B-33] 右键菜单 toggle
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
      this.toggleFav(it);
    },
    toggleFav(item) {
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
        // [审操作#3] 带 podcastId(=feedUrl)，防收藏写空 → 被 prunePreviewOrphans 静默清理。
        podcastId: item.podcastId || (item.id || '').split('::')[0],
        podcastEpisodeId: item.id,
      };
      this.$store.dispatch('togglePodcastFavorite', track);
    },
    onMenuDelete() {
      const it = this.menu.target;
      this.closeMenu();
      if (it) this.askDelete(it);
    },
    askDelete(item) {
      this.delTarget = item;
    },
    async confirmDelete() {
      const it = this.delTarget;
      this.delTarget = null;
      if (!it) return;
      await removeDownload(it.id);
      this.$store.dispatch('showToast', '已删除下载');
      await this.reload();
    },
    onCoverError(e) {
      e.target.style.opacity = 0;
    },
  },
};
</script>

<style lang="scss" scoped>
.downloads-page {
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
  .dl-btn {
    background: transparent;
    color: #27ae60;
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
      background: rgba(231, 76, 60, 0.12);
      color: #e74c3c;
    }
  }
}

// [B-35] 正在下载区
.downloading-section {
  margin-top: 18px;
  .section-head {
    font-size: 13px;
    font-weight: 700;
    opacity: 0.55;
    padding: 6px 8px;
    border-top: 1px solid var(--color-secondary-bg);
    margin-top: 6px;
  }
  .row.downloading {
    position: relative;
    overflow: hidden;
    cursor: default;
    &:hover {
      background: transparent;
    }
    // 复用单集背景进度条：弱视觉灰色，从左往右
    .dl-progress-bg {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 0%;
      background: rgba(128, 128, 128, 0.18);
      pointer-events: none;
      transition: width 0.4s ease-out;
      z-index: 0;
    }
    .cover,
    .meta {
      position: relative;
      z-index: 1;
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

// 删除确认弹窗
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}
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
.btn-secondary {
  background: var(--color-secondary-bg);
  color: var(--color-text);
  padding: 8px 16px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    background: var(--color-primary-bg-for-transparent);
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
</style>
