<template>
  <div class="podcast-library">
    <div class="header">
      <!-- [B-33] 标题 + 紧贴"阅"字的"更多"按钮 → 点击弹排序下拉（选项文字外显，自带方向） -->
      <div class="title-row">
        <h1>我的订阅</h1>
        <div ref="sortControl" class="sort-control">
          <button
            class="more-btn"
            :class="{ active: sortMenuOpen }"
            @click.stop="toggleSortMenu"
          >
            <svg-icon icon-class="menu-dots-vertical" />
          </button>
          <transition name="sort-pop">
            <div v-if="sortMenuOpen" class="sort-menu" @click.stop>
              <div class="sort-menu-head">排序方式</div>
              <div
                v-for="opt in sortOptions"
                :key="opt.key"
                class="sort-menu-item"
                :class="{ active: sortBy === opt.key }"
                @click="setSort(opt.key)"
              >
                <svg-icon :icon-class="opt.icon" class="lead" />
                <span class="label">{{ opt.label }}</span>
                <svg-icon
                  v-if="sortBy === opt.key"
                  class="dir"
                  :icon-class="
                    sortDir === 'asc'
                      ? 'arrow-up-small-big'
                      : 'arrow-down-small-big'
                  "
                />
              </div>
            </div>
          </transition>
        </div>
      </div>
      <!-- [播客改造 A-22] 添加订阅 + 导入 OPML 合并为 + 号按钮 + 弹窗。
           A-23 之后 podcast 详情已拆为独立路由，本页只在订阅列表显示。 -->
      <div class="actions">
        <div ref="plusControl" class="plus-control" @click.stop>
          <!-- [播客改造] title 屏蔽（不要原生 tooltip），文案保留供后续恢复 -->
          <button
            class="plus-button"
            :class="{ active: plusMenuOpen }"
            @click="togglePlusMenu"
          >
            <svg-icon icon-class="square-plus" />
          </button>
          <transition name="fade-pop">
            <div v-if="plusMenuOpen" class="plus-menu" @click.stop>
              <div class="plus-item" @click="onClickAddRss">
                <div class="t">粘贴 RSS 链接</div>
                <div class="s">单档节目订阅</div>
              </div>
              <div class="plus-item" @click="onClickImportOpml">
                <div class="t">导入文件</div>
                <div class="s">OPML 批量 / 单档 RSS / XML</div>
              </div>
            </div>
          </transition>
        </div>
        <input
          ref="opmlInput"
          type="file"
          accept=".opml,.xml,.rss,text/xml,application/xml,application/rss+xml"
          style="display: none"
          @change="handleImportFile"
        />
      </div>
    </div>

    <!-- [A-23] 订阅列表（一级界面）。节目详情已拆为 /library/podcast/:feedUrlEncoded 独立路由，
         < > 自然作为浏览器前进后退使用 -->
    <div class="podcast-grid" :class="{ resizing: isResizing }">
      <div v-if="!sortedPodcasts.length" class="empty-tip">
        还没有订阅。点击右上角 + 号添加 RSS 链接或导入文件。
      </div>
      <div
        v-for="p in sortedPodcasts"
        :key="p.id"
        class="podcast-card"
        :class="{ 'unsub-mode': unsubModeId === p.id }"
        @click="onCardClick(p)"
        @contextmenu.prevent="onCardContextMenu($event, p)"
      >
        <div class="cover-box">
          <!-- [B-44] 封面虚化光晕：所有位置封面统一具备"背景的那个光" -->
          <div
            class="cover-shadow"
            :style="{ backgroundImage: `url(${p.coverUrl})` }"
          ></div>
          <div class="cover-wrap">
            <img
              class="cover"
              :src="p.coverUrl"
              loading="lazy"
              @error="onCoverError"
            />
            <!-- [B-35→暂停] 封面下载进度 ring 应用户要求暂时取消。
               逻辑(podcastDlProgress) + 样式(.dl-ring) 保留，恢复时还原这段 svg 即可。 -->
            <!-- eslint-disable-next-line vue/no-unused-vars -->
            <svg
              v-if="false"
              class="dl-ring"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
            >
              <rect
                class="dl-ring-bar"
                x="1.2"
                y="1.2"
                width="97.6"
                height="97.6"
                rx="11"
                ry="11"
                pathLength="100"
                :stroke-dashoffset="100 - podcastDlProgress(p)"
              />
            </svg>
            <!-- [B-25 / bug-3] 右键后在封面上叠加 overlay，而不是单独小弹窗 -->
            <div
              v-if="unsubModeId === p.id"
              class="unsub-overlay"
              @click.stop="askUnsubscribe(p)"
              @mouseenter="cancelUnsubAutoClose"
              @mouseleave="scheduleUnsubAutoClose"
            >
              <svg-icon icon-class="heart-crack" />
              <div class="label">取消订阅</div>
            </div>
          </div>
        </div>
        <div class="title">{{ p.title || '(无标题)' }}</div>
        <div class="author">{{ p.author || '' }}</div>
        <!-- [B-31] 按用户要求：累计听过时长不在卡片下显示，留待将来"统计"入口页 -->
      </div>
    </div>

    <!-- [B-25] 取消订阅确认弹窗（应用内，替换系统 confirm） -->
    <div
      v-if="unsubTarget"
      class="dialog-mask"
      @click.self="unsubTarget = null"
    >
      <div class="confirm-dialog">
        <div class="title">取消订阅</div>
        <div class="msg">
          确定要取消订阅 <b>"{{ unsubTarget.title }}"</b> 吗？<br />
          单集历史进度不会被删除。
        </div>
        <div class="actions">
          <button class="btn-secondary" @click="unsubTarget = null"
            >取消</button
          >
          <button class="btn-danger" @click="doUnsubscribe">
            确定取消订阅
          </button>
        </div>
      </div>
    </div>

    <!-- [播客改造 C-1c] 导入进度弹窗 -->
    <div v-if="importPhase !== 'idle'" class="dialog-mask">
      <div class="import-dialog">
        <div v-if="importPhase === 'running'" class="import-running">
          <div class="title">{{ importLabel }}</div>
          <div class="bar-wrap">
            <div
              class="bar-fill"
              :style="{
                width:
                  (importTotal > 0 ? (importDone / importTotal) * 100 : 0) +
                  '%',
              }"
            ></div>
          </div>
          <div class="status">
            <span>{{ importDone }} / {{ importTotal }}</span>
            <span class="current" :title="importCurrent">{{
              importCurrent
            }}</span>
          </div>
        </div>
        <div v-else-if="importPhase === 'done'" class="import-done">
          <svg-icon icon-class="check" class="check" />
          <div class="msg">{{ importSuccessMsg }}</div>
        </div>
      </div>
    </div>

    <!-- 添加订阅对话框 -->
    <div v-if="showAddDialog" class="dialog-mask" @click.self="closeAddDialog">
      <div class="dialog">
        <div class="dialog-title">添加订阅</div>
        <div class="dialog-body">
          <input
            v-model="newFeedUrl"
            class="input"
            type="text"
            placeholder="粘贴 RSS 链接，例如 https://feed.xyzfm.space/xxxx"
            @keydown.enter="confirmAdd"
          />
          <div v-if="addError" class="error">{{ addError }}</div>
          <div v-if="adding" class="hint">抓取中…</div>
        </div>
        <div class="dialog-actions">
          <button class="btn-secondary" @click="closeAddDialog">取消</button>
          <button class="btn-primary" :disabled="adding" @click="confirmAdd">
            确定
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import {
  subscribeByRssUrl,
  importOpmlText,
  importRssText,
  getAllPodcasts,
  deletePodcast,
  getEpisodesByPodcast,
} from '@/utils/podcast/service';
import { getPodcastListenSummary } from '@/utils/podcast/listening';
import SvgIcon from '@/components/SvgIcon.vue';

