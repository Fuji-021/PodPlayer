import Vue from 'vue';
import VueGtag from 'vue-gtag';
import App from './App.vue';
import router from './router';
import store from './store';
import i18n from '@/locale';
import '@/assets/icons';
import '@/utils/filters';
import './registerServiceWorker';
import { dailyTask } from '@/utils/common';
import '@/assets/css/global.scss';
import NProgress from 'nprogress';
import '@/assets/css/nprogress.css';
// [B-62] 全局注册统一淡入封面组件（节目/单集封面零成本替换 <img>）
import PodImage from '@/components/PodImage.vue';
Vue.component('PodImage', PodImage);
// [优化2] 全局 hover tooltip 指令(统一替换原生 title= 的丑系统框)
import tip from '@/utils/directives/tip';
Vue.directive('tip', tip);

// [审P1-2] 渲染端全局兜底：未处理的 Promise 拒绝集中记录(仍 console.error 可见、保留 reason 栈)并
//   preventDefault，避免控制台被刷爆 + 某些配置下被当致命错误。首要修复是给高频写路径补 .catch
//   (见 Player.js 每秒 saveEpisodeProgress)，这里兜底其余意外 rejection。
window.addEventListener('unhandledrejection', e => {
  // eslint-disable-next-line no-console
  console.error('[unhandledrejection]', (e && e.reason) || e);
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
});

// [日志] 安装渲染端全局错误兜底 + 日志(经 IPC 落主进程文件 main.log)，尽早调用以捕获早期错误。
import { installRendererLogging } from '@/utils/log';
installRendererLogging();

// [事故加固] resetApp() 会 deleteDatabase 清空全部本地数据(订阅/进度/统计/收藏)。
//   2026-06-12 疑似被误触 → 不可恢复的清库。改为：① 必须显式 confirm；② 不再在
//   console 显眼广告它(去掉吸引误触的彩色提示)。仅作最后的人工自救手段保留。
window.resetApp = () => {
  const ok =
    typeof window.confirm === 'function'
      ? window.confirm(
          '⚠️ 确定要清空所有本地数据吗？\n订阅、收听进度、统计、收藏将被全部删除且不可恢复！'
        )
      : false;
  if (!ok) return '已取消，未做任何更改。';
  localStorage.clear();
  indexedDB.deleteDatabase('yesplaymusic');
  document.cookie.split(';').forEach(function (c) {
    document.cookie = c
      .replace(/^ +/, '')
      .replace(/=.*/, '=;expires=' + new Date().toUTCString() + ';path=/');
  });
  return '已重置应用，请刷新页面（按Ctrl/Command + R）';
};

Vue.use(
  VueGtag,
  {
    config: { id: 'G-KMJJCFZDKF' },
  },
  router
);
Vue.config.productionTip = false;

NProgress.configure({ showSpinner: false, trickleSpeed: 100 });
dailyTask();
// [播客改造 A-7.1] 启动时同步本地收藏 id 列表到 vuex
store.dispatch('fetchPodcastFavorites');

// [事故善后] 原 [DB Health] 裸 indexedDB.open 诊断探针已移除（事故已定位，见
//   docs/实例隔离规范.md；少一次每启动的裸开库）。需要时看「我的订阅」或控制台 db 查询。

// [B-31] 注册下载 IPC 监听 + 加载已下载列表灌入 store
import {
  registerDownloadListeners,
  loadAllDownloads,
  recoverDownloadsOnce,
  cleanupCompletedDownloads,
  setDownloadConcurrency,
} from '@/utils/podcast/downloads';
registerDownloadListeners();
// [C1] 启动时应用持久化的"同时下载集数"(否则重启回落底层默认 3)
setDownloadConcurrency(store.state.settings.downloadConcurrency || 3);
// [事故恢复·一次性] 实例改名后按"当前身份"修正下载绝对路径 + sha1 反查兜底（只跑一次）。
recoverDownloadsOnce();
loadAllDownloads()
  .then(rows => {
    // [B-35] 灌入 { id, filePath }，让 pathMap 就绪 → Player 能同步取 file:// 离线播放
    store.commit(
      'setDownloadedEpisodes',
      rows
        .filter(r => r && r.status === 'done')
        .map(r => ({ id: r.id, filePath: r.filePath }))
    );
  })
  .catch(() => {});

// [事故加固] 启动数据自动备份调度（30s 后首次 + 每 6 小时；空库自动跳过，
//   绝不用空数据覆盖历史好备份；落盘 userData\backups\，保留最近 3 份）。
import {
  startBackupSchedule,
  restoreFromLatestBackup,
  mergeRestoreHistoryFromLatestBackup,
  maybeAutoRestore,
} from '@/utils/podcast/backup';
startBackupSchedule();

