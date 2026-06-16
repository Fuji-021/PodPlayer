// [播客改造] 播客本地数据访问层（Dexie/IndexedDB）。
// 表结构在 utils/db.js 版本 5 里声明：podcasts / episodes / episodeProgress。
import Dexie from 'dexie';
import { db } from '@/utils/db';

// === 订阅 ===

export function upsertPodcast(podcast) {
  return db.podcasts.put({ ...podcast, updatedAt: Date.now() });
}

// [B-46 / D-3] 局部更新节目记录（不动 updatedAt 等其它字段）。
//   用途：订阅刷新写"新单集数 newCount"角标；进节目详情时清零。
//   newCount 不是索引字段，Dexie 可直接存，无需升 schema 版本。
export function updatePodcast(id, patch) {
  return db.podcasts.update(id, patch || {});
}

export function getAllPodcasts() {
  return db.podcasts.toArray();
}

// [B-50] 只取"已订阅"节目（subscribed!==false；旧数据无此字段→视为已订阅，兼容）。
//   发现页点卡片"预览"的节目入库时 subscribed=false，不出现在我的订阅、不算已订阅状态。
export function getSubscribedPodcasts() {
  return db.podcasts.filter(p => p.subscribed !== false).toArray();
}

// [B-52] 本地搜索：已订阅节目（按 title 包含，忽略大小写）
export async function searchLocalPodcasts(term) {
  const q = String(term || '')
    .trim()
    .toLowerCase();
  if (!q) return [];
  const all = await db.podcasts.filter(p => p.subscribed !== false).toArray();
  return all.filter(p => (p.title || '').toLowerCase().includes(q));
}

// [B-52] 本地搜索：单集标题（限 limit 条，join 所属节目名）
export async function searchLocalEpisodes(term, limit = 30) {
  const q = String(term || '')
    .trim()
    .toLowerCase();
  if (!q) return [];
  const matched = await db.episodes
    .filter(e => e.title && e.title.toLowerCase().includes(q))
    .limit(limit)
    .toArray();
  const podIds = [...new Set(matched.map(e => e.podcastId))];
  const pods = await db.podcasts.bulkGet(podIds);
  const podMap = {};
  podIds.forEach((id, i) => {
    if (pods[i]) podMap[id] = pods[i];
  });
  // [B-63] join 节目封面 + 订阅状态（搜索单集卡片用：左侧显节目封面、状态点判订阅）
  return matched.map(e => {
    const pod = podMap[e.podcastId];
    return {
      ...e,
      podcastTitle: (pod && pod.title) || '',
      podcastCoverUrl: (pod && pod.coverUrl) || e.coverUrl || '',
      podcastSubscribed: pod ? pod.subscribed !== false : false,
    };
  });
}

// [B-63] 按 id 批量取节目（供"为你推荐"把最近听过的 podcastId → 标题，再反查类型）
export async function getPodcastsByIds(ids) {
  if (!ids || !ids.length) return [];
  try {
    return (await db.podcasts.bulkGet(ids)).filter(Boolean);
  } catch (e) {
    return [];
  }
}

export function getPodcast(id) {
  return db.podcasts.get(id);
}

// [B-55/B56-2] 取消订阅 = 软删：只把 podcasts 记录置 subscribed:false，**不删 episodes / 收听统计**。
//   保留 podcasts + episodes 是为了：
//     ① 收听统计 join 到节目名/封面（统计含所有听过的，包括已取消订阅的）；
//     ② 已下载的离线单集 / 收听历史仍能 join 到单集元数据，正常显示与播放（修 B56-2）。
//   "我的订阅"/发现页用 getSubscribedPodcasts 过滤 subscribed===false，所以它不显示在订阅里；
//   重新订阅时 subscribeByRssUrl put 覆盖回 subscribed:true。（取消订阅频率低，保留数据量可控）
export async function deletePodcast(id) {
  // [T1 P1-b] nasRemoveAt 记录取消订阅时间，reconcileNas 满 7 天宽限后删 NAS 档（需用户开启且 armed）
  await db.podcasts.update(id, { subscribed: false, nasRemoveAt: Date.now() });
}

