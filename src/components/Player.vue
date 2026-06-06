<template>
  <div class="player" @click="handleClick" @mousedown="handleMouseDown">
    <!-- [播客改造 A-7.8] 进度条 hover 时间预览：鼠标在任意位置浮动时显示对应时间 -->
    <div
      class="progress-bar"
      :class="{
        nyancat: settings.nyancatStyle,
        'nyancat-stop': settings.nyancatStyle && !player.playing,
      }"
      @click.stop
      @mousemove="onProgressHover"
      @mouseleave="hoverTime = null"
    >
      <!-- [播客改造] 关掉 vue-slider 自带的 tooltip（与下方 .progress-hover-tip 重叠）；
           dot 默认放大效果在 CSS 里抑制（见下方 .progress-bar .vue-slider-dot） -->
      <vue-slider
        v-model="player.progress"
        :min="0"
        :max="player.currentTrackDuration"
        :interval="1"
        :drag-on-click="true"
        :duration="0"
        :dot-size="12"
        :height="2"
        tooltip="none"
        :lazy="true"
        :silent="true"
      ></vue-slider>
      <div
        v-if="hoverTime !== null"
        class="progress-hover-tip"
        :style="{ left: hoverX + 'px' }"
      >
        {{ formatTrackTime(hoverTime) }}
      </div>
      <!-- [C-14 bug-2] 加载中：从当前进度位置开始往右移动的小条 -->
      <div
        v-if="audioBuffering"
        class="buffering-bar"
        :style="{ left: bufferingLeftPercent + '%' }"
      ></div>
    </div>
    <div class="controls">
      <div class="playing">
        <div class="container" @click.stop>
          <img
            :src="currentTrack.al && currentTrack.al.picUrl | resizeImage(224)"
            loading="lazy"
            @click="goToAlbum"
          />
          <div class="track-info" :title="audioSource">
            <!-- [播客改造] 单集名：超出容器宽度时 hover 跑马灯滚动；
                 内层 span 用 transform 平移实现，需配合 JS 检测溢出 -->
            <div
              ref="nameWrap"
              :class="[
                'name',
                { 'has-list': hasList(), marquee: nameOverflow },
              ]"
              @click="hasList() && goToList()"
              @mouseenter="checkNameOverflow"
            >
              <span ref="nameText" class="name-text">{{
                currentTrack.name
              }}</span>
            </div>
            <!-- [播客改造] artist 行同时展示节目名和"已播/总时长"，时间字号与节目名一致 -->
            <div class="artist">
              <span
                v-for="(ar, index) in currentTrack.ar"
                :key="ar.id"
                @click="ar.id && goToArtist(ar.id)"
              >
                <span :class="{ ar: ar.id }"> {{ ar.name }} </span
                ><span v-if="index !== currentTrack.ar.length - 1">, </span>
              </span>
              <span v-if="currentTrack.name" class="time">
                · {{ playedTimeText }} / {{ totalTimeText }}
              </span>
            </div>
          </div>
          <!-- [播客改造 A-7.1] 爱心收藏：当前播放是播客则走本地收藏，否则保留原网易云逻辑 -->
          <div class="like-button" :class="{ favorited: isFavorited }">
            <button-icon
              :title="isFavorited ? '取消收藏' : '收藏'"
              @click.native="toggleFavorite"
            >
              <svg-icon v-show="!isFavorited" icon-class="heart"></svg-icon>
              <svg-icon
                v-show="isFavorited"
                icon-class="heart-solid"
              ></svg-icon>
            </button-icon>
          </div>
        </div>
        <div class="blank"></div>
      </div>
      <div class="middle-control-buttons">
        <div class="blank"></div>
        <div class="container" @click.stop>
          <!-- [播客改造 A-7.7] 中间控制：功能是播客标准的"后退15秒/前进30秒"；
               图标暂用原项目的 previous/next（自绘 SVG 风格不一致，暂缓） -->
          <button-icon
            v-show="!player.isPersonalFM"
            title="后退 15 秒"
            @click.native="seekBackward15"
            ><svg-icon icon-class="previous"
          /></button-icon>
          <button-icon
            v-show="player.isPersonalFM"
            title="不喜欢"
            @click.native="moveToFMTrash"
            ><svg-icon icon-class="thumbs-down"
          /></button-icon>
          <button-icon
            class="play"
            :title="$t(player.playing ? 'player.pause' : 'player.play')"
            @click.native="playOrPause"
          >
            <svg-icon :icon-class="player.playing ? 'pause' : 'play'"
          /></button-icon>
          <button-icon title="前进 30 秒" @click.native="seekForward30"
            ><svg-icon icon-class="next"
          /></button-icon>
        </div>
        <div class="blank"></div>
      </div>
      <div class="right-control-buttons">
        <div class="blank"></div>
        <div class="container" @click.stop>
          <!-- [播客改造 A-6] 倍速按钮：右侧按钮区第一个，紧贴中间播放控制 -->
          <div ref="rateControl" class="rate-control" @click.stop>
            <button
              class="rate-button"
              :class="{ active: playbackRate !== 1 }"
              @click="toggleRateMenu"
            >
              {{ rateButtonText }}
            </button>
            <transition name="fade">
              <!-- [播客改造 A-21] 倍速重做：去预设档位，只留滑条，0.5–3，步进 0.1
                   滚轮调节：在面板任意位置滚动即可调整 -->
              <div
                v-if="rateMenuOpen"
                class="rate-menu"
                @click.stop
                @wheel.prevent="onRateWheel"
              >
                <div class="rate-slider">
                  <span class="r-label">{{ rateLabel }}x</span>
                  <vue-slider
                    :value="playbackRate"
                    :min="0.5"
                    :max="3"
                    :interval="0.1"
                    :drag-on-click="true"
                    :duration="0"
                    tooltip="none"
                    :dot-size="12"
                    @change="setRate"
                  ></vue-slider>
                </div>
              </div>
            </transition>
          </div>
          <!-- [播客改造 A-7.9] 播放队列图标换成纯净 queue（去掉音乐符号，去音乐感） -->
          <button-icon
            :title="$t('player.nextUp')"
            :class="{
              active: $route.name === 'next',
              disabled: player.isPersonalFM,
            }"
            @click.native="goToNextTracksPage"
            ><svg-icon icon-class="queue"
          /></button-icon>
          <button-icon
            :class="{
              active: player.repeatMode !== 'off',
              disabled: player.isPersonalFM,
            }"
            :title="
              player.repeatMode === 'one'
                ? $t('player.repeatTrack')
                : $t('player.repeat')
            "
            @click.native="switchRepeatMode"
          >
            <svg-icon
              v-show="player.repeatMode !== 'one'"
              icon-class="repeat"
            />
            <svg-icon
              v-show="player.repeatMode === 'one'"
              icon-class="repeat-1"
            />
          </button-icon>
          <!-- [播客改造 A-7.2] 删除随机播放按钮（播客不需要，源码保留） -->
          <button-icon
            v-if="false"
            :class="{ active: player.shuffle, disabled: player.isPersonalFM }"
            :title="$t('player.shuffle')"
            @click.native="switchShuffle"
            ><svg-icon icon-class="shuffle"
          /></button-icon>
          <button-icon
            v-if="settings.enableReversedMode"
            :class="{ active: player.reversed, disabled: player.isPersonalFM }"
            :title="$t('player.reversed')"
            @click.native="switchReversed"
            ><svg-icon icon-class="sort-up"
          /></button-icon>
          <!-- [播客改造 A-7.4] 滚轮调音量：在音量按钮或音量条上滚动均可 -->
          <div class="volume-control" @wheel.prevent="onVolumeWheel">
            <button-icon :title="$t('player.mute')" @click.native="mute">
              <svg-icon v-show="volume > 0.5" icon-class="volume" />
              <svg-icon v-show="volume === 0" icon-class="volume-mute" />
              <svg-icon
                v-show="volume <= 0.5 && volume !== 0"
                icon-class="volume-half"
              />
            </button-icon>
            <div class="volume-bar">
              <vue-slider
                v-model="volume"
                :min="0"
                :max="1"
                :interval="0.01"
                :drag-on-click="true"
                :duration="0"
                tooltip="none"
                :dot-size="12"
              ></vue-slider>
            </div>
          </div>

          <!-- [播客改造] 展开沉浸页按钮：title 已在 ButtonIcon 层屏蔽；
               文案"歌词" → "沉浸页"作为后续解开屏蔽时的预备文案 -->
          <button-icon
            class="lyrics-button"
            title="沉浸页"
            style="margin-left: 12px"
            @click.native="toggleLyrics"
            ><svg-icon icon-class="arrow-up"
          /></button-icon>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { mapState, mapMutations, mapActions } from 'vuex';
