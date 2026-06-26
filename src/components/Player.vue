<template>
  <!-- [沉浸式播放页 P0] display:contents 包一层：原 .player bar 的盒子/定位/层叠完全不变(零回归)，
       只是多出一个全屏 overlay 兄弟节点。沉浸页是「叠加皮肤」——复用本组件全部播放状态与方法
       (同一 howler 实例、同一份 Vuex)，严禁另起播放逻辑或复制状态。详见 docs/沉浸式播放页方案.md。 -->
  <div class="player-root">
    <!-- [睡眠到点关机] 可取消的关机倒计时浮层(全屏最高层)：到 0 才真请求关机，期间随时"取消关机"，绝不误关 -->
    <transition name="fade">
      <div v-if="shutdownCountdown > 0" class="shutdown-overlay">
        <div class="shutdown-card">
          <svg-icon icon-class="moon" class="sd-icon" />
          <div class="sd-title">睡眠定时已到</div>
          <div class="sd-desc">
            系统将在 <b>{{ shutdownCountdown }}</b> 秒后关机
          </div>
          <button class="sd-cancel" @click="cancelShutdown">取消关机</button>
        </div>
      </div>
    </transition>
    <div class="player" @click="handleClick" @mousedown="handleMouseDown">
      <!-- [播客改造 A-7.8] 进度条 hover 时间预览：鼠标在任意位置浮动时显示对应时间 -->
      <div
        ref="progressBarEl"
        class="progress-bar"
        :class="{
          nyancat: settings.nyancatStyle,
          'nyancat-stop': settings.nyancatStyle && !player.playing,
        }"
        :style="{ '--prog-fill': coverFillColor }"
        @click.stop
        @mousemove="onProgressHover"
        @mouseleave="hoverTime = null"
      >
        <!-- [播客改造] 关掉 vue-slider 自带的 tooltip（与下方 .progress-hover-tip 重叠）；
           dot 默认放大效果在 CSS 里抑制（见下方 .progress-bar .vue-slider-dot） -->
        <vue-slider
          :key="'pb-' + progressBarKey"
          ref="progressSlider"
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
          :style="{ left: 'clamp(32px, ' + hoverX + 'px, calc(100% - 32px))' }"
        >
          {{ formatTrackTime(hoverTime) }}
        </div>
        <!-- [C-14 bug-2] 加载中：从当前进度位置开始往右移动的小条 -->
        <div
          v-if="audioBuffering"
          class="buffering-bar"
          :style="{ left: bufferingLeftPercent + '%' }"
        ></div>
        <!-- [B-75] 标记位置：进度条上每个标记一条细蓝标(封面主色)，纯展示、点击无反馈(pointer-events:none) -->
        <div
          v-for="(mk, i) in currentMarks"
          :key="'mk' + i"
          class="prog-mark"
          :style="{ left: markPct(mk) + '%', background: markContrastColor }"
        ></div>
        <!-- [B-77] 标记提示：hover 标记键时在**播放头正上方**浮出"标记此刻"(随进度跟着走)，
           替代原来贴在按钮上、又方又带异色描边的原生 title。 -->
        <div
          v-if="markHovering"
          class="mark-hint-tip"
          :style="{
            left: 'clamp(32px, ' + progressPercent + '%, calc(100% - 32px))',
          }"
        >
          标记此刻
        </div>
      </div>
      <div class="controls">
        <div class="playing">
          <!-- [BUG1] 删掉左列 container 整体 @click.stop：原本它撑满整个左列、把"金刚键左边空白"
               也吃掉 → 点左边不进沉浸(右边能)。改为只给内部真控件各自 @click.stop，container 空白
               冒泡到 .player → 左右对称进沉浸。 -->
          <div class="container">
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
                @error="coverLoaded = true"
                @click.stop="goToAlbumOrPodcast"
              />
            </div>
            <div v-tip="audioSource" class="track-info">
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
                @click.stop="onClickName"
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
                    @click.stop="onClickArtist(ar)"
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
                v-tip="isFavorited ? '取消收藏' : '收藏'"
                @click.native.stop="toggleFavorite"
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
              v-tip="'后退 15 秒'"
              @click.native="seekBackward15"
              ><svg-icon icon-class="previous"
            /></button-icon>
            <button-icon
              v-show="player.isPersonalFM"
              v-tip="'不喜欢'"
              @click.native="moveToFMTrash"
              ><svg-icon icon-class="thumbs-down"
            /></button-icon>
            <button-icon
              v-tip="$t(player.playing ? 'player.pause' : 'player.play')"
              class="play"
              @click.native="playOrPause"
            >
              <svg-icon :icon-class="player.playing ? 'pause' : 'play'"
            /></button-icon>
            <button-icon v-tip="'前进 30 秒'" @click.native="seekForward30"
              ><svg-icon icon-class="next"
            /></button-icon>
          </div>
          <div class="blank"></div>
        </div>
        <div class="right-control-buttons">
          <!-- [B-76] 标记位置键：放在右列**最左**(blank 之前) → 紧贴金刚键"前进30秒"右侧、
             与左侧"收藏"以播放为对称中心；blank 把倍速等推到右边、自然拉开距离(不再贴倍速)。
             短按=标记此刻(图标轻弹、不变色)；长按 3 秒=清空本集全部标记；标记 >5 变封面主色、>10 彩虹(彩蛋)。 -->
          <div
            v-if="isPodcastTrack"
            class="mark-control"
            :class="{
              charging: markCharging,
              pulse: markPulse,
              cleared: markCleared,
              rainbow: markCount > 10,
            }"
            :style="
              markCount > 5 && markCount <= 10 ? { color: markColor } : null
            "
            @click.stop
            @mouseenter="markHovering = true"
            @mousedown.stop="onMarkPressStart"
            @mouseup="onMarkPressEnd"
            @mouseleave="onMarkLeave"
          >
            <span class="mark-charge"></span>
            <svg-icon class="mark-icon" icon-class="social-network" />
          </div>
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
                  <div
                    v-if="!podcastQueue.length && !nowPlayingItem"
                    class="qp-empty"
                  >
                    队列空空。在节目里加入单集后会出现在这里。
                  </div>
                  <div v-else class="qp-list">
                    <!-- [播放列表] 正在播放：sticky 置顶行(放进 qp-list 内 → 与队列行同容器、同滚动条预留，
                         × 与封面都对齐)。左侧用封面主色的播放/暂停图标占位(=⋮⋮宽，无圆圈)且可点切换；右侧 × 剔除。 -->
                    <div v-if="nowPlayingItem" class="qp-item qp-now">
                      <button
                        v-tip="playing ? '暂停' : '播放'"
                        class="qp-now-play"
                        :style="{ color: coverFillColor }"
                        @click.stop="playOrPause"
                      >
                        <svg-icon :icon-class="playing ? 'pause' : 'play'" />
                      </button>
                      <PodImage
                        v-if="nowPlayingItem.coverUrl"
                        class="qp-cover"
                        :src="nowPlayingItem.coverUrl"
                      />
                      <div class="qp-meta">
                        <div class="qp-title">{{ nowPlayingItem.title }}</div>
                        <div class="qp-sub">{{
                          nowPlayingItem.podcastTitle
                        }}</div>
                      </div>
                      <button class="qp-del" @click.stop="removeNowPlaying">
                        ×
                      </button>
                    </div>
                    <div
                      v-for="(item, idx) in podcastQueue"
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
                      <button
                        class="qp-del"
                        @click.stop="removeFromQueue(item)"
                      >
                        ×
                      </button>
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
                    <!-- [B-63] 单滑条：拖到最左=睡眠(关)；蓝色细标=本集结束(拖到此=本集结束后暂停)。
                       max 按单集剩余时间动态算(开菜单瞬时计算)，蓝标位置随之变化。 -->
                    <div class="sl-track">
                      <!-- [B-73] "本集结束"蓝标：可点(=直接设本集结束)，hover 内条轻微放大 + 冒出小提示 -->
                      <div
                        v-if="sleepMarkerPct != null"
                        class="sl-end-marker"
                        :style="{ left: sleepMarkerPct + '%' }"
                        @click.stop="onMarkerClick"
                      >
                        <i
                          class="sl-end-bar"
                          :style="{ background: sleepMarkerColor }"
                        ></i>
                        <span class="sl-end-tip">本集结束</span>
                      </div>
                      <vue-slider
                        :value="sleepSliderVal"
                        :min="0"
                        :max="sleepMaxMin"
                        :interval="sleepStep"
                        :height="4"
                        :drag-on-click="true"
                        :duration="0"
                        tooltip="none"
                        :dot-size="10"
                        @change="onSleepChange"
                        @drag-end="onSleepCommit"
                      ></vue-slider>
                    </div>
                  </div>
                </div>
              </transition>
            </div>
            <button-icon
              v-tip="
                player.repeatMode === 'one'
                  ? $t('player.repeatTrack')
                  : $t('player.repeat')
              "
              :class="{
                active: player.repeatMode !== 'off',
                disabled: player.isPersonalFM,
              }"
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
              v-tip="$t('player.shuffle')"
              :class="{ active: player.shuffle, disabled: player.isPersonalFM }"
              @click.native="switchShuffle"
              ><svg-icon icon-class="shuffle"
            /></button-icon>
            <button-icon
              v-if="settings.enableReversedMode"
              v-tip="$t('player.reversed')"
              :class="{
                active: player.reversed,
                disabled: player.isPersonalFM,
              }"
              @click.native="switchReversed"
              ><svg-icon icon-class="sort-up"
            /></button-icon>
            <!-- [播客改造 A-7.4] 滚轮调音量：在音量按钮或音量条上滚动均可 -->
            <div class="volume-control" @wheel.prevent="onVolumeWheel">
              <button-icon v-tip="$t('player.mute')" @click.native="mute">
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
                  :dot-size="10"
                ></vue-slider>
              </div>
            </div>

            <!-- [沉浸式播放页 P0] 展开沉浸页按钮：arrow-up = 向上展开全屏沉浸页。
               原 toggleLyrics(老网易云歌词页)已不适用播客，改调 toggleImmersive；歌词代码原样保留(可逆)。 -->
            <button-icon
              v-tip="'沉浸页'"
              class="lyrics-button"
              style="margin-left: 12px"
              @click.native="toggleImmersive"
              ><svg-icon icon-class="arrow-up"
            /></button-icon>
          </div>
        </div>
      </div>
    </div>
    <!-- ============ [沉浸式播放页 P0] 全屏沉浸 overlay ============
         背景=C 混合(模糊封面打底 + 三色柔和径向渐变 + 磨砂层，静态)；大封面居中 + 细胶囊进度条 +
         一行控制(三大金刚居中、倍速/队列/睡眠在左、音量在右)。所有控制复用本组件方法与状态。
         P1 已落地：全屏 maximize/ESC 退出(单击退出/双击最小化)/顶部 hover 提示气泡；P2 动态背景。 -->
    <transition name="imm-fade">
      <div v-if="immersiveOpen" class="immersive">
        <!-- 背景三层(静态) -->
        <div class="imm-bg">
          <div
            class="imm-bg-cover"
            :style="{ backgroundImage: `url(${coverSrc})` }"
          ></div>
          <div class="imm-bg-tint" :style="{ background: immBg }"></div>
          <div class="imm-bg-frost"></div>
        </div>

        <!-- 顶部原生拖拽区：允许 Windows 双击最大化/还原 + 拖动移窗口（z-index 低于收起按钮） -->
        <div class="imm-drag-bar"></div>

        <!-- 顶部：收起按钮（z-index 高于 drag-bar，点击不受 drag 影响） -->
        <div class="imm-top">
          <button-icon
            v-tip="'收起'"
            class="imm-collapse"
            @click.native="closeImmersive"
            ><svg-icon icon-class="arrow-down"
          /></button-icon>
        </div>

        <!-- 主体：封面 + 信息 + 进度 + 控制。点 col 外的空白区(stage padding)= 收起(P0 便捷退出)。
             [修冲突] 用 mousedown.self 先记弹窗状态、click.self 再决策：按下时有弹窗开着则这次只关弹窗、不退出。 -->
        <div
          class="imm-stage"
          @mousedown.self="onImmStageMouseDown"
          @click.self="onImmStageClick"
        >
          <div class="imm-col">
            <!-- 大封面：固定方槽内 scale，播放 1 / 暂停 0.82，下方布局不跳动 -->
            <div class="imm-cover-slot">
              <img
                class="imm-cover"
                :class="{ paused: !playing }"
                :src="coverSrc"
              />
            </div>

            <!-- 节目名+单集名(整行可点击跳详情)；收藏已移到下方控制行右组 -->
            <div class="imm-meta">
              <div class="imm-text">
                <div
                  v-tip="currentTrack.name"
                  class="imm-ep"
                  @click="immClickTitle"
                >
                  {{ currentTrack.name }}
                </div>
                <div
                  v-if="podcastName"
                  v-tip="podcastName"
                  class="imm-pod"
                  @click="immClickPodcast"
                >
                  {{ podcastName }}
                </div>
              </div>
            </div>

            <!-- 细胶囊进度条：首尾不显时间，仅 hover 浮出该点时间。
                 [修] 补 nyancat 彩蛋类(与 bar 一致)：彩虹猫开启时沉浸页进度条也变彩虹猫 -->
            <div
              class="imm-progress"
              :class="{
                nyancat: settings.nyancatStyle,
                'nyancat-stop': settings.nyancatStyle && !player.playing,
              }"
              @click.stop
              @mousemove="onProgressHover"
              @mouseleave="hoverTime = null"
            >
              <vue-slider
                :key="'imm-' + immProgressBarKey"
                ref="immProgressSlider"
                v-model="player.progress"
                :min="0"
                :max="player.currentTrackDuration"
                :interval="1"
                :drag-on-click="true"
                :duration="0"
                :dot-size="10"
                :height="4"
                tooltip="none"
                :lazy="true"
                :silent="true"
              ></vue-slider>
              <!-- [修] 与 bar 进度条表现一致：加载缓冲条 + 标记刻度(封面主色) + hover 标记键时的「标记此刻」 -->
              <div
                v-if="audioBuffering"
                class="buffering-bar"
                :style="{ left: bufferingLeftPercent + '%' }"
              ></div>
              <div
                v-for="(mk, i) in currentMarks"
                :key="'immk' + i"
                class="prog-mark"
                :style="{ left: markPct(mk) + '%', background: markColor }"
              ></div>
              <div
                v-if="markHovering"
                class="mark-hint-tip"
                :style="{
                  left:
                    'clamp(28px, ' + progressPercent + '%, calc(100% - 28px))',
                }"
              >
                标记此刻
              </div>
              <div
                v-if="hoverTime !== null"
                class="progress-hover-tip"
                :style="{
                  left: 'clamp(28px, ' + hoverX + 'px, calc(100% - 28px))',
                }"
              >
                {{ formatTrackTime(hoverTime) }}
              </div>
            </div>

            <!-- 一行控制：左=倍速/队列/睡眠 中=三大金刚 右=音量 -->
            <div class="imm-controls">
              <div class="imm-side imm-side-left">
                <!-- 倍速(复用 rateMenuOpen/toggleRateMenu/setRate) -->
                <div
                  ref="rateControlImm"
                  class="rate-control imm-rate"
                  @click.stop
                >
                  <button
                    v-tip="'倍速'"
                    class="rate-button"
                    :class="{ active: playbackRate !== 1 }"
                    @click="toggleRateMenu"
                  >
                    {{ rateButtonText }}
                  </button>
                  <transition name="fade">
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
                <!-- 播放列表(复用 queuePanelOpen/toggleQueuePanel + 队列状态/方法) -->
                <div ref="queueControlImm" class="queue-control" @click.stop>
                  <button-icon
                    v-tip="'播放列表'"
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
                      <div
                        v-if="!podcastQueue.length && !nowPlayingItem"
                        class="qp-empty"
                      >
                        队列空空。在节目里加入单集后会出现在这里。
                      </div>
                      <div v-else class="qp-list">
                        <!-- [播放列表] 正在播放 sticky 置顶行(沉浸页，与播放 bar 一致；放进 qp-list 内对齐) -->
                        <div v-if="nowPlayingItem" class="qp-item qp-now">
                          <button
                            v-tip="playing ? '暂停' : '播放'"
                            class="qp-now-play"
                            :style="{ color: coverFillColor }"
                            @click.stop="playOrPause"
                          >
                            <svg-icon
                              :icon-class="playing ? 'pause' : 'play'"
                            />
                          </button>
                          <PodImage
                            v-if="nowPlayingItem.coverUrl"
                            class="qp-cover"
                            :src="nowPlayingItem.coverUrl"
                          />
                          <div class="qp-meta">
                            <div class="qp-title">
                              {{ nowPlayingItem.title }}
                            </div>
                            <div class="qp-sub">
                              {{ nowPlayingItem.podcastTitle }}
                            </div>
                          </div>
                          <button class="qp-del" @click.stop="removeNowPlaying">
                            ×
                          </button>
                        </div>
                        <div
                          v-for="(item, idx) in podcastQueue"
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
                          <button
                            class="qp-del"
                            @click.stop="removeFromQueue(item)"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    </div>
                  </transition>
                </div>
                <!-- 睡眠(复用 sleepMenuOpen/toggleSleepMenu + 睡眠状态/方法) -->
                <div ref="sleepControlImm" class="sleep-control" @click.stop>
                  <button-icon
                    v-tip="'睡眠定时'"
                    :class="{ active: sleepMode !== 'off' }"
                    @click.native="toggleSleepMenu"
                    ><svg-icon icon-class="moon"
                  /></button-icon>
                  <transition name="fade">
                    <div
                      v-if="sleepMenuOpen"
                      class="sleep-menu"
                      @click.stop
                      @wheel.prevent="onSleepWheel"
                    >
                      <div class="sleep-slider">
                        <span class="sl-label">{{ sleepLabel }}</span>
                        <div class="sl-track">
                          <div
                            v-if="sleepMarkerPct != null"
                            class="sl-end-marker"
                            :style="{ left: sleepMarkerPct + '%' }"
                            @click.stop="onMarkerClick"
                          >
                            <i
                              class="sl-end-bar"
                              :style="{ background: sleepMarkerColor }"
                            ></i>
                            <span class="sl-end-tip">本集结束</span>
                          </div>
                          <vue-slider
                            :value="sleepSliderVal"
                            :min="0"
                            :max="sleepMaxMin"
                            :interval="sleepStep"
                            :height="4"
                            :drag-on-click="true"
                            :duration="0"
                            tooltip="none"
                            :dot-size="10"
                            @change="onSleepChange"
                            @drag-end="onSleepCommit"
                          ></vue-slider>
                        </div>
                      </div>
                    </div>
                  </transition>
                </div>
              </div>

              <!-- 三大金刚：后退15 / 播放暂停(无圈) / 前进30 -->
              <div class="imm-king">
                <button-icon
                  v-tip="'后退 15 秒'"
                  class="imm-seek"
                  @click.native="seekBackward15"
                  ><svg-icon icon-class="previous"
                /></button-icon>
                <button-icon
                  v-tip="$t(player.playing ? 'player.pause' : 'player.play')"
                  class="imm-play"
                  @click.native="playOrPause"
                  ><svg-icon :icon-class="player.playing ? 'pause' : 'play'"
                /></button-icon>
                <button-icon
                  v-tip="'前进 30 秒'"
                  class="imm-seek"
                  @click.native="seekForward30"
                  ><svg-icon icon-class="next"
                /></button-icon>
              </div>

              <!-- 右组：标记 / 收藏 / 音量(以三大金刚为对称中心、与左组对称) -->
              <div class="imm-side imm-side-right">
                <!-- 标记此刻：复用 bar 标记逻辑(短按标记/长按3秒清空/封面主色/彩蛋#2) -->
                <div
                  v-if="isPodcastTrack"
                  class="mark-control imm-mark"
                  :class="{
                    charging: markCharging,
                    pulse: markPulse,
                    cleared: markCleared,
                    rainbow: markCount > 10,
                  }"
                  :style="
                    markCount > 5 && markCount <= 10
                      ? { color: markColor }
                      : null
                  "
                  @click.stop
                  @mouseenter="markHovering = true"
                  @mousedown.stop="onMarkPressStart"
                  @mouseup="onMarkPressEnd"
                  @mouseleave="onMarkLeave"
                >
                  <span class="mark-charge"></span>
                  <svg-icon class="mark-icon" icon-class="social-network" />
                </div>
                <!-- 收藏 -->
                <div class="imm-like" :class="{ favorited: isFavorited }">
                  <button-icon
                    v-tip="isFavorited ? '取消收藏' : '收藏'"
                    @click.native="toggleFavorite"
                  >
                    <svg-icon
                      v-show="!isFavorited"
                      icon-class="heart"
                    ></svg-icon>
                    <svg-icon
                      v-show="isFavorited"
                      icon-class="heart-solid"
                    ></svg-icon>
                  </button-icon>
                </div>
                <!-- 音量：点击弹出滑条弹窗(形状同睡眠)，可拖可滚轮；取消一键静音(拖到底=静音)。
                     不同于 bar 的常驻滑条——沉浸页用弹窗，干净。 -->
                <div
                  ref="volControlImm"
                  class="vol-control imm-vol"
                  @click.stop
                >
                  <button-icon
                    v-tip="'音量'"
                    :class="{ active: volMenuOpen }"
                    @click.native="toggleVolMenu"
                  >
                    <svg-icon v-show="volume > 0.5" icon-class="volume" />
                    <svg-icon v-show="volume === 0" icon-class="volume-mute" />
                    <svg-icon
                      v-show="volume <= 0.5 && volume !== 0"
                      icon-class="volume-half"
                    />
                  </button-icon>
                  <transition name="fade">
                    <div
                      v-if="volMenuOpen"
                      class="vol-menu"
                      @click.stop
                      @wheel.prevent="onVolumeWheel"
                    >
                      <div class="vol-slider">
                        <span class="v-label">音量 {{ volPercent }}%</span>
                        <div class="vol-track">
                          <vue-slider
                            v-model="volume"
                            :min="0"
                            :max="1"
                            :interval="0.01"
                            :height="4"
                            :drag-on-click="true"
                            :duration="0"
                            tooltip="none"
                            :dot-size="10"
                          ></vue-slider>
                        </div>
                      </div>
                    </div>
                  </transition>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { mapState, mapMutations, mapActions } from 'vuex';