// [F2 / B69-F2] 预览孤儿清理：发现页"预览"(previewByRssUrl)会把 subscribed:false 节目 +
//   其全部单集入库供试听，用户不订阅就成孤儿、长期堆积拖慢 DB。
//   清理判据(全部满足才删，极保守)：
//     · subscribed === false（绝不碰已订阅节目）；
//     · 零互动：无 episodeProgress / episodeListenStats（id 前缀 `pid::`）/ favorites / episodeDownloads
//       → "取消订阅但听过/收藏/下载过"的节目必命中而被保留(其历史是有意保留的，见 deletePodcast)；
//     · updatedAt 距今 > minAgeMs（默认 1h）→ 避开刚预览/正在看的(预览会刷新 updatedAt)。
//   删除内容：该节目的全部 episodes + podcasts 记录。屏蔽节目存在 localStorage(按名)、不在本表，无影响。
export async function prunePreviewOrphans(opts = {}) {
  const minAgeMs = opts.minAgeMs != null ? opts.minAgeMs : 60 * 60 * 1000;
  const excludeId = opts.excludeId || null;
  const now = Date.now();
  let candidates = [];
  try {
    candidates = await db.podcasts
      .filter(p => p && p.subscribed === false)
      .toArray();
  } catch (e) {
    return { pruned: 0, episodesDeleted: 0 };
  }
  let pruned = 0;
  let episodesDeleted = 0;
  for (const p of candidates) {
    const pid = p && p.id;
    if (!pid || pid === excludeId) continue;
    if (p.updatedAt && now - p.updatedAt < minAgeMs) continue; // 太新 → 跳过
    try {
      const prefix = pid + '::';
      if (await db.episodeProgress.where('id').startsWith(prefix).count())
        continue;
      if (await db.episodeListenStats.where('id').startsWith(prefix).count())
        continue;
      if (await db.favorites.where('podcastId').equals(pid).count()) continue;
      if (await db.episodeDownloads.where('podcastId').equals(pid).count())
        continue;
      // 纯预览孤儿 → 删单集 + 节目记录
      const n = await db.episodes.where('podcastId').equals(pid).delete();
      await db.podcasts.delete(pid);
      episodesDeleted += n || 0;
      pruned += 1;
    } catch (e) {
      // 单档失败不影响其它
    }
  }
  return { pruned, episodesDeleted };
}

// === 单集 ===

// [B-83] 截断尾巴检测：小宇宙等把部分节目 shownotes 截断后加"在小宇宙查看完整…"类尾巴。
const TRUNCATED_TAIL_RE =
  /(在|去)小宇宙.{0,12}(完整|文稿|该单集|查看|收听)|查看完整(的)?(单集)?(简介|文稿|节目内容|shownotes)/i;
function isTruncatedDesc(s) {
  if (!s) return false;
  return TRUNCATED_TAIL_RE.test(String(s).slice(-180));
}

// 整批 upsert，新集插入、老集刷新元数据，避免被反复重写已听进度（进度在另一张表）。
// [B-83] 防降级：刷新重抓时若新 description 带截断尾巴 / 明显短于库内旧值，则保留旧的
//   完整简介(及 xyzFull 补全标记)，其余字段照常更新——避免 B-80 后台刷新把已补全/完整的
//   简介覆盖成截断版(本 bug 的传播链就在这条全量覆盖上)。
export async function upsertEpisodes(episodes) {
  if (!episodes?.length) return Promise.resolve();
  try {
    const existing = await db.episodes.bulkGet(episodes.map(e => e.id));
    const exMap = new Map();
    existing.forEach(e => e && exMap.set(e.id, e));
    const merged = episodes.map(e => {
      const old = exMap.get(e.id);
      if (!old) return e;
      const oldDesc = old.description || '';
      const newDesc = e.description || '';
      const downgrade =
        oldDesc.length > newDesc.length &&
        (isTruncatedDesc(newDesc) || newDesc.length < oldDesc.length * 0.6);
      return downgrade
        ? { ...e, description: oldDesc, xyzFull: old.xyzFull }
        : e;
    });
    const res = await db.episodes.bulkPut(merged);
    // [perf·数据层整档重复读] 顺手维护各档 latestPubTime 冗余字段：
    //   "我的订阅"页排序/显示"最新一集时间"原本对每档整档 toArray 取 eps[0]，
    //   现在订阅/刷新写集时记录最大 pubTime，库页直接读 podcasts.latestPubTime 单值。
    await updateLatestPubTime(merged);
    return res;
  } catch (e) {
    // [审P2-6] 内部容错(防御纵深)：DB 读写失败记录后静默、不向上抛，避免新增不包 catch 的调用方回归白屏。
    console.error('[db] upsertEpisodes failed:', (e && e.message) || e);
    return undefined;
  }
}

// [perf·数据层整档重复读] 维护 podcasts.latestPubTime（各档最新一集 pubTime）。
//   非索引字段，Dexie 可直接存，无需升 schema 版本。失败不影响 upsert 主流程
//   （getLatestEpisodeTime 对缺该字段的老数据有整档读回退 + 回写自愈）。
async function updateLatestPubTime(episodes) {
  try {
    const maxByPod = new Map();
    for (const e of episodes) {
      if (!e || !e.podcastId) continue;
      const t = e.pubTime || 0;
      if (t > (maxByPod.get(e.podcastId) || 0)) maxByPod.set(e.podcastId, t);
    }
    for (const [pid, t] of maxByPod) {
      const pod = await db.podcasts.get(pid);
      if (pod && t > (pod.latestPubTime || 0)) {
        await db.podcasts.update(pid, { latestPubTime: t });
      }
    }
  } catch (e) {
    // 非关键：忽略
  }
}

