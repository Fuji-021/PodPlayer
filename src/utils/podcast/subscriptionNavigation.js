let enterAllSubscriptionsFromUpdates = false;
const SUBSCRIPTION_UPDATES_CHANGED_EVENT =
  'podplayer:subscription-updates-changed';
const SUBSCRIPTION_UPDATES_SCROLL_TOP_EVENT =
  'podplayer:subscription-updates-scroll-top';

function dispatchSubscriptionEvent(eventName) {
  if (
    typeof window === 'undefined' ||
    typeof window.dispatchEvent !== 'function'
  ) {
    return;
  }
  const EventCtor = window.Event;
  if (typeof EventCtor !== 'function') return;
  window.dispatchEvent(new EventCtor(eventName));
}

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
  dispatchSubscriptionEvent(SUBSCRIPTION_UPDATES_CHANGED_EVENT);
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

// Navbar repeats on the active update route should not navigate, reset the
// selected podcast, or duplicate scrolling code. The mounted update page owns
// the request and forwards it to the shared back-to-top component.
export function requestSubscriptionUpdatesScrollTop() {
  dispatchSubscriptionEvent(SUBSCRIPTION_UPDATES_SCROLL_TOP_EVENT);
}

export function onSubscriptionUpdatesScrollTop(listener) {
  if (
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function' ||
    typeof listener !== 'function'
  ) {
    return () => {};
  }
  window.addEventListener(SUBSCRIPTION_UPDATES_SCROLL_TOP_EVENT, listener);
  return () =>
    window.removeEventListener(SUBSCRIPTION_UPDATES_SCROLL_TOP_EVENT, listener);
}
