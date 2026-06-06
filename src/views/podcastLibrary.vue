<template>
  <div class="podcast-library">
    <div class="header">
      <h1>播客库</h1>
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
    <div class="podcast-grid">
      <div v-if="!podcasts.length" class="empty-tip">
        还没有订阅。点击右上角 + 号添加 RSS 链接或导入文件。
      </div>
      <div
        v-for="p in podcasts"
        :key="p.id"
        class="podcast-card"
        @click="openPodcast(p)"
        @contextmenu.prevent="onCardContextMenu($event, p)"
      >
        <img
          class="cover"
          :src="p.coverUrl"
          loading="lazy"
          @error="onCoverError"
        />
        <div class="title">{{ p.title || '(无标题)' }}</div>
        <div class="author">{{ p.author || '' }}</div>
      </div>
    </div>

    <!-- [B-25] 卡片右键菜单（只有"取消订阅"一项）-->
    <div
      v-if="contextMenu.open"
      ref="contextMenu"
      class="ctx-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @click.stop
    >
      <div class="ctx-item danger" @click="askUnsubscribe(contextMenu.target)">
        <svg-icon icon-class="heart-crack" />
        <span>取消订阅</span>
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
} from '@/utils/podcast/service';
import SvgIcon from '@/components/SvgIcon.vue';

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
      // [B-25] 卡片右键菜单 + 取消订阅确认弹窗
      contextMenu: { open: false, x: 0, y: 0, target: null },
      contextMenuOutsideListener: null,
      unsubTarget: null,
    };
  },
  beforeDestroy() {
    this.closePlusMenu();
    this.closeContextMenu();
  },
  activated() {
    this.loadPodcasts();
  },
  created() {
    this.loadPodcasts();
  },
  methods: {
    async loadPodcasts() {
      this.podcasts = await getAllPodcasts();
      // [播客改造 诊断] 用户报告"节目丢失"——打印实际从 Dexie 拿到的节目数
      // 用户按 F12 在 Console 标签可看到结果
      console.log(
        '[播客库] loaded',
        this.podcasts.length,
        'podcasts:',
        this.podcasts.map(p => p.title)
      );
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
    onCardContextMenu(e, p) {
      // 边界保护：菜单宽 180px / 高 ~44px，避免超出视窗
      const x = Math.min(e.clientX, window.innerWidth - 200);
      const y = Math.min(e.clientY, window.innerHeight - 60);
      this.contextMenu = { open: true, x, y, target: p };
      this.$nextTick(() => {
        this.contextMenuOutsideListener = ev => {
          const root = this.$refs.contextMenu;
          if (root && !root.contains(ev.target)) {
            this.closeContextMenu();
          }
        };
        document.addEventListener('mousedown', this.contextMenuOutsideListener);
      });
    },
    closeContextMenu() {
      this.contextMenu.open = false;
      if (this.contextMenuOutsideListener) {
        document.removeEventListener(
          'mousedown',
          this.contextMenuOutsideListener
        );
        this.contextMenuOutsideListener = null;
      }
    },
    askUnsubscribe(p) {
      this.closeContextMenu();
      this.unsubTarget = p;
    },
    async doUnsubscribe() {
      if (!this.unsubTarget) return;
      await deletePodcast(this.unsubTarget.id);
      this.$store.dispatch('showToast', '已取消订阅');
      this.unsubTarget = null;
      await this.loadPodcasts();
    },
    onCoverError(e) {
      e.target.style.opacity = 0;
    },
  },
};
</script>

<style lang="scss" scoped>
.podcast-library {
  color: var(--color-text);
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
  h1 {
    font-size: 32px;
    font-weight: 700;
  }
}
.actions {
  display: flex;
  gap: 10px;
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

// [B-25] 卡片右键菜单
.ctx-menu {
  position: fixed;
  z-index: 220;
  background: var(--color-body-bg);
  border-radius: 10px;
  padding: 4px;
  width: 180px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22),
    0 0 0 1px var(--color-secondary-bg-for-transparent);
}
.ctx-item {
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  transition: 0.15s;
  .svg-icon {
    width: 16px;
    height: 16px;
  }
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
  &.danger:hover {
    background: rgba(231, 76, 60, 0.12);
    color: #e74c3c;
  }
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
  .cover {
    width: 100%;
    aspect-ratio: 1 / 1;
    border-radius: 12px;
    object-fit: cover;
    background: var(--color-secondary-bg);
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
  }
  .author {
    margin-top: 4px;
    font-size: 12px;
    opacity: 0.6;
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
