<template>
  <!-- [修] R13：正常路径仍是单 <img>（父组件 .cover/.thumb 等类/元素选择器照常生效）。
       仅当「无 src」或「加载失败」时，切换为同样带 pod-img 类的占位块（纯色 + 居中图标），
       避免整块透明留白（思文败类 / Nice Try 首页空白成因）。 -->
  <img
    v-if="!failed && normalizedSrc"
    class="pod-img"
    :class="{ 'pod-img-loaded': loaded }"
    :src="normalizedSrc"
    loading="lazy"
    decoding="async"
    @load="onLoad"
    @error="onError"
  />
  <div v-else class="pod-img pod-img-placeholder">
    <svg-icon icon-class="radio-alt" class="pod-img-placeholder-icon" />
  </div>
</template>

<script>
// [B-62] 统一封面/单集图「淡入加载」：
//  - 未完全解码前 opacity:0 → 藏住远程图(多为 baseline JPEG)"逐行从上往下露出半张图"的过程，
//    @load 完成后整张淡入，视觉干净。
//  - loading="lazy"：可视区外的封面延迟加载 → 当前屏先出，滚动体验更快。
//  - decoding="async"：解码放后台线程，不卡主线程动画。
//  - 已被 HTTP 缓存命中的图，@load 可能在监听挂上前就触发 → mounted/换 src 后主动判 complete 兜底。
// 单 <img> 根：父组件的 .cover/.thumb 等样式(类/元素选择器)照常生效，替换零成本。
// [修] R13：加载失败/无 src 时渲染占位块(同样带 pod-img 类，继承父组件尺寸)，不再透明留白。
export default {
  name: 'PodImage',
  props: {
    src: { type: String, default: '' },
  },
  data() {
    return { loaded: false, failed: false };
  },
  computed: {
    // [修] R13：http:// 统一升 https://，减少混合内容被浏览器拦截致空白；其余 url 原样返回。
    normalizedSrc() {
      const raw = this.src || '';
      if (raw.indexOf('http://') === 0) {
        return 'https://' + raw.slice('http://'.length);
      }
      return raw;
    },
  },
  watch: {
    src() {
      this.loaded = false;
      this.failed = false; // [修] R13：换 src 重置失败态，给新封面正常加载机会。
      this.$nextTick(() => {
        // 父组件在 @error 时会给本 <img> 写 inline opacity(0/0.15)，
        // inline 优先级高于 class → 换 src 后新封面仍被旧的 inline opacity 压住隐身。
        // 换图时清掉上一张错误图留下的 inline opacity，让 class 控制淡入。
        if (this.$el && this.$el.style) this.$el.style.opacity = '';
        this.checkCached();
      });
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
      this.failed = true; // [修] R13：标记失败 → 模板切到占位块，而非透明隐藏。
      this.$emit('error', e);
    },
    checkCached() {
      const el = this.$el;
      // [修] R13：占位块没有 complete/naturalWidth，仅对真实 <img> 做缓存命中兜底。
      if (el && el.tagName === 'IMG' && el.complete && el.naturalWidth > 0) {
        this.loaded = true;
      }
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
/* [修] R13：占位块——纯色底 + 居中通用图标，撑满父组件给的尺寸，立即可见(无淡入)。 */
.pod-img-placeholder {
  opacity: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--color-secondary-bg);
}
.pod-img-placeholder-icon {
  width: 36%;
  height: 36%;
  max-width: 48px;
  max-height: 48px;
  color: var(--color-text);
  opacity: 0.35;
}
</style>
