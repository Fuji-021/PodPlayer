<template>
  <!-- [B-44] 发现页/二级页统一卡片：封面零常驻状态，状态走 hover 按钮 + 右键 overlay，
       与「我的订阅」封面交互一致（区别：未订阅默认动作=订阅）。订阅状态读 store，全局同步。 -->
  <div
    class="disc-card"
    :class="{ 'overlay-mode': overlayMode }"
    @click="onCardClick"
    @contextmenu.prevent="onContextMenu"
  >
    <div class="cover-box">
      <!-- 借鉴原项目 Cover：封面图自身虚化倒影光晕（所有位置封面一致的"背景的那个光"） -->
      <div
        class="cover-shadow"
        :style="{ backgroundImage: `url(${cover})` }"
      ></div>
      <div class="cover-wrap">
        <PodImage class="cover" :src="cover" @error="onImgError" />
        <!-- 订阅中：封面压暗 + 居中转圈（仅订阅过程，转瞬即逝） -->
        <div v-if="busy" class="cover-loading"
          ><span class="spinner"></span
        ></div>
        <!-- hover 按钮：未订阅=方形+；已订阅=方形勾（绿）。仅 hover 显示，点击切换订阅 -->
        <button
          v-show="!overlayMode"
          class="act-btn"
          :class="{ subbed: subbed }"
          :disabled="busy"
          :title="subbed ? '已订阅 · 点击取消订阅' : '订阅到我的'"
          @click.stop="onToggle"
        >
          <svg-icon :icon-class="subbed ? 'checkbox' : 'square-plus'" />
        </button>
        <!-- 右键 overlay：对齐「我的订阅」（封面变暗 + 居中图标/文字）。
             未订阅=订阅；已订阅=取消订阅 -->
        <div
          v-if="overlayMode"
          class="ctx-overlay"
          @click.stop="onBlock"
          @mouseenter="cancelAutoClose"
          @mouseleave="scheduleAutoClose"
        >
          <svg-icon icon-class="ban" />
          <div class="label">屏蔽</div>
        </div>
      </div>
    </div>
    <div class="card-name">
      <span class="cn-text">{{ podcast.name }}</span>
      <!-- [B-49] 已订阅绿点（少数派标记；封面仍零常驻状态，点在名字旁不在封面上） -->
      <span v-if="subbed" class="src-dot" title="已订阅"></span>
    </div>
    <div class="card-meta">
      {{ podcast.primaryGenreName }} · {{ fmtCount(podcast.avgPlayCount) }}
    </div>
  </div>
</template>

<script>
import SvgIcon from '@/components/SvgIcon.vue';
import {
  subscribePodcast,
  previewPodcast,
  hiResLogo,
} from '@/utils/podcast/discover';
import { deletePodcast } from '@/utils/podcast/service';

