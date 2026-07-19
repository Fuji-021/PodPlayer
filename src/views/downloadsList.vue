<template>
  <div class="downloads-page" data-selection="ui">
    <!-- [下载页改版] 表头：标题 + 批量管理（多选删除） -->
    <div class="head">
      <h1>
        我的下载
        <span v-if="list.length" class="storage-hint"
          >{{ list.length }} 集 · {{ totalStorageText }}</span
        >
      </h1>
      <div v-if="list.length" class="head-actions">
        <button
          v-if="!selectMode"
          v-tip="'批量管理'"
          class="manage-btn"
          @click="enterSelect"
        >
          <svg-icon icon-class="checkbox" />
        </button>
        <template v-else>
          <button class="link-btn" @click="toggleSelectAll">
            {{ allSelected ? '取消全选' : '全选' }}
          </button>
          <button
            class="del-selected"
            :disabled="!selectedIds.length"
            @click="askBatchDelete"
          >
            <svg-icon icon-class="trash" />
            <span
              >删除{{
                selectedIds.length ? ' (' + selectedIds.length + ')' : ''
              }}</span
            >
          </button>
          <button class="link-btn" @click="exitSelect">取消</button>
        </template>
      </div>
    </div>

    <div v-if="!list.length" class="empty">还没有下载的单集</div>
    <div
      v-for="item in list"
      :key="item.id"
      class="row"
      :class="{ selecting: selectMode, selected: isSelected(item) }"
      data-selection="ui"
      @click="onRowClick(item, $event)"
      @dblclick="onRowDblClick(item, $event)"
      @contextmenu.prevent="openMenu($event, item)"
    >
      <PodImage class="cover" :src="item.coverUrl" @error="onCoverError" />
      <div class="meta">
        <!-- [下载页改版] 单击进单集详情、双击播放(整行)；节目名单击进节目详情、双击仍播放 -->
        <div class="t" data-selection="content">{{ item.title }}</div>
        <div class="s">
          <span
            class="link"
            data-selection="content"
            @click.stop="onSubtitleClick(item, $event)"
            @dblclick.stop="onRowDblClick(item, $event)"
            >{{ item.podcastTitle }}</span
          >
        </div>
      </div>
      <!-- [B-33] 专属页：单集右边显示「已下载」状态按钮（点击删除） -->
      <button
        v-if="!selectMode"
        v-tip="'已下载（点击删除）'"
        class="dl-btn"
        @click.stop="askDelete(item)"
        @dblclick.stop
      >
        <svg-icon icon-class="check-circle" />
      </button>
      <!-- [下载页改版] 选择模式：右边变多选框 -->
      <span v-else class="sel-box" :class="{ on: isSelected(item) }">
        <svg-icon v-if="isSelected(item)" icon-class="check" />
      </span>
    </div>

    <!-- [B-35] 正在下载区：最新已下载的下方；复用单集背景进度条 -->
    <div v-if="downloadingItems.length" class="downloading-section">
      <div class="section-head">正在下载（{{ downloadingItems.length }}）</div>
      <div
        v-for="item in downloadingItems"
        :key="'dl-' + item.id"
        class="row downloading"
      >
        <div
          class="dl-progress-bg"
          :style="{ width: dlPercent(item) + '%' }"
        ></div>
        <PodImage class="cover" :src="item.coverUrl" @error="onCoverError" />
        <div class="meta">
          <div class="t" data-selection="content">{{ item.title }}</div>
          <div class="s" data-selection="content"
            >{{ item.podcastTitle }} · {{ dlPercentText(item) }}</div
          >
        </div>
      </div>
    </div>

    <!-- [B-33] 右键菜单（toggle：再次右键关闭） -->
    <div
      v-if="menu.open"
      ref="menu"
      class="ctx-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
    >
      <div class="ctx-item" @click="onMenuPlay">
        <svg-icon icon-class="play-circle" />
        <span>立即播放</span>
      </div>
      <div class="ctx-item" @click="onMenuQueue">
        <svg-icon icon-class="layer-plus" />
        <span>加入播放列表</span>
      </div>
      <div class="ctx-item" @click="onMenuFav">
        <svg-icon :icon-class="isFav(menu.target) ? 'heart-solid' : 'heart'" />
        <span>{{ isFav(menu.target) ? '取消收藏' : '收藏' }}</span>
      </div>
      <div class="ctx-item danger" @click="onMenuDelete">
        <svg-icon icon-class="trash" />
        <span>删除下载</span>
      </div>
    </div>

    <!-- 删除确认弹窗 -->
    <div v-if="delTarget" class="dialog-mask" @click.self="delTarget = null">
      <div class="confirm-dialog">
        <div class="title">删除下载</div>
        <div class="msg">
          确定要删除已下载的
          <b>"{{ delTarget.title }}"</b>
          吗？<br />只会删除本地音频文件；收听进度、文字稿、精修稿和总结都会保留。
        </div>
        <div class="actions">
          <button class="btn-secondary" @click="delTarget = null">取消</button>
          <button class="btn-danger" @click="confirmDelete">确定删除</button>
        </div>
      </div>
    </div>

    <!-- [下载页改版] 批量删除确认弹窗 -->
    <div
      v-if="batchDeleting"
      class="dialog-mask"
      @click.self="batchDeleting = false"
    >
      <div class="confirm-dialog">
        <div class="title">批量删除下载</div>
        <div class="msg">
          确定要删除选中的
          <b>{{ selectedIds.length }}</b>
          个下载吗？<br />只会删除本地音频文件；收听进度、文字稿、精修稿和总结都会保留。
        </div>
        <div class="actions">
          <button class="btn-secondary" @click="batchDeleting = false">
            取消
          </button>
          <button class="btn-danger" @click="confirmBatchDelete">
            确定删除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import {
  getDownloadedEpisodes,
  getDownloadingEpisodes,
  removeDownload,
} from '@/utils/podcast/downloads';
import SvgIcon from '@/components/SvgIcon.vue';
import { shouldPreserveSelection } from '@/utils/selectionIntent';

