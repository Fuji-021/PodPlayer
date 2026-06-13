// [NAS] 主进程：NAS(Audiobookshelf) 音源桥。
//
// 职责：持 NAS 地址/token(electron-store @ userData/nas-config.json，**不入 git**)；
//   对渲染端暴露 探测/解析/预热 IPC。所有 NAS 网络都在主进程(axios)，规避渲染进程
//   Chromium 代理拦截(同 _getAudioSource 注释 ERR_CONNECTION_CLOSED 前车之鉴)。
//
// 低耦合铁律：未配置/未启用时，渲染端 resolveNasUrl 直接返回 null、这些 IPC 也不被调用；
//   任何失败都返回 {url:null}/{ok:false}，由调用方静默落 CDN。绝不抛到打断播放。
//
// 注：本文件在 src/electron/ 主进程域，按项目约束**不使用可选链 ?. / 空值合并 ??**。
import axios from 'axios';
import { ipcMain } from 'electron';
import Store from 'electron-store';

const store = new Store({ name: 'nas-config' });

const UA = 'PodPlayerNAS/0.1';
const ITEMS_TTL = 10 * 60 * 1000; // 库 feedUrl→itemId 映射缓存
const EPS_TTL = 10 * 60 * 1000; // 单档 guid/url→ino 映射缓存
const PROBE_TIMEOUT = 800; // 熔断探测超时
const API_TIMEOUT = 6000; // 解析类请求超时

let itemsCache = null; // { ts, map: { normFeed: itemId } }
const epsCache = {}; // itemId -> { ts, byGuid: {guid:ino}, byUrl: {normUrl:ino} }

function getCfg() {
  return {
    enabled: store.get('enabled') === true,
    baseUrl: String(store.get('baseUrl') || '').replace(/\/+$/, ''),
    token: String(store.get('token') || ''),
    libraryId: String(store.get('libraryId') || ''),
  };
}

function ready(c) {
  return !!(c.enabled && c.baseUrl && c.token && c.libraryId);
}

