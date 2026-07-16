export const SUBSCRIPTION_EPISODE_COVER_SOURCES = Object.freeze({
  NONE: 'none',
  MEMORY: 'memory',
  PERSISTENT: 'persistent',
  REMOTE: 'remote',
});

export function normalizeSubscriptionEpisodeCoverUrl(value) {
  const raw = String(value || '').trim();
  if (raw.indexOf('http://') === 0) {
    return 'https://' + raw.slice('http://'.length);
  }
  return raw;
}

export function hasSameSubscriptionEpisodeCoverUrl(left, right) {
  const normalizedLeft = normalizeSubscriptionEpisodeCoverUrl(left);
  const normalizedRight = normalizeSubscriptionEpisodeCoverUrl(right);
  return !!normalizedLeft && normalizedLeft === normalizedRight;
}

export function createSubscriptionEpisodeCoverPlan({
  episodeId,
  episodeCoverUrl,
  podcastCoverUrl,
  memoryEpisodeCover,
  memoryPodcastCover,
  reducedMotion,
}) {
  const normalizedEpisode =
    normalizeSubscriptionEpisodeCoverUrl(episodeCoverUrl);
  const normalizedPodcast =
    normalizeSubscriptionEpisodeCoverUrl(podcastCoverUrl);
  const hasDistinctEpisode =
    !!normalizedEpisode &&
    !hasSameSubscriptionEpisodeCoverUrl(normalizedEpisode, normalizedPodcast);
  const memoryEpisode = String(memoryEpisodeCover || '');
  const memoryPodcast = String(memoryPodcastCover || '');

  return {
    episodeId: String(episodeId || ''),
    episodeUrl: hasDistinctEpisode ? normalizedEpisode : '',
    podcastUrl: normalizedPodcast,
    memoryEpisodeUrl: hasDistinctEpisode ? memoryEpisode : '',
    memoryPodcastUrl: memoryPodcast,
    shouldLookupEpisodeCache: hasDistinctEpisode && !memoryEpisode,
    shouldLookupPodcastCache: !!normalizedPodcast && !memoryPodcast,
    episodeSource:
      hasDistinctEpisode && memoryEpisode
        ? SUBSCRIPTION_EPISODE_COVER_SOURCES.MEMORY
        : hasDistinctEpisode
        ? SUBSCRIPTION_EPISODE_COVER_SOURCES.REMOTE
        : SUBSCRIPTION_EPISODE_COVER_SOURCES.NONE,
    reducedMotion: !!reducedMotion,
  };
}

export function isCurrentSubscriptionEpisodeCoverRequest({
  token,
  currentToken,
  episodeId,
  currentEpisodeId,
  source,
  currentSource,
}) {
  return (
    token === currentToken &&
    String(episodeId || '') === String(currentEpisodeId || '') &&
    String(source || '') === String(currentSource || '')
  );
}

export function resolveSubscriptionPodcastCoverSource(
  plan,
  persistentPodcastCover
) {
  const persistent = String(persistentPodcastCover || '');
  if (!plan || !plan.podcastUrl) {
    return { src: '', source: SUBSCRIPTION_EPISODE_COVER_SOURCES.NONE };
  }
  if (plan.memoryPodcastUrl) {
    return {
      src: plan.memoryPodcastUrl,
      source: SUBSCRIPTION_EPISODE_COVER_SOURCES.MEMORY,
    };
  }
  if (persistent) {
    return {
      src: persistent,
      source: SUBSCRIPTION_EPISODE_COVER_SOURCES.PERSISTENT,
    };
  }
  return {
    src: plan.podcastUrl,
    source: SUBSCRIPTION_EPISODE_COVER_SOURCES.REMOTE,
  };
}

export function resolveSubscriptionEpisodeCoverSource(
  plan,
  persistentEpisodeCover
) {
  const persistent = String(persistentEpisodeCover || '');
  if (!plan || !plan.episodeUrl) {
    return { src: '', source: SUBSCRIPTION_EPISODE_COVER_SOURCES.NONE };
  }
  if (plan.memoryEpisodeUrl) {
    return {
      src: plan.memoryEpisodeUrl,
      source: SUBSCRIPTION_EPISODE_COVER_SOURCES.MEMORY,
    };
  }
  if (persistent) {
    return {
      src: persistent,
      source: SUBSCRIPTION_EPISODE_COVER_SOURCES.PERSISTENT,
    };
  }
  return {
    src: plan.episodeUrl,
    source: SUBSCRIPTION_EPISODE_COVER_SOURCES.REMOTE,
  };
}

export function getSubscriptionEpisodeCoverReadyState({
  source,
  reducedMotion,
}) {
  const isMemory = source === SUBSCRIPTION_EPISODE_COVER_SOURCES.MEMORY;
  return {
    visible: source !== SUBSCRIPTION_EPISODE_COVER_SOURCES.NONE,
    animate: !isMemory && !reducedMotion,
    settleImmediately: isMemory || !!reducedMotion,
  };
}

export function shouldPersistSubscriptionEpisodeCover(source) {
  return source === SUBSCRIPTION_EPISODE_COVER_SOURCES.REMOTE;
}

export function getSubscriptionEpisodeCoverFailureState(plan) {
  return {
    episodeSrc: '',
    episodeSource: SUBSCRIPTION_EPISODE_COVER_SOURCES.NONE,
    fallbackSrc: (plan && (plan.memoryPodcastUrl || plan.podcastUrl)) || '',
  };
}
