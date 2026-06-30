<template>
  <div class="imm-transcript">
    <!-- 载入中 / 空：极简文字，不做框(背景式) -->
    <div v-if="loading" class="immt-state">载入文字稿…</div>
    <div v-else-if="!lines.length" class="immt-state">（本集暂无文字稿）</div>
    <!-- 文稿正文：歌词式背景文字(无框)。变高窗口虚拟化 + 上下渐隐遮罩 -->
    <div
      v-else
      ref="list"
      class="immt-list"
      @scroll.passive="onScroll"
      @wheel.passive="onUserScroll"
    >
      <div class="immt-spacer" :style="{ height: topPad + 'px' }"></div>
      <div
        v-for="w in winLines"
        :key="w.i"
        :data-i="w.i"
        class="immt-line"
        :class="{
          active: w.i === curIdx,
          past: w.i < curIdx,
        }"
        @click="onLineClick(w)"
        >{{ w.text }}</div
      >
      <div class="immt-spacer" :style="{ height: botPad + 'px' }"></div>
    </div>
  </div>
</template>

<script>
// [沉浸页·文稿] Apple Music 歌词式「背景文字稿」——绝非独立的框，而是浮在沉浸背景里的逐句文字。
//   设计参考 docs 设计稿(项目UI与美术设计-handoff/沉浸式播放页.dc.html)：当前句大而亮、上下句渐隐、
//   点句跳播、播放自动居中、上下渐隐遮罩、滚动条隐藏。
//   【复用而非另起】数据层完全复用现有 ASR/AI 文字稿管线：readSegments + postprocessSegments(事件过滤+
//   专名词典+拼音归一) + AI 精修 aiMap(若有)，与 TranscriptPanel 同一份产出；本组件只负责"背景式展示"。
//   【性能】沿用 TranscriptPanel 已验证的「变高窗口虚拟化」(只渲染可视区±缓冲)——长播客数千段不再常驻
//   DOM、不重蹈 content-visibility 全常驻致电脑级卡顿的坑。
//   【职责边界】只入(episodeId, currentSec)、只出(seek)；不复制任何播放状态(播放/队列/倍速归 Player)。
import {
  readSegments,
  getDictParts,
  getAiRefine,
  aiPromptVersion,
} from '@/utils/podcast/transcripts';
import { postprocessSegments } from '@/utils/podcast/transcriptPostprocess';

const BUF = 10; // 窗口上下缓冲行数(大一点 → 滚动时窗口少变、少重渲染)

