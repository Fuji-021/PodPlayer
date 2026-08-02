export const STATS_BAR_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)';
export const STATS_BAR_MIN_DURATION_MS = 280;
export const STATS_BAR_MAX_DURATION_MS = 560;
export const STATS_MOVE_MIN_DURATION_MS = 300;
export const STATS_MOVE_MAX_DURATION_MS = 650;
export const STATS_BAR_CLEANUP_SAFETY_MS = 96;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteIndex(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
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

export function statMoveRows(oldIndex, newIndex) {
  const oldValue = finiteIndex(oldIndex);
  const newValue = finiteIndex(newIndex);
  if (oldValue == null || newValue == null) return 0;
  return Math.abs(newValue - oldValue);
}

export function statMoveDurationMs(oldIndex, newIndex) {
  const rows = statMoveRows(oldIndex, newIndex);
  return Math.round(
    clamp(
      300 + 70 * Math.sqrt(Math.max(0, rows - 1)),
      STATS_MOVE_MIN_DURATION_MS,
      STATS_MOVE_MAX_DURATION_MS
    )
  );
}

export function withStatsBarMotion(item, startPct, targetPct, extra) {
  const motion = extra || {};
  const oldIndex = finiteIndex(motion.oldIndex);
  const newIndex = finiteIndex(motion.newIndex);
  const resolvedOldIndex = oldIndex == null ? newIndex : oldIndex;
  const resolvedNewIndex = newIndex == null ? oldIndex : newIndex;
  const barDuration = statBarDurationMs(startPct, targetPct);
  const moveRows = statMoveRows(resolvedOldIndex, resolvedNewIndex);
  const moveDuration = statMoveDurationMs(resolvedOldIndex, resolvedNewIndex);
  return {
    ...(item || {}),
    ...motion,
    _target: targetPct,
    _w: startPct,
    oldIndex: resolvedOldIndex,
    newIndex: resolvedNewIndex,
    moveRows,
    barDuration,
    moveDuration,
    motionDuration: Math.max(barDuration, moveDuration),
  };
}

export function statsBarCleanupDelayMs(items, safetyMs) {
  const maximumDuration = (Array.isArray(items) ? items : []).reduce(
    (maximum, item) =>
      Math.max(
        maximum,
        finiteNumber(item && (item.motionDuration || item.barDuration))
      ),
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
