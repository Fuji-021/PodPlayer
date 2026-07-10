<template>
  <div class="transcript-section" :class="{ expanded }">
    <div class="transcript-header">
      <h2>AI 文字稿</h2>
      <div v-if="mode === 'done' || mode === 'paused'" class="t-actions">
        <button
          class="t-link t-top-link"
          title="回到本页顶部"
          @click="scrollPageTop"
        >
          <svg-icon icon-class="arrow-up" />
          <span>顶部</span>
        </button>
        <button
          class="t-link"
          :class="{ on: follow }"
          title="播放时自动高亮并滚动到当前段"
          @click="toggleFollow"
        >
          {{ follow ? '跟随中' : '跟随' }}
        </button>
        <button
          class="t-link t-mode-cycle"
          :class="{ on: viewMode !== 'raw' }"
          :title="viewModeTitle"
          @click="cycleViewMode"
        >
          {{ viewModeLabel }}
        </button>
        <!-- [B路·AI精修] 触发/进度/取消 -->
        <button
          v-if="aiLive.status === 'running' && aiLive.episodeId === episodeId"
          class="t-link danger"
          title="取消 AI 精修"
          @click="onAiCancel"
        >
          AI中 {{ aiPct }}% · 取消
        </button>
        <button
          v-else
          class="t-link"
          :title="
            aiKey
              ? 'AI 段内词汇精修（联网·发送本集文稿到 DeepSeek·约几分钱/集）'
              : '需先在设置填 DeepSeek API Key'
          "
          @click="onAiRefine"
        >
          {{ aiAvailable ? '重跑 AI' : 'AI 优化' }}
        </button>
        <button
          class="t-link"
          title="导出为 txt / srt 文件"
          :disabled="!segments.length"
          @click="onExport"
        >
          导出
        </button>
        <button
          class="t-link"
          :class="{ on: showDict }"
          title="管理本节目纠错词典"
          @click="showDict = !showDict"
        >
          词典{{ dictCount ? '·' + dictCount : '' }}
        </button>
        <button class="t-link" title="删除文字稿" @click="onDelete"
          >删除</button
        >
      </div>
    </div>

    <!-- loading -->
    <div v-if="mode === 'loading'" class="t-hint">
      <span class="t-spin"></span>读取文字稿状态…
    </div>

    <!-- 模型未部署：优雅引导，不报错不崩 -->
    <div v-else-if="mode === 'no-model'" class="t-guide">
      <div class="t-guide-title">
        {{
          platformSupported ? '尚未部署转录模型' : '当前平台暂不支持本地转录'
        }}
      </div>
      <div v-if="platformSupported" class="t-guide-body">
        本地转文字稿需要 SenseVoiceSmall
        模型。请先到设置页完成模型部署或选择本地模型目录。
      </div>
      <div v-else class="t-guide-body">
        PodPlayer 0.5.0 的本地转文字稿仅验证 Windows x64。
      </div>
      <button
        v-if="platformSupported"
        class="t-btn small"
        @click="goModelSettings"
      >
        去设置
      </button>
    </div>

    <!-- 未转录 -->
    <div v-else-if="mode === 'idle'" class="t-idle">
      <button class="t-btn" :disabled="!hasLocalFile" @click="onGenerate">
        生成文字稿
      </button>
      <span v-if="!hasLocalFile" class="t-note">下载本集后可生成文字稿</span>
      <span v-else class="t-note">在本地把本集音频转成带时间戳的文字稿</span>
    </div>

    <!-- 排队中 -->
    <div v-else-if="mode === 'queued'" class="t-hint">
      <span class="t-spin"></span>已排队，等待前一个转录任务完成…
      <button class="t-link" @click="onCancel">取消</button>
    </div>

    <!-- 转录中 -->
    <div v-else-if="mode === 'running'" class="t-running">
      <div class="t-prog-row">
        <div class="t-prog-track">
          <div class="t-prog-fill" :style="{ width: progressPct + '%' }"></div>
        </div>
        <span class="t-prog-pct">{{ progressLabel }}</span>
        <button class="t-link danger" @click="onCancel">取消</button>
      </div>
      <div class="t-running-sub">
        {{ runningSubLabel }}
      </div>
      <div v-if="live.lastText" class="t-ticker">{{ live.lastText }}</div>
    </div>

    <!-- 已完成 / 已暂停（都展示段列表） -->
    <template v-else-if="mode === 'done' || mode === 'paused'">
      <div v-if="mode === 'paused'" class="t-resume-banner">
        <span>已暂停（已转 {{ pausedSegCount }} 段），可继续。</span>
        <button class="t-btn small" @click="onGenerate">继续转录</button>
      </div>
      <!-- 选中错词 → 加入本节目纠错词典（即时重算、原文可回退） -->
      <div v-if="sel.show" class="t-fix-bar">
        <span class="t-fix-from">把「{{ sel.from }}」改为</span>
        <input
          ref="fixInput"
          v-model="sel.to"
          class="t-fix-input"
          placeholder="正确写法"
          @keyup.enter="addSelToDict"
        />
        <label
          class="t-fix-mode"
          title="勾选=连同近音变体一起归一(锚定)；不勾=只精确替换这个词"
        >
          <input
            type="checkbox"
            :checked="sel.mode === 'anchor'"
            @change="sel.mode = sel.mode === 'anchor' ? 'exact' : 'anchor'"
          />
          治近音
        </label>
        <button class="t-btn small" @click="addSelToDict">加入词典</button>
        <button class="t-link" @click="cancelSel">取消</button>
      </div>
      <!-- 词典管理：来源标记 + 删除（author/global 只读） -->
      <div v-if="showDict" class="t-dict">
        <div v-if="!dictRows.length" class="t-dict-empty">
          暂无词条。选中文稿里的错词即可加入；主播名(author)会自动加入。
        </div>
        <div v-for="row in dictRows" :key="row.id" class="t-dict-row">
          <span class="t-dict-tag" :class="'src-' + (row.source || 'manual')">{{
            srcLabel(row.source)
          }}</span>
          <span class="t-dict-body">
            <template v-if="row.mode === 'anchor'"
              >{{ row.to }} <i class="t-dict-mode">近音</i></template
            >
            <template v-else>{{ row.from }} → {{ row.to }}</template>
          </span>
          <button
            v-if="row.source !== 'author' && row.source !== 'global'"
            class="t-link"
            @click="removeDictRow(row)"
          >
            删
          </button>
          <span v-else class="t-dict-ro">只读</span>
        </div>
      </div>
      <div v-if="loadingSegs" class="t-hint">
        <span class="t-spin"></span>加载文稿…
      </div>
      <div v-else-if="!segments.length" class="t-hint"
        >（暂无可显示的段落）</div
      >
      <div v-else class="seg-box">
        <!-- 展开/收起：浮在文稿框右上角的小按钮(批注：缩小 + 放进框里) -->
        <button
          class="t-expand-float"
          :class="{ on: expanded }"
          :title="
            expanded ? '退出展开' : '展开为大窗口（保留导航/播放栏，非真全屏）'
          "
          @click="toggleExpand"
        >
          <svg-icon :icon-class="expanded ? 'fullscreen-exit' : 'fullscreen'" />
        </button>
        <div
          ref="list"
          class="seg-list"
          @scroll.passive="onListScroll"
          @wheel.passive="onUserScrollIntent"
          @pointerdown="onUserScrollIntent"
          @touchstart.passive="onUserScrollIntent"
          @mouseup="onSelectText"
        >
          <div class="seg-spacer" :style="{ height: topPad + 'px' }"></div>
          <template v-for="w in winRows">
            <!-- 段落块：组内各原始段作 span 连排；点任意句跳该句、当前句 inline 高亮 -->
            <div
              v-if="w.row.type === 'para'"
              :key="'p' + w.row.items[0].vi"
              :data-ri="w.ri"
              class="seg-row"
              :class="{ active: rowHasActive(w.row) }"
            >
              <span class="seg-time" @click="onSegClick(w.row.items[0].seg)">{{
                fmtClock(w.row.items[0].seg.start)
              }}</span>
              <span class="seg-text"
                ><span
                  v-for="it in w.row.items"
                  :key="it.vi"
                  class="seg-sent"
                  :class="{
                    active: it.vi === curIdx,
                    'ai-changed': showAi && aiChangedSet.has(it.vi),
                  }"
                  @click="onSegClick(it.seg)"
                  >{{ it.seg.display }}</span
                ></span
              >
            </div>
            <div v-else :key="'g' + w.ri" :data-ri="w.ri" class="seg-gap">
              {{ w.row.music ? '♪ 音乐' : '···' }}
              <span v-if="w.row.count > 1" class="seg-gap-n"
                >×{{ w.row.count }}</span
              >
            </div>
          </template>
          <div class="seg-spacer" :style="{ height: botPad + 'px' }"></div>
        </div>
      </div>
    </template>

    <!-- 失败 -->
    <div v-else-if="mode === 'error'" class="t-error">
      <span>生成文字稿失败{{ errorText ? '：' + errorText : '' }}</span>
      <button class="t-btn small" @click="onGenerate">重试</button>
    </div>
  </div>