import '@/assets/css/slider.css';

import ButtonIcon from '@/components/ButtonIcon.vue';
import VueSlider from 'vue-slider-component';
import { goToListSource, hasListSource } from '@/utils/playList';
import { formatTrackTime } from '@/utils/common';
// [B-63] 睡眠定时"本集结束"小蓝标改用当前封面主色调（记忆点 + 与定位本集结束呼应）
import { getCoverColor } from '@/utils/podcast/coverColor';
// [沉浸式播放页 P0] 封面 3 色调色板（沉浸页中层三色柔和径向渐变背景用）
import { getCoverPalette } from '@/utils/podcast/coverPalette';

export default {
  name: 'Player',
  components: {
    ButtonIcon,
    VueSlider,
  },
  data() {
    // [进度条蓝闪修] 重开时从 localStorage 恢复上次封面主色/撞色：让首帧进度条即用封面主色，
    //   不再"先回退蓝 #335eea 再变主色"闪一下。值随播放的集由 refreshMarkColor 持久化(覆盖式)，
    //   启动恢复的就是上次那集的色 → 与恢复的当前曲一致；切到不同节目时各自的色都会被分别覆盖持久化。
    let _barFill = null;
    let _barContrast = '#e67e22';
    try {
      const _bc = JSON.parse(localStorage.getItem('playerBarColors') || 'null');
      if (_bc && _bc.fill) {
        _barFill = _bc.fill;
        _barContrast = _bc.contrast || _barContrast;
      }
    } catch (e) {
      /* ignore */
    }
    return {
      mouseDownTarget: null,
      // [播客改造 A-6] 倍速面板开关 + 当前倍速（与 player._playbackRate 双向同步）
      rateMenuOpen: false,
      playbackRate: 1,
      rateOutsideListener: null,
      // [播客改造 A-7.8] 进度条 hover 预览
      hoverTime: null,
      hoverX: 0,
      // [进度条·重开修复] 给两条 vue-slider 当 :key；布局稳定后自增一次 → 强制以"已恢复的进度/时长"
      //   重挂、重新测量轨道宽 → 重开软件未播放时填充也能立刻显示(vue-slider 3.2.24 无 refresh/不监听 resize)。
      progressBarKey: 0,
      immProgressBarKey: 0,
      // [B-75] 标记位置：封面主色(标记按钮 >5 变色彩蛋用)、长按充能态、短按 pulse 反馈。
      //   _markColorSrc/_markTimer/_markPulseTimer/_markPressed 用裸实例属性(不入 data，免响应式+避开保留键)
      markColor: _barFill || '#e67e22',
      // [进度条主色] 播放 bar「已播段」颜色 = 当前封面主色(切歌时由 refreshMarkColor 算出)。
      //   重开用 localStorage 恢复的上次主色(_barFill)→首帧即主色、不闪蓝；仅"史上第一次运行"无值时为
      //   null → CSS 回退原蓝 #335eea(一次性)。(沉浸页进度条按用户要求保持原样，不用此色。)
      coverFillColor: _barFill,
      // [进度条主色] 播放 bar 标记点颜色 = 封面主色的「撞色(互补色)」，保证蓝封面下也撞得出来、看得清(用户定)。
      //   切歌时由 refreshMarkColor 算出；重开恢复上次撞色(_barContrast)，默认橙。沉浸页标记点仍用 markColor。
      markContrastColor: _barContrast,
      markCharging: false,
      markPulse: false,
      markCleared: false, // [修] 长按充能满(清空标记)时给 icon 一记"清空"反馈动画(两端共用)
      markHovering: false, // [B-77] hover 标记键 → 播放头上方浮"标记此刻"提示
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
      sleepSliderVal: 0, // 滑条值(分钟)=用户设定的档位；未激活=0。[B-65] 不再随倒计时自缩，倒计时只走 label
      // [睡眠到点关机] 关机倒计时(秒)，>0 时显示浮层；归零才真请求关机
      shutdownCountdown: 0,
      shutdownTimer: null,
      sleepOutsideListener: null,
      // [B-63] 单滑条动态量程：开菜单时按单集剩余时间即时计算
      sleepMaxMin: 120, // 滑条最大值(分钟)
      sleepStep: 5, // [B-65] 步长(分钟)：随单集时长动态变(长单集步长大→好拖、落点是整数)
      sleepEndStop: 0, // [B-65] "本集结束"对应的刻度档位(=ceil(剩余/步长)*步长)；拖到此档=本集结束
      sleepDragging: false, // [B-65] 正在拖动：label 实时预览拖到的目标值(松手才落定时器)
      sleepMarkerPct: null, // "本集结束"标记位置(%)；null=无单集时不显示
      sleepEpisodeRemainMin: 0, // 当前单集剩余分钟(用于贴近标记时识别为"本集结束")
      sleepMarkerColor: '#e67e22', // [B-63]"本集结束"标记色=封面主色调(默认暖橙，区别于蓝色进度条)
      sleepColorSrc: '', // 已取色的封面 url（避免重复取色）
      // [沉浸式播放页 P0] 全屏沉浸 overlay 开关 + 封面 3 色调色板(切歌取一次、缓存)
      immersiveOpen: false,
      immPalette: null,
      // [沉浸式播放页] 音量弹窗(沉浸页专用：点击弹滑条，区别于 bar 的常驻滑条)
      volMenuOpen: false,
      volOutsideListener: null,
      immTooltipVisible: false,
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
    // [播放列表] 当前播放项 → 映射成队列行同款字段，置顶显示(带"正在播放"标签)。
    //   仅播客单集显示；播放器队列(podcastQueue)本就不含当前项，纯新增、无重复。
    nowPlayingItem() {
      const t = this.player && this.player.currentTrack;
      if (!t || !t.podcastEpisodeId) return null;
      return {
        id: t.podcastEpisodeId,
        title: t.name || '未命名单集',
        podcastTitle: (t.al && t.al.name) || '',
        coverUrl: (t.al && t.al.picUrl) || '',
      };
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
    // [B-77] 播放头百分比（标记提示气泡定位用，随进度跟着走）
    progressPercent() {
      return this.bufferingLeftPercent;
    },
    // [播客改造 A-21] 倍速显示固定 1 位小数（步进 0.1 不会有更多位数）
    rateLabel() {
      return this.playbackRate.toFixed(1);
    },
    rateButtonText() {
      return this.rateLabel + 'x';
    },
    // [B-47/B-63] 睡眠弹窗左侧文案：关闭 / 本集结束·剩余 / 剩余
    sleepLabel() {
      // [B-65] 拖动中实时预览拖到的目标值（松手才真正落定时器），给即时反馈
      if (this.sleepDragging) {
        const v = this.sleepSliderVal;
        // [B-73] 最左档文案由"关闭"改"睡眠"：用户易把"关闭"误读成"关闭软件"
        if (v <= 0) return '睡眠';
        if (this.sleepMarkerPct != null && v === this.sleepEndStop)
          return '本集结束';
        return this.fmtSleepMin(v);
      }
      if (this.sleepMode === 'off') return '睡眠';
      if (this.sleepMode === 'end') {
        return '本集结束 · ' + (this.sleepRemainText || '0:00');
      }
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
    // [B-75] 标记位置相关
    markEpisodeId() {
      const t = this.player && this.player.currentTrack;
      return (t && t.podcastEpisodeId) || '';
    },
    currentMarks() {
      const map =
        (this.$store.state.podcastMarks &&
          this.$store.state.podcastMarks.map) ||
        {};
      return (this.markEpisodeId && map[this.markEpisodeId]) || [];
    },
    markCount() {
      return this.currentMarks.length;
    },
    // [沉浸式播放页 P0] 节目名(播客=ar 数组拼接；用于沉浸页第二行可点击跳节目详情)
    podcastName() {
      const ar = this.currentTrack && this.currentTrack.ar;
      if (!ar || !ar.length) return '';
      return ar.map(a => a.name).join(', ');
    },
    // [沉浸式播放页] 音量百分比(弹窗 label 用)
    volPercent() {
      return Math.round((this.volume || 0) * 100);
    },
    // [沉浸式播放页 P0] 中层三色柔和径向渐变(忠实封面冷暖分布、已降饱和)；
    //   取色未就绪/失败 → 中性深色兜底，保证不空。
    immBg() {
      const p = this.immPalette;
      const hsla = (c, a) => `hsla(${c[0]}, ${c[1]}%, ${c[2]}%, ${a})`;
      if (!p || !p.hsl || !p.hsl.length) {
        return 'radial-gradient(80% 80% at 50% 30%, hsla(220, 12%, 30%, 0.6), transparent 70%)';
      }
      const a = p.hsl[0];
      const b = p.hsl[1] || p.hsl[0];
      const c = p.hsl[2] || p.hsl[0];
      return [
        `radial-gradient(62% 80% at 16% 12%, ${hsla(
          a,
          0.85
        )}, transparent 66%)`,
        `radial-gradient(60% 74% at 86% 20%, ${hsla(
          b,
          0.72
        )}, transparent 70%)`,
        `radial-gradient(82% 72% at 50% 104%, ${hsla(
          c,
          0.66
        )}, transparent 76%)`,
      ].join(', ');
    },
  },
  mounted() {
    // [审P2-2] setupMediaControls 已删:媒体会话动作处理器统一由 Player.js _initMediaSession 注册
    //   (原这份把 play/pause 都绑 playOrPause toggle、又覆盖 Player.js 的正确版 → 系统暂停反成播放)。
    window.addEventListener('keydown', this.handleKeydown);
    // [B-32] 单集名溢出检测：初次挂载 + 切歌 + 窗口缩放 都重新判断，
    // 溢出则 nameOverflow=true → .marquee 自动跑马灯（不再依赖 hover）。
    window.addEventListener('resize', this.checkNameOverflow);
    this.$watch(
      () => this.currentTrack && this.currentTrack.name,
      () => this.checkNameOverflow()
    );
    // [B-36/B-64] 封面 url 变化时先置 loading 态，等新图 @load 再淡入；
    //   但缓存命中(来回切最近两集、同 url 复用)时 @load 可能不再触发 → 下一帧主动判
    //   img.complete && naturalWidth>0 立即置 loaded，避免封面卡在半透明。
    this.$watch(
      () => this.coverSrc,
      src => {
        this.coverLoaded = false;
        this.refreshMarkColor(src); // [B-75] 换封面 → 刷新标记主色
        // [沉浸式播放页 P0] 沉浸页开着时换歌 → 刷新背景三色(关着时不算，省一次 worker 取色)
        if (this.immersiveOpen) this.refreshImmPalette(src);
        this.$nextTick(() => {
          const img = this.$el && this.$el.querySelector('.cover-img');
          if (img && img.complete && img.naturalWidth > 0) {
            this.coverLoaded = true;
          }
        });
      }
    );
    this.refreshMarkColor(this.coverSrc); // [B-75] 初始封面主色
    this.$nextTick(() => this.checkNameOverflow());
    // [播客改造 A-6] 从 player 状态恢复倍速（持久化由 store 的 Proxy 自动完成）
    if (this.player && typeof this.player.playbackRate === 'number') {
      this.playbackRate = this.player.playbackRate;
    }
    // [进度条·重开修复] vue-slider 暂停态挂载时，process(已播填充)按当时轨道宽算；重开软件时底栏在
    //   slide-up 入场、轨道宽尚未量好 → 填充算成 0 宽，要等播放后 progress 连续变化才重算 → 进度条"看不见"、
    //   点播放才"重现"。**vue-slider 3.2.24 既无 refresh() 也不监听 resize**(实测确认，旧的 refresh() 调用
    //   恒被 typeof 守卫跳过=空转)，故改用「自增 :key 强制重挂」：布局稳定后让 slider 以已恢复的 progress/
    //   duration 重新实例化、重测轨道宽 → 填充立刻正确，无需先播放。:duration=0 无动画、重挂瞬时。
    const bumpBar = () => {
      this.progressBarKey++;
    };
    this.$nextTick(bumpBar);
    // 二次兜底：底栏 slide-up 入场过渡(~0.4s)结束、布局彻底稳定后再重挂一次，覆盖 nextTick 时轨道宽未量好的边角。
    //   组件实为单例不销毁；仍存 id 并在 beforeDestroy 清理(防未来若被 v-if 条件渲染时的迟发)。
    this._barBumpTimer = setTimeout(bumpBar, 500);
    // [进度条偶发消失·根治] vue-slider 3.2.24 不监听 resize：进度条容器宽度一旦变化(切页致内容区滚动条
    //   出现/消失、窗口缩放、布局回流…)，slider 缓存的轨道宽变陈旧 → 已播填充按旧宽算、可能算成 0 → 进度条
    //   "突然消失"(用户实测切界面偶发)。用 ResizeObserver 盯容器宽：真变(≥1px)才自增 :key 重挂、按新宽重测，
    //   只在宽度确变时触发(非每次切页)、:duration=0 重挂瞬时无闪。观察容器(非 slider 自身)→重挂不改容器宽→不自激。
    if (window.ResizeObserver && this.$refs.progressBarEl) {
      let lastBarW = 0;
      this._barRO = new ResizeObserver(entries => {
        const r = entries && entries[0] && entries[0].contentRect;
        const w = r ? r.width : 0;
        if (w && Math.abs(w - lastBarW) >= 1) {
          lastBarW = w;
          bumpBar();
        }
      });
      this._barRO.observe(this.$refs.progressBarEl);
    }
    // [两端一致] 沉浸页进度条随面板 v-if 挂载，开启瞬间同样可能是暂停态 → 开启时也重挂一次。
    this.$watch(
      () => this.immersiveOpen,
      open => {
        if (!open) return;
        this.$nextTick(() => {
          this.immProgressBarKey++;
        });
      }
    );
    // [进度条偶发消失·根治] 切页后(布局稳定时)重挂一次进度条：覆盖"切到别的界面进度条偶发消失"——
    //   不论是轨道宽陈旧、还是 slider 内部态在某次切页重渲时算错，重挂(按当前 progress/duration/宽重新实例化)
    //   都能恢复。仅在容器有有效宽度时重挂，绝不在宽=0 的瞬态重挂(否则反而算成 0 宽=消失)。:duration=0 重挂瞬时无闪。
    this.$watch(
      () => this.$route && this.$route.fullPath,
      () => {
        this.$nextTick(() => {
          const el = this.$refs.progressBarEl;
          if (el && el.offsetWidth > 0) this.progressBarKey++;
        });
      }
    );
  },
  beforeDestroy() {
    window.removeEventListener('keydown', this.handleKeydown);
    window.removeEventListener('resize', this.checkNameOverflow);
    // [播客改造 A-6] 卸载倍速面板的"点击外部关闭"监听
    this.closeRateMenu();
    // [B-46] 卸载睡眠定时器的监听与计时器
    this.closeSleepMenu();
    this.clearSleep();
    // [睡眠到点关机] 清理关机倒计时(防销毁后仍触发关机)
    this.clearShutdownTimer();
    // [进度条偶发消失·根治] 断开进度条宽度观察器
    if (this._barRO) {
      this._barRO.disconnect();
      this._barRO = null;
    }
    // [B-75] 清理标记长按/pulse/清空 计时器
    clearTimeout(this._markTimer);
    clearTimeout(this._markPulseTimer);
    clearTimeout(this._markClearTimer);
    // [进度条·重开修复] 清理进度条重挂的二次兜底计时器
    clearTimeout(this._barBumpTimer);
    // [沉浸式播放页 P0] 卸载时若沉浸页还开着，恢复全局滚动 + 关队列/音量面板监听(防泄漏) + 清 body 标记
    this.closeQueuePanel();
    this.closeVolMenu();
    if (this.immersiveOpen) {
      this.$store.commit('enableScrolling', true);
      if (typeof document !== 'undefined') {
        document.body.classList.remove('immersive-open');
      }
    }
  },
  methods: {
    ...mapMutations(['toggleLyrics']),
    ...mapActions(['showToast', 'likeATrack']),
    handleClick(event) {
      // [沉浸式播放页 P0] 点击 bar 空白处 → 展开沉浸页。各功能区(封面/信息/金刚/右控)均 @click.stop，
      //   故此处只在真正点到 bar 背景时触发；event.target==mouseDownTarget 确保是「点击」而非拖拽松手。
      // [修冲突] 若按下那一刻有功能弹窗(倍速/队列/睡眠)开着 → 这次空白点击是为了关弹窗
      //   (已由弹窗各自的 outside 监听在 mousedown 关掉)，不应被判定成「进入沉浸页」。
      if (this._menuOpenAtDown) return;
      if (event.target === this.mouseDownTarget) {
        this.openImmersive();
      }
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
    // [B-75] 标记位置 ===
    markPct(sec) {
      const dur = this.player.currentTrackDuration || 0;
      if (dur <= 0) return 0;
      return Math.min(100, Math.max(0, (sec / dur) * 100));
    },
    // 封面主色：换封面时算一次缓存（进度条已播段 + 标记按钮 >5 变色彩蛋，两端共用）
    refreshMarkColor(src) {
      if (!src || src === this._markColorSrc) return;
      this._markColorSrc = src;
      getCoverColor(src)
        .then(hsl => {
          if (hsl && this._markColorSrc === src) {
            const c = `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)`;
            this.markColor = c; // 标记按钮 >5 变封面主色(彩蛋#2) + 沉浸页标记点
            this.coverFillColor = c; // 播放 bar 已播段 = 封面主色
            // 播放 bar 标记点 = 封面主色的撞色(互补色 hue+180)，高饱和高对比 → 任何封面(含蓝)都看得清
            this.markContrastColor = `hsl(${(hsl[0] + 180) % 360}, 85%, 55%)`;
            // [进度条蓝闪修] 覆盖式持久化当前封面主色/撞色 → 下次重开 data() 即取到、首帧就是主色，不闪蓝。
            try {
              localStorage.setItem(
                'playerBarColors',
                JSON.stringify({ fill: c, contrast: this.markContrastColor })
              );
            } catch (e) {
              /* ignore */
            }
          }
        })
        .catch(() => {});
    },
    // 按下：起 3 秒长按计时 + 充能动画（mousedown）。[B-76] 5s→3s：等待心理近指数增长，5s 体感像 10s
    onMarkPressStart() {
      if (!this.markEpisodeId) return;
      this._markPressed = true;
      this.markCharging = true;
      clearTimeout(this._markTimer);
      this._markTimer = setTimeout(() => {
        // 长按满 3 秒 → 清空本集全部标记 + icon「清空」反馈(不能只有充能圈、icon 也要动)
        this.markCharging = false;
        this._markPressed = false;
        this._markTimer = null;
        this.clearAllMarks();
        this.flashMarkCleared();
      }, 3000);
    },
    // [修] 长按充能满时给 icon 一记"清空"动画(scale 先收后弹=放电感)。两端共用 .mark-control.cleared。
    flashMarkCleared() {
      this.markCleared = false;
      clearTimeout(this._markClearTimer);
      this.$nextTick(() => {
        this.markCleared = true;
        this._markClearTimer = setTimeout(() => {
          this.markCleared = false;
        }, 460);
      });
    },
    // 松手：未到 5 秒 = 短按 → 标记当前时间点（mouseup）
    onMarkPressEnd() {
      if (!this._markPressed) return; // 已被长按消费 / 已取消
      this._markPressed = false;
      this.markCharging = false;
      if (this._markTimer) {
        clearTimeout(this._markTimer);
        this._markTimer = null;
        this.addMarkHere();
      }
    },
    // 移出按钮：取消（既不标记也不清空）
    onMarkPressCancel() {
      if (this._markTimer) {
        clearTimeout(this._markTimer);
        this._markTimer = null;
      }
      this.markCharging = false;
      this._markPressed = false;
    },
    // [B-77] 鼠标移出标记键：收起"标记此刻"提示 + 取消长按计时
    onMarkLeave() {
      this.markHovering = false;
      this.onMarkPressCancel();
    },
    addMarkHere() {
      const id = this.markEpisodeId;
      if (!id) return;
      const sec = Math.floor(this.player.progress || 0);
      this.$store.commit('addPodcastMark', { episodeId: id, sec });
      // [B-76] 反馈只靠视觉(图标 pulse + 进度条出蓝标)，不弹 toast(用户嫌提示文案干扰视线)
      this.markPulse = true;
      clearTimeout(this._markPulseTimer);
      this._markPulseTimer = setTimeout(() => {
        this.markPulse = false;
      }, 260);
    },
    clearAllMarks() {
      const id = this.markEpisodeId;
      if (!id || !this.markCount) return;
      // [B-76] 清空靠视觉(进度条蓝标消失)反馈，不弹 toast
      this.$store.commit('clearPodcastMarks', id);
    },
    // [播客改造 A-21] 倍速：步进 0.1，0.5-3 范围
    setRate(rate) {
      const r =
        Math.round(Math.max(0.5, Math.min(3, Number(rate) || 1)) * 10) / 10;
      this.playbackRate = r;
      this.player.playbackRate = r;
    },
    // [沉浸式播放页 P0] 点击是否落在「任一指定 ref 子树」内。bar 与沉浸页各有一套
    //   倍速/队列/睡眠控件，复用同一份 open 状态；点进其中任一个都算「内部」、不误关。
    //   沉浸页未渲染时 -imm ref 为 undefined、被 filter 掉 → 行为与改前完全一致(零回归)。
    _insideAnyRef(refNames, target) {
      return refNames.some(n => {
        const el = this.$refs[n];
        return el && el.contains && el.contains(target);
      });
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
          if (
            !this._insideAnyRef(['rateControl', 'rateControlImm'], ev.target)
          ) {
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
      // [B-63] 开菜单瞬时按单集剩余时间算出滑条量程 + 本集结束蓝标位置（必须快、无卡顿）
      this.computeSleepRange();
      this.sleepMenuOpen = true;
      this.$nextTick(() => {
        this.sleepOutsideListener = ev => {
          if (
            !this._insideAnyRef(['sleepControl', 'sleepControlImm'], ev.target)
          )
            this.closeSleepMenu();
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
    // [B-69bis S0-spec] 开菜单按单集剩余算量程：剩余<CAP(120min)→量程固定 0–120(轴稳定、跨单集可比)、
    //   蓝标按真实剩余比例落位；剩余≥120→量程=结束档、蓝标最右。阈值按"剩余时长"(用户拍板 CAP=120/按剩余)。
    computeSleepRange() {
      const dur = this.player.currentTrackDuration || 0;
      const pos = this.player.progress || 0;
      const remainMin = (dur - pos) / 60;
      if (dur > 0 && remainMin >= 1) {
        this.sleepEpisodeRemainMin = remainMin;
        // [B-65] 步长随单集时长动态：长单集步长大 → 每档够宽好拖、落点是整数(30/45/60/90)
        const step = this.sleepStepFor(remainMin);
        // "本集结束"对应的刻度档位：剩余向上取整到步长整数倍 → 落得到、snap 命中、量程可整除
        const endStop = Math.max(step, Math.ceil(remainMin / step) * step);
        // [B-69bis S0-spec] 量程：剩余<120→固定 ceil(120/step)*step(=120，short 单集轴稳定)；
        //   剩余≥120→max=endStop(≈剩余、蓝标最右)。蓝标 endStop/max → short 按真实剩余比例落位。
        //   max 始终是步长整数倍 → 满足 vue-slider (max-min)%interval===0(防 total=0 死锁)。
        const CAP = 120;
        const max = remainMin >= CAP ? endStop : Math.ceil(CAP / step) * step;
        this.sleepStep = step;
        this.sleepEndStop = endStop;
        this.sleepMaxMin = max;
        this.sleepMarkerPct = Math.min(100, (endStop / max) * 100);
        // [B-69bis S2] end 模式重开弹窗：把手贴回"本集结束"档(否则播放推进/换集后旧值与新蓝标脱开)；
        //   min 模式就近规整到新步长档位，避免滑块错位。
        if (this.sleepMode === 'end') {
          this.sleepSliderVal = endStop;
        } else if (this.sleepMode === 'min') {
          this.sleepSliderVal = Math.min(
            max,
            Math.round(this.sleepSliderVal / step) * step
          );
        }
      } else {
        // 无单集/无时长 → 退化为普通 0-120 滑条(步长5)，不显示标记
        this.sleepEpisodeRemainMin = 0;
        this.sleepStep = 5;
        this.sleepEndStop = 0;
        this.sleepMaxMin = 120;
        this.sleepMarkerPct = null;
      }
      // [B-63] "本集结束"标记色 = 当前封面主色调（缓存，避免重复取色）
      const src = this.coverSrc;
      if (src && src !== this.sleepColorSrc) {
        this.sleepColorSrc = src;
        getCoverColor(src)
          .then(hsl => {
            if (hsl && this.sleepColorSrc === src) {
              this.sleepMarkerColor = `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)`;
            }
          })
          .catch(() => {});
      }
    },
    // [B-65] 拖动中：只更新显示值 + 预览 label，不动定时器 → 实时跟手、无 churn(松手才落)
    onSleepChange(val) {
      this.sleepDragging = true;
      this.sleepSliderVal = Math.max(0, Math.round(Number(val) || 0));
    },
    // [B-65] 松手/点击落定：val=分钟。0=关闭；正好落在"本集结束"档=本集结束；其余=定时分钟。
    onSleepCommit() {
      this.sleepDragging = false;
      const min = this.sleepSliderVal;
      if (min <= 0) {
        this.cancelSleep();
        return;
      }
      // 落在"本集结束"档(=endStop) → 本集结束模式(跟随真实播放进度，非墙钟)。
      //   仅精确等于该档才触发(值已对齐步长)，不吞掉邻近定时取值。
      if (
        this.sleepMarkerPct != null &&
        this.sleepEpisodeRemainMin > 0 &&
        min === this.sleepEndStop
      ) {
        this.setSleepEnd();
        return;
      }
      this.applySleep(min * 60 * 1000, 'min');
    },
    // [B-65] 步长(分钟)随单集剩余时长动态：短单集精细、长单集粗 → 好拖、落点是整数
    sleepStepFor(min) {
      if (min <= 30) return 1;
      if (min <= 60) return 2;
      if (min <= 120) return 5;
      if (min <= 240) return 10;
      return 15;
    },
    // [B-65] 分钟数 → 人读预览：≥60 显示"X小时Y分"
    fmtSleepMin(v) {
      if (v >= 60) {
        const h = Math.floor(v / 60);
        const m = v % 60;
        return m ? `${h}小时${m}分` : `${h}小时`;
      }
      return `${v}分钟`;
    },
    // [B-47/B-65] 滚轮调节：每格 ±一个步长(随量程动态)，立即落定
    onSleepWheel(e) {
      const step = this.sleepStep || 1;
      const dir = e.deltaY < 0 ? 1 : -1;
      const base = this.sleepMode === 'off' ? 0 : this.sleepSliderVal;
      this.sleepSliderVal = Math.max(
        0,
        Math.min(this.sleepMaxMin, base + dir * step)
      );
      this.onSleepCommit();
    },
    // [B-47/B-64] 本集结束后暂停：'end' 模式跟随单集真实播放进度(非墙钟)，暂停/卡顿不提前误触发
    setSleepEnd() {
      this.applySleep(0, 'end');
    },
    // [B-73] 点"本集结束"蓝标 → 直接设本集结束(等价把滑块拖到该档)。蓝标仅有单集时显示，故 endStop>0。
    //   把手同步贴到 endStop，再走 setSleepEnd。click 仅在 mousedown/up 同落于标上才触发，
    //   滑条拖动结束于标上(down 在轨/把手)不会误触发，故不抢拖动。
    onMarkerClick() {
      if (this.sleepMarkerPct == null) return;
      this.sleepDragging = false;
      this.sleepSliderVal = this.sleepEndStop;
      this.setSleepEnd();
    },
    // [B-47/B-64] 应用睡眠：'min'=墙钟 setTimeout；'end'=每秒比较 progress 与时长(由 updateSleepRemain 判定)
    applySleep(ms, mode) {
      this.clearSleep();
      this.sleepMode = mode;
      if (mode === 'min') {
        this.sleepEndsAt = Date.now() + ms;
        this.sleepTimer = setTimeout(() => this.fireSleep(), ms);
      } else {
        this.sleepEndsAt = 0; // 'end' 不用墙钟一次性定时
        // [T15] 通知 player.js 本集自然播完时跳过续播队列
        if (this.player && this.player.setSleepEndMode)
          this.player.setSleepEndMode(true);
      }
      this.updateSleepRemain();
      this.sleepInterval = setInterval(() => this.updateSleepRemain(), 1000);
    },
    cancelSleep() {
      this.clearSleep();
      this.sleepMode = 'off';
      this.sleepRemainText = '';
      this.sleepSliderVal = 0;
      // [T15] 取消睡眠时一并清除 player.js 内的 endMode 标志
      if (this.player && this.player.setSleepEndMode)
        this.player.setSleepEndMode(false);
    },
    // [B67-BUG-1] 倒计时格式化：≥1 小时进位成 H:MM:SS，否则 M:SS。
    //   修长单集(如 264 分钟)标签显示成 "264:31" 的 bug（应为 4:24:31）。
    fmtClock(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      const ss = String(s).padStart(2, '0');
      return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
    },
    updateSleepRemain() {
      // [B-64] 'end' 模式：用单集真实剩余(时长-进度)而非墙钟 → 暂停/卡顿时进度不动、不会提前暂停
      if (this.sleepMode === 'end') {
        const dur = this.player.currentTrackDuration || 0;
        const pos = this.player.progress || 0;
        const leftSec = dur > 0 ? Math.max(0, Math.round(dur - pos)) : 0;
        this.sleepRemainText = this.fmtClock(leftSec); // [B67-BUG-1] H:MM:SS 进位
        // 播放到接近结尾(≤2s)且确在播放时才暂停 → 既"本集结束后暂停"、又先于自动续播
        if (dur > 0 && leftSec <= 2 && this.player.playing) {
          this.fireSleep();
        }
        return;
      }
      // [B-65] 'min' 模式：墙钟倒计时。滑块停在设定档(显示"你设了多少")，倒计时只走 label 文案，
      //   不再每秒回写 sleepSliderVal → 消除"滑块自缩"和松手后被 interval 拽回的打架。
      const left = Math.max(0, this.sleepEndsAt - Date.now());
      this.sleepRemainText = this.fmtClock(Math.round(left / 1000)); // [B67-BUG-1] H:MM:SS 进位
      if (left <= 0) this.fireSleep();
    },
    fireSleep() {
      const wasPlaying =
        this.player &&
        this.player.playing &&
        typeof this.player.pause === 'function';
      if (wasPlaying) this.player.pause();
      // [T15] 清除 player.js endMode 标志（end 模式提前 2s 暂停路径）
      if (this.player && this.player.setSleepEndMode)
        this.player.setSleepEndMode(false);
      this.clearSleep();
      this.sleepMode = 'off';
      this.sleepRemainText = '';
      this.sleepSliderVal = 0;
      // [睡眠到点关机] 开了"到点关机"→暂停后启动可取消的关机倒计时；否则只暂停(原行为)。
      if (this.settings && this.settings.sleepShutdown) {
        this.showToast(wasPlaying ? '睡眠定时已到，已暂停' : '睡眠定时已到');
        this.startShutdownCountdown();
        return;
      }
      // [B-64] 仅真正执行暂停才提示"已暂停"，否则文案不误导
      this.showToast(wasPlaying ? '睡眠定时已到，已暂停播放' : '睡眠定时已到');
    },
    // [睡眠到点关机] 启动可取消的关机倒计时：应用内宽限 60s，到 0 才真请求关机，期间随时可取消(绝不误关)。
    startShutdownCountdown() {
      this.clearShutdownTimer();
      this._shuttingDown = false; // [审P2-2] 每次新倒计时复位防重入标志
      this.shutdownCountdown = 60;
      this.shutdownTimer = setInterval(() => {
        this.shutdownCountdown -= 1;
        if (this.shutdownCountdown <= 0) {
          this.clearShutdownTimer();
          this.doShutdown();
        }
      }, 1000);
      // [审nit] ESC 也可取消关机(无障碍/顺手)；监听随倒计时挂、随 clearShutdownTimer 摘
      this._shutdownEsc = e => {
        if (e.key === 'Escape') this.cancelShutdown();
      };
      window.addEventListener('keydown', this._shutdownEsc);
    },
    cancelShutdown() {
      this.clearShutdownTimer();
      this.shutdownCountdown = 0;
      this.showToast('已取消关机');
    },
    clearShutdownTimer() {
      if (this.shutdownTimer) {
        clearInterval(this.shutdownTimer);
        this.shutdownTimer = null;
      }
      if (this._shutdownEsc) {
        window.removeEventListener('keydown', this._shutdownEsc);
        this._shutdownEsc = null;
      }
    },
    // 倒计时归零 → 先 flush 落盘再请求主进程关机(主进程仅 Windows、且仅 prod 真关机、dev 干跑)。
    async doShutdown() {
      if (this._shuttingDown) return; // [审P2-2] 防重入(将来若加"立即关机"也不会双触发)
      this._shuttingDown = true;
      this.shutdownCountdown = 0;
      let r = null;
      try {
        if (this.player && this.player.requestSystemShutdown) {
          r = await this.player.requestSystemShutdown();
        }
      } catch (e) {
        r = null;
      }
      if (r && r.dryRun) {
        this.showToast('（开发版）已演练关机流程，未真正关机');
      } else if (r && r.ok) {
        this.showToast('数据已保存，正在关机…');
      } else if (r && r.reason === 'unsupported') {
        this.showToast('关机未执行（仅支持 Windows）');
      } else {
        // [审P2-1] 真机执行失败(spawn 抛错/无 IPC) → 如实提示，不误显"仅支持 Windows"
        this.showToast('关机命令执行失败');
      }
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
      // [修冲突] 记下按下瞬间是否有功能弹窗开着(此刻弹窗尚未被 outside 监听关闭：
      //   元素冒泡监听先于 document 监听触发)。handleClick 据此区分「关弹窗」与「进沉浸页」。
      this._menuOpenAtDown = this._anyMenuOpen();
    },
    // [修冲突] 是否有任一功能弹窗开着(倍速/队列/睡眠/沉浸页音量)。
    _anyMenuOpen() {
      return (
        this.rateMenuOpen ||
        this.sleepMenuOpen ||
        this.queuePanelOpen ||
        this.volMenuOpen
      );
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
          if (
            !this._insideAnyRef(['queueControl', 'queueControlImm'], ev.target)
          )
            this.closeQueuePanel();
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
    // [播放列表] 剔除"正在播放"的这一集：有后续队列 → 直接播下一首(等同把当前集移出播放)；
    //   队列为空 → 暂停(无下一集可顶上，保留信息行避免突兀清空)。
    removeNowPlaying() {
      if (this.podcastQueue.length) {
        this.playFromQueue(this.podcastQueue[0]);
      } else {
        this.player.pause();
      }
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

    // ===== [沉浸式播放页 P0] =====
    toggleImmersive() {
      this.immersiveOpen ? this.closeImmersive() : this.openImmersive();
    },
    openImmersive() {
      if (this.immersiveOpen) return;
      this.immersiveOpen = true;
      this.refreshImmPalette(this.coverSrc); // 进入时取一次背景三色
      // 锁主区滚动(与歌词页一致)，overlay 之下不再误滚
      this.$store.commit('enableScrolling', false);
      // [修] 给 body 打标记 → 全局 Toast 在沉浸页里下移，避开居中的控制区(详见 Toast.vue)
      if (typeof document !== 'undefined') {
        document.body.classList.add('immersive-open');
      }
      // [P1] ESC 退出沉浸（单次，不干预窗口状态）
      this._immKeyHandler = ev => this._immKeyDown(ev);
      document.addEventListener('keydown', this._immKeyHandler);
    },
    closeImmersive() {
      if (!this.immersiveOpen) return;
      this.immersiveOpen = false;
      this.$store.commit('enableScrolling', true);
      if (typeof document !== 'undefined') {
        document.body.classList.remove('immersive-open');
      }
      // [P1] 移除 ESC 监听
      if (this._immKeyHandler) {
        document.removeEventListener('keydown', this._immKeyHandler);
        this._immKeyHandler = null;
      }
      this.immTooltipVisible = false;
      // 顺手收起可能开着的功能面板，避免下次进来残留
      this.closeRateMenu();
      this.closeSleepMenu();
      this.closeQueuePanel();
      this.closeVolMenu();
    },
    // [沉浸式播放页] 音量弹窗：点击切换、点外部关闭(同倍速/睡眠模式)。取消一键静音——
    //   要静音把滑条拖到底即可。滚轮在弹窗内调节(onVolumeWheel 复用 bar 逻辑)。
    toggleVolMenu() {
      this.volMenuOpen ? this.closeVolMenu() : this.openVolMenu();
    },
    openVolMenu() {
      this.volMenuOpen = true;
      this.$nextTick(() => {
        this.volOutsideListener = ev => {
          if (!this._insideAnyRef(['volControlImm'], ev.target))
            this.closeVolMenu();
        };
        document.addEventListener('mousedown', this.volOutsideListener);
      });
    },
    closeVolMenu() {
      this.volMenuOpen = false;
      if (this.volOutsideListener) {
        document.removeEventListener('mousedown', this.volOutsideListener);
        this.volOutsideListener = null;
      }
    },
    // 取封面 3 色(切歌一次、缓存)；竞态保护：仅当仍是同一 src 才落定
    refreshImmPalette(src) {
      if (!src || src === this._immPaletteSrc) return;
      this._immPaletteSrc = src;
      getCoverPalette(src)
        .then(p => {
          if (p && this._immPaletteSrc === src) this.immPalette = p;
        })
        .catch(() => {});
    },
    // [修冲突] 沉浸页空白区按下：记下此刻是否有功能弹窗开着(此时弹窗尚未被 outside 监听关掉)。
    onImmStageMouseDown() {
      this._menuOpenAtDown = this._anyMenuOpen();
    },
    // [修冲突] 沉浸页空白区点击：若按下时有弹窗 → 这次点击只是关弹窗(已关)，不退出沉浸页；否则退出。
    onImmStageClick() {
      if (this._menuOpenAtDown) {
        this._menuOpenAtDown = false;
        return;
      }
      this.closeImmersive();
    },
    // 点单集名 → 单集详情(播客) / 列表(网易云)，并收起沉浸页(方案决策5)
    immClickTitle() {
      if (this.isPodcastTrack) this.goToEpisodeDetail();
      else if (this.hasList()) this.goToList();
      this.closeImmersive();
    },
    // 点节目名 → 节目详情，并收起沉浸页
    immClickPodcast() {
      if (this.isPodcastTrack) this.goToPodcastDetail();
      this.closeImmersive();
    },

    // [沉浸式播放页 P1] ESC 单次退出沉浸（不干预窗口状态，最大化/还原交给 Windows 原生）
    _immKeyDown(ev) {
      if (ev.repeat) return;
      const exitKey =
        (this.settings && this.settings.immersiveExitKey) || 'Escape';
      if (ev.code !== exitKey && ev.key !== exitKey) return;
      this.closeImmersive();
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
// [沉浸式播放页 P0] 包裹层不生成盒子：原 .player bar 与全屏 .immersive overlay 都作为
//   #app 直接子节点参与布局/定位/层叠 → bar 的一切(position/z-index/transition)零变化。
.player-root {
  display: contents;
}
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
// [进度条主色/B-19] 播放 bar 已播段 = 封面主色(--prog-fill，模板按当前封面注入)，未取到色回退原蓝 #335eea。
//   :not(.nyancat) → 彩虹猫开启时让位给全局 .nyancat 彩虹渐变；标记点用封面主色的撞色(见 .prog-mark)与已播段区分。
.progress-bar:not(.nyancat) ::v-deep .vue-slider-process {
  background-color: var(--prog-fill, #335eea);
  transition: background-color 0.35s ease; // 切歌时蓝→封面色柔和过渡
}
// [B-75/进度条主色] 标记点：进度条上每个标记一条细竖标。沉浸页=封面主色(inline markColor，原样保留)；
//   播放 bar=封面主色的撞色(inline markContrastColor)，蓝封面下也撞得出来。极细、纯展示、不挡点击。
.prog-mark {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 8px;
  border-radius: 1px;
  // 兜底色，实际由 inline 覆盖(沉浸页=markColor / 播放 bar=markContrastColor)
  background: var(--color-primary);
  pointer-events: none;
  z-index: 4;
}
// [B-77] 标记提示气泡：浮在播放头正上方，干净圆角(无方框/异色描边)，随进度跟着走。
.mark-hint-tip {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--color-body-bg);
  color: var(--color-text);
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.22);
  pointer-events: none;
  z-index: 112;
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
  // [加载条衔接] 左缘(贴播放头处)做 24px 渐隐遮罩 → 流光从已播段柔和"浮现"，
  //   不再在播放头硬切出现(根治用户报的"左边出现割裂、没有衔接")。
  -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 24px);
  mask-image: linear-gradient(90deg, transparent 0, #000 24px);
}
@keyframes bufferingFlow {
  0% {
    background-position: -50% 0;
  }
  100% {
    background-position: 150% 0;
  }
}
// [加载条配色] 加载高光条原用 --color-primary(蓝)。改为与各自进度条一致：
//   底栏 = 封面主色(--prog-fill，与已播段同色)；沉浸页 = 浅色 --imm-accent(保持沉浸页原浅色，不用蓝)。
//   用 background-image 只覆盖渐变色，保留基类的 size/repeat/动画。
.progress-bar .buffering-bar {
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    var(--prog-fill, #335eea) 50%,
    transparent 100%
  );
}
.imm-progress .buffering-bar {
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    var(--imm-accent) 50%,
    transparent 100%
  );
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
    border-radius: var(--radius-cover-mini);
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
  align-items: center; // [B-76] 让直接子级(标记键)与 blank/container 一起垂直居中
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

// [B-75] 标记位置键：与左侧"收藏"对称、紧贴金刚键右侧。
//   短按=标记(图标 pulse、不变色)；长按 5 秒=充能圈填满→清空本集标记。
//   彩蛋#2：本集标记 >5 → 图标变封面主色(inline color)；>10 → 彩虹流转。
.mark-control {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin: 0 8px;
  border-radius: 50%;
  cursor: pointer;
  user-select: none;
  // [B-76] 跟其他控制图标一样用 --color-text → 深色模式自适应(不再黑)。
  //   放父级：彩蛋的 inline color(6~10) / 彩虹动画(>10) 仍能覆盖。
  color: var(--color-text);
  // 长按充能圈：从中心放大，5 秒线性填满=即将清空；松手 0.2s 缩回（视觉区分长/短按）
  .mark-charge {
    position: absolute;
    inset: 2px;
    border-radius: 50%;
    background: currentColor;
    // [修] 0.18→0.26：长按充能圈在播放 bar 上更明显一点(沉浸页另有更高 opacity 覆盖，见 .imm-mark)
    opacity: 0.26;
    transform: scale(0);
    transform-origin: center;
    transition: transform 0.2s ease;
    pointer-events: none;
  }
  .mark-icon {
    position: relative;
    width: 18px;
    height: 18px;
    transition: transform 0.12s ease;
  }
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
  // 短按反馈：图标弹一下（不变色）
  &.pulse .mark-icon {
    transform: scale(1.32);
  }
  // [修] 长按充能满(清空标记)：图标「先收后弹」一下=放电/重置感，确认动作生效——
  //   不能只有充能圈在攒、满了 icon 毫无反馈。bar 与沉浸页共用本规则(.mark-control)。
  &.cleared .mark-icon {
    animation: markClearPop 0.46s cubic-bezier(0.2, 0.7, 0.2, 1);
  }
  // 长按充能：圈用 3 秒线性放大填满（与长按判定时长一致）
  &.charging .mark-charge {
    transform: scale(1);
    transition: transform 3s linear;
  }
  // 彩蛋#2：>10 标记 → 图标彩虹流转（animation 的 color 覆盖 inline color）
  &.rainbow .mark-icon {
    animation: markRainbow 2.4s linear infinite;
  }
}
@keyframes markRainbow {
  0% {
    color: hsl(0, 80%, 56%);
  }
  20% {
    color: hsl(45, 90%, 52%);
  }
  40% {
    color: hsl(140, 65%, 45%);
  }
  60% {
    color: hsl(195, 80%, 50%);
  }
  80% {
    color: hsl(265, 70%, 60%);
  }
  100% {
    color: hsl(360, 80%, 56%);
  }
}
// [修] 长按充能满 → icon 放电/重置反馈：先收(0.72)后弹(1.28)再回弹到 1
@keyframes markClearPop {
  0% {
    transform: scale(1);
  }
  28% {
    transform: scale(0.72);
  }
  60% {
    transform: scale(1.28);
  }
  100% {
    transform: scale(1);
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
    flex-shrink: 0;
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
    // [播放列表] 不再硬截断 10 项：渲染全部 + 弹性高度(受面板 max-height 约束)滚动查看
    flex: 1 1 auto;
    min-height: 0;
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
      // [播放列表] 收窄拖动列(原 20→16)，但保持字号14/字距-2 → ⋮⋮ 两列清晰可辨(不能并成 ⋮)
      width: 16px;
      box-sizing: border-box;
      text-align: center;
      flex-shrink: 0;
      padding: 2px 0;
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
      border-radius: var(--radius-cover-mini);
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
  // [播放列表] 正在播放置顶行：复用 .qp-item，但非交互(不可点/拖/删)
  .qp-now {
    cursor: default;
    // [播放列表] sticky 置顶：随 qp-list 滚动钉在顶部(在 qp-list 内 → 与队列行同容器/同滚动条预留，× 与封面对齐)；
    //   不透明底 + z-index 防下方队列行滚动时透视上来。
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--color-body-bg);
    // 与下方队列之间用稍粗分隔线区隔(比行间 1px 略粗)
    border-bottom-width: 2px;
    &:hover {
      background: var(--color-body-bg);
    }
    // [播放列表] 左侧播放/暂停图标(无圆圈)：着色=封面主色(行内 style)，占位宽=队列行 .qp-handle(16px) → 封面对齐；
    //   点击 = playOrPause(同金刚键)。去掉圆底后只剩图标本身，不再有"图标在圆内偏心"的问题。
    .qp-now-play {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      box-sizing: border-box;
      padding: 0;
      border: none;
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: transform 0.15s, opacity 0.15s;
      .svg-icon {
        width: 12px;
        height: 12px;
        display: block;
      }
      &:hover {
        transform: scale(1.15);
        opacity: 0.85;
      }
      &:active {
        transform: scale(0.9);
      }
    }
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
  padding: 13px 14px;
  width: 244px;
  z-index: 110;
  color: var(--color-text);
}
// [B-69 S1] 睡眠滑条改「上下两行」：label 独占一行、滑条独占整行(~216px 恒宽)。
//   原「左 label + 右滑条」同行布局下，label 文案宽度随状态变(关闭64px↔本集结束·4:24:31~105px)
//   会挤压滑轨宽度；而 vue-slider 的换算比例尺 scale 只在按下瞬间缓存、拖动中不刷新 →
//   拖动第一帧 label 缩窄→滑轨变宽+左缘左移、scale 仍是旧窄值 → 位置算偏~40% 乱跳/松手跳位。
//   拆行后滑轨几何与 label 文案完全解耦、交互期间恒定 → 根治。顺带长单集每档像素更大。
.sleep-slider {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  .sl-label {
    font-size: 12px;
    font-weight: 600;
    opacity: 0.7;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  // [B-63] 滑条 + 本集结束蓝标 的相对定位容器
  //   [B67-BUG-1] 给一点行高，弹窗不再"扁空"，滑条上下也多一点呼吸/可点余量
  .sl-track {
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    min-height: 20px;
  }
  // [B-69bis S0·根治] 滑条用 flex:1 取代 width:100%。vue-slider 未传 :width 时会给根元素
  //   内联 width:auto(dist containerStyles)，压过样式表的 width:100% → 在 .sl-track(display:flex)
  //   里按内容宽收缩，而 rail 子元素全绝对定位 → 内容宽=0 → 滑轨塌缩成 0px(scale=0→任何拖动
  //   位置=Infinity 钳到 max=拖不动/瞬移/把手不动)。flex:1(=flex-basis:0+grow)走 flex 算法分宽、
  //   绕开 width 属性 → 撑满整行(与一直正常的倍速滑条 .rate-slider .vue-slider{flex:1} 同款)。
  .vue-slider {
    flex: 1;
  }
  // [B-63改/B67-BUG-1] 睡眠滑条：已填充段蓝色；轨道用更明显的中性灰(原 0.4 在浅色下几乎看不见)+ 圆角。
  //   [B-72] 轨道高度由 8 改回 4(模板 :height=4)、把手 14→12，与倍速滑条(默认 4px + dot 12)一致、更精致。
  //   B67-BUG-1 当初加到 8px 是想治"看不到/拖不动"，但 B-69bis 已实锤真凶是滑轨 0px 塌缩(已 flex:1 修)，
  //   与 4px/浅色无关 → 现可安全改细。::v-deep 仅作用于睡眠滑条。
  ::v-deep .vue-slider-rail {
    background-color: rgba(128, 128, 128, 0.5);
    border-radius: 4px;
  }
  ::v-deep .vue-slider-process {
    background-color: var(--color-primary);
    border-radius: 4px;
  }
  ::v-deep .vue-slider-dot-handle {
    // [B-64] 把手常显(全局默认 hover 才显)，让用户一眼看到可拖的蓝色圆点
    visibility: visible;
    background-color: var(--color-primary);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  }
  // [B-63改] "本集结束"标记：用当前封面主色调(inline sleepMarkerColor 绑定 .sl-end-bar)，
  //   区别于蓝色进度条 → 记忆点，与"定位到本集结束"呼应。
  // [B-73] 可见细条更小(2×10)，hover 时内条轻微放大(scale1.4≈回到原 14 高)+ 冒出"本集结束"小提示，
  //   提升可发现性；整标可点(=直接设本集结束，等价拖到该档)。外层是稍大的透明命中区(便于 hover/点中)，
  //   放大只作用于内条 .sl-end-bar，提示 .sl-end-tip 不随之缩放。
  .sl-end-marker {
    position: absolute;
    top: 50%;
    left: 0; // 实际由 inline left:% 覆盖
    transform: translate(-50%, -50%);
    width: 8px; // 透明命中区，比可见细条宽，便于鼠标 hover/点击
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 3;
    .sl-end-bar {
      width: 2px;
      height: 10px;
      border-radius: 2px;
      // 兜底，实际由 inline sleepMarkerColor 覆盖
      background: var(--color-primary);
      box-shadow: 0 0 0 1.5px var(--color-body-bg);
      // [B-73.1] hover 放大改用 width/height(在固定 8×16 绝对定位命中区内 flex 居中长大)，
      //   不再用 transform:scale。scale 会把 box-shadow 描边一起缩放 + 合成层亚像素取整抖动，
      //   慢速从左往右划过、指针压在标上时表现为"指针被轻微抢占/位移"(且左右方向不对称)。
      //   改 w/h 后从中心对称长大、不重排滑条/页面、无 transform 抖动 → 位移感消除。
      transition: width 0.12s ease, height 0.12s ease;
    }
    .sl-end-tip {
      position: absolute;
      bottom: calc(100% + 1px);
      left: 50%;
      transform: translateX(-50%);
      white-space: nowrap;
      font-size: 11px;
      line-height: 1;
      padding: 3px 6px;
      border-radius: 5px;
      background: var(--color-body-bg);
      color: var(--color-text);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.12s ease;
    }
    &:hover {
      .sl-end-bar {
        width: 3px;
        height: 14px;
      }
      .sl-end-tip {
        opacity: 1;
      }
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

// ============ [沉浸式播放页 P0] 全屏沉浸 overlay ============
// [沉浸页主题] 2026-06-16 用户拍板：**固定深色表现**(不随 app 深/浅色切换)。
//   深色那套=柔和近白字 + 深磨砂压暗封面 + 轻暗描边(用户满意);浅色那套(浅磨砂提亮背景=发白)被否、已删(见下)。
//   下方 --imm-* 默认值即唯一一套(深色);已无 body[data-theme='light'] 覆盖。
.immersive {
  // 深色模式默认值(浅色模式见下方 body[data-theme='light'] 覆盖)
  --imm-text: rgba(245, 245, 247, 0.92); // 主字(标题/播放键):柔和近白
  --imm-text-2nd: rgba(236, 237, 241, 0.82); // 次字(功能图标/倍速/标记)
  --imm-text-weak: rgba(228, 230, 236, 0.6); // 弱字(节目名副标题)
  --imm-text-shadow: 0 1px 3px rgba(0, 0, 0, 0.45); // 可读兜底:轻暗描边
  --imm-frost: rgba(10, 11, 14, 0.34); // 磨砂遮罩:压暗封面
  --imm-accent: rgba(
    255,
    255,
    255,
    0.92
  ); // 进度条已播/把手(沉浸页固定深色，此即深色值=近白)
  --imm-rail: rgba(255, 255, 255, 0.18); // 进度条未播轨
  position: fixed;
  inset: 0;
  z-index: 190; // 盖住 navbar/bar(100)，低于 toast/modal(1000+)
  background: #0e0f13;
  color: var(--imm-text);
  text-shadow: var(--imm-text-shadow); // 子元素继承，任何封面上都撑住对比
  overflow: hidden;
  user-select: none;
  -webkit-app-region: no-drag; // 沉浸层覆盖 Win32Titlebar drag 区，必须显式 no-drag 否则顶边 mousemove 被 OS 吞掉
  // 复用的功能键(倍速文字/队列/睡眠/音量/收藏)字色随主题
  ::v-deep .button-icon .svg-icon {
    color: var(--imm-text-2nd);
  }
  ::v-deep .button-icon:hover {
    background: rgba(127, 127, 127, 0.16); // 中性 hover 底，深浅色都可见
  }
}
// [2026-06-16 用户拍板] 沉浸页**固定深色表现**：原 TODO3 的浅色覆盖(浅磨砂 --imm-frost rgba(236,238,243,.62)
//   把背景洗发白 + 近黑字)被用户否(浅色模式背景"非常不满意");深色那套(深磨砂压暗 + 近白字)用户非常满意。
//   故删掉 body[data-theme='light'] .immersive 覆盖 → 沉浸页在 app 深/浅色下都走上方 .immersive 默认(深色)值,
//   两端同款深色。深色模式表现完全不变。要恢复"分深浅"见 git review-fixes 轮 abb40dc(TODO3)。
.imm-fade-enter-active,
.imm-fade-leave-active {
  transition: opacity 0.32s ease, transform 0.32s cubic-bezier(0.2, 0.7, 0.2, 1);
  will-change: opacity, transform; // 仅 active 类，动画结束自动移除，不常驻提层
}
// [性能·降热] 进出 0.32s 期间临时去掉磨砂层 backdrop-filter——否则 opacity 动画每帧都重算
//   blur(24px)(叠加 imm-bg-cover blur64 双层滤镜)→ CPU 尖峰/掉帧(疑与双击最大化时鼠标缓慢/
//   闪退相关，见 known-bugs)。动画期用 --imm-frost 纯色压暗兜底(视觉几乎无损)，落定后恢复 blur。
.imm-fade-enter-active .imm-bg-frost,
.imm-fade-leave-active .imm-bg-frost {
  backdrop-filter: none;
}
.imm-fade-enter,
.imm-fade-leave-to {
  opacity: 0;
  transform: translateY(24px);
}

// ---- 背景三层(静态)：模糊封面打底 + 三色柔和渐变 + 磨砂噪点 ----
.imm-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}
.imm-bg-cover {
  position: absolute;
  inset: -12%; // ≈124% 覆盖，大半径 blur 边缘不露空
  background-size: cover;
  background-position: center;
  filter: blur(64px) saturate(1.15);
  transform: scale(1.15);
  opacity: 0.5;
}
.imm-bg-tint {
  position: absolute;
  inset: 0;
  // background 由 inline :style="immBg"(三色径向渐变)注入
}
.imm-bg-frost {
  position: absolute;
  inset: 0;
  background: var(--imm-frost); // 固定深色磨砂压暗(--imm-frost 唯一深色值)
  // [perf·审P1-8] 去掉常驻 backdrop-filter: blur(24px)——身后 .imm-bg-cover 已 blur(64px)+柔和渐变，
  //   再叠 24px 磨砂对观感增益微乎其微，却让页内每帧动画(封面 scale/进度/nyancat/充能)触发全屏
  //   backdrop 重采样模糊 → 低端/4K 发烫掉帧(关联 known-bugs「双击最大化疑似闪退」)。进出动画期
  //   (imm-fade)早已置 backdrop-filter:none 兜底且实测「视觉几乎无损」，故稳态一并去除；磨砂质感
  //   由底层 blur(64px) 底图提供。【待真机/4K 视觉确认】
  // 极轻噪点：内联 svg feTurbulence(高级磨砂感)
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='110' height='110'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    opacity: 0.04;
    mix-blend-mode: overlay;
  }
}

// ---- 顶部收起(P1 再加 ESC/顶部 hover 提示) ----
.imm-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 clamp(12px, 2vw, 28px);
  z-index: 4;
  // [修·收回按钮点不动] 收回按钮落在顶部 32px 的 .imm-drag-bar(app-region:drag)区上方，
  //   OS 级拖拽区会吞掉 click(z-index 高也没用)。给按钮显式 no-drag 夺回点击；其余顶边仍可拖。
  .imm-collapse {
    -webkit-app-region: no-drag;
  }
  .imm-collapse .svg-icon {
    width: 22px;
    height: 22px;
    color: var(--imm-text-2nd);
  }
}

// ---- 主体 ----
.imm-stage {
  position: relative;
  z-index: 2;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 56px 16px 30px;
  box-sizing: border-box;
}
.imm-col {
  // 封面=方形；列宽同时受视口高/宽与上限约束 → 封面、信息、进度、控制天然「与封面同宽」
  width: min(58vh, 86vw, 620px);
  display: flex;
  flex-direction: column;
  // [性能·补动画] 窗口最大化/还原时列宽随视口(vh/vw)变化平滑缓动(原硬切瞬跳)；只此收敛容器
  //   过渡 width、子元素百分比跟随。绝不给 .immersive/.imm-bg 加尺寸过渡(会逼双层滤镜逐帧重算发烫)。
  transition: width 0.26s cubic-bezier(0.2, 0.7, 0.2, 1);
}

// 大封面：方槽内 scale，播放 1 / 暂停 0.82，下方布局不跳动
.imm-cover-slot {
  width: 100%;
  aspect-ratio: 1 / 1;
  display: flex;
  align-items: center;
  justify-content: center;
  // [批注] 加大封面↔下方块间距 → 「节目名+进度条+控制」整块下移、封面上提，呼吸更足
  margin-bottom: clamp(28px, 5vh, 58px);
  transition: margin-bottom 0.26s cubic-bezier(0.2, 0.7, 0.2, 1); // [性能·补动画] 最大化时间距平滑
}
.imm-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: clamp(12px, 1.4vw, 16px);
  box-shadow: 0 30px 60px -12px rgba(0, 0, 0, 0.55),
    0 0 0 1px rgba(255, 255, 255, 0.04);
  transition: transform 0.45s cubic-bezier(0.2, 0.7, 0.2, 1),
    box-shadow 0.45s ease;
  transform: scale(1);
  &.paused {
    transform: scale(0.82);
    box-shadow: 0 16px 34px -14px rgba(0, 0, 0, 0.5);
  }
}

// 节目名/单集名(整行可点击)；收藏已移到下方控制行
.imm-meta {
  // [批注] 再加大「节目名↔进度条」间距 → 进度条+控制整块再下移；hover 时间提示也不会撞到节目名
  margin-bottom: clamp(20px, 3.4vh, 40px);
  transition: margin-bottom 0.26s cubic-bezier(0.2, 0.7, 0.2, 1); // [性能·补动画] 最大化时间距平滑
  .imm-text {
    min-width: 0;
  }
  .imm-ep {
    font-size: clamp(16px, 1.5vw, 22px);
    font-weight: 700;
    line-height: 1.25;
    color: var(--imm-text);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    &:hover {
      text-decoration: underline;
    }
  }
  .imm-pod {
    margin-top: 4px;
    font-size: clamp(12px, 1vw, 14px);
    color: var(--imm-text-weak);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    &:hover {
      text-decoration: underline;
      color: var(--imm-text-2nd);
    }
  }
}

// 进度条：细胶囊、首尾不显时间(仅 hover 浮出)
.imm-progress {
  position: relative;
  margin-bottom: clamp(14px, 2.4vh, 26px);
  // 白色胶囊样式：仅在「非彩虹猫」时生效。开了 nyancat 就整段让位给全局 .nyancat 彩虹猫样式
  //   (slider.css；本组件 scoped 白色规则带 data 属性、特异性更高，会压过彩虹猫，故用 :not 排除)。
  &:not(.nyancat) {
    ::v-deep .vue-slider-rail {
      background-color: var(--imm-rail);
      border-radius: 999px;
    }
    ::v-deep .vue-slider-process {
      background-color: var(--imm-accent);
      border-radius: 999px;
    }
    ::v-deep .vue-slider-dot-handle {
      background-color: var(--imm-accent);
      box-shadow: 0 1px 6px rgba(0, 0, 0, 0.4);
      visibility: hidden; // 干净：平时藏点，hover/拖动才现
    }
    ::v-deep .vue-slider:hover .vue-slider-dot-handle,
    ::v-deep .vue-slider:active .vue-slider-dot-handle {
      visibility: visible;
    }
  }
  // [批注] 去掉黑底小弹窗(太丑/显示突兀)：纯白字 + 文字阴影，亮背景上也看得清，无方框
  .progress-hover-tip {
    bottom: calc(100% + 8px);
    background: transparent;
    color: var(--imm-text);
    padding: 0;
    box-shadow: none;
    opacity: 1;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.75), 0 0 2px rgba(0, 0, 0, 0.6);
  }
}

// 一行控制：整行铺满(与进度条/节目名等宽)。左组(倍速/列表/睡眠) | 中三大金刚 | 右组(标记/收藏/音量)，
//   左右两组各自贴边、以金刚为对称中心；组内稍疏。
.imm-controls {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
}
.imm-side {
  display: flex;
  align-items: center;
  gap: clamp(4px, 0.9vw, 14px); // 疏一点
}
.imm-side-left {
  justify-content: flex-start; // 贴左缘
}
.imm-side-right {
  justify-content: flex-end; // 贴右缘
}
// 左右两组功能图标统一尺寸(队列/睡眠/收藏/音量)
.imm-side ::v-deep .button-icon .svg-icon {
  width: 20px;
  height: 20px;
}
// 去掉 button-icon 自带 margin:4px → 组内间距只由 gap 控制，与 div 型控件(倍速/标记)对齐均匀
.imm-side ::v-deep .button-icon {
  margin: 0;
}
// 倍速文字键：浅色 + 统一 36px 宽(去 bar 的 56px)。让左组(倍速/列表/睡眠)与右组(标记/收藏/音量)
//   6 个键全部 36px 等宽 → 两组宽度相等 → 各自贴边时到三大金刚的内侧空白自动相等(修批注「gap2 偏宽」)。
.immersive .rate-button {
  width: 36px;
  padding: 4px 0;
  color: var(--imm-text-2nd);
  &:hover {
    background: rgba(127, 127, 127, 0.16);
  }
  &.active {
    color: var(--imm-text);
  }
}
// 队列/睡眠激活态
.imm-side ::v-deep .button-icon.active .svg-icon {
  color: var(--color-primary);
}
// 收藏：已收藏=纯白实心(沉浸页固定深色不用红色按钮打扰；纯白 heart-solid 区别于未收藏的浅描边 heart)
.imm-like.favorited ::v-deep .svg-icon {
  color: #fff;
}
// 标记键：浅色 + hover 底；充能圈/彩蛋复用 .mark-control，去默认左右 margin、统一 36×36(与其余 5 键等宽)
.imm-mark {
  margin: 0;
  width: 36px;
  height: 36px;
  color: var(--imm-text-2nd);
  &:hover {
    background: rgba(127, 127, 127, 0.16);
  }
  .mark-icon {
    width: 20px;
    height: 20px;
  }
  // [修] 长按充能圈在深色沉浸页上需更高 opacity 才看得清(覆盖 .mark-control 的 0.26)；
  //   3 秒线性放大填满的动画本身复用 .mark-control.charging，无需重写。
  .mark-charge {
    opacity: 0.45;
  }
}
// 音量：点击弹出滑条弹窗(沉浸页专用，区别于 bar 常驻滑条)
.vol-control {
  position: relative;
  display: flex;
  align-items: center;
}
.vol-menu {
  position: absolute;
  bottom: calc(100% + 12px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--color-body-bg);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18),
    0 0 0 1px rgba(127, 127, 127, 0.12);
  padding: 13px 14px;
  width: 220px;
  z-index: 110;
  color: var(--color-text);
}
// 形状对齐睡眠弹窗：label 一行 + 滑条独占一行(.vol-track flex 撑满，绕开 vue-slider width:auto 塌缩)
.vol-slider {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  .v-label {
    font-size: 12px;
    font-weight: 600;
    opacity: 0.7;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .vol-track {
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    min-height: 20px;
  }
  .vol-track .vue-slider {
    flex: 1;
  }
  ::v-deep .vue-slider-rail {
    background-color: rgba(128, 128, 128, 0.5);
    border-radius: 4px;
  }
  ::v-deep .vue-slider-process {
    background-color: var(--color-primary);
    border-radius: 4px;
  }
  ::v-deep .vue-slider-dot-handle {
    visibility: visible;
    background-color: var(--color-primary);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  }
}
// 三大金刚：无圆圈、播放键更大、居中、组内稍疏
.imm-king {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(10px, 1.8vw, 24px);
  .imm-seek ::v-deep .svg-icon {
    width: clamp(20px, 2vw, 26px);
    height: clamp(20px, 2vw, 26px);
    color: var(--imm-text);
  }
  .imm-play ::v-deep .svg-icon {
    width: clamp(30px, 3.2vw, 42px);
    height: clamp(30px, 3.2vw, 42px);
    color: var(--imm-text);
  }
}

// [TODO3] 原 [审操作#17] 把沉浸页内弹窗(倍速/队列/睡眠/音量)主题隔离为固定深色;按"改回随主题"
//   的最新意见**去掉该隔离** —— 弹窗改为跟随全局深浅色(沉浸页本体也已随主题:深色深磨砂/浅色浅磨砂),
//   二者一致、不再就地强制深色。如需弹窗与沉浸字色完全统一可后续再调。

// 顶部原生拖拽区：z-index 低于 imm-top(z-4) 的收起按钮，故按钮仍可点击；
//   整个 .immersive 有 no-drag，此元素显式 drag 覆盖 → Windows 可原生双击最大化/还原 + 拖动
.imm-drag-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 32px;
  z-index: 3;
  -webkit-app-region: drag;
}
/* [睡眠到点关机] 可取消的关机倒计时浮层 */
.shutdown-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
}
.shutdown-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 32px 40px;
  // [关机弹窗固定面积] 固定宽度：避免倒计时数字位数变化(60→9)致卡片宽度跳动
  width: 300px;
  box-sizing: border-box;
  border-radius: 16px;
  background: var(--color-body-bg);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
  color: var(--color-text);
  text-align: center;
  .sd-icon {
    width: 40px;
    height: 40px;
    color: var(--color-primary);
  }
  .sd-title {
    font-size: 18px;
    font-weight: 700;
  }
  .sd-desc {
    font-size: 14px;
    opacity: 0.7;
    b {
      // [关机弹窗固定面积] 数字占固定槽宽 + 等宽数字 → 1↔2 位切换时文字不左右挪动
      display: inline-block;
      min-width: 1.4em;
      text-align: center;
      font-variant-numeric: tabular-nums;
      color: var(--color-primary);
      font-size: 16px;
    }
  }
  .sd-cancel {
    margin-top: 4px;
    padding: 10px 28px;
    border: none;
    border-radius: 10px;
    background: var(--color-primary);
    color: #fff;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.15s, opacity 0.15s;
    &:hover {
      transform: scale(1.04);
      opacity: 0.92;
    }
  }
}
</style>