// [A-28] 取一档节目最新一集的 pubTime（用于"节目更新时间"排序）
async function getLatestEpisodeTime(podcastId) {
  const eps = await getEpisodesByPodcast(podcastId);
  if (!eps.length) return 0;
  // getEpisodesByPodcast 已经 reverse 按 pubTime 排序，第一条就是最新
  return eps[0].pubTime || 0;
}

export default {
  name: 'PodcastLibrary',
  components: { SvgIcon },
  data() {
    return {
      podcasts: [],
      showAddDialog: false,
      newFeedUrl: '',
      addError: '',
      adding: false,
      // [播客改造 A-22] + 号弹窗开关
      plusMenuOpen: false,
      plusOutsideListener: null,
      // [播客改造 C-1c] 文件导入进度弹窗
      importPhase: 'idle', // 'idle' | 'running' | 'done'
      importLabel: '',
      importCurrent: '',
      importDone: 0,
      importTotal: 1,
      importSuccessMsg: '',
      // [B-25 / bug-3] 卡片 unsub-overlay 模式：当前激活的卡片 id
      unsubModeId: null,
      unsubModeOutsideListener: null,
      unsubModeKeyListener: null,
      unsubModeAutoTimer: null,
      unsubTarget: null,
      // [A-28] 排序：updatedAt(导入) / title(名称) / episodeTime(最新一集)；方向 asc/desc
      sortBy: localStorage.getItem('podcastLibrary.sortBy') || 'updatedAt',
      sortDir: localStorage.getItem('podcastLibrary.sortDir') || 'desc',
      sortMenuOpen: false,
      sortOutsideListener: null,
      // [B-33] 排序下拉选项（文字外显，自带方向箭头）
      sortOptions: [
        { key: 'updatedAt', icon: 'sort-alt', label: '按订阅时间' },
        { key: 'title', icon: 'sort-alpha-down-alt', label: '按节目名' },
        {
          key: 'episodeTime',
          icon: 'arrow-down-small-big',
          label: '按最新更新',
        },
        { key: 'listenWall', icon: 'time-past', label: '按累计听过时长' },
      ],
      // [S 级 bug 修] 窗口缩放时禁用 transition，避免大量 .podcast-card 动画排队卡顿
      isResizing: false,
      resizeTimer: null,
    };
  },
  computed: {
    // [A-28] 排序后的订阅列表
    sortedPodcasts() {
      const arr = [...this.podcasts];
      const sign = this.sortDir === 'asc' ? 1 : -1;
      const byKey = {
        updatedAt: p => p.updatedAt || 0,
        title: p => (p.title || '').toLowerCase(),
        episodeTime: p => p.latestEpisodeTime || 0,
        listenWall: p => (p.listenSummary && p.listenSummary.wallSec) || 0,
      };
      const getKey = byKey[this.sortBy] || byKey.updatedAt;
      arr.sort((a, b) => {
        const ka = getKey(a);
        const kb = getKey(b);
        if (ka < kb) return -1 * sign;
        if (ka > kb) return 1 * sign;
        return 0;
      });
      return arr;
    },
  },
  mounted() {
    // [S 级 bug 修] 窗口缩放监听，加 .resizing 暂时禁用动画
    window.addEventListener('resize', this.onWinResize);
  },
  beforeDestroy() {
    this.closePlusMenu();
    this.closeUnsubMode();
    this.closeSortMenu();
    window.removeEventListener('resize', this.onWinResize);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
  },
  activated() {
    this.loadPodcasts();
  },
  created() {
    this.loadPodcasts();
  },
  methods: {
    // [B-35] 该节目下载进度（0-100），无下载任务返 -1。
    //   episodeId 形如 `${feedUrl}::${guid}`，p.id = feedUrl，按前缀聚合属于该节目的下载中单集。
    podcastDlProgress(p) {
      const map =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.progressMap) ||
        {};
      const prefix = p.id + '::';
      let done = 0;
      let total = 0;
      let hasTask = false;
      for (const id in map) {
        if (!id.startsWith(prefix)) continue;
        const pr = map[id];
        if (!pr || pr.status !== 'downloading') continue;
        hasTask = true;
        done += pr.bytesDone || 0;
        total += pr.bytesTotal || 0;
      }
      if (!hasTask) return -1;
      if (!total) return 3; // 还没拿到 content-length，先显示一点点
      return Math.max(3, Math.min(99, (done / total) * 100));
    },
    async loadPodcasts() {
      const list = await getAllPodcasts();
      // [A-28] 并行查每档"最新一集"时间，用于按更新时间排序
      // [B-30] 并行查每档"累计收听时长"摘要，用于"我的最爱"排序 + UI 显示
      const [latest, summaries] = await Promise.all([
        Promise.all(list.map(p => getLatestEpisodeTime(p.id).catch(() => 0))),
        Promise.all(
          list.map(p => getPodcastListenSummary(p.id).catch(() => null))
        ),
      ]);
      this.podcasts = list.map((p, i) => ({
        ...p,
        latestEpisodeTime: latest[i] || 0,
        listenSummary: summaries[i] || null,
      }));
      console.log(
        '[播客库] loaded',
        this.podcasts.length,
        'podcasts:',
        this.podcasts.map(p => p.title)
      );
    },
    // [B-33] 选排序：同 key 再点 → 切方向（菜单保持开，看方向变化）；换 key → 设置并关闭
    setSort(key) {
      if (this.sortBy === key) {
        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        localStorage.setItem('podcastLibrary.sortDir', this.sortDir);
      } else {
        this.sortBy = key;
        this.sortDir = key === 'title' ? 'asc' : 'desc';
        localStorage.setItem('podcastLibrary.sortBy', this.sortBy);
        localStorage.setItem('podcastLibrary.sortDir', this.sortDir);
        this.closeSortMenu();
      }
    },
    // [B-33] "更多"按钮 toggle 下拉菜单；点击外部关闭（click 监听，与右键菜单同策略）
    toggleSortMenu() {
      if (this.sortMenuOpen) {
        this.closeSortMenu();
        return;
      }
      this.sortMenuOpen = true;
      this.$nextTick(() => {
        this.sortOutsideListener = ev => {
          const root = this.$refs.sortControl;
          if (root && !root.contains(ev.target)) this.closeSortMenu();
        };
        document.addEventListener('click', this.sortOutsideListener);
      });
    },
    closeSortMenu() {
      this.sortMenuOpen = false;
      if (this.sortOutsideListener) {
        document.removeEventListener('click', this.sortOutsideListener);
        this.sortOutsideListener = null;
      }
    },
    // [播客改造 A-22] + 号弹窗：点击外部关闭，与倍速面板同款策略
    togglePlusMenu() {
      if (this.plusMenuOpen) {
        this.closePlusMenu();
      } else {
        this.openPlusMenu();
      }
    },
    openPlusMenu() {
      this.plusMenuOpen = true;
      this.$nextTick(() => {
        this.plusOutsideListener = ev => {
          const root = this.$refs.plusControl;
          if (root && !root.contains(ev.target)) {
            this.closePlusMenu();
          }
        };
        document.addEventListener('mousedown', this.plusOutsideListener);
      });
    },
    closePlusMenu() {
      this.plusMenuOpen = false;
      if (this.plusOutsideListener) {
        document.removeEventListener('mousedown', this.plusOutsideListener);
        this.plusOutsideListener = null;
      }
    },
    onClickAddRss() {
      this.closePlusMenu();
      this.openAddDialog();
    },
    onClickImportOpml() {
      this.closePlusMenu();
      this.openImportOpml();
    },
    openAddDialog() {
      this.newFeedUrl = '';
      this.addError = '';
      this.showAddDialog = true;
    },
    closeAddDialog() {
      this.showAddDialog = false;
    },
    async confirmAdd() {
      if (this.adding) return;
      this.adding = true;
      this.addError = '';
      try {
        const { podcast } = await subscribeByRssUrl(this.newFeedUrl);
        await this.loadPodcasts();
        this.$store.dispatch('showToast', `已添加：${podcast.title}`);
        this.showAddDialog = false;
      } catch (err) {
        this.addError = String(err?.message || err);
      } finally {
        this.adding = false;
      }
    },
    openImportOpml() {
      this.$refs.opmlInput.click();
    },
    // [播客改造 C-1c] 文件导入：嗅探 OPML/RSS，自动派发
    async handleImportFile(e) {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';
      const text = await file.text();
      // 嗅探：包含 <opml → OPML；包含 <rss 或 <feed → 单档 RSS/Atom
      const isOpml = /<opml\b/i.test(text);
      const isRss = /<rss\b/i.test(text) || /<feed\b/i.test(text);

      if (isOpml) {
        await this.runOpmlImport(text);
      } else if (isRss) {
        await this.runSingleRssImport(text, file.name);
      } else {
        this.$store.dispatch(
          'showToast',
          '无法识别的文件格式（既不是 OPML，也不是 RSS/XML）'
        );
      }
    },
    // OPML 批量导入：弹进度框，importOpmlText 回调更新
    async runOpmlImport(text) {
      this.importPhase = 'running';
      this.importLabel = 'OPML 导入';
      this.importDone = 0;
      this.importTotal = 1;
      this.importCurrent = '解析 OPML...';
      try {
        const { added, failed } = await importOpmlText(
          text,
          (done, total, t) => {
            this.importDone = done;
            this.importTotal = total || 1;
            this.importCurrent = t || '';
          }
        );
        await this.loadPodcasts();
        this.importPhase = 'done';
        this.importSuccessMsg =
          `导入完成：成功 ${added.length} 档` +
          (failed.length ? `，失败 ${failed.length} 档` : '');
        if (failed.length) console.warn('[OPML 导入失败明细]', failed);
        setTimeout(() => {
          this.importPhase = 'idle';
        }, 1600);
      } catch (err) {
        this.importPhase = 'idle';
        this.$store.dispatch(
          'showToast',
          'OPML 解析失败：' + (err?.message || err)
        );
      }
    },
    // 单档 RSS/XML 导入
    async runSingleRssImport(text, fileName) {
      this.importPhase = 'running';
      this.importLabel = '导入单档 RSS';
      this.importDone = 0;
      this.importTotal = 1;
      this.importCurrent = fileName || '';
      try {
        const { podcast } = await importRssText(text, fileName);
        await this.loadPodcasts();
        this.importDone = 1;
        this.importPhase = 'done';
        this.importSuccessMsg = `已添加：${podcast.title || podcast.feedUrl}`;
        setTimeout(() => {
          this.importPhase = 'idle';
        }, 1600);
      } catch (err) {
        this.importPhase = 'idle';
        this.$store.dispatch(
          'showToast',
          'RSS 解析失败：' + (err?.message || err)
        );
      }
    },
    // [A-23] 进节目详情 = 真 router push；URL 改变 → 历史栈增长 → <> 可用
    openPodcast(p) {
      this.$router.push({
        name: 'podcastDetail',
        params: { feedUrlEncoded: encodeURIComponent(p.id) },
      });
    },
    // [B-25] 右键封面卡片 → 弹小菜单"取消订阅"
    // [B-25 / bug-3] 卡片点击行为：unsub-overlay 模式时点卡片 = 关闭模式
    onCardClick(p) {
      if (this.unsubModeId === p.id) {
        this.closeUnsubMode();
        return;
      }
      this.openPodcast(p);
    },
    onCardContextMenu(e, p) {
      // 再次右键同一张卡 = 关闭模式（多一种关闭方式）
      if (this.unsubModeId === p.id) {
        this.closeUnsubMode();
        return;
      }
      this.unsubModeId = p.id;
      this.$nextTick(() => {
        // 点击外部任意位置关闭
        this.unsubModeOutsideListener = ev => {
          if (!ev.target.closest('.podcast-card')) {
            this.closeUnsubMode();
          }
        };
        // Esc 键关闭
        this.unsubModeKeyListener = ev => {
          if (ev.key === 'Escape') this.closeUnsubMode();
        };
        document.addEventListener('mousedown', this.unsubModeOutsideListener);
        document.addEventListener('keydown', this.unsubModeKeyListener);
        // [UI 改] 5s 不操作自动复原（用户不需要手动关）
        this.scheduleUnsubAutoClose();
      });
    },
    scheduleUnsubAutoClose() {
      if (this.unsubModeAutoTimer) clearTimeout(this.unsubModeAutoTimer);
      this.unsubModeAutoTimer = setTimeout(() => {
        this.closeUnsubMode();
      }, 5000);
    },
    cancelUnsubAutoClose() {
      if (this.unsubModeAutoTimer) {
        clearTimeout(this.unsubModeAutoTimer);
        this.unsubModeAutoTimer = null;
      }
    },
    closeUnsubMode() {
      this.unsubModeId = null;
      if (this.unsubModeOutsideListener) {
        document.removeEventListener(
          'mousedown',
          this.unsubModeOutsideListener
        );
        this.unsubModeOutsideListener = null;
      }
      if (this.unsubModeKeyListener) {
        document.removeEventListener('keydown', this.unsubModeKeyListener);
        this.unsubModeKeyListener = null;
      }
      this.cancelUnsubAutoClose();
    },
    askUnsubscribe(p) {
      this.closeUnsubMode();
      this.unsubTarget = p;
    },
    async doUnsubscribe() {
      if (!this.unsubTarget) return;
      const target = this.unsubTarget;
      await deletePodcast(target.id);
      // [B-44] 全局同步：发现页/二级页同名卡片实时回到"未订阅"
      this.$store.commit('removeSubscribedPodcast', {
        feedUrl: target.id,
        name: target.title,
      });
      this.$store.dispatch('showToast', '已取消订阅');
      this.unsubTarget = null;
      await this.loadPodcasts();
    },
    onCoverError(e) {
      e.target.style.opacity = 0;
    },
    // [S 级 bug 修] 窗口缩放时禁用 transition，结束后 250ms 复位
    onWinResize() {
      if (!this.isResizing) this.isResizing = true;
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.isResizing = false;
      }, 250);
    },
  },
};
</script>

