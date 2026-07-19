<template>
  <transition name="main-scroll-back-top">
    <button
      v-show="visible"
      ref="button"
      v-tip="'回到顶部'"
      type="button"
      class="main-scroll-back-top"
      aria-label="回到顶部"
      @click="scrollToTopSmooth"
    >
      <svg-icon icon-class="arrow-up" />
    </button>
  </transition>
</template>

<script>
import SvgIcon from '@/components/SvgIcon.vue';

const DEFAULT_THRESHOLD = 520;

export default {
  name: 'MainScrollBackToTop',
  components: { SvgIcon },
  props: {
    threshold: {
      type: Number,
      default: DEFAULT_THRESHOLD,
    },
  },
  data() {
    return {
      visible: false,
    };
  },
  mounted() {
    this._destroyed = false;
    this._isActive = true;
    this.bindMainScroll();
  },
  activated() {
    this._isActive = true;
    this.bindMainScroll();
  },
  deactivated() {
    this._isActive = false;
    this.unbindMainScroll();
    this.stopScrollAnimation();
    this.cancelVisibilityFrame();
  },
  beforeDestroy() {
    this._destroyed = true;
    this._isActive = false;
    this.unbindMainScroll();
    this.stopScrollAnimation();
    this.cancelVisibilityFrame();
  },
  methods: {
    getMainScrollElement() {
      const ownRoot = this.$el;
      if (ownRoot && ownRoot.closest) {
        const main = ownRoot.closest('main');
        if (main) return main;
      }
      const parentRoot = this.$parent && this.$parent.$el;
      return parentRoot && parentRoot.closest
        ? parentRoot.closest('main')
        : null;
    },
    bindMainScroll() {
      const main = this.getMainScrollElement();
      if (main) {
        this.bindMainScrollTarget(main);
        return;
      }
      const token = (this._bindToken || 0) + 1;
      this._bindToken = token;
      this.$nextTick(() => {
        if (
          this._destroyed ||
          !this._isActive ||
          token !== this._bindToken ||
          this._mainScrollBound
        ) {
          return;
        }
        const delayed = this.getMainScrollElement();
        if (delayed) this.bindMainScrollTarget(delayed);
      });
    },
    bindMainScrollTarget(main) {
      if (!main || this._mainScrollBound === main) return;
      this.unbindMainScroll();
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
      this.visible = main.scrollTop > this.threshold;
    },
    unbindMainScroll() {
      const main = this._mainScrollBound;
      this._bindToken = (this._bindToken || 0) + 1;
      if (!main) return;
      main.removeEventListener('scroll', this.onMainScroll);
      main.removeEventListener('wheel', this.stopScrollAnimation);
      main.removeEventListener('pointerdown', this.stopScrollAnimation);
      main.removeEventListener('touchstart', this.stopScrollAnimation);
      this._mainScrollBound = null;
    },
    onMainScroll() {
      if (!this._isActive || this._visibilityRaf) return;
      this._visibilityRaf = requestAnimationFrame(() => {
        this._visibilityRaf = null;
        if (this._destroyed || !this._isActive) return;
        const main = this._mainScrollBound || this.getMainScrollElement();
        this.visible = !!(main && main.scrollTop > this.threshold);
      });
    },
    cancelVisibilityFrame() {
      if (this._visibilityRaf) cancelAnimationFrame(this._visibilityRaf);
      this._visibilityRaf = null;
    },
    scrollToTopSmooth() {
      const main = this._mainScrollBound || this.getMainScrollElement();
      if (!main || main.scrollTop <= 0) return;
      this.stopScrollAnimation();
      const start = main.scrollTop;
      const duration = Math.min(420, Math.max(240, 180 + Math.sqrt(start) * 2));
      const startedAt = performance.now();
      const token = (this._scrollToken || 0) + 1;
      this._scrollToken = token;
      const tick = now => {
        if (
          this._destroyed ||
          !this._isActive ||
          token !== this._scrollToken ||
          main !== this._mainScrollBound
        ) {
          return;
        }
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 4);
        main.scrollTop = start * (1 - eased);
        if (progress < 1) {
          this._scrollRaf = requestAnimationFrame(tick);
          return;
        }
        this._scrollRaf = null;
        main.scrollTop = 0;
        this.visible = false;
      };
      this._scrollRaf = requestAnimationFrame(tick);
    },
    stopScrollAnimation() {
      this._scrollToken = (this._scrollToken || 0) + 1;
      if (this._scrollRaf) cancelAnimationFrame(this._scrollRaf);
      this._scrollRaf = null;
    },
  },
};
</script>
