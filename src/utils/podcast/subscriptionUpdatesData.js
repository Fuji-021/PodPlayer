import { db } from '@/utils/db';
import { getSubscribedPodcasts } from './db';
import {
  createSubscriptionUpdateView,
  getLocalDayKey,
  rankSubscriptionRail,
  sortSubscriptionUpdates,
} from './subscriptionUpdatesRules';

const EMPTY_LIST = Object.freeze([]);

const snapshotSession = {
  snapshot: null,
  inFlight: null,
  dirty: true,
  revision: 0,
  version: 0,
  dayKey: '',
};

function freezeList(items) {
  return Object.freeze((items || []).map(item => Object.freeze(item)));
}

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

function viewKey(podcastId, unfinishedOnly) {
  return (podcastId || 'all') + ':' + (unfinishedOnly ? 'unfinished' : 'all');
}

function createViewIndex(episodes, podcastIds) {
  const allByPodcast = new Map();
  const unfinishedByPodcast = new Map();
  podcastIds.forEach(id => {
    allByPodcast.set(id, []);
    unfinishedByPodcast.set(id, []);
  });

  const all = [];
  const unfinished = [];
  episodes.forEach(episode => {
    all.push(episode);
    if (allByPodcast.has(episode.podcastId)) {
      allByPodcast.get(episode.podcastId).push(episode);
    }
    if (!episode.completed) {
      unfinished.push(episode);
      if (unfinishedByPodcast.has(episode.podcastId)) {
        unfinishedByPodcast.get(episode.podcastId).push(episode);
      }
    }
  });

  const index = new Map();
  index.set(viewKey('', false), freezeList(all));
  index.set(viewKey('', true), freezeList(unfinished));
  podcastIds.forEach(id => {
    index.set(viewKey(id, false), freezeList(allByPodcast.get(id)));
    index.set(viewKey(id, true), freezeList(unfinishedByPodcast.get(id)));
  });
  return index;
}

function freezeView(items, now) {
  const view = createSubscriptionUpdateView(items, now);
  return Object.freeze({
    episodes: items,
    groups: freezeList(
      view.groups.map(group => ({
        ...group,
        episodes: freezeList(group.episodes),
      }))
    ),
    flatItems: freezeList(view.flatItems),
    metrics: freezeList(view.metrics),
    totalHeight: view.totalHeight,
  });
}

// The snapshot builder is deliberately pure so its cache and completed-state
// invalidation rules can be regression-tested without opening Dexie.
export function createSubscriptionUpdateSnapshot({
  podcasts = EMPTY_LIST,
  episodes = EMPTY_LIST,
  podcastCount = 0,
  favoriteIds = EMPTY_LIST,
  downloadedIds = EMPTY_LIST,
  now = Date.now(),
  version = 0,
}) {
  const frozenEpisodes = freezeList(episodes);
  const podcastIds = podcasts.map(podcast => podcast.id);
  const viewIndex = createViewIndex(frozenEpisodes, podcastIds);
  const orderByEpisodeId = new Map(
    frozenEpisodes.map((episode, index) => [episode.id, index])
  );
  return Object.freeze({
    version,
    dayKey: getLocalDayKey(now),
    podcasts: freezeList(podcasts),
    episodes: frozenEpisodes,
    podcastCount,
    favoriteIds: Object.freeze([...(favoriteIds || [])]),
    downloadedIds: Object.freeze([...(downloadedIds || [])]),
    // These Maps stay module-private by convention. Vue only receives frozen
    // arrays/views, so the 10k-row snapshot does not become deeply observed.
    _viewIndex: viewIndex,
    _viewCache: new Map(),
    _orderByEpisodeId: orderByEpisodeId,
  });
}

function rebuildSnapshotViews(snapshot, now) {
  if (!snapshot || snapshot.dayKey === getLocalDayKey(now)) return snapshot;
  return Object.freeze({
    ...snapshot,
    dayKey: getLocalDayKey(now),
    _viewCache: new Map(),
  });
}

async function readSparseStatusRows(episodeIdSet, podcastIds) {
  // Progress and listen statistics do not have a podcastId index. Read their
  // actual sparse rows once and intersect with the subscribed episode IDs;
  // do not issue five 10k-key bulkGet calls on every update-page activation.
  // Favorites/downloads/transcripts do have podcastId indexes, so stay on
  // those narrow indexed reads.
  const [stats, progresses, favorites, transcripts, downloads] =
    await Promise.all([
      db.episodeListenStats.toArray().catch(() => []),
      db.episodeProgress.toArray().catch(() => []),
      db.favorites
        .where('podcastId')
        .anyOf(podcastIds)
        .toArray()
        .catch(() => []),
      db.transcripts
        .where('podcastId')
        .anyOf(podcastIds)
        .toArray()
        .catch(() => []),
      db.episodeDownloads
        .where('podcastId')
        .anyOf(podcastIds)
        .toArray()
        .catch(() => []),
    ]);

  const onlyCurrentEpisodes = rows =>
    (rows || []).filter(row => row && episodeIdSet.has(row.id));
  return {
    stats: onlyCurrentEpisodes(stats),
    progresses: onlyCurrentEpisodes(progresses),
    favorites: onlyCurrentEpisodes(favorites),
    transcripts: onlyCurrentEpisodes(transcripts),
    downloads: onlyCurrentEpisodes(downloads),
  };
}