<style lang="scss" scoped>
.podcast-library {
  color: var(--color-text);
  padding-top: 28px; // [bug 修复] 与 podcastDetail 一致，避开顶栏过紧
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 24px;
}
// [B-33] 标题 + 紧贴的"更多"按钮（"我的订阅 ⋮"）
.title-row {
  display: flex;
  align-items: center;
  gap: 4px;
  h1 {
    font-size: 32px;
    font-weight: 700;
    line-height: 1;
    margin: 0;
  }
}
.actions {
  display: flex;
  gap: 10px;
}

// [B-33] "更多"按钮：紧贴"阅"字，点击弹排序下拉
.sort-control {
  position: relative;
  align-self: center;
}
.more-btn {
  background: transparent;
  color: var(--color-text);
  opacity: 0.5;
  border-radius: 6px;
  padding: 4px 6px;
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
    opacity: 0.9;
    background: var(--color-secondary-bg-for-transparent);
  }
  &.active {
    opacity: 1;
    color: var(--color-primary);
    background: var(--color-primary-bg-for-transparent);
  }
}
// [B-33] 排序下拉菜单
.sort-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  min-width: 188px;
  background: var(--color-body-bg);
  border-radius: 12px;
  padding: 6px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18),
    0 0 0 1px var(--color-secondary-bg-for-transparent);
  z-index: 80;
}
.sort-menu-head {
  font-size: 11px;
  opacity: 0.5;
  padding: 6px 10px 4px;
  font-weight: 600;
}
.sort-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  transition: 0.15s;
  .lead {
    width: 15px;
    height: 15px;
    opacity: 0.7;
    flex-shrink: 0;
  }
  .label {
    flex: 1;
  }
  .dir {
    width: 14px;
    height: 14px;
    color: var(--color-primary);
    flex-shrink: 0;
  }
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
  &.active {
    color: var(--color-primary);
    background: var(--color-primary-bg-for-transparent);
    .lead {
      opacity: 1;
      color: var(--color-primary);
    }
  }
}
// [B-33] 排序下拉出现动画（origin 左上，区别于 + 号菜单的 fade-pop）
.sort-pop-enter-active,
.sort-pop-leave-active {
  transition: opacity 0.15s, transform 0.15s;
  transform-origin: top left;
}
.sort-pop-enter,
.sort-pop-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
}

