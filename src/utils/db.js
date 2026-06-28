import axios from 'axios';
import Dexie from 'dexie';
import store from '@/store';
import { rlog } from '@/utils/log';
// import pkg from "../../package.json";

// [播客改造] 导出 db 实例，供 utils/podcast/db.js 复用，避免多个 Dexie 实例冲突。
export const db = new Dexie('yesplaymusic');

// [封面缓存·治本] v11：新增 coverCache 表（本地持久封面缓存）。
//   背景：部分节目封面托管在国内不稳定的国际 CDN（实测「疯投圈」封面在 Cloudflare 台北节点），
//     且响应头多带 `max-age=0, must-revalidate` → 浏览器每次渲染都要向 CDN 实时重校验，
//     CDN 一抽风 <img> 就在 opacity:0 下长时间空白 =「封面加载很慢」（与图片大小无关，实测仅 15KB）。
//   治本：封面首次成功加载后，把它 canvas 降采样成 ~360px JPEG dataURL 持久化到此表，
//     之后 PodImage 命中即用本地 dataURL、零网络，彻底摆脱国际 CDN 实时往返；全 app 封面统一受益。
//   key = 归一化(http→https)后的封面 url；data = dataURL；ts 供 LRU 淘汰。详见 utils/podcast/coverCache.js。
//   纯新增表、无数据迁移，对现有表零影响。
// [转文字稿·v13] 新增 transcriptDict 表（专名替换词典：节目级 + 全局）。
//   行 { id, scope:'global'|'podcast', podcastId, from, to, createdAt, updatedAt }；
//   id = `${scope}:${podcastId||''}:${from}` 唯一。替换是应用层 pass —— 原始文稿不动、可重算可回退。
//   ⚠️ 节目级作用域防误伤（如「黄忠→黄峥」只在该节目生效，不污染三国话题）。纯新增表、无迁移。
db.version(13).stores({
  podcasts: '&id, feedUrl, updatedAt',
  episodes: '&id, podcastId, pubTime, [podcastId+pubTime]',
  episodeProgress: '&id, updatedAt',
  favorites: '&id, podcastId, addedAt',
  episodeListenStats: '&id, completed, updatedAt',
  episodeDownloads: '&id, podcastId, addedAt',
  listenDaily: '&key, date',
  coverCache: '&url, ts',
  transcripts: '&id, podcastId, createdAt, status',
  transcriptDict: '&id, scope, podcastId',
});

// [转文字稿·v12] 新增 transcripts 表（单集文字稿索引；正文落盘在 userData/transcripts/<sha1(id)>/）。
//   只存索引（状态 + 路径 + 段数/时长），正文 txt/json/srt 在磁盘文件里，表很小。
//   id = episode.id（`${feedUrl}::${guid}`，与 episodes/episodeDownloads 等表同口径）；
//   status: 'running'|'paused'|'done'|'error'（'idle'/未转录=表里无行）；
//   model=引擎名；segPath/txtPath=磁盘绝对路径；segCount=段数；durationMs=音频时长。
//   纯新增表、无迁移（照搬 v11 coverCache 增量法）。备份登记见 utils/podcast/backup.js。
db.version(12).stores({
  podcasts: '&id, feedUrl, updatedAt',
  episodes: '&id, podcastId, pubTime, [podcastId+pubTime]',
  episodeProgress: '&id, updatedAt',
  favorites: '&id, podcastId, addedAt',
  episodeListenStats: '&id, completed, updatedAt',
  episodeDownloads: '&id, podcastId, addedAt',
  listenDaily: '&key, date',
  coverCache: '&url, ts',
  transcripts: '&id, podcastId, createdAt, status',
});

db.version(11).stores({
  podcasts: '&id, feedUrl, updatedAt',
  episodes: '&id, podcastId, pubTime, [podcastId+pubTime]',
  episodeProgress: '&id, updatedAt',
  favorites: '&id, podcastId, addedAt',
  episodeListenStats: '&id, completed, updatedAt',
  episodeDownloads: '&id, podcastId, addedAt',
  listenDaily: '&key, date',
  coverCache: '&url, ts',
});

