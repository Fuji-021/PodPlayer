let enterAllSubscriptionsFromUpdates = false;

export function markAllSubscriptionsEntryFromUpdates() {
  enterAllSubscriptionsFromUpdates = true;
}

export function consumeAllSubscriptionsEntryFromUpdates() {
  const shouldReset = enterAllSubscriptionsFromUpdates;
  enterAllSubscriptionsFromUpdates = false;
  return shouldReset;
}
