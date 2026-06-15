<template>
  <div v-show="episode" class="episode-detail-page">
    <div v-if="episode" class="ep-header">
      <!-- [B-63] 封面 hover 微动+光晕（复用首页设计） -->
      <div v-if="episode.coverUrl" class="cover-box">
        <div
          class="cover-shadow"
          :style="{ backgroundImage: `url(${episode.coverUrl})` }"
        ></div>
        <div class="cover-wrap">
          <PodImage
            class="cover"
            :src="episode.coverUrl"
            @error="onCoverError"
          />
        </div>
      </div>
      <div class="meta">
        <div class="podcast-name" @click="goPodcast">
          {{ podcast && podcast.title }}
        </div>
        <h1 class="title">{{ episode.title }}</h1>
        <div class="sub">
          <span>{{ formatDate(episode.pubDate) }}</span>
          <span v-if="episode.duration"
            >· {{ formatDuration(episode.duration) }}</span
          >
          <span v-if="progressLabel" class="prog" :class="progressLabelClass"
            >· {{ progressLabel }}</span
          >
        </div>
        <div class="actions">
          <!-- [S-3] 主播放 button：状态机 正在播放(暂停图标)/继续播放/点击播放 -->
          <button
            class="play-btn"
            :class="{ 'is-playing': isThisPlaying }"
            @click="play"
          >
            <svg-icon :icon-class="isThisPlaying ? 'pause' : 'play-circle'" />
            <span>{{ playBtnLabel }}</span>
          </button>
          <!-- [S-3] 三个小入口：收藏 / 下载 / 加入播放列表 -->
          <button class="mini-btn" :class="{ favorited: isFav }" @click="onFav">
            <svg-icon :icon-class="isFav ? 'heart-solid' : 'heart'" />
          </button>
          <button
            v-tip="isQueued ? '移出播放列表' : '加入播放列表'"
            class="mini-btn"
            :class="{ queued: isQueued }"
            @click="onQueue"
          >
            <svg-icon :icon-class="isQueued ? 'check-circle' : 'layer-plus'" />
          </button>
          <!-- [B-31] 下载按钮：未下载 → download；下载中 → 进度%；已下载 → check-circle（点击删除） -->
          <button
            v-tip="downloadBtnTitle"
            class="mini-btn"
            :class="{ downloaded: isDownloaded, downloading: isDownloading }"
            @click="onDownload"
          >
            <svg-icon :icon-class="downloadIcon" />
            <span v-if="isDownloading" class="dl-pct">{{
              downloadPercentText
            }}</span>
          </button>
          <a
            v-if="episode.link"
            class="link-btn"
            :href="episode.link"
            target="_blank"
            rel="noopener noreferrer"
          >
            原文链接
          </a>
        </div>
      </div>
    </div>

    <!-- [B-31] 删除下载确认弹窗 -->
    <div
      v-if="showDeleteDlConfirm"
      class="dialog-mask"
      @click.self="showDeleteDlConfirm = false"
    >
      <div class="confirm-dialog">
        <div class="title">删除下载</div>
        <div class="msg">
          确定要删除已下载的
          <b>"{{ episode && episode.title }}"</b>
          吗？<br />本地音频文件会被删除，单集听过的进度不会被删除。
        </div>
        <div class="actions">
          <button class="btn-secondary" @click="showDeleteDlConfirm = false">
            取消
          </button>
          <button class="btn-danger" @click="confirmDeleteDownload">
            确定删除
          </button>
        </div>
      </div>
    </div>

    <div v-if="episode" class="notes" @click="onNotesClick">
      <!-- sanitizeHtml 已清洗 RSS description（白名单 tag + 移除 on* + 强制 http 协议）；
           processedNotes 在其基础上把纯文本时间戳 HH:MM:SS/MM:SS 包成可点 .ts-seek（仅文本节点，不碰属性）。 -->
      <!-- [B-83] 小宇宙截断单集后台补全完整文稿期间显示占位，避免先闪截断版 -->
      <div v-if="enriching" class="notes-loading">
        <span class="spinner"></span>正在加载完整文稿…
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-else-if="processedNotes" v-html="processedNotes"></div>
      <div v-else class="empty">这一集没有提供 show notes / 节目简介。</div>
    </div>
  </div>
