// [事故恢复·加固] 本地数据自动备份
// ----------------------------------------------------------------------------
// 背景：2026-06-12 dev-serve 主库被 deleteDatabase 清空(疑 resetApp 误触)，而 app 的
//   Dexie 数据此前**全程无备份机制** → 订阅/进度/统计/收藏不可恢复。本模块把全表导出成
//   一个全保真 JSON + 订阅 OPML，落盘到 userData\backups\(主进程写、保留最近 10 份)。
// 关键安全阀：**空库不备份** —— 避免清空事故后又用空数据覆盖掉之前的好备份(本次正是
//   备份发生在清空之后才同样为空)。
import { db } from '@/utils/db';
import { exportSubscriptionsOpml } from '@/utils/podcast/service';

const ipcRenderer = window.require
  ? window.require('electron').ipcRenderer
  : null;

export async function runBackup() {
  if (!ipcRenderer) return { ok: false, reason: 'not-electron' };
  try {
    // [瘦身] 不存 episodes 全表（最大、且可由 OPML 重订阅后重抓）。只存不可再生/难再生的：
    //   订阅元数据 + 收藏 + 收听进度/统计 + 下载记录。
    const [
      podcasts,
      favorites,
      episodeProgress,
      episodeListenStats,
      listenDaily,
      episodeDownloads,
    ] = await Promise.all([
      db.podcasts.toArray(),
      db.favorites.toArray(),
      db.episodeProgress.toArray(),
      db.episodeListenStats.toArray(),
      db.listenDaily.toArray(),
      db.episodeDownloads.toArray(),
    ]);

    // 安全阀：空库(无订阅/收藏/进度)直接跳过，绝不用空数据覆盖历史好备份。
    if (!podcasts.length && !favorites.length && !episodeProgress.length) {
      return { ok: false, skipped: 'empty' };
    }

    const json = JSON.stringify({
      _meta: {
        app: 'PodPlayer',
        at: Date.now(),
        v: 1,
        note: 'episodes 表未含，靠 OPML 重抓',
      },
      podcasts,
      favorites,
      episodeProgress,
      episodeListenStats,
      listenDaily,
      episodeDownloads,
    });
    let opml = '';
    try {
      opml = await exportSubscriptionsOpml();
    } catch (e) {
      opml = '';
    }
    return await ipcRenderer.invoke('podcast:backup:write', { json, opml });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

let _timer = null;

// 启动后 30s 跑首次备份，之后每 6 小时一次。空库自动跳过。
export function startBackupSchedule() {
  setTimeout(() => {
    runBackup().catch(() => {});
  }, 30000);
  if (_timer) return;
  _timer = setInterval(() => {
    runBackup().catch(() => {});
  }, 6 * 60 * 60 * 1000);
}
