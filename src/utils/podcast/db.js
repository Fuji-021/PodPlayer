// [播客改造] 播客本地数据访问层（Dexie/IndexedDB）。
// 表结构在 utils/db.js 版本 5 里声明：podcasts / episodes / episodeProgress。
import { db } from '@/utils/db';

// === 订阅 ===

export function upsertPodcast(podcast) {
  return db.podcasts.put({ ...podcast, updatedAt: Date.now() });
}

export function getAllPodcasts() {
  return db.podcasts.toArray();
}

export function getPodcast(id) {
  return db.podcasts.get(id);
}

export async function deletePodcast(id) {
  await db.episodes.where('podcastId').equals(id).delete();
  await db.podcasts.delete(id);
}

// === 单集 ===

// 整批 upsert，新集插入、老集刷新元数据，避免被反复重写已听进度（进度在另一张表）。
export function upsertEpisodes(episodes) {
  if (!episodes?.length) return Promise.resolve();
  return db.episodes.bulkPut(episodes);
}

export function getEpisodesByPodcast(podcastId) {
  return db.episodes
    .where('podcastId')
    .equals(podcastId)
    .reverse()
    .sortBy('pubTime');
}

export function getEpisode(id) {
  return db.episodes.get(id);
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