import '@/assets/css/slider.css';

import ButtonIcon from '@/components/ButtonIcon.vue';
import VueSlider from 'vue-slider-component';
import { goToListSource, hasListSource } from '@/utils/playList';
import { formatTrackTime } from '@/utils/common';

export default {
  name: 'Player',
  components: {
    ButtonIcon,
    VueSlider,
  },
  data() {
    return {
      mouseDownTarget: null,
      // [播客改造 A-6] 倍速面板开关 + 当前倍速（与 player._playbackRate 双向同步）
      rateMenuOpen: false,
      playbackRate: 1,
      rateOutsideListener: null,
      // [播客改造 A-7.8] 进度条 hover 预览
      hoverTime: null,
      hoverX: 0,
      // [播客改造] 单集名是否溢出（决定是否启用跑马灯）
      nameOverflow: false,
    };
  },
  computed: {
    ...mapState(['player', 'settings', 'data', 'audioBuffering']),
    currentTrack() {
      return this.player.currentTrack;
    },
    volume: {
      get() {
        return this.player.volume;
      },
      set(value) {
        this.player.volume = value;
      },
    },
    playing() {
      return this.player.playing;
    },
    audioSource() {
      return this.player._howler?._src.includes('kuwo.cn')
        ? '音源来自酷我音乐'
        : '';
    },
    // [播客改造 A-7.11] 播放条上的时间显示
    playedTimeText() {
      return this.formatTrackTime(this.player.progress || 0);
    },
    totalTimeText() {
      return this.formatTrackTime(this.player.currentTrackDuration || 0);
    },
    // [bug 修复] 加载条起点 = 当前进度百分比
    bufferingLeftPercent() {
      const dur = this.player.currentTrackDuration || 0;
      const p = this.player.progress || 0;
      if (dur <= 0) return 0;
      return Math.min(100, Math.max(0, (p / dur) * 100));
    },
    // [播客改造 A-21] 倍速显示固定 1 位小数（步进 0.1 不会有更多位数）
    rateLabel() {
      return this.playbackRate.toFixed(1);
    },
    rateButtonText() {
      return this.rateLabel + 'x';
    },
    // [播客改造 A-7.1] 当前 track 是否已收藏：播客走本地表，网易云走原 store.liked.songs
    isFavorited() {
      const t = this.player && this.player.currentTrack;
      if (!t) return false;
      if (t.podcastEpisodeId) {
        const ids =
          (this.$store.state.podcastFavorites &&
            this.$store.state.podcastFavorites.episodeIds) ||
          [];
        return ids.includes(t.podcastEpisodeId);
      }
      return !!this.player.isCurrentTrackLiked;
    },
  },
  mounted() {
    this.setupMediaControls();
    window.addEventListener('keydown', this.handleKeydown);
    // [播客改造 A-6] 从 player 状态恢复倍速（持久化由 store 的 Proxy 自动完成）
    if (this.player && typeof this.player.playbackRate === 'number') {
      this.playbackRate = this.player.playbackRate;
    }
  },
  beforeDestroy() {
    window.removeEventListener('keydown', this.handleKeydown);
    // [播客改造 A-6] 卸载倍速面板的"点击外部关闭"监听
    this.closeRateMenu();
  },
  methods: {
    ...mapMutations(['toggleLyrics']),
    ...mapActions(['showToast', 'likeATrack']),
    handleClick(event) {
      // [播客改造] 屏蔽"点 bar 空白处展开沉浸式播放页"——播客不是高频操作，
      // 用户后续可能加回。右下角"展开"按钮（lyrics-button）仍可用。
      // 改回逻辑：把下方 if 块的注释去掉即可。
      // if (event.target == this.mouseDownTarget) {
      //   this.toggleLyrics();
      // }
      void event;
    },
    // [播客改造] 检测单集名是否溢出，决定是否启用跑马灯
    checkNameOverflow() {
      this.$nextTick(() => {
        const wrap = this.$refs.nameWrap;
        const txt = this.$refs.nameText;
        if (!wrap || !txt) return;
        this.nameOverflow = txt.scrollWidth > wrap.clientWidth + 2;
      });
    },
    // [播客改造 A-7.8] 进度条 hover 时根据鼠标位置算对应时间
    onProgressHover(e) {
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const ratio = x / rect.width;
      const dur = this.player.currentTrackDuration || 0;
      this.hoverTime = Math.floor(ratio * dur);
      this.hoverX = x;
    },
    // [播客改造] 倍速面板滚轮调节：向上 +0.1，向下 -0.1，夹在 [0.5, 3]
    onRateWheel(e) {
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      this.setRate(this.playbackRate + delta);
    },
    // [播客改造 A-7.4] 鼠标滚轮调音量：向上滚增加、向下滚减少；步长 0.05；夹在 [0, 1]
    onVolumeWheel(e) {
      const step = 0.05;
      const delta = e.deltaY < 0 ? step : -step;
      const next = Math.max(0, Math.min(1, this.volume + delta));
      // 用 setter 触发 player.volume = next（已带 howler.volume 同步）
      this.volume = Math.round(next * 100) / 100;
    },
    // [播客改造 A-7.1] 点击爱心：播客 → 本地收藏切换；网易云 → 原 likeATrack action
    toggleFavorite() {
      const t = this.player && this.player.currentTrack;
      if (!t) return;
      if (t.podcastEpisodeId) {
        this.$store.dispatch('togglePodcastFavorite', t);
      } else if (t.id) {
        this.likeATrack(t.id);
      }
    },
    // [播客改造 A-21] 倍速：步进 0.1，0.5-3 范围
    setRate(rate) {
      const r =
        Math.round(Math.max(0.5, Math.min(3, Number(rate) || 1)) * 10) / 10;
      this.playbackRate = r;
      this.player.playbackRate = r;
    },
    // [播客改造 A-6] 倍速面板开关与关闭策略（点击外部关闭，而非 mouseleave）
    toggleRateMenu() {
      if (this.rateMenuOpen) {
        this.closeRateMenu();
      } else {
        this.openRateMenu();
      }
    },
    openRateMenu() {
      this.rateMenuOpen = true;
      // 下一帧挂监听，避免捕获到当前的"打开"点击事件本身导致立即关闭
      this.$nextTick(() => {
        this.rateOutsideListener = ev => {
          const root = this.$refs.rateControl;
          if (root && !root.contains(ev.target)) {
            this.closeRateMenu();
          }
        };
        document.addEventListener('mousedown', this.rateOutsideListener);
      });
    },
    closeRateMenu() {
      this.rateMenuOpen = false;
      if (this.rateOutsideListener) {
        document.removeEventListener('mousedown', this.rateOutsideListener);
        this.rateOutsideListener = null;
      }
    },
    handleMouseDown(event) {
      this.mouseDownTarget = event.target;
    },
    playPrevTrack() {
      this.player.playPrevTrack();
    },
    // [播客改造 A-7.7] 后退 15 秒
    seekBackward15() {
      const cur = this.player.seek();
      this.player.seek(Math.max(0, (cur || 0) - 15));
    },
    // [播客改造 A-7.7] 前进 30 秒（夹住时长上限，避免超过结尾）
    seekForward30() {
      const cur = this.player.seek();
      const dur = this.player.currentTrackDuration || 0;
      const next = Math.min(Math.max(0, dur - 1), (cur || 0) + 30);
      this.player.seek(next);
    },
    playOrPause() {
      this.player.playOrPause();
    },
    playNextTrack() {
      if (this.player.isPersonalFM) {
        this.player.playNextFMTrack();
      } else {
        this.player.playNextTrack();
      }
    },
    goToNextTracksPage() {
      if (this.player.isPersonalFM) return;
      this.$route.name === 'next'
        ? this.$router.go(-1)
        : this.$router.push({ name: 'next' });
    },
    formatTrackTime(value) {
      return formatTrackTime(value);
    },
    hasList() {
      return hasListSource();
    },
    goToList() {
      goToListSource();
    },
    goToAlbum() {
      if (this.player.currentTrack.al.id === 0) return;
      this.$router.push({ path: '/album/' + this.player.currentTrack.al.id });
    },
    goToArtist(id) {
      this.$router.push({ path: '/artist/' + id });
    },
    moveToFMTrash() {
      this.player.moveToFMTrash();
    },
    switchRepeatMode() {
      this.player.switchRepeatMode();
    },
    switchShuffle() {
      this.player.switchShuffle();
    },
    switchReversed() {
      this.player.switchReversed();
    },
    mute() {
      this.player.mute();
    },

    setupMediaControls() {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', () => {
          this.playOrPause();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          this.playOrPause();
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
          this.playPrevTrack();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
          this.playNextTrack();
        });
      }
    },

    handleKeydown(event) {
      switch (event.code) {
        case 'MediaPlayPause':
          this.playOrPause();
          break;
        case 'MediaTrackPrevious':
          this.playPrevTrack();
          break;
        case 'MediaTrackNext':
          this.playNextTrack();
          break;
        default:
          break;
      }
    },
  },
};
</script>

