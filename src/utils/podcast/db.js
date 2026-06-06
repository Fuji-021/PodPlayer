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
