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
      <div v-if="discoverLoading" class="disc-state is-loading">
        <BouncingDots />
      </div>
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
              v-tip="sec.actionText"
              class="disc-action"
              @click="onSectionAction(sec)"
            >
              <span>{{ sec.actionText }}</span>
              <!-- [B67-BUG-6] bottle-cap(再来一瓶)彩色瓶盖信息密度高，单独放大；箭头/罗盘维持小尺寸 -->
              <svg-icon
                :icon-class="sec.actionIcon"
                :class="{ 'is-bottlecap': sec.actionIcon === 'bottle-cap' }"
              />
            </div>
          </div>
          <!-- [B-44] 固定两行 + 列数随窗口自适应（去掉横向滚轮）；切到 2*cols 项，多的进二级页 -->
          <!-- [B-47] forYou 的 key 随"再推荐一次"变化 → 网格重挂触发淡入过渡(非硬切) -->
          <!-- [性能·补动画] 用 transition-group 让窗口缩放跨列数(5↔6)时卡片 FLIP 平滑滑到新位，
               而非瞬移。:key 不变(resize)→走 *-move 位移;:key 变(reroll)→整组重建、重播
               discGridFade 淡入(原机制保留)。move 走 transform 不触发重排，60fps。 -->
          <transition-group
            :key="sec.key + '-' + (rerollSeq[sec.key] || 0)"
            name="disc-flip"
            tag="div"
            class="disc-grid"
            :style="{ '--disc-cols': cols }"
          >
            <DiscoverCard
              v-for="p in sec.items.slice(0, cols * 2)"
              :key="sec.key + '-' + (p.id || p.feedUrl || p.name)"
              :podcast="p"
              @changed="onCardChanged"
            />
          </transition-group>
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
import BouncingDots from '@/components/BouncingDots.vue';
import {
  fetchHotPodcasts,
  fetchNewPodcasts,
  fetchAppleCharts,
  mergeDiscoverByName,
  splitSections,
  reshuffleSection,
  preferredGenresFrom,
} from '@/utils/podcast/discover';
import { getSubscribedPodcasts, getPodcastsByIds } from '@/utils/podcast/db';
import { getRecentListenedPodcastIds } from '@/utils/podcast/listening';