</template>

<script>
import {
  transcribeState,
  getTranscript,
  getAsrStatus,
  readSegments,
  startTranscribe,
  cancelTranscribe,
  deleteTranscript,
  exportTranscriptText,
  getDictParts,
  listDict,
  addDictEntry,
  removeDictEntry,
  syncAuthorAnchors,
  startAiRefine,
  getAiRefine,
  deleteAiRefine,
  cancelAiRefine,
  aiRefineState,
  aiPromptVersion,
} from '@/utils/podcast/transcripts';
import { getDownload } from '@/utils/podcast/downloads';
import { getPodcast } from '@/utils/podcast/db';
import {
  postprocessSegments,
  groupParagraphs,
} from '@/utils/podcast/transcriptPostprocess';

export default {
  name: 'TranscriptPanel',
  props: {
    episode: { type: Object, default: null },
    episodeId: { type: String, default: '' },
  },
  data() {
    return {
      initializing: true,
      platformSupported: true,
      modelReady: false,
      hasLocalFile: false,
      dbRow: null,
      segments: [],
      loadingSegs: false,
      curIdx: -1,
      follow: true,
      queuedLocal: false,
      scrollPauseUntil: 0,
      // [性能·虚拟化] 变高窗口虚拟滚动：只渲染可视区±缓冲，DOM 节点数与文稿长度脱钩
      //   (根治几千段 content-visibility 节点常驻 → 滚动 layout 风暴致电脑级卡顿)
      winStart: 0,
      winEnd: 60,
      rowH: {}, // 行 key → 实测高(估高兜底)
      listWidth: 0,
      // [质量优化] 专名词典(exact 精确 + anchor 拼音锚定) + 原文切换 + 选中加词典 + 词典管理
      dictParts: { exact: [], anchors: [] },
      dictRows: [],
      showDict: false,
      // [三态] raw 原文 / opt 规则优化 / ai AI精修(在 opt 之上叠加段内词汇纠错)
      viewMode: 'opt',
      aiMap: {}, // {viewSegments下标: AI采纳后文本}
      aiChangedSet: new Set(), // 被 AI 改过的下标(打标记)
      expanded: false, // 文稿窗口展开为大窗口(夹在 navbar 与播放 bar 之间，非真全屏)
      sel: { show: false, from: '', to: '', mode: 'anchor' },
    };
  },
  computed: {
    // 引入实时态（Vue.observable）使其变化驱动本组件
    live() {
      return transcribeState;
    },
    isActiveTask() {
      return (
        this.live.episodeId === this.episodeId && this.live.status === 'running'
      );
    },
    // dbRow.status 归一化：'running' 但当前并无活动任务（app 重启中断）→ 视为可续 'paused'
    dbStatus() {
      const s = this.dbRow && this.dbRow.status;
      if (!s) return '';
      if (s === 'running' && !this.isActiveTask) return 'paused';
      return s;
    },
    mode() {
      if (this.initializing) return 'loading';
      if (!this.modelReady) return 'no-model';
      // 实时态优先（同集）：立即反映 running/done/error，避免完成瞬间闪一下"已暂停"
      if (this.live.episodeId === this.episodeId) {
        if (this.live.status === 'running') return 'running';
        if (this.live.status === 'done') return 'done';
        if (
          this.live.status === 'error' &&
          this.live.error !== 'model-missing'
        ) {
          return 'error';
        }
        // 'canceled' → 落到 dbStatus 的 paused
      }
      if (this.queuedLocal) return 'queued';
      const s = this.dbStatus;
      if (s === 'done') return 'done';
      if (s === 'paused') return 'paused';
      if (s === 'error') return 'error';
      return 'idle';
    },
    progressPct() {
      const t = this.live.totalSec || 0;
      if (!t) return this.live.phase === 'transcribing' ? 1 : 0;
      return Math.max(0, Math.min(99, (this.live.processedSec / t) * 100));
    },
    progressLabel() {
      if (this.live.phase && this.live.phase !== 'transcribing') {
        return this.live.phase === 'decoding' ? '准备中' : '加载中';
      }
      return Math.floor(this.progressPct) + '%';
    },
    runningSubLabel() {
      if (this.live.phase === 'decoding') return '正在准备音频…';
      if (this.live.phase === 'loading') return '正在载入模型…';
      const done = this.fmtClock(this.live.processedSec || 0);
      const total = this.fmtClock(this.live.totalSec || 0);
      const remain = this.estRemainLabel();
      return (
        '已转录 ' +
        (this.live.segCount || 0) +
        ' 段 · ' +
        done +
        ' / ' +
        total +
        (remain ? ' · 预计剩余 ' + remain : '')
      );
    },
    pausedSegCount() {
      return (this.dbRow && this.dbRow.segCount) || this.segments.length || 0;
    },
    errorText() {
      return (this.dbRow && this.dbRow.error) || this.live.error || '';
    },
    playerProgressSec() {
      const p = this.$store.state.player;
      return (p && p.progress) || 0;
    },
    playingThisEpisode() {
      const ct = this.$store.state.player.currentTrack;
      return !!(ct && ct.podcastEpisodeId === this.episodeId);
    },
    podcastId() {
      return String(this.episodeId || '').split('::')[0];
    },
    // [三态派生] showRaw=原文; showAi=AI精修态。showRaw 仍被各处读取(选词/导出)，改为 computed。
    showRaw() {
      return this.viewMode === 'raw';
    },
    showAi() {
      return this.viewMode === 'ai';
    },
    aiLive() {
      return aiRefineState;
    },
    aiPct() {
      const t = this.aiLive.total || 0;
      return t ? Math.min(99, Math.floor((this.aiLive.done / t) * 100)) : 0;
    },
    aiAvailable() {
      return this.aiMap && Object.keys(this.aiMap).length > 0;
    },
    viewModeLabel() {
      if (this.viewMode === 'raw') return '原文';
      if (this.viewMode === 'ai') return '已优化·AI';
      return '已优化';
    },
    viewModeTitle() {
      return this.aiAvailable
        ? '点击切换：已优化 / AI 精修 / 原文'
        : '点击切换：已优化 / 原文';
    },
    estCharsPerLine() {
      const w = this.listWidth || 760;
      const textW = Math.max(240, w - 100);
      return Math.max(24, Math.floor(textW / 15));
    },
    aiKey() {
      const s = this.$store.state.settings;
      return !!(s && s.deepseekKey && String(s.deepseekKey).trim());
    },
    // 处理后的段（事件分类 + 专名词典替换）；原文=原样；AI 态在 opt 之上叠加段内词汇纠错。
    //   词典/viewMode/aiMap 变 → computed 自动重算 → 即时生效、可回退。原始 segments 永不改。
    viewSegments() {
      if (this.showRaw) {
        return this.segments.map(s =>
          Object.assign({}, s, { kind: 'speech', display: s.text })
        );
      }
      const vs = postprocessSegments(this.segments, {
        dict: this.dictParts.exact,
        anchors: this.dictParts.anchors,
        mainLang: 'zh',
      });
      if (this.showAi && this.aiMap) {
        // AI 层：仅 speech 段、仅有 AI 结果的下标，用采纳后文本覆盖(段边界/数/时间戳全不动)
        return vs.map((s, i) => {
          if (s.kind === 'speech' && this.aiMap[i] != null) {
            return Object.assign({}, s, { display: this.aiMap[i] });
          }
          return s;
        });
      }
      return vs;
    },
    // [D·段落重组] 段落块(组内多段连排) + noise/music 折叠占位块。
    //   段落聚合只在"已优化/AI"态固定启用；原文态 → 每段独立(块结构一致，统一渲染)。
    //   组内每段保留 {vi,seg}（vi=viewSegments 下标）→ 点读/高亮粒度不降。
    rows() {
      return groupParagraphs(this.viewSegments, {
        enabled: !this.showRaw,
        gapSec: 1.0,
        maxLen: 100,
      });
    },
    // [性能·虚拟化] 行高(实测优先,否则估高) → 前缀和 offsets → 可视窗口 + 上下占位高
    offsets() {
      const rws = this.rows;
      const arr = new Array(rws.length + 1);
      arr[0] = 0;
      for (let i = 0; i < rws.length; i++) {
        const k = this.rowKey(rws[i], i);
        const h = this.rowH[k] || this.estRowH(rws[i]);
        arr[i + 1] = arr[i] + h;
      }
      return arr;
    },
    totalH() {
      const o = this.offsets;
      return o[o.length - 1] || 0;
    },
    winRows() {
      const out = [];
      const end = Math.min(this.winEnd, this.rows.length);
      for (let i = this.winStart; i < end; i++) {
        out.push({ row: this.rows[i], ri: i });
      }
      return out;
    },
    topPad() {
      return this.offsets[Math.min(this.winStart, this.rows.length)] || 0;
    },
    botPad() {
      const endOff =
        this.offsets[Math.min(this.winEnd, this.rows.length)] || this.totalH;
      return Math.max(0, this.totalH - endOff);
    },
    // vi → 所在块下标（段落内每段都映到同一块 → 高亮/跟随定位到该段落）
    viToRowIndex() {
      const map = {};
      const rws = this.rows;
      for (let i = 0; i < rws.length; i++) {
        const r = rws[i];
        if (r.type === 'para') {
          for (let j = 0; j < r.items.length; j++) map[r.items[j].vi] = i;
        }
      }
      return map;
    },
    dictCount() {
      return (this.dictRows && this.dictRows.length) || 0;
    },
  },
  watch: {
    episodeId() {
      this.init();
    },
    // [性能·虚拟化] 行集变化(切集 / 词典 / 原文切换) → 重置窗口并重算
    rows() {
      this.resetWindow();
    },
    // 实时态完成/失败/取消 → 重载 Dexie 行与段列表，切到对应终态
    'live.status'(s) {
      if (this.live.episodeId !== this.episodeId) return;
      if (s === 'done') {
        this.queuedLocal = false;
        this.afterFinish();
      } else if (s === 'error') {
        this.queuedLocal = false;
        this.reloadRow();
      } else if (s === 'canceled') {
        this.queuedLocal = false;
        this.reloadRow().then(() => this.maybeLoadSegments());
      } else if (s === 'running') {
        this.queuedLocal = false;
      }
    },
    // 播放位置变化 → 高亮跟随（仅当展示完成文稿且正在播放本集）
    playerProgressSec() {
      this.updateHighlight();
    },
    playingThisEpisode() {
      this.updateHighlight();
    },
    mode(m) {
      if (m === 'done' || m === 'paused') this.maybeLoadSegments();
    },
  },
  mounted() {
    this.init();
    // 展开态按 Esc 退出
    this._onEsc = e => {
      if (e.key === 'Escape' && this.expanded) {
        this.expanded = false;
        this.$nextTick(() => this.recalcWindow());
      }
    };
    window.addEventListener('keydown', this._onEsc);
    this.$nextTick(() => this.setupListResizeObserver());
  },
  beforeDestroy() {
    this._initReq = (this._initReq || 0) + 1;
    this._segmentsReq = (this._segmentsReq || 0) + 1;
    this._rowReq = (this._rowReq || 0) + 1;
    if (this._onEsc) window.removeEventListener('keydown', this._onEsc);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._resizeObservedEl = null;
    if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);
    if (this._resizeRAF) cancelAnimationFrame(this._resizeRAF);
    if (this._measureTimer) clearTimeout(this._measureTimer);
  },
  methods: {
    // 文稿窗口展开/收起为大窗口(夹在 navbar 与播放 bar 之间，非真全屏)；
    //   尺寸变 → 虚拟滚动按新 clientHeight 重算窗口。
    toggleExpand() {
      this.expanded = !this.expanded;
      this.$nextTick(() => this.recalcWindow());
    },
    setupListResizeObserver() {
      const list = this.$refs.list;
      if (!list || typeof ResizeObserver === 'undefined') return;
      this.listWidth = list.clientWidth || 0;
      if (this._resizeObserver) this._resizeObserver.disconnect();
      this._resizeObservedEl = list;
      this._resizeObserver = new ResizeObserver(entries => {
        const entry = entries && entries[0];
        const rect = entry && entry.contentRect;
        const w = rect ? rect.width : list.clientWidth;
        if (!w || Math.abs(w - this.listWidth) < 2) return;
        this.listWidth = w;
        if (this._resizeRAF) cancelAnimationFrame(this._resizeRAF);
        this._resizeRAF = requestAnimationFrame(() => {
          this._resizeRAF = null;
          this.rowH = {};
          this.recalcWindow();
        });
      });
      this._resizeObserver.observe(list);
    },
    cycleViewMode() {
      const modes = this.aiAvailable ? ['opt', 'ai', 'raw'] : ['opt', 'raw'];
      const idx = modes.indexOf(this.viewMode);
      this.viewMode = modes[(idx + 1) % modes.length] || 'opt';
    },
    scrollPageTop() {
      const root = this.$el;
      const scroller = root && root.closest && root.closest('main');
      if (scroller) {
        scroller.scrollTop = 0;
      }
    },
    async init() {
      const reqId = (this._initReq || 0) + 1;
      this._initReq = reqId;
      this._segmentsReq = (this._segmentsReq || 0) + 1;
      const episodeId = this.episodeId;
      this.initializing = true;
      this.queuedLocal = false;
      this.segments = [];
      this.loadingSegs = false;
      this.curIdx = -1;
      this.viewMode = 'opt'; // [三态] 切集回到"已优化"
      this.aiMap = {};
      this.aiChangedSet = new Set();
      if (!episodeId) {
        this.modelReady = false;
        this.hasLocalFile = false;
        this.dbRow = null;
        this.initializing = false;
        return;
      }
      let st = null;
      try {
        st = await getAsrStatus(episodeId);
      } catch (e) {
        st = null;
      }
      if (reqId !== this._initReq || episodeId !== this.episodeId) return;
      this.modelReady = !!(st && st.modelReady);
      this.platformSupported = !st || st.platformSupported !== false;
      if (st && st.isThisQueued) this.queuedLocal = true;
      // 本地音频是否存在（已下载/已缓存）→ 决定能否生成
      const hasLocalFile = await this.checkLocalFile(episodeId);
      if (reqId !== this._initReq || episodeId !== this.episodeId) return;
      const dbRow = await getTranscript(episodeId).catch(() => null);
      if (reqId !== this._initReq || episodeId !== this.episodeId) return;
      this.hasLocalFile = hasLocalFile;
      this.dbRow = dbRow;
      this.initializing = false;
      if (this.mode === 'done' || this.mode === 'paused') {
        await this.maybeLoadSegments();
      }
    },
    async checkLocalFile(episodeId) {
      try {
        const row = await getDownload(episodeId);
        if (row && row.filePath) return true;
      } catch (e) {
        /* ignore */
      }
      const pm =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.pathMap) ||
        {};
      return !!pm[episodeId];
    },
    async reloadRow() {
      const reqId = (this._rowReq || 0) + 1;
      this._rowReq = reqId;
      const episodeId = this.episodeId;
      const row = await getTranscript(episodeId).catch(() => null);
      if (reqId !== this._rowReq || episodeId !== this.episodeId) return null;
      this.dbRow = row;
      return row;
    },
    async afterFinish() {
      await this.reloadRow();
      await this.loadSegments();
      this.$nextTick(() => this.updateHighlight());
    },
    async maybeLoadSegments() {
      if (this.segments.length || this.loadingSegs) return;
      await this.loadSegments();
    },
    async loadSegments() {
      const reqId = (this._segmentsReq || 0) + 1;
      this._segmentsReq = reqId;
      const episodeId = this.episodeId;
      this.loadingSegs = true;
      let segments = [];
      try {
        const res = await readSegments(episodeId);
        if (res && res.ok && Array.isArray(res.segments)) {
          // 只展示有文本的段（VAD 偶有空段）；兜底按 start 升序（worker 已升序写）
          segments = res.segments
            .filter(s => s && s.text && String(s.text).trim().length)
            .sort((a, b) => (a.start || 0) - (b.start || 0));
        }
      } catch (e) {
        segments = [];
      }
      if (reqId !== this._segmentsReq || episodeId !== this.episodeId) return;
      this.segments = segments;
      this.loadingSegs = false;
      await this.loadDict(reqId, episodeId);
      if (reqId !== this._segmentsReq || episodeId !== this.episodeId) return;
      await this.loadAiRefine(reqId, episodeId, segments.length); // [B路·AI] 载入已缓存的 AI 精修层(若有)
      if (reqId !== this._segmentsReq || episodeId !== this.episodeId) return;
      this.$nextTick(() => this.updateHighlight());
    },
    // [B路·AI] 载入该集已缓存的 AI 精修(同 promptVer 才用，否则视为无)
    async loadAiRefine(reqId, episodeId, segmentCount) {
      episodeId = episodeId || this.episodeId;
      segmentCount =
        typeof segmentCount === 'number' ? segmentCount : this.segments.length;
      try {
        const row = await getAiRefine(episodeId);
        if (
          episodeId !== this.episodeId ||
          (reqId && reqId !== this._segmentsReq)
        )
          return;
        // 同 promptVer 且段数未变(续转会追加段→下标平移)才用缓存，否则视为陈旧丢弃
        if (
          row &&
          row.promptVer === aiPromptVersion &&
          row.segs &&
          (!row.segCount || row.segCount === segmentCount)
        ) {
          this.aiMap = row.segs;
          this.aiChangedSet = new Set(row.changedIdx || []);
          return;
        }
      } catch (e) {
        /* ignore */
      }
      if (
        episodeId !== this.episodeId ||
        (reqId && reqId !== this._segmentsReq)
      )
        return;
      this.aiMap = {};
      this.aiChangedSet = new Set();
    },
    // [B路·AI] 触发 AI 段内词汇精修：取"已优化"态的 speech 段送 DeepSeek，完成后切 AI 态
    async onAiRefine() {
      const episodeId = this.episodeId;
      const podcastId = this.podcastId;
      const segmentCount = this.segments.length;
      if (!this.aiKey) {
        this.$store.dispatch(
          'showToast',
          '请先在「设置」里填入 DeepSeek API Key'
        );
        if (this.$router) this.$router.push('/settings').catch(() => {});
        return;
      }
      const opt = postprocessSegments(this.segments, {
        dict: this.dictParts.exact,
        anchors: this.dictParts.anchors,
        mainLang: 'zh',
      });
      const speech = [];
      for (let i = 0; i < opt.length; i++) {
        if (opt[i].kind === 'speech')
          speech.push({ idx: i, text: opt[i].display });
      }
      if (!speech.length) return;
      const anchors = (this.dictParts.anchors || [])
        .map(a => a.to)
        .filter(Boolean);
      // 「重跑 AI」(已有完整缓存=覆盖全部 speech 段)→ 清旧缓存重算(吸收词典变更)；
      //   部分缓存(取消后)→ 保留续跑。
      const complete =
        this.aiAvailable && Object.keys(this.aiMap).length >= speech.length;
      if (complete) {
        await deleteAiRefine(episodeId);
        if (episodeId !== this.episodeId) return;
        this.aiMap = {};
        this.aiChangedSet = new Set();
      }
      const res = await startAiRefine(
        episodeId,
        podcastId,
        speech,
        anchors,
        segmentCount
      );
      if (episodeId !== this.episodeId) return;
      if (res && res.ok) {
        await this.loadAiRefine();
        this.viewMode = 'ai';
        this.$nextTick(() => this.updateHighlight());
      }
    },
    onAiCancel() {
      cancelAiRefine(this.episodeId);
    },
    async loadDict(reqId, episodeId) {
      episodeId = episodeId || this.episodeId;
      const podcastId = String(episodeId || '').split('::')[0];
      // A2: 先按 podcast.author 同步该节目的 author 来源 anchor（自动种主播名）
      try {
        const pod = await getPodcast(podcastId);
        if (
          episodeId !== this.episodeId ||
          (reqId && reqId !== this._segmentsReq)
        )
          return;
        await syncAuthorAnchors(podcastId, (pod && pod.author) || '');
      } catch (e) {
        /* ignore */
      }
      if (
        episodeId !== this.episodeId ||
        (reqId && reqId !== this._segmentsReq)
      )
        return;
      try {
        const dictParts = await getDictParts(podcastId);
        if (
          episodeId !== this.episodeId ||
          (reqId && reqId !== this._segmentsReq)
        )
          return;
        this.dictParts = dictParts;
      } catch (e) {
        if (
          episodeId !== this.episodeId ||
          (reqId && reqId !== this._segmentsReq)
        )
          return;
        this.dictParts = { exact: [], anchors: [] };
      }
      try {
        const dictRows = await listDict(podcastId);
        if (
          episodeId !== this.episodeId ||
          (reqId && reqId !== this._segmentsReq)
        )
          return;
        this.dictRows = dictRows;
      } catch (e) {
        if (
          episodeId !== this.episodeId ||
          (reqId && reqId !== this._segmentsReq)
        )
          return;
        this.dictRows = [];
      }
    },
    // 在文稿里选中错词 → 弹纠错条（只接受词级短选择，避免整段）；默认 anchor 治同音
    onSelectText() {
      if (this.showRaw) return; // 原文模式不提供加词典
      let txt = '';
      try {
        txt = (window.getSelection && window.getSelection().toString()) || '';
      } catch (e) {
        txt = '';
      }
      txt = txt.trim();
      if (txt && txt.length <= 20) {
        this.sel = { show: true, from: txt, to: '', mode: 'anchor' };
        // [修 bug] 选词弹条后把焦点直接送进输入框：选中文稿里的词时，文档里那个词仍处于
        //   "选中高亮"态，此时点击输入框首击常只是 collapse 旧选区、焦点落不进 → 表现为
        //   "正确写法点不动/打不了字"。自动聚焦既根治此问题、也更顺手(选完直接打字)。
        this.$nextTick(() => {
          const el = this.$refs.fixInput;
          if (el && el.focus) el.focus();
        });
      }
    },
    cancelSel() {
      this.sel = { show: false, from: '', to: '', mode: 'anchor' };
    },
    async addSelToDict() {
      const from = (this.sel.from || '').trim();
      const to = (this.sel.to || '').trim();
      if (!to) return;
      const mode = this.sel.mode === 'exact' ? 'exact' : 'anchor';
      const res = await addDictEntry({
        scope: 'podcast',
        podcastId: this.podcastId,
        from: from,
        to: to,
        mode: mode,
        source: 'manual',
      });
      if (res && res.ok) {
        await this.loadDict(); // 词典变 → viewSegments computed 自动重算、即时生效
        this.cancelSel();
        this.$store.dispatch(
          'showToast',
          mode === 'anchor'
            ? '已加入(锚定近音)：' + to
            : '已加入：' + from + ' → ' + to
        );
      } else {
        this.$store.dispatch(
          'showToast',
          '加入失败：' + ((res && res.error) || '')
        );
      }
    },
    async removeDictRow(row) {
      if (!row || !row.id) return;
      if (row.source === 'author' || row.source === 'global') return; // 自动/全局只读
      await removeDictEntry(row.id);
      await this.loadDict();
    },
    srcLabel(source) {
      if (source === 'author') return '主播';
      if (source === 'global') return '全局';
      return '手动';
    },
    onGenerate() {
      if (!this.episode) return;
      this.queuedLocal = false;
      startTranscribe(this.episode).then(res => {
        if (res && res.ok && res.queued) this.queuedLocal = true;
      });
    },
    goModelSettings() {
      if (this.$router) this.$router.push('/settings').catch(() => {});
    },
    onCancel() {
      cancelTranscribe(this.episodeId);
      this.queuedLocal = false;
    },
    async onDelete() {
      const ok =
        typeof window.confirm !== 'function' ||
        window.confirm('确定删除本集文字稿？（可重新生成）');
      if (!ok) return;
      const res = await deleteTranscript(this.episodeId);
      if (!res || !res.ok) {
        this.$store.dispatch(
          'showToast',
          '删除失败：' + ((res && res.error) || 'unknown')
        );
        return;
      }
      this.dbRow = null;
      this.segments = [];
      this.curIdx = -1;
      this.$store.dispatch('showToast', '已删除文字稿');
    },
    onSegClick(seg) {
      if (!seg) return;
      // 选中文字(加词典)时不误触跳播（双击选词会同时触发 click）
      try {
        const s = window.getSelection && window.getSelection().toString();
        if (s && s.trim()) return;
      } catch (e) {
        /* ignore */
      }
      this.$emit('seek', seg.start || 0);
    },
    // 导出文稿为文件（另存为 txt/srt）
    async onExport() {
      if (!this.segments.length) return;
      const name =
        (this.episode && this.episode.title) ||
        (this.dbRow && this.dbRow.id) ||
        'transcript';
      const c = this.buildExportContent();
      const res = await exportTranscriptText(
        this.episodeId,
        name,
        c.txt,
        c.srt
      );
      if (res && res.ok) {
        this.$store.dispatch('showToast', '已导出到 ' + res.path);
      } else if (res && res.canceled) {
        // 用户取消，不提示
      } else {
        this.$store.dispatch(
          'showToast',
          '导出失败：' + ((res && res.error) || '')
        );
      }
    },
    // 按当前「原文/已优化」模式生成导出内容（txt + srt）；优化态跳过噪声/音乐段
    buildExportContent() {
      let segs;
      if (this.showRaw) {
        segs = this.segments.map(s => ({
          start: s.start,
          end: s.end,
          text: s.text || '',
        }));
      } else {
        segs = this.viewSegments
          .filter(s => s.kind === 'speech')
          .map(s => ({ start: s.start, end: s.end, text: s.display || '' }));
      }
      segs = segs.filter(s => s.text && String(s.text).trim());
      const txt = segs.map(s => s.text).join('\n');
      const srt = segs
        .map(
          (s, i) =>
            i +
            1 +
            '\n' +
            this.fmtSrtTime(s.start) +
            ' --> ' +
            this.fmtSrtTime(s.end) +
            '\n' +
            s.text +
            '\n'
        )
        .join('\n');
      return { txt: txt, srt: srt };
    },
    fmtSrtTime(t) {
      const ms = Math.floor((t || 0) * 1000);
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      const mm = ms % 1000;
      const p = (n, w) => String(n).padStart(w, '0');
      return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(mm, 3);
    },
    toggleFollow() {
      this.follow = !this.follow;
      if (this.follow) this.scrollToCurrent();
    },
    onUserScrollIntent() {
      this.scrollPauseUntil = Date.now() + 2500;
    },
    onListScroll() {
      this._lastListScrollAt = Date.now();
      if (this._scrollRAF) return;
      this._scrollRAF = requestAnimationFrame(() => {
        this._scrollRAF = null;
        this.recalcWindow();
      });
    },
    scheduleMeasureVisible(delay) {
      if (this._measureTimer) clearTimeout(this._measureTimer);
      this._measureTimer = setTimeout(
        () => {
          this._measureTimer = null;
          const quietFor = Date.now() - (this._lastListScrollAt || 0);
          if (quietFor < 140) {
            this.scheduleMeasureVisible(140 - quietFor);
            return;
          }
          this.measureVisible();
        },
        delay == null ? 160 : delay
      );
    },
    estRowH(row) {
      if (!row || row.type === 'gap') return 30;
      let len = 0;
      const items = row.items || [];
      for (let i = 0; i < items.length; i++) {
        const d = items[i].seg && items[i].seg.display;
        if (d) len += Array.from(d).length;
      }
      const lines = Math.max(1, Math.ceil(len / this.estCharsPerLine));
      return 16 + lines * 23; // 估高：padding + 行数 × 行高
    },
    rowKey(row, i) {
      return row.type === 'para' ? 'p' + row.items[0].vi : 'g' + i;
    },
    // 段落块是否含当前播放段(用于整段轻底色提示，当前句另在 span 上高亮)
    rowHasActive(row) {
      if (!row || row.type !== 'para') return false;
      const items = row.items;
      for (let i = 0; i < items.length; i++) {
        if (items[i].vi === this.curIdx) return true;
      }
      return false;
    },
    // 按当前 scrollTop 二分 offsets 算可视窗口 [winStart,winEnd)（含缓冲）
    recalcWindow() {
      const list = this.$refs.list;
      if (!list) return;
      if (this._resizeObservedEl !== list) this.setupListResizeObserver();
      const nextWidth = list.clientWidth || 0;
      if (Math.abs(nextWidth - this.listWidth) >= 2) {
        this.listWidth = nextWidth;
        this.rowH = {};
      }
      const top = list.scrollTop;
      const viewH = list.clientHeight || 400;
      const off = this.offsets;
      const n = this.rows.length;
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
      const BUF = 6;
      const nextStart = Math.max(0, start - BUF);
      const nextEnd = Math.min(n, end + BUF);
      const changed = nextStart !== this.winStart || nextEnd !== this.winEnd;
      this.winStart = nextStart;
      this.winEnd = nextEnd;
      if (changed) this.scheduleMeasureVisible(160);
    },
    // 实测当前渲染行真实高度 → 更新 rowH（只测可视区，故只影响下方 offset，视口不跳）
    measureVisible() {
      this.$nextTick(() => {
        const list = this.$refs.list;
        if (!list) return;
        const els = list.querySelectorAll('[data-ri]');
        const updates = {};
        let changed = false;
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          const ri = parseInt(el.getAttribute('data-ri'), 10);
          if (isNaN(ri) || !this.rows[ri]) continue;
          const k = this.rowKey(this.rows[ri], ri);
          // [性能·丝滑滚动] 已测过的行跳过——不再读 offsetHeight。读 offsetHeight 强制同步重排,
          //   原来每个滚动帧对所有可视行都读=layout thrash(滚动不如原生丝滑的主因)。行集变
          //   (原文/优化视图、切集、词典、宽度变化)时 resetWindow 已清缓存,故按 rowKey 测一次即可。
          if (this.rowH[k] != null) continue;
          const h = el.offsetHeight;
          if (h && this.rowH[k] !== h) {
            updates[k] = h;
            changed = true;
          }
        }
        if (changed) this.rowH = Object.assign({}, this.rowH, updates);
      });
    },
    resetWindow() {
      // 行集结构变化(原文切换、切集、词典、宽度变化) → 同一 rowKey 的高度可能完全不同；
      //   必须清实测缓存，否则残留旧高 → 离屏 spacer 算错、滚动条跳。
      this.rowH = {};
      this.winStart = 0;
      this.winEnd = 60;
      this.$nextTick(() => {
        this.recalcWindow();
        this.measureVisible();
      });
    },
    updateHighlight() {
      if (this.mode !== 'done' && this.mode !== 'paused') return;
      if (!this.playingThisEpisode || !this.segments.length) {
        return;
      }
      const sec = this.playerProgressSec;
      const idx = this.findSegIndex(sec);
      if (idx !== this.curIdx) {
        this.curIdx = idx;
        if (this.follow) this.scrollToCurrent();
      }
    },
    // 最后一个 start <= sec 的段；若落在被折叠的 noise/music 段，回退到最近的上一句 speech。
    //   (curIdx 必须落在 speech 段才有 viToRowIndex 映射、才能高亮+跟随；否则经过噪声/音乐间隙时高亮会消失)
    findSegIndex(sec) {
      const vs = this.viewSegments;
      let lo = 0;
      let hi = vs.length - 1;
      let pos = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((vs[mid].start || 0) <= sec) {
          pos = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      for (let i = pos; i >= 0; i--) {
        if (vs[i].kind === 'speech') return i;
      }
      return -1;
    },
    scrollToCurrent() {
      if (this.curIdx < 0) return;
      if (Date.now() < this.scrollPauseUntil) return;
      const ri = this.viToRowIndex[this.curIdx];
      if (ri === undefined) return;
      const list = this.$refs.list;
      if (!list) return;
      const viewH = list.clientHeight || 400;
      const top = this.offsets[ri] || 0;
      const rowH = (this.offsets[ri + 1] || top) - top;
      // ① 段落块整体不在视口 → 按 offset 直接定位带入（虚拟化下不用 scrollIntoView 触发全列表
      //    layout；也保证该块内的句 span 被渲染出来，供 ② 细化定位）
      const cur = list.scrollTop;
      const blockVisible = top >= cur && top + rowH <= cur + viewH;
      if (!blockVisible) {
        this._progScrollUntil = Date.now() + 150;
        list.scrollTop = Math.max(0, top - viewH * 0.4);
        this.recalcWindow();
      }
      // ② 段内细粒度：段落聚合后一块含多句，锚到整段顶会让"超视口长段落"每跳一句把当前句
      //    顶出视口；故细化到当前句 span，仅当它不在视口时才滚。
      this.$nextTick(() => {
        const el = list.querySelector && list.querySelector('.seg-sent.active');
        if (!el) return;
        const lr = list.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        const elTop = er.top - lr.top + list.scrollTop;
        const elBot = elTop + er.height;
        const c = list.scrollTop;
        if (elTop < c + 8 || elBot > c + viewH - 8) {
          this._progScrollUntil = Date.now() + 150;
          list.scrollTop = Math.max(0, elTop - viewH * 0.4);
          this.recalcWindow();
        }
      });
    },
    estRemainLabel() {
      const t = this.live.totalSec || 0;
      const done = this.live.processedSec || 0;
      if (!t || done <= 0) return '';
      // 经验：int8 RTF≈0.033，即处理 1s 音频约耗 0.033s
      const remainAudio = Math.max(0, t - done);
      const remainSec = Math.round(remainAudio * 0.04 + 1);
      return this.fmtClock(remainSec);
    },
    fmtClock(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      const ss = String(s).padStart(2, '0');
      if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + ss;
      return m + ':' + ss;
    },
  },
};
</script>

