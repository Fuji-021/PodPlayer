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

// defaults.enabled=false：显式保证「未配置/全新安装默认关」（铁律）。
//   仅在 key 缺失时生效——已存在的配置(含用户已开的档)原样保留，不被覆盖。
const store = new Store({ name: 'nas-config', defaults: { enabled: false } });

const UA = 'PodPlayerNAS/0.1';
const ITEMS_TTL = 10 * 60 * 1000; // 库 feedUrl→itemId 映射缓存
const EPS_TTL = 10 * 60 * 1000; // 单档 guid/url→ino 映射缓存
const PROBE_TIMEOUT = 800; // 熔断探测超时
const API_TIMEOUT = 6000; // 解析类请求超时

let itemsCache = null; // { ts, map: { normFeed: itemId } }
const epsCache = {}; // itemId -> { ts, byGuid: {guid:ino}, byUrl: {normUrl:ino} }

// [NAS 配置中心] 简易唯一 id（避免依赖 crypto.randomUUID 的 Node 版本差异）。
function genId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function hostOf(url) {
  const m = String(url || '').match(/^https?:\/\/([^/]+)/i);
  return m ? m[1] : String(url || '');
}

// [NAS 配置中心] 向后兼容：旧的扁平配置(baseUrl/token/libraryId 在顶层) → 迁成 profiles[0]。
function migrateIfNeeded() {
  if (Array.isArray(store.get('profiles'))) return; // 已是新格式
  const baseUrl = String(store.get('baseUrl') || '').replace(/\/+$/, '');
  const token = String(store.get('token') || '');
  const libraryId = String(store.get('libraryId') || '');
  if (baseUrl || token || libraryId) {
    const id = genId();
    store.set('profiles', [
      {
        id,
        name: hostOf(baseUrl),
        baseUrl,
        token,
        libraryId,
        libraryName: '',
        lastConnectedAt: Date.now(),
        createdAt: Date.now(),
      },
    ]);
    store.set('activeProfileId', id);
  } else {
    store.set('profiles', []);
  }
  store.delete('baseUrl');
  store.delete('token');
  store.delete('libraryId');
}

function getProfiles() {
  migrateIfNeeded();
  const p = store.get('profiles');
  return Array.isArray(p) ? p : [];
}

function getActiveProfile() {
  const profiles = getProfiles();
  const activeId = store.get('activeProfileId') || '';
  return profiles.find(p => p && p.id === activeId) || profiles[0] || null;
}

