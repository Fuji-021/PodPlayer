// Player owns the anchor lifecycle. This module only decides which content
// seconds were crossed without an explicit seek, source rebuild, or long gap.

export const LISTEN_COVERAGE_MAX_TICK_GAP_MS = 3500;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function createListenCoverageAnchor(position, at = Date.now()) {
  return {
    position: Math.max(0, finiteNumber(position)),
    at: finiteNumber(at, Date.now()),
  };
}

export function advanceListenCoverage(
  anchor,
  {
    position,
    playbackRate = 1,
    totalSec = 0,
    now = Date.now(),
    maxTickGapMs = LISTEN_COVERAGE_MAX_TICK_GAP_MS,
  } = {}
) {
  const nextPosition = Math.max(0, finiteNumber(position));
  const nextNow = finiteNumber(now, Date.now());
  const nextAnchor = createListenCoverageAnchor(nextPosition, nextNow);

  if (
    !anchor ||
    !Number.isFinite(anchor.position) ||
    !Number.isFinite(anchor.at)
  ) {
    return {
      anchor: nextAnchor,
      secs: [],
      contentDeltaSec: 0,
      continuous: false,
      reason: 'unanchored',
    };
  }

  const elapsedMs = nextNow - anchor.at;
  const rate = Math.max(0.5, Math.min(3, finiteNumber(playbackRate, 1)));
  const expectedDelta = (elapsedMs / 1000) * rate;
  const delta = nextPosition - anchor.position;
  const minimumProgress = Math.max(0.03, expectedDelta * 0.2);
  const maximumProgress = expectedDelta + Math.max(0.75, rate * 0.75);

  if (
    elapsedMs <= 0 ||
    elapsedMs > maxTickGapMs ||
    delta < minimumProgress ||
    delta > maximumProgress
  ) {
    return {
      anchor: nextAnchor,
      secs: [],
      contentDeltaSec: 0,
      continuous: false,
      reason: 'discontinuous',
    };
  }

  const maxSec = Math.max(0, Math.floor(finiteNumber(totalSec)) - 1);
  const firstSec = Math.max(0, Math.floor(anchor.position));
  const lastSec = Math.min(maxSec, Math.floor(nextPosition));
  const secs = [];
  for (let sec = firstSec; sec <= lastSec; sec += 1) {
    secs.push(sec);
  }

  return {
    anchor: nextAnchor,
    secs,
    contentDeltaSec: rate,
    continuous: true,
    reason: 'continuous',
  };
}

export function toListenBatchPayload(buffer) {
  return {
    secs: (buffer && buffer.secs) || [],
    wallDeltaSec: (buffer && buffer.wall) || 0,
    contentDeltaSec: (buffer && buffer.content) || 0,
  };
}
