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
        @keydown.left.prevent.stop="moveRailFocus(-1)"
        @keydown.right.prevent.stop="moveRailFocus(1)"
        @keydown.home="handleRailEdgeKey($event, false)"
        @keydown.end="handleRailEdgeKey($event, true)"
        @focusin="handleRailFocusIn"
        @focusout="handleRailFocusOut"
        @wheel="handleRailWheel"
        @pointerdown="handleRailPointerDown"
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
          @click="select('', $event)"
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
          @pointerenter="beginHaloHover(podcast, $event.currentTarget)"
          @pointerleave="endHaloHover(podcast, $event.currentTarget)"
          @click="select(podcast.id, $event)"
        >
          <span class="rail-cover">
            <span class="rail-cover-halo"></span>
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
  getRailMotionDecision,
  getRailMotionStep,
  getRailPositionMetrics,
  RAIL_EDGE_EPSILON,
  getRailSelectionContextTarget,
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
    };
  },
  watch: {
    podcasts() {
      this.$nextTick(() => this.updateMetrics(true));
    },
    selectedPodcastId(value) {
      const requestToken = this._selectionRequestToken || 0;
      this.$nextTick(() => {
        if (
          this._destroyed ||
          requestToken !== (this._selectionRequestToken || 0)
        ) {
          return;
        }
        const pendingSelection = this._pendingUserSelection;
        const selectionAlreadyPositioned =
          pendingSelection &&
          pendingSelection.token === requestToken &&
          pendingSelection.id === value;
        if (selectionAlreadyPositioned) {
          this._pendingUserSelection = null;
        } else {
          if (pendingSelection && pendingSelection.token === requestToken) {
            this._pendingUserSelection = null;
          }
          if (value) this.ensureSelectedVisible(value);
        }
        const podcast = this.podcasts.find(item => item.id === value);
        this.syncSelectedHalo(podcast);
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
      this.clearRailKeyboardFocus();
      this.bindRailTabTracking();
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
        this.syncSelectedHalo(selected);
      });
    },
    deactivateRail() {
      this._railActive = false;
      this.unbindRailTabTracking();
      if (
        this._hoverHaloTarget &&
        this._hoverHaloTarget !== this._selectedHaloTarget
      ) {
        this.clearHalo(this._hoverHaloTarget);
      }
      this._railGoal = null;
      this._railGoalDirection = null;
      this._controllerOwnsScroll = false;
      this._expectedProgrammaticScroll = null;
      this._hoverHaloTarget = null;
      this._hoverHaloPodcast = null;
      this._selectedHaloTarget = null;
      this.releaseRailFocus({ blur: true });
      this.stopAnimation();
      this.finishDrag();
      this.cancelNativeRailFrame();
      this.finishNativeRailMotion();
      if (this._resizeObserver) this._resizeObserver.disconnect();
      this._resizeObserver = null;
      this.setMotionClass('is-moving', false);
      this.setMotionClass('is-dragging', false);
    },
    select(podcastId) {
      if (podcastId === this.selectedPodcastId) {
        if (podcastId) this.ensureSelectedVisible(podcastId);
        return;
      }
      const token = (this._selectionRequestToken || 0) + 1;
      this._selectionRequestToken = token;
      this._pendingUserSelection = podcastId ? { id: podcastId, token } : null;
      if (podcastId) this.ensureSelectedVisible(podcastId);
      this.$emit('select', podcastId);
    },
    handleRailPointerDown() {
      this._railTabIntent = false;
      this.clearRailKeyboardFocus();
      this.interruptRailMotion();
    },
    bindRailTabTracking() {
      if (
        this._railDocumentKeydownListener ||
        typeof document === 'undefined' ||
        !document.addEventListener
      ) {
        return;
      }
      this._railDocumentKeydownListener = event => {
        this._railTabIntent = !!(
          event &&
          event.key === 'Tab' &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        );
      };
      this._railDocumentKeyupListener = event => {
        if (event && event.key === 'Tab') this._railTabIntent = false;
      };
      document.addEventListener(
        'keydown',
        this._railDocumentKeydownListener,
        true
      );
      document.addEventListener('keyup', this._railDocumentKeyupListener, true);
    },
    unbindRailTabTracking() {
      if (typeof document !== 'undefined' && document.removeEventListener) {
        if (this._railDocumentKeydownListener) {
          document.removeEventListener(
            'keydown',
            this._railDocumentKeydownListener,
            true
          );
        }
        if (this._railDocumentKeyupListener) {
          document.removeEventListener(
            'keyup',
            this._railDocumentKeyupListener,
            true
          );
        }
      }
      this._railDocumentKeydownListener = null;
      this._railDocumentKeyupListener = null;
      this._railTabIntent = false;
    },
    handleRailFocusIn(event) {
      if (!event || !event.target) return;
      if (this._railTabIntent) {
        this._railTabIntent = false;
        this.markRailKeyboardFocus(event.target);
      }
    },
    handleRailFocusOut(event) {
      if (!event || event.target === this._railKeyboardFocusTarget) {
        this.clearRailKeyboardFocus();
      }
    },
    markRailKeyboardFocus(target) {
      const viewport = this.$refs.viewport;
      if (!target || !viewport || !viewport.contains(target)) return false;
      this.clearRailKeyboardFocus();
      target.setAttribute('data-rail-keyboard-focus', 'true');
      this._railKeyboardFocusTarget = target;
      return true;
    },
    clearRailKeyboardFocus({ blur = false } = {}) {
      const viewport = this.$refs.viewport;
      const activeElement =
        typeof document !== 'undefined' ? document.activeElement : null;
      const markedTarget = this._railKeyboardFocusTarget;
      if (markedTarget && markedTarget.removeAttribute) {
        markedTarget.removeAttribute('data-rail-keyboard-focus');
      }
      this._railKeyboardFocusTarget = null;
      if (
        blur &&
        viewport &&
        activeElement &&
        viewport.contains(activeElement) &&
        typeof activeElement.blur === 'function'
      ) {
        activeElement.blur();
      }
    },
    releaseRailFocus(options) {
      this._railTabIntent = false;
      this.clearRailKeyboardFocus(options);
    },
    focusRailItem(target) {
      if (!target || typeof target.focus !== 'function') return;
      if (
        typeof document !== 'undefined' &&
        document.activeElement === target
      ) {
        return;
      }
      try {
        target.focus({ preventScroll: true });
      } catch (error) {
        target.focus();
      }
    },
    measure() {
      const viewport = this.$refs.viewport;
      if (!viewport) return getRailMetrics();
      const scrollLeft = viewport.scrollLeft;
      const clientWidth = viewport.clientWidth;
      const scrollWidth = viewport.scrollWidth;
      this._railViewportWidth = clientWidth;
      this._railScrollWidth = scrollWidth;
      return getRailMetrics({
        scrollLeft,
        clientWidth,
        scrollWidth,
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
      const geometry = this._thumbGeometry || { width: 0, travel: 0 };
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
      this.applyMeasuredMetrics(metrics);
    },
    applyMeasuredMetrics(metrics) {
      if (!metrics) return;
      this._metrics = metrics;
      this._railPosition = metrics.scrollLeft;
      this._thumbGeometry = this.getThumbGeometry(metrics);
      this.syncThumb(metrics);
      this.syncRailState(metrics);
    },
    captureRailLayout() {
      this.updateMetrics();
      return this._metrics;
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
    // Layout is refreshed at input and resize boundaries; frames consume only
    // this controller position so the viewport and thumb cannot drift apart.
    commitRailFrame(scrollLeft, { write = true } = {}) {
      const viewport = this.$refs.viewport;
      if (!viewport || !this._metrics) return;
      const metrics = getRailPositionMetrics(this._metrics, scrollLeft);
      this._metrics = metrics;
      this._railPosition = metrics.scrollLeft;
      if (
        write &&
        Math.abs(viewport.scrollLeft - metrics.scrollLeft) >= RAIL_EDGE_EPSILON
      ) {
        this._expectedProgrammaticScroll = metrics.scrollLeft;
        viewport.scrollLeft = metrics.scrollLeft;
      }
      this.syncThumb(metrics, metrics.scrollLeft);
      this.syncRailState(metrics);
    },
    onScroll() {
      if (!this._railActive) return;
      const viewport = this.$refs.viewport;
      if (!viewport) return;
      const actualPosition = viewport.scrollLeft;
      if (this._controllerOwnsScroll) return;
      if (
        Number.isFinite(this._expectedProgrammaticScroll) &&
        Math.abs(actualPosition - this._expectedProgrammaticScroll) <
          RAIL_EDGE_EPSILON
      ) {
        this._expectedProgrammaticScroll = null;
        return;
      }
      this._expectedProgrammaticScroll = null;
      if (!this._metrics) {
        this.captureRailLayout();
      }
      this.beginNativeRailMotion();
      this.queueNativeRailPosition(actualPosition, { write: false });
    },
    beginNativeRailMotion() {
      this._nativeInputActive = true;
      this.setMotionClass('is-moving', true);
      this.clearNativeMotionStop();
    },
    clearNativeMotionStop() {
      if (this._nativeScrollStopTimer) {
        clearTimeout(this._nativeScrollStopTimer);
      }
      this._nativeScrollStopTimer = null;
    },
    scheduleNativeMotionStop() {
      this.clearNativeMotionStop();
      this._nativeScrollStopTimer = setTimeout(() => {
        this.finishNativeRailMotion();
      }, 120);
    },
    finishNativeRailMotion() {
      this.clearNativeMotionStop();
      this._nativeInputActive = false;
      if (!this._controllerOwnsScroll && !this._isRailDragging) {
        this.setMotionClass('is-moving', false);
        this.refreshRetainedHalos();
      }
    },
    queueNativeRailPosition(position, { write = false } = {}) {
      this._pendingNativeRailPosition = position;
      this._pendingNativeRailWrite = !!write;
      if (!this._nativeScrollRaf) {
        this._nativeScrollRaf = requestAnimationFrame(() => {
          this._nativeScrollRaf = null;
          if (!this._railActive || this._destroyed) return;
          const nextPosition = this._pendingNativeRailPosition;
          const shouldWrite = this._pendingNativeRailWrite;
          this._pendingNativeRailPosition = null;
          this._pendingNativeRailWrite = false;
          if (!Number.isFinite(nextPosition)) return;
          this.commitRailFrame(nextPosition, { write: shouldWrite });
        });
      }
      this.scheduleNativeMotionStop();
    },
    cancelNativeRailFrame() {
      if (this._nativeScrollRaf) cancelAnimationFrame(this._nativeScrollRaf);
      this._nativeScrollRaf = null;
      this._pendingNativeRailPosition = null;
      this._pendingNativeRailWrite = false;
    },
    interruptRailMotion() {
      if (this._drag) this.finishDrag();
      this._railGoal = null;
      this._railGoalDirection = null;
      this._controllerOwnsScroll = false;
      this._expectedProgrammaticScroll = null;
      this.stopAnimation();
      this.cancelNativeRailFrame();
      this.finishNativeRailMotion();
    },
    handleRailWheel(event) {
      const viewport = this.$refs.viewport;
      if (!viewport) return;
      const horizontal = Math.abs(event.deltaX) > 0.5 ? event.deltaX : 0;
      const shiftWheel = event.shiftKey ? event.deltaY : 0;
      const delta = horizontal || shiftWheel;
      if (!delta) return;
      const metrics =
        this._nativeInputActive && this._metrics
          ? this._metrics
          : this.captureRailLayout();
      if (!delta || !metrics.canScroll) return;
      const currentPosition = Number.isFinite(this._pendingNativeRailPosition)
        ? this._pendingNativeRailPosition
        : this._railPosition;
      const next = Math.max(
        0,
        Math.min(metrics.maxScroll, currentPosition + delta)
      );
      if (next === currentPosition) return;
      event.preventDefault();
      this.interruptRailMotion();
      this.beginNativeRailMotion();
      this.queueNativeRailPosition(next, { write: true });
    },
    scrollRail(direction) {
      const viewport = this.$refs.viewport;
      if (!viewport) return;
      const metrics =
        this._controllerOwnsScroll && this._metrics
          ? this._metrics
          : this.captureRailLayout();
      if (!metrics.canScroll) return;
      const normalizedDirection = direction < 0 ? -1 : 1;
      const goal = getRailArrowGoal({
        scrollLeft: this._railPosition,
        goal: this._railGoal,
        goalDirection: this._railGoalDirection,
        clientWidth: this._railViewportWidth,
        scrollWidth: this._railScrollWidth,
        direction: normalizedDirection,
      });
      this.retargetRailMotion(goal, { direction: normalizedDirection });
    },
    prefersReducedMotion() {
      return !!(
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    },
    finishRailMotion() {
      this._railGoal = null;
      this._railGoalDirection = null;
      this._controllerOwnsScroll = false;
      this.setMotionClass('is-moving', false);
      this.refreshRetainedHalos();
    },
    retargetRailMotion(goal, { direction = null } = {}) {
      const viewport = this.$refs.viewport;
      if (!viewport || !this._metrics) return;
      if (this._drag) this.finishDrag();
      const decision = getRailMotionDecision({
        scrollLeft: this._railPosition,
        goal,
        maxScroll: this._metrics.maxScroll,
        reducedMotion: this.prefersReducedMotion(),
      });
      this.cancelNativeRailFrame();
      this.finishNativeRailMotion();
      this._railGoalDirection = direction;
      if (decision.immediate) {
        this.stopAnimation();
        this.commitRailFrame(decision.target);
        this.finishRailMotion();
        return;
      }
      this._railGoal = decision.target;
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
          scrollLeft: this._railPosition,
          goal: this._railGoal,
          maxScroll: this._metrics ? this._metrics.maxScroll : 0,
          deltaMs,
        });
        this.commitRailFrame(next);
        if (next === this._railGoal) {
          this._animationRaf = null;
          this.finishRailMotion();
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
      const metrics = this.captureRailLayout();
      const allItem = this.$el.querySelector('.rail-all');
      const railItems = [allItem, ...items].filter(Boolean);
      const index = railItems.indexOf(item);
      const previous = railItems[index - 1];
      const next = railItems[index + 1];
      const viewportRect = viewport.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const itemLeft = itemRect.left - viewportRect.left + metrics.scrollLeft;
      let gap = 0;
      if (previous) {
        const previousRect = previous.getBoundingClientRect();
        const previousLeft =
          previousRect.left - viewportRect.left + metrics.scrollLeft;
        gap = itemLeft - (previousLeft + previous.offsetWidth);
      } else if (next) {
        const nextRect = next.getBoundingClientRect();
        const nextLeft = nextRect.left - viewportRect.left + metrics.scrollLeft;
        gap = nextLeft - (itemLeft + item.offsetWidth);
      }
      const goal = getRailSelectionContextTarget({
        scrollLeft: metrics.scrollLeft,
        clientWidth: this._railViewportWidth,
        scrollWidth: this._railScrollWidth,
        itemLeft,
        itemWidth: item.offsetWidth,
        gap: Math.max(0, gap),
        hasPrev: index > 0,
        hasNext: index >= 0 && index < railItems.length - 1,
      });
      this.retargetRailMotion(goal);
    },
    handleRailEdgeKey(event, last) {
      const activeElement =
        typeof document !== 'undefined' ? document.activeElement : null;
      if (
        !event ||
        !activeElement ||
        activeElement !== this._railKeyboardFocusTarget ||
        activeElement.getAttribute('data-rail-keyboard-focus') !== 'true'
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.focusRailEdge(last);
    },
    focusRailEdge(last) {
      const items = this.$refs.items || [];
      const target = last
        ? items[items.length - 1]
        : this.$el.querySelector('.rail-all');
      this.focusRailItem(target);
      this.markRailKeyboardFocus(target);
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
      this.focusRailItem(target);
      this.markRailKeyboardFocus(target);
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
      this.applyMeasuredMetrics(metrics);
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
        this.commitRailFrame(this._drag.nextScrollLeft);
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
      this.refreshRetainedHalos();
      document.removeEventListener('pointermove', this.onDragMove);
      document.removeEventListener('pointerup', this.finishDrag);
      document.removeEventListener('pointercancel', this.finishDrag);
    },
    getRailItem(podcastId) {
      if (!podcastId) return null;
      return (this.$refs.items || []).find(
        node => node.dataset.podcastId === podcastId
      );
    },
    getRailHalo(target) {
      if (!target || !target.querySelector) return null;
      return target.querySelector('.rail-cover-halo');
    },
    clearHalo(target) {
      const halo = this.getRailHalo(target);
      if (!halo || !halo.style) return;
      halo.style.backgroundImage = '';
      halo._railHaloToken = (halo._railHaloToken || 0) + 1;
    },
    beginHaloHover(podcast, target) {
      if (!podcast || !podcast.id || !target) return;
      this._hoverHaloPodcast = podcast;
      this._hoverHaloTarget = target;
      this.warmHalo(podcast, target);
    },
    endHaloHover(podcast, target) {
      if (target && this._hoverHaloTarget === target) {
        this._hoverHaloTarget = null;
        this._hoverHaloPodcast = null;
      }
      if (podcast && podcast.id === this.selectedPodcastId) return;
      this.clearHalo(target);
    },
    syncSelectedHalo(podcast) {
      const nextTarget = podcast ? this.getRailItem(podcast.id) : null;
      const previousTarget = this._selectedHaloTarget;
      this._selectedHaloTarget = nextTarget || null;
      if (previousTarget && previousTarget !== nextTarget) {
        const keepForHover = previousTarget === this._hoverHaloTarget;
        if (!keepForHover) this.clearHalo(previousTarget);
      }
      if (podcast && nextTarget) this.warmHalo(podcast, nextTarget);
    },
    refreshRetainedHalos() {
      const selected = this.podcasts.find(
        item => item.id === this.selectedPodcastId
      );
      if (selected && this._selectedHaloTarget) {
        this.warmHalo(selected, this._selectedHaloTarget);
      }
      if (this._hoverHaloPodcast && this._hoverHaloTarget) {
        this.warmHalo(this._hoverHaloPodcast, this._hoverHaloTarget);
      }
    },
    shouldKeepHalo(podcast, target) {
      return !!(
        podcast &&
        target &&
        (podcast.id === this.selectedPodcastId ||
          target === this._hoverHaloTarget)
      );
    },
    warmHalo(podcast, target) {
      if (
        !podcast ||
        !podcast.id ||
        !podcast.coverUrl ||
        !this._railActive ||
        this._isRailMoving ||
        this._isRailDragging ||
        !target
      ) {
        return;
      }
      const halo = this.getRailHalo(target);
      if (!halo || !halo.style) return;
      const cached = peekTinyCover(podcast.coverUrl);
      if (cached) {
        halo.style.backgroundImage = 'url("' + cached + '")';
        return;
      }
      const token = (halo._railHaloToken || 0) + 1;
      halo._railHaloToken = token;
      ensureTinyCover(podcast.coverUrl).then(url => {
        if (
          !this._destroyed &&
          halo._railHaloToken === token &&
          url &&
          this.shouldKeepHalo(podcast, target)
        ) {
          halo.style.backgroundImage = 'url("' + url + '")';
        }
      });
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
  // The bottom padding is deliberate drawing room for the cover's compact
  // projection. The scroll container itself remains clipped and horizontal.
  padding: 10px 0 30px;
  scrollbar-width: none;
  scroll-behavior: auto;

  &::-webkit-scrollbar {
    display: none;
  }

  &:focus {
    outline: none;
  }
}

.rail-item {
  --rail-cover-lift: 0px;
  --rail-cover-scale: 1;
  --rail-cover-transition: 120ms;
  --rail-cover-easing: cubic-bezier(0.2, 0.8, 0.2, 1);
  --rail-halo-opacity: 0;
  --rail-halo-scale-x: 0.82;
  --rail-halo-scale-y: 0.5;
  --rail-halo-transition: 120ms;
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
  &:active,
  &.active {
    z-index: 1;
  }

  &:focus {
    outline: none;
  }
}

.rail-item[data-rail-keyboard-focus='true']:focus,
.rail-viewport[data-rail-keyboard-focus='true']:focus {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.rail-viewport[data-rail-keyboard-focus='true']:focus {
  outline-offset: 4px;
  border-radius: 8px;
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
  transition: transform var(--rail-cover-transition) var(--rail-cover-easing);
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
.rail-item:active,
.rail-item.active {
  --rail-cover-lift: -6px;
  --rail-halo-opacity: 1;
}

.rail-item:active,
.rail-item.active {
  // Pointer active bridges the click until selectedPodcastId returns from parent.
  --rail-cover-scale: 1.055;
  --rail-cover-transition: 140ms;
  --rail-halo-scale-x: 0.9;
  --rail-halo-scale-y: 0.62;
  --rail-halo-transition: 140ms;
}

.rail-item:hover:not(.active) {
  --rail-cover-transition: 110ms;
  --rail-halo-transition: 110ms;
  --rail-halo-scale-x: 0.86;
  --rail-halo-scale-y: 0.56;
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
  top: 64px;
  right: 9px;
  left: 9px;
  height: 28px;
  z-index: 0;
  border-radius: 50%;
  background-position: center 78%;
  background-size: 118px auto;
  filter: blur(12px) saturate(1.1);
  opacity: var(--rail-halo-opacity);
  pointer-events: none;
  transform: scaleX(var(--rail-halo-scale-x)) scaleY(var(--rail-halo-scale-y));
  transform-origin: center;
  transition: opacity var(--rail-halo-transition) var(--rail-cover-easing),
    transform var(--rail-halo-transition) var(--rail-cover-easing);
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
  .rail-item,
  .rail-item:hover,
  .rail-item:active,
  .rail-item.active {
    --rail-cover-lift: 0px;
    --rail-cover-scale: 1;
    --rail-halo-opacity: 0;
  }

  .rail-cover,
  .rail-all-icon,
  .rail-cover-halo {
    transition: none !important;
  }

  .rail-cover,
  .rail-all-icon {
    transform: none;
  }
}
</style>
