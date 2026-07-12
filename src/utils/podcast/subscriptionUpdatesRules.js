export const UPDATE_DATE_BUCKETS = [
  { id: 'today', label: '今天' },
  { id: 'yesterday', label: '昨天' },
  { id: 'this-week', label: '本周更早' },
  { id: 'last-week', label: '上周' },
  { id: 'older', label: '更早' },
];

const BUCKET_ORDER = UPDATE_DATE_BUCKETS.reduce((map, bucket, index) => {
  map[bucket.id] = index;
  return map;
}, {});

function timestampOf(value) {
  if (value instanceof Date) {
    const dateValue = value.getTime();
    return Number.isFinite(dateValue) && dateValue > 0 ? dateValue : 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  const numberValue = Number(value);
  if (Number.isFinite(numberValue) && numberValue > 0) return numberValue;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function dayStart(time) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function mondayStart(time) {
  const date = new Date(dayStart(time));
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return date.getTime();
}

function stableValue(item, fallbackIndex) {
  const value = Number(item && item.stableOrder);
  return Number.isFinite(value) ? value : fallbackIndex;
}

function compareStable(a, b) {
  const stableDelta =
    stableValue(a.item, a.index) - stableValue(b.item, b.index);
  if (stableDelta) return stableDelta;
  return String(a.item && a.item.id).localeCompare(String(b.item && b.item.id));
}

export function getUpdateDateBucket(pubTime, now = Date.now()) {
  const value = timestampOf(pubTime);
  if (!value) return 'older';

  const today = dayStart(now);
  const yesterday = today - 24 * 60 * 60 * 1000;
  const thisWeek = mondayStart(now);
  const lastWeek = thisWeek - 7 * 24 * 60 * 60 * 1000;

  if (value >= today) return 'today';
  if (value >= yesterday) return 'yesterday';
  if (value >= thisWeek) return 'this-week';
  if (value >= lastWeek) return 'last-week';
  return 'older';
}

export function sortSubscriptionUpdates(items) {
  return (items || [])
    .map((item, index) => ({
      item,
      index,
      pubTime: timestampOf(item && item.pubTime),
    }))
    .sort((a, b) => {
      if (a.pubTime && b.pubTime && a.pubTime !== b.pubTime) {
        return b.pubTime - a.pubTime;
      }
      if (a.pubTime && !b.pubTime) return -1;
      if (!a.pubTime && b.pubTime) return 1;
      return compareStable(a, b);
    })
    .map(entry => entry.item);
}

export function filterSubscriptionUpdates(
  items,
  { podcastId = '', unfinishedOnly = false } = {}
) {
  return (items || []).filter(item => {
    if (!item || item.podcastSubscribed === false) return false;
    if (podcastId && item.podcastId !== podcastId) return false;
    return !unfinishedOnly || item.completed !== true;
  });
}

export function groupSubscriptionUpdates(items, now = Date.now()) {
  const groups = UPDATE_DATE_BUCKETS.map(bucket => ({
    ...bucket,
    episodes: [],
  }));
  const byId = groups.reduce((map, group) => {
    map[group.id] = group;
    return map;
  }, {});

  sortSubscriptionUpdates(items).forEach(item => {
    byId[getUpdateDateBucket(item && item.pubTime, now)].episodes.push(item);
  });

  return groups.filter(group => group.episodes.length);
}

export function rankSubscriptionRail(podcasts, now = Date.now()) {
  return (podcasts || [])
    .map((podcast, index) => {
      const latestPubTime = timestampOf(podcast && podcast.latestPubTime);
      return {
        podcast,
        index,
        latestPubTime,
        hasValidLatest: latestPubTime > 0,
        bucket: latestPubTime
          ? getUpdateDateBucket(latestPubTime, now)
          : 'older',
        listenSec: Number(podcast && podcast.listenWallSec) || 0,
      };
    })
    .sort((a, b) => {
      if (a.hasValidLatest !== b.hasValidLatest) {
        return a.hasValidLatest ? -1 : 1;
      }
      if (a.hasValidLatest) {
        const bucketDelta = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
        if (bucketDelta) return bucketDelta;
      }
      if (a.listenSec !== b.listenSec) return b.listenSec - a.listenSec;
      if (a.latestPubTime !== b.latestPubTime) {
        return b.latestPubTime - a.latestPubTime;
      }
      return compareStable(a, b);
    })
    .map(entry => entry.podcast);
}

export function getRailMetrics({
  scrollLeft = 0,
  clientWidth = 0,
  scrollWidth = 0,
} = {}) {
  const width = Math.max(0, Number(clientWidth) || 0);
  const content = Math.max(0, Number(scrollWidth) || 0);
  const maxScroll = Math.max(0, content - width);
  const left = Math.max(0, Math.min(maxScroll, Number(scrollLeft) || 0));
  const visibleRatio = content > 0 ? Math.min(1, width / content) : 1;
  return {
    scrollLeft: left,
    maxScroll,
    visibleRatio,
    canScroll: maxScroll > 1,
    canPrev: left > 1,
    canNext: left < maxScroll - 1,
  };
}

export function getRailArrowTarget({
  scrollLeft = 0,
  clientWidth = 0,
  scrollWidth = 0,
  direction = 1,
} = {}) {
  const metrics = getRailMetrics({ scrollLeft, clientWidth, scrollWidth });
  const step = Math.max(0, Number(clientWidth) || 0) * 0.7;
  const target = metrics.scrollLeft + (direction < 0 ? -step : step);
  return Math.max(0, Math.min(metrics.maxScroll, target));
}

export function getRailThumbDragTarget({
  startScrollLeft = 0,
  startPointerX = 0,
  pointerX = 0,
  trackWidth = 0,
  thumbWidth = 0,
  maxScroll = 0,
} = {}) {
  const travel = Math.max(0, Number(trackWidth) - Number(thumbWidth));
  const max = Math.max(0, Number(maxScroll) || 0);
  if (!travel || !max) return 0;
  const delta = Number(pointerX) - Number(startPointerX);
  const target = Number(startScrollLeft) + (delta / travel) * max;
  return Math.max(0, Math.min(max, target));
}

export function flattenUpdateGroups(groups) {
  const rows = [];
  (groups || []).forEach(group => {
    rows.push({
      type: 'group',
      key: 'group:' + group.id,
      group,
    });
    group.episodes.forEach(episode => {
      rows.push({
        type: 'episode',
        key: 'episode:' + episode.id,
        episode,
      });
    });
  });
  return rows;
}
