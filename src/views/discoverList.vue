<template>
  <div class="discover-list">
    <div class="head">
      <h1>{{ title }}</h1>
    </div>

    <div v-if="loading" class="state is-loading"><BouncingDots /></div>
    <div v-else-if="error" class="state">
      {{ error }}
      <button class="retry" @click="reload(true)">重试</button>
    </div>

    <template v-else>
      <!-- [分页改造] 热门/新上线=固定排行：grid 在内层独立滚动(grid-wrap)，分页条钉死在页脚 →
           不管从哪页跳到哪页，分页条**全程不移动**、main 不滚动。卡片复用 DiscoverCard。 -->
      <div ref="gridWrap" class="grid-wrap">
        <div class="grid">
          <DiscoverCard
            v-for="p in pagedItems"
            :key="p.id || p.feedUrl || p.name"
            :podcast="p"
          />
        </div>
      </div>

      <!-- [分页] 页脚(固定在底部、不随页码增减或内容多少移动)：末页软提醒放在**分页条上方**，
           这样它出现时不会把分页条往上拱(分页条作为页脚最后一个元素、底边恒定)。 -->
      <div class="disc-footer">
        <!-- [分页] 末页软提醒：到底 + 总数；排行刷新后(下次取数)才变 -->
        <div v-if="isLastPage" class="page-end-tip">
          — 到底啦，共 {{ visibleItems.length }} 档节目 —
        </div>

        <!-- [分页] 控件：‹ 1 2 3 … › -->
        <div v-if="totalPages > 1" class="pager">
          <button
            class="pg-btn nav"
            :disabled="currentPage === 1"
            @click="goPage(currentPage - 1)"
          >
            ‹
          </button>
          <template v-for="(p, i) in pageWindow">
            <span v-if="p === '...'" :key="'e' + i" class="pg-ellipsis">…</span>
            <button
              v-else
              :key="'p' + p"
              class="pg-btn"
              :class="{ active: p === currentPage }"
              @click="goPage(p)"
            >
              {{ p }}
            </button>
          </template>
          <button
            class="pg-btn nav"
            :disabled="currentPage === totalPages"
            @click="goPage(currentPage + 1)"
          >
            ›
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script>
import {
  fetchHotPodcasts,
  fetchNewPodcasts,
  getSectionFull,
} from '@/utils/podcast/discover';
import { getSubscribedPodcasts } from '@/utils/podcast/db';
import DiscoverCard from '@/components/DiscoverCard.vue';
import BouncingDots from '@/components/BouncingDots.vue';