export default {
  name: 'DownloadsList',
  components: { SvgIcon },
  data() {
    return {
      list: [],
      // [B-35] 正在下载列表（最新已下载的下方）
      downloadingItems: [],
      menu: { open: false, x: 0, y: 0, target: null },
      menuListener: null,
      delTarget: null,
      // [下载页改版] 批量管理（多选删除）
      selectMode: false,
      selectedIds: [],
      batchDeleting: false,
    };
  },
  computed: {
    // [下载页改版] 是否已全选
    allSelected() {
      return (
        this.list.length > 0 && this.selectedIds.length === this.list.length
      );
    },
    // [T6] 已下载单集总占用（bytes → 可读文本）
    totalStorageText() {
      const total = this.list.reduce(function (s, ep) {
        return s + (ep.bytesTotal || 0);
      }, 0);
      if (total <= 0) return '';
      if (total < 1024 * 1024) return Math.round(total / 1024) + ' KB';
      if (total < 1024 * 1024 * 1024)
        return (total / (1024 * 1024)).toFixed(1) + ' MB';
      return (total / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    },
  },
  watch: {
    // [B-35] 下载进度/项变化 → 刷新「正在下载」区；完成（doneIds 变）→ 刷新已下载区
    '$store.state.podcastDownloads.progressMap'() {
      this.refreshDownloading();
    },
    '$store.state.podcastDownloads.doneIds'() {
      if (this._bulkDeleting) return; // [审nit] 批量删除期间挂起，末尾统一 reload 一次
      this.reload();
    },
  },
  async created() {
    await this.reload();
    await this.refreshDownloading();
  },
  async activated() {
    this.exitSelect(); // [下载页改版] 重入页面退出选择模式，避免残留勾选
    await this.reload();
    await this.refreshDownloading();
  },
  beforeDestroy() {
    this.closeMenu();
    this._cancelPendingNav();
  },
  methods: {
    async reload() {
      this.list = await getDownloadedEpisodes();
    },
    async refreshDownloading() {
      this.downloadingItems = await getDownloadingEpisodes();
    },
    // [B-35] 下载百分比（响应式读 store.progressMap）
    dlPercent(item) {
      const map =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.progressMap) ||
        {};
      const p = map[item.id];
      if (!p) return 0;
      if (!p.bytesTotal) return 2;
      return Math.max(2, Math.min(99, (p.bytesDone / p.bytesTotal) * 100));
    },
    dlPercentText(item) {
      const map =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.progressMap) ||
        {};
      const p = map[item.id];
      if (!p || !p.bytesTotal) return '下载中…';
      return Math.floor((p.bytesDone / p.bytesTotal) * 100) + '%';
    },
    play(item) {
      const ep = {
        id: item.id,
        guid: item.guid || item.id.split('::').pop(),
        title: item.title,
        audioUrl: item.audioUrl,
        coverUrl: item.coverUrl,
        duration: item.duration,
        podcastId: item.podcastId,
      };
      this.$store.state.player.playPodcastEpisode(ep, item.podcastTitle || '');
    },
    // [下载页改版] 取消挂起的"单击进详情"延迟（双击/删除/右键/进选择模式/销毁时统一调用）
    _cancelPendingNav() {
      if (this._rowClickTimer) {
        clearTimeout(this._rowClickTimer);
        this._rowClickTimer = null;
      }
    },
    // [下载页改版] 行点击：选择模式=切换选中；否则单击延迟 250ms 进单集详情(留窗口给双击拦截)
    //   口径与 podcastDetail onRowClick 一致(单击进详情、双击播放)。250ms：150ms 太短，双击两下间隔稍大就
    //   会在第二下之前触发单击导航(变成"双击却进了详情")；250ms 才能稳定抓住双击=播放。
    onRowClick(item, event) {
      if (shouldPreserveSelection(event, event && event.currentTarget)) {
        this._cancelPendingNav();
        return;
      }
      if (this.selectMode) {
        this.toggleSelect(item);
        return;
      }
      this._cancelPendingNav();
      this._rowClickTimer = setTimeout(() => {
        this._rowClickTimer = null;
        this.goEpisode(item);
      }, 250);
    },
    // [下载页改版] 双击行 → 取消挂起的"进详情"，直接播放
    onRowDblClick(item, event) {
      if (shouldPreserveSelection(event, event && event.currentTarget)) {
        this._cancelPendingNav();
        return;
      }
      if (this.selectMode) return;
      this._cancelPendingNav();
      this.play(item);
    },
    // [下载页改版] 节目名点击：选择模式=切换选中；否则延迟进节目详情(同样让位双击播放)
    onSubtitleClick(item, event) {
      if (shouldPreserveSelection(event, event && event.currentTarget)) {
        this._cancelPendingNav();
        return;
      }
      if (this.selectMode) {
        this.toggleSelect(item);
        return;
      }
      this._cancelPendingNav();
      this._rowClickTimer = setTimeout(() => {
        this._rowClickTimer = null;
        this.goPodcast(item);
      }, 250);
    },
    // [下载页改版] 从 id(=feedUrl::guid) 解出 feedUrl/guid，口径与 downloads.js dirGuidFor 一致
    //   (用 indexOf/slice，guid 自身含 '::' 也不会被截断)
    _splitId(item) {
      const id = (item && item.id) || '';
      const idx = id.indexOf('::');
      return {
        feedUrl: (item && item.podcastId) || (idx > 0 ? id.slice(0, idx) : ''),
        guid: (item && item.guid) || (idx > 0 ? id.slice(idx + 2) : ''),
      };
    },
    // [下载页改版] 跳单集详情（与 podcastDetail/Player 一致：feedUrlEncoded + guidEncoded）
    goEpisode(item) {
      const { feedUrl, guid } = this._splitId(item);
      if (!feedUrl || !guid) return;
      this.$router.push({
        name: 'episodeDetail',
        params: {
          feedUrlEncoded: encodeURIComponent(feedUrl),
          guidEncoded: encodeURIComponent(guid),
        },
      });
    },
    // [下载页改版] 跳节目详情（与 historyList goPodcast 一致）
    goPodcast(item) {
      const { feedUrl } = this._splitId(item);
      if (!feedUrl) return;
      this.$router.push({
        name: 'podcastDetail',
        params: { feedUrlEncoded: encodeURIComponent(feedUrl) },
      });
    },
    // [下载页改版] 选择模式控制
    enterSelect() {
      this.closeMenu();
      this._cancelPendingNav(); // 进选择模式取消挂起的"进详情"
      this.selectMode = true;
      this.selectedIds = [];
    },
    exitSelect() {
      this.selectMode = false;
      this.selectedIds = [];
      this.batchDeleting = false;
    },
    isSelected(item) {
      return this.selectedIds.includes(item.id);
    },
    toggleSelect(item) {
      const i = this.selectedIds.indexOf(item.id);
      if (i >= 0) this.selectedIds.splice(i, 1);
      else this.selectedIds.push(item.id);
    },
    toggleSelectAll() {
      if (this.allSelected) this.selectedIds = [];
      else this.selectedIds = this.list.map(i => i.id);
    },
    askBatchDelete() {
      if (!this.selectedIds.length) return;
      this.batchDeleting = true;
    },
    async confirmBatchDelete() {
      // [审P2] 只删当前列表仍存在的选中项：剔除已被外部移出的陈旧 id，避免计数虚报
      const live = new Set(this.list.map(i => i.id));
      const ids = this.selectedIds.filter(id => live.has(id));
      this.batchDeleting = false;
      if (!ids.length) {
        this.exitSelect();
        return;
      }
      // [审nit] 批量期间挂起 doneIds watcher，收敛到末尾一次 reload（否则每删一条触发一次）
      //   try/finally 保证即便 removeDownload 抛错也复位，绝不把 watcher 永久挂起
      this._bulkDeleting = true;
      let ok = 0;
      try {
        for (const id of ids) {
          const r = await removeDownload(id);
          if (!r || r.ok !== false) ok++;
        }
      } finally {
        this._bulkDeleting = false;
      }
      const fail = ids.length - ok;
      // [审P2] 部分失败要让用户看见（toast 为单例，逐条失败提示会被覆盖，这里给准确汇总）
      this.$store.dispatch(
        'showToast',
        fail > 0 ? `已删除 ${ok} 个，${fail} 个删除失败` : `已删除 ${ok} 个下载`
      );
      this.exitSelect();
      await this.reload();
    },
    isFav(item) {
      if (!item) return false;
      const ids =
        (this.$store.state.podcastFavorites &&
          this.$store.state.podcastFavorites.episodeIds) ||
        [];
      return ids.includes(item.id);
    },
    // [B-33] 右键菜单 toggle
    openMenu(e, item) {
      if (this.selectMode) return; // [下载页改版] 选择模式禁用右键菜单
      this._cancelPendingNav(); // 右键即取消挂起的"进详情"
      const isSame =
        this.menu.open && this.menu.target && this.menu.target.id === item.id;
      this.closeMenu();
      if (isSame) return;
      const w = 200;
      const h = 200;
      const x = Math.min(e.clientX, window.innerWidth - w - 10);
      const y = Math.min(e.clientY, window.innerHeight - h - 10);
      this.menu = { open: true, x, y, target: item };
      this.$nextTick(() => {
        this.menuListener = ev => {
          const root = this.$refs.menu;
          if (root && !root.contains(ev.target)) this.closeMenu();
        };
        document.addEventListener('click', this.menuListener);
      });
    },
    closeMenu() {
      this.menu.open = false;
      this.menu.target = null;
      if (this.menuListener) {
        document.removeEventListener('click', this.menuListener);
        this.menuListener = null;
      }
    },
    onMenuPlay() {
      const it = this.menu.target;
      this.closeMenu();
      if (it) this.play(it);
    },
    onMenuQueue() {
      const it = this.menu.target;
      this.closeMenu();
      if (!it) return;
      this.$store.dispatch('enqueueEpisode', {
        ...it,
        podcastTitle: it.podcastTitle || '',
      });
    },
    onMenuFav() {
      const it = this.menu.target;
      this.closeMenu();
      if (!it) return;
      this.toggleFav(it);
    },
    toggleFav(item) {
      const track = {
        id: `pod:${item.id}`,
        name: item.title,
        al: {
          id: 0,
          name: item.podcastTitle || '',
          picUrl: item.coverUrl || '',
        },
        dt: (item.duration || 0) * 1000,
        podcastAudioUrl: item.audioUrl,
        // [审操作#3] 带 podcastId(=feedUrl)，防收藏写空 → 被 prunePreviewOrphans 静默清理。
        podcastId: item.podcastId || (item.id || '').split('::')[0],
        podcastEpisodeId: item.id,
      };
      this.$store.dispatch('togglePodcastFavorite', track);
    },
    onMenuDelete() {
      const it = this.menu.target;
      this.closeMenu();
      if (it) this.askDelete(it);
    },
    askDelete(item) {
      this._cancelPendingNav(); // 点删除即取消挂起的"进详情"，避免 250ms 后跳走
      this.delTarget = item;
    },
    async confirmDelete() {
      const it = this.delTarget;
      this.delTarget = null;
      if (!it) return;
      await removeDownload(it.id);
      this.$store.dispatch('showToast', '已删除下载');
      await this.reload();
    },
    onCoverError(e) {
      e.target.style.opacity = 0;
    },
  },
};
</script>

