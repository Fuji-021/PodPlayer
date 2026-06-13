// [NAS] 渲染端：NAS 音源解析 + 熔断器。
//
// 低耦合铁律：未启用 / 不可用(nasAlive=false) → resolveNasUrl 直接返回 null，播放零等待
//   直落 CDN；NAS 断网/断电只在"跨过 30s 探测窗"那一次多等 ≤800ms，之后均同步 null。
//   所有网络都在主进程 nasBridge，这里只发 IPC + 维护熔断状态。
//
// 注入点：Player._getAudioSource 的②级（①本地 file:// / ③CDN 两级原文不动）。

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer =
  electron && electron.ipcRenderer ? electron.ipcRenderer : null;

let enabled = false; // 配置启用 + 地址/token/库齐全
let nasAlive = false; // 熔断状态
let lastProbe = 0;
let probing = null; // 进行中的探测(去重)
let heartbeat = null;

export function isNasEnabled() {
  return enabled && !!ipcRenderer;
}
export function nasStatus() {
  return { enabled, alive: nasAlive };
}

// 启动/配置变更后调用：重读主进程状态，启用则探一次 + 起 5min 心跳。
export async function initNas() {
  if (!ipcRenderer) return;
  try {
    const st = await ipcRenderer.invoke('nas:getStatus');
    enabled = !!(st && st.enabled && st.baseUrl && st.hasToken && st.libraryId);
  } catch (e) {
    enabled = false;
  }
  if (enabled) {
    probe();
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        if (enabled) probe();
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
  probing = ipcRenderer
    .invoke('nas:probe')
    .then(r => {
      nasAlive = !!(r && r.ok);
      lastProbe = Date.now();
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

// 进节目详情页预热整档（暖主进程 episodes 缓存）→ 点哪集都秒解析。失败静默、不阻塞。
export function prefetchNasPodcast(podcastId) {
  if (!isNasEnabled() || !podcastId) return;
  ensureProbed().then(alive => {
    if (alive) {
      ipcRenderer.invoke('nas:warmPodcast', podcastId).catch(() => {});
    }
  });
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
export async function getNasConfig() {
  if (!ipcRenderer) return null;
  try {
    return await ipcRenderer.invoke('nas:getStatus');
  } catch (e) {
    return null;
  }
}