// [播客改造 A-22] + 号按钮 + 弹窗
.plus-control {
  position: relative;
}
.plus-button {
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
  transition: 0.2s;
  .svg-icon {
    width: 26px;
    height: 26px;
  }
  &:hover {
    opacity: 1;
    background: var(--color-secondary-bg-for-transparent);
  }
  &.active {
    opacity: 1;
    color: var(--color-primary);
  }
}
.plus-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  background: var(--color-body-bg);
  border-radius: 12px;
  padding: 6px;
  width: 240px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18),
    0 0 0 1px var(--color-secondary-bg-for-transparent);
  z-index: 80;
}
.plus-item {
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    background: var(--color-primary-bg-for-transparent);
  }
  .t {
    font-weight: 600;
    font-size: 14px;
    color: var(--color-text);
  }
  .s {
    font-size: 11px;
    opacity: 0.55;
    margin-top: 2px;
  }
}
.fade-pop-enter-active,
.fade-pop-leave-active {
  transition: opacity 0.15s, transform 0.15s;
  transform-origin: top right;
}
.fade-pop-enter,
.fade-pop-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
}

// [B-25] 取消订阅确认弹窗
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
.btn-danger {
  background: #e74c3c;
  color: #fff;
  padding: 8px 16px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    transform: scale(1.04);
  }
}