<style lang="scss" scoped>
.downloads-page {
  color: var(--color-text);
  padding-top: 28px;
}
// [下载页改版] 表头：标题 + 右侧批量管理操作
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
  gap: 12px;
  // 右内边距与单集行一致(行 padding 0 8px)，让右上角按钮与下方"已下载"绿勾列对齐
  padding-right: 8px;
}
h1 {
  font-size: 32px;
  font-weight: 700;
  margin: 0;
  .storage-hint {
    font-size: 14px;
    font-weight: 500;
    opacity: 0.4;
    margin-left: 10px;
    // 与标题下沿(基线)对齐，而非垂直居中
    vertical-align: baseline;
  }
}
// [下载页改版] 右侧操作区
.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.manage-btn {
  background: transparent;
  color: var(--color-text);
  opacity: 0.55;
  // 用 padding:8px(与 .dl-btn 同尺寸)，配合 .head 的 padding-right:8px，图标中心与绿勾列精确对齐
  padding: 8px;
  border-radius: 50%;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: 0.15s;
  .svg-icon {
    width: 20px;
    height: 20px;
  }
  &:hover {
    opacity: 1;
    background: var(--color-secondary-bg-for-transparent);
  }
}
.link-btn {
  background: transparent;
  color: var(--color-text);
  opacity: 0.6;
  font-size: 14px;
  font-weight: 600;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    opacity: 1;
    background: var(--color-secondary-bg-for-transparent);
  }
}
.del-selected {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #e74c3c;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  padding: 8px 14px;
  border-radius: 8px;
  cursor: pointer;
  transition: 0.15s;
  .svg-icon {
    width: 15px;
    height: 15px;
  }
  &:hover {
    transform: scale(1.04);
  }
  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    transform: none;
  }
}
.empty {
  text-align: center;
  opacity: 0.4;
  padding: 80px 0;
  font-size: 14px;
}
.row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 8px;
  border-radius: 10px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
  .cover {
    width: 56px;
    height: 56px;
    border-radius: var(--radius-cover-sm);
    object-fit: cover;
    background: var(--color-secondary-bg);
    flex-shrink: 0;
  }
  .meta {
    flex: 1;
    min-width: 0;
    .t {
      font-weight: 600;
      font-size: 15px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .s {
      font-size: 12px;
      opacity: 0.6;
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    // [下载页改版] 可点击跳转的名字（单集名/节目名）
    .link {
      cursor: pointer;
      transition: color 0.15s;
      &:hover {
        color: var(--color-primary);
        text-decoration: underline;
      }
    }
  }
  .dl-btn {
    background: transparent;
    color: #27ae60;
    padding: 8px;
    border-radius: 50%;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: 0.15s;
    .svg-icon {
      width: 20px;
      height: 20px;
    }
    &:hover {
      background: rgba(231, 76, 60, 0.12);
      color: #e74c3c;
    }
  }
  // [下载页改版] 选择模式：多选框（尺寸对齐"已下载"绿勾图标 20px，避免显得像按钮外圈）
  .sel-box {
    box-sizing: border-box;
    width: 19px;
    height: 19px;
    margin: 8px; // 与 .dl-btn 的 padding:8px 对齐，切换时右侧不跳动
    border-radius: 50%;
    border: 1.5px solid var(--color-text);
    opacity: 0.4;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: 0.15s;
    .svg-icon {
      width: 11px;
      height: 11px;
      color: #fff;
    }
    &.on {
      background: var(--color-primary);
      border-color: var(--color-primary);
      opacity: 1;
    }
  }
  // [下载页改版] 选中态高亮 + 选择模式下名字不再表现为链接
  &.selected {
    background: var(--color-primary-bg-for-transparent);
  }
  &.selecting .meta .link {
    cursor: pointer;
    &:hover {
      color: inherit;
      text-decoration: none;
    }
  }
}

// [B-35] 正在下载区
.downloading-section {
  margin-top: 18px;
  .section-head {
    font-size: 13px;
    font-weight: 700;
    opacity: 0.55;
    padding: 6px 8px;
    border-top: 1px solid var(--color-secondary-bg);
    margin-top: 6px;
  }
  .row.downloading {
    position: relative;
    overflow: hidden;
    cursor: default;
    &:hover {
      background: transparent;
    }
    // 复用单集背景进度条：弱视觉灰色，从左往右
    .dl-progress-bg {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 0%;
      background: rgba(128, 128, 128, 0.18);
      pointer-events: none;
      transition: width 0.4s ease-out;
      z-index: 0;
    }
    .cover,
    .meta {
      position: relative;
      z-index: 1;
    }
  }
}

// [B-33] 右键菜单
.ctx-menu {
  position: fixed;
  z-index: 200;
  min-width: 168px;
  background: var(--color-body-bg);
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.2),
    0 0 0 1px var(--color-secondary-bg-for-transparent);
}
.ctx-item {
  padding: 9px 12px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
  transition: 0.15s;
  .svg-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
  &.danger {
    color: #e74c3c;
    &:hover {
      background: rgba(231, 76, 60, 0.12);
    }
  }
}

// 删除确认弹窗
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
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
  border-radius: 8px;
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
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    transform: scale(1.04);
  }
}
</style>
