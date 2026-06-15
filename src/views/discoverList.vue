<template>
  <div class="discover-list">
    <div class="head">
      <h1>{{ title }}</h1>
      <button v-tip="'换一批'" class="refresh-btn" @click="reload(true)">
        <svg-icon icon-class="refresh" />
      </button>
    </div>

    <div v-if="loading" class="state">正在加载…</div>
    <div v-else-if="error" class="state">
      {{ error }}
      <button class="retry" @click="reload(true)">重试</button>
    </div>

    <!-- [B-44] 全量 grid，封面大小/缩放与「我的订阅」一致；卡片复用 DiscoverCard（与首页同一交互） -->
    <div v-else class="grid">
      <DiscoverCard
        v-for="p in visibleItems"
        :key="p.id || p.feedUrl || p.name"
        :podcast="p"
      />
    </div>
  </div>
</template>

<script>
import {
  fetchHotPodcasts,
  fetchNewPodcasts,
  getSectionFull,
} from '@/utils/podcast/discover';
import { getSubscribedPodcasts } from '@/utils/podcast/db';
import SvgIcon from '@/components/SvgIcon.vue';
import DiscoverCard from '@/components/DiscoverCard.vue';

export default {
  name: 'DiscoverList',
  components: { SvgIcon, DiscoverCard },
  data() {
    return {
      items: [],
      loading: false,
      error: '',
    };
  },
  computed: {
    type() {
      return this.$route.params.type || 'hot';
    },
    title() {
      if (this.type === 'treasure') return '播客寻宝';
      if (this.type === 'new') return '新上线';
      return '热门排行';
    },
    // [B-47 第5点] 过滤掉已屏蔽节目（与首页一致，响应式）
    visibleItems() {
      const blocked = new Set(
        (this.$store.state.podcastBlocked.items || []).map(b =>
          (b.name || '').trim()
        )
      );
      return this.items.filter(p => !blocked.has((p.name || '').trim()));
    },
  },
  watch: {
    type() {
      this.reload();
    },
  },
  async created() {
    await this.reload();
  },
  async activated() {
    if (!this.items.length) await this.reload();
  },
  methods: {
    async reload(force = false) {
      this.error = '';
      this.loading = true;
      try {
        const all =
          this.type === 'new'
            ? await fetchNewPodcasts(force)
            : await fetchHotPodcasts(force);
        // [B-43/B-44] 灌入已订阅映射（卡片绿勾回显 + 去重），全局共用同一 store
        const subMap = await this.loadSubscribedMap();
        this.$store.commit('setSubscribedPodcastMap', subMap);
        const excludeNames = new Set(Object.keys(subMap));
        this.items = getSectionFull(all, this.type, excludeNames);
      } catch (e) {
        this.error = String((e && e.message) || e) || '加载失败';
      } finally {
        this.loading = false;
      }
    },
    // 从 Dexie 读已订阅 → {节目名: feedUrl}
    async loadSubscribedMap() {
      try {
        const pods = await getSubscribedPodcasts();
        const map = {};
        pods.forEach(p => {
          const t = (p.title || '').trim();
          if (t) map[t] = p.id;
        });
        return map;
      } catch (e) {
        return {};
      }
    },
  },
};
</script>

<style lang="scss" scoped>
.discover-list {
  color: var(--color-text);
  padding-top: 28px;
  // [B-47] 进二级页过渡：上滑淡入，避免硬切
  animation: discPageEnter 0.34s ease;
}
@keyframes discPageEnter {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 24px;
  h1 {
    font-size: 32px;
    font-weight: 700;
    margin: 0;
  }
}
.refresh-btn {
  background: transparent;
  color: var(--color-text);
  opacity: 0.5;
  border-radius: 8px;
  padding: 6px;
  cursor: pointer;
  display: inline-flex;
  transition: 0.15s;
  .svg-icon {
    width: 18px;
    height: 18px;
  }
  &:hover {
    opacity: 1;
    color: var(--color-primary);
    background: var(--color-secondary-bg-for-transparent);
  }
}
.state {
  opacity: 0.5;
  padding: 60px 0;
  text-align: center;
  font-size: 14px;
  .retry {
    margin-left: 10px;
    color: var(--color-primary);
    cursor: pointer;
    background: transparent;
  }
}
// 与「我的订阅」一致：auto-fill minmax(180px) 网格，缩放逻辑相同
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 24px;
}
</style>
