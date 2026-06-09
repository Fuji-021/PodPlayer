<template>
  <div v-show="show" class="home">
    <!-- [播客改造] 首页网易云推荐板块整体屏蔽（源码保留）。
         showLegacyHome=false 即隐藏全部推荐内容；改回 true 可恢复原首页。 -->
    <div
      v-if="showLegacyHome && settings.showPlaylistsByAppleMusic !== false"
      class="index-row first-row"
    >
      <div class="title"> by Apple Music </div>
      <CoverRow
        :type="'playlist'"
        :items="byAppleMusic"
        sub-text="appleMusic"
        :image-size="1024"
      />
    </div>
    <div v-if="showLegacyHome" class="index-row">
      <div class="title">
        {{ $t('home.recommendPlaylist') }}
        <router-link to="/explore?category=推荐歌单">{{
          $t('home.seeMore')
        }}</router-link>
      </div>
      <CoverRow
        :type="'playlist'"
        :items="recommendPlaylist.items"
        sub-text="copywriter"
      />
    </div>
    <div v-if="showLegacyHome" class="index-row">
      <div class="title"> For You </div>
      <div class="for-you-row">
        <DailyTracksCard ref="DailyTracksCard" />
        <FMCard />
      </div>
    </div>
    <div v-if="showLegacyHome" class="index-row">
      <div class="title">{{ $t('home.recommendArtist') }}</div>
      <CoverRow
        type="artist"
        :column-number="6"
        :items="recommendArtists.items"
      />
    </div>
    <div v-if="showLegacyHome" class="index-row">
      <div class="title">
        {{ $t('home.newAlbum') }}
        <router-link to="/new-album">{{ $t('home.seeMore') }}</router-link>
      </div>
      <CoverRow
        type="album"
        :items="newReleasesAlbum.items"
        sub-text="artist"
      />
    </div>
    <div v-if="showLegacyHome" class="index-row">
      <div class="title">
        {{ $t('home.charts') }}
        <router-link to="/explore?category=排行榜">{{
          $t('home.seeMore')
        }}</router-link>
      </div>
      <CoverRow
        type="playlist"
        :items="topList.items"
        sub-text="updateFrequency"
        :image-size="1024"
      />
    </div>

    <!-- [B-39/B-44] 播客发现页：热门排行 / 播客寻宝 / 为你推荐 -->
    <div v-if="!showLegacyHome" ref="discRoot" class="podcast-discover">
      <div v-if="discoverLoading" class="disc-state">正在加载热门播客…</div>
      <div v-else-if="discoverError" class="disc-state">
        {{ discoverError }}
        <button class="retry" @click="loadDiscover(true)">重试</button>
      </div>
      <template v-else>
        <section
          v-for="sec in discoverSections"
          :key="sec.key"
          class="disc-section"
        >
          <!-- [B-42] 标题行：左标题 + 右操作（探索更多/再找一找/再推荐一次） -->
          <div class="disc-head">
            <div class="disc-title">{{ sec.title }}</div>
            <div
              class="disc-action"
              :title="sec.actionText"
              @click="onSectionAction(sec)"
            >
              <span>{{ sec.actionText }}</span>
              <svg-icon :icon-class="sec.actionIcon" />
            </div>
          </div>
          <!-- [B-44] 固定两行 + 列数随窗口自适应（去掉横向滚轮）；切到 2*cols 项，多的进二级页 -->
          <!-- [B-47] forYou 的 key 随"再推荐一次"变化 → 网格重挂触发淡入过渡(非硬切) -->
          <div
            :key="sec.key === 'forYou' ? 'forYou' + forYouSeq : sec.key"
            class="disc-grid"
            :style="{ '--disc-cols': cols }"
          >
            <DiscoverCard
              v-for="p in sec.items.slice(0, cols * 2)"
              :key="sec.key + '-' + p.id"
              :podcast="p"
              @changed="onCardChanged"
            />
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<script>
import { toplists } from '@/api/playlist';
import { toplistOfArtists } from '@/api/artist';
import { newAlbums } from '@/api/album';
import { byAppleMusic } from '@/utils/staticData';
import { getRecommendPlayList } from '@/utils/playList';
import NProgress from 'nprogress';
import { mapState } from 'vuex';
import CoverRow from '@/components/CoverRow.vue';
import FMCard from '@/components/FMCard.vue';
import DailyTracksCard from '@/components/DailyTracksCard.vue';
import SvgIcon from '@/components/SvgIcon.vue';
import DiscoverCard from '@/components/DiscoverCard.vue';
import {
  fetchHotPodcasts,
  fetchNewPodcasts,
  splitSections,
  reshuffleSection,
  preferredGenresFrom,
} from '@/utils/podcast/discover';
import { getSubscribedPodcasts } from '@/utils/podcast/db';

