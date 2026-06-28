<template>
  <div class="transcript-section">
    <div class="transcript-header">
      <h2>AI 文字稿</h2>
      <div v-if="mode === 'done' || mode === 'paused'" class="t-actions">
        <button
          class="t-link"
          :class="{ on: follow }"
          title="播放时自动高亮并滚动到当前段"
          @click="toggleFollow"
        >
          {{ follow ? '跟随中' : '跟随' }}
        </button>
        <button
          class="t-link"
          :class="{ on: !showRaw }"
          :title="
            showRaw
              ? '当前显示原始转录'
              : '已应用事件过滤 + 专名词典（点击看原文）'
          "
          @click="showRaw = !showRaw"
        >
          {{ showRaw ? '原文' : '已优化' }}
        </button>
        <button
          class="t-link"
          title="复制全文到剪贴板"
          :disabled="!segments.length"
          @click="onCopy"
        >
          复制
        </button>
        <button
          class="t-link"
          title="导出为 txt / srt 文件"
          :disabled="!segments.length"
          @click="onExport"
        >
          导出
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
      <div class="t-guide-title">尚未部署转录模型</div>
      <div class="t-guide-body">
        本地转文字稿需要语音模型（SenseVoice）。开发期请将模型放到 benchmark
        目录或在设置中指定路径；正式版将提供「一键部署」。
      </div>
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
          v-model="sel.to"
          class="t-fix-input"
          placeholder="正确写法"
          @keyup.enter="addSelToDict"
        />
        <button class="t-btn small" @click="addSelToDict">加入词典</button>
        <button class="t-link" @click="cancelSel">取消</button>
      </div>
      <div v-if="loadingSegs" class="t-hint">
        <span class="t-spin"></span>加载文稿…
      </div>
      <div v-else-if="!segments.length" class="t-hint"
        >（暂无可显示的段落）</div
      >
      <div
        v-else
        ref="list"
        class="seg-list"
        @scroll.passive="onListScroll"
        @mouseup="onSelectText"
      >
        <template v-for="(row, ri) in rows">
          <div
            v-if="row.type === 'seg'"
            :key="'s' + row.vi"
            :data-vi="row.vi"
            class="seg-row"
            :class="{ active: row.vi === curIdx }"
            @click="onSegClick(row.seg)"
          >
            <span class="seg-time">{{ fmtClock(row.seg.start) }}</span>
            <span class="seg-text">{{ row.seg.display }}</span>
          </div>
          <div v-else :key="'g' + ri" class="seg-gap">
            {{ row.music ? '♪ 音乐' : '···' }}
            <span v-if="row.count > 1" class="seg-gap-n">×{{ row.count }}</span>
          </div>
        </template>
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
  getDictFor,
  addDictEntry,
} from '@/utils/podcast/transcripts';
import { getDownload } from '@/utils/podcast/downloads';
import { postprocessSegments } from '@/utils/podcast/transcriptPostprocess';

