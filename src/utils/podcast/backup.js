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

// [事故恢复] 从最新备份恢复：删掉(可能损坏/空)的当前库 → 重建干净 schema → 回灌备份各表。
//   补上 app 此前"只写备份、不会读回"的最大缺口。episodeListenStats.bits 在 JSON 里是 {0:..} 普通
//   对象，需还原成 Uint8Array。单集表(episodes)备份里没存(可由 RSS 重抓)，进入节目时自动补回。
export async function restoreFromLatestBackup() {
  if (!ipcRenderer) throw new Error('not-electron');
  const res = await ipcRenderer.invoke('podcast:backup:readLatest');
  if (!res || !res.ok || !res.json) {
    throw new Error((res && res.error) || '没有可用备份');
  }
  const data = JSON.parse(res.json);
  const arr = k => (Array.isArray(data[k]) ? data[k] : []);
  // bits: JSON 序列化把 Uint8Array 变成了 {0:..,1:..} 普通对象 → 还原回 Uint8Array
  const stats = arr('episodeListenStats').map(s => {
    if (s && s.bits && !(s.bits instanceof Uint8Array)) {
      try {
        return { ...s, bits: Uint8Array.from(Object.values(s.bits)) };
      } catch (e) {
        return { ...s, bits: new Uint8Array(0) };
      }
    }
    return s;
  });
  // 删掉当前库(清除损坏/空状态)→ 重建干净 schema → 回灌
  await db.delete();
  await db.open();
  await db.podcasts.bulkPut(arr('podcasts'));
  await db.favorites.bulkPut(arr('favorites'));
  await db.episodeProgress.bulkPut(arr('episodeProgress'));
  await db.episodeListenStats.bulkPut(stats);
  await db.listenDaily.bulkPut(arr('listenDaily'));
  await db.episodeDownloads.bulkPut(arr('episodeDownloads'));
  return {
    from: res.name,
    podcasts: arr('podcasts').length,
    favorites: arr('favorites').length,
    episodeProgress: arr('episodeProgress').length,
    episodeListenStats: stats.length,
    listenDaily: arr('listenDaily').length,
    episodeDownloads: arr('episodeDownloads').length,
  };
}

// [事故恢复·自愈] 开机自检：若订阅库为空(或打不开)、但有非空备份 → 弹窗询问是否一键恢复。
//   根治"IndexedDB 损坏/被重置成空库 → 重开订阅全没"的反复事故。新用户(无备份)绝不触发、不打扰。
export async function maybeAutoRestore() {
  if (!ipcRenderer) return;
  try {
    let count = 0;
    try {
      count = await db.podcasts.count();
    } catch (e) {
      count = 0; // 库打不开也视作空 → 尝试从备份恢复
    }
    if (count > 0) return; // 有数据 → 正常，不打扰
    const res = await ipcRenderer.invoke('podcast:backup:readLatest');
    if (!res || !res.ok || !res.json) return; // 无备份(新用户) → 不提示
    let n = 0;
    try {
      n = (JSON.parse(res.json).podcasts || []).length;
    } catch (e) {
      n = 0;
    }
    if (n <= 0) return; // 备份也是空 → 不提示
    const ok =
      typeof window.confirm === 'function' &&
      window.confirm(
        `检测到本地订阅为空，但发现备份（${res.name}，含 ${n} 档订阅）。\n` +
          `这通常是数据库损坏或被重置导致。是否从备份恢复？\n` +
          `（恢复订阅 / 进度 / 统计 / 收藏 / 下载记录；单集会在进入节目时自动重抓）`
      );
    if (!ok) return;
    const r = await restoreFromLatestBackup();
    // eslint-disable-next-line no-console
    console.log('[auto-restore] 已从备份恢复:', r);
    if (typeof window.alert === 'function') {
      window.alert(`已恢复 ${r.podcasts} 档订阅，即将刷新页面。`);
    }
    window.location.reload();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[auto-restore] 失败:', (e && e.message) || e);
  }
}