export default {
  name: 'Home',
  components: {
    CoverRow,
    FMCard,
    DailyTracksCard,
    SvgIcon,
    DiscoverCard,
    BouncingDots,
  },
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
      // [B-47] reroll 自增序号(按板块)：变化触发该板块网格重挂淡入过渡(forYou/treasure 共用此机制)
      rerollSeq: { forYou: 0, treasure: 0 },
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
          actionText: '完整榜单',
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
          // [改] 'page'→'reroll'：用户要"再找一找"原地重洗、不跳全屏二级页(对齐"为你推荐")
          actionType: 'reroll',
        },
        {
          key: 'forYou',
          title: '为你推荐',
          items: this.noBlocked(this.sections.forYou),
          actionText: '再来一瓶',
          actionIcon: 'bottle-cap',
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
    // [性能] rAF 节流：resize 高频触发，原每次同步读 clientWidth 会强制 reflow、多次抖动；
    //   合并到下一帧只读一次，配合 disc-flip move 让缩放更顺。
    computeCols() {
      if (this._colsRaf) cancelAnimationFrame(this._colsRaf);
      this._colsRaf = requestAnimationFrame(() => {
        this._colsRaf = null;
        const el = this.$refs.discRoot;
        if (!el) return;
        const w = el.clientWidth;
        if (!w) return;
        const card = 168;
        const gap = 18;
        this.cols = Math.max(1, Math.floor((w + gap) / (card + gap)));
      });
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
        // [资源池] 同时抓 Apple 中国区官方榜(软耦合·失败返 [])，去重后并入发现池 →
        //   热门 top 仍 xyzrank 榜单序，寻宝/为你推荐池扩大、更多中文头部内容(治"池枯竭")。
        const [hotItems, newItems, appleItems] = await Promise.all([
          fetchHotPodcasts(force),
          fetchNewPodcasts(force).catch(() => []),
          fetchAppleCharts(force),
        ]);
        const items = mergeDiscoverByName(hotItems, appleItems);
        this.allItems = items;
        // [B-43] 从 Dexie 灌入已订阅映射（卡片绿勾回显 + 寻宝/推荐去重）
        const subMap = await this.loadSubscribedMap();
        this.$store.commit('setSubscribedPodcastMap', subMap);
        const subbedNames = new Set(Object.keys(subMap));
        // [B-43/B-63] 综合偏好分类(订阅 + 最近一周听过 + 最近搜索词类目)，"为你推荐"按分类加权
        this.preferredGenres = await this.buildPreferredGenres(
          items,
          subbedNames
        );
        this.sections = splitSections(items, subbedNames, this.preferredGenres);
        // [B-53] 新上线：排除已订阅，保持新鲜
        // [C] 并入热门/寻宝/为你推荐已展示节目名，避免"新上线"与其它三栏重复
        const shownNames = new Set(subbedNames);
        ['hot', 'treasure', 'forYou'].forEach(k => {
          (this.sections[k] || []).forEach(p =>
            shownNames.add((p.name || '').trim())
          );
        });
        this.newItems = (newItems || []).filter(
          p => !shownNames.has((p.name || '').trim())
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
    // [B-63] 综合偏好分类：订阅节目 + 最近一周听过节目 + 最近搜索词，→ 在热榜里反查 primaryGenreName。
    //   关键词走"类目"而非只按名字硬匹配 → 推同类节目，不生硬。
    async buildPreferredGenres(items, subbedNames) {
      const genres = preferredGenresFrom(items, subbedNames); // 订阅类目
      try {
        const recentIds = await getRecentListenedPodcastIds(7);
        if (recentIds.length) {
          const pods = await getPodcastsByIds(recentIds);
          const names = new Set(
            pods.map(p => (p.title || '').trim()).filter(Boolean)
          );
          preferredGenresFrom(items, names).forEach(g => genres.add(g));
        }
      } catch (e) {
        /* 忽略：拿不到近期收听不影响订阅类目推荐 */
      }
      try {
        const kws = JSON.parse(
          localStorage.getItem('podcast.recentSearch') || '[]'
        );
        const lowered = kws.map(k => String(k).toLowerCase()).filter(Boolean);
        if (lowered.length) {
          items.forEach(it => {
            const name = (it.name || '').toLowerCase();
            if (lowered.some(k => name.includes(k))) {
              const g = (it.primaryGenreName || '').trim();
              if (g) genres.add(g);
            }
          });
        }
      } catch (e) {
        /* 忽略 */
      }
      return genres;
    },
    // [B-42] 行尾操作：page=进二级页；reroll=重新随机推荐
    async onSectionAction(sec) {
      if (sec.actionType === 'page') {
        this.$router.push({ name: 'discover', params: { type: sec.key } });
      } else if (sec.actionType === 'reroll') {
        // [再找一找/再来一瓶] 原地重洗"被点的那栏"(sec.key)，不跳二级页。
        //   硬排除已订阅(绝不显示)；软排除 其它各栏当前批 + 本栏上一批：
        //   forYou 走 buildForYou 读 softExclude → 真"换一批"(池不足时从非订阅全池回填，不只剩两三个)；
        //   treasure 走 shuffle 自然换序、不读 softExclude(其分支只硬排已订阅)。
        const key = sec.key;
        const hardExclude = new Set(Object.keys(this.subscribedMap));
        const softExclude = new Set();
        ['hot', 'treasure', 'forYou'].forEach(k =>
          (this.sections[k] || []).forEach(p =>
            softExclude.add((p.name || '').trim())
          )
        );
        (this.newItems || []).forEach(p =>
          softExclude.add((p.name || '').trim())
        );
        this.rerollSeq[key] = (this.rerollSeq[key] || 0) + 1; // [B-47] 变 key 触发卡片淡入过渡
        this.sections = {
          ...this.sections,
          [key]: reshuffleSection(
            this.allItems,
            key,
            hardExclude,
            softExclude,
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
    // [加载动效] 加载中用跳动点：不沿用 0.55 暗淡(明暗由点关键帧管)，居中
    &.is-loading {
      opacity: 1;
      display: flex;
      justify-content: center;
    }
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
    // [B67-BUG-6] 「再来一瓶」bottle-cap 彩色瓶盖。bottle-cap.svg 的 viewBox 是 640×480(4:3 非正方)：
    //   ⚠️ 不能用 width:auto——svg-icon 外层 <svg> 自身无 viewBox(在 sprite 的 <symbol> 上)，无内在宽高比，
    //   width:auto 会回退到替换元素默认 300px、把按钮撑爆、标题行错位。必须给**显式 4:3 宽高**(匹配
    //   viewBox→不留白)。26×20 ≈ 4:3，瓶盖按 ~20px 高完整渲染、比 13px 文字稍大。箭头/罗盘仍 13px。
    .svg-icon.is-bottlecap {
      width: 26px;
      height: 20px;
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
  // [性能·补动画] 窗口缩放跨列数时卡片 FLIP 平滑滑动(transform-only，不重排)。
  //   transition-group 自动给位置变化的子元素挂 .disc-flip-move 并补 translate。
  .disc-flip-move {
    transition: transform 0.34s cubic-bezier(0.2, 0.7, 0.2, 1);
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
