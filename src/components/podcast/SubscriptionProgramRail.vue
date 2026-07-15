<template>
  <section
    class="subscription-program-rail"
    aria-label="节目快速选择"
    data-selection="ui"
  >
    <div ref="root" class="program-rail">
      <button
        v-tip="'向左浏览'"
        class="rail-arrow"
        :disabled="!state.canPrev"
        aria-label="向左浏览"
        @click="scrollRail(-1)"
      >
        <svg-icon icon-class="arrow-left" />
      </button>
      <div
        ref="viewport"
        class="rail-viewport"
        tabindex="0"
        role="listbox"
        aria-orientation="horizontal"
        aria-label="按节目筛选更新"
        @keydown.left.prevent="moveRailFocus(-1)"
        @keydown.right.prevent="moveRailFocus(1)"
        @keydown.home.prevent="focusRailEdge(false)"
        @keydown.end.prevent="focusRailEdge(true)"
        @wheel="handleRailWheel"
        @pointerdown="interruptRailMotion"
        @scroll.passive="onScroll"
      >
        <button
          v-tip="'全部节目'"
          class="rail-item rail-all"
          :class="{ active: !selectedPodcastId }"
          :aria-selected="!selectedPodcastId"
          :tabindex="!selectedPodcastId ? 0 : -1"
          aria-label="全部节目"
          role="option"
          @click="select('')"
        >
          <span class="rail-all-icon"><svg-icon icon-class="list" /></span>
        </button>
        <button
          v-for="podcast in podcasts"
          :key="podcast.id"
          ref="items"
          ref-in-for
          class="rail-item"
          :class="{ active: selectedPodcastId === podcast.id }"
          :aria-selected="selectedPodcastId === podcast.id"
          :tabindex="selectedPodcastId === podcast.id ? 0 : -1"
          :aria-label="podcast.title || '未命名节目'"
          :data-podcast-id="podcast.id"
          role="option"
          @pointerenter="previewHalo(podcast)"
          @pointerleave="clearPreviewHalo(podcast)"
          @focus="previewHalo(podcast)"
          @blur="clearPreviewHalo(podcast)"
          @click="select(podcast.id)"
        >
          <span class="rail-cover">
            <span class="rail-cover-halo" :style="haloStyle(podcast)"></span>
            <PodImage class="rail-cover-image" :src="podcast.coverUrl" />
          </span>
        </button>
      </div>
      <button
        v-tip="'向右浏览'"
        class="rail-arrow"
        :disabled="!state.canNext"
        aria-label="向右浏览"
        @click="scrollRail(1)"
      >
        <svg-icon icon-class="arrow-right" />
      </button>
    </div>
    <div
      ref="track"
      class="rail-track"
      :class="{ 'is-hidden': !state.canScroll }"
      aria-hidden="true"
    >
      <div
        ref="thumb"
        class="rail-thumb"
        @pointerdown.prevent="startDrag"
      ></div>
    </div>
  </section>
</template>

<script>
import PodImage from '@/components/PodImage.vue';
import SvgIcon from '@/components/SvgIcon.vue';
import { ensureTinyCover, peekTinyCover } from '@/utils/podcast/coverHalo';
import {
  getRailArrowGoal,
  getRailMetrics,
  getRailMotionStep,
  getRailPositionMetrics,
  RAIL_EDGE_EPSILON,
  getRailThumbDragTarget,
  getRailThumbGeometry,
} from '@/utils/podcast/subscriptionUpdatesRules';

