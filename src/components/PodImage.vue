<template>
  <!-- [修] R13：正常路径仍是单 <img>（父组件 .cover/.thumb 等类/元素选择器照常生效）。
       仅当「无 src」或「加载失败」时，切换为同样带 pod-img 类的占位块（纯色 + 居中图标），
       避免整块透明留白（思文败类 / Nice Try 首页空白成因）。 -->
  <img
    v-if="!failed && displaySrc"
    class="pod-img"
    :class="{ 'pod-img-loaded': loaded }"
    :src="displaySrc"
    :loading="imageLoading"
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
// [封面缓存·治本] 接入本地持久封面缓存(coverCache)：内存命中→秒用本地 dataURL(零网络)；否则先挂原图，
//   异步查 Dexie 命中且远程尚未加载完成则换成本地图(把卡在不稳定国际 CDN——如 Cloudflare——的请求
//   换成秒开本地图)；远程**加载成功后**复用那张已解码的 <img> 降采样落盘(零额外请求、尊重 lazy)，
//   下次进任意封面位置即零网络秒开。一处接入、全 app 封面位置统一受益。详见 utils/podcast/coverCache.js。
import {
  peekCachedCover,
  getCachedCover,
  cacheCoverFromImg,
} from '@/utils/podcast/coverCache';

export default {
  name: 'PodImage',
  props: {
    src: { type: String, default: '' },
    loading: { type: String, default: 'lazy' },
  },
  data() {
    // displaySrc = 实际喂给 <img> 的地址：优先本地缓存 dataURL，否则归一化后的远程 url。
    return { loaded: false, failed: false, displaySrc: '' };
  },
  computed: {
    imageLoading() {
      return this.loading === 'eager' ? 'eager' : 'lazy';
    },
    // [修] R13：http:// 统一升 https://，减少混合内容被浏览器拦截致空白；其余 url 原样返回。
    //   同时作为封面缓存的统一 key（http/https 归一为同一条缓存）。
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
      this.resolveSrc();
    },
  },
  created() {
    // 初始解析放 created：在首帧渲染前就定好 displaySrc，避免出现一瞬占位块闪烁。
    this.resolveSrc();
  },
  methods: {
    // 解析当前应显示的封面地址：同步内存命中用本地图；否则先挂原图、异步查 Dexie 命中则换本地图。
    resolveSrc() {
      this.failed = false; // [修] R13：换 src 重置失败态，给新封面正常加载机会。
      const url = this.normalizedSrc;
      const cached = peekCachedCover(url); // 会话内存命中 → 直接本地图，零网络、零闪
      this.displaySrc = cached || url;
      // [封面闪烁修] 命中本地 dataURL → 立即 opacity:1 显示(本地解码即时)，不再白白从 0 淡入造成暗块/错峰；
      //   远程 url → loaded=false，等 @load 再淡入(隐藏 progressive JPEG 逐行解码，原行为不变)。
      this.loaded = !!cached;
      this.$nextTick(() => {
        // 父组件在 @error 时会给本 <img> 写 inline opacity(0/0.15)，inline 优先级高于 class
        // → 换 src 后新封面仍被旧的 inline opacity 压住隐身。换图时清掉，让 class 控制淡入。
        if (this.$el && this.$el.style) this.$el.style.opacity = '';
        this.checkCached();
      });
      if (!url || cached) return;
      // 异步查 Dexie 持久缓存：命中且远程尚未加载完成 → 换成本地 dataURL，
      //   把卡在不稳定 CDN 的远程请求替换为秒开本地图（远程已加载完则不换，避免无谓闪烁）。
      getCachedCover(url).then(data => {
        if (this.normalizedSrc !== url) return; // src 已切换 → 本次结果作废
        if (data && data !== this.displaySrc && !this.loaded) {
          this.failed = false;
          this.displaySrc = data;
          this.loaded = true; // [封面闪烁修] Dexie 命中也即时显示，不二次淡入
        }
      });
    },
    // [封面闪烁修] 落盘(canvas 编码)挪到空闲帧 + 二次校验：翻页整页 @load 时刻聚集，原来同步编码 ~24 张
    //   会与各图淡入抢主线程致错峰卡顿。延迟回调里若组件已卸载/换 src/变占位块则跳过，绝不对失效 el 操作。
    _persistCover(url) {
      const run = () => {
        if (
          this.normalizedSrc === url &&
          this.displaySrc === url &&
          this.$el &&
          this.$el.tagName === 'IMG'
        ) {
          cacheCoverFromImg(url, this.$el);
        }
      };
      if (window.requestIdleCallback) {
        window.requestIdleCallback(run, { timeout: 800 });
      } else {
        setTimeout(run, 0);
      }
    },
    onLoad(e) {
      this.loaded = true;
      // 显示的是远程原图(非已命中的本地 dataURL)时，把这张已解码的图降采样持久化 → 下次零网络秒开。
      if (
        this.displaySrc === this.normalizedSrc &&
        this.$el &&
        this.$el.tagName === 'IMG'
      ) {
        this._persistCover(this.normalizedSrc);
      }
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
        // HTTP 缓存命中时 @load 可能早于监听挂上 → 这里补一次封面持久化（与 onLoad 同条件）。
        if (this.displaySrc === this.normalizedSrc) {
          this._persistCover(this.normalizedSrc);
        }
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