// [播客改造 C-1c] 导入进度/成功弹窗
.import-dialog {
  background: var(--color-body-bg);
  color: var(--color-text);
  border-radius: 14px;
  padding: 26px 28px;
  min-width: 360px;
  max-width: 460px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
}
.import-running {
  .title {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 14px;
  }
  .bar-wrap {
    height: 6px;
    background: var(--color-secondary-bg);
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 10px;
  }
  .bar-fill {
    height: 100%;
    background: var(--color-primary);
    transition: width 0.25s ease-out;
  }
  .status {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 12px;
    opacity: 0.65;
    .current {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 280px;
    }
  }
}
.import-done {
  display: flex;
  align-items: center;
  gap: 14px;
  .check {
    width: 28px;
    height: 28px;
    color: #27ae60;
    flex-shrink: 0;
  }
  .msg {
    font-size: 15px;
    font-weight: 600;
  }
}
.btn-primary,
.btn-secondary {
  font-weight: 600;
  font-size: 14px;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: 0.2s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  .svg-icon {
    width: 14px;
    height: 14px;
  }
}
.btn-primary {
  background: var(--color-primary);
  color: var(--color-primary-bg);
  &:hover {
    transform: scale(1.04);
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }
}
.btn-secondary {
  background: var(--color-secondary-bg);
  color: var(--color-text);
  &:hover {
    background: var(--color-primary-bg-for-transparent);
  }
}