// [B-83] 单集局部更新(补全 shownotes 后写回 description + xyzFull 标记)。
export function updateEpisode(id, patch) {
  return db.episodes.update(id, patch);
}

// [T7·性能·数据层①] 利用 v10 复合索引 [podcastId+pubTime]，DB 层直接排好序后返回，
//   替代旧的 .sortBy('pubTime')（后者先全量取 → 内存排，机核 1000+ 集情况下耗时明显）。
//   between([pid, minKey], [pid, maxKey]) = 取该 podcastId 所有集，reverse() = 最新集在前。
export function getEpisodesByPodcast(podcastId) {
  return db.episodes
    .where('[podcastId+pubTime]')
    .between([podcastId, Dexie.minKey], [podcastId, Dexie.maxKey])
    .reverse()
    .toArray();
}

// [T7·性能·数据层①] 仅取主键列表（episode.id），不反序列化行数据。
//   供 refreshAllSubscriptions 计算新增集数 diff，避免把含 description 等重文本的完整行读进内存。
export function getEpisodeIdsByPodcast(podcastId) {
  return db.episodes.where('podcastId').equals(podcastId).primaryKeys();
}

export function getEpisode(id) {
  return db.episodes.get(id);
}

// [B-47 / 第6点] 每档节目"最近一次收听时间"映射 {podcastId(feedUrl): maxUpdatedAt}。
//   episodeProgress.id = `${feedUrl}::${guid}`，feedUrl 内不含 '::'，故 split('::')[0] 即 podcastId。
//   一次全表扫描聚合，避免每档单查。用于"按最近收听"排序。
export async function getLastListenedByPodcast() {
  const rows = await db.episodeProgress.toArray();
  const map = {};
  rows.forEach(r => {
    const pid = String((r && r.id) || '').split('::')[0];
    if (!pid) return;
    const t = (r && r.updatedAt) || 0;
    if (!map[pid] || t > map[pid]) map[pid] = t;
  });
  return map;
}

// === 播放进度（第 3 步会用上，先把接口预留好） ===

export function saveEpisodeProgress(episodeId, positionSec) {
  return db.episodeProgress.put({
    id: episodeId,
    position: positionSec,
    updatedAt: Date.now(),
  });
}

export function getEpisodeProgress(episodeId) {
  return db.episodeProgress.get(episodeId);
}

// [B-36] 批量取进度：一次 bulkGet 代替 N 次 get。
// 节目详情页原来对每集各发一次 get（百集 = 上百次异步事务 → 列表加载卡）。
export function getEpisodeProgressBulk(ids) {
  return db.episodeProgress.bulkGet(ids);
}

// [B-37] 收听历史：episodeProgress 按 updatedAt 倒序（=最近播放），join 单集元数据 + 节目名 + 听完状态。
export async function getRecentlyPlayed(limit = 100) {
  const progresses = await db.episodeProgress
    .orderBy('updatedAt')
    .reverse()
    .limit(limit)
    .toArray();
  if (!progresses.length) return [];
  const ids = progresses.map(p => p.id);
  const [eps, stats] = await Promise.all([
    db.episodes.bulkGet(ids),
    db.episodeListenStats.bulkGet(ids),
  ]);
  const podcastIds = [...new Set(eps.filter(Boolean).map(e => e.podcastId))];
  const pods = await db.podcasts.bulkGet(podcastIds);
  const podTitle = {};
  podcastIds.forEach((pid, i) => {
    if (pods[i]) podTitle[pid] = pods[i].title;
  });
  return progresses
    .map((p, i) => {
      const ep = eps[i];
      if (!ep) return null;
      return {
        ...ep,
        podcastTitle: podTitle[ep.podcastId] || '',
        position: p.position || 0,
        lastPlayedAt: p.updatedAt || 0,
        completed: !!(stats[i] && stats[i].completed),
      };
    })
    .filter(Boolean);
}

// === 收藏（A-7.1） ===
// 收藏一条单集。entry 至少含 episode 全量字段+ podcastTitle 方便"我的收藏"显示。
export function addFavorite(entry) {
  return db.favorites.put({
    ...entry,
    addedAt: Date.now(),
  });
}

export function removeFavorite(episodeId) {
  return db.favorites.delete(episodeId);
}

export async function isFavorited(episodeId) {
  if (!episodeId) return false;
  const row = await db.favorites.get(episodeId);
  return !!row;
}

export function getAllFavorites() {
  return db.favorites.orderBy('addedAt').reverse().toArray();
}

// 只取 id 数组，给 Vuex state 用作快速判定（不每次都读全表）
export async function getAllFavoriteIds() {
  const all = await db.favorites.toArray();
  return all.map(r => r.id);
}
