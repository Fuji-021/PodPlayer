// [B-31 播客改造] Renderer 端下载封装
// - startDownload / cancelDownload / removeDownload
// - 注册 IPC 监听把进度推到 store.podcastDownloads.progressMap
// - 完成后写 Dexie episodeDownloads，并清掉 progress
import { db } from '@/utils/db';
import store from '@/store';
// [C3·NAS 就近源] 下载前软解析 NAS URL(在 NAS 上的单集从 NAS 取更快;未启用/不可达返回 null)
import { resolveNasUrl } from '@/utils/podcast/nasSource';

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

// [缓存·C3/B] 音频缓存：episodeDownloads 行 auto:true=自动缓存(可淘汰)、否则=手动下载(永不淘汰)。
//   淘汰只动 auto 行、绝不碰手动下载;删除复用 removeDownload(主进程删文件,删失败不删 DB)。
//   [B] 边播边缓存已改为"流播缓存代理"(播放经 /pa,主进程边喂播放器边写缓存)——见 podcastAudioProxy.js,
//   完成后经 'podcast:audioCached' IPC 在此登记 auto 行。手动下载仍走 startDownload(可标 auto，现仅手动=false)。
const _autoSet = new Set(); // startDownload({auto:true}) 时标记(done 据此写 auto)；现仅保留接口
let _proxyBase = ''; // [B] 本地流播缓存代理基址(http://127.0.0.1:<express>)，启动时经 IPC 取一次

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
  const isAuto = _autoSet.has(episode.id); // [C3] 自动缓存：全程不进下载 UI(进度条/已下载标记/系统通知)
  // [C3] 自动缓存不写 progressMap → 单集行不显进度条/"下载中"态(缓存应静默,与下载彻底解耦)
  if (!isAuto) {
    store.commit('setDownloadProgress', {
      episodeId: episode.id,
      bytesDone: 0,
      bytesTotal: 0,
      status: 'downloading',
    });
  }
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
  // [C3·NAS 就近源] 下载前软解析 NAS URL：在 NAS 上的单集直接从 NAS 取(LAN 更快)，
  //   否则回退原 audioUrl；NAS 未启用/不可达/查不到 resolveNasUrl 同步返回 null(软耦合、零阻断)。
  let sourceUrl = '';
  try {
    const u = await resolveNasUrl({
      podcastEpisodeId: episode.id,
      podcastId: episode.podcastId || feedUrl,
      podcastAudioUrl: episode.audioUrl,
      podcastEpisodePubTime: episode.pubTime || 0,
    });
    if (u) sourceUrl = u;
  } catch (e) {
    // NAS 解析失败 → 用原 audioUrl(软耦合，绝不阻断下载)
  }
  let res;
  try {
    res = await ipcRenderer.invoke('podcast:download:start', {
      episodeId: episode.id,
      feedUrl,
      guid,
      audioUrl: episode.audioUrl,
      sourceUrl, // [C3] 就近源(NAS)；主进程优先用、为空则回退 audioUrl
      auto: isAuto, // [C3] 自动缓存 → 主进程完成时静默(不发系统通知)
    });
  } catch (e) {
    // [bugfix A] invoke 异常未捕获会导致 _activeSet 槽位永久泄漏、队列死锁
    _metaCache.delete(episode.id);
    _activeSet.delete(episode.id);
    _autoSet.delete(episode.id); // [C3] 清自动缓存标记,防陈旧标记误标后续手动下载
    store.commit('clearDownloadProgress', episode.id);
    store.dispatch('showToast', '下载启动失败：' + ((e && e.message) || ''));
    _pump();
    return { ok: false };
  }
  if (!res || !res.ok) {
    _metaCache.delete(episode.id);
    _activeSet.delete(episode.id);
    _autoSet.delete(episode.id); // [C3] 同上
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
    if (_autoSet.has(p.episodeId)) return; // [C3] 自动缓存不写 progressMap → 不显进度条/"下载中"
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
    // [缓存·C3] 本次是否"自动缓存"发起 → 行打 auto 标记 + lastAccess(供 LRU)
    const isAuto = _autoSet.has(p.episodeId);
    _autoSet.delete(p.episodeId);
    try {
      await db.episodeDownloads.put({
        id: p.episodeId,
        podcastId,
        filePath: p.filePath,
        bytesTotal: p.bytesTotal || 0,
        status: 'done',
        addedAt: Date.now(),
        auto: isAuto, // [C3] true=自动缓存(可淘汰)；false/缺=手动下载(永不淘汰)
        lastAccess: Date.now(),
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
    // [C3] 带 auto：自动缓存只进 pathMap(供播放)、不进 doneIds(不显"已下载"标记)
    store.commit('addDownloadedEpisode', {
      id: p.episodeId,
      filePath: p.filePath,
      auto: isAuto,
    });
    // [C3] 自动缓存静默完成(不打扰)；手动下载照常提示"下载完成"
    if (!isAuto) store.dispatch('showToast', '下载完成');
    // [B-52] 释放槽位，拉起排队中的下一个
    _activeSet.delete(p.episodeId);
    _pump();
    // [C3] 自动缓存新增一集 → 跑一次预算淘汰(只淘汰 auto 行,超 2GB 删最久未用的)
    if (isAuto) evictAudioCache().catch(() => {});
  });
  ipcRenderer.on('podcast:download:error', (_e, p) => {
    if (!p || !p.episodeId) return;
    _metaCache.delete(p.episodeId);
    const wasAuto = _autoSet.has(p.episodeId); // [C3]
    _autoSet.delete(p.episodeId); // [C3] 清标记
    store.commit('clearDownloadProgress', p.episodeId);
    // [C3] 自动缓存失败静默(后台行为、不打扰);手动下载照常提示
    if (!wasAuto) store.dispatch('showToast', '下载失败：' + (p.error || ''));
    // [B-52] 释放槽位，拉起排队中的下一个
    _activeSet.delete(p.episodeId);
    _pump();
  });
  // [缓存·B] 流播缓存代理把某集下满 → 登记为 auto 行(进 LRU/TTL 淘汰)+ pathMap(下次直接 file:// 秒播)。
  //   已是手动下载(auto!==true)的不降级。静默(不弹"下载完成")。登记后跑一次预算淘汰。
  ipcRenderer.on('podcast:audioCached', async (_e, p) => {
    if (!p || !p.episodeId || !p.filePath) return;
    const idx = p.episodeId.indexOf('::');
    const podcastId = idx > 0 ? p.episodeId.slice(0, idx) : '';
    try {
      const existing = await db.episodeDownloads.get(p.episodeId);
      if (existing && existing.status === 'done' && existing.auto !== true) {
        return; // 手动下载已存在 → 保持手动钉住，不降级为可淘汰
      }
      await db.episodeDownloads.put({
        id: p.episodeId,
        podcastId,
        filePath: p.filePath,
        bytesTotal: p.bytesTotal || 0,
        status: 'done',
        addedAt: (existing && existing.addedAt) || Date.now(),
        auto: true,
        lastAccess: Date.now(),
      });
    } catch (e) {
      // 登记失败不影响播放(缓存文件仍在，下次仍可命中)
    }
    store.commit('addDownloadedEpisode', {
      id: p.episodeId,
      filePath: p.filePath,
      auto: true,
    });
    evictAudioCache().catch(() => {});
  });
  // [缓存·B] 启动取一次流播缓存代理基址(渲染端拼 /pa 播放 URL 用；dev 渲染在 webpack 端口、需显式 express 基址)
  ipcRenderer
    .invoke('podcast:audioProxyBase')
    .then(b => {
      if (b) _proxyBase = b;
    })
    .catch(() => {});
}

export async function startDownload(episode, opts) {
  opts = opts || {}; // [C3] opts.auto=true 表示"自动缓存"(可被淘汰);手动下载不传
  if (!ipcRenderer) {
    if (!opts.auto) store.dispatch('showToast', '下载仅在桌面版可用');
    return { ok: false };
  }
  if (!episode || !episode.audioUrl) {
    if (!opts.auto) store.dispatch('showToast', '该单集没有音频地址');
    return { ok: false };
  }
  // [C3·P0修] 手动下载意图永远压过"在途自动缓存"标记：用户手动点下载时(!opts.auto)，
  //   无论该集是否正在自动缓存(在队/在下/刚完成升级)，都先清掉 _autoSet 标记 → done 时必写
  //   auto:false(手动、永不淘汰)。否则"自动缓存在途 + 用户手动下载同集"竞态会把手动下载误标可淘汰、后被删盘。
  if (!opts.auto) _autoSet.delete(episode.id);
  // 已下载就别重启
  const existing = await db.episodeDownloads.get(episode.id);
  if (existing && existing.status === 'done') {
    // [C3] 用户手动下载一个原本"自动缓存"的集 → 升级为手动(钉住、不再被淘汰)
    if (!opts.auto && existing.auto) {
      await db.episodeDownloads
        .update(episode.id, { auto: false })
        .catch(() => {});
    }
    return { ok: true, alreadyDone: true };
  }
  // 已在下载/排队 → 忽略重复（多选批量时天然去重；上面已清 _autoSet，手动意图已生效）
  if (_activeSet.has(episode.id) || _waitQueue.some(e => e.id === episode.id)) {
    return { ok: true, already: true };
  }
  // [C3] 标记本次为自动缓存(done 时据此写 auto:true);失败/取消路径会清除该标记
  if (opts.auto) _autoSet.add(episode.id);
  // [B-52] 并发上限：达到上限则入队排队(status:'queued')，否则立即下载
  if (_activeSet.size >= MAX_CONCURRENT) {
    _waitQueue.push(episode);
    // [C3] 自动缓存不写 progressMap → 不显"排队中"(缓存全程静默)
    if (!opts.auto) {
      store.commit('setDownloadProgress', {
        episodeId: episode.id,
        bytesDone: 0,
        bytesTotal: 0,
        status: 'queued',
      });
    }
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
  _autoSet.delete(episodeId); // [C3] 清自动缓存标记
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
  // [C3] 只显"手动下载"(auto!==true);自动缓存不混入"我的下载"页与其存储占用
  const done = rows.filter(r => r && r.status === 'done' && r.auto !== true);
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
      bytesTotal: r.bytesTotal || 0, // [T6] 供下载页显示存储占用
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

// [T5] 听完自动清理：扫描已下载单集中 episodeListenStats.completed=true 的条目，
//   删除本地文件 + DB 记录。在启动期/切集后调用（非播放中），安全无副作用。
//   返回 { cleaned: N }。
export async function cleanupCompletedDownloads() {
  try {
    const rows = await db.episodeDownloads.toArray();
    const done = rows.filter(function (r) {
      return r && r.status === 'done';
    });
    if (!done.length) return { cleaned: 0 };
    const ids = done.map(function (r) {
      return r.id;
    });
    const stats = await db.episodeListenStats.bulkGet(ids).catch(function () {
      return [];
    });
    let cleaned = 0;
    for (let i = 0; i < done.length; i++) {
      const stat = stats[i];
      if (stat && stat.completed) {
        const res = await removeDownload(done[i].id);
        if (!res || res.ok !== false) cleaned++;
      }
    }
    return { cleaned: cleaned };
  } catch (e) {
    console.warn('[downloads] cleanupCompletedDownloads 失败', e);
    return { cleaned: 0 };
  }
}

// ============ [缓存·C3] 单集音频自动缓存（在听未听完 + 体积预算 LRU + 空闲 TTL） ============

function _audioCacheEnabled() {
  // [C3·P2修] 默认开：用 !== false 与设置页 UI 对齐，老用户(localStorage 无此键)也视为开，不出现"UI 显开、实际不缓存"。
  return !!(
    store.state.settings && store.state.settings.audioCacheEnabled !== false
  );
}
function _audioCacheBudgetBytes() {
  const mb =
    (store.state.settings && store.state.settings.audioCacheLimit) || 2048;
  return (Number(mb) || 2048) * 1024 * 1024;
}

// [缓存·B] 取本地流播缓存代理的播放 URL：启用缓存 + 代理基址就绪 → 返回 /pa 地址(经它播放=边播边缓存);
//   否则返回 ''(调用方回退直连)。Player ③CDN 路径用它替代直链，失败有 fallback 回退直连。
export function buildAudioProxyUrl(episodeId, audioUrl) {
  if (!_audioCacheEnabled()) return '';
  if (!_proxyBase || !episodeId || !audioUrl) return '';
  return (
    _proxyBase +
    '/pa?eid=' +
    encodeURIComponent(episodeId) +
    '&u=' +
    encodeURIComponent(audioUrl)
  );
}

// [C3] 播放命中本地即触碰 lastAccess（LRU 用）；仅更新已存在的行、失败静默。
export function touchDownloadAccess(episodeId) {
  if (!episodeId) return;
  db.episodeDownloads
    .update(episodeId, { lastAccess: Date.now() })
    .catch(() => {});
}

// [C3] 自动缓存占用统计（仅 auto 行）。
export async function getAudioCacheStats() {
  try {
    const rows = await db.episodeDownloads.toArray();
    const auto = rows.filter(r => r && r.status === 'done' && r.auto === true);
    return {
      count: auto.length,
      bytes: auto.reduce((s, r) => s + (r.bytesTotal || 0), 0),
    };
  } catch (e) {
    return { count: 0, bytes: 0 };
  }
}

// [C3] 清空自动缓存（仅 auto 行；逐条二次校验 auto===true 再删，复用 removeDownload 安全删除）。
export async function clearAudioCache() {
  try {
    const rows = await db.episodeDownloads.toArray();
    const auto = rows.filter(r => r && r.auto === true);
    let cleared = 0;
    for (const r of auto) {
      const row = await db.episodeDownloads.get(r.id);
      if (!row || row.auto !== true) continue; // 二次校验：绝不误删手动下载
      const res = await removeDownload(r.id);
      if (!res || res.ok !== false) cleared++;
    }
    return { cleared };
  } catch (e) {
    return { cleared: 0 };
  }
}

// [C3] 淘汰引擎（仅动 auto 行，手动下载永不碰）：
//   TTL(辅)：听完 且 lastAccess 超 7 天 → 主动清回收空间(未听完豁免、不 TTL 删)；
//   体积(主)：仍超预算 → 先删"听完的"(LRU)、不够再删"未听完的"(LRU，最后手段)。
//   删除复用 removeDownload(主进程删文件、删失败不删 DB) + 逐条二次校验 auto===true。
export async function evictAudioCache() {
  try {
    const rows = await db.episodeDownloads.toArray();
    const auto = rows.filter(r => r && r.status === 'done' && r.auto === true);
    if (!auto.length) return { evicted: 0 };
    const ids = auto.map(r => r.id);
    const stats = await db.episodeListenStats.bulkGet(ids).catch(() => []);
    const completed = {};
    auto.forEach((r, i) => {
      completed[r.id] = !!(stats[i] && stats[i].completed);
    });
    const now = Date.now();
    const TTL = 7 * 24 * 3600 * 1000;
    const la = r => r.lastAccess || r.addedAt || 0;
    const bytesOf = r => r.bytesTotal || 0;
    const budget = _audioCacheBudgetBytes();
    let total = auto.reduce((s, r) => s + bytesOf(r), 0);

    const delIds = new Set();
    // (1) TTL：听完 + 超 7 天 → 删（未听完豁免）
    auto.forEach(r => {
      if (completed[r.id] && now - la(r) > TTL) {
        delIds.add(r.id);
        total -= bytesOf(r);
      }
    });
    // (2) 体积：仍超预算 → 听完的(LRU)先删、再未听完的(LRU)
    if (total > budget) {
      const remain = auto.filter(r => !delIds.has(r.id));
      const byLru = (a, b) => la(a) - la(b);
      const order = remain
        .filter(r => completed[r.id])
        .sort(byLru)
        .concat(remain.filter(r => !completed[r.id]).sort(byLru));
      for (const r of order) {
        if (total <= budget) break;
        delIds.add(r.id);
        total -= bytesOf(r);
      }
    }
    // 执行删除：逐条二次校验 auto===true（防 scan→delete 间被用户钉为手动）
    let evicted = 0;
    for (const id of delIds) {
      const row = await db.episodeDownloads.get(id);
      if (!row || row.auto !== true) continue;
      const res = await removeDownload(id);
      if (!res || res.ok !== false) evicted++;
    }
    return { evicted };
  } catch (e) {
    console.warn('[downloads] evictAudioCache 失败', e);
    return { evicted: 0 };
  }
}