.podcast-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 24px;
}
// [S 级 bug 修] 缩放期间禁用所有 transition，避免动画累积导致卡顿
.podcast-grid.resizing,
.podcast-grid.resizing * {
  transition: none !important;
  animation: none !important;
}
.empty-tip {
  grid-column: 1 / -1;
  text-align: center;
  opacity: 0.5;
  padding: 60px 0;
}
.podcast-card {
  cursor: pointer;
  transition: 0.2s;
  &:hover {
    transform: translateY(-2px);
  }
  &:hover .cover-shadow {
    filter: blur(20px) opacity(0.6);
    transform: scale(0.95);
    top: 16px;
  }
  // [B-44] 封面外层：承载方形尺寸，且不裁切光晕
  .cover-box {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1;
  }
  // [B-44] 封面虚化光晕（在 cover-wrap 之外，可超出不被裁切）
  .cover-shadow {
    position: absolute;
    left: 0;
    top: 10px;
    width: 100%;
    height: 100%;
    border-radius: 12px;
    background-size: cover;
    background-position: center;
    filter: blur(16px) opacity(0.45);
    transform: scale(0.9);
    z-index: 0;
    transition: filter 0.25s, transform 0.25s, top 0.25s;
  }
  .cover-wrap {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    border-radius: 12px;
    overflow: hidden;
    background: var(--color-secondary-bg);
  }
  // [B-35] 下载进度边框：SVG rect 从顶边左端顺时针描边一圈，细度≈播放bar，蓝色
  .dl-ring {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 2;
    .dl-ring-bar {
      fill: none;
      stroke: var(--color-primary);
      stroke-width: 1.2;
      stroke-dasharray: 100;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.4s ease;
    }
  }
  .cover {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.25s ease-out;
  }
  // [bug-3 / UI 改] unsub mode：封面更暗 + 微微放大
  &.unsub-mode {
    .cover {
      transform: scale(1.06);
      filter: brightness(0.3);
    }
    .title,
    .author {
      opacity: 0.4;
    }
  }
  .title {
    margin-top: 10px;
    font-weight: 600;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    transition: opacity 0.2s;
  }
  .author {
    margin-top: 4px;
    font-size: 12px;
    opacity: 0.6;
    transition: opacity 0.2s;
  }
}
// [bug-3] 取消订阅 overlay：贴在封面上的居中"取消订阅"按钮
.unsub-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  cursor: pointer;
  color: #fff;
  transition: 0.2s;
  .svg-icon {
    width: 38px;
    height: 38px;
  }
  .label {
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0.5px;
  }
  &:hover {
    color: #ff7a6b;
  }
}