async function buildSnapshot(now, version) {
  const subscribed = await getSubscribedPodcasts();
  if (!subscribed.length) {
    return createSubscriptionUpdateSnapshot({
      version,
      now,
    });
  }

  const podcasts = subscribed.map(podcast => ({
    id: podcast.id,
    title: podcast.title || '',
    coverUrl: podcast.coverUrl || '',
    updatedAt: Number(podcast.updatedAt) || 0,
    latestPubTime: Number(podcast.latestPubTime) || 0,
  }));
  const podcastIds = podcasts.map(podcast => podcast.id);
  const rawEpisodes = await db.episodes
    .where('podcastId')
    .anyOf(podcastIds)
    .toArray();
  const episodeIdSet = new Set(rawEpisodes.map(episode => episode.id));
  const sparse = await readSparseStatusRows(episodeIdSet, podcastIds);
  const podcastById = new Map(podcasts.map(podcast => [podcast.id, podcast]));
  const statsById = toMap(sparse.stats);
  const progressById = toMap(sparse.progresses);
  const favoriteById = toMap(sparse.favorites);
  const transcriptById = toMap(sparse.transcripts);
  const downloadById = toMap(sparse.downloads);
  const subscribedOrder = subscriptionOrder(podcasts);
  const latestByPodcast = new Map();
  const listenByPodcast = new Map();

  const rows = rawEpisodes.map((episode, index) => {
    const podcast = podcastById.get(episode.podcastId);
    const stats = statsById.get(episode.id);
    const progress = progressById.get(episode.id);
    const transcript = transcriptById.get(episode.id);
    const download = downloadById.get(episode.id);
    const pubTime = Number(episode.pubTime) || 0;
    if (pubTime > (latestByPodcast.get(episode.podcastId) || 0)) {
      latestByPodcast.set(episode.podcastId, pubTime);
    }
    listenByPodcast.set(
      episode.podcastId,
      (listenByPodcast.get(episode.podcastId) || 0) +
        (Number(stats && stats.totalPlayWallSec) || 0)
    );

    // Project only row fields used by the update flow. In particular do not
    // copy shownotes/description into a 10k-row Vue render snapshot.
    return {
      id: episode.id,
      podcastId: episode.podcastId,
      guid: episode.guid || '',
      title: episode.title || '',
      pubTime,
      duration: Number(episode.duration) || 0,
      audioUrl: episode.audioUrl || '',
      episodeCoverUrl: episode.coverUrl || '',
      podcastTitle: (podcast && podcast.title) || '',
      podcastCoverUrl: (podcast && podcast.coverUrl) || episode.coverUrl || '',
      podcastSubscribed: true,
      completed: !!(stats && stats.completed),
      listenedSec: Number(progress && progress.position) || 0,
      listenStats: stats
        ? {
            completed: !!stats.completed,
            listenedSec: Number(stats.listenedSec) || 0,
            totalSec: Number(stats.totalSec) || 0,
          }
        : null,
      transcriptReady: !!(transcript && transcript.status === 'done'),
      downloaded: !!(
        download &&
        download.status === 'done' &&
        download.auto !== true
      ),
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

  return createSubscriptionUpdateSnapshot({
    podcasts: railPodcasts,
    episodes: sortSubscriptionUpdates(rows),
    podcastCount: podcasts.length,
    favoriteIds: [...favoriteById.keys()],
    downloadedIds: rows
      .filter(episode => episode.downloaded)
      .map(episode => episode.id),
    now,
    version,
  });
}

export function markSubscriptionUpdatesDirty() {
  snapshotSession.dirty = true;
  snapshotSession.revision += 1;
  return snapshotSession.revision;
}

async function buildLatestSnapshot(now) {
  // A single in-flight loop serialises revisions. A mutation or forced read
  // during a build invalidates that result and all waiters receive the newest
  // stable generation instead of an old promise that happened to resolve late.
  const buildRevision = snapshotSession.revision;
  const snapshot = await buildSnapshot(now, snapshotSession.version + 1);
  if (buildRevision !== snapshotSession.revision) {
    return buildLatestSnapshot(now);
  }

  snapshotSession.snapshot = snapshot;
  snapshotSession.version = snapshot.version;
  snapshotSession.dayKey = snapshot.dayKey;
  snapshotSession.dirty = false;
  return snapshot;
}

export function getSubscriptionUpdateView(
  snapshot,
  { podcastId = '', unfinishedOnly = false, now = Date.now() } = {}
) {
  if (!snapshot || !snapshot._viewCache) return null;
  const requestedKey = viewKey(podcastId, unfinishedOnly);
  const key = snapshot._viewIndex.has(requestedKey)
    ? requestedKey
    : viewKey('', unfinishedOnly);
  const cached = snapshot._viewCache.get(key);
  if (cached) return cached;
  const items = snapshot._viewIndex.get(key);
  if (!items) return null;
  const view = freezeView(items, now);
  snapshot._viewCache.set(key, view);
  return view;
}

export async function getSubscriptionUpdatesSnapshot(options = {}) {
  const normalized =
    typeof options === 'number' ? { now: options } : options || {};
  const now = normalized.now || Date.now();
  const force = !!normalized.force;
  if (force) markSubscriptionUpdatesDirty();
  if (!force && snapshotSession.snapshot && !snapshotSession.dirty) {
    const refreshed = rebuildSnapshotViews(snapshotSession.snapshot, now);
    snapshotSession.snapshot = refreshed;
    snapshotSession.dayKey = refreshed.dayKey;
    return refreshed;
  }
  if (snapshotSession.inFlight) return snapshotSession.inFlight;

  snapshotSession.inFlight = buildLatestSnapshot(now).finally(() => {
    snapshotSession.inFlight = null;
  });
  return snapshotSession.inFlight;
}

export function applySubscriptionUpdateCompletion(
  snapshot,
  episodeId,
  completed,
  now = Date.now()
) {
  if (!snapshot || !episodeId) return snapshot;
  const index = snapshot.episodes.findIndex(
    episode => episode.id === episodeId
  );
  if (index < 0 || snapshot.episodes[index].completed === !!completed) {
    return snapshot;
  }
  const oldEpisode = snapshot.episodes[index];
  const nextEpisode = Object.freeze({
    ...oldEpisode,
    completed: !!completed,
    listenStats: oldEpisode.listenStats
      ? { ...oldEpisode.listenStats, completed: !!completed }
      : null,
  });
  const replaceEpisode = items => {
    const itemIndex = items.findIndex(item => item.id === episodeId);
    if (itemIndex < 0) return items;
    const nextItems = items.slice();
    nextItems[itemIndex] = nextEpisode;
    return Object.freeze(nextItems);
  };
  const removeEpisode = items => {
    const itemIndex = items.findIndex(item => item.id === episodeId);
    if (itemIndex < 0) return items;
    return Object.freeze([
      ...items.slice(0, itemIndex),
      ...items.slice(itemIndex + 1),
    ]);
  };
  const insertEpisodeByOrder = items => {
    const targetOrder = snapshot._orderByEpisodeId.get(episodeId);
    if (!Number.isFinite(targetOrder)) return items;
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const middleOrder = snapshot._orderByEpisodeId.get(items[middle].id);
      if ((Number.isFinite(middleOrder) ? middleOrder : -1) < targetOrder) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return Object.freeze([
      ...items.slice(0, low),
      nextEpisode,
      ...items.slice(low),
    ]);
  };
  const nextIndex = new Map(snapshot._viewIndex);
  const allKey = viewKey('', false);
  const podcastAllKey = viewKey(oldEpisode.podcastId, false);
  const unfinishedKey = viewKey('', true);
  const podcastUnfinishedKey = viewKey(oldEpisode.podcastId, true);
  nextIndex.set(allKey, replaceEpisode(nextIndex.get(allKey) || EMPTY_LIST));
  nextIndex.set(
    podcastAllKey,
    replaceEpisode(nextIndex.get(podcastAllKey) || EMPTY_LIST)
  );
  const addBackToUnfinished = oldEpisode.completed && !completed;
  const removeFromUnfinished = !oldEpisode.completed && completed;
  if (addBackToUnfinished) {
    nextIndex.set(
      unfinishedKey,
      insertEpisodeByOrder(nextIndex.get(unfinishedKey) || EMPTY_LIST)
    );
    nextIndex.set(
      podcastUnfinishedKey,
      insertEpisodeByOrder(nextIndex.get(podcastUnfinishedKey) || EMPTY_LIST)
    );
  } else if (removeFromUnfinished) {
    nextIndex.set(
      unfinishedKey,
      removeEpisode(nextIndex.get(unfinishedKey) || EMPTY_LIST)
    );
    nextIndex.set(
      podcastUnfinishedKey,
      removeEpisode(nextIndex.get(podcastUnfinishedKey) || EMPTY_LIST)
    );
  }
  const nextDayKey = getLocalDayKey(now);
  const nextCache =
    snapshot.dayKey === nextDayKey ? new Map(snapshot._viewCache) : new Map();
  [allKey, podcastAllKey, unfinishedKey, podcastUnfinishedKey].forEach(key =>
    nextCache.delete(key)
  );
  const next = Object.freeze({
    ...snapshot,
    version: snapshot.version + 1,
    dayKey: nextDayKey,
    episodes: replaceEpisode(snapshot.episodes),
    _viewIndex: nextIndex,
    _viewCache: nextCache,
  });
  if (snapshotSession.snapshot === snapshot) {
    snapshotSession.snapshot = next;
    snapshotSession.version = next.version;
    snapshotSession.dayKey = next.dayKey;
  }
  return next;
}