export default {
  name: 'SubscriptionProgramRail',
  components: { PodImage, SvgIcon },
  props: {
    podcasts: { type: Array, default: () => [] },
    selectedPodcastId: { type: String, default: '' },
  },
  data() {
    return {
      state: {
        canScroll: false,
        canPrev: false,
        canNext: false,
      },
      haloMap: {},
      previewPodcastId: '',
    };
  },
  watch: {
    podcasts() {
      this.$nextTick(() => this.updateMetrics(true));
    },
    selectedPodcastId(value) {
      this.$nextTick(() => {
        if (value) this.ensureSelectedVisible(value);
        const podcast = this.podcasts.find(item => item.id === value);
        if (podcast) this.warmHalo(podcast);
      });
    },
  },
  mounted() {
    this._destroyed = false;
    this.activateRail();
  },
  activated() {
    this._destroyed = false;
    this.activateRail();
  },
  deactivated() {
    this.deactivateRail();
  },
  beforeDestroy() {
    this._destroyed = true;
    this.deactivateRail();
  },
  methods: {
    activateRail() {
      if (this._railActive) return;
      this._railActive = true;
      this.$nextTick(() => {
        if (!this._railActive || this._destroyed) return;
        if (typeof ResizeObserver !== 'undefined') {
          this._resizeObserver = new ResizeObserver(() => this.updateMetrics());
          if (this.$refs.viewport)
            this._resizeObserver.observe(this.$refs.viewport);
          if (this.$refs.track) this._resizeObserver.observe(this.$refs.track);
        }
        this.updateMetrics();
        const selected = this.podcasts.find(
          item => item.id === this.selectedPodcastId
        );
        if (selected) this.warmHalo(selected);
      });
    },
    deactivateRail() {
      this._railActive = false;
      this._haloToken = (this._haloToken || 0) + 1;
      this._railGoal = null;
      this._railGoalDirection = null;
      this._controllerOwnsScroll = false;
      this.previewPodcastId = '';
      this.stopAnimation();
      this.finishDrag();
      if (this._scrollRaf) cancelAnimationFrame(this._scrollRaf);
      this._scrollRaf = null;
      if (this._scrollStopTimer) clearTimeout(this._scrollStopTimer);
      this._scrollStopTimer = null;
      if (this._resizeObserver) this._resizeObserver.disconnect();
      this._resizeObserver = null;
      this.setMotionClass('is-moving', false);
      this.setMotionClass('is-dragging', false);
    },
    select(podcastId) {
      if (podcastId === this.selectedPodcastId) return;
      this.$emit('select', podcastId);
    },
    measure() {
      const viewport = this.$refs.viewport;
      if (!viewport) return getRailMetrics();
      return getRailMetrics({
        scrollLeft: viewport.scrollLeft,
        clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
      });
    },
    setMotionClass(name, active) {
      const root = this.$refs.root;
      if (root && root.classList) root.classList.toggle(name, !!active);
      if (name === 'is-moving') this._isRailMoving = !!active;
      if (name === 'is-dragging') this._isRailDragging = !!active;
    },
    getThumbGeometry(metrics) {
      const track = this.$refs.track;
      if (!track) return { width: 0, travel: 0 };
      return getRailThumbGeometry({
        trackWidth: track.clientWidth,
        visibleRatio: metrics.visibleRatio,
        canScroll: metrics.canScroll,
        compact: track.clientWidth < 520,
      });
    },
    syncThumb(metrics, scrollLeft = metrics.scrollLeft) {
      const thumb = this.$refs.thumb;
      if (!thumb) return;
      const geometry = this._thumbGeometry || this.getThumbGeometry(metrics);
      if (!geometry.width) {
        thumb.style.width = '0px';
        thumb.style.transform = 'translate3d(0, 0, 0)';
        return;
      }
      const ratio = metrics.maxScroll ? scrollLeft / metrics.maxScroll : 0;
      thumb.style.width = geometry.width + 'px';
      thumb.style.transform =
        'translate3d(' + geometry.travel * ratio + 'px, 0, 0)';
    },
    updateMetrics() {
      if (!this._railActive || this._destroyed) return;
      const metrics = this.measure();
      this.applyMetrics(metrics, { measureThumb: true });
    },
    applyMetrics(metrics, { measureThumb = false } = {}) {
      if (!metrics) return;
      this._metrics = metrics;
      if (measureThumb || !this._thumbGeometry) {
        this._thumbGeometry = this.getThumbGeometry(metrics);
      }
      this.syncThumb(metrics);
      this.syncRailState(metrics);
    },
    syncRailState(metrics) {
      if (
        this.state.canScroll !== metrics.canScroll ||
        this.state.canPrev !== metrics.canPrev ||
        this.state.canNext !== metrics.canNext
      ) {
        this.state = {
          canScroll: metrics.canScroll,
          canPrev: metrics.canPrev,
          canNext: metrics.canNext,
        };
      }
    },
    onScroll() {
      if (!this._railActive) return;
      this.setMotionClass('is-moving', true);
      if (this._controllerOwnsScroll) {
        this.scheduleMotionStop();
        return;
      }
      if (!this._scrollRaf) {
        this._scrollRaf = requestAnimationFrame(() => {
          this._scrollRaf = null;
          this.updateMetrics();
        });
      }
      this.scheduleMotionStop();
    },
    scheduleMotionStop() {
      if (this._scrollStopTimer) clearTimeout(this._scrollStopTimer);
      this._scrollStopTimer = setTimeout(() => {
        this.setMotionClass('is-moving', false);
      }, 120);
    },
    writeRailPosition(scrollLeft) {
      const viewport = this.$refs.viewport;
      if (!viewport || !this._metrics) return;
      const metrics = getRailPositionMetrics(this._metrics, scrollLeft);
      this._metrics = metrics;
      if (
        Math.abs(viewport.scrollLeft - metrics.scrollLeft) >= RAIL_EDGE_EPSILON
      ) {
        viewport.scrollLeft = metrics.scrollLeft;
      }
      this.syncThumb(metrics, metrics.scrollLeft);
      this.syncRailState(metrics);
    },
    interruptRailMotion() {
      this._railGoal = null;
      this._railGoalDirection = null;
      this._controllerOwnsScroll = false;
      this.stopAnimation();
    },
    handleRailWheel(event) {
      const viewport = this.$refs.viewport;
      if (!viewport) return;
      const horizontal = Math.abs(event.deltaX) > 0.5 ? event.deltaX : 0;
      const shiftWheel = event.shiftKey ? event.deltaY : 0;
      const delta = horizontal || shiftWheel;
      const metrics = this.measure();
      this.applyMetrics(metrics, { measureThumb: true });
      if (!delta || !metrics.canScroll) return;
      const next = Math.max(
        0,
        Math.min(metrics.maxScroll, viewport.scrollLeft + delta)
      );
      if (next === viewport.scrollLeft) return;
      event.preventDefault();
      this.interruptRailMotion();
      this.writeRailPosition(next);
    },
    scrollRail(direction) {
      const viewport = this.$refs.viewport;
      if (!viewport) return;
      const metrics = this.measure();
      this.applyMetrics(metrics, { measureThumb: true });
      if (!metrics.canScroll) return;
      const normalizedDirection = direction < 0 ? -1 : 1;
      this._railGoal = getRailArrowGoal({
        scrollLeft: metrics.scrollLeft,
        goal: this._railGoal,
        goalDirection: this._railGoalDirection,
        clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
        direction: normalizedDirection,
      });
      this._railGoalDirection = normalizedDirection;
      this._controllerOwnsScroll = true;
      this.setMotionClass('is-moving', true);
      this.startAnimation();
    },
    startAnimation() {
      if (this._animationRaf) return;
      this._lastAnimationAt = 0;
      const tick = now => {
        const viewport = this.$refs.viewport;
        if (
          !this._railActive ||
          !viewport ||
          !Number.isFinite(this._railGoal)
        ) {
          this._animationRaf = null;
          return;
        }
        const deltaMs = this._lastAnimationAt
          ? now - this._lastAnimationAt
          : 16;
        this._lastAnimationAt = now;
        const next = getRailMotionStep({
          scrollLeft: viewport.scrollLeft,
          goal: this._railGoal,
          maxScroll: this._metrics ? this._metrics.maxScroll : 0,
          deltaMs,
        });
        this.writeRailPosition(next);
        if (next === this._railGoal) {
          this.writeRailPosition(this._railGoal);
          this._railGoal = null;
          this._railGoalDirection = null;
          this._animationRaf = null;
          this._controllerOwnsScroll = false;
          this.updateMetrics();
          this.setMotionClass('is-moving', false);
          return;
        }
        this._animationRaf = requestAnimationFrame(tick);
      };
      this._animationRaf = requestAnimationFrame(tick);
    },
    stopAnimation() {
      if (this._animationRaf) cancelAnimationFrame(this._animationRaf);
      this._animationRaf = null;
      this._lastAnimationAt = 0;
    },
    ensureSelectedVisible(podcastId) {
      const viewport = this.$refs.viewport;
      const items = this.$refs.items || [];
      const item = items.find(node => node.dataset.podcastId === podcastId);
      if (!viewport || !item) return;
      const left = item.offsetLeft;
      const right = left + item.offsetWidth;
      this.interruptRailMotion();
      const metrics = this.measure();
      this.applyMetrics(metrics, { measureThumb: true });
      if (left < metrics.scrollLeft) this.writeRailPosition(left);
      else if (right > metrics.scrollLeft + viewport.clientWidth) {
        this.writeRailPosition(right - viewport.clientWidth);
      }
    },
    focusRailEdge(last) {
      const items = this.$refs.items || [];
      const target = last
        ? items[items.length - 1]
        : this.$el.querySelector('.rail-all');
      if (target && typeof target.focus === 'function') target.focus();
    },
    moveRailFocus(direction) {
      const all = this.$el.querySelector('.rail-all');
      const items = [all, ...(this.$refs.items || [])].filter(Boolean);
      if (!items.length) return;
      const current = document.activeElement;
      const currentIndex = items.indexOf(current);
      const base = currentIndex < 0 ? 0 : currentIndex;
      const nextIndex = Math.max(
        0,
        Math.min(items.length - 1, base + (direction < 0 ? -1 : 1))
      );
      const target = items[nextIndex];
      if (target && typeof target.focus === 'function') target.focus();
    },
    startDrag(event) {
      const viewport = this.$refs.viewport;
      const track = this.$refs.track;
      const thumb = this.$refs.thumb;
      const metrics = this.measure();
      if (
        !event.isPrimary ||
        !viewport ||
        !track ||
        !thumb ||
        !metrics.canScroll
      ) {
        return;
      }
      this.applyMetrics(metrics, { measureThumb: true });
      this.interruptRailMotion();
      this._controllerOwnsScroll = true;
      this.setMotionClass('is-dragging', true);
      this.setMotionClass('is-moving', true);
      this._drag = {
        pointerId: event.pointerId,
        startPointerX: event.clientX,
        startScrollLeft: metrics.scrollLeft,
        trackWidth: track.clientWidth,
        thumbWidth: thumb.offsetWidth,
        maxScroll: metrics.maxScroll,
        nextScrollLeft: metrics.scrollLeft,
      };
      this._dragTarget = event.currentTarget;
      if (this._dragTarget.setPointerCapture) {
        this._dragTarget.setPointerCapture(event.pointerId);
      }
      document.addEventListener('pointermove', this.onDragMove);
      document.addEventListener('pointerup', this.finishDrag);
      document.addEventListener('pointercancel', this.finishDrag);
    },
    onDragMove(event) {
      if (!this._drag || event.pointerId !== this._drag.pointerId) return;
      this._drag.nextScrollLeft = getRailThumbDragTarget({
        startScrollLeft: this._drag.startScrollLeft,
        startPointerX: this._drag.startPointerX,
        pointerX: event.clientX,
        trackWidth: this._drag.trackWidth,
        thumbWidth: this._drag.thumbWidth,
        maxScroll: this._drag.maxScroll,
      });
      if (this._dragRaf) return;
      this._dragRaf = requestAnimationFrame(() => {
        this._dragRaf = null;
        const viewport = this.$refs.viewport;
        if (!viewport || !this._drag) return;
        this.writeRailPosition(this._drag.nextScrollLeft);
      });
    },
    finishDrag(event) {
      if (event && this._drag && event.pointerId !== this._drag.pointerId)
        return;
      if (this._dragRaf) cancelAnimationFrame(this._dragRaf);
      this._dragRaf = null;
      if (
        this._dragTarget &&
        this._drag &&
        this._dragTarget.releasePointerCapture
      ) {
        try {
          this._dragTarget.releasePointerCapture(this._drag.pointerId);
        } catch (e) {
          // Pointer capture may already have been released by the browser.
        }
      }
      this._drag = null;
      this._dragTarget = null;
      this._controllerOwnsScroll = false;
      this.setMotionClass('is-dragging', false);
      this.setMotionClass('is-moving', false);
      this.updateMetrics();
      document.removeEventListener('pointermove', this.onDragMove);
      document.removeEventListener('pointerup', this.finishDrag);
      document.removeEventListener('pointercancel', this.finishDrag);
    },
    previewHalo(podcast) {
      if (!podcast || !podcast.id) return;
      this.previewPodcastId = podcast.id;
      this.warmHalo(podcast);
    },
    clearPreviewHalo(podcast) {
      if (podcast && this.previewPodcastId === podcast.id) {
        this.previewPodcastId = '';
      }
    },
    warmHalo(podcast) {
      if (
        !podcast ||
        !podcast.id ||
        !podcast.coverUrl ||
        this.haloMap[podcast.id] ||
        !this._railActive ||
        this._isRailMoving ||
        this._isRailDragging
      ) {
        return;
      }
      const cached = peekTinyCover(podcast.coverUrl);
      if (cached) {
        this.$set(this.haloMap, podcast.id, cached);
        return;
      }
      const token = (this._haloToken || 0) + 1;
      this._haloToken = token;
      ensureTinyCover(podcast.coverUrl).then(url => {
        if (!this._destroyed && token === this._haloToken && url) {
          this.$set(this.haloMap, podcast.id, url);
        }
      });
    },
    haloStyle(podcast) {
      if (!podcast || !podcast.id) return {};
      const isVisible =
        this.previewPodcastId === podcast.id ||
        this.selectedPodcastId === podcast.id;
      const url = isVisible ? this.haloMap[podcast.id] || podcast.coverUrl : '';
      return url ? { backgroundImage: 'url("' + url + '")' } : {};
    },
  },
};
</script>

