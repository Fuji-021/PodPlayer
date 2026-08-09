export function shouldRemoveQueueEntryAfterHandoff(started) {
  return started !== false;
}

export function getAutoCleanPreviousEpisodeId({
  lastListenCompleted,
  previousEpisodeId,
  currentEpisodeId,
  autoCleanEnabled,
} = {}) {
  if (
    !lastListenCompleted ||
    !autoCleanEnabled ||
    !previousEpisodeId ||
    previousEpisodeId === currentEpisodeId
  ) {
    return '';
  }
  return previousEpisodeId;
}

export function getForwardSeekTarget(current, duration, step = 30) {
  const currentSec = Math.max(0, Number(current) || 0);
  const durationSec = Number(duration);
  const stepSec = Math.max(0, Number(step) || 0);

  // Metadata can arrive after a keyboard/UI seek. Do not turn a valid current
  // position into zero merely because the duration is still unknown.
  if (!Number.isFinite(durationSec) || durationSec <= 0) return currentSec;

  return Math.min(Math.max(0, durationSec - 1), currentSec + stepSec);
}