// [T7·性能·数据层①] v10：episodes 加复合索引 [podcastId+pubTime]，
//   供 getEpisodesByPodcast 利用 IDB 游标排序，免除内存 Array.sortBy（机核 1000+ 集从 JS 排序→DB 排序）。
//   [podcastId+pubTime] 是 Dexie 的"复合索引"语法，IndexedDB 底层建 [feedUrl, pubTime] 联合索引。
db.version(10).stores({
  podcasts: '&id, feedUrl, updatedAt',
  episodes: '&id, podcastId, pubTime, [podcastId+pubTime]',
  episodeProgress: '&id, updatedAt',
  favorites: '&id, podcastId, addedAt',
  episodeListenStats: '&id, completed, updatedAt',
  episodeDownloads: '&id, podcastId, addedAt',
  listenDaily: '&key, date',
});

// [B-37] v9：新增 listenDaily 表（按天×节目聚合收听时长，用于"最近 N 天"统计）
//   key = `${YYYY-MM-DD}::${podcastId}`；wallSec 墙钟秒、contentSec 倍速换算秒
db.version(9).stores({
  podcasts: '&id, feedUrl, updatedAt',
  episodes: '&id, podcastId, pubTime',
  episodeProgress: '&id, updatedAt',
  favorites: '&id, podcastId, addedAt',
  episodeListenStats: '&id, completed, updatedAt',
  episodeDownloads: '&id, podcastId, addedAt',
  listenDaily: '&key, date',
});

// [B-31] v8：新增 episodeDownloads 表（本地已下载文件记录）
//   id = episode.id；filePath = 本地绝对路径；status: 'done'（也保留扩展位）
db.version(8).stores({
  podcasts: '&id, feedUrl, updatedAt',
  episodes: '&id, podcastId, pubTime',
  episodeProgress: '&id, updatedAt',
  favorites: '&id, podcastId, addedAt',
  episodeListenStats: '&id, completed, updatedAt',
  episodeDownloads: '&id, podcastId, addedAt',
});

// [播客改造] v7：新增 episodeListenStats 表（真实收听统计 + 进度标记）
db.version(7).stores({
  podcasts: '&id, feedUrl, updatedAt',
  episodes: '&id, podcastId, pubTime',
  episodeProgress: '&id, updatedAt',
  favorites: '&id, podcastId, addedAt',
  episodeListenStats: '&id, completed, updatedAt',
});

// [播客改造] v6：新增本地收藏表（favorites）
//   favorites: 已收藏的播客单集（id = episode.id；存全量元数据，方便"我的收藏"列表展示）
// ⚠️ Dexie schema 是增量的，但稳妥起见把 v5 的播客 3 表也声明在 v6，
// 防止任何边缘情况下表被误删。
db.version(6).stores({
  podcasts: '&id, feedUrl, updatedAt',
  episodes: '&id, podcastId, pubTime',
  episodeProgress: '&id, updatedAt',
  favorites: '&id, podcastId, addedAt',
});

// [播客改造] v5：新增播客订阅 / 单集 / 单集播放进度三张表。
//   podcasts: 一档节目（id = feedUrl）
//   episodes: 一集（id = `${feedUrl}::${guid}`，按 podcastId/pubTime 建索引方便查询）
//   episodeProgress: 每集已听到的秒数（id = episode.id）
db.version(5).stores({
  podcasts: '&id, feedUrl, updatedAt',
  episodes: '&id, podcastId, pubTime',
  episodeProgress: '&id, updatedAt',
});

db.version(4).stores({
  trackDetail: '&id, updateTime',
  lyric: '&id, updateTime',
  album: '&id, updateTime',
});

db.version(3)
  .stores({
    trackSources: '&id, createTime',
  })
  .upgrade(tx =>
    tx
      .table('trackSources')
      .toCollection()
      .modify(
        track => !track.createTime && (track.createTime = new Date().getTime())
      )
  );

db.version(1).stores({
  trackSources: '&id',
});

let tracksCacheBytes = 0;

async function deleteExcessCache() {
  if (
    store.state.settings.cacheLimit === false ||
    tracksCacheBytes < store.state.settings.cacheLimit * Math.pow(1024, 2)
  ) {
    return;
  }
  try {
    const delCache = await db.trackSources.orderBy('createTime').first();
    await db.trackSources.delete(delCache.id);
    tracksCacheBytes -= delCache.source.byteLength;
    console.debug(
      `[debug][db.js] deleteExcessCacheSucces, track: ${delCache.name}, size: ${delCache.source.byteLength}, cacheSize:${tracksCacheBytes}`
    );
    deleteExcessCache();
  } catch (error) {
    console.debug('[debug][db.js] deleteExcessCacheFailed', error);
  }
}