<style lang="scss" scoped>
.subscription-program-rail {
  width: 100%;
  margin-bottom: 17px;
}

.program-rail {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 36px;
  gap: 10px;
  align-items: center;
}

.rail-arrow {
  display: inline-flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--color-text-secondary);
  background: var(--color-secondary-bg);

  &:hover:not(:disabled) {
    color: var(--color-primary);
    background: var(--color-primary-bg-for-transparent);
  }

  &:disabled {
    cursor: default;
    opacity: 0.35;
  }

  .svg-icon {
    width: 18px;
    height: 18px;
  }
}

.rail-viewport {
  --rail-gap: 10px;
  display: flex;
  min-width: 0;
  gap: var(--rail-gap);
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  padding: 10px 0 16px;
  scrollbar-width: none;
  scroll-behavior: auto;

  &::-webkit-scrollbar {
    display: none;
  }

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 4px;
    border-radius: 8px;
  }
}

.rail-item {
  --rail-cover-lift: 0px;
  --rail-cover-scale: 1;
  --rail-cover-transition: 90ms;
  --rail-halo-opacity: 0;
  --rail-halo-scale: 0.9;
  --rail-halo-transition: 80ms;
  position: relative;
  display: inline-flex;
  flex: 0 0 96px;
  width: 96px;
  height: 96px;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: 0;
  border-radius: var(--radius-cover);
  color: var(--color-text-secondary);
  background: transparent;

  &:hover,
  &.active {
    z-index: 1;
  }

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
}

