// [NAS] 渲染端：NAS 音源解析 + 熔断器。
//
// 低耦合铁律：未启用 / 不可用(nasAlive=false) → resolveNasUrl 直接返回 null，播放零等待
//   直落 CDN；NAS 断网/断电只在"跨过 30s 探测窗"那一次多等 ≤800ms，之后均同步 null。
//   所有网络都在主进程 nasBridge，这里只发 IPC + 维护熔断状态。
//
// 注入点：Player._getAudioSource 的②级（①本地 file:// / ③CDN 两级原文不动）。

// [T1 P1] 订阅对账：读库用
import { getAllPodcasts, updatePodcast } from './db';

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer =
  electron && electron.ipcRenderer ? electron.ipcRenderer : null;

let enabled = false; // 配置启用 + 地址/token/库齐全
let activeName = ''; // 当前激活连接档的名称(toast「来源于X的NAS」用)
let nasAlive = false; // 熔断状态
let lastProbe = 0;
let probing = null; // 进行中的探测(去重)
let heartbeat = null;

// [审P3-4] 渲染端卸载/重载(reload)时清掉心跳 interval —— 原仅在停用时清、无卸载清理，
//   边缘场景(window.location.reload 等)可能叠加游离 interval。危害极小，顺手堵上。
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('beforeunload', () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  });
}

export function isNasEnabled() {
  return enabled && !!ipcRenderer;
}
export function nasStatus() {
  return { enabled, alive: nasAlive };
}
// 当前激活连接档名称（toast「来源于X的NAS」用；未设/未启用为空串）。
export function nasActiveName() {
  return activeName;
}

// [P3] 播放中途 NAS 掉线时由 Player 调用：立即熔断。置 nasAlive=false + 重置 lastProbe，
//   使其后 30s 内 resolveNasUrl 直返 null（直落 CDN、零等待）；30s 后 ensureProbed/心跳
//   自动重探，NAS 恢复则下一集/下次解析自然回到 NAS。不发网络、纯本地状态翻转。
export function markNasDown() {
  nasAlive = false;
  lastProbe = Date.now();
}

// 启动/配置变更后调用：重读主进程状态，启用则探一次 + 起 5min 心跳。
export async function initNas() {
  if (!ipcRenderer) return;
  try {
    const st = await ipcRenderer.invoke('nas:getStatus');
    enabled = !!(st && st.enabled && st.baseUrl && st.hasToken && st.libraryId);
    activeName = (st && st.activeName) || '';
  } catch (e) {
    enabled = false;
    activeName = '';
  }
  if (enabled) {
    probe();
    if (!heartbeat) {
      heartbeat = setInterval(function () {
        if (!enabled) return;
        probe();
        // [T1 P1] 每日对账：每 5 分钟检查一次，但满 24h 才真正跑
        try {
          var lastR = Number(
            window.localStorage.getItem('nasLastReconcileAt') || 0
          );
          if (Date.now() - lastR > 24 * 60 * 60 * 1000) {
            reconcileNas({ trigger: 'daily' }).catch(function () {});
          }
        } catch (e) {
          /* ignore */
        }
      }, 5 * 60 * 1000);
    }
  } else {
    nasAlive = false;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }
}

function probe() {
  if (!ipcRenderer || !enabled) {
    nasAlive = false;
    return Promise.resolve(false);
  }
  if (probing) return probing;
  var wasAlive = nasAlive; // [T1 P1-a] 捕获当前状态，检测 false→true 恢复
  probing = ipcRenderer
    .invoke('nas:probe')
    .then(r => {
      nasAlive = !!(r && r.ok);
      lastProbe = Date.now();
      if (!wasAlive && nasAlive) {
        // NAS 从断线恢复 → 触发一次对账（fire-and-forget）
        reconcileNas({ trigger: 'recovery' }).catch(function () {});
      }
      return nasAlive;
    })
    .catch(() => {
      nasAlive = false;
      lastProbe = Date.now();
      return false;
    })
    .then(v => {
      probing = null;
      return v;
    });
  return probing;
}