export default {
  name: 'Home',
  components: { CoverRow, FMCard, DailyTracksCard, SvgIcon, DiscoverCard },
  data() {
    return {
      show: false,
      // [播客改造] 首页推荐板块总开关：false=屏蔽全部网易云推荐，显示占位
      showLegacyHome: false,
      recommendPlaylist: { items: [] },
      newReleasesAlbum: { items: [] },
      topList: {
        items: [],
        ids: [19723756, 180106, 60198, 3812895, 60131],
      },
      recommendArtists: {
        items: [],
        indexs: [],
      },
      // [B-39] 发现页状态
      discoverLoading: false,
      discoverError: '',
      sections: { hot: [], treasure: [], forYou: [] },
      allItems: [], // [B-42] 全量榜单，供二级页 / 再推荐复用
      newItems: [], // [B-53] 新上线节目（xyzrank /api/new-podcasts）
      // [B-44] 每行列数（随窗口自适应），每板块固定显示 2*cols 项
      cols: 2,
      // [B-47] "再推荐一次"自增序号：变化触发 forYou 网格淡入过渡
      forYouSeq: 0,
      // [B-43] 订阅偏好分类（用于"为你推荐" + reroll；不进模板，无需响应式）
      preferredGenres: new Set(),
    };
  },
  computed: {
    ...mapState(['settings']),
    // [B-43] 已订阅映射（节目名 → feedUrl）。store 变化时卡片绿勾自动回显。
    subscribedMap() {
      return this.$store.state.podcastDiscover.subscribedMap;
    },
    byAppleMusic() {
      return byAppleMusic;
    },
    // [B-47 第5点] 已屏蔽节目名集合（响应式：屏蔽后发现页立即过滤掉）
    blockedNames() {
      return new Set(
        (this.$store.state.podcastBlocked.items || []).map(b =>
          (b.name || '').trim()
        )
      );
    },
    discoverSections() {
      return [
        {
          key: 'hot',
          title: '热门排行',
          items: this.noBlocked(this.sections.hot),
          actionText: '探索更多',
          actionIcon: 'arrow-right',
          actionType: 'page',
        },
        {
          key: 'new',
          title: '新上线',
          items: this.noBlocked(this.newItems),
          actionText: '探索更多',
          actionIcon: 'arrow-right',
          actionType: 'page',
        },
        {
          key: 'treasure',
          title: '播客寻宝',
          items: this.noBlocked(this.sections.treasure),
          actionText: '再找一找',
          actionIcon: 'compass-alt',
          actionType: 'page',
        },
        {
          key: 'forYou',
          title: '为你推荐',
          items: this.noBlocked(this.sections.forYou),
          actionText: '再推荐一次',
          actionIcon: 'cardinal-compass',
          actionType: 'reroll',
        },
      ];
    },
  },
  activated() {
    this.loadData();
    this.loadDiscover();
    this.$nextTick(this.computeCols);
    this.$parent.$refs.scrollbar.restorePosition();
  },
  mounted() {
    // [B-44] 窗口缩放时重算列数（固定两行，列数自适应）
    window.addEventListener('resize', this.computeCols);
    this.$nextTick(this.computeCols);
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.computeCols);
  },
  methods: {
    // [B-44] 按容器宽度算每行列数：card 最小 168px + gap 18px
    computeCols() {
      const el = this.$refs.discRoot;
      if (!el) return;
      const w = el.clientWidth;
      if (!w) return;
      const card = 168;
      const gap = 18;
      this.cols = Math.max(1, Math.floor((w + gap) / (card + gap)));
    },
    // [B-44] 卡片订阅状态变化（订阅/取消订阅）后，重算偏好分类等可选刷新；
    //   subscribedMap 已由卡片直接更新 store，回显是响应式的，这里无需重拉。
    onCardChanged() {},
    // [B-47 第5点] 过滤掉已屏蔽节目（发现页三栏都用）
    noBlocked(arr) {
      return (arr || []).filter(
        p => !this.blockedNames.has((p.name || '').trim())
      );
    },
    // [B-39] 发现页：加载榜单 + 分板块
    async loadDiscover(force = false) {
      if (this.showLegacyHome) return;
      // [B56-3] 早退要求 hot 与 new 都已拿到；new 上次失败为空时不被 hot 缓存挡住，会重抓
      if (!force && this.sections.hot.length && this.newItems.length) return;
      this.discoverError = '';
      this.discoverLoading = true;
      try {
        // [B-53] 并行抓热门 + 新上线（new 失败不影响热门）
        const [items, newItems] = await Promise.all([
          fetchHotPodcasts(force),
          fetchNewPodcasts(force).catch(() => []),
        ]);
        this.allItems = items;
        // [B-43] 从 Dexie 灌入已订阅映射（卡片绿勾回显 + 寻宝/推荐去重）
        const subMap = await this.loadSubscribedMap();
        this.$store.commit('setSubscribedPodcastMap', subMap);
        const subbedNames = new Set(Object.keys(subMap));
        // [B-43] 反推偏好分类，"为你推荐"按分类加权
        this.preferredGenres = preferredGenresFrom(items, subbedNames);
        this.sections = splitSections(items, subbedNames, this.preferredGenres);
        // [B-53] 新上线：排除已订阅，保持新鲜
        this.newItems = (newItems || []).filter(
          p => !subbedNames.has((p.name || '').trim())
        );
      } catch (e) {
        this.discoverError = String((e && e.message) || e) || '加载失败';
      } finally {
        this.discoverLoading = false;
      }
    },
    // [B-43] 从 Dexie 读已订阅 → {节目名: feedUrl}。节目名是榜单(name)与订阅库(title)唯一关联键。
    async loadSubscribedMap() {
      try {
        const pods = await getSubscribedPodcasts();
        const map = {};
        pods.forEach(p => {
          const t = (p.title || '').trim();
          if (t) map[t] = p.id; // db.podcasts 的 id 即 feedUrl
        });
        return map;
      } catch (e) {
        return {};
      }
    },
    // [B-42] 行尾操作：page=进二级页；reroll=重新随机推荐
    async onSectionAction(sec) {
      if (sec.actionType === 'page') {
        this.$router.push({ name: 'discover', params: { type: sec.key } });
      } else if (sec.actionType === 'reroll') {
        // [B-43] 排除已订阅 + [B-47] 再排除当前热门/寻宝已显示项（三栏不重复）+ 按分类加权
        const exclude = new Set(Object.keys(this.subscribedMap));
        (this.sections.hot || []).forEach(p =>
          exclude.add((p.name || '').trim())
        );
        (this.sections.treasure || []).forEach(p =>
          exclude.add((p.name || '').trim())
        );
        this.forYouSeq++; // [B-47] 变 key 触发卡片淡入过渡（不硬切）
        this.sections = {
          ...this.sections,
          forYou: reshuffleSection(
            this.allItems,
            'forYou',
            exclude,
            this.preferredGenres
          ),
        };
      }
    },
    loadData() {
      // [播客改造] 推荐板块已屏蔽：直接显示首页占位，不再请求网易云数据
      if (!this.showLegacyHome) {
        this.show = true;
        return;
      }
      setTimeout(() => {
        if (!this.show) NProgress.start();
      }, 1000);
      getRecommendPlayList(10, false).then(items => {
        this.recommendPlaylist.items = items;
        NProgress.done();
        this.show = true;
      });
      newAlbums({
        area: this.settings.musicLanguage ?? 'ALL',
        limit: 10,
      }).then(data => {
        this.newReleasesAlbum.items = data.albums;
      });

      const toplistOfArtistsAreaTable = {
        all: null,
        zh: 1,
        ea: 2,
        jp: 4,
        kr: 3,
      };
      toplistOfArtists(
        toplistOfArtistsAreaTable[this.settings.musicLanguage ?? 'all']
      ).then(data => {
        let indexs = [];
        while (indexs.length < 6) {
          let tmp = ~~(Math.random() * 100);
          if (!indexs.includes(tmp)) indexs.push(tmp);
        }
        this.recommendArtists.indexs = indexs;
        this.recommendArtists.items = data.list.artists.filter((l, index) =>
          indexs.includes(index)
        );
      });
      toplists().then(data => {
        this.topList.items = data.list.filter(l =>
          this.topList.ids.includes(l.id)
        );
      });
      this.$refs.DailyTracksCard.loadDailyTracks();
    },
  },
};
</script>

