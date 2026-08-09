import { refreshAllSubscriptions } from './service';
import { markSubscriptionUpdatesDirty } from './subscriptionUpdatesData';
import { notifySubscriptionUpdatesChanged } from './subscriptionNavigation';

const REFRESH_KEY = 'podcastLibrary.lastAutoRefresh';
const DEFAULT_INTERVAL = 10 * 60 * 1000;

let refreshInFlight = null;
let latestResult = null;

function readLastRefresh() {
  try {
    return Number(window.localStorage.getItem(REFRESH_KEY) || 0);
  } catch (e) {
    return 0;
  }
}

function markRefreshSuccess() {
  try {
    window.localStorage.setItem(REFRESH_KEY, String(Date.now()));
  } catch (e) {
    // localStorage 不可用时仍允许本次刷新，单例 in-flight 继续兜底。
  }
}

export function getLatestSubscriptionRefreshResult() {
  return latestResult;
}

export function refreshSubscribedPodcasts({
  minInterval = DEFAULT_INTERVAL,
  force = false,
  onAttempt,
} = {}) {
  if (refreshInFlight) return refreshInFlight;
  if (!force && Date.now() - readLastRefresh() < minInterval) {
    return Promise.resolve({
      skipped: true,
      totalNew: 0,
      results: latestResult ? latestResult.results : [],
    });
  }

  // Consumers may clear transient UI from a previous completed attempt here.
  // Skipped calls and in-flight followers deliberately do not invoke it.
  if (typeof onAttempt === 'function') onAttempt();

  refreshInFlight = refreshAllSubscriptions()
    .then(result => {
      latestResult = result || { totalNew: 0, results: [] };
      const hasSuccessfulFeed = (latestResult.results || []).some(
        item => item && !item.error
      );
      // A complete outage must not suppress the next automatic retry for the
      // full interval. In-flight still deduplicates concurrent callers.
      if (hasSuccessfulFeed) markRefreshSuccess();
      if (latestResult.changed) {
        markSubscriptionUpdatesDirty();
        notifySubscriptionUpdatesChanged();
      }
      return { ...latestResult, skipped: false };
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}
