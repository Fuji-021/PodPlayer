<template>
  <section class="subscription-episode-feed">
    <div
      ref="feedList"
      class="updates-window"
      :style="{
        paddingTop: virtualTopSpace + 'px',
        paddingBottom: virtualBottomSpace + 'px',
      }"
    >
      <div
        v-for="item in virtualItems"
        :key="item.key"
        class="update-virtual-item"
        :class="'is-' + item.type"
      >
        <div
          v-if="item.type === 'group'"
          class="update-date-group"
          role="heading"
          aria-level="2"
        >
          {{ item.group.label }}
        </div>
        <SubscriptionEpisodeRow
          v-else
          :episode="item.episode"
          :get-episode-state="getEpisodeState"
          @open-episode="$emit('open-episode', $event)"
          @open-podcast="$emit('open-podcast', $event)"
          @play="$emit('play', $event)"
          @menu="forwardMenu"
        />
      </div>
    </div>

    <transition name="updates-back-top">
      <button
        v-show="showBackTop"
        v-tip="'回到更新页顶部'"
        class="updates-back-top"
        aria-label="回到更新页顶部"
        @click="scrollToTopSmooth"
      >
        <svg-icon icon-class="arrow-up" />
      </button>
    </transition>
  </section>
</template>

<script>
import SvgIcon from '@/components/SvgIcon.vue';
import SubscriptionEpisodeRow from './SubscriptionEpisodeRow.vue';
import {
  findFixedVirtualIndex,
  getStableVirtualRange,
} from '@/utils/podcast/subscriptionUpdatesRules';

const VIRTUAL_BUFFER = 12;
const VIRTUAL_GUARD = 4;

