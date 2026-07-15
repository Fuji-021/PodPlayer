export const UPDATE_DATE_BUCKETS = [
  { id: 'today', label: '今天' },
  { id: 'yesterday', label: '昨天' },
  { id: 'this-week', label: '本周更早' },
  { id: 'last-week', label: '上周' },
  { id: 'last-month', label: '上个月' },
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

function atLocalDayStart(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function moveLocalDays(date, days) {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

function mondayStart(value) {
  const date = atLocalDayStart(value);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date;
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

export function getLocalDayKey(now = Date.now()) {
  const date = new Date(now);
  return [date.getFullYear(), date.getMonth(), date.getDate()].join('-');
}

export function getUpdateDateBucket(pubTime, now = Date.now()) {
  const value = timestampOf(pubTime);
  if (!value) return 'older';

  // Always move calendar dates through Date#setDate. A fixed 24-hour offset
  // would put rows in the wrong bucket across a local DST boundary.
  const today = atLocalDayStart(now);
  const yesterday = moveLocalDays(today, -1);
  const thisWeek = mondayStart(now);
  const lastWeek = moveLocalDays(thisWeek, -7);
  const lastMonth = moveLocalDays(today, -30);

  if (value >= today.getTime()) return 'today';
  if (value >= yesterday.getTime()) return 'yesterday';
  if (value >= thisWeek.getTime()) return 'this-week';
  if (value >= lastWeek.getTime()) return 'last-week';
  if (value >= lastMonth.getTime()) return 'last-month';
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

export function resolveSubscriptionSelection(podcasts, selectedPodcastId) {
  if (!selectedPodcastId) return '';
  return (podcasts || []).some(
    podcast => podcast && podcast.id === selectedPodcastId
  )
    ? selectedPodcastId
    : '';
}

export function countPendingSubscriptionEpisodes(
  currentEpisodes,
  nextEpisodes
) {
  const shownIds = new Set(
    (currentEpisodes || []).map(item => item && item.id)
  );
  return (nextEpisodes || []).reduce(
    (count, item) => count + (item && shownIds.has(item.id) ? 0 : 1),
    0
  );
}

export function groupSortedSubscriptionUpdates(items, now = Date.now()) {
  const groups = UPDATE_DATE_BUCKETS.map(bucket => ({
    ...bucket,
    episodes: [],
  }));
  const byId = groups.reduce((map, group) => {
    map[group.id] = group;
    return map;
  }, {});

  (items || []).forEach(item => {
    byId[getUpdateDateBucket(item && item.pubTime, now)].episodes.push(item);
  });

  return groups.filter(group => group.episodes.length);
}

export function groupSubscriptionUpdates(items, now = Date.now()) {
  return groupSortedSubscriptionUpdates(sortSubscriptionUpdates(items), now);
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

export function buildFixedUpdateMetrics(
  flatItems,
  { rowHeight = 96, groupHeight = 34 } = {}
) {
  let top = 0;
  return (flatItems || []).map(item => {
    const height = item.type === 'group' ? groupHeight : rowHeight;
    const metric = { ...item, top, height };
    top += height;
    return metric;
  });
}

export function findFixedVirtualIndex(metrics, offset) {
  const items = metrics || [];
  if (!items.length) return 0;
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const metric = items[middle];
    if (metric.top + metric.height <= offset) low = middle + 1;
    else high = middle;
  }
  // Scroll containers can report an offset at or one pixel beyond totalHeight.
  // Clamp it to the final real row so the tail never becomes an empty window.
  return Math.min(items.length - 1, low);
}

export function createSubscriptionUpdateView(items, now = Date.now(), heights) {
  const groups = groupSortedSubscriptionUpdates(items, now);
  const flatItems = flattenUpdateGroups(groups);
  const metrics = buildFixedUpdateMetrics(flatItems, heights);
  const last = metrics[metrics.length - 1];
  return {
    episodes: items || [],
    groups,
    flatItems,
    metrics,
    totalHeight: last ? last.top + last.height : 0,
  };
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

export const RAIL_EDGE_EPSILON = 0.01;

function clampRailPosition(scrollLeft, maxScroll) {
  const max = Math.max(0, Number(maxScroll) || 0);
  return Math.max(0, Math.min(max, Number(scrollLeft) || 0));
}

export function getRailPositionMetrics(
  { maxScroll = 0, visibleRatio = 1 } = {},
  scrollLeft = 0
) {
  const max = Math.max(0, Number(maxScroll) || 0);
  const left = clampRailPosition(scrollLeft, max);
  return {
    scrollLeft: left,
    maxScroll: max,
    visibleRatio,
    canScroll: max > RAIL_EDGE_EPSILON,
    canPrev: left > RAIL_EDGE_EPSILON,
    canNext: left < max - RAIL_EDGE_EPSILON,
  };
}

export function getRailMetrics({
  scrollLeft = 0,
  clientWidth = 0,
  scrollWidth = 0,
} = {}) {
  const width = Math.max(0, Number(clientWidth) || 0);
  const content = Math.max(0, Number(scrollWidth) || 0);
  const maxScroll = Math.max(0, content - width);
  const visibleRatio = content > 0 ? Math.min(1, width / content) : 1;
  return getRailPositionMetrics({ maxScroll, visibleRatio }, scrollLeft);
}

export function getRailThumbGeometry({
  trackWidth = 0,
  visibleRatio = 1,
  canScroll = false,
  compact = false,
} = {}) {
  const width = Math.max(0, Number(trackWidth) || 0);
  if (!canScroll || !width) return { width: 0, travel: 0 };
  const min = compact ? 48 : 64;
  const max = compact ? 96 : 160;
  const naturalWidth = width * Math.max(0, Math.min(1, visibleRatio));
  const visualWidth = Math.min(max, Math.max(min, naturalWidth / 3));
  const thumbWidth = Math.min(width, visualWidth);
  return { width: thumbWidth, travel: Math.max(0, width - thumbWidth) };
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

export function getRailArrowGoal({
  scrollLeft = 0,
  goal = null,
  goalDirection = null,
  clientWidth = 0,
  scrollWidth = 0,
  direction = 1,
} = {}) {
  const normalizedDirection = direction < 0 ? -1 : 1;
  const canAccumulate =
    Number.isFinite(goal) &&
    (goalDirection == null || goalDirection === normalizedDirection);
  const base = canAccumulate ? goal : scrollLeft;
  return getRailArrowTarget({
    scrollLeft: base,
    clientWidth,
    scrollWidth,
    direction: normalizedDirection,
  });
}

/**
 * The amount of neighboring context we keep visible when selecting a rail
 * item. It is intentionally mirrored on both sides: one cover plus its gap,
 * capped to half of the remaining viewport so narrow rails stay usable.
 */
export function getRailSelectionContextDistance({
  clientWidth = 0,
  itemWidth = 0,
  gap = 0,
} = {}) {
  const viewport = Math.max(0, Number(clientWidth) || 0);
  const cover = Math.max(0, Number(itemWidth) || 0);
  const spacing = Math.max(0, Number(gap) || 0);
  return Math.max(0, Math.min(cover + spacing, (viewport - cover) / 2));
}

/**
 * Returns the scroll position that keeps a selected item inside a symmetric
 * safe zone and, where possible, fully reveals one neighboring cover. The
 * DOM is measured only by the caller at selection time; rAF frames only use
 * the result as a target.
 */
export function getRailSelectionContextTarget({
  scrollLeft = 0,
  clientWidth = 0,
  scrollWidth = 0,
  itemLeft = 0,
  itemWidth = 0,
  gap = 0,
  hasPrev = false,
  hasNext = false,
  epsilon = RAIL_EDGE_EPSILON,
} = {}) {
  const metrics = getRailMetrics({ scrollLeft, clientWidth, scrollWidth });
  const viewport = Math.max(0, Number(clientWidth) || 0);
  const left = Math.max(0, Number(itemLeft) || 0);
  const width = Math.max(0, Number(itemWidth) || 0);
  const right = left + width;
  const context = getRailSelectionContextDistance({
    clientWidth: viewport,
    itemWidth: width,
    gap,
  });
  const tolerance = Math.max(0, Number(epsilon) || 0);
  const safeLeft = metrics.scrollLeft + (hasPrev ? context : 0);
  const safeRight = metrics.scrollLeft + viewport - (hasNext ? context : 0);
  let target = metrics.scrollLeft;

  if (left < safeLeft - tolerance) {
    target = left - (hasPrev ? context : 0);
  } else if (right > safeRight + tolerance) {
    target = right - viewport + (hasNext ? context : 0);
  }

  return clampRailPosition(target, metrics.maxScroll);
}

/**
 * Normalizes controller decisions so selection, arrow clicks and reduced
 * motion all share the same target clamping and no stale goal survives an
 * interruption.
 */
export function getRailMotionDecision({
  scrollLeft = 0,
  goal = 0,
  maxScroll = 0,
  reducedMotion = false,
  interrupted = false,
} = {}) {
  const current = clampRailPosition(scrollLeft, maxScroll);
  const target = interrupted ? current : clampRailPosition(goal, maxScroll);
  const shouldAnimate =
    !interrupted && !reducedMotion && Math.abs(target - current) >= 0.75;
  return {
    target,
    shouldAnimate,
    immediate: interrupted || reducedMotion || !shouldAnimate,
  };
}

/**
 * Advances the rail toward its current target without retaining an obsolete
 * animation origin. A new arrow click can retarget from the exact visible
 * position instead of restarting an easing curve and jumping.
 */
export function getRailMotionStep({
  scrollLeft = 0,
  goal = 0,
  maxScroll = 0,
  deltaMs = 16,
} = {}) {
  const max = Math.max(0, Number(maxScroll) || 0);
  const current = Math.max(0, Math.min(max, Number(scrollLeft) || 0));
  const target = Math.max(0, Math.min(max, Number(goal) || 0));
  const distance = target - current;
  if (Math.abs(distance) < 0.75) return target;

  // A short catch-up is responsive at 60 Hz and remains continuous when an
  // arrow click changes the target before the prior motion settles.
  const frame = Math.min(64, Math.max(0, Number(deltaMs) || 0));
  const progress = 1 - Math.exp(-frame / 36);
  const next = current + distance * progress;
  return Math.max(0, Math.min(max, next));
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

export function getStableVirtualRange({
  itemCount = 0,
  firstVisible = 0,
  lastVisible = 0,
  currentStart = 0,
  currentEnd = 0,
  buffer = 12,
  guard = 4,
  force = false,
} = {}) {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  if (!count) return { start: 0, end: 0, changed: false };

  const first = Math.max(
    0,
    Math.min(count - 1, Math.floor(Number(firstVisible) || 0))
  );
  const last = Math.max(
    first,
    Math.min(count - 1, Math.floor(Number(lastVisible) || first))
  );
  const overscan = Math.max(0, Math.floor(Number(buffer) || 0));
  const safeGuard = Math.max(
    0,
    Math.min(overscan, Math.floor(Number(guard) || 0))
  );
  const oldStart = Math.max(0, Math.floor(Number(currentStart) || 0));
  const oldEnd = Math.min(count, Math.floor(Number(currentEnd) || 0));
  const currentValid = oldEnd > oldStart;
  const safeStart = oldStart === 0 ? 0 : oldStart + safeGuard;
  const safeEnd = oldEnd === count ? count : oldEnd - safeGuard;

  if (!force && currentValid && first >= safeStart && last + 1 <= safeEnd) {
    return { start: oldStart, end: oldEnd, changed: false };
  }

  const start = Math.max(0, first - overscan);
  const end = Math.min(count, last + overscan + 1);
  return {
    start,
    end,
    changed: start !== oldStart || end !== oldEnd,
  };
}