export function cacheTrackSource(trackInfo, url, bitRate, from = 'netease') {
  if (!process.env.IS_ELECTRON) return;
  const name = trackInfo.name;
  const artist =
    (trackInfo.ar && trackInfo.ar[0]?.name) ||
    (trackInfo.artists && trackInfo.artists[0]?.name) ||
    'Unknown';
  let cover = trackInfo.al.picUrl;
  if (cover.slice(0, 5) !== 'https') {
    cover = 'https' + cover.slice(4);
  }
  axios.get(`${cover}?param=512y512`);
  axios.get(`${cover}?param=224y224`);
  axios.get(`${cover}?param=1024y1024`);
  return axios
    .get(url, {
      responseType: 'arraybuffer',
    })
    .then(response => {
      db.trackSources.put({
        id: trackInfo.id,
        source: response.data,
        bitRate,
        from,
        name,
        artist,
        createTime: new Date().getTime(),
      });
      console.debug(`[debug][db.js] cached track 👉 ${name} by ${artist}`);
      tracksCacheBytes += response.data.byteLength;
      deleteExcessCache();
      return { trackID: trackInfo.id, source: response.data, bitRate };
    });
}

export function getTrackSource(id) {
  // [启动竞态修 2026-06-16] 非数字 id(如播客单集 id)→ Number()=NaN → IndexedDB get 抛
  //   "not a valid key" DataError。网易云缓存以数字 id 为键，播客 id 必不命中 → 返回 null(=未命中)。
  const nid = Number(id);
  if (!Number.isFinite(nid)) return Promise.resolve(null);
  return db.trackSources.get(nid).then(track => {
    if (!track) return null;
    console.debug(
      `[debug][db.js] get track from cache 👉 ${track.name} by ${track.artist}`
    );
    return track;
  });
}

export function cacheTrackDetail(track, privileges) {
  db.trackDetail.put({
    id: track.id,
    detail: track,
    privileges: privileges,
    updateTime: new Date().getTime(),
  });
}

export function getTrackDetailFromCache(ids) {
  return db.trackDetail
    .filter(track => {
      return ids.includes(String(track.id));
    })
    .toArray()
    .then(tracks => {
      const result = { songs: [], privileges: [] };
      ids.map(id => {
        const one = tracks.find(t => String(t.id) === id);
        result.songs.push(one?.detail);
        result.privileges.push(one?.privileges);
      });
      if (result.songs.includes(undefined)) {
        return undefined;
      }
      return result;
    });
}

export function cacheLyric(id, lyrics) {
  db.lyric.put({
    id,
    lyrics,
    updateTime: new Date().getTime(),
  });
}

export function getLyricFromCache(id) {
  // [启动竞态修 2026-06-16] 播客当前曲 id 非数字 → Number()=NaN → get 抛 DataError(=本轮启动期那条未捕获异常)。
  //   播客无网易云歌词缓存 → 直接返回 undefined。
  const nid = Number(id);
  if (!Number.isFinite(nid)) return Promise.resolve(undefined);
  return db.lyric.get(nid).then(result => {
    if (!result) return undefined;
    return result.lyrics;
  });
}

export function cacheAlbum(id, album) {
  db.album.put({
    id: Number(id),
    album,
    updateTime: new Date().getTime(),
  });
}

export function getAlbumFromCache(id) {
  // [启动竞态修 2026-06-16] 非数字 id → NaN → get 抛 DataError；播客无网易云专辑缓存 → 返回 undefined。
  const nid = Number(id);
  if (!Number.isFinite(nid)) return Promise.resolve(undefined);
  return db.album.get(nid).then(result => {
    if (!result) return undefined;
    return result.album;
  });
}

export function countDBSize() {
  const trackSizes = [];
  return db.trackSources
    .each(track => {
      trackSizes.push(track.source.byteLength);
    })
    .then(() => {
      const res = {
        bytes: trackSizes.reduce((s1, s2) => s1 + s2, 0),
        length: trackSizes.length,
      };
      tracksCacheBytes = res.bytes;
      console.debug(
        `[debug][db.js] load tracksCacheBytes: ${tracksCacheBytes}`
      );
      return res;
    });
}

export function clearDB() {
  return new Promise(resolve => {
    db.tables.forEach(function (table) {
      table.clear();
    });
    resolve();
  });
}

// [事故根治] IndexedDB backing-store 兜底
// ----------------------------------------------------------------------------
// 当多个同身份实例抢同一个 LevelDB LOCK，或磁盘库损坏时，db.open() 会抛
// UnknownError / InvalidStateError（"Internal error opening backing store
// for indexedDB.open."）。Dexie 默认惰性打开、抛错后整页白屏。这里主动 open，
// 失败时弹出明确的全屏提示 + 重试/自救引导，而不是静默白屏。
// 详见 docs/调查报告-IndexedDB无法打开.md 与 docs/实例隔离规范.md。

