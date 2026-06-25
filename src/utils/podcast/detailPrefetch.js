// [缓存·C2] 节目详情预取 / 空闲预热：把详情(节目 meta + 单集列表 + 进度/收听统计)读进
//   L1 内存缓存 [[episodeCache]]，使 hover(L2) 或启动空闲(L3) 之后**点开秒显**——
//   点开时 podcastDetail.load() 命中 getEpisodeCache 即首帧呈现(再后台从 Dexie 校正)。
//
// 关键约束：
//   · **只读本地 Dexie**(getPodcast 命中=已订阅/已入库)，未入库节目直接放弃，**绝不触网**(hover 不该发请求)。
//   · **零副作用**：不像 load() 那样清 newCount 角标 / 不跑 shownotes 补全 / 不暖 NAS——那些是"真正打开"才该发生的。
//   · 写入的 mapped 结构与 podcastDetail.load() 完全一致({...ep, listenedSec, listenStats})，命中后 load 可直接用。
//   · 在途去重 + 已缓存跳过；失败全静默(点开时 load 仍会正常读取)。
//   本目录(utils/podcast)禁可选链 ?./??，统一 && / ||。
import { getEpisodeCache, setEpisodeCache } from './episodeCache';
import { getPodcast, getEpisodesByPodcast, getEpisodeProgressBulk } from './db';
import { getListenStatsBulk } from './listening';

const _pending = new Set();

export async function prefetchDetail(feedUrl) {
  if (!feedUrl) return;
  if (getEpisodeCache(feedUrl)) return; // 已在 L1 → 无需预取
  if (_pending.has(feedUrl)) return; // 在途去重
  _pending.add(feedUrl);
  try {
    const podcast = await getPodcast(feedUrl);
    if (!podcast) return; // 非本地节目(未订阅/未预览) → 不预取、不触网
    if (getEpisodeCache(feedUrl)) return; // 期间已被别处填充
    const eps = await getEpisodesByPodcast(feedUrl);
    const ids = eps.map(e => e.id);
    const [progresses, stats] = await Promise.all([
      getEpisodeProgressBulk(ids).catch(() => []),
      getListenStatsBulk(ids).catch(() => []),
    ]);
    const mapped = eps.map((ep, i) => ({
      ...ep,
      listenedSec: (progresses[i] && progresses[i].position) || 0,
      listenStats: stats[i] || null,
    }));
    if (!getEpisodeCache(feedUrl)) {
      setEpisodeCache(feedUrl, { podcast, episodes: mapped });
    }
  } catch (e) {
    // 预取失败静默
  } finally {
    _pending.delete(feedUrl);
  }
}

// [L3] 空闲预热一批 feedUrl(去重、逐档 idle 串行)，给"最可能点开"的节目(如最近听过)暖 L1。
//   串行 + requestIdleCallback：不一次性并发占主线程/IDB；无 ric 时回退 setTimeout。
export function prewarmDetails(feedUrls, limit) {
  const list = (feedUrls || []).filter(Boolean).slice(0, limit || 8);
  let i = 0;
  const step = () => {
    if (i >= list.length) return;
    const url = list[i++];
    prefetchDetail(url).finally(() => schedule(step));
  };
  schedule(step);
}

function schedule(fn) {
  if (typeof window !== 'undefined' && window.requestIdleCallback) {
    window.requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 200);
  }
}
