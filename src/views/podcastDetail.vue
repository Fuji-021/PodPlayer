<template>
  <div v-show="podcast" class="podcast-detail-page">
    <div v-if="podcast" class="podcast-detail">
      <img class="cover-lg" :src="podcast.coverUrl" @error="onCoverError" />
      <div class="meta">
        <div class="t">{{ podcast.title }}</div>
        <div class="a">{{ podcast.author }}</div>
        <div class="d">{{ podcast.description }}</div>
      </div>
      <!-- [B-25] 取消订阅按钮挪到节目信息行最右边 -->
      <div class="actions">
        <button class="unsubscribe-btn" @click="confirmUnsubscribe">
          <svg-icon icon-class="heart-crack" />
          <span>取消订阅</span>
        </button>
      </div>
    </div>

    <div class="episode-list">
      <div
        v-for="ep in episodes"
        :key="ep.id"
        class="episode-row"
        @click="goEpisodeDetail(ep)"
        @contextmenu.prevent="openEpisodeMenu($event, ep)"
      >
        <div class="ep-main">
          <div class="ep-title">{{ ep.title }}</div>
          <div class="ep-sub">
            <span>{{ formatDate(ep.pubDate) }}</span>
            <!-- [C-4] 时长 / 剩余 / 已听完 -->
            <span
              v-if="ep.duration"
              class="ep-prog"
              :class="{ done: isFinished(ep) }"
            >
              · {{ formatProgressLabel(ep) }}
            </span>
          </div>
        </div>
        <!-- [S-3] 三点冒号入口（替代 ⓘ）：弹"加入播放列表/收藏/下载"菜单 -->
        <button class="ep-menu-btn" @click.stop="openEpisodeMenu($event, ep)">
          <svg-icon icon-class="menu-dots-vertical" />
        </button>
      </div>
    </div>

    <!-- [S-3] 单集操作菜单（贴触发点） -->
    <div
      v-if="episodeMenu.open"
      ref="episodeMenu"
      class="ep-ctx-menu"
      :style="{ left: episodeMenu.x + 'px', top: episodeMenu.y + 'px' }"
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
      <div class="ctx-item" @click="onMenuFavorite">
        <svg-icon
          :icon-class="
            isFavorited(episodeMenu.target) ? 'heart-solid' : 'heart'
          "
        />
        <span>{{ isFavorited(episodeMenu.target) ? '取消收藏' : '收藏' }}</span>
      </div>
      <div class="ctx-item" @click="onMenuDownload">
        <svg-icon icon-class="download" />
        <span>下载</span>
      </div>
    </div>

    <!-- [播客改造] 取消订阅确认弹窗（替换原系统 confirm 弹窗，与软件风格一致） -->
    <div
      v-if="showConfirmUnsub"
      class="dialog-mask"
      @click.self="showConfirmUnsub = false"
    >
      <div class="confirm-dialog">
        <div class="title">取消订阅</div>
        <div class="msg">
          确定要取消订阅 <b>"{{ podcast && podcast.title }}"</b> 吗？<br />
          单集历史进度不会被删除。
        </div>
        <div class="actions">
          <button class="btn-secondary" @click="showConfirmUnsub = false">
            取消
          </button>
          <button class="btn-danger" @click="doUnsubscribe">
            确定取消订阅
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import {
  getPodcast,
  getEpisodesByPodcast,
  deletePodcast,
} from '@/utils/podcast/service';
import { getEpisodeProgress } from '@/utils/podcast/db';
import SvgIcon from '@/components/SvgIcon.vue';

