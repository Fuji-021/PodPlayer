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

    <MainScrollBackToTop />
  </section>
</template>

<script>
import MainScrollBackToTop from '@/components/MainScrollBackToTop.vue';
import SubscriptionEpisodeRow from './SubscriptionEpisodeRow.vue';
import {
  findFixedVirtualIndex,
  getStableVirtualRange,
} from '@/utils/podcast/subscriptionUpdatesRules';

const VIRTUAL_BUFFER = 12;
const VIRTUAL_GUARD = 4;

export default {
  name: 'SubscriptionEpisodeFeed',
  components: { MainScrollBackToTop, SubscriptionEpisodeRow },
  props: {
    view: { type: Object, default: null },
    getEpisodeState: { type: Function, required: true },
  },
  data() {
    return {
      winStart: 0,
      winEnd: 0,
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
    this.cancelVirtualFrame();
    this.cancelVisibleHydration();
    if (this._resizeRaf) {
      cancelAnimationFrame(this._resizeRaf);
      this._resizeRaf = null;
    }
  },
  beforeDestroy() {
    this._destroyed = true;
    this._isActive = false;
    this.unbindMainScroll();
    this.cancelVirtualFrame();
    this.cancelVisibleHydration();
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
        if (this._destroyed || !this._isActive || this._mainScrollBound) {
          return;
        }
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
    },
    unbindMainScroll() {
      const main = this._mainScrollBound;
      if (!main) return;
      main.removeEventListener('scroll', this.onMainScroll);
      this._mainScrollBound = null;
      this._scrollEl = null;
    },
    onMainScroll() {
      if (!this._isActive || this._virtualRaf) return;
      this._virtualRaf = requestAnimationFrame(() => {
        this._virtualRaf = null;
        if (this._destroyed || !this._isActive) return;
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
      if (this._destroyed || !this._isActive) return;
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
      if (this._destroyed || !this._isActive) return;
      if (this._hydrateTimer) clearTimeout(this._hydrateTimer);
      const token = (this._hydrateToken || 0) + 1;
      this._hydrateToken = token;
      this._hydrateTimer = setTimeout(() => {
        if (token === this._hydrateToken) this._hydrateTimer = null;
        if (
          this._destroyed ||
          !this._isActive ||
          token !== this._hydrateToken
        ) {
          return;
        }
        const episodes = this.virtualItems
          .filter(item => item.type === 'episode')
          .map(item => item.episode);
        this.$emit('visible-episodes', episodes, token);
      }, 150);
    },
    cancelVirtualFrame() {
      if (this._virtualRaf) cancelAnimationFrame(this._virtualRaf);
      this._virtualRaf = null;
    },
    cancelVisibleHydration() {
      this._hydrateToken = (this._hydrateToken || 0) + 1;
      if (this._hydrateTimer) clearTimeout(this._hydrateTimer);
      this._hydrateTimer = null;
    },
    resetToTop() {
      const main = this.getMainScrollElement();
      if (main) main.scrollTop = 0;
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
</style>
