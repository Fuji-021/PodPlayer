<template>
  <div id="app" :class="{ 'user-select-none': userSelectNone }">
    <Scrollbar v-show="!showLyrics" ref="scrollbar" />
    <Navbar v-show="showNavbar" ref="navbar" />
    <main
      ref="main"
      :style="{ overflow: enableScrolling ? 'auto' : 'hidden' }"
      @scroll="handleScroll"
    >
      <!-- [性能·路由过渡] 给页面切换加淡入+轻微上移过渡，消除"硬切"主观卡顿。
           :key=$route.name 让同为 keepAlive 的菜单互切(home↔library↔explore)也能触发过渡。
           keepAlive 仍按 name 缓存各页 DOM，过渡只补视觉、不重渲。 -->
      <transition name="page" mode="out-in" @before-enter="resetMainScroll">
        <keep-alive>
          <router-view
            v-if="$route.meta.keepAlive"
            :key="$route.name"
          ></router-view>
        </keep-alive>
      </transition>
      <transition name="page" mode="out-in" @before-enter="resetMainScroll">
        <router-view
          v-if="!$route.meta.keepAlive"
          :key="$route.name"
        ></router-view>
      </transition>
    </main>
    <transition name="slide-up">
      <Player v-if="enablePlayer" v-show="showPlayer" ref="player" />
    </transition>
    <Toast />
    <ModalAddTrackToPlaylist v-if="isAccountLoggedIn" />
    <ModalNewPlaylist v-if="isAccountLoggedIn" />
    <transition v-if="enablePlayer" name="slide-up">
      <Lyrics v-show="showLyrics" />
    </transition>
  </div>
</template>

<script>
import ModalAddTrackToPlaylist from './components/ModalAddTrackToPlaylist.vue';
import ModalNewPlaylist from './components/ModalNewPlaylist.vue';
import Scrollbar from './components/Scrollbar.vue';
import Navbar from './components/Navbar.vue';
import Player from './components/Player.vue';
import Toast from './components/Toast.vue';
import { ipcRenderer } from './electron/ipcRenderer';
import { isAccountLoggedIn, isLooseLoggedIn } from '@/utils/auth';
import Lyrics from './views/lyrics.vue';
import { mapState } from 'vuex';

export default {
  name: 'App',
  components: {
    Navbar,
    Player,
    Toast,
    ModalAddTrackToPlaylist,
    ModalNewPlaylist,
    Lyrics,
    Scrollbar,
  },
  data() {
    return {
      isElectron: process.env.IS_ELECTRON, // true || undefined
      userSelectNone: false,
    };
  },
  computed: {
    ...mapState(['showLyrics', 'settings', 'player', 'enableScrolling']),
    isAccountLoggedIn() {
      return isAccountLoggedIn();
    },
    showPlayer() {
      return (
        [
          'mv',
          'loginUsername',
          'login',
          'loginAccount',
          'lastfmCallback',
        ].includes(this.$route.name) === false
      );
    },
    enablePlayer() {
      return this.player.enabled && this.$route.name !== 'lastfmCallback';
    },
    showNavbar() {
      return this.$route.name !== 'lastfmCallback';
    },
  },
  created() {
    if (this.isElectron) ipcRenderer(this);
    window.addEventListener('keydown', this.handleKeydown);
    this.fetchData();
  },
  methods: {
    handleKeydown(e) {
      if (e.code === 'Space') {
        if (e.target.tagName === 'INPUT') return false;
        if (this.$route.name === 'mv') return false;
        e.preventDefault();
        this.player.playOrPause();
      }
    },
    fetchData() {
      if (!isLooseLoggedIn()) return;
      this.$store.dispatch('fetchLikedSongs');
      this.$store.dispatch('fetchLikedSongsWithDetails');
      this.$store.dispatch('fetchLikedPlaylist');
      if (isAccountLoggedIn()) {
        this.$store.dispatch('fetchLikedAlbums');
        this.$store.dispatch('fetchLikedArtists');
        this.$store.dispatch('fetchLikedMVs');
        this.$store.dispatch('fetchCloudDisk');
      }
    },
    handleScroll() {
      this.$refs.scrollbar.handleScroll();
    },
    // [滚动复位·查漏补缺] 路由切换、新页进场时把全站唯一的滚动容器 <main> 归零(回顶部)。
    //   根因：全站共用本组件的 <main> 作滚动容器，跨页不会自动归零 → 从已滚动的页面前进到
    //   discover/单集详情/收藏/历史/统计等"不保存位置"的页，会停在上一页的滚动位(中间)。统一在此兜底，
    //   与既有 per-page 复位(podcastDetail._presentEpisodes / dailyTracks)同时机、同效果，只是收口到一处。
    //   savePosition 页(home/explore/artist/next/library)跳过：由各自 activated() 的 restorePosition()
    //   恢复滚动位；跳过 → 与本钩子触发顺序无关、绝不打架。
    resetMainScroll() {
      if (this.$route.meta && this.$route.meta.savePosition) return;
      if (this.$refs.main) this.$refs.main.scrollTop = 0;
    },
  },
};
</script>

<style lang="scss">
#app {
  width: 100%;
  // [B-33] 只过渡主题色，不用 transition: all——否则窗口 resize 时宽/高也被动画化，
  // 内容滞后于窗口边缘 → 露出底色"黑边"，非常割裂。这是缩放不丝滑的主因。
  transition: background-color 0.4s, color 0.4s;
}

main {
  position: fixed;
  top: 0;
  bottom: 0;
  right: 0;
  left: 0;
  overflow: auto;
  // [B-33] 内容区铺满主题底色：resize 时第一时间用 body bg 填充，减轻"黑边"观感。
  background-color: var(--color-body-bg);
  // [B-33] 边距单位制：封面 grid gap=24px=1 单位；左右边距 2~3 单位（48~72px）自适应。
  // clamp 让默认窗口≈2 单位、大屏最大化≈3 单位平滑过渡（替代原 10vw/5vw 太空旷）。
  padding: 64px clamp(48px, 4vw, 72px) 96px;
  box-sizing: border-box;
  scrollbar-width: none; // firefox
}

main::-webkit-scrollbar {
  width: 0px;
}

// [性能·路由过渡] 页面切换淡入+轻微上移，消除硬切。2026-06-21 再加快(用户嫌"我的订阅↔首页来回拖沓")：
//   leave 0.09→0.05、enter 0.13→0.08(mode=out-in 串行总 ~0.22s→~0.13s)、位移 6→4px 更轻快、跟手；
//   仍保留过渡(不硬切)。只动 opacity/transform(合成器属性)，不引发重排。时长可继续按手感微调。
.page-enter-active {
  transition: opacity 0.08s ease, transform 0.08s cubic-bezier(0.2, 0.7, 0.2, 1);
}
.page-leave-active {
  transition: opacity 0.05s ease;
}
.page-enter {
  opacity: 0;
  transform: translateY(4px);
}
.page-leave-to {
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.4s;
}
.slide-up-enter,
.slide-up-leave-to {
  transform: translateY(100%);
}
</style>