export default {
  name: 'DiscoverCard',
  components: { SvgIcon },
  props: {
    podcast: { type: Object, required: true },
  },
  data() {
    return {
      busy: false,
      overlayMode: false,
      outsideListener: null,
      keyListener: null,
      autoTimer: null,
    };
  },
  computed: {
    // 全局订阅映射（节目名 → feedUrl）。store 变化时所有位置同名卡片同步刷新。
    subscribedMap() {
      return this.$store.state.podcastDiscover.subscribedMap;
    },
    name() {
      return (
        this.podcast && this.podcast.name ? this.podcast.name : ''
      ).trim();
    },
    subbed() {
      return !!this.feedUrl;
    },
    feedUrl() {
      if (this.subscribedMap[this.name]) return this.subscribedMap[this.name];
      // [B56-4] 搜索结果自带 feedUrl，名字可能与 RSS 标题不一致 → 按 feedUrl 反查是否已订阅
      const feed = this.podcast && this.podcast.feedUrl;
      if (feed && Object.values(this.subscribedMap).includes(feed)) return feed;
      return '';
    },
    cover() {
      return hiResLogo(this.podcast.logoURL);
    },
  },
  beforeDestroy() {
    this.closeOverlay();
  },
  methods: {
    // 左键：进节目详情。已订阅用本地 feedUrl 秒进；未订阅走"预览"(入库不订阅)再进，可试听
    onCardClick() {
      if (this.overlayMode) {
        this.closeOverlay();
        return;
      }
      this.openPodcast();
    },
    async openPodcast() {
      // 已订阅：本地 feedUrl 秒进
      if (this.feedUrl) {
        this.$router.push({
          name: 'podcastDetail',
          params: { feedUrlEncoded: encodeURIComponent(this.feedUrl) },
        });
        return;
      }
      if (this.busy) return;
      this.busy = true;
      try {
        // [B-50] 未订阅：预览（入库但不订阅，不进我的订阅、不算已订阅状态），再进详情
        const { feedUrl } = await previewPodcast(this.podcast);
        this.$router.push({
          name: 'podcastDetail',
          params: { feedUrlEncoded: encodeURIComponent(feedUrl) },
        });
      } catch (e) {
        this.toast('打开失败：' + ((e && e.message) || e));
      } finally {
        this.busy = false;
      }
    },
    // hover 按钮点击：已订阅→取消订阅；未订阅→订阅（都不跳转）
    onToggle() {
      if (this.busy) return;
      if (this.subbed) this.unsubscribe();
      else this.subscribe();
    },
    async subscribe() {
      if (this.busy || this.subbed) return;
      this.busy = true;
      try {
        const { podcast, feedUrl } = await subscribePodcast(this.podcast);
        this.markSubscribed(podcast, feedUrl);
        this.toast(
          `已订阅：${(podcast && podcast.title) || this.podcast.name}`
        );
        this.$emit('changed');
      } catch (e) {
        this.toast('订阅失败：' + ((e && e.message) || e));
      } finally {
        this.busy = false;
      }
    },
    async unsubscribe() {
      const feed = this.feedUrl;
      if (this.busy || !feed) return;
      this.busy = true;
      try {
        await deletePodcast(feed);
        this.$store.commit('removeSubscribedPodcast', {
          feedUrl: feed,
          name: this.name,
        });
        this.toast('已取消订阅');
        this.$emit('changed');
      } catch (e) {
        this.toast('取消订阅失败：' + ((e && e.message) || e));
      } finally {
        this.busy = false;
      }
    },
    // 订阅成功登记 store（榜单名 + RSS 标题都登记，二者可能略异）
    markSubscribed(podcast, feedUrl) {
      this.$store.commit('addSubscribedPodcast', {
        name: this.podcast.name,
        feedUrl,
      });
      if (podcast && podcast.title && podcast.title.trim() !== this.name) {
        this.$store.commit('addSubscribedPodcast', {
          name: podcast.title,
          feedUrl,
        });
      }
    },
    // 右键：弹封面 overlay（与「我的订阅」同款）。再次右键 / 点外部 / Esc / 5s 关闭
    onContextMenu() {
      if (this.overlayMode) {
        this.closeOverlay();
        return;
      }
      this.overlayMode = true;
      this.$nextTick(() => {
        this.outsideListener = ev => {
          if (!ev.target.closest('.disc-card')) this.closeOverlay();
        };
        this.keyListener = ev => {
          if (ev.key === 'Escape') this.closeOverlay();
        };
        document.addEventListener('mousedown', this.outsideListener);
        document.addEventListener('keydown', this.keyListener);
        this.scheduleAutoClose();
      });
    },
    // [B-47 第5点] 右键 = 屏蔽该节目（取代原订阅/取消订阅；订阅靠右下角按钮）
    onBlock() {
      this.closeOverlay();
      this.$store.commit('addBlockedPodcast', {
        name: this.name,
        coverUrl: this.cover,
      });
      this.toast(`已屏蔽：${this.podcast.name}`);
      this.$emit('changed');
    },
    scheduleAutoClose() {
      if (this.autoTimer) clearTimeout(this.autoTimer);
      this.autoTimer = setTimeout(() => this.closeOverlay(), 5000);
    },
    cancelAutoClose() {
      if (this.autoTimer) {
        clearTimeout(this.autoTimer);
        this.autoTimer = null;
      }
    },
    closeOverlay() {
      this.overlayMode = false;
      if (this.outsideListener) {
        document.removeEventListener('mousedown', this.outsideListener);
        this.outsideListener = null;
      }
      if (this.keyListener) {
        document.removeEventListener('keydown', this.keyListener);
        this.keyListener = null;
      }
      this.cancelAutoClose();
    },
    toast(msg) {
      this.$store.dispatch('showToast', msg);
    },
    fmtCount(n) {
      n = Number(n) || 0;
      if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
      if (n >= 1e4) return Math.round(n / 1e4) + '万';
      return String(n);
    },
    onImgError(e) {
      e.target.style.opacity = 0.15;
    },
  },
};
</script>

