export const STATS_BAR_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)';
export const STATS_BAR_MIN_DURATION_MS = 280;
export const STATS_BAR_MAX_DURATION_MS = 560;
export const STATS_BAR_CLEANUP_SAFETY_MS = 96;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function statBarDurationMs(startPct, targetPct) {
  const distance = Math.abs(finiteNumber(targetPct) - finiteNumber(startPct));
  return Math.round(
    clamp(
      240 + distance * 5,
      STATS_BAR_MIN_DURATION_MS,
      STATS_BAR_MAX_DURATION_MS
    )
  );
}

export function withStatsBarMotion(item, startPct, targetPct, extra) {
  return {
    ...(item || {}),
    ...(extra || {}),
    _target: targetPct,
    _w: startPct,
    _durationMs: statBarDurationMs(startPct, targetPct),
  };
}

export function statsBarCleanupDelayMs(items, safetyMs) {
  const maximumDuration = (Array.isArray(items) ? items : []).reduce(
    (maximum, item) =>
      Math.max(maximum, finiteNumber(item && item._durationMs)),
    0
  );
  const safety =
    safetyMs == null
      ? STATS_BAR_CLEANUP_SAFETY_MS
      : Math.max(0, finiteNumber(safetyMs));
  return Math.round(maximumDuration + safety);
}

export function isCurrentStatsBarAnimation(turn, currentTurn) {
  return turn === currentTurn;
}

// Test-only sampling of the same ease-out curve used by CSS. Runtime motion is
// still performed by the browser's native transition implementation.
export function sampleStatsBarEaseOut(progress) {
  const x = clamp(finiteNumber(progress), 0, 1);
  if (x === 0 || x === 1) return x;
  const cubic = (t, first, second) => {
    const inverse = 1 - t;
    return (
      3 * inverse * inverse * t * first +
      3 * inverse * t * t * second +
      t * t * t
    );
  };
  let lower = 0;
  let upper = 1;
  for (let index = 0; index < 20; index += 1) {
    const middle = (lower + upper) / 2;
    if (cubic(middle, 0.16, 0.3) < x) lower = middle;
    else upper = middle;
  }
  return cubic((lower + upper) / 2, 1, 1);
}