// 另一个连接要升级 schema 却被本连接挡住（极少见，正常会自动协商）→ 提示用户关闭多余窗口。
db.on('blocked', () => {
  console.warn(
    '[db] open blocked：另一个连接正在升级数据库，请关闭其它 PodPlayer 窗口后重试。'
  );
});

// 别的连接升级了版本 → 主动关闭本连接，避免把对方卡死（IndexedDB 标准做法）。
db.on('versionchange', () => {
  console.warn('[db] versionchange：另一实例升级了数据库，关闭本连接。');
  db.close();
});

function showDbFatalOverlay(err) {
  if (typeof document === 'undefined') return;
  const render = () => {
    if (!document.body || document.getElementById('db-fatal-overlay')) return;
    const name = (err && err.name) || 'Error';
    const msg = (err && err.message) || String(err);
    const el = document.createElement('div');
    el.id = 'db-fatal-overlay';
    el.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,.55)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      '-webkit-app-region:no-drag',
    ].join(';');
    el.innerHTML =
      '<div style="max-width:520px;background:#1f1f22;color:#eee;border-radius:16px;' +
      'padding:28px 30px;box-shadow:0 20px 60px rgba(0,0,0,.5);line-height:1.6">' +
      '<div style="font-size:18px;font-weight:600;margin-bottom:10px">本地数据库无法打开</div>' +
      '<div style="font-size:13px;color:#bbb;margin-bottom:14px">' +
      '错误：<code id="db-fatal-name" style="color:#ff8a8a"></code> ' +
      '<span id="db-fatal-msg"></span>' +
      '</div>' +
      '<div style="font-size:13px;color:#ccc;margin-bottom:8px">最可能的原因：' +
      '<b>同时打开了多个 PodPlayer 实例</b>，抢占同一个数据库文件锁；或磁盘库损坏。</div>' +
      '<ul style="font-size:13px;color:#ccc;margin:0 0 18px 18px;padding:0">' +
      '<li>关闭其它 PodPlayer 窗口/实例后点「重试」。</li>' +
      '<li>任务管理器结束多余的 PodPlayer*.exe / electron.exe 进程后重试。</li>' +
      '<li>仍失败可能是磁盘库损坏，参考 docs/调查报告-IndexedDB无法打开.md（§6.2 自救）。</li>' +
      '</ul>' +
      '<div style="text-align:right">' +
      '<button id="db-fatal-retry" style="background:#1db954;color:#fff;border:0;' +
      'border-radius:10px;padding:9px 18px;font-size:14px;font-weight:600;cursor:pointer">重试</button>' +
      '</div></div>';
    document.body.appendChild(el);
    // [事故根治·加固] 变量部分用 textContent 注入，避免 err.message 含标记时破坏 DOM。
    const nameEl = document.getElementById('db-fatal-name');
    if (nameEl) nameEl.textContent = name;
    const msgEl = document.getElementById('db-fatal-msg');
    if (msgEl) msgEl.textContent = '— ' + msg;
    const btn = document.getElementById('db-fatal-retry');
    if (btn) btn.addEventListener('click', () => window.location.reload());
  };
  if (document.body) render();
  else window.addEventListener('DOMContentLoaded', render);
}

// 主动打开数据库；失败按错误类型决定是否弹兜底层。供启动期与按需调用。
export function openDatabase() {
  return db.open().catch(err => {
    const name = err && err.name;
    console.error('[db] open failed:', name, err && err.message);
    try {
      rlog.error('[db] open failed', name, (err && err.message) || String(err));
    } catch (e) {
      /* ignore */
    }
    if (
      name === 'UnknownError' ||
      name === 'InvalidStateError' ||
      name === 'VersionError'
    ) {
      showDbFatalOverlay(err);
    }
    throw err;
  });
}

// 应用启动即尝试打开，第一时间暴露 backing-store 故障（而非等首次查询才白屏）。
// 仅在 Electron 渲染端执行（磁盘 LevelDB 才有锁/损坏问题；纯 web 构建跳过）。
// 下载路径迁移/重挂的一次性恢复见 utils/podcast/downloads.js recoverDownloadsOnce()
// （由 main.js 启动期调用，避免 db.js ↔ downloads.js 循环依赖）。
if (typeof window !== 'undefined' && process.env.IS_ELECTRON) {
  openDatabase().catch(() => {});
}
