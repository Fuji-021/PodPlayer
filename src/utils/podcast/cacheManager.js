// [缓存·C1] 统一缓存管理：聚合各类缓存的占用统计 + 清理入口，供设置页"缓存管理"使用。
//   现接入：封面缓存（coverCache，Dexie）+ 发现榜单缓存（主进程落盘，经 IPC）。
//   预留扩展：C3 的"单集音频自动缓存"接入同一套接口（提供 stats/clear）即可登记进来。
//   返回的 breakdown 用稳定 key（cover/discover），标签由 UI 按 key 翻译，故本模块不依赖 i18n。
//   本目录(utils/podcast)禁可选链 ?./??，统一用 && + ||。
import { getCoverCacheStats, clearCoverCache } from './coverCache';
import { getAudioCacheStats, clearAudioCache } from './downloads';

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer = (electron && electron.ipcRenderer) || null;

async function discoverStats() {
  if (!ipcRenderer) return { bytes: 0, ts: 0 };
  try {
    const res = await ipcRenderer.invoke('podcast:discoverCacheInfo');
    return { bytes: (res && res.bytes) || 0, ts: (res && res.ts) || 0 };
  } catch (e) {
    return { bytes: 0, ts: 0 };
  }
}

// 返回各类缓存占用（key 稳定；count 可选，bytes 必有，ts 为最近更新时间）
export async function getCacheBreakdown() {
  const cover = await getCoverCacheStats();
  const disc = await discoverStats();
  const audio = await getAudioCacheStats(); // [C3] 自动音频缓存
  return [
    { key: 'cover', count: cover.count, bytes: cover.bytes },
    { key: 'discover', bytes: disc.bytes, ts: disc.ts },
    { key: 'audio', count: audio.count, bytes: audio.bytes },
  ];
}

export async function clearCache(key) {
  if (key === 'cover') {
    await clearCoverCache();
    return;
  }
  if (key === 'audio') {
    await clearAudioCache(); // [C3] 只清 auto 行(二次校验,不碰手动下载)
    return;
  }
  if (key === 'discover' && ipcRenderer) {
    try {
      await ipcRenderer.invoke('podcast:clearDiscoverCache');
    } catch (e) {
      // 忽略
    }
  }
}

export async function clearAllCaches() {
  await clearCache('cover');
  await clearCache('discover');
  await clearCache('audio');
}