.rail-cover,
.rail-all-icon {
  position: relative;
  display: inline-flex;
  width: 88px;
  height: 88px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-cover);
  transform: translateY(var(--rail-cover-lift)) scale(var(--rail-cover-scale));
  transition: transform var(--rail-cover-transition) ease-out;
}

.rail-all-icon {
  color: var(--color-text-secondary);
  background: var(--color-secondary-bg);

  .svg-icon {
    width: 25px;
    height: 25px;
  }
}

.rail-item:hover,
.rail-item.active {
  --rail-cover-lift: -3px;
  --rail-halo-opacity: 1;
}

.rail-item.active {
  // The selected state keeps the hover lift, then adds its small scale.
  --rail-cover-scale: 1.045;
  --rail-cover-transition: 160ms;
  --rail-halo-scale: 0.98;
  --rail-halo-transition: 160ms;
}

.rail-item:hover:not(.active) {
  --rail-halo-scale: 0.96;
}

.rail-item.active .rail-all-icon {
  color: var(--color-primary);
  background: var(--color-primary-bg-for-transparent);
}

.rail-cover-image {
  position: relative;
  z-index: 1;
  width: 88px;
  height: 88px;
  overflow: hidden;
  border-radius: var(--radius-cover);
}

.rail-cover-halo {
  position: absolute;
  top: 8px;
  right: 0;
  left: 0;
  height: 100%;
  z-index: 0;
  border-radius: var(--radius-cover);
  background-position: center;
  background-size: cover;
  filter: blur(12px) opacity(0.6);
  opacity: var(--rail-halo-opacity);
  transform: scale(var(--rail-halo-scale));
  transition: opacity var(--rail-halo-transition) ease-out,
    transform var(--rail-halo-transition) ease-out;
}

