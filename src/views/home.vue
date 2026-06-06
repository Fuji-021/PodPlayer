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

    <!-- [播客改造] 首页占位（推荐板块屏蔽后显示），后续替换为播客首页内容 -->
    <div v-if="!showLegacyHome" class="podcast-home-placeholder">
      <p>播客首页建设中</p>
      <router-link to="/library" class="go-library-btn">
        前往播客库 →
      </router-link>
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

export default {
  name: 'Home',
  components: { CoverRow, FMCard, DailyTracksCard },
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
    };
  },
  computed: {
    ...mapState(['settings']),
    byAppleMusic() {
      return byAppleMusic;
    },
  },
  activated() {
    this.loadData();
    this.$parent.$refs.scrollbar.restorePosition();
  },
  methods: {
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
</style>