<style lang="scss" scoped>
.disc-card {
  cursor: pointer;
  // [B-48 第2/3点] hover 放大放到 cover-box（整框上浮放大），配合 cover-wrap overflow:hidden →
  //   遮罩(loading/ctx-overlay) inset:0 始终盖满封面，不再"小一圈"（与我的订阅同逻辑）
  &:hover .cover-box {
    transform: translateY(-4px) scale(1.02);
  }
  &:hover .cover-shadow {
    filter: blur(20px) opacity(0.6);
  }
  &:hover .act-btn {
    opacity: 1;
  }
}
.cover-box {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  transition: transform 0.25s;
}
// 封面虚化光晕（在 cover-wrap 之外，可超出不被裁切）。随 cover-box 一起 hover 放大。
.cover-shadow {
  position: absolute;
  left: 0;
  top: 12px;
  width: 100%;
  height: 100%;
  border-radius: 12px;
  background-size: cover;
  background-position: center;
  filter: blur(16px) opacity(0.45);
  transform: scale(0.92);
  z-index: 0;
  transition: filter 0.25s;
}
.cover-wrap {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  border-radius: 12px;
  overflow: hidden; // 裁切封面 → 加载/右键遮罩 inset:0 盖满，不留一圈
}
.cover {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 12px;
  object-fit: cover;
  background: var(--color-secondary-bg);
  transition: filter 0.25s;
  z-index: 1;
}
.act-btn {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 2;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0; // 仅 hover 显示，封面零常驻状态
  transition: opacity 0.15s, background 0.15s, transform 0.15s;
  .svg-icon {
    width: 18px;
    height: 18px;
  }
  &:hover {
    background: var(--color-primary);
    transform: scale(1.1);
  }
  // 已订阅：方形绿勾（hover 才显示，不常驻）
  &.subbed {
    color: #fff;
    background: rgba(39, 174, 96, 0.92);
    &:hover {
      background: rgba(39, 174, 96, 0.92);
      transform: scale(1.1);
    }
  }
  &:disabled {
    cursor: default;
  }
}
// [B-47 第2点] 右键 overlay：去掉半透明黑底，改为靠封面 filter 变暗（复用「我的订阅」处理）
.ctx-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  border-radius: 12px;
  background: transparent;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #fff;
  cursor: pointer;
  transition: 0.2s;
  .svg-icon {
    width: 34px;
    height: 34px;
  }
  .label {
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 0.5px;
  }
  &:hover {
    color: var(--color-primary);
  }
}
// [B-47/B-48 第2点] 复用「我的订阅」unsub-mode：封面变暗（放大由 cover-box hover 提供）
.disc-card.overlay-mode .cover {
  filter: brightness(0.3);
}
.cover-loading {
  position: absolute;
  inset: 0;
  z-index: 4;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.42);
  display: flex;
  align-items: center;
  justify-content: center;
  .spinner {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 3px solid rgba(255, 255, 255, 0.35);
    border-top-color: #fff;
    animation: discCardSpin 0.8s linear infinite;
  }
}
.card-name {
  margin-top: 10px;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  .cn-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0; // 允许收缩，名字长时省略号、绿点仍可见
  }
}
// [B-49] 已订阅绿点：紧挨名字、句号大小、稀疏（不被名字省略号裁掉）
.src-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-left: 5px;
  background: #27ae60;
}
.card-meta {
  margin-top: 3px;
  font-size: 12px;
  opacity: 0.55;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes discCardSpin {
  to {
    transform: rotate(360deg);
  }
}
</style>