export default {
  name: 'SubscriptionEpisodeFeed',
  components: { SvgIcon, SubscriptionEpisodeRow },
  props: {
    view: { type: Object, default: null },
    getEpisodeState: { type: Function, required: true },
  },
  data() {
    return {
      winStart: 0,
      winEnd: 0,
      showBackTop: false,
    };
  },
  computed: {
    metrics() {
      return (this.view && this.view.metrics) || [];
    },
    virtualItems() {
      return this.metrics.slice(this.winStart, this.winEnd);
    },
    totalHeight() {
      return (this.view && this.view.totalHeight) || 0;
    },
    virtualTopSpace() {
      const first = this.metrics[this.winStart];
      return first ? first.top : 0;
    },
    virtualBottomSpace() {
      const last = this.metrics[this.winEnd - 1];
      const used = last ? last.top + last.height : 0;
      return Math.max(0, this.totalHeight - used);
    },
  },
  watch: {
    view() {
      this._viewToken = (this._viewToken || 0) + 1;
      this.$nextTick(() => {
        this._feedListTop = null;
        this.recalcWindow(true);
      });
    },
  },
  mounted() {
    this._destroyed = false;
    this._isActive = true;
    this.bindMainScroll();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.handleViewportResize);
    }
    this.$nextTick(() => this.recalcWindow(true));
  },
  activated() {
    this._isActive = true;
    this.bindMainScroll();
    this.$nextTick(() => this.recalcWindow(true));
  },
  deactivated() {
    this._isActive = false;
    this.unbindMainScroll();
    this.stopScrollAnimation();
    if (this._resizeRaf) {
      cancelAnimationFrame(this._resizeRaf);
      this._resizeRaf = null;
    }
  },
  beforeDestroy() {
    this._destroyed = true;
    this.unbindMainScroll();
    this.stopScrollAnimation();
    if (this._virtualRaf) cancelAnimationFrame(this._virtualRaf);
    if (this._hydrateTimer) clearTimeout(this._hydrateTimer);
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.handleViewportResize);
    }
  },
  methods: {
    forwardMenu(event, episode) {
      this.$emit('menu', event, episode);
    },
    getMainScrollElement() {
      return this._scrollEl || (this.$el && this.$el.closest('main'));
    },
    bindMainScroll() {
      const main = this.getMainScrollElement();
      if (main) {
        this.bindMainScrollTarget(main);
        return;
      }
      this.$nextTick(() => {
        if (this._destroyed || this._mainScrollBound) return;
        const delayed = this.getMainScrollElement();
        if (delayed) this.bindMainScrollTarget(delayed);
      });
    },
    bindMainScrollTarget(main) {
      if (!main || this._mainScrollBound === main) return;
      this.unbindMainScroll();
      this._scrollEl = main;
      this._mainScrollBound = main;
      main.addEventListener('scroll', this.onMainScroll, { passive: true });
      main.addEventListener('wheel', this.stopScrollAnimation, {
        passive: true,
      });
      main.addEventListener('pointerdown', this.stopScrollAnimation, {
        passive: true,
      });
      main.addEventListener('touchstart', this.stopScrollAnimation, {
        passive: true,
      });
      this.showBackTop = main.scrollTop > 520;
    },
    unbindMainScroll() {
      const main = this._mainScrollBound;
      if (!main) return;
      main.removeEventListener('scroll', this.onMainScroll);
      main.removeEventListener('wheel', this.stopScrollAnimation);
      main.removeEventListener('pointerdown', this.stopScrollAnimation);
      main.removeEventListener('touchstart', this.stopScrollAnimation);
      this._mainScrollBound = null;
      this._scrollEl = null;
    },
    onMainScroll() {
      if (this._virtualRaf) return;
      this._virtualRaf = requestAnimationFrame(() => {
        this._virtualRaf = null;
        const main = this.getMainScrollElement();
        this.showBackTop = !!(main && main.scrollTop > 520);
        this.recalcWindow(false);
      });
    },
    handleViewportResize() {
      if (!this._isActive || this._resizeRaf) return;
      this._resizeRaf = requestAnimationFrame(() => {
        this._resizeRaf = null;
        if (this._destroyed || !this._isActive) return;
        this._feedListTop = null;
        this.recalcWindow(true);
      });
    },
    recalcWindow(forceMeasure) {
      const metrics = this.metrics;
      const main = this.getMainScrollElement();
      const list = this.$refs.feedList;
      if (!metrics.length || !main || !list) {
        this.winStart = 0;
        this.winEnd = metrics.length;
        this.scheduleVisibleHydration();
        return;
      }
      if (forceMeasure || !Number.isFinite(this._feedListTop)) {
        const mainRect = main.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        this._feedListTop = main.scrollTop + listRect.top - mainRect.top;
      }
      const viewportStart = main.scrollTop - this._feedListTop;
      const visibleStart = Math.max(0, viewportStart);
      const visibleEnd = Math.max(
        visibleStart,
        viewportStart + main.clientHeight
      );
      const firstVisible = findFixedVirtualIndex(metrics, visibleStart);
      const lastVisible = findFixedVirtualIndex(
        metrics,
        Math.max(visibleStart, visibleEnd - 1)
      );
      const range = getStableVirtualRange({
        itemCount: metrics.length,
        firstVisible,
        lastVisible,
        currentStart: this.winStart,
        currentEnd: this.winEnd,
        buffer: VIRTUAL_BUFFER,
        guard: VIRTUAL_GUARD,
        force: !!forceMeasure,
      });
      if (range.changed || forceMeasure) {
        this.winStart = range.start;
        this.winEnd = range.end;
        this.scheduleVisibleHydration();
      }
    },
    scheduleVisibleHydration() {
      if (this._hydrateTimer) clearTimeout(this._hydrateTimer);
      const token = (this._hydrateToken || 0) + 1;
      this._hydrateToken = token;
      this._hydrateTimer = setTimeout(() => {
        if (this._destroyed || token !== this._hydrateToken) return;
        const episodes = this.virtualItems
          .filter(item => item.type === 'episode')
          .map(item => item.episode);
        this.$emit('visible-episodes', episodes, token);
      }, 150);
    },
    scrollToTop() {
      const main = this.getMainScrollElement();
      this.stopScrollAnimation();
      if (main) main.scrollTop = 0;
      this.showBackTop = false;
    },
    scrollToTopSmooth() {
      const main = this.getMainScrollElement();
      if (!main || main.scrollTop <= 0) return;
      this.stopScrollAnimation();
      const start = main.scrollTop;
      const duration = Math.min(420, Math.max(240, 180 + Math.sqrt(start) * 2));
      const startedAt = performance.now();
      const tick = now => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 4);
        main.scrollTop = start * (1 - eased);
        if (progress < 1) this._feedScrollRaf = requestAnimationFrame(tick);
        else {
          this._feedScrollRaf = null;
          main.scrollTop = 0;
          this.showBackTop = false;
        }
      };
      this._feedScrollRaf = requestAnimationFrame(tick);
    },
    stopScrollAnimation() {
      if (!this._feedScrollRaf) return;
      cancelAnimationFrame(this._feedScrollRaf);
      this._feedScrollRaf = null;
    },
    resetToTop() {
      this.scrollToTop();
      this.$nextTick(() => this.recalcWindow(true));
    },
  },
};
</script>

<style lang="scss" scoped>
.subscription-episode-feed {
  position: relative;
  border-top: 1px solid var(--color-secondary-bg);
}

.update-virtual-item.is-group {
  height: 34px;
}

.update-virtual-item.is-episode {
  height: 96px;
}

.update-date-group {
  display: flex;
  height: 34px;
  align-items: flex-end;
  padding: 0 2px 7px;
  box-sizing: border-box;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 700;
}

.updates-back-top {
  position: fixed;
  right: clamp(24px, 4vw, 64px);
  bottom: 108px;
  z-index: 24;
  display: inline-flex;
  width: 42px;
  height: 42px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--color-text);
  background: var(--color-body-bg);
  box-shadow: 0 5px 18px rgba(0, 0, 0, 0.18);

  .svg-icon {
    width: 18px;
    height: 18px;
  }

  &:hover {
    color: var(--color-primary);
    background: var(--color-secondary-bg);
  }
}

.updates-back-top-enter-active,
.updates-back-top-leave-active {
  transition: opacity 120ms ease-out, transform 120ms ease-out;
}

.updates-back-top-enter,
.updates-back-top-leave-to {
  opacity: 0;
  transform: translateY(5px);
}
</style>
