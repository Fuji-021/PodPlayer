<template>
  <div>
    <transition name="fade">
      <div
        v-show="show"
        id="scrollbar"
        :class="{ 'on-drag': isOnDrag }"
        @click="handleClick"
      >
        <div
          id="thumbContainer"
          :class="{ active }"
          :style="thumbStyle"
          @mouseenter="handleMouseenter"
          @mouseleave="handleMouseleave"
          @mousedown="handleDragStart"
          @click.stop
        >
          <div></div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
export default {
  name: 'Scrollbar',
  data() {
    return {
      top: 0,
      thumbHeight: 0,
      active: false,
      show: false,
      hideTimer: null,
      isOnDrag: false,
      onDragClientY: 0,
      positions: {
        home: { scrollTop: 0, params: {} },
      },
    };
  },
  computed: {
    thumbStyle() {
      return {
        transform: `translateY(${this.top}px)`,
        height: `${this.thumbHeight}px`,
      };
    },
    main() {
      return this.$parent.$refs.main;
    },
  },

  created() {
    this.$router.beforeEach((to, from, next) => {
      this.show = false;
      next();
    });
  },

  methods: {
    handleScroll() {
      const main = this.main;
      // [首页滚动卡顿修·P1] 原来每个 scroll 事件(键盘 rAF 滚动时 ~60 次/秒)都同步读 clientHeight +
      //   scrollHeight，紧跟在 rAF 写 scrollTop 之后 → 教科书式 forced synchronous layout(layout
      //   thrash)。首页一次性铺 40+ 张封面卡(不虚拟化)，每帧整页 reflow → 卡顿；单集详情页虚拟化
      //   DOM 极少故无感。修：这俩几何量在一次连续滚动里基本不变，节流到 ~每 250ms 才重读一次；每帧
      //   只读 scrollTop(轻)。自愈：内容/视口变化最多 250ms 后反映到滚动条，无需挂 resize/路由钩子。
      const now =
        typeof performance !== 'undefined' && performance.now
          ? performance.now()
          : Date.now();
      if (!this._metricsTs || now - this._metricsTs > 250 || !this._cScrollH) {
        this._cClientH = main.clientHeight - 128;
        this._cScrollH = main.scrollHeight - 128;
        this._metricsTs = now;
      }
      const clintHeight = this._cClientH;
      const scrollHeight = this._cScrollH;
      const scrollTop = main.scrollTop;
      let top = ~~((scrollTop / scrollHeight) * clintHeight);
      let thumbHeight = ~~((clintHeight / scrollHeight) * clintHeight);

      if (thumbHeight < 24) thumbHeight = 24;
      if (top > clintHeight - thumbHeight) {
        top = clintHeight - thumbHeight;
      }
      this.top = top;
      this.thumbHeight = thumbHeight;

      if (!this.show && clintHeight !== thumbHeight) this.show = true;
      this.setScrollbarHideTimeout();

      const route = this.$route;
      if (route.meta.savePosition) {
        this.positions[route.name] = { scrollTop, params: route.params };
      }
    },
    handleMouseenter() {
      this.active = true;
    },
    handleMouseleave() {
      this.active = false;
      this.setScrollbarHideTimeout();
    },
    handleDragStart(e) {
      this.onDragClientY = e.clientY;
      this.isOnDrag = true;
      this.$parent.userSelectNone = true;
      document.addEventListener('mousemove', this.handleDragMove);
      document.addEventListener('mouseup', this.handleDragEnd);
    },
    handleDragMove(e) {
      if (!this.isOnDrag) return;
      const clintHeight = this.main.clientHeight - 128;
      const scrollHeight = this.main.scrollHeight - 128;
      const clientY = e.clientY;
      const scrollTop = this.main.scrollTop;
      const offset = ~~(
        ((clientY - this.onDragClientY) / clintHeight) *
        scrollHeight
      );
      this.top = ~~((scrollTop / scrollHeight) * clintHeight);
      this.main.scrollBy(0, offset);
      this.onDragClientY = clientY;
    },
    handleDragEnd() {
      this.isOnDrag = false;
      this.$parent.userSelectNone = false;
      document.removeEventListener('mousemove', this.handleDragMove);
      document.removeEventListener('mouseup', this.handleDragEnd);
    },
    handleClick(e) {
      let scrollTop;
      if (e.clientY < this.top + 84) {
        scrollTop = -256;
      } else {
        scrollTop = 256;
      }
      this.main.scrollBy({
        top: scrollTop,
        behavior: 'smooth',
      });
    },
    setScrollbarHideTimeout() {
      if (this.hideTimer !== null) clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        if (!this.active) this.show = false;
        this.hideTimer = null;
      }, 4000);
    },
    restorePosition() {
      const route = this.$route;
      if (
        !route.meta.savePosition ||
        this.positions[route.name] === undefined ||
        this.main === undefined
      ) {
        return;
      }
      this.main.scrollTo({ top: this.positions[route.name].scrollTop });
    },
  },
};
</script>

<style lang="scss" scoped>
#scrollbar {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 16px;
  z-index: 1000;

  #thumbContainer {
    margin-top: 64px;
    div {
      transition: background 0.4s;
      position: absolute;
      right: 2px;
      width: 8px;
      height: 100%;
      border-radius: 4px;
      background: rgba(128, 128, 128, 0.38);
    }
  }
  #thumbContainer.active div {
    background: rgba(128, 128, 128, 0.58);
  }
}

[data-theme='dark'] {
  #thumbContainer div {
    background: var(--color-secondary-bg);
  }
}

#scrollbar.on-drag {
  left: 0;
  width: auto;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter,
.fade-leave-to {
  opacity: 0;
}
</style>