<style lang="scss" scoped>
.transcript-section {
  margin-top: 40px;
  padding-bottom: 24px;
  color: var(--color-text);
}
// [展开] 文稿大窗口：夹在 navbar(顶 64) 与播放 bar(底 64) 之间，z-index 99(低于二者 100)→
//   导航/播放栏仍在仍可用；非真全屏。flex 列让段列表填满高度。
.transcript-section.expanded {
  position: fixed;
  top: 64px;
  bottom: 64px;
  left: 0;
  right: 0;
  z-index: 99;
  margin: 0;
  // [批注①] 标题原来贴着 navbar「撞墙」→ 加大顶距，整块往下移、留呼吸
  padding: clamp(22px, 3.4vh, 46px) clamp(24px, 4vw, 64px) 16px;
  background: var(--color-body-bg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  // [批注②] 展开态文稿框撑满高度：seg-box flex 列 → seg-list 填满
  .seg-box {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .seg-list {
    max-height: none;
    flex: 1 1 auto;
    min-height: 0;
  }
}
// [批注②] 文稿框定位上下文，承载右上角浮动展开按钮
.seg-box {
  position: relative;
}
// [批注②] 展开/收起按钮：缩小 + 浮在文稿框右上角(原在工具栏末尾、太大又撞墙)
.t-expand-float {
  position: absolute;
  top: 8px;
  right: 12px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--color-secondary-bg-for-transparent);
  color: var(--color-text);
  opacity: 0.5;
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s;
  &:hover {
    opacity: 1;
    background: var(--color-secondary-bg);
  }
  &.on {
    opacity: 0.85;
  }
  .svg-icon {
    width: 14px;
    height: 14px;
  }
}
.transcript-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  h2 {
    font-size: 18px;
    font-weight: 700;
    margin: 0;
  }
  .t-actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px 10px;
    max-width: min(760px, 70vw);
  }
}
.t-link {
  background: transparent;
  color: var(--color-text);
  opacity: 0.55;
  font-size: 13px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    opacity: 1;
  }
  &.on {
    opacity: 1;
    color: var(--color-primary);
  }
  &.danger:hover {
    color: #e74c3c;
  }
  &.t-mode-cycle {
    min-width: 72px;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--color-secondary-bg-for-transparent);
    opacity: 0.78;
  }
  &.t-top-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    .svg-icon {
      width: 13px;
      height: 13px;
    }
  }
}
.t-btn {
  background: var(--color-primary);
  color: #fff;
  padding: 8px 16px;
  border-radius: var(--radius-button);
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  transition: transform 0.15s, opacity 0.15s;
  &:hover:not(:disabled) {
    transform: scale(1.04);
  }
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  &.small {
    padding: 6px 12px;
    font-size: 12px;
  }
}
.t-idle {
  display: flex;
  align-items: center;
  gap: 14px;
  .t-note {
    font-size: 13px;
    opacity: 0.55;
  }
}
.t-hint {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  opacity: 0.65;
  padding: 6px 0;
}
.t-guide {
  background: var(--color-secondary-bg-for-transparent);
  border-radius: 12px;
  padding: 16px 18px;
  .t-guide-title {
    font-weight: 700;
    font-size: 14px;
    margin-bottom: 6px;
  }
  .t-guide-body {
    font-size: 13px;
    line-height: 1.6;
    opacity: 0.7;
  }
}
.t-running {
  .t-prog-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .t-prog-track {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: var(--color-secondary-bg);
    overflow: hidden;
  }
  .t-prog-fill {
    height: 100%;
    background: var(--color-primary);
    border-radius: 3px;
    transition: width 0.3s ease-out;
  }
  .t-prog-pct {
    font-size: 13px;
    font-weight: 700;
    min-width: 38px;
    text-align: right;
  }
  .t-running-sub {
    font-size: 12px;
    opacity: 0.6;
    margin-top: 8px;
  }
  .t-ticker {
    margin-top: 8px;
    font-size: 13px;
    opacity: 0.85;
    line-height: 1.6;
    max-height: 2.6em;
    overflow: hidden;
    color: var(--color-primary);
  }
}
.t-resume-banner {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 13px;
  opacity: 0.85;
  margin-bottom: 12px;
}
.seg-list {
  max-height: 56vh;
  overflow-y: auto;
  border-radius: 12px;
  background: var(--color-secondary-bg-for-transparent);
  padding: 6px 4px;
  contain: layout paint;
  scrollbar-width: none;
  -ms-overflow-style: none;
  // 内层文稿框只保留滚轮/触控滚动，不显示额外滚动条，避免右侧出现无语义竖线。
  &::-webkit-scrollbar {
    width: 0;
    height: 0;
  }
}
.seg-row {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  transition: background 0.12s;
  // [性能·虚拟化] 改用 JS 窗口虚拟化(只渲染可视区±缓冲)，不再用 content-visibility——
  //   后者节点全常驻、变高估算不准，滚动时几千节点 layout 风暴致电脑级卡顿(已实测)。
  &:hover {
    background: var(--color-secondary-bg);
  }
  // [D·段落重组] 当前播放段落整段轻底色；具体当前句另在 .seg-sent.active 上高亮
  &.active {
    background: var(--color-primary-bg-for-transparent);
  }
}
.seg-spacer {
  width: 100%;
  pointer-events: none;
}
.seg-time {
  flex-shrink: 0;
  font-size: 12px;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
  padding-top: 2px;
  min-width: 48px;
  cursor: pointer;
  transition: opacity 0.12s;
  &:hover {
    opacity: 0.9;
  }
}
.seg-text {
  font-size: 14px;
  line-height: 1.6;
}
// [D·段落重组] 段落内每个原始段=一个可点读句子；当前句 inline 高亮
.seg-sent {
  cursor: pointer;
  transition: color 0.12s;
  &:hover {
    color: var(--color-primary);
  }
  &.active {
    color: var(--color-primary);
    text-shadow: 0 0 0 currentColor;
  }
  // [B路·AI] 被 AI 精修改过的句：轻微虚线下划线，便于核对(不抢眼)
  &.ai-changed {
    border-bottom: 1px dashed var(--color-primary);
  }
}
// 折叠的噪声/音乐段占位（不可点读、弱化）
.seg-gap {
  padding: 4px 12px 4px 60px;
  font-size: 12px;
  opacity: 0.38;
  user-select: none;
  .seg-gap-n {
    margin-left: 4px;
  }
}
// 选中错词 → 加入纠错词典 的浮条
.t-fix-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--color-primary-bg-for-transparent);
  font-size: 13px;
  .t-fix-from {
    opacity: 0.85;
  }
}
.t-fix-input {
  flex: 0 1 160px;
  background: var(--color-secondary-bg);
  border: none;
  border-radius: 6px;
  padding: 5px 9px;
  color: var(--color-text);
  font-size: 13px;
  outline: none;
}
.t-fix-mode {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  opacity: 0.75;
  cursor: pointer;
}
// 词典管理列表
.t-dict {
  margin-bottom: 12px;
  max-height: 200px;
  overflow-y: auto;
  border-radius: 10px;
  background: var(--color-secondary-bg-for-transparent);
  padding: 6px 8px;
}
.t-dict-empty {
  font-size: 12px;
  opacity: 0.55;
  padding: 8px 6px;
}
.t-dict-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  font-size: 13px;
}
.t-dict-tag {
  flex-shrink: 0;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--color-secondary-bg);
  opacity: 0.9;
  &.src-author {
    color: #1db954;
  }
  &.src-global {
    color: #e0a800;
  }
}
.t-dict-body {
  flex: 1;
}
.t-dict-mode {
  font-style: normal;
  font-size: 11px;
  opacity: 0.5;
  margin-left: 2px;
}
.t-dict-ro {
  font-size: 11px;
  opacity: 0.4;
}
.t-error {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 14px;
  color: #e74c3c;
}
.t-spin {
  width: 14px;
  height: 14px;
  border: 2px solid var(--color-text);
  border-top-color: transparent;
  border-radius: 50%;
  opacity: 0.6;
  animation: t-spin 0.7s linear infinite;
  display: inline-block;
}
@keyframes t-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
