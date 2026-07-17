import { normalizeSubscriptionEpisodeCoverUrl } from './subscriptionEpisodeCover';

const DEFAULT_IDLE_TIMEOUT = 1200;

// The update feed only mounts a small virtual window. Keep persistence bounded
// anyway: cache writes are best effort and must never compete with rendering.
export const SUBSCRIPTION_EPISODE_COVER_PERSISTENCE_MAX_PENDING = 48;

function normalizeUrl(value) {
  return normalizeSubscriptionEpisodeCoverUrl(value);
}

function createDefaultSchedule(callback, timeout) {
  if (
    typeof window !== 'undefined' &&
    typeof window.requestIdleCallback === 'function'
  ) {
    return {
      type: 'idle',
      id: window.requestIdleCallback(callback, { timeout }),
    };
  }
  return {
    type: 'timeout',
    id: setTimeout(callback, 0),
  };
}

function cancelDefaultSchedule(handle) {
  if (!handle) return;
  if (
    handle.type === 'idle' &&
    typeof window !== 'undefined' &&
    typeof window.cancelIdleCallback === 'function'
  ) {
    window.cancelIdleCallback(handle.id);
    return;
  }
  clearTimeout(handle.id);
}

function callSafely(callback, value) {
  if (typeof callback !== 'function') return;
  try {
    callback(value);
  } catch (e) {
    // Cache persistence must never surface a consumer callback failure.
  }
}

/**
 * A module-local queue shared by every visible update-feed cover component.
 * It deliberately performs one synchronous canvas encode per idle/macrotask.
 */
export function createSubscriptionEpisodeCoverPersistenceScheduler({
  maxPending = SUBSCRIPTION_EPISODE_COVER_PERSISTENCE_MAX_PENDING,
  idleTimeout = DEFAULT_IDLE_TIMEOUT,
  schedule = createDefaultSchedule,
  cancelSchedule = cancelDefaultSchedule,
} = {}) {
  const pendingLimit = Math.max(1, Math.floor(Number(maxPending) || 1));
  const queue = [];
  const jobsByUrl = new Map();
  let scheduled = null;

  function removeJob(job) {
    if (!job) return;
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    if (jobsByUrl.get(job.url) === job) jobsByUrl.delete(job.url);
  }

  function settleJob(job, reason) {
    if (!job || job.settled) return;
    job.settled = true;
    removeJob(job);
    const onSettled = job.onSettled;
    const ticket = job.ticket;
    job.isValid = null;
    job.persist = null;
    job.onSettled = null;
    job.ticket = null;
    if (ticket) {
      ticket.canceled = reason === 'canceled';
      ticket.job = null;
    }
    callSafely(onSettled, reason);
  }

  function isJobCurrent(job) {
    if (!job || job.settled || typeof job.isValid !== 'function') return false;
    try {
      return !!job.isValid();
    } catch (e) {
      return false;
    }
  }

  function pruneStaleJobs() {
    queue.slice().forEach(job => {
      if (!isJobCurrent(job)) settleJob(job, 'stale');
    });
  }

  function cancelScheduledWhenIdle() {
    if (queue.length || !scheduled) return;
    const handle = scheduled;
    scheduled = null;
    try {
      cancelSchedule(handle);
    } catch (e) {
      // A canceled callback may race its browser delivery. It self-invalidates.
    }
  }

  function drainOne() {
    pruneStaleJobs();
    const job = queue[0];
    if (!job) return;
    removeJob(job);
    if (!isJobCurrent(job)) {
      settleJob(job, 'stale');
      return;
    }
    try {
      job.persist();
    } catch (e) {
      // Canvas/Dexie persistence is intentionally best effort.
    } finally {
      settleJob(job, 'completed');
    }
  }

  function scheduleNext() {
    if (scheduled || !queue.length) return;
    let handle = null;
    const callback = () => {
      if (scheduled === handle) scheduled = null;
      drainOne();
      scheduleNext();
    };
    handle = schedule(callback, idleTimeout);
    scheduled = handle;
  }

  function enqueue({ url, isValid, persist, onSettled } = {}) {
    const normalizedUrl = normalizeUrl(url);
    if (
      !normalizedUrl ||
      typeof isValid !== 'function' ||
      typeof persist !== 'function'
    ) {
      return null;
    }

    pruneStaleJobs();
    const duplicate = jobsByUrl.get(normalizedUrl);
    if (duplicate) settleJob(duplicate, 'deduped');

    while (queue.length >= pendingLimit) {
      // Existing stale jobs were removed above. The oldest remaining cache
      // write is the lowest-value best-effort work when the window turns over.
      settleJob(queue[0], 'queue-cap');
    }

    const ticket = { canceled: false, job: null };
    const job = {
      url: normalizedUrl,
      isValid,
      persist,
      onSettled,
      ticket,
      settled: false,
    };
    ticket.job = job;
    queue.push(job);
    jobsByUrl.set(normalizedUrl, job);
    scheduleNext();
    return ticket;
  }

  function cancel(ticket) {
    const job = ticket && ticket.job;
    if (!job) return;
    settleJob(job, 'canceled');
    cancelScheduledWhenIdle();
  }

  function getStateForTest() {
    return {
      pendingCount: queue.length,
      pendingUrls: queue.map(job => job.url),
      scheduledType: scheduled && scheduled.type,
    };
  }

  return { enqueue, cancel, getStateForTest };
}

const defaultScheduler = createSubscriptionEpisodeCoverPersistenceScheduler();

export function enqueueSubscriptionEpisodeCoverPersistence(options) {
  return defaultScheduler.enqueue(options);
}

export function cancelSubscriptionEpisodeCoverPersistence(ticket) {
  defaultScheduler.cancel(ticket);
}
