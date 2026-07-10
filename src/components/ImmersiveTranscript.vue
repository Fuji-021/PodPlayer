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
      @wheel.passive="onUserInputScroll"
      @pointerdown.passive="onUserInputScroll"
      @touchstart.passive="onUserInputScroll"
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
        ><span class="immt-line-text">{{ w.text }}</span></div
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
import { buildAnchors, pinyinNormalize } from '@/utils/podcast/pinyinNormalize';
import {
  buildReplacer,
  classifySegment,
} from '@/utils/podcast/transcriptPostprocess';

const BUF = 10; // 窗口上下缓冲行数(大一点 → 滚动时窗口少变、少重渲染)
const PROCESS_CHUNK_SIZE = 80;
const EDGE_PAD_VH = 18;
const MAX_VISUAL_CHARS = 30;
const SOFT_MIN_CHARS = 12;
const MIN_VISUAL_DURATION = 0.72;
const FOLLOW_LOW = 0.35;
const FOLLOW_HIGH = 0.6;
const FOLLOW_TARGET = 0.46;
const FORWARD_HYSTERESIS = 0.18;
const BACKWARD_HYSTERESIS = 0.32;
const SEEK_JUMP_SEC = 1.5;
const LINE_CACHE_LIMIT = 6;
const lineCache = new Map();

function getCachedLines(key) {
  return key && lineCache.has(key) ? lineCache.get(key) : null;
}

function cacheLines(key, lines) {
  if (!key || !Array.isArray(lines)) return;
  if (lineCache.has(key)) lineCache.delete(key);
  lineCache.set(key, lines);
  while (lineCache.size > LINE_CACHE_LIMIT) {
    lineCache.delete(lineCache.keys().next().value);
  }
}

function waitForWorkSlot(preferIdle) {
  return new Promise(resolve => {
    if (
      preferIdle &&
      typeof window !== 'undefined' &&
      typeof window.requestIdleCallback === 'function'
    ) {
      window.requestIdleCallback(resolve, { timeout: 500 });
      return;
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0));
      return;
    }
    setTimeout(resolve, 0);
  });
}

function hashValue(h, value) {
  const str = String(value == null ? '' : value);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function finishHash(h) {
  return (h >>> 0).toString(36);
}

function hashSegments(segs) {
  let h = hashValue(2166136261, segs.length);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] || {};
    h = hashValue(h, s.start);
    h = hashValue(h, s.end);
    h = hashValue(h, s.text);
    h = hashValue(h, s.event);
    h = hashValue(h, s.lang);
  }
  return finishHash(h);
}

function hashDict(dict) {
  let h = 2166136261;
  h = hashValue(h, JSON.stringify((dict && dict.exact) || []));
  h = hashValue(h, JSON.stringify((dict && dict.anchors) || []));
  return finishHash(h);
}

function hashAiMap(aiMap) {
  const keys = Object.keys(aiMap || {}).sort();
  let h = hashValue(2166136261, keys.length);
  for (let i = 0; i < keys.length; i++) {
    h = hashValue(h, keys[i]);
    h = hashValue(h, aiMap[keys[i]]);
  }
  return finishHash(h);
}