<style lang="scss" scoped>
.player {
  position: fixed;
  bottom: 0;
  right: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  height: 64px;
  backdrop-filter: saturate(180%) blur(30px);
  // background-color: rgba(255, 255, 255, 0.86);
  background-color: var(--color-navbar-bg);
  z-index: 100;
}

@supports (-moz-appearance: none) {
  .player {
    background-color: var(--color-body-bg);
  }
}

.progress-bar {
  margin-top: -6px;
  margin-bottom: -6px;
  width: 100%;
  position: relative; // [播客改造 A-7.8] 让 hover-tip absolute 相对它定位
}
// [播客改造] hover 进度条时不再放大小白点（与 hover 时间预览功能重叠），
// 只在真正拖动时显示 dot。需写在 scoped 之外，否则 ::v-deep 选不到 vue-slider 内部 DOM
.progress-bar ::v-deep .vue-slider:hover .vue-slider-dot-handle {
  visibility: hidden;
}
.progress-bar ::v-deep .vue-slider:active .vue-slider-dot-handle {
  visibility: visible;
}
// [C-14 / bug 修复] 缓冲条：从 :style="left=当前进度%" 起点开始，
// 向右一段距离循环移动，营造"正在加载"感
.buffering-bar {
  position: absolute;
  top: 50%;
  height: 2px;
  width: 80px;
  background: var(--color-primary);
  border-radius: 2px;
  pointer-events: none;
  z-index: 5;
  animation: bufferingMove 1.2s ease-in-out infinite;
  transform-origin: left center;
}
@keyframes bufferingMove {
  0% {
    transform: translate(0, -50%) scaleX(0.3);
    opacity: 0.45;
  }
  50% {
    transform: translate(40px, -50%) scaleX(1);
    opacity: 0.9;
  }
  100% {
    transform: translate(90px, -50%) scaleX(0.3);
    opacity: 0.45;
  }
}