<style lang="scss" scoped>
.index-row {
  margin-top: 54px;
}
.index-row.first-row {
  margin-top: 32px;
}
.playlists {
  display: flex;
  flex-wrap: wrap;
  margin: {
    right: -12px;
    left: -12px;
  }
  .index-playlist {
    margin: 12px 12px 24px 12px;
  }
}

.title {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 20px;
  font-size: 28px;
  font-weight: 700;
  color: var(--color-text);
  a {
    font-size: 13px;
    font-weight: 600;
    opacity: 0.68;
  }
}

footer {
  display: flex;
  justify-content: center;
  margin-top: 48px;
}

.for-you-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24px;
  margin-bottom: 78px;
}

// [播客改造] 首页占位样式
.podcast-home-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  color: var(--color-text);
  font-weight: 600;
  user-select: none;
  p {
    opacity: 0.4;
    font-size: 18px;
    margin-bottom: 18px;
  }
  .go-library-btn {
    color: var(--color-primary);
    background: var(--color-primary-bg);
    padding: 10px 22px;
    border-radius: 10px;
    text-decoration: none;
    font-size: 15px;
    transition: 0.2s;
    &:hover {
      transform: scale(1.04);
    }
  }
}

// [B-39] 播客发现页
.podcast-discover {
  color: var(--color-text);
  // [B-44] 顶部留白加大，避免第一个板块标题/「探索更多」被 navbar 切到
  padding-top: 36px;
  .disc-state {
    text-align: center;
    padding: 80px 0;
    opacity: 0.55;
    font-size: 14px;
    .retry {
      margin-left: 10px;
      color: var(--color-primary);
      cursor: pointer;
      background: transparent;
      font-weight: 600;
    }
  }
  .disc-section {
    margin-bottom: 30px;
  }
  .disc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .disc-title {
    font-size: 22px;
    font-weight: 700;
  }
  .disc-action {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 13px;
    font-weight: 600;
    opacity: 0.55;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 8px;
    transition: 0.15s;
    .svg-icon {
      width: 13px;
      height: 13px;
    }
    &:hover {
      opacity: 1;
      color: var(--color-primary);
      background: var(--color-secondary-bg-for-transparent);
    }
  }
  // [B-44] 固定两行 + 列数随窗口自适应（去掉横向滚轮）。卡片本体样式见 DiscoverCard.vue
  .disc-grid {
    display: grid;
    grid-template-columns: repeat(var(--disc-cols, 4), minmax(0, 1fr));
    gap: 24px 18px;
    // [B-47] 网格淡入上滑：首屏加载 + "再推荐一次"重挂时都有平滑过渡（不硬切）
    animation: discGridFade 0.32s ease;
  }
}
@keyframes discGridFade {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
