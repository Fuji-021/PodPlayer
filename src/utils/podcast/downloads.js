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

// [B-52] 下载并发上限（默认 3；后续可由设置"同时下载集数 1-10"覆盖）
let MAX_CONCURRENT = 3;
const _activeSet = new Set(); // 正在下载的 episodeId
const _waitQueue = []; // 排队等待的 episode 对象
// [bugfix B] 缓存发起下载时的单集元数据，完成后回写 db.episodes，
// 让"我的下载"能 join 到（done 的 IPC 回包只带 episodeId/filePath/bytesTotal）
const _metaCache = new Map(); // episodeId → episode 元数据

// [B-52] 接口预留：设置层调用以覆盖并发上限（1=队列依次下载，>1=并发）。范围 1~10。
export function setDownloadConcurrency(n) {
  const v = Number(n);
  if (v >= 1 && v <= 10) MAX_CONCURRENT = Math.floor(v);
}
export function getDownloadConcurrency() {
  return MAX_CONCURRENT;
}

// 实际向主进程发起下载（不含并发判断）
async function _doStart(episode) {
  store.commit('setDownloadProgress', {
    episodeId: episode.id,
    bytesDone: 0,
    bytesTotal: 0,
    status: 'downloading',
  });
  // [bugfix B] 记录元数据，完成后回写 db.episodes
  _metaCache.set(episode.id, {
    id: episode.id,
    podcastId: episode.podcastId,
    title: episode.title,
    coverUrl: episode.coverUrl,
    audioUrl: episode.audioUrl,
    duration: episode.duration,
  });
  const idx = (episode.id || '').indexOf('::');
  const feedUrl = idx > 0 ? episode.id.slice(0, idx) : '';
  const guid = idx > 0 ? episode.id.slice(idx + 2) : episode.guid || episode.id;
  let res;
  try {
    res = await ipcRenderer.invoke('podcast:download:start', {
      episodeId: episode.id,
      feedUrl,
      guid,
      audioUrl: episode.audioUrl,
    });
  } catch (e) {
    // [bugfix A] invoke 异常未捕获会导致 _activeSet 槽位永久泄漏、队列死锁
    _metaCache.delete(episode.id);
    _activeSet.delete(episode.id);
    store.commit('clearDownloadProgress', episode.id);
    store.dispatch('showToast', '下载启动失败：' + ((e && e.message) || ''));
    _pump();
    return { ok: false };
  }
  if (!res || !res.ok) {
    _metaCache.delete(episode.id);
    _activeSet.delete(episode.id);
    store.commit('clearDownloadProgress', episode.id);
    store.dispatch('showToast', '下载启动失败：' + ((res && res.error) || ''));
    _pump();
  }
  return res || { ok: false };
}