export default {
  name: 'DiscoverList',
  components: { DiscoverCard, BouncingDots },
  data() {
    return {
      items: [],
      loading: false,
      error: '',
      // [分页] 加载哨兵：仅"成功加载过"才置位 → keepAlive 返回时不再重取；失败/空结果不置位、返回会重试
      loaded: false,
      // [分页] 当前页(1-based) + 每页数量；排行类固定，分页纯本地切片、不重新取数
      currentPage: 1,
      pageSize: 24,
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
    totalPages() {
      return Math.max(1, Math.ceil(this.visibleItems.length / this.pageSize));
    },
    pagedItems() {
      const start = (this.currentPage - 1) * this.pageSize;
      return this.visibleItems.slice(start, start + this.pageSize);
    },
    isLastPage() {
      return this.currentPage >= this.totalPages;
    },
    // [分页] 页码窗口：≤7 页全列；否则 首尾固定 + 当前页±1 + 省略号(…)
    pageWindow() {
      const total = this.totalPages;
      const cur = this.currentPage;
      if (total <= 7) {
        return Array.from({ length: total }, (_, i) => i + 1);
      }
      const pages = [1];
      let start = Math.max(2, cur - 1);
      let end = Math.min(total - 1, cur + 1);
      if (cur <= 3) {
        start = 2;
        end = 4;
      }
      if (cur >= total - 2) {
        start = total - 3;
        end = total - 1;
      }
      if (start > 2) pages.push('...');
      for (let p = start; p <= end; p++) pages.push(p);
      if (end < total - 1) pages.push('...');
      pages.push(total);
      return pages;
    },
  },
  watch: {
    type() {
      // 切换 热门↔新上线：回到第 1 页并重载（两者共用同一 keepAlive 实例，靠 type 变化驱动）
      this.currentPage = 1;
      this.reload();
    },
    // [分页] 屏蔽节目致总页数缩水时，夹紧当前页防越界（停在空白页）
    totalPages(n) {
      if (this.currentPage > n) this.currentPage = n;
    },
  },
  activated() {
    // [返回不变] 路由 keepAlive：从节目详情/订阅返回后**不重载、不重排、保留页码**(仅首次未加载才取数)。
    //   滚动位不走 savePosition：discover 改回非 savePosition，进入(首访/返回)统一由 App.vue 进场钩子
    //   归顶 → 避免首访从已下滚的首页进来时停在中间(savePosition 会让其跳过归顶钩子又无历史可恢复)。
    if (!this.loaded) this.reload();
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
        this.currentPage = 1; // 新数据从第 1 页看起
        this.loaded = true; // 成功加载 → 返回不再重取(失败则保持 false、返回重试)
      } catch (e) {
        this.error = String((e && e.message) || e) || '加载失败';
      } finally {
        this.loading = false;
      }
    },
    goPage(p) {
      const target = Math.min(Math.max(1, p), this.totalPages);
      if (target === this.currentPage) return;
      this.currentPage = target;
      // [全程不动] 分页条钉死在页脚、main 不滚动 → 翻页时它绝不移动(无论满页↔末页)。
      //   只把**内层 grid** 滚回顶部让新一页从头看(nextTick 等新页渲染后再复位，确保落在新内容顶)；
      //   页面整体不滚、分页条原地不动，可连续点。
      this.$nextTick(() => {
        const w = this.$refs.gridWrap;
        if (w) w.scrollTop = 0;
      });
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
  box-sizing: border-box;
  // [分页·全程不动] 固定为视口可用高度 + 纵向 flex：grid 在中间(grid-wrap)独立滚动、分页条(disc-footer)
  //   钉死在底部 → 翻页 / 满页↔末页切换时分页条**绝不移动**、整页(main)不滚动。
  //   100vh 减 navbar(64)+player 区(96)≈160，再留 ~12px 余量(172) 使分页条恰在播放条之上、不被遮。
  height: calc(100vh - 172px);
  display: flex;
  flex-direction: column;
  // [B-47] 进二级页过渡：上滑淡入，避免硬切
  animation: discPageEnter 0.34s ease;
}
// [分页] grid 容器：占中间剩余高度、内部独立纵向滚动(隐藏滚动条与全站一致)；min-height:0 让其可收缩滚动
.grid-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;
  &::-webkit-scrollbar {
    width: 0;
  }
}
// [分页] 页脚：固定在底部(flex:none)，分页条/提示均不随内容多少或页码增减移动
.disc-footer {
  flex: none;
  padding-top: 14px;
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
// [加载动效] 加载中用跳动点：不沿用 0.5 暗淡(明暗由点关键帧管)，居中
.state.is-loading {
  opacity: 1;
  display: flex;
  justify-content: center;
}
// 与「我的订阅」一致：auto-fill minmax(180px) 网格，缩放逻辑相同
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 24px;
}

// [分页] 控件：圆角按钮，当前页用主题色填充（与全站按钮风格一致）
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0;
  flex-wrap: wrap;
  .pg-btn {
    min-width: 36px;
    height: 36px;
    padding: 0 10px;
    border: none;
    border-radius: 10px;
    background: var(--color-secondary-bg);
    color: var(--color-text);
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
    transition: transform 0.15s, background 0.15s, color 0.15s;
    &.nav {
      font-size: 18px;
    }
    &:hover:not(:disabled):not(.active) {
      transform: translateY(-1px);
      color: var(--color-primary);
    }
    &.active {
      background: var(--color-primary);
      color: #fff;
      cursor: default;
    }
    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  }
  .pg-ellipsis {
    opacity: 0.5;
    padding: 0 2px;
    user-select: none;
  }
}
.page-end-tip {
  text-align: center;
  opacity: 0.42;
  font-size: 13px;
  margin: 0 0 10px; // 位于分页条上方，下边距与分页条分隔
}
</style>