// 归一化 feedUrl/enclosure URL 用于匹配：去协议 + 去尾斜杠（容 http/https、尾杂）。
function normFeed(u) {
  return String(u || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

function clearCache() {
  itemsCache = null;
  Object.keys(epsCache).forEach(k => delete epsCache[k]);
}

function authGet(c, path, timeout) {
  return axios.get(c.baseUrl + path, {
    timeout: timeout || API_TIMEOUT,
    headers: {
      Authorization: 'Bearer ' + c.token,
      'User-Agent': UA,
      Accept: 'application/json',
    },
    validateStatus: s => s >= 200 && s < 300,
  });
}

async function ensureItems(c) {
  const now = Date.now();
  if (itemsCache && now - itemsCache.ts < ITEMS_TTL) return itemsCache.map;
  const res = await authGet(
    c,
    '/api/libraries/' + c.libraryId + '/items?limit=500'
  );
  const results = (res.data && res.data.results) || [];
  const map = {};
  results.forEach(it => {
    const meta = (it && it.media && it.media.metadata) || {};
    if (meta.feedUrl && it.id) map[normFeed(meta.feedUrl)] = it.id;
  });
  itemsCache = { ts: now, map };
  return map;
}

async function ensureEps(c, itemId) {
  const now = Date.now();
  const cached = epsCache[itemId];
  if (cached && now - cached.ts < EPS_TTL) return cached;
  const res = await authGet(c, '/api/items/' + itemId + '?expanded=1');
  const eps = (res.data && res.data.media && res.data.media.episodes) || [];
  const byGuid = {};
  const byUrl = {};
  eps.forEach(e => {
    const ino = e && e.audioFile && e.audioFile.ino;
    if (!ino) return;
    if (e.guid) byGuid[String(e.guid)] = ino;
    if (e.enclosure && e.enclosure.url) byUrl[normFeed(e.enclosure.url)] = ino;
  });
  const entry = { ts: now, byGuid, byUrl };
  epsCache[itemId] = entry;
  return entry;
}

function streamUrl(c, itemId, ino) {
  return (
    c.baseUrl +
    '/api/items/' +
    itemId +
    '/file/' +
    ino +
    '?token=' +
    encodeURIComponent(c.token)
  );
}

// podcastId(feedUrl) + guid(首选) / audioUrl(兜底) → 流 URL；任一环节查不到返回 null。
async function resolveStream(c, podcastId, guid, audioUrl) {
  const items = await ensureItems(c);
  const itemId = items[normFeed(podcastId)];
  if (!itemId) return null;
  const eps = await ensureEps(c, itemId);
  let ino = guid ? eps.byGuid[String(guid)] : null;
  if (!ino && audioUrl) ino = eps.byUrl[normFeed(audioUrl)];
  if (!ino) return null;
  return streamUrl(c, itemId, ino);
}

export function registerNasIpc() {
  // 状态(不回传 token，只回 hasToken)；渲染端据此判 enabled。
  ipcMain.handle('nas:getStatus', () => {
    const c = getCfg();
    return {
      enabled: c.enabled,
      baseUrl: c.baseUrl,
      libraryId: c.libraryId,
      hasToken: !!c.token,
    };
  });

  // 写配置（P2 设置页接此；P1 经渲染端 setNasConfig 调用）。配置变更清缓存。
  ipcMain.handle('nas:setConfig', (_e, cfg) => {
    const o = cfg || {};
    if ('enabled' in o) store.set('enabled', o.enabled === true);
    if ('baseUrl' in o)
      store.set('baseUrl', String(o.baseUrl || '').replace(/\/+$/, ''));
    if ('token' in o) store.set('token', String(o.token || ''));
    if ('libraryId' in o) store.set('libraryId', String(o.libraryId || ''));
    clearCache();
    return { ok: true };
  });

  // 健康探测（熔断器用）：仅 /ping，超时 800ms。未启用直接 false。
  ipcMain.handle('nas:probe', async () => {
    const c = getCfg();
    if (!c.enabled || !c.baseUrl) return { ok: false };
    try {
      await axios.get(c.baseUrl + '/ping', {
        timeout: PROBE_TIMEOUT,
        headers: { 'User-Agent': UA },
        validateStatus: s => s >= 200 && s < 300,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false };
    }
  });

  // 解析单集 → 流 URL（含 token）。未就绪/查不到/出错一律 {url:null}。
  ipcMain.handle('nas:resolve', async (_e, args) => {
    const c = getCfg();
    if (!ready(c)) return { url: null };
    const a = args || {};
    try {
      const url = await resolveStream(c, a.podcastId, a.guid, a.audioUrl);
      return { url: url || null };
    } catch (e) {
      return { url: null, error: String((e && e.message) || e) };
    }
  });

  // 预热整档（进节目详情页时暖 episodes 缓存）→ 之后点哪集都命中缓存秒解析。
  ipcMain.handle('nas:warmPodcast', async (_e, podcastId) => {
    const c = getCfg();
    if (!ready(c)) return { ok: false };
    try {
      const items = await ensureItems(c);
      const itemId = items[normFeed(podcastId)];
      if (!itemId) return { ok: false };
      const eps = await ensureEps(c, itemId);
      return { ok: true, count: Object.keys(eps.byGuid).length };
    } catch (e) {
      return { ok: false };
    }
  });

  // [NAS·状态点] 库里所有节目的归一化 feedUrl 集合（供订阅页标"NAS 上有此节目"）。
  ipcMain.handle('nas:podcastSet', async () => {
    const c = getCfg();
    if (!ready(c)) return { feeds: [] };
    try {
      const items = await ensureItems(c);
      return { feeds: Object.keys(items) };
    } catch (e) {
      return { feeds: [] };
    }
  });

  // [NAS·状态点] 某档在 NAS 上已归档的单集 guid 集合（供详情页标"NAS 上有此单集"）。
  ipcMain.handle('nas:episodeGuids', async (_e, podcastId) => {
    const c = getCfg();
    if (!ready(c)) return { guids: [] };
    try {
      const items = await ensureItems(c);
      const itemId = items[normFeed(podcastId)];
      if (!itemId) return { guids: [] };
      const eps = await ensureEps(c, itemId);
      return { guids: Object.keys(eps.byGuid) };
    } catch (e) {
      return { guids: [] };
    }
  });
}