function makeLineCacheKey(episodeId, segs, dict, aiMap) {
  return [
    episodeId || '',
    aiPromptVersion,
    hashSegments(segs || []),
    hashDict(dict || {}),
    hashAiMap(aiMap || {}),
  ].join('|');
}

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
      offsets: [0],
      totalH: 0,
      scrollPauseUntil: 0, // 用户手动滚动后短暂暂停自动跟随
    };
  },
  computed: {
    podcastId() {
      return String(this.episodeId || '').split('::')[0];
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
    if (this._measureRAF) cancelAnimationFrame(this._measureRAF);
    if (this._resizeObserver) this._resizeObserver.disconnect();
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
      await waitForWorkSlot(false);
      if (reqId !== this._loadReq || episodeId !== this.episodeId) return;
      // 走"已优化"管线，再叠加 AI 采纳(若有)；只保留 speech 段(噪声/音乐不入歌词流)
      const cacheKey = makeLineCacheKey(episodeId, segs, dict, aiMap);
      const cached = getCachedLines(cacheKey);
      if (cached) {
        this.lines = cached;
        this.loading = false;
        this.$nextTick(() => this.updateCur(true));
        return;
      }
      const lines = await this.buildLinesInChunks(
        segs,
        dict,
        aiMap,
        reqId,
        episodeId
      );
      if (!lines) return;
      cacheLines(cacheKey, lines);
      this.lines = lines;
      this.loading = false;
      this.$nextTick(() => this.updateCur(true)); // 打开即定位当前句(瞬时居中)
    },
    async buildLinesInChunks(segs, dict, aiMap, reqId, episodeId) {
      const replace = buildReplacer(dict.exact);
      const anchors = buildAnchors(dict.anchors);
      const lines = [];
      for (let i = 0; i < segs.length; i++) {
        if (i > 0 && i % PROCESS_CHUNK_SIZE === 0) {
          await waitForWorkSlot(false);
          if (reqId !== this._loadReq || episodeId !== this.episodeId) {
            return null;
          }
        }
        const s = segs[i];
        if (!s || classifySegment(s, { mainLang: 'zh' }) !== 'speech') {
          continue;
        }
        const display = pinyinNormalize(replace(s.text || ''), anchors);
        const text = (aiMap[i] != null ? aiMap[i] : display) || '';
        if (!String(text).trim()) continue;
        this.pushVisualLines(lines, s, text);
      }
      return lines;
    },
    pushVisualLines(out, seg, text) {
      const start = seg.start || 0;
      const end = seg.end || start;
      const duration = Math.max(0, end - start);
      const maxParts =
        duration > 0
          ? Math.max(1, Math.floor(duration / MIN_VISUAL_DURATION))
          : 1;
      const parts = this.splitVisualText(text, maxParts);
      if (!parts.length) return;
      for (let i = 0; i < parts.length; i++) {
        const partStart =
          duration > 0 ? start + (duration * i) / parts.length : start;
        const partEnd =
          duration > 0 ? start + (duration * (i + 1)) / parts.length : end;
        out.push({ start: partStart, end: partEnd, text: parts[i] });
        out[out.length - 1].h = this.estTextH(parts[i]);
      }
    },
    splitVisualText(text, maxParts) {
      const source = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!source) return [];
      const sentences = source.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [
        source,
      ];
      const out = [];
      for (let i = 0; i < sentences.length; i++) {
        let chars = Array.from(sentences[i].trim());
        while (chars.length > MAX_VISUAL_CHARS) {
          let cut = MAX_VISUAL_CHARS;
          for (let j = MAX_VISUAL_CHARS - 1; j >= SOFT_MIN_CHARS; j--) {
            if ('，,、：:'.includes(chars[j])) {
              cut = j + 1;
              break;
            }
          }
          out.push(chars.slice(0, cut).join('').trim());
          chars = chars.slice(cut);
        }
        const rest = chars.join('').trim();
        if (rest) out.push(rest);
      }
      return this.limitVisualParts(out.filter(Boolean), maxParts);
    },
    limitVisualParts(parts, maxParts) {
      const limit = Math.max(1, maxParts || 1);
      if (parts.length <= limit) return parts;
      const out = [];
      for (let i = 0; i < limit; i++) {
        const start = Math.floor((i * parts.length) / limit);
        const end = Math.floor(((i + 1) * parts.length) / limit);
        out.push(parts.slice(start, Math.max(start + 1, end)).join(''));
      }
      return out.filter(Boolean);
    },
    estTextH(text) {
      const len = text ? Array.from(text).length : 0;
      const lines = Math.max(1, Math.ceil(len / 15)); // 每行约 15 字(背景列较窄)
      return 16 + lines * 28; // padding + 行数×行高(估，measureVisible 实测纠正)
    },
    estH(line) {
      if (line && line.h) return line.h;
      return this.estTextH(line && line.text);
    },
    lineHeightAt(i) {
      return this.rowH[i] || this.estH(this.lines[i]);
    },
    rebuildOffsets() {
      const n = this.lines.length;
      const arr = new Array(n + 1);
      arr[0] = 0;
      for (let i = 0; i < n; i++) {
        arr[i + 1] = arr[i] + this.lineHeightAt(i);
      }
      this.offsets = arr;
      this.totalH = arr[n] || 0;
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
    stableIdx(sec, force) {
      const raw = this.findIdx(sec);
      const cur = this.curIdx;
      if (force || cur < 0 || raw < 0 || !this.lines[cur]) return raw;
      const lastSec =
        typeof this._lastSec === 'number' && isFinite(this._lastSec)
          ? this._lastSec
          : sec;
      if (Math.abs(sec - lastSec) > SEEK_JUMP_SEC) return raw;
      if (raw > cur) {
        const nextStart = this.lines[raw] ? this.lines[raw].start || 0 : sec;
        return sec >= nextStart + FORWARD_HYSTERESIS ? raw : cur;
      }
      if (raw < cur) {
        const curStart = this.lines[cur] ? this.lines[cur].start || 0 : sec;
        return sec <= curStart - BACKWARD_HYSTERESIS ? raw : cur;
      }
      return raw;
    },
    updateCur(forceCenter) {
      if (!this.lines.length) {
        this.curIdx = -1;
        return;
      }
      const sec = Number(this.currentSec) || 0;
      const idx = this.stableIdx(sec, !!forceCenter);
      this._lastSec = sec;
      const changed = idx !== this.curIdx;
      this.curIdx = idx;
      // 隐藏(未展开)时只更新高亮下标、不自动滚动(省事，展开瞬间再统一居中)
      if (
        (changed || forceCenter) &&
        idx >= 0 &&
        this.active &&
        !this.isUserScrolling()
      ) {
        this.$nextTick(() => this.followActive(!!forceCenter));
      }
    },
    isUserScrolling() {
      return Date.now() < this.scrollPauseUntil;
    },
    // 列表 padding-top 的像素值。CSS 是 `padding: 18vh` → 直接用 innerHeight 算，
    //   避免每滚动帧 getComputedStyle(强制样式重算)。
    padTopPx() {
      const h =
        typeof window !== 'undefined' && window.innerHeight
          ? window.innerHeight
          : 0;
      return h * (EDGE_PAD_VH / 100);
    },
    // dead-zone 跟随：当前句在视口 35%~60% 内不滚，超出后瞬时拉回目标区。
    followActive(forceCenter) {
      const list = this.$refs.list;
      if (!list || this.curIdx < 0) return;
      const viewH = list.clientHeight || 400;
      const padTop = this.padTopPx();
      const top = padTop + (this.offsets[this.curIdx] || 0);
      const h = this.lineHeightAt(this.curIdx);
      const center = top + h / 2;
      const y = center - (list.scrollTop || 0);
      const low = viewH * FOLLOW_LOW;
      const high = viewH * FOLLOW_HIGH;
      if (!forceCenter && y >= low && y <= high) {
        this.recalcWindow();
        return;
      }
      const target = Math.max(0, center - viewH * FOLLOW_TARGET);
      try {
        list.scrollTo({ top: target, behavior: 'auto' });
      } catch (e) {
        list.scrollTop = target;
      }
      this.recalcWindow();
    },
    onScroll() {
      if (this._scrollRAF) return;
      this._scrollRAF = requestAnimationFrame(() => {
        this._scrollRAF = null;
        this.recalcWindow();
      });
    },
    onUserInputScroll() {
      this.scrollPauseUntil = Date.now() + 4000; // 真实用户输入 → 暂停自动跟随 4s
    },
    // 按 scrollTop 二分 offsets 算可视窗口[winStart,winEnd)(含缓冲)
    recalcWindow() {
      const list = this.$refs.list;
      if (!list) return;
      this.trackListWidth(list);
      const padTop = this.padTopPx();
      const top = Math.max(0, list.scrollTop - padTop);
      const viewH = list.clientHeight || 400;
      if (this.offsets.length !== this.lines.length + 1) this.rebuildOffsets();
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
    trackListWidth(list) {
      const width = Math.round(list.clientWidth || 0);
      if (!width) return;
      if (this._listWidth && Math.abs(width - this._listWidth) > 1) {
        this.rowH = {};
        this.rebuildOffsets();
      }
      this._listWidth = width;
      this.ensureResizeObserver(list);
    },
    ensureResizeObserver(list) {
      if (this._resizeEl === list) return;
      if (this._resizeObserver) this._resizeObserver.disconnect();
      this._resizeEl = list;
      if (typeof ResizeObserver !== 'function') return;
      this._resizeObserver = new ResizeObserver(entries => {
        const rect =
          entries && entries[0] && entries[0].contentRect
            ? entries[0].contentRect
            : null;
        const width = rect ? Math.round(rect.width || 0) : 0;
        if (!width || !this._listWidth) {
          this._listWidth = width || this._listWidth;
          return;
        }
        if (Math.abs(width - this._listWidth) <= 1) return;
        this._listWidth = width;
        this.rowH = {};
        this.rebuildOffsets();
        this.$nextTick(() => this.recalcWindow());
      });
      this._resizeObserver.observe(list);
    },
    measureVisible() {
      if (!this.active || this._measureRAF) return;
      this._measureRAF = requestAnimationFrame(() => {
        this._measureRAF = null;
        this.$nextTick(() => {
          const list = this.$refs.list;
          if (!list || !this.active) return;
          const els = list.querySelectorAll('[data-i]');
          const updates = {};
          let changed = false;
          for (let k = 0; k < els.length; k++) {
            const el = els[k];
            const i = parseInt(el.getAttribute('data-i'), 10);
            // [性能] 已测过的行跳过——不再读 offsetHeight。读 offsetHeight 会强制同步重排,
            //   原来每个滚动帧对所有可视行都读一遍=layout thrash(滚动不丝滑主因)。行高随内容固定,
            //   测一次即可(rows 变时 resetWindow 已清缓存)。当前句只做 transform 高亮，不再改变布局高度。
            if (isNaN(i) || !this.lines[i]) continue;
            if (this.rowH[i] != null) continue;
            const h = el.offsetHeight;
            // 高度真变才更新(当前行虽每帧重测,字号过渡稳定后 h 不变→不触发重算)
            if (h && this.rowH[i] !== h) {
              updates[i] = h;
              changed = true;
            }
          }
          if (changed) {
            this.rowH = Object.assign({}, this.rowH, updates);
            this.rebuildOffsets();
          }
        });
      });
    },
    resetWindow() {
      this.rowH = {};
      this.rebuildOffsets();
      this.winStart = 0;
      this.winEnd = Math.min(this.lines.length, 40);
      if (this.active) this.$nextTick(() => this.recalcWindow());
    },
    onLineClick(w) {
      if (!w) return;
      this.scrollPauseUntil = 0; // 点句即恢复跟随
      this.curIdx = w.i;
      this._lastSec = w.start || 0;
      this.$emit('seek', w.start || 0);
      this.$nextTick(() => this.followActive(true));
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
  overflow-x: hidden;
  padding: 18vh clamp(30px, 4vw, 54px) 18vh 4px;
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
  padding: 7px 9px;
  margin: 2px 0;
  border-radius: 10px;
  cursor: pointer;
  letter-spacing: 0;
  line-height: 1.32;
  overflow-wrap: anywhere;
  box-sizing: border-box;
  width: 100%;
  overflow: visible;
  font-size: clamp(15px, 1.18vw, 18px);
  font-weight: 700;
  color: rgba(245, 245, 247, 0.95);
  opacity: 0.24;
  transition: opacity 0.32s ease, color 0.32s ease, text-shadow 0.32s ease;
  &:hover {
    opacity: 0.92;
  }
  &.past {
    opacity: 0.4; // 已读句
  }
  &.active {
    opacity: 1;
    color: rgba(255, 255, 255, 0.98);
    text-shadow: 0 1px 10px rgba(0, 0, 0, 0.42);
  }
}
.immt-line-text {
  display: inline-block;
  max-width: 100%;
  transform-origin: left center;
  transform: scale(1);
  transition: transform 0.28s ease, opacity 0.32s ease;
}
.immt-line.active .immt-line-text {
  transform: scale(1.08);
  will-change: transform;
}
</style>