// [播客改造 A-7.8] 进度条 hover 时间小气泡：跟主题色一致，不扎眼，位置稍下移但不紧贴
.progress-hover-tip {
  position: absolute;
  bottom: calc(100% + 2px);
  transform: translateX(-50%);
  background: var(--color-body-bg);
  color: var(--color-text);
  font-size: 11px;
  font-weight: 600;
  padding: 3px 7px;
  border-radius: 5px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 110; // 高于卡片封面（卡片大约 z=1），确保压在所有内容之上
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12),
    0 0 0 1px var(--color-secondary-bg-for-transparent);
  opacity: 0.95;
}

.controls {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  height: 100%;
  // [播客改造] 收紧两边内边距，全屏时不再"显得太空"；
  // 自适应 clamp：小屏 16px，大屏 32px，中等屏在两者之间
  padding: 0 clamp(16px, 1.8vw, 32px);
}

.blank {
  flex-grow: 1;
}

.playing {
  display: flex;
}

.playing .container {
  display: flex;
  align-items: center;
  img {
    height: 46px;
    border-radius: 5px;
    box-shadow: 0 6px 8px -2px rgba(0, 0, 0, 0.16);
    cursor: pointer;
    user-select: none;
  }
  .track-info {
    height: 46px;
    margin-left: 12px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    .name {
      font-weight: 600;
      font-size: 16px;
      opacity: 0.88;
      color: var(--color-text);
      margin-bottom: 4px;
      overflow: hidden;
      white-space: nowrap;
      .name-text {
        display: inline-block;
        text-overflow: ellipsis;
        overflow: hidden;
        max-width: 100%;
        vertical-align: middle;
      }
      // [播客改造] 跑马灯：仅在 hover 且文本溢出时启用
      &.marquee:hover .name-text {
        animation: marquee 12s linear infinite;
        max-width: none;
        overflow: visible;
        padding-right: 40px;
      }
    }
    @keyframes marquee {
      0% {
        transform: translateX(0);
      }
      15% {
        transform: translateX(0);
      }
      90% {
        transform: translateX(calc(-100% + 100px));
      }
      100% {
        transform: translateX(calc(-100% + 100px));
      }
    }
    // [播客改造] artist 行里时间显示样式（字号与节目名/作者一致 = 12px）
    .time {
      font-variant-numeric: tabular-nums;
      opacity: 0.8;
      margin-left: 4px;
    }
    .has-list {
      cursor: pointer;
      &:hover {
        text-decoration: underline;
      }
    }
    .artist {
      font-size: 12px;
      opacity: 0.58;
      color: var(--color-text);
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 1;
      overflow: hidden;
      word-break: break-all;
      span.ar {
        cursor: pointer;
        &:hover {
          text-decoration: underline;
        }
      }
    }
  }
}

