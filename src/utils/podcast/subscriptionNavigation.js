let enterAllSubscriptionsFromUpdates = false;
const SUBSCRIPTION_UPDATES_CHANGED_EVENT =
  'podplayer:subscription-updates-changed';

export function markAllSubscriptionsEntryFromUpdates() {
  enterAllSubscriptionsFromUpdates = true;
}

export function consumeAllSubscriptionsEntryFromUpdates() {
  const shouldReset = enterAllSubscriptionsFromUpdates;
  enterAllSubscriptionsFromUpdates = false;
  return shouldReset;
}

// Keep the update-feed cache coherent without coupling unrelated pages to its
// in-memory snapshot implementation. Subscription writes remain the source of
// truth; this only marks the next read as stale.
export function notifySubscriptionUpdatesChanged() {
  if (
    typeof window === 'undefined' ||
    typeof window.dispatchEvent !== 'function'
  ) {
    return;
  }
  const EventCtor = window.Event;
  if (typeof EventCtor !== 'function') return;
  window.dispatchEvent(new EventCtor(SUBSCRIPTION_UPDATES_CHANGED_EVENT));
}

export function onSubscriptionUpdatesChanged(listener) {
  if (
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function' ||
    typeof listener !== 'function'
  ) {
    return () => {};
  }
  window.addEventListener(SUBSCRIPTION_UPDATES_CHANGED_EVENT, listener);
  return () =>
    window.removeEventListener(SUBSCRIPTION_UPDATES_CHANGED_EVENT, listener);
}