export default {
  name: 'ImmersiveTranscript',
  props: {
    episodeId: { type: String, default: '' },
    currentSec: { type: Number, default: 0 },
    // 文稿是否处于展开(可见)态：隐藏时不做自动居中(省事)；激活瞬间重新居中到当前句
    active: { type: Boolean, default: true },
  },
  data() {
    return {
      loading: true,
      lines: [], // [{start, end, text}]，仅 speech 段(噪声/音乐已滤)
      curIdx: -1,
      winStart: 0,
      winEnd: 40,
      rowH: {}, // 行下标 → 实测高(估高兜底)
      scrollPauseUntil: 0, // 用户手动滚动后短暂暂停自动跟随
    };
  },
  computed: {
    podcastId() {
      return String(this.episodeId || '').split('::')[0];
    },
    // 行高(实测优先,否则估高) → 前缀和 offsets
    offsets() {
      const n = this.lines.length;
      const arr = new Array(n + 1);
      arr[0] = 0;
      for (let i = 0; i < n; i++) {
        arr[i + 1] = arr[i] + (this.rowH[i] || this.estH(this.lines[i]));
      }
      return arr;
    },
    totalH() {
      const o = this.offsets;
      return o[o.length - 1] || 0;
    },
    winLines() {
      const out = [];
      const end = Math.min(this.winEnd, this.lines.length);
      for (let i = this.winStart; i < end; i++) {
        out.push({ i, text: this.lines[i].text, start: this.lines[i].start });
      }
      return out;
    },
    topPad() {
      return this.offsets[Math.min(this.winStart, this.lines.length)] || 0;
    },
    botPad() {
      const endOff =
        this.offsets[Math.min(this.winEnd, this.lines.length)] || this.totalH;
      return Math.max(0, this.totalH - endOff);
    },
  },
  watch: {
    episodeId() {
      this.load();
    },
    currentSec() {
      this.updateCur(false);
    },
    lines() {
      this.resetWindow();
    },
    active(v) {
      // 展开瞬间：几何在预加载期已稳定(仅 opacity/transform 过渡)，$nextTick 内重算窗口 + 居中到当前句(瞬时)
      if (v) {
        this.$nextTick(() => {
          this.recalcWindow();
          this.updateCur(true);
        });
      }
    },
  },
  mounted() {
    this.load();
  },
  beforeDestroy() {
    this._loadReq = (this._loadReq || 0) + 1;
    if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);
  },
  methods: {
    async load() {
      const reqId = (this._loadReq || 0) + 1;
      this._loadReq = reqId;
      const episodeId = this.episodeId;
      const podcastId = String(episodeId || '').split('::')[0];
      // 仅首次(无内容)显示"载入中"；换集重载时保留旧文稿到新内容就绪再替换 → 减少切换闪烁
      this.loading = !this.lines.length;
      let segs = [];
      try {
        const res = await readSegments(episodeId);
        if (res && res.ok && Array.isArray(res.segments)) {
          segs = res.segments
            .filter(s => s && s.text && String(s.text).trim().length)
            .sort((a, b) => (a.start || 0) - (b.start || 0));
        }
      } catch (e) {
        segs = [];
      }
      if (reqId !== this._loadReq || episodeId !== this.episodeId) return;
      // 词典(节目级+全局) + AI 精修缓存(同 promptVer 且段数未变才用) —— 与 TranscriptPanel 一致
      let dict = { exact: [], anchors: [] };
      try {
        dict = await getDictParts(podcastId);
      } catch (e) {
        /* ignore */
      }
      if (reqId !== this._loadReq || episodeId !== this.episodeId) return;
      let aiMap = {};
      try {
        const row = await getAiRefine(episodeId);
        if (
          row &&
          row.promptVer === aiPromptVersion &&
          row.segs &&
          (!row.segCount || row.segCount === segs.length)
        ) {
          aiMap = row.segs;
        }
      } catch (e) {
        /* ignore */
      }
      if (reqId !== this._loadReq || episodeId !== this.episodeId) return;
      // 走"已优化"管线，再叠加 AI 采纳(若有)；只保留 speech 段(噪声/音乐不入歌词流)
      const vs = postprocessSegments(segs, {
        dict: dict.exact,
        anchors: dict.anchors,
        mainLang: 'zh',
      });
      const lines = [];
      for (let i = 0; i < vs.length; i++) {
        const s = vs[i];
        if (s.kind !== 'speech') continue;
        const text = (aiMap[i] != null ? aiMap[i] : s.display) || '';
        if (!String(text).trim()) continue;
        lines.push({ start: s.start || 0, end: s.end || 0, text });
      }
      this.lines = lines;
      this.loading = false;
      this.$nextTick(() => this.updateCur(true)); // 打开即定位当前句(瞬时居中)
    },
    estH(line) {
      const len = line && line.text ? Array.from(line.text).length : 0;
      const lines = Math.max(1, Math.ceil(len / 16)); // 每行约 16 字(背景列较窄)
      return 18 + lines * 30; // padding + 行数×行高(估，measureVisible 实测纠正)
    },
    findIdx(sec) {
      const n = this.lines.length;
      if (!n) return -1;
      let lo = 0;
      let hi = n - 1;
      let pos = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((this.lines[mid].start || 0) <= sec) {
          pos = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return pos < 0 ? 0 : pos; // 起播前(sec<首句)也高亮首句
    },
    updateCur(forceCenter) {
      if (!this.lines.length) {
        this.curIdx = -1;
        return;
      }
      const idx = this.findIdx(this.currentSec);
      const changed = idx !== this.curIdx;
      this.curIdx = idx;
      // 隐藏(未展开)时只更新高亮下标、不自动滚动(省事，展开瞬间再统一居中)
      if (
        (changed || forceCenter) &&
        idx >= 0 &&
        this.active &&
        !this.isUserScrolling()
      ) {
        this.$nextTick(() => this.centerActive(!!forceCenter));
      }
    },
    isUserScrolling() {
      return Date.now() < this.scrollPauseUntil;
    },
    // 列表 padding-top 的像素值。CSS 是 `padding: 36vh` → 直接用 innerHeight*0.36 算，
    //   避免每滚动帧 getComputedStyle(强制样式重算)。⚠️ 0.36 必须与 .immt-list 的 36vh 同步改。
    padTopPx() {
      return (window.innerHeight || 0) * 0.36;
    },
    // 把当前句滚到列表垂直中央
    centerActive(instant) {
      const list = this.$refs.list;
      if (!list || this.curIdx < 0) return;
      const viewH = list.clientHeight || 400;
      const padTop = this.padTopPx();
      const top = padTop + (this.offsets[this.curIdx] || 0);
      const h = this.rowH[this.curIdx] || this.estH(this.lines[this.curIdx]);
      const target = Math.max(0, top + h / 2 - viewH / 2);
      this._progScrollUntil = Date.now() + 160; // 标记为程序滚动，别误判成用户滚动
      try {
        list.scrollTo({ top: target, behavior: instant ? 'auto' : 'smooth' });
      } catch (e) {
        list.scrollTop = target;
      }
      this.recalcWindow();
    },
    onScroll() {
      // 程序滚动(自动居中)触发的 scroll 不算用户滚动
      if (Date.now() > (this._progScrollUntil || 0)) {
        this.scrollPauseUntil = Date.now() + 4000;
      }
      if (this._scrollRAF) return;
      this._scrollRAF = requestAnimationFrame(() => {
        this._scrollRAF = null;
        this.recalcWindow();
      });
    },
    onUserScroll() {
      this.scrollPauseUntil = Date.now() + 4000; // 用户滚轮 → 暂停自动跟随 4s
    },
    // 按 scrollTop 二分 offsets 算可视窗口[winStart,winEnd)(含缓冲)
    recalcWindow() {
      const list = this.$refs.list;
      if (!list) return;
      const padTop = this.padTopPx();
      const top = Math.max(0, list.scrollTop - padTop);
      const viewH = list.clientHeight || 400;
      const off = this.offsets;
      const n = this.lines.length;
      let lo = 0;
      let hi = n;
      let start = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((off[mid] || 0) <= top) {
          start = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      let end = start;
      while (end < n && (off[end] || 0) < top + viewH) end++;
      this.winStart = Math.max(0, start - BUF);
      this.winEnd = Math.min(n, end + BUF);
      this.measureVisible();
    },
    measureVisible() {
      this.$nextTick(() => {
        const list = this.$refs.list;
        if (!list) return;
        const els = list.querySelectorAll('[data-i]');
        const updates = {};
        let changed = false;
        for (let k = 0; k < els.length; k++) {
          const el = els[k];
          const i = parseInt(el.getAttribute('data-i'), 10);
          // [性能] 已测过的行跳过——不再读 offsetHeight。读 offsetHeight 会强制同步重排,
          //   原来每个滚动帧对所有可视行都读一遍=layout thrash(滚动不丝滑主因)。行高随内容固定,
          //   测一次即可(rows 变时 resetWindow 已清缓存)。
          //   例外:当前句字号会放大(高度变) → 当前行始终重测,保证 offsets/居中准确。
          if (isNaN(i) || !this.lines[i]) continue;
          if (this.rowH[i] != null && i !== this.curIdx) continue;
          const h = el.offsetHeight;
          // 高度真变才更新(当前行虽每帧重测,字号过渡稳定后 h 不变→不触发重算)
          if (h && this.rowH[i] !== h) {
            updates[i] = h;
            changed = true;
          }
        }
        if (changed) this.rowH = Object.assign({}, this.rowH, updates);
      });
    },
    resetWindow() {
      this.rowH = {};
      this.winStart = 0;
      this.winEnd = 40;
      this.$nextTick(() => this.recalcWindow());
    },
    onLineClick(w) {
      if (!w) return;
      this.scrollPauseUntil = 0; // 点句即恢复跟随
      this.curIdx = w.i;
      this.$emit('seek', w.start || 0);
      this.$nextTick(() => this.centerActive(false));
    },
  },
};
</script>

<style lang="scss" scoped>
.imm-transcript {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
}
// 载入/空态：背景式淡字，不做框
.immt-state {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  transform: translateY(-50%);
  text-align: center;
  font-size: 15px;
  color: rgba(245, 245, 247, 0.5);
}
// 文稿滚动区：上下渐隐遮罩 + 隐藏滚动条 + 大上下留白(让首尾句也能居中)
.immt-list {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  padding: 36vh 4px;
  box-sizing: border-box;
  scrollbar-width: none;
  // [性能] translateZ(0) 提层 → 滚动走合成器、不重绘身后 blur(64px) 模糊背景(滚动卡顿主因之一)。
  //   单这一层即可,不再加 will-change(避免与背景 blur 叠太多持久合成层)。
  transform: translateZ(0);
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    #000 14%,
    #000 86%,
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    #000 14%,
    #000 86%,
    transparent 100%
  );
  &::-webkit-scrollbar {
    width: 0;
    height: 0;
    display: none;
  }
}
.immt-spacer {
  width: 100%;
  pointer-events: none;
}
// 单句：默认未来句最弱 → 已读句次弱 → 当前句最大最亮
.immt-line {
  padding: 8px 10px;
  margin: 2px 0;
  border-radius: 10px;
  cursor: pointer;
  letter-spacing: 0.2px;
  line-height: 1.34;
  // [批注] 文稿字体再小一号
  font-size: clamp(14px, 1.25vw, 18px);
  font-weight: 600;
  color: rgba(245, 245, 247, 0.95);
  opacity: 0.24;
  transform-origin: left center;
  transition: opacity 0.4s ease, font-size 0.4s ease, color 0.4s ease;
  &:hover {
    opacity: 0.92;
  }
  &.past {
    opacity: 0.4; // 已读句
  }
  &.active {
    opacity: 1;
    font-size: clamp(18px, 1.85vw, 25px);
    font-weight: 700;
  }
}
</style>