// getCfg：对上层(probe/resolve/...)透明——返回当前激活档的有效配置。
function getCfg() {
  const p = getActiveProfile();
  return {
    enabled: store.get('enabled') === true,
    baseUrl: p ? String(p.baseUrl || '').replace(/\/+$/, '') : '',
    token: p ? String(p.token || '') : '',
    libraryId: p ? String(p.libraryId || '') : '',
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

// [NAS 托管·P0] 写类请求(POST/PATCH)。需 admin/update token；失败由调用方 try/catch 静默吞，
//   绝不抛到打断订阅。本文件主进程域，禁可选链 ?.（全用 && 守卫）。
function authPost(c, path, body) {
  return axios.post(c.baseUrl + path, body, {
    timeout: API_TIMEOUT,
    headers: {
      Authorization: 'Bearer ' + c.token,
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    validateStatus: s => s >= 200 && s < 300,
  });
}
function authPatch(c, path, body) {
  return axios.patch(c.baseUrl + path, body, {
    timeout: API_TIMEOUT,
    headers: {
      Authorization: 'Bearer ' + c.token,
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    validateStatus: s => s >= 200 && s < 300,
  });
}
// [NAS 托管·P0] 取库的首个 folder（创建播客需 folderId+path）。版本差异：folders 可能在
//   顶层或 library 下，逐层判（禁 ?.）。无则返回 null。
async function getFirstFolder(c) {
  const res = await authGet(c, '/api/libraries/' + c.libraryId);
  const d = (res && res.data) || {};
  const lib = d.library ? d.library : d;
  const folders = (lib && lib.folders) || [];
  return folders.length ? folders[0] : null;
}
// 文件名净化：去 NAS/Windows 非法字符，限长，作为 path 末段。
function sanitizeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 80);
}

// [审P2-11] 在途请求(冷缓存时三入口并发去重)
let itemsInflight = null;
const epsInflight = {};

async function ensureItems(c) {
  const now = Date.now();
  if (itemsCache && now - itemsCache.ts < ITEMS_TTL) return itemsCache.map;
  // [审P2-11] 在途去重：冷缓存时 resolve/warm/podcastSet 三入口并发 → 复用同一个在途请求，不发 3 份重复。
  if (itemsInflight) return itemsInflight;
  itemsInflight = (async () => {
    const map = {};
    const LIMIT = 500;
    let total = Infinity;
    // [审P2-11] 分页拉全：原 limit=500 硬上限会让库超 500 档静默漏档。按 total 翻页(上限 40 页=2 万档，防失控)。
    for (let page = 0; page * LIMIT < total && page < 40; page++) {
      const res = await authGet(
        c,
        '/api/libraries/' +
          c.libraryId +
          '/items?limit=' +
          LIMIT +
          '&page=' +
          page
      );
      const data = (res && res.data) || {};
      const results = data.results || [];
      // [审P2-11 修] total 兜底：API 未给 total 时，满页(==LIMIT)→设 Infinity 继续翻(靠下方短页 break 收尾)，
      //   短页→已到底(=已累计)。否则"满页且无 total"会被误判成 total=本页数而停在首页、漏后续档。
      total =
        typeof data.total === 'number'
          ? data.total
          : results.length < LIMIT
          ? page * LIMIT + results.length
          : Infinity;
      results.forEach(it => {
        const meta = (it && it.media && it.media.metadata) || {};
        if (meta.feedUrl && it.id) map[normFeed(meta.feedUrl)] = it.id;
      });
      if (results.length < LIMIT) break;
    }
    itemsCache = { ts: Date.now(), map };
    return map;
  })();
  try {
    return await itemsInflight;
  } finally {
    itemsInflight = null;
  }
}

async function ensureEps(c, itemId) {
  const now = Date.now();
  const cached = epsCache[itemId];
  if (cached && now - cached.ts < EPS_TTL) return cached;
  // [审P2-11] 同档在途去重：避免对同一 itemId 并发发多份 expanded 请求。
  if (epsInflight[itemId]) return epsInflight[itemId];
  epsInflight[itemId] = (async () => {
    const res = await authGet(c, '/api/items/' + itemId + '?expanded=1');
    const eps = (res.data && res.data.media && res.data.media.episodes) || [];
    const byGuid = {};
    const byUrl = {};
    eps.forEach(e => {
      const ino = e && e.audioFile && e.audioFile.ino;
      if (!ino) return;
      if (e.guid) byGuid[String(e.guid)] = ino;
      if (e.enclosure && e.enclosure.url)
        byUrl[normFeed(e.enclosure.url)] = ino;
    });
    const entry = { ts: Date.now(), byGuid, byUrl };
    epsCache[itemId] = entry;
    return entry;
  })();
  try {
    return await epsInflight[itemId];
  } finally {
    delete epsInflight[itemId];
  }
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
  // 状态(不回传 token，只回 hasToken)；渲染端据此判 enabled + 显示当前连接名/库名。
  ipcMain.handle('nas:getStatus', () => {
    const c = getCfg();
    const p = getActiveProfile();
    return {
      enabled: c.enabled,
      baseUrl: c.baseUrl,
      libraryId: c.libraryId,
      hasToken: !!c.token,
      activeProfileId: (p && p.id) || '',
      activeName: (p && p.name) || '',
      libraryName: (p && p.libraryName) || '',
    };
  });

  // 总开关(启用/停用 NAS 就近音源)。配置变更清缓存。档管理走下面的 profile IPC。
  ipcMain.handle('nas:setConfig', (_e, cfg) => {
    const o = cfg || {};
    if ('enabled' in o) store.set('enabled', o.enabled === true);
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

  // [#16 修]「测试连接」专用：**不看总开关(enabled)**，只测当前激活档 baseUrl 的真实可达性。
  //   总开关关闭时只翻 store.enabled、不删档，getCfg 照常返回 baseUrl → 能独立测；
  //   与后台心跳/熔断(nas:probe 的 !enabled 短路)解耦，不破坏"关闭时不跑心跳"的低耦合铁律。
  ipcMain.handle('nas:probeActive', async () => {
    const c = getCfg();
    if (!c.baseUrl) return { ok: false, reason: 'no-config' };
    try {
      await axios.get(c.baseUrl + '/ping', {
        timeout: PROBE_TIMEOUT,
        headers: { 'User-Agent': UA },
        validateStatus: s => s >= 200 && s < 300,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'unreachable' };
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

  // [NAS 托管·P0] 订阅成功后把该档托管到 NAS：
  //   已存在该 feedUrl → 幂等 PATCH /api/items/{id}/media 确保 autoDownload 开 + 上限 100；
  //   不存在 → 取 folder → POST /api/podcasts 创建(autoDownloadEpisodes:true，靠 ABS 自动抓最近 100 集)。
  //   **P0 走路 A：不调 download-episodes、不调任何 DELETE**（破坏面最小）。未就绪/出错一律返回对象、绝不抛，
  //   属订阅后旁路、失败不影响订阅与播放。⚠️ POST body 形态/folder 解析/PATCH 权限需本机 ABS 实测后放量。
  ipcMain.handle('nas:handoffSubscription', async (_e, args) => {
    const c = getCfg();
    if (!ready(c)) return { skipped: 'no-nas' };
    const a = args || {};
    const feedUrl = String(a.feedUrl || '');
    const title = String(a.title || '');
    if (!feedUrl) return { error: 'no-feedurl' };
    try {
      const items = await ensureItems(c);
      const existingId = items[normFeed(feedUrl)] || '';
      if (existingId) {
        await authPatch(c, '/api/items/' + existingId + '/media', {
          autoDownloadEpisodes: true,
          maxNewEpisodesToDownload: 100,
          maxEpisodesToKeep: 100,
        });
        return { ok: true, updated: true };
      }
      const folder = await getFirstFolder(c);
      if (!folder || !folder.id) return { error: 'no-folder' };
      const safe = sanitizeName(title) || normFeed(feedUrl).slice(0, 64);
      const path = folder.fullPath
        ? String(folder.fullPath).replace(/[\\/]+$/, '') + '/' + safe
        : '';
      const body = {
        libraryId: c.libraryId,
        folderId: folder.id,
        path: path,
        media: {
          metadata: { feedUrl: feedUrl, title: title },
          autoDownloadEpisodes: true,
          maxNewEpisodesToDownload: 100,
          maxEpisodesToKeep: 100,
        },
      };
      const res = await authPost(c, '/api/podcasts', body);
      const newId = res && res.data && res.data.id ? res.data.id : '';
      clearCache(); // 新建后让 itemsCache 失效，下次 ensureItems 重拉
      return { ok: true, created: true, itemId: newId };
    } catch (e) {
      return { error: String((e && e.message) || e) };
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

  // [NAS 配置中心] 用临时凭据列库(测试/发现库用，未必已保存)。过滤 podcast 类型 → 免手填 UUID。
  ipcMain.handle('nas:listLibraries', async (_e, args) => {
    const a = args || {};
    const base = String(a.baseUrl || '').replace(/\/+$/, '');
    const token = String(a.token || '');
    if (!base || !token) return { ok: false, error: '地址或 token 为空' };
    try {
      const res = await axios.get(base + '/api/libraries', {
        timeout: 6000,
        headers: {
          Authorization: 'Bearer ' + token,
          'User-Agent': UA,
          Accept: 'application/json',
        },
        validateStatus: s => s >= 200 && s < 300,
      });
      const libs = (res.data && res.data.libraries) || [];
      const out = libs
        .filter(l => l && (l.mediaType === 'podcast' || !l.mediaType))
        .map(l => ({ id: l.id, name: l.name, mediaType: l.mediaType || '' }));
      return { ok: true, libraries: out };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // [NAS 配置中心] 列出连接档(去 token，只回 hasToken)。
  ipcMain.handle('nas:listProfiles', () => {
    const profiles = getProfiles();
    return {
      enabled: store.get('enabled') === true,
      activeProfileId: store.get('activeProfileId') || '',
      profiles: profiles.map(p => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        libraryId: p.libraryId,
        libraryName: p.libraryName || '',
        hasToken: !!p.token,
        lastConnectedAt: p.lastConnectedAt || 0,
        createdAt: p.createdAt || 0,
      })),
    };
  });

  // [NAS 配置中心] 新增/更新一档(含 token，仅主进程存)。无 id=新增；编辑时 token 留空=沿用旧 token。
  ipcMain.handle('nas:saveProfile', (_e, args) => {
    const p = (args && args.profile) || {};
    const baseUrl = String(p.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) return { ok: false, error: '地址为空' };
    const profiles = getProfiles();
    const id = p.id || '';
    const row = {
      id: id || genId(),
      name: String(p.name || '').trim() || hostOf(baseUrl),
      baseUrl,
      token: String(p.token || ''),
      libraryId: String(p.libraryId || ''),
      libraryName: String(p.libraryName || ''),
      lastConnectedAt: 0,
      createdAt: Date.now(),
    };
    const idx = id ? profiles.findIndex(x => x && x.id === id) : -1;
    if (idx >= 0) {
      row.createdAt = profiles[idx].createdAt || row.createdAt;
      row.lastConnectedAt = profiles[idx].lastConnectedAt || 0;
      if (!row.token) row.token = profiles[idx].token || ''; // 编辑不重输 token
      profiles[idx] = row;
    } else {
      profiles.push(row);
    }
    store.set('profiles', profiles);
    clearCache();
    return { ok: true, id: row.id };
  });

  // [NAS 配置中心] 删除一档(若删的是 active，自动切到剩余第一档)。
  ipcMain.handle('nas:deleteProfile', (_e, args) => {
    const id = (args && args.id) || '';
    const profiles = getProfiles().filter(p => p && p.id !== id);
    store.set('profiles', profiles);
    if ((store.get('activeProfileId') || '') === id) {
      store.set('activeProfileId', (profiles[0] && profiles[0].id) || '');
    }
    clearCache();
    return { ok: true };
  });

  // [NAS 配置中心] 一键连接：设为 active + 更新 lastConnectedAt + 清缓存(渲染端随后 initNas 重探)。
  ipcMain.handle('nas:activateProfile', (_e, args) => {
    const id = (args && args.id) || '';
    const profiles = getProfiles();
    const idx = profiles.findIndex(p => p && p.id === id);
    if (idx < 0) return { ok: false };
    profiles[idx].lastConnectedAt = Date.now();
    store.set('profiles', profiles);
    store.set('activeProfileId', id);
    clearCache();
    return { ok: true };
  });
}
