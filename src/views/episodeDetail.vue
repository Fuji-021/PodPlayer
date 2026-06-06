<template>
  <div v-show="episode" class="episode-detail-page">
    <div v-if="episode" class="ep-header">
      <img
        v-if="episode.coverUrl"
        class="cover"
        :src="episode.coverUrl"
        @error="onCoverError"
      />
      <div class="meta">
        <div class="podcast-name" @click="goPodcast">
          {{ podcast && podcast.title }}
        </div>
        <h1 class="title">{{ episode.title }}</h1>
        <div class="sub">
          <span>{{ formatDate(episode.pubDate) }}</span>
          <span v-if="episode.duration"
            >· {{ formatDuration(episode.duration) }}</span
          >
          <span v-if="progressLabel" class="prog">· {{ progressLabel }}</span>
        </div>
        <div class="actions">
          <!-- [S-3] 主播放 button：play-circle 大按钮 -->
          <button class="play-btn" @click="play">
            <svg-icon icon-class="play-circle" />
            <span>{{ resumeAvailable ? '继续播放' : '立即播放' }}</span>
          </button>
          <!-- [S-3] 三个小入口：收藏 / 下载 / 加入播放列表 -->
          <button class="mini-btn" :class="{ favorited: isFav }" @click="onFav">
            <svg-icon :icon-class="isFav ? 'heart-solid' : 'heart'" />
          </button>
          <button class="mini-btn" @click="onQueue">
            <svg-icon icon-class="layer-plus" />
          </button>
          <button class="mini-btn" @click="onDownload">
            <svg-icon icon-class="download" />
          </button>
          <a
            v-if="episode.link"
            class="link-btn"
            :href="episode.link"
            target="_blank"
            rel="noopener noreferrer"
          >
            原文链接
          </a>
        </div>
      </div>
    </div>

    <div v-if="episode" class="notes">
      <!-- eslint-disable-next-line vue/no-v-html
           sanitizeHtml 已经清洗了 RSS description（白名单 tag + 移除 on* + 强制 http 协议） -->
      <div v-if="sanitizedDescription" v-html="sanitizedDescription"></div>
      <div v-else class="empty">这一集没有提供 show notes / 节目简介。</div>
    </div>
  </div>
</template>

<script>
import { getPodcast, getEpisode, getEpisodeProgress } from '@/utils/podcast/db';
import { sanitizeHtml } from '@/utils/podcast/sanitizeHtml';
import SvgIcon from '@/components/SvgIcon.vue';

