<template>
  <!-- [加载动效] 跳动的三点：轻量加载等待提示，取代静态"正在载入…"文案。
       颜色默认主题色，可传 color(如封面主色)；纯 transform/opacity 合成器动画，零重排。
       Chromium91(Electron13) 支持 CSS 自定义属性 + 该动画。 -->
  <div
    class="bouncing-dots"
    :style="color ? { '--bdot-color': color } : null"
    role="status"
    aria-label="加载中"
  >
    <span></span>
    <span></span>
    <span></span>
  </div>
</template>

<script>
export default {
  name: 'BouncingDots',
  props: {
    // 圆点颜色；留空用主题色 var(--color-primary)
    color: { type: String, default: '' },
  },
};
</script>

<style lang="scss" scoped>
.bouncing-dots {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  --bdot-color: var(--color-primary);
  span {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--bdot-color);
    // 三点错相位跳动 → 波浪感；both 让首尾保持关键帧态
    animation: bdots-bounce 1.2s ease-in-out infinite both;
    transition: background 0.3s; // 封面色异步就绪时平滑换色，不突跳
    &:nth-child(2) {
      animation-delay: 0.16s;
    }
    &:nth-child(3) {
      animation-delay: 0.32s;
    }
  }
}
@keyframes bdots-bounce {
  0%,
  80%,
  100% {
    transform: translateY(0);
    opacity: 0.45;
  }
  40% {
    transform: translateY(-7px);
    opacity: 1;
  }
}
</style>