// 距上次探测 >30s 才重探(否则用缓存的 nasAlive，零网络)。
function ensureProbed() {
  if (!enabled) return Promise.resolve(false);
  if (Date.now() - lastProbe > 30 * 1000) return probe();
  return Promise.resolve(nasAlive);
}

// 从 track 拆出 podcastId(feedUrl) 与 guid（podcastEpisodeId = `${feedUrl}::${guid}`）。
function splitTrack(track) {
  const podcastId = track.podcastId || '';
  const epId = String(track.podcastEpisodeId || '');
  let guid = '';
  if (podcastId && epId.indexOf(podcastId + '::') === 0) {
    guid = epId.slice(podcastId.length + 2);
  } else {
    const i = epId.indexOf('::');
    guid = i >= 0 ? epId.slice(i + 2) : '';
  }
  return { podcastId: podcastId || epId.split('::')[0], guid };
}

// 解析单集 NAS 流 URL；未启用/不可用/查不到/出错 → null（调用方直落 CDN）。
export async function resolveNasUrl(track) {
  if (!isNasEnabled() || !track || !track.podcastEpisodeId) return null;
  const alive = await ensureProbed();
  if (!alive) return null;
  const { podcastId, guid } = splitTrack(track);
  if (!podcastId) return null;
  try {
    const r = await ipcRenderer.invoke('nas:resolve', {
      podcastId,
      guid,
      audioUrl: track.podcastAudioUrl || '',
    });
    return (r && r.url) || null;
  } catch (e) {
    return null;
  }
}

