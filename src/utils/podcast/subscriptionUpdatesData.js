import { db } from '@/utils/db';
import { getSubscribedPodcasts } from './db';
import {
  rankSubscriptionRail,
  sortSubscriptionUpdates,
} from './subscriptionUpdatesRules';

function toMap(rows) {
  const map = new Map();
  (rows || []).forEach(row => {
    if (row && row.id) map.set(row.id, row);
  });
  return map;
}

function subscriptionOrder(podcasts) {
  return [...podcasts]
    .sort((a, b) => {
      const timeA = Number(a && a.updatedAt) || 0;
      const timeB = Number(b && b.updatedAt) || 0;
      if (timeA !== timeB) return timeA - timeB;
      return String(a && a.id).localeCompare(String(b && b.id));
    })
    .reduce((map, podcast, index) => {
      map.set(podcast.id, index);
      return map;
    }, new Map());
}

export async function getSubscriptionUpdatesSnapshot(now = Date.now()) {
  const podcasts = await getSubscribedPodcasts();
  if (!podcasts.length) {
    return {
      podcasts: [],
      episodes: [],
      podcastCount: 0,
      favoriteIds: [],
    };
  }

  const podcastIds = podcasts.map(podcast => podcast.id);
  const episodes = await db.episodes
    .where('podcastId')
    .anyOf(podcastIds)
    .toArray();
  const episodeIds = episodes.map(episode => episode.id);
  const [stats, progresses, favorites, transcripts] = await Promise.all([
    db.episodeListenStats.bulkGet(episodeIds).catch(() => []),
    db.episodeProgress.bulkGet(episodeIds).catch(() => []),
    db.favorites.bulkGet(episodeIds).catch(() => []),
    db.transcripts.bulkGet(episodeIds).catch(() => []),
  ]);

  const podcastById = new Map(podcasts.map(podcast => [podcast.id, podcast]));
  const statsById = toMap(stats);
  const progressById = toMap(progresses);
  const favoriteById = toMap(favorites);
  const transcriptById = toMap(transcripts);
  const subscribedOrder = subscriptionOrder(podcasts);
  const latestByPodcast = new Map();
  const listenByPodcast = new Map();

  const rows = episodes.map((episode, index) => {
    const podcast = podcastById.get(episode.podcastId);
    const statsRow = statsById.get(episode.id);
    const progress = progressById.get(episode.id);
    const transcript = transcriptById.get(episode.id);
    const pubTime = Number(episode.pubTime) || 0;
    const currentLatest = latestByPodcast.get(episode.podcastId) || 0;
    if (pubTime > currentLatest) {
      latestByPodcast.set(episode.podcastId, pubTime);
    }
    const currentListen = listenByPodcast.get(episode.podcastId) || 0;
    listenByPodcast.set(
      episode.podcastId,
      currentListen + Number(statsRow ? statsRow.totalPlayWallSec : 0)
    );
    return {
      ...episode,
      podcastTitle: (podcast && podcast.title) || '',
      podcastCoverUrl: (podcast && podcast.coverUrl) || episode.coverUrl || '',
      podcastSubscribed: !!podcast,
      completed: !!(statsRow && statsRow.completed),
      listenedSec: Number(progress && progress.position) || 0,
      listenStats: statsRow || null,
      favorited: !!favoriteById.get(episode.id),
      transcriptReady: !!(transcript && transcript.status === 'done'),
      stableOrder:
        (subscribedOrder.get(episode.podcastId) || 0) * 1000000 + index,
    };
  });

  const railPodcasts = rankSubscriptionRail(
    podcasts.map(podcast => ({
      ...podcast,
      latestPubTime:
        latestByPodcast.get(podcast.id) || Number(podcast.latestPubTime) || 0,
      listenWallSec: listenByPodcast.get(podcast.id) || 0,
      stableOrder: subscribedOrder.get(podcast.id) || 0,
    })),
    now
  );

  return {
    podcasts: railPodcasts,
    episodes: sortSubscriptionUpdates(rows),
    podcastCount: podcasts.length,
    favoriteIds: [...favoriteById.keys()],
  };
}
