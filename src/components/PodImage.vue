<template>
  <img
    class="pod-img"
    :class="{ 'pod-img-loaded': loaded }"
    :src="src"
    loading="lazy"
    decoding="async"
    @load="onLoad"
    @error="onError"
  />
</template>

<script>
// [B-62] 统一封面/单集图「淡入加载」：
//  - 未完全解码前 opacity:0 → 藏住远程图(多为 baseline JPEG)"逐行从上往下露出半张图"的过程，
//    @load 完成后整张淡入，视觉干净。
//  - loading="lazy"：可视区外的封面延迟加载 → 当前屏先出，滚动体验更快。
//  - decoding="async"：解码放后台线程，不卡主线程动画。
//  - 已被 HTTP 缓存命中的图，@load 可能在监听挂上前就触发 → mounted/换 src 后主动判 complete 兜底。
// 单 <img> 根：父组件的 .cover/.thumb 等样式(类/元素选择器)照常生效，替换零成本。
export default {
  name: 'PodImage',
  props: {
    src: { type: String, default: '' },
  },
  data() {
    return { loaded: false };
  },
  watch: {
    src() {
      this.loaded = false;
      this.$nextTick(this.checkCached);
    },
  },
  mounted() {
    this.checkCached();
  },
  methods: {
    onLoad(e) {
      this.loaded = true;
      this.$emit('load', e);
    },
    onError(e) {
      this.$emit('error', e);
    },
    checkCached() {
      const el = this.$el;
      if (el && el.complete && el.naturalWidth > 0) this.loaded = true;
    },
  },
};
</script>

<style scoped>
.pod-img {
  opacity: 0;
  transition: opacity 0.4s ease;
}
.pod-img.pod-img-loaded {
  opacity: 1;
}
</style>
