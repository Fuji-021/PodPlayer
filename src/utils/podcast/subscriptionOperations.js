// Keep all unsubscribe entry points fail-closed: only callers that receive an
// ok result may mutate local subscription state or navigate away.
export async function requestUnsubscribe(feedUrl, removePodcast) {
  if (!feedUrl || typeof removePodcast !== 'function') {
    return { ok: false, error: 'unsubscribe-invalid-request' };
  }
  try {
    await removePodcast(feedUrl);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: 'unsubscribe-failed' };
  }
}