.episode-view {
  .back-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }
  .link-btn {
    background: transparent;
    color: var(--color-text);
    cursor: pointer;
    font-size: 14px;
    opacity: 0.7;
    &:hover {
      opacity: 1;
    }
    &.danger:hover {
      color: #e74c3c;
    }
  }
}
.podcast-detail {
  display: flex;
  gap: 24px;
  margin-bottom: 32px;
  .cover-lg {
    width: 180px;
    height: 180px;
    border-radius: 16px;
    object-fit: cover;
    flex-shrink: 0;
    background: var(--color-secondary-bg);
  }
  .meta {
    flex: 1;
    overflow: hidden;
    .t {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .a {
      opacity: 0.7;
      margin-bottom: 12px;
    }
    .d {
      font-size: 14px;
      opacity: 0.7;
      line-height: 1.6;
      max-height: 100px;
      overflow: hidden;
    }
  }
}
.episode-list {
  border-top: 1px solid var(--color-secondary-bg);
}
.episode-row {
  padding: 14px 4px;
  cursor: pointer;
  border-bottom: 1px solid var(--color-secondary-bg);
  transition: 0.15s;
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
    padding-left: 12px;
  }
  .ep-title {
    font-weight: 600;
    font-size: 15px;
    margin-bottom: 4px;
  }
  .ep-sub {
    font-size: 12px;
    opacity: 0.6;
    display: flex;
    gap: 16px;
  }
}

.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.dialog {
  background: var(--color-body-bg);
  color: var(--color-text);
  border-radius: 12px;
  padding: 24px;
  width: 460px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
.dialog-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 16px;
}
.dialog-body {
  margin-bottom: 16px;
  .input {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--color-secondary-bg);
    background: var(--color-secondary-bg-for-transparent);
    color: var(--color-text);
    font-size: 14px;
    &:focus {
      outline: none;
      border-color: var(--color-primary);
    }
  }
  .error {
    color: #e74c3c;
    margin-top: 8px;
    font-size: 13px;
  }
  .hint {
    color: var(--color-primary);
    margin-top: 8px;
    font-size: 13px;
  }
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
