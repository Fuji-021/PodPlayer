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

window.resetApp = () => {
  localStorage.clear();
  indexedDB.deleteDatabase('yesplaymusic');
  document.cookie.split(';').forEach(function (c) {
    document.cookie = c
      .replace(/^ +/, '')
      .replace(/=.*/, '=;expires=' + new Date().toUTCString() + ';path=/');
  });
  return '已重置应用，请刷新页面（按Ctrl/Command + R）';
};
console.log(
  '如出现问题，可尝试在本页输入 %cresetApp()%c 然后按回车重置应用。',
  'background: #eaeffd;color:#335eea;padding: 4px 6px;border-radius:3px;',
  'background:unset;color:unset;'
);

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

// [播客改造 诊断] 启动时直接用原生 IndexedDB API 检查 podcasts/episodes 表的真实行数。
// 用户报告"节目丢失"——这个日志会立即告诉我们：① 表是否还存在；② 真实节目/单集行数。
// F12 → Console 看 [DB Health] 那行。
setTimeout(() => {
  try {
    const req = indexedDB.open('yesplaymusic');
    req.onsuccess = e => {
      const idb = e.target.result;
      const tables = Array.from(idb.objectStoreNames);
      console.log('[DB Health] tables:', tables, 'version:', idb.version);
      ['podcasts', 'episodes', 'favorites', 'episodeProgress'].forEach(t => {
        if (!tables.includes(t)) {
          console.warn(`[DB Health] table "${t}" MISSING`);
          return;
        }
        const tx = idb.transaction(t, 'readonly');
        const req2 = tx.objectStore(t).count();
        req2.onsuccess = () =>
          console.log(`[DB Health] ${t} rows:`, req2.result);
      });
    };
    req.onerror = () => console.warn('[DB Health] open failed');
  } catch (e) {
    console.warn('[DB Health] error', e);
  }
}, 800);

// [B-31] 注册下载 IPC 监听 + 加载已下载列表灌入 store
import {
  registerDownloadListeners,
  loadAllDownloads,
} from '@/utils/podcast/downloads';
registerDownloadListeners();
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

// [NAS] 启动时初始化 NAS 音源熔断器（读配置：未启用则 no-op；启用则探活 + 起心跳）。
//   失败静默，绝不影响启动与既有播放。配置已由设置页 NAS 区块接管(window.podNas 临时入口已移除)。
import { initNas } from '@/utils/podcast/nasSource';
initNas().catch(() => {});

// [F2 / B69-F2] 启动后空闲清理"预览孤儿"(发现页预览残留的 subscribed:false 零互动节目+单集)，
//   防其长期堆积拖慢 DB。延迟到启动稳定后跑、低优先、失败静默；只删零互动的预览残留，
//   不碰已订阅/有历史/近 1h 预览过的节目(详见 db.js prunePreviewOrphans 判据)。
import { prunePreviewOrphans } from '@/utils/podcast/db';
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

new Vue({
  i18n,
  store,
  router,
  render: h => h(App),
}).$mount('#app');
