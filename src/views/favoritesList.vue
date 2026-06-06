<template>
  <div class="favorites-page">
    <h1>我的收藏</h1>
    <div v-if="!list.length" class="empty">还没有收藏的单集</div>
    <div v-for="item in list" :key="item.id" class="row" @click="play(item)">
      <img class="cover" :src="item.coverUrl" @error="onCoverError" />
      <div class="meta">
        <div class="t">{{ item.title }}</div>
        <div class="s">{{ item.podcastTitle }}</div>
      </div>
      <button class="unfav" @click.stop="unfav(item)">
        <svg-icon icon-class="heart-solid" />
      </button>
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
    return { list: [] };
  },
  async created() {
    await this.reload();
  },
  async activated() {
    await this.reload();
  },
  methods: {
    async reload() {
      this.list = await getAllFavorites();
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
    border-radius: 8px;
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
</style>
