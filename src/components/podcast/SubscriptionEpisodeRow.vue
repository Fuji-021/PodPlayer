<template>
  <article
    class="update-episode-row"
    :class="{ 'is-playing': runtime.isPlaying }"
    @click="deferOpenEpisode"
    @dblclick="playFromRow"
    @contextmenu.prevent="$emit('menu', $event, episode)"
  >
    <button
      v-tip="'查看单集详情'"
      class="update-cover-button"
      @click.stop="$emit('open-episode', episode)"
      @dblclick.stop
    >
      <PodImage
        class="update-cover"
        :src="episode.podcastCoverUrl || episode.episodeCoverUrl"
      />
    </button>
    <div class="update-episode-main">
      <div class="update-episode-meta">
        <button
          class="update-podcast-link"
          @click.stop="$emit('open-podcast', episode)"
          @dblclick.stop
        >
          {{ episode.podcastTitle || '未命名节目' }}
        </button>
        <span
          v-if="runtime.isUnstarted"
          v-tip="'未开始收听'"
          class="unstarted-dot"
        ></span>
        <span class="update-published">{{ publishedText }}</span>
      </div>
      <button
        class="update-episode-title"
        @click.stop="$emit('open-episode', episode)"
        @dblclick.stop
      >
        {{ episode.title || '未命名单集' }}
      </button>
      <div class="update-episode-sub">
        <span>{{ durationText }}</span>
        <span>{{ runtime.progressText }}</span>
        <span
          v-for="tag in runtime.capabilityTags"
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
        v-tip="'更多操作'"
        class="podcast-episode-action"
        aria-label="更多操作"
        @click.stop="$emit('menu', $event, episode)"
        @dblclick.stop
      >
        <svg-icon icon-class="menu-dots-vertical" />
      </button>
      <button
        v-tip="runtime.isPlaying ? '暂停' : '播放'"
        class="podcast-episode-action"
        :aria-label="runtime.isPlaying ? '暂停' : '播放'"
        @click.stop="$emit('play', episode)"
        @dblclick.stop
      >
        <svg-icon :icon-class="runtime.isPlaying ? 'pause' : 'play-circle'" />
      </button>
    </div>
  </article>
</template>

<script>
import PodImage from '@/components/PodImage.vue';
import SvgIcon from '@/components/SvgIcon.vue';

function formatDuration(value) {
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
}

function formatPublished(value) {
  const time = Number(value) || 0;
  if (!time) return '发布时间未知';
  const date = new Date(time);
  return Number.isNaN(date.getTime())
    ? '发布时间未知'
    : date.toLocaleDateString('zh-CN');
}

export default {
  name: 'SubscriptionEpisodeRow',
  components: { PodImage, SvgIcon },
  props: {
    episode: { type: Object, required: true },
    getEpisodeState: { type: Function, required: true },
  },
  computed: {
    runtime() {
      return (
        this.getEpisodeState(this.episode) || {
          isPlaying: false,
          isUnstarted: false,
          progressText: '未听',
          capabilityTags: [],
        }
      );
    },
    durationText() {
      return formatDuration(this.episode.duration);
    },
    publishedText() {
      return formatPublished(this.episode.pubTime);
    },
  },
  beforeDestroy() {
    if (this._clickTimer) clearTimeout(this._clickTimer);
  },
  methods: {
    deferOpenEpisode() {
      if (this._clickTimer) clearTimeout(this._clickTimer);
      this._clickTimer = setTimeout(() => {
        this._clickTimer = null;
        this.$emit('open-episode', this.episode);
      }, 250);
    },
    playFromRow() {
      if (this._clickTimer) clearTimeout(this._clickTimer);
      this._clickTimer = null;
      this.$emit('play', this.episode);
    },
  },
};
</script>

<style lang="scss" scoped>
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
  align-items: center;
}

@media (max-width: 620px) {
  .update-episode-row {
    grid-template-columns: 48px minmax(0, 1fr) auto;
    gap: 9px;
  }

  .update-cover-button,
  .update-cover {
    width: 48px;
    height: 48px;
  }
}
</style>