// 槽位空出时，从等待队列拉起下一个
function _pump() {
  while (_activeSet.size < MAX_CONCURRENT && _waitQueue.length) {
    const ep = _waitQueue.shift();
    _activeSet.add(ep.id);
    // [bugfix A] 兜底吞掉 _doStart 内部任何未捕获 rejection，避免槽位泄漏
    _doStart(ep).catch(() => {});
  }
}

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
      // [bugfix B] 同步补写 episodes 表，避免 getDownloaded/Downloading
      // 因 db.episodes.get 为空而被丢条（done 回包不含元数据，取自 _metaCache）
      const meta = _metaCache.get(p.episodeId);
      if (meta) {
        const existed = await db.episodes.get(p.episodeId);
        if (!existed) {
          await db.episodes.put({
            id: p.episodeId,
            podcastId: meta.podcastId || podcastId,
            title: meta.title || '',
            coverUrl: meta.coverUrl || '',
            audioUrl: meta.audioUrl || '',
            duration: meta.duration || 0,
          });
        }
      }
    } catch (e) {
      console.error('[downloads] DB put 失败', e);
    }
    _metaCache.delete(p.episodeId);
    store.commit('clearDownloadProgress', p.episodeId);
    // [B-35] 带上本地路径，供 Player 同步取 file:// 离线播放
    store.commit('addDownloadedEpisode', {
      id: p.episodeId,
      filePath: p.filePath,
    });
    store.dispatch('showToast', '下载完成');
    // [B-52] 释放槽位，拉起排队中的下一个
    _activeSet.delete(p.episodeId);
    _pump();
  });
  ipcRenderer.on('podcast:download:error', (_e, p) => {
    if (!p || !p.episodeId) return;
    _metaCache.delete(p.episodeId);
    store.commit('clearDownloadProgress', p.episodeId);
    store.dispatch('showToast', '下载失败：' + (p.error || ''));
    // [B-52] 释放槽位，拉起排队中的下一个
    _activeSet.delete(p.episodeId);
    _pump();
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
  // 已在下载/排队 → 忽略重复（多选批量时天然去重）
  if (_activeSet.has(episode.id) || _waitQueue.some(e => e.id === episode.id)) {
    return { ok: true, already: true };
  }
  // [B-52] 并发上限：达到上限则入队排队(status:'queued')，否则立即下载
  if (_activeSet.size >= MAX_CONCURRENT) {
    _waitQueue.push(episode);
    store.commit('setDownloadProgress', {
      episodeId: episode.id,
      bytesDone: 0,
      bytesTotal: 0,
      status: 'queued',
    });
    return { ok: true, queued: true };
  }
  _activeSet.add(episode.id);
  return _doStart(episode);
}

export async function cancelDownload(episodeId) {
  // [B-52] 排队中(未开始) → 直接出队，无需通知主进程
  const qi = _waitQueue.findIndex(e => e.id === episodeId);
  if (qi >= 0) {
    _waitQueue.splice(qi, 1);
    store.commit('clearDownloadProgress', episodeId);
    return { ok: true };
  }
  if (!ipcRenderer) return { ok: false };
  const res = await ipcRenderer.invoke('podcast:download:cancel', {
    episodeId,
  });
  _activeSet.delete(episodeId);
  store.commit('clearDownloadProgress', episodeId);
  _pump();
  return res || { ok: false };
}

export async function removeDownload(episodeId) {
  const row = await db.episodeDownloads.get(episodeId);
  if (!row) return { ok: true };
  if (ipcRenderer && row.filePath) {
    // [bugfix D] 主进程删文件失败就别删 DB，否则记录没了但文件还在变成孤儿
    const res = await ipcRenderer.invoke('podcast:download:remove', {
      filePath: row.filePath,
    });
    if (res && res.ok === false) {
      store.dispatch(
        'showToast',
        '删除文件失败：' + ((res && res.error) || '')
      );
      return { ok: false };
    }
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
//   [B69-F3] 原来循环内逐条 await db.episodes.get + db.podcasts.get（2N 次串行 IndexedDB 往返，
//   下载多了明显变慢）→ 改 bulkGet 批量取（与 B-36 详情页同款）。
export async function getDownloadedEpisodes() {
  const rows = await db.episodeDownloads.toArray();
  const done = rows.filter(r => r && r.status === 'done');
  const eps = await db.episodes.bulkGet(done.map(r => r.id)).catch(() => []);
  const podIds = [
    ...new Set(
      eps
        .filter(Boolean)
        .map(e => e.podcastId)
        .filter(Boolean)
    ),
  ];
  const pods = await db.podcasts.bulkGet(podIds).catch(() => []);
  const podMap = {};
  podIds.forEach((pid, i) => {
    if (pods[i]) podMap[pid] = pods[i];
  });
  const result = [];
  done.forEach((r, i) => {
    const ep = eps[i];
    if (!ep) return;
    result.push({
      ...ep,
      podcastTitle: (podMap[ep.podcastId] && podMap[ep.podcastId].title) || '',
      filePath: r.filePath,
      downloadedAt: r.addedAt || 0,
    });
  });
  result.sort((a, b) => (a.downloadedAt || 0) - (b.downloadedAt || 0));
  return result;
}

// [B-35] 正在下载的单集富对象（从 store.progressMap 取 downloading 的 id + join 元数据）
export async function getDownloadingEpisodes() {
  const pm =
    (store.state.podcastDownloads &&
      store.state.podcastDownloads.progressMap) ||
    {};
  // [bugfix B/C] 放宽过滤：queued 也要在"正在下载"区可见
  const ids = Object.keys(pm).filter(
    id =>
      pm[id] && (pm[id].status === 'downloading' || pm[id].status === 'queued')
  );
  const result = [];
  for (const id of ids) {
    const ep = await db.episodes.get(id);
    // [bugfix B/C] join 不到元数据时也别丢条（用 _metaCache 兜底，再不行给最小占位）
    const base = ep || _metaCache.get(id) || { id };
    let podcastTitle = '';
    try {
      const pod = await db.podcasts.get(base.podcastId);
      podcastTitle = (pod && pod.title) || '';
    } catch (e) {
      // ignore
    }
    result.push({ ...base, status: pm[id].status, podcastTitle });
  }
  return result;
}

// [事故恢复] 下载重挂：清库后订阅可用 OPML 重灌，但 episodeDownloads 记录丢失 →
//   磁盘上 3GB 下载文件变"孤儿"。重订阅后调用本函数：主进程按下载端同款命名
//   (sha1(feedUrl)[:12]/sha1(guid)[:16]) 反查磁盘文件，匹配到的写回 episodeDownloads，
//   下载即"复活"、无需重下。幂等：已存在 done 记录的跳过。
export async function relinkDownloads() {
  if (!ipcRenderer) return { ok: false, relinked: 0 };
  const eps = await db.episodes.toArray();
  const res = await ipcRenderer.invoke(
    'podcast:download:relink',
    eps.map(e => ({ id: e.id, podcastId: e.podcastId }))
  );
  if (!res || !res.ok) return { ok: false, relinked: 0 };
  let relinked = 0;
  for (const m of res.matched) {
    const existed = await db.episodeDownloads.get(m.id);
    // 已是 done 且路径正确 → 跳过；路径不符(如迁移后失准)→ 仍以磁盘实测路径纠正。
    if (
      existed &&
      existed.status === 'done' &&
      existed.filePath === m.filePath
    ) {
      continue;
    }
    await db.episodeDownloads.put({
      id: m.id,
      podcastId: m.podcastId,
      filePath: m.filePath,
      bytesTotal: m.bytesTotal || 0,
      status: 'done',
      addedAt: (existed && existed.addedAt) || Date.now(),
    });
    store.commit('addDownloadedEpisode', { id: m.id, filePath: m.filePath });
    relinked++;
  }
  return {
    ok: true,
    relinked,
    scanned: eps.length,
    matched: res.matched.length,
  };
}

// [事故恢复·一次性] 实例改名后（YesPlayMusicPodcast → 当前身份）的下载恢复：
//   ① 把 episodeDownloads 里旧绝对前缀 \YesPlayMusicPodcast\ 改成「当前实例」目录
//      （basename 来自主进程 app.getPath('userData')，绝不硬编码 PodPlayerDev，
//      避免测试床/正式版首启被错改）；② 若确有记录被改写，再跑一次 relinkDownloads()
//      用 sha1 反查兜底（覆盖"前缀改了但文件没搬/路径仍不符"的情况）。
//   localStorage FLAG 只跑一次；空库/无旧前缀记录自然 no-op。由 main.js 启动期调用。
export async function recoverDownloadsOnce() {
  if (!ipcRenderer) return;
  try {
    const FLAG = 'podplayer_dlpath_migrated_v1';
    if (window.localStorage.getItem(FLAG)) return;
    const userData = await ipcRenderer.invoke('podcast:userDataDir');
    const cur = String(userData || '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop();
    let migrated = 0;
    if (cur && cur !== 'YesPlayMusicPodcast') {
      const OLD = '\\YesPlayMusicPodcast\\';
      const NEW = '\\' + cur + '\\';
      const rows = await db.episodeDownloads.toArray();
      for (const r of rows) {
        if (r && r.filePath && r.filePath.indexOf(OLD) !== -1) {
          await db.episodeDownloads.update(r.id, {
            filePath: r.filePath.split(OLD).join(NEW),
          });
          migrated++;
        }
      }
    }
    // 仅当确有旧前缀记录被改写时，才用 sha1 反查兜底（避免对空库做无谓全盘扫描）。
    if (migrated > 0) {
      try {
        await relinkDownloads();
      } catch (e) {
        // ignore
      }
      console.log(`[downloads] 已迁移 ${migrated} 条下载路径 → ${cur}`);
    }
    window.localStorage.setItem(FLAG, '1');
  } catch (e) {
    console.warn('[downloads] recoverDownloadsOnce 失败', e);
  }
}