// 归一化 feedUrl（与主进程 nasBridge.normFeed 同口径）：去协议 + 去尾斜杠，用于 NAS 集合比对。
export function normFeedUrl(u) {
  return String(u || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

// [NAS·状态点] 取"NAS 上有哪些节目"的归一化 feedUrl 集合。未启用/不可用 → 空集(=不显示任何标识)。
export async function nasPodcastSet() {
  if (!isNasEnabled()) return new Set();
  const alive = await ensureProbed();
  if (!alive) return new Set();
  try {
    const r = await ipcRenderer.invoke('nas:podcastSet');
    return new Set((r && r.feeds) || []);
  } catch (e) {
    return new Set();
  }
}

// [NAS·状态点] 取某档在 NAS 上已归档的单集 guid 集合。未启用/不可用 → 空集。
export async function nasEpisodeGuidSet(podcastId) {
  if (!isNasEnabled() || !podcastId) return new Set();
  const alive = await ensureProbed();
  if (!alive) return new Set();
  try {
    const r = await ipcRenderer.invoke('nas:episodeGuids', podcastId);
    return new Set((r && r.guids) || []);
  } catch (e) {
    return new Set();
  }
}

// [审查 R·节流] 预取并发上限 + 在途去重：防"滚动滑过 N 张卡 → N 个 warmPodcast 并发灌爆主进程"。
let _warmInflight = 0;
const _warming = new Set();
const WARM_MAX = 2;

// 预热整档（暖主进程 episodes 缓存）→ 点哪集都秒解析。失败静默、不阻塞。
//   并发≤2、同档在途去重；超限直接丢弃(详情页打开时的按需取数兜底，不影响正确性)。
export function prefetchNasPodcast(podcastId) {
  if (!isNasEnabled() || !podcastId) return;
  if (_warming.has(podcastId) || _warmInflight >= WARM_MAX) return;
  _warming.add(podcastId);
  _warmInflight += 1;
  const done = () => {
    _warming.delete(podcastId);
    _warmInflight -= 1;
  };
  ensureProbed()
    .then(alive => {
      if (!alive) {
        done();
        return;
      }
      ipcRenderer
        .invoke('nas:warmPodcast', podcastId)
        .catch(() => {})
        .then(done);
    })
    .catch(done);
}

// 设置/测试用（P2 设置页接此；P1 可经此启用+配置）。写配置后重读状态+重探。
export async function setNasConfig(cfg) {
  if (!ipcRenderer) return { ok: false };
  let r;
  try {
    r = await ipcRenderer.invoke('nas:setConfig', cfg);
  } catch (e) {
    return { ok: false };
  }
  await initNas();
  return r || { ok: false };
}
export async function testNasConnection() {
  if (!ipcRenderer) return { ok: false };
  const ok = await probe();
  return { ok };
}
// [#16 修]「设置·测试连接」专用：走 nas:probeActive(**不看总开关**)，关态也能真测可达性，不再恒报失败。
//   与 testNasConnection(Navbar"手动重连"——经 probe() 更新模块 nasAlive 驱动状态图标)刻意区分：
//   后者要受总开关短路(关态不跑心跳)，前者只是一次性可达性测试，互不影响。
export async function testNasReachable() {
  if (!ipcRenderer) return { ok: false };
  try {
    const r = await ipcRenderer.invoke('nas:probeActive');
    return r && typeof r.ok === 'boolean' ? r : { ok: false };
  } catch (e) {
    return { ok: false };
  }
}
export async function getNasConfig() {
  if (!ipcRenderer) return null;
  try {
    return await ipcRenderer.invoke('nas:getStatus');
  } catch (e) {
    return null;
  }
}

// ===== [NAS 配置中心] 设置页用：总开关 + 多档管理 + 自动发现库 =====

// 总开关：启用/停用 NAS 就近音源。
export async function setNasEnabled(on) {
  if (!ipcRenderer) return { ok: false };
  try {
    await ipcRenderer.invoke('nas:setConfig', { enabled: on === true });
  } catch (e) {
    return { ok: false };
  }
  await initNas();
  return { ok: true };
}

// 用临时凭据列库(测试 + 自动发现库，免手填 UUID)。
export async function listNasLibraries(baseUrl, token) {
  if (!ipcRenderer) return { ok: false, libraries: [] };
  try {
    return await ipcRenderer.invoke('nas:listLibraries', { baseUrl, token });
  } catch (e) {
    return { ok: false, libraries: [] };
  }
}

export async function listNasProfiles() {
  const empty = { enabled: false, activeProfileId: '', profiles: [] };
  if (!ipcRenderer) return empty;
  try {
    return await ipcRenderer.invoke('nas:listProfiles');
  } catch (e) {
    return empty;
  }
}

export async function saveNasProfile(profile) {
  if (!ipcRenderer) return { ok: false };
  try {
    return await ipcRenderer.invoke('nas:saveProfile', { profile });
  } catch (e) {
    return { ok: false };
  }
}

export async function deleteNasProfile(id) {
  if (!ipcRenderer) return { ok: false };
  try {
    return await ipcRenderer.invoke('nas:deleteProfile', { id });
  } catch (e) {
    return { ok: false };
  }
}

// 一键连接：设为 active 后重读状态 + 重探。
export async function activateNasProfile(id) {
  if (!ipcRenderer) return { ok: false };
  try {
    await ipcRenderer.invoke('nas:activateProfile', { id });
  } catch (e) {
    return { ok: false };
  }
  await initNas();
  return { ok: true };
}

// [NAS 托管·P0] 订阅成功后旁路托管：把该档交给主进程托管到 NAS(创建/确保 autoDownload)。
//   门槛：NAS 未启用 / 无 feedUrl → skip；探活(缓存>30s 才发探测)不通 → skip。fire-and-forget：
//   **永不抛、失败静默**，调用方(service.subscribeByRssUrl)绝不 await、不受其成败影响。
//   托管功能总开关(settings.nasHandoffEnabled)由调用方先判(见 service.nasHandoffOn)。
export async function handoffToNas(feedUrl, title) {
  if (!isNasEnabled() || !feedUrl) return { skipped: 'no-nas' };
  try {
    const alive = await ensureProbed();
    if (!alive) return { skipped: 'nas-down' };
    const r = await ipcRenderer.invoke('nas:handoffSubscription', {
      feedUrl: feedUrl,
      title: title || '',
    });
    return r || { ok: false };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// ===== [T1 NAS P1] 声明式对账 =====

// 读"取消订阅后自动从 NAS 删档"开关（默认关；key 确为 'settings'，同 service.js nasHandoffOn 同源）。
function nasRemoveOn() {
  try {
    var s = JSON.parse(window.localStorage.getItem('settings') || '{}');
    return s.nasRemoveEnabled === true;
  } catch (e) {
    return false;
  }
}

// 读"设备 scope"（local=只在本设备执行删档，shared=多设备共享不删；默认 local）。
function nasDeviceScope() {
  try {
    var s = JSON.parse(window.localStorage.getItem('settings') || '{}');
    var v = s.nasDeviceScope;
    return v === 'shared' ? 'shared' : 'local';
  } catch (e) {
    return 'local';
  }
}

// 私有并发限制器：对 items 数组最多 limit 个并发地执行 fn，供 reconcileNas 使用。
// 注：不从 service.js 导入（会形成循环依赖），此处单独维护一份轻量实现。
function runLimited(items, limit, fn) {
  if (!items || !items.length) return Promise.resolve([]);
  var results = [];
  var idx = 0;
  function next() {
    if (idx >= items.length) return Promise.resolve();
    var item = items[idx++];
    return Promise.resolve()
      .then(function () {
        return fn(item);
      })
      .then(function (r) {
        results.push(r);
        return next();
      })
      .catch(function () {
        results.push(null);
        return next();
      });
  }
  var workers = [];
  var n = Math.min(limit, items.length);
  for (var i = 0; i < n; i++) {
    workers.push(next());
  }
  return Promise.all(workers).then(function () {
    return results;
  });
}

// [T1 P1] 声明式对账主函数：
//   对已订阅节目批量 ensureManaged；对宽限期已过的取消订阅节目批量 removeItem（需四重保险）。
//   触发时机：① NAS 首次/恢复上线(probe false→true) ② 每日心跳 ③ 手动调用。
export async function reconcileNas() {
  if (!isNasEnabled() || !ipcRenderer) return { skipped: 'no-nas' };
  var alive;
  try {
    alive = await ensureProbed();
  } catch (e) {
    return { skipped: 'probe-error' };
  }
  if (!alive) return { skipped: 'nas-down' };
  var pods;
  try {
    pods = await getAllPodcasts();
  } catch (e) {
    return { error: 'db' };
  }
  if (!pods || !pods.length) return { ok: true, ensured: 0, removed: 0 };
  var scope = nasDeviceScope();
  var removeOn = nasRemoveOn();
  var now = Date.now();
  var GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天宽限
  var ensure = [];
  var remove = [];
  for (var i = 0; i < pods.length; i++) {
    var p = pods[i];
    if (!p || !p.id) continue;
    var subscribed = p.subscribed !== false;
    if (!subscribed) {
      // 已取消订阅：有 nasRemoveAt 且超 7 天宽限才入删档桶
      if (!p.nasRemoveAt) continue;
      if (now - p.nasRemoveAt < GRACE_MS) continue;
      remove.push({ feedUrl: p.id });
      continue;
    }
    ensure.push({ feedUrl: p.id, title: p.title || '' });
  }
  // 批量确保托管（最多 3 并发，幂等安全）
  await runLimited(ensure, 3, function (it) {
    return ipcRenderer.invoke('nas:ensureManaged', it).catch(function () {});
  });
  // 批量删档（scope=local + removeOn + armed 四重保险）
  if (scope === 'local' && removeOn && remove.length) {
    var armed = false;
    try {
      armed = window.localStorage.getItem('nasDestructiveArmed') === 'true';
    } catch (e) {
      /* ignore */
    }
    await runLimited(remove, 2, function (it) {
      return ipcRenderer
        .invoke('nas:removeItem', { feedUrl: it.feedUrl, armed: armed })
        .then(function (r) {
          // 真正删成功后清 nasRemoveAt，让本档不再出现在 remove 桶
          if (r && r.ok && !r.dry_run && !r.not_found) {
            return updatePodcast(it.feedUrl, { nasRemoveAt: null }).catch(
              function () {}
            );
          }
        })
        .catch(function () {});
    });
  }
  try {
    window.localStorage.setItem('nasLastReconcileAt', String(now));
  } catch (e) {
    /* ignore */
  }
  return {
    ok: true,
    ensured: ensure.length,
    removed: remove.length,
    scope: scope,
  };
}
