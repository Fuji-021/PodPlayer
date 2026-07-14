<template>
  <transition name="fade">
    <div v-show="toast.show" class="toast" data-selection="ui">
      {{ toast.text }}
    </div>
  </transition>
</template>

<script>
import { mapState } from 'vuex';

export default {
  name: 'Toast',
  computed: {
    ...mapState(['toast']),
  },
};
</script>

<style lang="scss" scoped>
// [改] 去掉发灰的硬边框，改纯阴影浮起的胶囊：更干净、更有层次。
.toast {
  position: fixed;
  bottom: 64px;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 8px 24px -6px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.06);
  border: none;
  backdrop-filter: saturate(180%) blur(16px);
  border-radius: 10px;
  box-sizing: border-box;
  padding: 8px 16px;
  z-index: 1010;
}

// [沉浸式播放页] 沉浸页打开时(body.immersive-open)，控制区在垂直居中位置，默认 bottom:64px 的
//   toast 会与之重叠。此时把 toast 下移到更靠近屏幕底部(仍水平居中)，避开控制区、不遮挡。
//   普通视图(无该类)位置不变，仍贴在播放 bar 之上。
body.immersive-open .toast {
  bottom: 24px;
}

[data-theme='dark'] {
  .toast {
    background: rgba(46, 46, 46, 0.82);
    box-shadow: 0 8px 24px -6px rgba(0, 0, 0, 0.5);
    backdrop-filter: saturate(160%) blur(18px);
    border: none;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter, .fade-leave-to /* .fade-leave-active below version 2.1.8 */ {
  opacity: 0;
}
</style>
