export function createPlaybackSuspendSnapshot(input) {
  const value = input || {};
  return {
    token: Number(value.token) || 0,
    suspendedAt: Number(value.suspendedAt) || Date.now(),
    trackId: value.trackId || '',
    episodeId: value.episodeId || '',
    wasPlaying: value.wasPlaying === true,
    progress: Math.max(0, Number(value.progress) || 0),
    source: value.source || '',
    sourceToken: Number(value.sourceToken) || 0,
  };
}

export function canHandlePlaybackResume(
  snapshot,
  event,
  handledToken,
  currentTrackId
) {
  if (!snapshot || !event) return false;
  const token = Number(event.token) || 0;
  if (!token || snapshot.token !== token || handledToken === token)
    return false;
  if (!snapshot.trackId || snapshot.trackId !== currentTrackId) return false;
  return true;
}

export function planPlaybackResume(input) {
  const value = input || {};
  if (
    !canHandlePlaybackResume(
      value.snapshot,
      value.event,
      value.handledToken,
      value.currentTrackId
    )
  ) {
    return { action: 'skip', reason: 'stale-or-duplicate' };
  }
  if (value.currentPlaying !== value.snapshot.wasPlaying) {
    return { action: 'skip', reason: 'intent-changed', consume: true };
  }
  if (!value.snapshot.wasPlaying && value.nodeUsable) {
    return { action: 'skip', reason: 'paused-and-healthy', consume: true };
  }
  return {
    action: 'recover',
    autoplay: value.snapshot.wasPlaying,
    progress: value.snapshot.progress,
    consume: true,
  };
}

export function shouldRecoverStalledDownload(task, event, now) {
  if (!task || !event || task.settled || task.canceled) return false;
  if (task.powerSuspendToken !== event.token) return false;
  if (task.powerResumeAttemptedToken === event.token) return false;
  if ((task.bytesDone || 0) > (task.powerResumeBytes || 0)) return false;
  const resumedAt = Number(event.at) || Number(now) || Date.now();
  return (task.lastProgressAt || 0) <= resumedAt;
}

export function decideOutputDeviceFallback(savedDeviceId, devices) {
  const current = savedDeviceId || 'default';
  if (current === 'default') return { fallback: false, reason: 'default' };
  const outputs = Array.isArray(devices)
    ? devices.filter(device => device && device.kind === 'audiooutput')
    : [];
  if (!outputs.length) return { fallback: false, reason: 'no-output-info' };
  if (outputs.some(device => device.deviceId === current)) {
    return { fallback: false, reason: 'available' };
  }
  return { fallback: true, deviceId: 'default', missingDeviceId: current };
}