.middle-control-buttons {
  display: flex;
}

.middle-control-buttons .container {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 0 8px;
  .button-icon {
    margin: 0 8px;
  }
  .play {
    height: 42px;
    width: 42px;
    .svg-icon {
      width: 24px;
      height: 24px;
    }
  }
}

.right-control-buttons {
  display: flex;
}

.right-control-buttons .container {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  .expand {
    margin-left: 24px;
    .svg-icon {
      height: 24px;
      width: 24px;
    }
  }
  .active .svg-icon {
    color: var(--color-primary);
  }
  .volume-control {
    margin-left: 4px;
    display: flex;
    align-items: center;
    .volume-bar {
      width: 84px;
    }
  }
}

.like-button {
  margin-left: 16px;
  // [播客改造 A-7.1] 已收藏：爱心变红
  &.favorited .svg-icon {
    color: #e74c3c;
  }
}

.button-icon.disabled {
  cursor: default;
  opacity: 0.38;
  &:hover {
    background: none;
  }
  &:active {
    transform: unset;
  }
}

// [播客改造 A-6] 倍速按钮 + 弹出面板
.rate-control {
  position: relative;
  display: flex;
  align-items: center;
  margin-right: 4px;
}
.rate-button {
  background: transparent;
  color: var(--color-text);
  font-weight: 600;
  font-size: 13px;
  padding: 4px 6px;
  border-radius: 8px;
  cursor: pointer;
  opacity: 0.78;
  transition: 0.2s;
  // [播客改造] 固定宽度避免文本变化（1x → 1.25x → 2x）推动右侧按钮
  width: 56px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
    opacity: 1;
  }
  &.active {
    color: var(--color-primary);
    opacity: 1;
  }
}
.rate-menu {
  position: absolute;
  bottom: calc(100% + 12px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--color-body-bg);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18),
    0 0 0 1px rgba(127, 127, 127, 0.12);
  padding: 10px 12px;
  width: 200px;
  z-index: 110;
  color: var(--color-text); // 主题色继承给所有内部文本
}
// [播客改造] 强制覆盖 vue-slider 内部残留的黑色（深色模式必读）
.rate-menu ::v-deep .vue-slider-dot-tooltip-inner,
.rate-menu ::v-deep .vue-slider-dot-tooltip-text {
  color: var(--color-text) !important;
  background-color: var(--color-body-bg) !important;
  border-color: var(--color-body-bg) !important;
}
// [播客改造 A-21] 倍速面板紧凑化：高度只占滑条 + padding
.rate-slider {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 2px 2px;
  .r-label {
    font-size: 12px;
    font-weight: 600;
    opacity: 0.7;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums; // 字符等宽，slider 起点稳定
  }
  .vue-slider {
    flex: 1;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}
.fade-enter,
.fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(4px);
}
</style>