// [事故恢复·自愈] 开机自检：本地订阅为空(或库损坏打不开)但有非空备份 → 弹窗一键恢复。
//   根治"IndexedDB 损坏/被重置成空库 → 重开订阅全没"的反复事故；新用户(无备份)不触发。
//   等 openDatabase() 尝试 settle 后再自检，避免与启动期建库竞态(openDatabase 幂等、与 db.js 自动开库共享同一 promise)。
import { openDatabase } from '@/utils/db';
openDatabase()
  .catch(() => {})
  .then(() => maybeAutoRestore());

// [事故恢复] 手动入口：控制台跑 restoreFromBackup() 从最新备份恢复(自检未触发时的兜底)。
window.restoreFromBackup = async () => {
  const r = await restoreFromLatestBackup();
  // eslint-disable-next-line no-console
  console.log('[restore] 已恢复:', r);
  if (typeof window.alert === 'function') {
    window.alert(`已恢复 ${r.podcasts} 档订阅，即将刷新页面。`);
  }
  window.location.reload();
  return r;
};

// [事故恢复·合并] 手动入口：订阅在但收听统计/进度为空时，控制台跑 mergeRestoreHistory() 只把
//   历史(进度/统计/收藏/下载)从备份合并回来，不动当前订阅(自检未弹时的兜底)。
window.mergeRestoreHistory = async () => {
  const r = await mergeRestoreHistoryFromLatestBackup();
  // eslint-disable-next-line no-console
  console.log('[merge-restore] 已合并恢复历史:', r);
  if (typeof window.alert === 'function') {
    window.alert('已合并恢复收听历史，即将刷新页面。');
  }
  window.location.reload();
  return r;
};

// [事故恢复] 暴露下载重挂（安全/幂等/仅新增）：清库后用 OPML 重订阅，再在控制台
//   运行一次 relinkDownloads() 即可把磁盘上残留的下载文件挂回、无需重下。
import { relinkDownloads } from '@/utils/podcast/downloads';
window.relinkDownloads = relinkDownloads;

// [NAS] 启动时初始化 NAS 音源熔断器（读配置：未启用则 no-op；启用则探活 + 起心跳）。
//   失败静默，绝不影响启动与既有播放。配置已由设置页 NAS 区块接管(window.podNas 临时入口已移除)。
import { initNas } from '@/utils/podcast/nasSource';
initNas().catch(() => {});

// [T5] 启动后空闲期批量清理「已听完但仍保留下载」的单集（用户开启设置时）
setTimeout(function () {
  if (
    store.state.settings &&
    store.state.settings.autoCleanCompletedDownloads
  ) {
    cleanupCompletedDownloads()
      .then(function (r) {
        if (r && r.cleaned) {
          store.dispatch(
            'showToast',
            '已自动清理 ' + r.cleaned + ' 个听完的下载文件'
          );
        }
      })
      .catch(function () {});
  }
}, 8000);

// [F2 / B69-F2] 启动后空闲清理"预览孤儿"(发现页预览残留的 subscribed:false 零互动节目+单集)，
//   防其长期堆积拖慢 DB。延迟到启动稳定后跑、低优先、失败静默；只删零互动的预览残留，
//   不碰已订阅/有历史/近 1h 预览过的节目(详见 db.js prunePreviewOrphans 判据)。
import {
  prunePreviewOrphans,
  getLastListenedByPodcast,
} from '@/utils/podcast/db';
setTimeout(() => {
  prunePreviewOrphans()
    .then(r => {
      if (r && r.pruned) {
        // eslint-disable-next-line no-console
        console.log(
          `[F2 prune] 清理预览孤儿 ${r.pruned} 档 / ${r.episodesDeleted} 单集`
        );
      }
    })
    .catch(() => {});
}, 6000);

// [缓存·C2/L3] 启动后空闲预热：把"最近听过"的若干档详情(节目 meta + 单集列表)读进 L1 episodeCache，
//   使首次点开(无需 hover)也近乎秒显。只读本地 Dexie、不触网；逐档 idle 串行、失败静默。
import { prewarmDetails } from '@/utils/podcast/detailPrefetch';
setTimeout(() => {
  getLastListenedByPodcast()
    .then(map => {
      const m = map || {};
      const urls = Object.keys(m).sort((a, b) => (m[b] || 0) - (m[a] || 0));
      prewarmDetails(urls, 8);
    })
    .catch(() => {});
}, 7000);

new Vue({
  i18n,
  store,
  router,
  render: h => h(App),
}).$mount('#app');

// [启动页] 启动后按用户设置跳转：startupPage==='library' → 我的订阅(/library)，否则保持首页(/)。
//   纯渲染端实现(background.js 固定加载首页 /，这里一次性 replace)、HMR 友好、不动主进程。
//   用全新 key startupPage(缺省 home)，不复用旧 showLibraryDefault(老值多为 true、会误跳)。
//   onReady 在初始路由解析后触发一次；.catch 吞掉 NavigationDuplicated。
router.onReady(() => {
  if (
    store.state.settings &&
    store.state.settings.startupPage === 'library' &&
    router.currentRoute.path === '/'
  ) {
    router.replace('/library').catch(() => {});
  }
});
