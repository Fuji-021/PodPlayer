// [B-31 播客改造] Renderer 端下载封装
// - startDownload / cancelDownload / removeDownload
// - 注册 IPC 监听把进度推到 store.podcastDownloads.progressMap
// - 完成后写 Dexie episodeDownloads，并清掉 progress
import { db } from '@/utils/db';
import store from '@/store';

const ipcRenderer = window.require
  ? window.require('electron').ipcRenderer
  : null;

let _registered = false;

// 在 app 启动时调用一次，把进度/完成/失败的 IPC 事件接到 store
export function registerDownloadListeners() {
  if (_registered || !ipcRenderer) return;
  _registered = true;
  ipcRenderer.on('podcast:download:progress', (_e, p) => {
    if (!p || !p.episodeId) return;
    store.commit('setDownloadProgress', {
      episodeId: p.episodeId,
      bytesDone: p.bytesDone || 0,
      bytesTotal: p.bytesTotal || 0,
      status: 'downloading',
    });
  });
  ipcRenderer.on('podcast:download:done', async (_e, p) => {
    if (!p || !p.episodeId) return;
    // 取写入 DB 用的 podcastId（episodeId 格式 `${feedUrl}::${guid}`）
    const idx = p.episodeId.indexOf('::');
    const podcastId = idx > 0 ? p.episodeId.slice(0, idx) : '';
    try {
      await db.episodeDownloads.put({
        id: p.episodeId,
        podcastId,
        filePath: p.filePath,
        bytesTotal: p.bytesTotal || 0,
        status: 'done',
        addedAt: Date.now(),
      });
    } catch (e) {
      console.error('[downloads] DB put 失败', e);
    }
    store.commit('clearDownloadProgress', p.episodeId);
    // [B-35] 带上本地路径，供 Player 同步取 file:// 离线播放
    store.commit('addDownloadedEpisode', {
      id: p.episodeId,
      filePath: p.filePath,
    });
    store.dispatch('showToast', '下载完成');
  });
  ipcRenderer.on('podcast:download:error', (_e, p) => {
    if (!p || !p.episodeId) return;
    store.commit('clearDownloadProgress', p.episodeId);
    store.dispatch('showToast', '下载失败：' + (p.error || ''));
  });
}

export async function startDownload(episode) {
  if (!ipcRenderer) {
    store.dispatch('showToast', '下载仅在桌面版可用');
    return { ok: false };
  }
  if (!episode || !episode.audioUrl) {
    store.dispatch('showToast', '该单集没有音频地址');
    return { ok: false };
  }
  // 已下载就别重启
  const existing = await db.episodeDownloads.get(episode.id);
  if (existing && existing.status === 'done') {
    return { ok: true, alreadyDone: true };
  }
  // 立刻在 store 写入 0% 进度（UI 即可显示进度条）
  store.commit('setDownloadProgress', {
    episodeId: episode.id,
    bytesDone: 0,
    bytesTotal: 0,
    status: 'downloading',
  });
  const idx = (episode.id || '').indexOf('::');
  const feedUrl = idx > 0 ? episode.id.slice(0, idx) : '';
  const guid = idx > 0 ? episode.id.slice(idx + 2) : episode.guid || episode.id;
  const res = await ipcRenderer.invoke('podcast:download:start', {
    episodeId: episode.id,
    feedUrl,
    guid,
    audioUrl: episode.audioUrl,
  });
  if (!res || !res.ok) {
    store.commit('clearDownloadProgress', episode.id);
    store.dispatch('showToast', '下载启动失败：' + (res?.error || ''));
  }
  return res || { ok: false };
}

export async function cancelDownload(episodeId) {
  if (!ipcRenderer) return { ok: false };
  const res = await ipcRenderer.invoke('podcast:download:cancel', {
    episodeId,
  });
  store.commit('clearDownloadProgress', episodeId);
  return res || { ok: false };
}

export async function removeDownload(episodeId) {
  const row = await db.episodeDownloads.get(episodeId);
  if (!row) return { ok: true };
  if (ipcRenderer && row.filePath) {
    await ipcRenderer.invoke('podcast:download:remove', {
      filePath: row.filePath,
    });
  }
  await db.episodeDownloads.delete(episodeId);
  store.commit('removeDownloadedEpisode', episodeId);
  return { ok: true };
}

export async function loadAllDownloads() {
  return await db.episodeDownloads.toArray();
}

export async function getDownload(episodeId) {
  return await db.episodeDownloads.get(episodeId);
}

// [B-33/B-35] 我的下载页：已下载单集富对象（join 元数据），按下载时间**正序**（最早在上、最新在下）
export async function getDownloadedEpisodes() {
  const rows = await db.episodeDownloads.toArray();
  const done = rows.filter(r => r && r.status === 'done');
  const result = [];
  for (const r of done) {
    const ep = await db.episodes.get(r.id);
    if (!ep) continue;
    let podcastTitle = '';
    try {
      const pod = await db.podcasts.get(ep.podcastId);
      podcastTitle = (pod && pod.title) || '';
    } catch (e) {
      // ignore
    }
    result.push({
      ...ep,
      podcastTitle,
      filePath: r.filePath,
      downloadedAt: r.addedAt || 0,
    });
  }
  result.sort((a, b) => (a.downloadedAt || 0) - (b.downloadedAt || 0));
  return result;
}

// [B-35] 正在下载的单集富对象（从 store.progressMap 取 downloading 的 id + join 元数据）
export async function getDownloadingEpisodes() {
  const pm =
    (store.state.podcastDownloads &&
      store.state.podcastDownloads.progressMap) ||
    {};
  const ids = Object.keys(pm).filter(
    id => pm[id] && pm[id].status === 'downloading'
  );
  const result = [];
  for (const id of ids) {
    const ep = await db.episodes.get(id);
    if (!ep) continue;
    let podcastTitle = '';
    try {
      const pod = await db.podcasts.get(ep.podcastId);
      podcastTitle = (pod && pod.title) || '';
    } catch (e) {
      // ignore
    }
    result.push({ ...ep, podcastTitle });
  }
  return result;
}
