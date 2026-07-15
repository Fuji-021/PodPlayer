export function shouldFinishSleepAtEnd({
  sleepMode,
  duration,
  progress,
  playing,
}) {
  if (sleepMode !== 'end' || !playing) return false;
  const total = Number(duration) || 0;
  if (total <= 0) return false;
  const position = Math.max(0, Number(progress) || 0);
  return Math.max(0, Math.round(total - position)) <= 2;
}

export function shouldHandleNaturalSleepEnd({ sleepMode, signal }) {
  return (
    sleepMode === 'end' &&
    signal &&
    signal.reason === 'natural-end' &&
    Number.isFinite(signal.token)
  );
}

export function getSleepCompletionPlan({ alreadyStopped, sleepShutdown }) {
  return {
    shouldPause: !alreadyStopped,
    shouldStartShutdown: !!sleepShutdown,
  };
}
