// Podcast artwork is allowed to use the browser's native external drag by
// default. Keep the policy at cover component boundaries so article images and
// queue reordering do not inherit a global image-drag side effect.
export function isPodcastCoverDragEnabled(settings) {
  return !settings || settings.allowPodcastCoverDrag !== false;
}

export function guardPodcastCoverDrag(event, settings) {
  const enabled = isPodcastCoverDragEnabled(settings);
  if (!enabled && event && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }
  return enabled;
}
