<template>
  <div id="app" :class="{ 'user-select-none': userSelectNone }">
    <Scrollbar v-show="!showLyrics" ref="scrollbar" />
    <Navbar v-show="showNavbar" ref="navbar" />
    <main
      ref="main"
      :style="{ overflow: enableScrolling ? 'auto' : 'hidden' }"
      @scroll="handleScroll"
    >
      <!-- [路由过渡·单 RV 根治闪页] 单个 router-view + keep-alive:include → 全局只有一个 <transition>，
           mode=out-in 才真正生效(旧页 leave 完成后才进新页)，根治原"两个 RV 各自 transition 并发交叠"
           导致的「切 keepAlive↔非keepAlive 时旧页(如首页)一闪」(点首页节目进详情 100% 复现)。
           keep-alive 仅缓存 include 列出的页(=原 meta.keepAlive 那批，按组件 name)，其余正常创建/销毁；
           :key=$route.name 让同为 keepAlive 的菜单互切(首页↔我的订阅↔探索)也触发过渡。 -->
      <transition name="page" mode="out-in" @before-enter="resetMainScroll">
        <keep-alive :include="keepAliveComponents">
          <router-view :key="$route.name"></router-view>
        </keep-alive>
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
      // [路由过渡·单 RV] keep-alive 缓存的页面(组件 name)= 原 router meta.keepAlive 的 8 个路由。
      //   ⚠️ 增删 keepAlive 页时这里必须同步(否则该页不被缓存 → 丢 activated/滚动恢复/分页返回不变等)。
      keepAliveComponents: [
        'Home',
        'Explore',
        'Artist',
        'ArtistMV',
        'Next',
        'Search',
        'PodcastLibrary',
        'DiscoverList',
      ],
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
    // [键盘滚动] 长按连续平滑滚动需要成对的 keyup(松开收尾)与 blur(切窗口防卡在持续滚动)。
    window.addEventListener('keyup', this.handleScrollKeyup);
    window.addEventListener('blur', this.stopKbScroll);
    this.fetchData();
  },
  beforeDestroy() {
    window.removeEventListener('keydown', this.handleKeydown);
    window.removeEventListener('keyup', this.handleScrollKeyup);
    window.removeEventListener('blur', this.stopKbScroll);
    this.stopKbScroll();
  },
  methods: {
    handleKeydown(e) {
      if (e.code === 'Space') {
        if (e.target.tagName === 'INPUT') return false;
        if (this.$route.name === 'mv') return false;
        e.preventDefault();
        this.player.playOrPause();
        return;
      }
      // [键盘滚动] ↑/↓ 滚一步、PageUp/PageDown 滚一屏，作用于全站唯一滚动容器 <main>。
      this.handleScrollKeydown(e);
    },
    // [键盘滚动] 用键盘连续平滑滚动主内容区。<main> 是全站唯一滚动容器(position:fixed，默认键盘
    //   滚不动，故显式接管)。手感关键：不是「每次 keydown 跳一格」(那样长按受系统按键重复频率限制 →
    //   一顿一顿)，而是按住即用 requestAnimationFrame 每帧按速度推进 scrollTop(60fps 连续)、松开缓动
    //   停住，像鼠标中键自动滚。多重让行：① 只认裸 ↑/↓/PageUp/PageDown；② 带 Ctrl/Cmd/Alt 让给既有
    //   快捷键(如 Ctrl+↑/↓ 音量)；③ mv/沉浸页/歌词页(overlay 锁 enableScrolling=false)不抢；
    //   ④ 焦点在输入框/可编辑区(方向键给光标)、或在 vue-slider 滑块(方向键调值)时不抢。
    handleScrollKeydown(e) {
      const code = e.code;
      let dir = 0;
      if (code === 'ArrowUp' || code === 'PageUp') dir = -1;
      else if (code === 'ArrowDown' || code === 'PageDown') dir = 1;
      else return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.$route.name === 'mv') return;
      if (this.showLyrics) return;
      if (!this.enableScrolling) return;
      const t = e.target;
      if (t) {
        const tag = t.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          t.isContentEditable
        ) {
          return;
        }
        if (typeof t.closest === 'function' && t.closest('.vue-slider')) return;
      }
      const main = this.$refs.main;
      if (!main) return;
      e.preventDefault(); // 顶掉系统默认滚动，避免与 rAF 双滚
      const isPage = code === 'PageUp' || code === 'PageDown';
      // 目标速度(px/s)：方向键平稳、翻页键约 3.2 屏/秒(随视口高自适应)。连续 rAF 滚，
      //   手感不受系统按键重复频率影响 = 长按不再一顿一顿。
      const speed = isPage ? Math.max(main.clientHeight * 3.2, 2600) : 1100;
      this._kbScrollActive = code;
      this._kbScrollTargetVel = dir * speed;
      this.startKbScroll();
    },
    startKbScroll() {
      // [首页滚动卡顿修·P2] 滚动期给 body 打标记 → 全局 CSS 冻结封面淡入/辉光过渡(见本文件 style)，
      //   砍掉慢速逐张进场时叠加的 transition 重算峰值(订阅页同款 .scrolling 冻结方案)。鼠标滚轮另说，
      //   这里只在键盘连续滚动期间冻结、松开即恢复。
      if (typeof document !== 'undefined') {
        document.body.classList.add('is-kb-scrolling');
      }
      if (this._kbScrollRAF) return; // 已在滚，仅更新目标速度即可
      this._kbScrollLastTs = 0;
      this._kbScrollRAF = requestAnimationFrame(this.kbScrollStep);
    },
    kbScrollStep(ts) {
      const main = this.$refs.main;
      if (!main) {
        this._kbScrollRAF = null;
        return;
      }
      if (!this._kbScrollLastTs) this._kbScrollLastTs = ts;
      let dt = (ts - this._kbScrollLastTs) / 1000;
      this._kbScrollLastTs = ts;
      if (dt > 0.05) dt = 0.05; // 掉帧/切走回来别一次猛跳
      const target = this._kbScrollTargetVel || 0;
      // 速度向目标缓动：起步/收尾都顺(不是硬启停)，约 200ms 到位。
      const ease = Math.min(1, dt * 14);
      const cur = this._kbScrollVel || 0;
      const v = cur + (target - cur) * ease;
      this._kbScrollVel = v;
      // [抖动修] 单帧位移封顶 ≈1.5 个 60fps 帧的量。长按久了偶发的掉帧(单集列表跨行重渲染、GC、
      //   播放器每秒落盘任务都会让某帧 dt 变大)若按 v*dt 照搬就会「猛跳一下」= 肉眼抖动；封顶后该帧只是
      //   少滚一点点(几乎无感)、把跳变摊匀 → 长按全程持续顺滑。dt 法本身仍保证不同刷新率下速度一致。
      let delta = v * dt;
      const maxStep = (Math.abs(v) / 60) * 1.5;
      if (delta > maxStep) delta = maxStep;
      else if (delta < -maxStep) delta = -maxStep;
      main.scrollTop += delta;
      // 松键(target=0)且基本停下 → 收尾、结束循环、恢复封面过渡。
      if (target === 0 && Math.abs(v) < 4) {
        this._kbScrollVel = 0;
        this._kbScrollRAF = null;
        if (typeof document !== 'undefined') {
          document.body.classList.remove('is-kb-scrolling');
        }
        return;
      }
      this._kbScrollRAF = requestAnimationFrame(this.kbScrollStep);
    },
    handleScrollKeyup(e) {
      // 只在松开「当前驱动滚动的那个键」时收尾；松开别的键不打断(多键同按由后按的键接管)。
      if (e.code === this._kbScrollActive) {
        this._kbScrollTargetVel = 0; // 缓动到 0 后 kbScrollStep 自停
        this._kbScrollActive = null;
      }
    },
    stopKbScroll() {
      // 切窗口/失焦：keyup 可能收不到 → 立即硬停，防卡在持续滚动。
      this._kbScrollTargetVel = 0;
      this._kbScrollVel = 0;
      this._kbScrollActive = null;
      if (this._kbScrollRAF) {
        cancelAnimationFrame(this._kbScrollRAF);
        this._kbScrollRAF = null;
      }
      if (typeof document !== 'undefined') {
        document.body.classList.remove('is-kb-scrolling');
      }
    },
    // 自定义 Scrollbar 由 <main @scroll="handleScroll"> 在每帧 scrollTop 变化时自动同步，无需手动调。
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

// [首页滚动卡顿修·P2] 键盘连续滚动期间(body.is-kb-scrolling，由 App.vue startKbScroll/stopKbScroll 切)
//   冻结封面淡入(PodImage .pod-img 的 0.4s opacity)与发现卡辉光(DiscoverCard .cover-shadow 的
//   filter/opacity 过渡)。慢速 ↑/↓ 滚动时封面逐张进场，这些过渡逐帧重算叠加成峰值=卡顿；滚动期按住
//   基态、松开即恢复(订阅页 .scrolling 同款思路)。非 scoped 全局样式 + !important 才能压过组件 scoped 过渡。
body.is-kb-scrolling .pod-img,
body.is-kb-scrolling .cover-shadow {
  transition: none !important;
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