export default {
  name: 'EpisodeDetail',
  components: { SvgIcon },
  data() {
    return {
      podcast: null,
      episode: null,
      progressSec: 0,
    };
  },
  computed: {
    feedUrl() {
      return decodeURIComponent(this.$route.params.feedUrlEncoded || '');
    },
    guid() {
      return decodeURIComponent(this.$route.params.guidEncoded || '');
    },
    episodeId() {
      return `${this.feedUrl}::${this.guid}`;
    },
    sanitizedDescription() {
      const raw = (this.episode && this.episode.description) || '';
      return sanitizeHtml(raw);
    },
    progressLabel() {
      const total = (this.episode && this.episode.duration) || 0;
      const listened = this.progressSec || 0;
      if (total <= 0 || listened <= 30) return '';
      if (listened >= total - 30) return '已听完';
      return `剩余 ${this.formatDuration(total - listened)}`;
    },
    resumeAvailable() {
      return (
        this.progressSec > 30 &&
        this.episode &&
        this.progressSec < (this.episode.duration || Infinity) - 30
      );
    },
    isFav() {
      if (!this.episode) return false;
      const ids =
        (this.$store.state.podcastFavorites &&
          this.$store.state.podcastFavorites.episodeIds) ||
        [];
      return ids.includes(this.episode.id);
    },
  },
  watch: {
    episodeId: {
      immediate: true,
      handler(v) {
        if (v) this.load();
      },
    },
  },
  methods: {
    async load() {
      this.episode = await getEpisode(this.episodeId);
      if (!this.episode) {
        this.$router.replace('/library');
        return;
      }
      this.podcast = await getPodcast(this.feedUrl);
      const p = await getEpisodeProgress(this.episodeId).catch(() => null);
      this.progressSec = (p && p.position) || 0;
    },
    play() {
      const title = (this.podcast && this.podcast.title) || '';
      this.$store.state.player.playPodcastEpisode(this.episode, title);
    },
    // [S-3] 三个小入口
    onFav() {
      if (!this.episode) return;
      const title = (this.podcast && this.podcast.title) || '';
      const track = {
        id: `pod:${this.episode.id}`,
        name: this.episode.title,
        al: { id: 0, name: title, picUrl: this.episode.coverUrl || '' },
        dt: (this.episode.duration || 0) * 1000,
        podcastAudioUrl: this.episode.audioUrl,
        podcastEpisodeId: this.episode.id,
      };
      this.$store.dispatch('togglePodcastFavorite', track);
    },
    onQueue() {
      this.$store.dispatch('showToast', '播放列表功能即将上线');
    },
    onDownload() {
      this.$store.dispatch('showToast', '下载功能即将上线');
    },
    goPodcast() {
      this.$router.push({
        name: 'podcastDetail',
        params: { feedUrlEncoded: encodeURIComponent(this.feedUrl) },
      });
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
.episode-detail-page {
  color: var(--color-text);
}
.ep-header {
  display: flex;
  gap: 24px;
  margin-bottom: 28px;
  align-items: flex-start;
  .cover {
    width: 160px;
    height: 160px;
    border-radius: 14px;
    object-fit: cover;
    flex-shrink: 0;
    background: var(--color-secondary-bg);
  }
  .meta {
    flex: 1;
    overflow: hidden;
    .podcast-name {
      font-size: 13px;
      opacity: 0.65;
      cursor: pointer;
      display: inline-block;
      margin-bottom: 4px;
      &:hover {
        opacity: 1;
        text-decoration: underline;
      }
    }
    .title {
      font-size: 26px;
      font-weight: 700;
      line-height: 1.3;
      margin: 0 0 10px;
    }
    .sub {
      font-size: 13px;
      opacity: 0.6;
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 16px;
      .prog {
        color: var(--color-primary);
        opacity: 1;
      }
    }
    .actions {
      display: flex;
      gap: 12px;
      align-items: center;
    }
  }
}
.play-btn {
  background: var(--color-primary);
  color: var(--color-primary-bg);
  padding: 9px 18px;
  border-radius: 10px;
  font-weight: 700;
  font-size: 14px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  transition: 0.15s;
  .svg-icon {
    width: 14px;
    height: 14px;
  }
  &:hover {
    transform: scale(1.04);
  }
}
.link-btn {
  color: var(--color-text);
  opacity: 0.55;
  font-size: 13px;
  text-decoration: none;
  &:hover {
    opacity: 1;
    text-decoration: underline;
  }
}
// [S-3] 小图标按钮：收藏 / 下载 / 加入播放列表
.mini-btn {
  background: transparent;
  color: var(--color-text);
  opacity: 0.55;
  border-radius: 50%;
  padding: 8px;
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
    opacity: 1;
    background: var(--color-secondary-bg-for-transparent);
  }
  &.favorited {
    opacity: 1;
    color: #e74c3c;
  }
}

.notes {
  font-size: 15px;
  line-height: 1.75;
  opacity: 0.92;
  ::v-deep {
    p {
      margin: 10px 0;
    }
    a {
      color: var(--color-primary);
      text-decoration: none;
      &:hover {
        text-decoration: underline;
      }
    }
    img {
      max-width: 100%;
      height: auto;
      border-radius: 8px;
      margin: 14px 0;
    }
    figure {
      margin: 14px 0;
    }
    ul,
    ol {
      padding-left: 28px;
    }
    blockquote {
      border-left: 3px solid var(--color-primary);
      padding-left: 14px;
      margin: 14px 0;
      opacity: 0.85;
    }
    pre {
      background: var(--color-secondary-bg);
      padding: 10px 14px;
      border-radius: 8px;
      overflow: auto;
    }
    code {
      background: var(--color-secondary-bg-for-transparent);
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 0.92em;
    }
  }
  .empty {
    text-align: center;
    opacity: 0.45;
    padding: 40px 0;
  }
}
</style>
