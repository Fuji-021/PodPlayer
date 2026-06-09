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
          <!-- [B-63] 播放栏封面：小幅 hover 微动+光晕（力度/光晕比首页小一档） -->
          <div class="cover-box">
            <div
              class="cover-glow"
              :style="{ backgroundImage: `url(${coverSrc})` }"
            ></div>
            <img
              class="cover-img"
              :class="{ 'cover-loaded': coverLoaded }"
              :src="coverSrc"
              @load="coverLoaded = true"
              @click="goToAlbumOrPodcast"
            />
          </div>
          <div class="track-info" :title="audioSource">
            <!-- [播客改造] 单集名：超出容器宽度时 hover 跑马灯滚动；
                 内层 span 用 transform 平移实现，需配合 JS 检测溢出 -->
            <!-- [B-31] 点击单集名：网易云 → 跳列表；播客 → 跳单集详情 -->
            <div
              ref="nameWrap"
              :class="[
                'name',
                {
                  'has-list': hasList() || isPodcastTrack,
                  marquee: nameOverflow,
                },
              ]"
              @click="onClickName"
              @mouseenter="checkNameOverflow"
            >
              <span ref="nameText" class="name-text">{{
                currentTrack.name
              }}</span>
            </div>
            <!-- [播客改造] artist 行同时展示节目名和"已播/总时长"，时间字号与节目名一致 -->
            <!-- [B-31] 点击节目名（播客）→ 跳节目详情 -->
            <div class="artist">
              <!-- [B-34] 节目名可省略，时间进度 flex-shrink:0 永不截断 → 保证时间看全 -->
              <span class="ar-names">
                <span
                  v-for="(ar, index) in currentTrack.ar"
                  :key="ar.id"
                  @click="onClickArtist(ar)"
                >
                  <span :class="{ ar: ar.id || isPodcastTrack }">
                    {{ ar.name }} </span
                  ><span v-if="index !== currentTrack.ar.length - 1">, </span>
                </span>
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
        <!-- [B-36] 删掉 .playing 里的 blank：它和 container 都 flex-grow:1 平分左列，
             导致 container 只占一半、右侧一大块空白。删后 container 撑满左列，
             节目名+时间获得全部宽度，离三大金刚更近。 -->
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
          <!-- [A-24] 播放队列按钮：弹原位小弹窗显示队列（非全屏） -->
          <div ref="queueControl" class="queue-control" @click.stop>
            <button-icon
              :class="{ active: queuePanelOpen }"
              @click.native="toggleQueuePanel"
              ><svg-icon icon-class="queue"
            /></button-icon>
            <transition name="queue-pop">
              <div v-if="queuePanelOpen" class="queue-panel" @click.stop>
                <div class="qp-head">
                  <span>播放列表 ({{ podcastQueue.length }})</span>
                  <button
                    v-if="podcastQueue.length"
                    class="qp-clear"
                    @click="clearQueue"
                  >
                    清空
                  </button>
                </div>
                <div v-if="!podcastQueue.length" class="qp-empty">
                  队列空空。在节目里加入单集后会出现在这里。
                </div>
                <div v-else class="qp-list">
                  <div
                    v-for="(item, idx) in podcastQueue.slice(0, 10)"
                    :key="item.id"
                    class="qp-item"
                    :class="{ 'drag-over': dragOverIdx === idx }"
                    draggable="true"
                    @click="playFromQueue(item)"
                    @dragstart="onQueueDragStart($event, idx)"
                    @dragover.prevent="onQueueDragOver(idx)"
                    @dragleave="onQueueDragLeave(idx)"
                    @drop="onQueueDrop(idx)"
                    @dragend="onQueueDragEnd"
                  >
                    <!-- [A-24 拖动] 左侧拖动点 -->
                    <div class="qp-handle">⋮⋮</div>
                    <PodImage
                      v-if="item.coverUrl"
                      class="qp-cover"
                      :src="item.coverUrl"
                    />
                    <div class="qp-meta">
                      <div class="qp-title">{{ item.title }}</div>
                      <div class="qp-sub">{{ item.podcastTitle }}</div>
                    </div>
                    <button class="qp-del" @click.stop="removeFromQueue(item)">
                      ×
                    </button>
                  </div>
                  <div v-if="podcastQueue.length > 10" class="qp-more">
                    还有 {{ podcastQueue.length - 10 }} 项 …
                  </div>
                </div>
              </div>
            </transition>
          </div>
          <!-- [B-46] 睡眠定时器：原位弹窗（X 分钟后 / 本集结束后暂停） -->
          <div ref="sleepControl" class="sleep-control" @click.stop>
            <button-icon
              :class="{ active: sleepMode !== 'off' }"
              @click.native="toggleSleepMenu"
              ><svg-icon icon-class="moon"
            /></button-icon>
            <transition name="fade">
              <!-- [B-47] 借鉴倍速弹窗：滑条(分钟，拖动+滚轮)，设置后随倒计时自缩 -->
              <div
                v-if="sleepMenuOpen"
                class="sleep-menu"
                @click.stop
                @wheel.prevent="onSleepWheel"
              >
                <div class="sleep-slider">
                  <span class="sl-label">{{ sleepLabel }}</span>
                  <vue-slider
                    :value="sleepSliderVal"
                    :min="0"
                    :max="120"
                    :interval="5"
                    :drag-on-click="true"
                    :duration="0"
                    tooltip="none"
                    :dot-size="12"
                    @change="onSleepSlide"
                  ></vue-slider>
                </div>
                <div class="sleep-foot">
                  <button
                    class="sl-foot-btn"
                    :class="{ active: sleepMode === 'end' }"
                    @click="setSleepEnd"
                  >
                    本集结束后
                  </button>
                  <button
                    v-if="sleepMode !== 'off'"
                    class="sl-foot-btn cancel"
                    @click="cancelSleep"
                  >
                    取消
                  </button>
                </div>
              </div>
            </transition>
          </div>
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
      // [B-36] 封面加载淡入：切歌时置 false，图片 @load 后 true → opacity 过渡
      coverLoaded: false,
      // [A-24] 播放队列弹窗
      queuePanelOpen: false,
      queueOutsideListener: null,
      // [A-24 拖动] 排序状态
      dragIdx: -1,
      dragOverIdx: -1,
      // [B-46/B-47] 睡眠定时器（滑条式）
      sleepMenuOpen: false,
      sleepMode: 'off', // 'off' | 'min'(定时分钟) | 'end'(本集结束后)
      sleepTimer: null, // setTimeout 句柄（到点暂停）
      sleepInterval: null, // setInterval 句柄（每秒刷新剩余 + 滑条自缩）
      sleepEndsAt: 0, // 暂停目标时间戳(ms)
      sleepRemainText: '', // 剩余 "M:SS"
      sleepSliderVal: 0, // 滑条显示值(分钟)：未激活=0；激活=剩余分钟(随倒计时自缩)
      sleepOutsideListener: null,
    };
  },
  computed: {
    ...mapState([
      'player',
      'settings',
      'data',
      'audioBuffering',
      'podcastQueue',
    ]),
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
    // [B-31] 当前 track 是否为播客单集（用于点击 name/artist/封面跳转）
    isPodcastTrack() {
      const t = this.player.currentTrack;
      return !!(t && t.podcastEpisodeId);
    },
    // [B-36] 播放栏封面：播客用原 url（复用订阅页/节目页已下过的缓存，秒显；
    // 第三方 CDN 不支持 ?param 缩放，加了反而 cache miss 重下大图），网易云走 resizeImage。
    coverSrc() {
      const url =
        (this.currentTrack &&
          this.currentTrack.al &&
          this.currentTrack.al.picUrl) ||
        '';
      if (!url) return '';
      if (this.isPodcastTrack) return url;
      const https = url.slice(0, 5) !== 'https' ? 'https' + url.slice(4) : url;
      return `${https}?param=224y224`;
    },
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
    // [B-47] 睡眠弹窗左侧文案：未激活=关闭；定时/本集结束=剩余 M:SS
    sleepLabel() {
      if (this.sleepMode === 'off') return '关闭';
      return '剩余 ' + (this.sleepRemainText || '0:00');
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
    // [B-32] 单集名溢出检测：初次挂载 + 切歌 + 窗口缩放 都重新判断，
    // 溢出则 nameOverflow=true → .marquee 自动跑马灯（不再依赖 hover）。
    window.addEventListener('resize', this.checkNameOverflow);
    this.$watch(
      () => this.currentTrack && this.currentTrack.name,
      () => this.checkNameOverflow()
    );
    // [B-36] 封面 url 变化时先置 loading 态，等新图 @load 再淡入
    this.$watch(
      () => this.coverSrc,
      () => {
        this.coverLoaded = false;
      }
    );
    this.$nextTick(() => this.checkNameOverflow());
    // [播客改造 A-6] 从 player 状态恢复倍速（持久化由 store 的 Proxy 自动完成）
    if (this.player && typeof this.player.playbackRate === 'number') {
      this.playbackRate = this.player.playbackRate;
    }
  },
  beforeDestroy() {
    window.removeEventListener('keydown', this.handleKeydown);
    window.removeEventListener('resize', this.checkNameOverflow);
    // [播客改造 A-6] 卸载倍速面板的"点击外部关闭"监听
    this.closeRateMenu();
    // [B-46] 卸载睡眠定时器的监听与计时器
    this.closeSleepMenu();
    this.clearSleep();
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
    // [B-46] 睡眠定时器：原位弹窗开关（点外部关闭，与倍速面板同款）
    toggleSleepMenu() {
      if (this.sleepMenuOpen) {
        this.closeSleepMenu();
        return;
      }
      this.sleepMenuOpen = true;
      this.$nextTick(() => {
        this.sleepOutsideListener = ev => {
          const root = this.$refs.sleepControl;
          if (root && !root.contains(ev.target)) this.closeSleepMenu();
        };
        document.addEventListener('mousedown', this.sleepOutsideListener);
      });
    },
    closeSleepMenu() {
      this.sleepMenuOpen = false;
      if (this.sleepOutsideListener) {
        document.removeEventListener('mousedown', this.sleepOutsideListener);
        this.sleepOutsideListener = null;
      }
    },
    // [B-47] 滑条拖动/点击：val=分钟(0=关闭)。设置后不关弹窗，便于看滑块自缩。
    onSleepSlide(val) {
      const min = Number(val) || 0;
      if (min <= 0) {
        this.cancelSleep();
        return;
      }
      this.applySleep(min * 60 * 1000, 'min');
    },
    // [B-47] 滚轮调节：每格 ±5 分钟（借鉴倍速滚轮）
    onSleepWheel(e) {
      const step = e.deltaY < 0 ? 5 : -5;
      const base = this.sleepMode === 'off' ? 0 : this.sleepSliderVal;
      this.onSleepSlide(Math.max(0, Math.min(120, base + step)));
    },
    // [B-47] 本集结束后暂停
    setSleepEnd() {
      const dur = this.player.currentTrackDuration || 0;
      const pos = this.player.progress || 0;
      this.applySleep(Math.max(0, (dur - pos) * 1000), 'end');
    },
    // [B-47] 应用睡眠：ms 后暂停，每秒刷新剩余 + 滑条自缩
    applySleep(ms, mode) {
      this.clearSleep();
      this.sleepMode = mode;
      this.sleepEndsAt = Date.now() + ms;
      this.sleepTimer = setTimeout(() => this.fireSleep(), ms);
      this.updateSleepRemain();
      this.sleepInterval = setInterval(() => this.updateSleepRemain(), 1000);
    },
    cancelSleep() {
      this.clearSleep();
      this.sleepMode = 'off';
      this.sleepRemainText = '';
      this.sleepSliderVal = 0;
    },
    updateSleepRemain() {
      const left = Math.max(0, this.sleepEndsAt - Date.now());
      const totalSec = Math.round(left / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      this.sleepRemainText = `${m}:${String(s).padStart(2, '0')}`;
      // [B-47] 滑条值随倒计时自缩（向上取整到分钟）
      this.sleepSliderVal = Math.ceil(left / 60000);
    },
    fireSleep() {
      if (
        this.player &&
        this.player.playing &&
        typeof this.player.pause === 'function'
      ) {
        this.player.pause();
      }
      this.clearSleep();
      this.sleepMode = 'off';
      this.sleepRemainText = '';
      this.sleepSliderVal = 0;
      this.showToast('睡眠定时已到，已暂停播放');
    },
    clearSleep() {
      if (this.sleepTimer) {
        clearTimeout(this.sleepTimer);
        this.sleepTimer = null;
      }
      if (this.sleepInterval) {
        clearInterval(this.sleepInterval);
        this.sleepInterval = null;
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
    // [A-24] 队列弹窗控制
    toggleQueuePanel() {
      if (this.queuePanelOpen) {
        this.closeQueuePanel();
      } else {
        this.openQueuePanel();
      }
    },
    openQueuePanel() {
      this.queuePanelOpen = true;
      this.$nextTick(() => {
        this.queueOutsideListener = ev => {
          const root = this.$refs.queueControl;
          if (root && !root.contains(ev.target)) this.closeQueuePanel();
        };
        document.addEventListener('mousedown', this.queueOutsideListener);
      });
    },
    closeQueuePanel() {
      this.queuePanelOpen = false;
      if (this.queueOutsideListener) {
        document.removeEventListener('mousedown', this.queueOutsideListener);
        this.queueOutsideListener = null;
      }
    },
    playFromQueue(item) {
      // 点击就立即播放该集；从队列里删它（避免重复）
      this.$store.commit('removeFromQueue', item.id);
      this.player.playPodcastEpisode(
        {
          id: item.id,
          guid: item.guid,
          title: item.title,
          audioUrl: item.audioUrl,
          coverUrl: item.coverUrl,
          duration: item.duration,
          podcastId: item.podcastId,
        },
        item.podcastTitle || ''
      );
      this.closeQueuePanel();
    },
    removeFromQueue(item) {
      this.$store.commit('removeFromQueue', item.id);
    },
    clearQueue() {
      this.$store.commit('clearQueue');
    },
    // [A-24 拖动排序]
    onQueueDragStart(e, idx) {
      this.dragIdx = idx;
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', String(idx));
      } catch (_) {
        /* ignore */
      }
    },
    onQueueDragOver(idx) {
      this.dragOverIdx = idx;
    },
    onQueueDragLeave(idx) {
      if (this.dragOverIdx === idx) this.dragOverIdx = -1;
    },
    onQueueDrop(idx) {
      if (this.dragIdx < 0 || this.dragIdx === idx) {
        this.onQueueDragEnd();
        return;
      }
      const list = [...this.podcastQueue];
      const [moved] = list.splice(this.dragIdx, 1);
      list.splice(idx, 0, moved);
      this.$store.commit('setQueue', list);
      this.onQueueDragEnd();
    },
    onQueueDragEnd() {
      this.dragIdx = -1;
      this.dragOverIdx = -1;
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
    // [B-31] 点击播放栏：单集名 / 节目名 / 封面 — 播客优先
    onClickName() {
      if (this.isPodcastTrack) {
        this.goToEpisodeDetail();
        return;
      }
      if (this.hasList()) this.goToList();
    },
    onClickArtist(ar) {
      if (this.isPodcastTrack) {
        this.goToPodcastDetail();
        return;
      }
      if (ar.id) this.goToArtist(ar.id);
    },
    goToAlbumOrPodcast() {
      if (this.isPodcastTrack) {
        this.goToPodcastDetail();
        return;
      }
      this.goToAlbum();
    },
    goToPodcastDetail() {
      const t = this.player.currentTrack;
      const epId = t && t.podcastEpisodeId;
      if (!epId) return;
      // episodeId 格式：`${feedUrl}::${guid}`
      const idx = epId.indexOf('::');
      const feedUrl = idx > 0 ? epId.slice(0, idx) : epId;
      this.$router.push({
        name: 'podcastDetail',
        params: { feedUrlEncoded: encodeURIComponent(feedUrl) },
      });
    },
    goToEpisodeDetail() {
      const t = this.player.currentTrack;
      const epId = t && t.podcastEpisodeId;
      if (!epId) return;
      const idx = epId.indexOf('::');
      if (idx <= 0) return;
      const feedUrl = epId.slice(0, idx);
      const guid = epId.slice(idx + 2);
      this.$router.push({
        name: 'episodeDetail',
        params: {
          feedUrlEncoded: encodeURIComponent(feedUrl),
          guidEncoded: encodeURIComponent(guid),
        },
      });
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
  // [B-30 bar 修] 之前为了底部 Win32 resize 边留 4px 透明，
  // 但用户反馈"中间能看到背景"——左右上下都有 4px 缝。改成贴底贴左右，
  // 失去底部 resize 是 OK 的（Spotify / Apple Music 桌面端也都贴底）。
  // 左右上三边和四角仍可 resize。
  bottom: 0;
  right: 0;
  left: 0;
  border-radius: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  height: 64px;
  backdrop-filter: saturate(180%) blur(30px);
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
// [C-14 / bug 修复] 缓冲条：从当前进度位置一直延伸到最右，
// 内部用 gradient + background-position 流动，看起来像"水流向右"
.buffering-bar {
  position: absolute;
  top: 50%;
  right: 0;
  transform: translateY(-50%);
  height: 2px;
  pointer-events: none;
  z-index: 5;
  // [B-35/B-59] 高光条占 50% 宽，从左外(-50%)平移到右外(150%) → 高光「一直向右」流动
  // （B-59 修：之前 150%→-50% 是向左，与本意相反）；两端都在视野外，循环跳变不可见。
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--color-primary) 50%,
    transparent 100%
  );
  background-size: 50% 100%;
  background-repeat: no-repeat;
  animation: bufferingFlow 1.2s linear infinite;
  opacity: 0.85;
}
@keyframes bufferingFlow {
  0% {
    background-position: -50% 0;
  }
  100% {
    background-position: 150% 0;
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
  // [B-32] 中间列 auto = 三大金刚自然宽度，左右 minmax(0,1fr) 等分剩余空间。
  // 因左右 fr 相等 → 中间块恒居容器正中 = 窗口正中（锚点，不随缩放漂移）。
  // minmax(0,...) 的 min=0 让左右内容超长时收缩/省略，而不是撑大列把中间挤偏。
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
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
  min-width: 0; // [B-32] 允许左列收缩 → 长名字触发省略/跑马灯而非撑破布局
}

.playing .container {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1;
  // [B-63] 封面外框：小幅 hover 微动 + 光晕（尺度比首页小一档）
  .cover-box {
    position: relative;
    flex-shrink: 0;
    width: 46px;
    height: 46px;
    transition: transform 0.22s ease-out;
    &:hover {
      transform: scale(1.06);
    }
    &:hover .cover-glow {
      filter: blur(12px) opacity(0.5);
    }
  }
  .cover-glow {
    position: absolute;
    inset: 0;
    border-radius: 5px;
    background-size: cover;
    background-position: center;
    filter: blur(7px) opacity(0.32);
    transform: scale(0.9);
    z-index: 0;
    pointer-events: none;
  }
  img {
    position: relative;
    z-index: 1;
    height: 46px;
    width: 46px;
    object-fit: cover;
    border-radius: 5px;
    box-shadow: 0 6px 8px -2px rgba(0, 0, 0, 0.16);
    cursor: pointer;
    user-select: none;
    // [B-36] 封面淡入：默认半透明，加载完 .cover-loaded → opacity 1，避免"生硬蹦出"
    opacity: 0.35;
    transition: opacity 0.28s ease;
    &.cover-loaded {
      opacity: 1;
    }
  }
  .track-info {
    flex: 1;
    min-width: 0; // [B-32] 配合 name 的 overflow:hidden 让长名字省略 + 跑马灯
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
      // [B-33] 跑马灯：仅 hover 且溢出时启用；单向 linear 循环（非来回往返）。
      // 平时（非 hover）溢出名字显示省略号；能完整显示的根本不会有 .marquee class。
      &.marquee:hover .name-text {
        animation: marquee 9s linear infinite;
        max-width: none;
        overflow: visible;
        padding-right: 48px; // 一轮结束与下一轮开始之间的空隙
      }
    }
    @keyframes marquee {
      0%,
      8% {
        transform: translateX(0);
      }
      100% {
        transform: translateX(-100%);
      }
    }
    // [播客改造] artist 行里时间显示样式（字号与节目名/作者一致 = 12px）
    // [B-34] flex-shrink:0 + nowrap → 时间进度永远完整显示，不被节目名挤掉
    .time {
      font-variant-numeric: tabular-nums;
      opacity: 0.8;
      margin-left: 4px;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .has-list {
      cursor: pointer;
      &:hover {
        text-decoration: underline;
      }
    }
    // [B-34] artist 改 flex：节目名可省略号，时间不缩。原来 line-clamp 整行截断会把时间也切掉。
    .artist {
      font-size: 12px;
      opacity: 0.58;
      color: var(--color-text);
      display: flex;
      align-items: center;
      overflow: hidden;
      .ar-names {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
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

// [A-24] 播放队列：原位小弹窗（贴底部播放条上方）
.queue-control {
  position: relative;
}
// [A-24 改] 从下方往上展开 + 以图标为视觉锚点（origin: 78% 100%）
.queue-pop-enter-active,
.queue-pop-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.queue-pop-enter,
.queue-pop-leave-to {
  opacity: 0;
  transform: translateX(-78%) translateY(14px) scale(0.92);
}
.queue-panel {
  position: absolute;
  // [B-37] 修：面板用 body-bg 深底，但没显式设字色 → 文字继承默认黑，深色模式下看不清。
  color: var(--color-text);
  bottom: calc(100% + 14px);
  // [A-24 改] 大致以图标为中心展开（图标在 panel 右下角偏 22% 位置）
  left: 50%;
  transform: translateX(-78%);
  transform-origin: 78% 100%;
  width: 360px;
  max-height: 460px;
  background: var(--color-body-bg);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22),
    0 0 0 1px var(--color-secondary-bg-for-transparent);
  z-index: 110;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  .qp-head {
    padding: 12px 16px;
    font-weight: 700;
    font-size: 14px;
    border-bottom: 1px solid var(--color-secondary-bg-for-transparent);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .qp-clear {
    background: transparent;
    color: var(--color-text);
    opacity: 0.5;
    font-size: 12px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    &:hover {
      opacity: 1;
      color: #e74c3c;
    }
  }
  .qp-empty {
    padding: 32px 16px;
    text-align: center;
    font-size: 12px;
    opacity: 0.5;
  }
  .qp-list {
    overflow-y: auto;
    max-height: 380px;
  }
  .qp-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--color-secondary-bg-for-transparent);
    transition: 0.12s;
    &:hover {
      background: var(--color-secondary-bg-for-transparent);
    }
    &.drag-over {
      background: var(--color-primary-bg-for-transparent);
      box-shadow: inset 0 2px 0 var(--color-primary);
    }
    .qp-handle {
      cursor: grab;
      opacity: 0.35;
      font-size: 14px;
      line-height: 1;
      letter-spacing: -2px;
      user-select: none;
      padding: 2px 4px;
      &:hover {
        opacity: 0.85;
      }
      &:active {
        cursor: grabbing;
      }
    }
    .qp-cover {
      width: 38px;
      height: 38px;
      border-radius: 6px;
      object-fit: cover;
      flex-shrink: 0;
    }
    .qp-meta {
      flex: 1;
      min-width: 0;
    }
    .qp-title {
      font-size: 13px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .qp-sub {
      font-size: 11px;
      opacity: 0.55;
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .qp-del {
      background: transparent;
      color: var(--color-text);
      opacity: 0.4;
      font-size: 16px;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      cursor: pointer;
      flex-shrink: 0;
      &:hover {
        opacity: 1;
        color: #e74c3c;
      }
    }
  }
  .qp-more {
    padding: 8px 16px;
    text-align: center;
    font-size: 11px;
    opacity: 0.45;
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

// [B-46] 睡眠定时器弹窗（与倍速面板同款向上锚定）
.sleep-control {
  position: relative;
  display: flex;
  align-items: center;
}
.sleep-menu {
  position: absolute;
  bottom: calc(100% + 12px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--color-body-bg);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18),
    0 0 0 1px rgba(127, 127, 127, 0.12);
  padding: 10px 12px;
  width: 220px;
  z-index: 110;
  color: var(--color-text);
}
// [B-47] 睡眠滑条：与倍速面板同款（左 label + 滑条，可拖动/滚轮）
.sleep-slider {
  display: flex;
  align-items: center;
  gap: 10px;
  .sl-label {
    font-size: 12px;
    font-weight: 600;
    opacity: 0.7;
    flex-shrink: 0;
    white-space: nowrap;
    min-width: 56px;
    font-variant-numeric: tabular-nums;
  }
  .vue-slider {
    flex: 1;
  }
}
.sleep-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  .sl-foot-btn {
    background: transparent;
    color: var(--color-text);
    opacity: 0.6;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    padding: 3px 6px;
    border-radius: 6px;
    transition: 0.15s;
    &:hover {
      opacity: 1;
      background: var(--color-secondary-bg-for-transparent);
    }
    &.active {
      color: var(--color-primary);
      opacity: 1;
    }
    &.cancel:hover {
      color: #e74c3c;
      background: transparent;
    }
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