.program-rail.is-moving .rail-cover-halo,
.program-rail.is-dragging .rail-cover-halo {
  opacity: 0 !important;
  transition: none;
}

.rail-track {
  position: relative;
  height: 16px;
  margin: 6px 46px 0;
  contain: layout style;

  &::before {
    position: absolute;
    top: 6px;
    right: 0;
    left: 0;
    height: 4px;
    border-radius: 999px;
    background: var(--color-secondary-bg);
    content: '';
  }

  &.is-hidden {
    visibility: hidden;
  }
}

.rail-thumb {
  position: absolute;
  top: 6px;
  left: 0;
  height: 4px;
  border-radius: 999px;
  background: var(--color-primary);
  cursor: default;
  touch-action: none;
  will-change: transform;

  &::after {
    position: absolute;
    top: -7px;
    right: 0;
    bottom: -7px;
    left: 0;
    content: '';
  }
}

@media (max-width: 760px) {
  .rail-item {
    flex-basis: 76px;
    width: 76px;
    height: 76px;
  }

  .rail-cover,
  .rail-all-icon,
  .rail-cover-image {
    width: 68px;
    height: 68px;
  }

  .rail-arrow {
    width: 32px;
    height: 32px;
  }

  .program-rail {
    grid-template-columns: 32px minmax(0, 1fr) 32px;
    gap: 6px;
  }

  .rail-track {
    margin-right: 38px;
    margin-left: 38px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rail-cover,
  .rail-all-icon,
  .rail-cover-halo {
    transition: none;
  }
}
</style>