</template>

<script>
import { getPodcast, getEpisode, getEpisodeProgress } from '@/utils/podcast/db';
import {
  looksTruncated,
  xyzEpisodeUrl,
  enrichEpisodeShownotes,
} from '@/utils/podcast/shownotesEnrich';
import {
  getListenStats,
  listenedPercentStepped,
} from '@/utils/podcast/listening';
import {
  startDownload,
  cancelDownload,
  removeDownload,
} from '@/utils/podcast/downloads';
import { sanitizeHtml } from '@/utils/podcast/sanitizeHtml';
import SvgIcon from '@/components/SvgIcon.vue';

export default {
  name: 'EpisodeDetail',
  components: { SvgIcon },
  data() {
    return {
      podcast: null,
      episode: null,
      progressSec: 0,
      listenStats: null,
      // [B-31] 删除下载确认弹窗
      showDeleteDlConfirm: false,
      // [B-83] 小宇宙截断单集正在后台抓完整文稿时，notes 区显示加载占位(不闪截断版)
      enriching: false,
    };
  },
  computed: {
    feedUrl() {
      return decodeURIComponent(this.$route.params.feedUrlEncoded || '');
    },
    guid() {
      return decodeURIComponent(this.$route.params.guidEncoded || '');
    },
    episodeId() {
      return `${this.feedUrl}::${this.guid}`;
    },
    sanitizedDescription() {
      const raw = (this.episode && this.episode.description) || '';
      return sanitizeHtml(raw);
    },
    // [B-74] 时间戳 seek：在已清洗的 show notes 上，把纯文本里的 HH:MM:SS / MM:SS 包成可点蓝链
    //   (.ts-seek data-sec=秒)。只遍历**文本节点**改写，不动标签/属性(避免破坏已有 <a href> 里的数字)。
    processedNotes() {
      const html = this.sanitizedDescription;
      if (!html) return '';
      try {
        const div = document.createElement('div');
        div.innerHTML = html;
        this.linkifyTimestamps(div);
        return div.innerHTML;
      } catch (e) {
        return html; // 解析异常兜底用原文
      }
    },
    progressLabel() {
      if (this.listenStats && this.listenStats.completed) return '已听完';
      const pct = listenedPercentStepped(this.listenStats);
      if (pct >= 5) return `听过 ${pct}%`;
      const total = (this.episode && this.episode.duration) || 0;
      const listened = this.progressSec || 0;
      if (total <= 0 || listened <= 30) return '';
      return `剩余 ${this.formatDuration(total - listened)}`;
    },
    progressLabelClass() {
      if (this.listenStats && this.listenStats.completed) return 'done';
      if (listenedPercentStepped(this.listenStats) >= 5) return 'partial';
      return '';
    },
    // [UI状态机] 播放器当前加载的是不是本集
    isCurrentEpisode() {
      const ct = this.$store.state.player.currentTrack;
      return !!(this.episode && ct && ct.podcastEpisodeId === this.episode.id);
    },
    // 播放器是否正在播放（响应式：依赖 player._playing）
    playerPlaying() {
      return !!this.$store.state.player.playing;
    },
    // 本集是否正在播放中（= 当前曲 + 正在播放）
    isThisPlaying() {
      return this.isCurrentEpisode && this.playerPlaying;
    },
    // [UI状态机] ③ 续播判定：有断点(>30s) + 没听完(completed=false) + 离结尾还有 >30s。
    //   完整听过一遍的(已听完)不算续播 → 走「点击播放」从头。
    canResume() {
      if (this.listenStats && this.listenStats.completed) return false;
      const dur = (this.episode && this.episode.duration) || 0;
      return this.progressSec > 30 && (dur <= 0 || this.progressSec < dur - 30);
    },
    // [UI状态机] 主按钮文案：
    //   ① 本集正在播放 → 正在播放（点击暂停）
    //   ② 本集已加载但暂停 → 继续播放（点击续播）
    //   ③ 非本集但听过没听完 → 继续播放（从断点续播）
    //   ④ 其余(没听过 / 已听完) → 点击播放（从头）
    playBtnLabel() {
      if (this.isCurrentEpisode) {
        return this.playerPlaying ? '正在播放' : '继续播放';
      }
      if (this.canResume) return '继续播放';
      return '点击播放';
    },
    // [B-31] 下载状态
    isDownloaded() {
      if (!this.episode) return false;
      const ids =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.doneIds) ||
        [];
      return ids.includes(this.episode.id);
    },
    isDownloading() {
      return this.downloadProgressRaw !== null;
    },
    downloadProgressRaw() {
      if (!this.episode) return null;
      const map =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.progressMap) ||
        {};
      const p = map[this.episode.id];
      if (!p || p.status !== 'downloading') return null;
      return p;
    },
    downloadPercentText() {
      const p = this.downloadProgressRaw;
      if (!p) return '';
      if (!p.bytesTotal) return '…';
      const pct = Math.min(99, (p.bytesDone / p.bytesTotal) * 100);
      return Math.floor(pct) + '%';
    },
    downloadIcon() {
      if (this.isDownloaded) return 'check-circle';
      return 'download';
    },
    downloadBtnTitle() {
      if (this.isDownloaded) return '已下载（点击删除）';
      if (this.isDownloading) return '下载中（点击取消）';
      return '下载';
    },
    isFav() {
      if (!this.episode) return false;
      const ids =
        (this.$store.state.podcastFavorites &&
          this.$store.state.podcastFavorites.episodeIds) ||
        [];
      return ids.includes(this.episode.id);
    },
    // [B67-BUG-5 修] 是否已在播放列表：以真实队列成员为持久态(取代瞬时 justQueued)，驱动 toggle 与图标。
    isQueued() {
      if (!this.episode) return false;
      const q = this.$store.state.podcastQueue || [];
      return q.some(x => x && x.id === this.episode.id);
    },
  },
  watch: {
    episodeId: {
      immediate: true,
      handler(v) {
        if (v) this.load();
      },
    },
    // [B-31] 监听播放器广播：当前显示的这一集发生 5%/completed 变化 → 重读 listenStats
    '$store.state.podcastListening.listenTick'() {
      const pl = this.$store.state.podcastListening;
      if (pl && pl.episodeId && pl.episodeId === this.episodeId) {
        getListenStats(this.episodeId)
          .then(s => (this.listenStats = s))
          .catch(() => {});
      }
    },
  },
  methods: {
    async load() {
      this.episode = await getEpisode(this.episodeId);
      if (!this.episode) {
        this.$router.replace('/'); // [B-79] 单集不存在 → 回首页(不再甩我的订阅，同 B-70)
        return;
      }
      this.podcast = await getPodcast(this.feedUrl);
      const p = await getEpisodeProgress(this.episodeId).catch(() => null);
      this.progressSec = (p && p.position) || 0;
      this.listenStats = await getListenStats(this.episodeId).catch(() => null);
      // [B-83/预取] 多数情况下完整文稿已被节目页后台预取(xyzFull=true)→ 这里直接秒显完整。
      //   仅当"小宇宙截断且尚未补全"时，先挂「加载完整文稿」占位(绝不先闪截断版)、抓完再渲染。
      const ep = this.episode;
      const needEnrich =
        !!ep &&
        !ep.xyzFull &&
        !!xyzEpisodeUrl(ep.link) &&
        (looksTruncated(ep.description) ||
          (ep.description || '').length < 1200);
      this.enriching = needEnrich;
      if (needEnrich) {
        await this.enrichShownotesIfNeeded();
        if (this.episode && this.episode.id === ep.id) this.enriching = false;
      }
    },
    // [B-83] 抓小宇宙单集页完整 shownotes 补全 description(命中更长才替换+持久化，逻辑在
    //   enrichEpisodeShownotes 内)。抓取期间用户可能已切集 → 校验仍是同一集再替换视图。
    async enrichShownotesIfNeeded() {
      const ep = this.episode;
      if (!ep) return;
      const full = await enrichEpisodeShownotes(ep);
      if (full && this.episode && this.episode.id === ep.id) {
        this.$set(this.episode, 'description', full);
        this.episode.xyzFull = true;
      }
    },
    play() {
      const player = this.$store.state.player;
      if (!player || !this.episode) return;
      // 本集已是当前曲：点击 = 暂停/继续（playOrPause 切换；不重建、保留进度）。
      if (this.isCurrentEpisode) {
        if (typeof player.playOrPause === 'function') player.playOrPause();
        return;
      }
      // 非本集：起播。playPodcastEpisode 内部按保存进度续播/从头(已听完会自动归零从头)。
      const title = (this.podcast && this.podcast.title) || '';
      player.playPodcastEpisode(this.episode, title);
    },
    // [B-74] show notes 里把纯文本时间戳包成可点链接（只遍历文本节点，不碰标签/属性）。
    linkifyTimestamps(root) {
      // [B-81 真因4] 有些 RSS 把时间戳本身做成 <a>(如 <a href="#t=...">14:27</a>)，
      //   或 sanitizeHtml 把非 http 的 href 剥掉但保留 <a> → 变成无 href 的 <a>14:27</a>。
      //   这类"整段就是一个时间戳"的 <a> 会被下面文本遍历的 closest('a') 跳过 → 死链不可点。
      //   先把它们就地转成 ts-seek(只认纯文本时间戳，绝不碰含其它文字的正常外链)。
      const tsFull = /^\s*(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?\s*$/;
      Array.from(root.querySelectorAll('a')).forEach(a => {
        if (a.querySelector('*')) return; // 含子元素的不碰
        const m = (a.textContent || '').match(tsFull);
        if (!m) return;
        let sec;
        if (m[3] !== undefined) {
          const H = +m[1];
          const M = +m[2];
          const S = +m[3];
          if (M >= 60 || S >= 60) return;
          sec = H * 3600 + M * 60 + S;
        } else {
          const M = +m[1];
          const S = +m[2];
          if (S >= 60) return;
          sec = M * 60 + S;
        }
        a.classList.add('ts-seek');
        a.setAttribute('data-sec', String(sec));
        a.removeAttribute('href'); // 交给 onNotesClick 原地 seek，不走默认导航
        a.removeAttribute('target');
      });
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        null
      );
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) nodes.push(n);
      nodes.forEach(node => {
        // 已在 <a> 内的文本不再处理（避免把链接文字里的数字也包进去）
        const parent = node.parentNode;
        if (!parent || (parent.closest && parent.closest('a'))) return;
        const text = node.nodeValue || '';
        // [B-77] 同时认半角 : 与全角 ：(中文 show notes 常用全角，原来只认半角 → 时间戳没被识别)
        const re = /\b(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?\b/g;
        if (!re.test(text)) return;
        re.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        let m;
        while ((m = re.exec(text))) {
          const full = m[0];
          let sec;
          if (m[3] !== undefined) {
            const H = +m[1];
            const M = +m[2];
            const S = +m[3];
            if (M >= 60 || S >= 60) continue; // 非法时分秒 → 当普通文本
            sec = H * 3600 + M * 60 + S;
          } else {
            const M = +m[1];
            const S = +m[2];
            if (S >= 60) continue;
            sec = M * 60 + S;
          }
          if (m.index > last) {
            frag.appendChild(
              document.createTextNode(text.slice(last, m.index))
            );
          }
          const a = document.createElement('a');
          a.className = 'ts-seek';
          a.setAttribute('data-sec', String(sec));
          a.textContent = full;
          frag.appendChild(a);
          last = m.index + full.length;
        }
        if (last > 0) {
          if (last < text.length) {
            frag.appendChild(document.createTextNode(text.slice(last)));
          }
          parent.replaceChild(frag, node);
        }
      });
    },
    // [B-74] 点 show notes 里的时间戳 → seek 到对应秒（本集在播则原地 seek，否则从该处起播）
    onNotesClick(e) {
      const a = e.target && e.target.closest && e.target.closest('.ts-seek');
      if (!a) return;
      e.preventDefault();
      const sec = parseInt(a.getAttribute('data-sec'), 10);
      if (isNaN(sec)) return;
      this.seekToTimestamp(sec);
    },
    seekToTimestamp(sec) {
      const player = this.$store.state.player;
      if (!player || !this.episode) return;
      const cur = player.currentTrack;
      const isThis = cur && cur.podcastEpisodeId === this.episode.id;
      if (isThis && player._howler) {
        // 本集已是当前曲且 howler 已创建：原地 seek
        //   (seek() 内部已对"howler 加载中"用 once('load') 兜底，加载窗口内点击也不丢)
        player.seek(sec);
        if (!player.playing && typeof player.play === 'function') player.play();
      } else {
        const title = (this.podcast && this.podcast.title) || '';
        // [B-74 修] 原来 .then 后再 seek：那时新 howler 还没 load 完，seek 被随后的
        //   续播 once('load') 覆盖 → 点了不跳。改为把起播秒数传进去，由 _playAudioSource
        //   的 once('load') 在加载完成时确定性 seek（与续播同路）。
        player.playPodcastEpisode(this.episode, title, sec);
      }
      this.$store.dispatch('showToast', '已跳到 ' + this.fmtTs(sec));
    },
    fmtTs(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      const ss = String(s).padStart(2, '0');
      return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
    },
    // [S-3] 三个小入口
    onFav() {
      if (!this.episode) return;
      const title = (this.podcast && this.podcast.title) || '';
      const track = {
        id: `pod:${this.episode.id}`,
        name: this.episode.title,
        al: { id: 0, name: title, picUrl: this.episode.coverUrl || '' },
        dt: (this.episode.duration || 0) * 1000,
        podcastAudioUrl: this.episode.audioUrl,
        // [审操作#3] 带 podcastId(=feedUrl)，防收藏写空 → 被 prunePreviewOrphans 静默清理。
        podcastId:
          this.episode.podcastId || (this.episode.id || '').split('::')[0],
        podcastEpisodeId: this.episode.id,
      };
      this.$store.dispatch('togglePodcastFavorite', track);
    },
    onQueue() {
      if (!this.episode) return;
      // [B67-BUG-5 修] toggle：已在队列 → 移出；否则加入。状态由 isQueued(真实队列成员)持久驱动，
      //   加入高亮跟随队列关系、不再 1.4s 自动消失，且可再点移出。
      if (this.isQueued) {
        this.$store.commit('removeFromQueue', this.episode.id);
        return;
      }
      // toast 由 enqueueEpisode action 内部弹出
      this.$store.dispatch('enqueueEpisode', {
        ...this.episode,
        podcastTitle: this.podcast ? this.podcast.title : '',
      });
    },
    // [B-31] 下载按钮三态：未下载 → 启动；下载中 → 取消；已下载 → 弹删除确认
    onDownload() {
      if (!this.episode) return;
      if (this.isDownloaded) {
        this.showDeleteDlConfirm = true;
        return;
      }
      if (this.isDownloading) {
        cancelDownload(this.episode.id);
        return;
      }
      startDownload(this.episode);
    },
    async confirmDeleteDownload() {
      this.showDeleteDlConfirm = false;
      if (!this.episode) return;
      await removeDownload(this.episode.id);
      this.$store.dispatch('showToast', '已删除下载');
    },
    goPodcast() {
      this.$router.push({
        name: 'podcastDetail',
        params: { feedUrlEncoded: encodeURIComponent(this.feedUrl) },
      });
    },
    formatDate(s) {
      if (!s) return '';
      const d = new Date(s);
      if (isNaN(d.getTime())) return s;
      return d.toLocaleDateString('zh-CN');
    },
    formatDuration(sec) {
      sec = Number(sec) || 0;
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(
          2,
          '0'
        )}`;
      }
      return `${m}:${String(s).padStart(2, '0')}`;
    },
    onCoverError(e) {
      e.target.style.opacity = 0;
    },
  },
};
</script>

<style lang="scss" scoped>
.episode-detail-page {
  color: var(--color-text);
  padding-top: 28px; // [B-63] 修顶部被 navbar 裁切一行（与其它页一致）
}
.ep-header {
  display: flex;
  gap: 24px;
  margin-bottom: 28px;
  align-items: flex-start;
  // [B-63] 封面外框：光晕 + hover 微动放大（不裁切，光晕可溢出）
  .cover-box {
    position: relative;
    width: 160px;
    height: 160px;
    flex-shrink: 0;
    transition: transform 0.25s ease-out;
    &:hover {
      transform: translateY(-3px) scale(1.02);
    }
    &:hover .cover-shadow {
      // 辉光增强只动 opacity/transform（合成器属性），不动 filter → 不被主线程渲染阻塞、不再慢半拍
      opacity: 0.6;
      transform: scale(0.98);
    }
  }
  .cover-shadow {
    position: absolute;
    left: 0;
    top: 10px;
    width: 100%;
    height: 100%;
    border-radius: 14px;
    background-size: cover;
    background-position: center;
    // [perf] blur 固定不动画（filter 动画走主线程 paint，会被大档单集渲染占用 → 辉光滞后于 scale）；
    //   强弱/扩散改用 opacity + transform scale，纯合成器、与主线程负载解耦。
    filter: blur(18px);
    opacity: 0.4;
    transform: scale(0.92);
    z-index: 0;
    transition: opacity 0.25s ease-out, transform 0.25s ease-out;
    will-change: opacity, transform;
    pointer-events: none;
  }
  .cover-wrap {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    border-radius: var(--radius-cover);
    overflow: hidden;
  }
  .cover {
    width: 100%;
    height: 100%;
    // 圆角交给 .cover-wrap 的 overflow:hidden 裁；内层不再重复 radius（消双重圆角发丝缝裁切）
    object-fit: cover;
    background: var(--color-secondary-bg);
    display: block;
  }
  .meta {
    flex: 1;
    // [裁切修] 原 overflow:hidden 会裁掉 .play-btn 等子按钮的 :hover scale 反馈(按钮贴 .meta 边)；
    //   改 min-width:0：同样防 flex 被长标题撑破，但不裁切放大动画。
    min-width: 0;
    .podcast-name {
      font-size: 13px;
      opacity: 0.65;
      cursor: pointer;
      display: inline-block;
      margin-bottom: 4px;
      &:hover {
        opacity: 1;
        text-decoration: underline;
      }
    }
    .title {
      font-size: 26px;
      font-weight: 700;
      line-height: 1.3;
      margin: 0 0 10px;
    }
    .sub {
      font-size: 13px;
      opacity: 0.6;
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 16px;
      .prog {
        color: var(--color-primary);
        opacity: 1;
        &.partial {
          color: #e0a800;
        }
        &.done {
          color: #27ae60;
        }
      }
    }
    .actions {
      display: flex;
      gap: 12px;
      align-items: center;
    }
  }
}
.play-btn {
  background: var(--color-primary);
  color: var(--color-primary-bg);
  padding: 8px 16px;
  border-radius: var(--radius-button);
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: 0.15s;
  .svg-icon {
    width: 14px;
    height: 14px;
  }
  &:hover {
    transform: scale(1.04);
  }
}
.link-btn {
  color: var(--color-text);
  opacity: 0.55;
  font-size: 13px;
  text-decoration: none;
  &:hover {
    opacity: 1;
    text-decoration: underline;
  }
}
// [S-3] 小图标按钮：收藏 / 下载 / 加入播放列表
.mini-btn {
  background: transparent;
  color: var(--color-text);
  opacity: 0.55;
  border-radius: 50%;
  padding: 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: 0.15s;
  .svg-icon {
    width: 18px;
    height: 18px;
  }
  &:hover {
    opacity: 1;
    background: var(--color-secondary-bg-for-transparent);
  }
  &.favorited {
    opacity: 1;
    color: #e74c3c;
  }
  // [B67-BUG-5] 已在播放列表：绿色高亮（持久跟随队列成员关系，点击可移出）
  &.queued {
    opacity: 1;
    color: #fff;
    background: #27ae60;
  }
  // [B-31] 下载三态
  &.downloaded {
    opacity: 1;
    color: #27ae60;
    border-radius: 14px;
    &:hover {
      color: #e74c3c;
    }
  }
  &.downloading {
    opacity: 1;
    color: var(--color-primary);
    border-radius: 14px;
    padding: 6px 10px;
    gap: 4px;
    .dl-pct {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }
  }
}

// [B-31] 与 podcastDetail 共用的中央确认弹窗样式
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.confirm-dialog {
  background: var(--color-body-bg);
  color: var(--color-text);
  border-radius: 14px;
  padding: 24px 26px;
  min-width: 360px;
  max-width: 440px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
  .title {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 12px;
  }
  .msg {
    font-size: 14px;
    line-height: 1.6;
    opacity: 0.85;
    margin-bottom: 18px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
}
.btn-secondary {
  background: var(--color-secondary-bg);
  color: var(--color-text);
  padding: 8px 16px;
  border-radius: var(--radius-button);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    background: var(--color-primary-bg-for-transparent);
  }
}
.btn-danger {
  background: #e74c3c;
  color: #fff;
  padding: 8px 16px;
  border-radius: var(--radius-button);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    transform: scale(1.04);
  }
}

.notes-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  opacity: 0.6;
  padding: 8px 0;
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--color-text);
    border-top-color: transparent;
    border-radius: 50%;
    opacity: 0.7;
    animation: notes-spin 0.7s linear infinite;
  }
}
@keyframes notes-spin {
  to {
    transform: rotate(360deg);
  }
}
.notes {
  font-size: 15px;
  line-height: 1.75;
  opacity: 0.92;
  ::v-deep {
    p {
      margin: 10px 0;
    }
    a {
      color: var(--color-primary);
      text-decoration: none;
      &:hover {
        text-decoration: underline;
      }
    }
    // [B-74] 时间戳 seek 链接（无 href，需手动 pointer + 加粗以示可点）
    a.ts-seek {
      cursor: pointer;
      font-weight: 600;
      white-space: nowrap;
    }
    img {
      max-width: 100%;
      height: auto;
      border-radius: 8px;
      margin: 14px 0;
    }
    figure {
      margin: 14px 0;
    }
    ul,
    ol {
      padding-left: 28px;
    }
    blockquote {
      border-left: 3px solid var(--color-primary);
      padding-left: 14px;
      margin: 14px 0;
      opacity: 0.85;
    }
    pre {
      background: var(--color-secondary-bg);
      padding: 10px 14px;
      border-radius: 8px;
      overflow: auto;
    }
    code {
      background: var(--color-secondary-bg-for-transparent);
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 0.92em;
    }
  }
  .empty {
    text-align: center;
    opacity: 0.45;
    padding: 40px 0;
  }
}
</style>