export default {
  name: 'TranscriptPanel',
  props: {
    episode: { type: Object, default: null },
    episodeId: { type: String, default: '' },
  },
  data() {
    return {
      initializing: true,
      modelReady: false,
      hasLocalFile: false,
      dbRow: null,
      segments: [],
      loadingSegs: false,
      curIdx: -1,
      follow: true,
      queuedLocal: false,
      scrollPauseUntil: 0,
      // [质量优化] 专名词典 + 原文/已优化切换 + 选中加词典交互
      dict: [],
      showRaw: false,
      sel: { show: false, from: '', to: '' },
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
    // 处理后的段（事件分类 + 专名词典替换）；原文模式=原样不处理。
    //   词典/showRaw 变 → computed 自动重算 → 即时生效、可回退。原始 segments 永不改。
    viewSegments() {
      if (this.showRaw) {
        return this.segments.map(s =>
          Object.assign({}, s, { kind: 'speech', display: s.text })
        );
      }
      return postprocessSegments(this.segments, {
        dict: this.dict,
        mainLang: 'zh',
      });
    },
    // 把连续的 noise/music 段折叠成一个占位行；speech 独立成行（vi=在 viewSegments 的下标，供高亮/跳播）
    rows() {
      const out = [];
      const vs = this.viewSegments;
      let gap = null;
      for (let i = 0; i < vs.length; i++) {
        const seg = vs[i];
        if (seg.kind === 'speech') {
          if (gap) {
            out.push(gap);
            gap = null;
          }
          out.push({ type: 'seg', vi: i, seg: seg });
        } else {
          if (!gap) gap = { type: 'gap', music: false, count: 0 };
          gap.count++;
          if (seg.kind === 'music') gap.music = true;
        }
      }
      if (gap) out.push(gap);
      return out;
    },
    dictCount() {
      return (this.dict && this.dict.length) || 0;
    },
  },
  watch: {
    episodeId() {
      this.init();
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
  },
  methods: {
    async init() {
      this.initializing = true;
      this.queuedLocal = false;
      this.segments = [];
      this.curIdx = -1;
      try {
        const st = await getAsrStatus(this.episodeId);
        this.modelReady = !!(st && st.modelReady);
        if (st && st.isThisQueued) this.queuedLocal = true;
      } catch (e) {
        this.modelReady = false;
      }
      // 本地音频是否存在（已下载/已缓存）→ 决定能否生成
      this.hasLocalFile = await this.checkLocalFile();
      this.dbRow = await getTranscript(this.episodeId).catch(() => null);
      this.initializing = false;
      if (this.mode === 'done' || this.mode === 'paused') {
        await this.maybeLoadSegments();
      }
    },
    async checkLocalFile() {
      try {
        const row = await getDownload(this.episodeId);
        if (row && row.filePath) return true;
      } catch (e) {
        /* ignore */
      }
      const pm =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.pathMap) ||
        {};
      return !!pm[this.episodeId];
    },
    async reloadRow() {
      this.dbRow = await getTranscript(this.episodeId).catch(() => null);
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
      this.loadingSegs = true;
      try {
        const res = await readSegments(this.episodeId);
        if (res && res.ok && Array.isArray(res.segments)) {
          // 只展示有文本的段（VAD 偶有空段）；兜底按 start 升序（worker 已升序写）
          this.segments = res.segments
            .filter(s => s && s.text && String(s.text).trim().length)
            .sort((a, b) => (a.start || 0) - (b.start || 0));
        } else {
          this.segments = [];
        }
      } catch (e) {
        this.segments = [];
      }
      this.loadingSegs = false;
      await this.loadDict();
      this.$nextTick(() => this.updateHighlight());
    },
    async loadDict() {
      try {
        this.dict = await getDictFor(this.podcastId);
      } catch (e) {
        this.dict = [];
      }
    },
    // 在文稿里选中错词 → 弹纠错条（只接受词级短选择，避免整段）
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
        this.sel = { show: true, from: txt, to: '' };
      }
    },
    cancelSel() {
      this.sel = { show: false, from: '', to: '' };
    },
    async addSelToDict() {
      const from = (this.sel.from || '').trim();
      const to = (this.sel.to || '').trim();
      if (!from || !to) return;
      const res = await addDictEntry({
        scope: 'podcast',
        podcastId: this.podcastId,
        from: from,
        to: to,
      });
      if (res && res.ok) {
        await this.loadDict(); // dict 变 → viewSegments computed 自动重算、即时生效
        this.cancelSel();
        this.$store.dispatch(
          'showToast',
          '已加入本节目词典：' + from + ' → ' + to
        );
      } else {
        this.$store.dispatch(
          'showToast',
          '加入失败：' + ((res && res.error) || '')
        );
      }
    },
    onGenerate() {
      if (!this.episode) return;
      this.queuedLocal = false;
      startTranscribe(this.episode).then(res => {
        if (res && res.ok && res.queued) this.queuedLocal = true;
      });
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
      try {
        await deleteTranscript(this.episodeId);
      } catch (e) {
        /* ignore */
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
    // 复制全文到剪贴板（开发调试：一键拿到纯文本，免逐段复制）
    onCopy() {
      if (!this.segments.length) return;
      // 跟随"原文/已优化"：原文=全段原始文本；已优化=只取 speech 段的替换后文本(跳过噪声/音乐段)
      let lines;
      if (this.showRaw) {
        lines = this.segments.map(s => (s && s.text) || '').filter(Boolean);
      } else {
        lines = this.viewSegments
          .filter(s => s.kind === 'speech')
          .map(s => s.display || '')
          .filter(Boolean);
      }
      const text = lines.join('\n');
      let done = false;
      try {
        if (window.require) {
          window.require('electron').clipboard.writeText(text);
          done = true;
        }
      } catch (e) {
        done = false;
      }
      if (!done && navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(() => {});
        done = true;
      }
      this.$store.dispatch(
        'showToast',
        done ? '已复制全文（' + lines.length + ' 段）' : '复制失败'
      );
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
    onListScroll() {
      // 用户手动滚动 → 暂时不抢滚动（避免与跟随打架）；2.5s 内不自动滚
      this.scrollPauseUntil = Date.now() + 2500;
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
    // 最后一个 start <= sec 的段（落在静音间隙时高亮"刚说过"的那段）
    findSegIndex(sec) {
      const segs = this.segments;
      let lo = 0;
      let hi = segs.length - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((segs[mid].start || 0) <= sec) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    },
    scrollToCurrent() {
      if (this.curIdx < 0) return;
      if (Date.now() < this.scrollPauseUntil) return;
      this.$nextTick(() => {
        const list = this.$refs.list;
        if (!list) return;
        const row = list.querySelector(
          '.seg-row[data-vi="' + this.curIdx + '"]'
        );
        if (row && row.scrollIntoView) {
          row.scrollIntoView({ block: 'nearest' });
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
    gap: 14px;
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
}
.seg-row {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s;
  // [转文字稿] 变高内容用 content-visibility 做"原生虚拟滚动"
  //   （Electron13=Chromium91 支持）：屏外段不渲染，5h 数千段也流畅，无需 JS 窗口化。
  content-visibility: auto;
  contain-intrinsic-size: 0 44px;
  &:hover {
    background: var(--color-secondary-bg);
  }
  &.active {
    background: var(--color-primary-bg-for-transparent);
    .seg-text {
      color: var(--color-primary);
      font-weight: 600;
    }
  }
}
.seg-time {
  flex-shrink: 0;
  font-size: 12px;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
  padding-top: 2px;
  min-width: 48px;
}
.seg-text {
  font-size: 14px;
  line-height: 1.6;
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