export default {
  name: 'PodcastDetail',
  components: { SvgIcon },
  data() {
    return {
      podcast: null,
      episodes: [],
      showConfirmUnsub: false,
      // [S-3] 单集菜单
      episodeMenu: { open: false, x: 0, y: 0, target: null },
      episodeMenuOutsideListener: null,
    };
  },
  computed: {
    feedUrl() {
      return decodeURIComponent(this.$route.params.feedUrlEncoded || '');
    },
  },
  watch: {
    // 路由切换到另一档节目时重新加载
    feedUrl: {
      immediate: true,
      handler(v) {
        if (v) this.load();
      },
    },
  },
  methods: {
    async load() {
      this.podcast = await getPodcast(this.feedUrl);
      if (!this.podcast) {
        // 节目不存在（被删了或 URL 错），回订阅列表
        this.$router.replace('/library');
        return;
      }
      const eps = await getEpisodesByPodcast(this.feedUrl);
      // [C-4] 并行读取每集播放进度
      const progresses = await Promise.all(
        eps.map(ep => getEpisodeProgress(ep.id).catch(() => null))
      );
      this.episodes = eps.map((ep, i) => ({
        ...ep,
        listenedSec: (progresses[i] && progresses[i].position) || 0,
      }));
    },
    playEpisode(ep) {
      const title = this.podcast ? this.podcast.title : '';
      this.$store.state.player.playPodcastEpisode(ep, title);
    },
    // [S-3] 单集菜单
    openEpisodeMenu(e, ep) {
      const w = 200;
      const h = 184;
      const x = Math.min(e.clientX, window.innerWidth - w - 10);
      const y = Math.min(e.clientY, window.innerHeight - h - 10);
      this.episodeMenu = { open: true, x, y, target: ep };
      this.$nextTick(() => {
        this.episodeMenuOutsideListener = ev => {
          const root = this.$refs.episodeMenu;
          if (root && !root.contains(ev.target)) this.closeEpisodeMenu();
        };
        document.addEventListener('mousedown', this.episodeMenuOutsideListener);
      });
    },
    closeEpisodeMenu() {
      this.episodeMenu.open = false;
      this.episodeMenu.target = null;
      if (this.episodeMenuOutsideListener) {
        document.removeEventListener(
          'mousedown',
          this.episodeMenuOutsideListener
        );
        this.episodeMenuOutsideListener = null;
      }
    },
    onMenuPlay() {
      const ep = this.episodeMenu.target;
      this.closeEpisodeMenu();
      if (ep) this.playEpisode(ep);
    },
    onMenuQueue() {
      this.closeEpisodeMenu();
      this.$store.dispatch('showToast', '播放列表功能即将上线');
    },
    onMenuFavorite() {
      const ep = this.episodeMenu.target;
      this.closeEpisodeMenu();
      if (!ep) return;
      // 拼一个 track-like 对象给收藏 action
      const title = (this.podcast && this.podcast.title) || '';
      const track = {
        id: `pod:${ep.id}`,
        name: ep.title,
        al: {
          id: 0,
          name: title,
          picUrl: ep.coverUrl || '',
        },
        dt: (ep.duration || 0) * 1000,
        podcastAudioUrl: ep.audioUrl,
        podcastEpisodeId: ep.id,
      };
      this.$store.dispatch('togglePodcastFavorite', track);
    },
    onMenuDownload() {
      this.closeEpisodeMenu();
      this.$store.dispatch('showToast', '下载功能即将上线');
    },
    // [S-3] 当前 episode 是否已收藏
    isFavorited(ep) {
      if (!ep) return false;
      const ids =
        (this.$store.state.podcastFavorites &&
          this.$store.state.podcastFavorites.episodeIds) ||
        [];
      return ids.includes(ep.id);
    },
    // [C-5] 进单集详情页
    goEpisodeDetail(ep) {
      this.$router.push({
        name: 'episodeDetail',
        params: {
          feedUrlEncoded: encodeURIComponent(this.feedUrl),
          guidEncoded: encodeURIComponent(ep.guid),
        },
      });
    },
    // [C-4] 单集状态
    isFinished(ep) {
      const total = ep.duration || 0;
      const listened = ep.listenedSec || 0;
      return total > 0 && listened >= total - 30;
    },
    formatProgressLabel(ep) {
      const total = ep.duration || 0;
      const listened = ep.listenedSec || 0;
      if (this.isFinished(ep)) return '已听完';
      if (listened > 30) return `剩余 ${this.formatDuration(total - listened)}`;
      return this.formatDuration(total);
    },
    confirmUnsubscribe() {
      this.showConfirmUnsub = true;
    },
    async doUnsubscribe() {
      if (!this.podcast) return;
      await deletePodcast(this.podcast.id);
      this.showConfirmUnsub = false;
      this.$store.dispatch('showToast', '已取消订阅');
      // 回订阅列表（用 replace 避免历史栈里残留已删除节目的页面）
      this.$router.replace('/library');
    },
    formatDate(s) {
      if (!s) return '';
      const d = new Date(s);
      if (isNaN(d.getTime())) return s;
      return d.toLocaleDateString('zh-CN');
    },
    formatDuration(sec) {
      sec = Number(sec) || 0;
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(
          2,
          '0'
        )}`;
      }
      return `${m}:${String(s).padStart(2, '0')}`;
    },
    onCoverError(e) {
      e.target.style.opacity = 0;
    },
  },
};
</script>

<style lang="scss" scoped>
.podcast-detail-page {
  color: var(--color-text);
  // [bug] 详情页没有顶部 .header（与播客库一级界面相比少了"播客库"标题），
  // 内容直接顶到 navbar 下沿太紧。补一点上边距。
  padding-top: 28px;
}
.podcast-detail {
  display: flex;
  gap: 24px;
  margin-bottom: 32px;
  align-items: flex-start;
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
  // [B-25] 取消订阅按钮在右上
  .actions {
    flex-shrink: 0;
  }
}
.unsubscribe-btn {
  background: transparent;
  color: var(--color-text);
  opacity: 0.55;
  border-radius: 8px;
  padding: 6px 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  transition: 0.15s;
  .svg-icon {
    width: 16px;
    height: 16px;
  }
  &:hover {
    opacity: 1;
    background: rgba(231, 76, 60, 0.12);
    color: #e74c3c;
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
  display: flex;
  align-items: center;
  gap: 12px;
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
    padding-left: 12px;
  }
  .ep-main {
    flex: 1;
    min-width: 0;
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
    gap: 4px;
  }
  // [C-4] 时长/剩余/已听完
  .ep-prog {
    &.done {
      color: #27ae60;
      opacity: 1;
      font-weight: 600;
    }
  }
  // [S-3] 三点冒号按钮
  .ep-menu-btn {
    background: transparent;
    color: var(--color-text);
    opacity: 0.4;
    padding: 8px;
    border-radius: 50%;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: 0.15s;
    flex-shrink: 0;
    .svg-icon {
      width: 18px;
      height: 18px;
    }
    &:hover {
      opacity: 1;
      background: var(--color-secondary-bg-for-transparent);
      color: var(--color-primary);
    }
  }
}

// 确认弹窗
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
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
// [S-3] 单集操作弹出菜单
.ep-ctx-menu {
  position: fixed;
  z-index: 220;
  background: var(--color-body-bg);
  color: var(--color-text);
  border-radius: 10px;
  padding: 4px;
  width: 200px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22),
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
