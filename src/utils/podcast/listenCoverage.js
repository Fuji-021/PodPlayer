// Player owns the anchor lifecycle. This module only decides which content
// seconds were crossed without an explicit seek, source rebuild, or playback
// discontinuity. A delayed renderer tick is still continuous when media time
// progressed at the expected playback rate.

export const LISTEN_COVERAGE_RATIO_TOLERANCE = 0.12;
export const LISTEN_COVERAGE_MIN_TOLERANCE_SEC = 0.35;

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
    ratioTolerance = LISTEN_COVERAGE_RATIO_TOLERANCE,
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
  const wallDeltaSec = elapsedMs / 1000;
  const expectedDelta = wallDeltaSec * rate;
  const delta = nextPosition - anchor.position;
  const tolerance = Math.max(
    LISTEN_COVERAGE_MIN_TOLERANCE_SEC,
    expectedDelta * Math.max(0, finiteNumber(ratioTolerance))
  );

  if (elapsedMs <= 0) {
    return {
      anchor: nextAnchor,
      secs: [],
      wallDeltaSec: 0,
      contentDeltaSec: 0,
      continuous: false,
      reason: 'invalid-clock',
    };
  }

  if (delta <= 0.02) {
    return {
      anchor: nextAnchor,
      secs: [],
      wallDeltaSec: 0,
      contentDeltaSec: 0,
      continuous: false,
      reason: delta < 0 ? 'position-reversed' : 'position-stalled',
    };
  }

  if (Math.abs(delta - expectedDelta) > tolerance) {
    return {
      anchor: nextAnchor,
      secs: [],
      wallDeltaSec: 0,
      contentDeltaSec: 0,
      continuous: false,
      reason: 'rate-mismatch',
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
    wallDeltaSec,
    contentDeltaSec: delta,
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

export function shouldFlushListenBuffer(buffer, flushAfterSec) {
  return !!(
    buffer &&
    buffer.count &&
    finiteNumber(buffer.wall) >= Math.max(0, finiteNumber(flushAfterSec))
  );
}

// Keep the buffer hand-off testable: Player swaps in an empty buffer before
// persistence starts, so a subsequent tick can never mutate the old batch.
export function flushListenBuffer(buffer, persist) {
  if (!buffer || !buffer.count || typeof persist !== 'function') return null;

  const id = buffer.id;
  const totalSec = buffer.totalSec;
  const payload = toListenBatchPayload(buffer);
  const nextBuffer = {
    id,
    totalSec,
    secs: [],
    wall: 0,
    content: 0,
    count: 0,
  };
  let promise;
  try {
    promise = Promise.resolve(persist(id, totalSec, payload));
  } catch (error) {
    promise = Promise.reject(error);
  }
  return { nextBuffer, promise };
}
