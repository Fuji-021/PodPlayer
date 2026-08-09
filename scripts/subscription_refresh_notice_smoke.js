const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const viewPath = path.join(root, 'src/views/subscriptionUpdates.vue');
const refreshPath = path.join(
  root,
  'src/utils/podcast/subscriptionRefresh.js'
);

function loadComponent(source, refreshSubscribedPodcasts) {
  const match = source.match(/<script>([\s\S]*?)<\/script>/);
  assert(match, 'subscription updates page must contain a script block');
  const script = match[1].replace(/^import[\s\S]*?;\r?\n/gm, '').replace(
    'export default {',
    `const ContextMenu = {};
const SvgIcon = {};
const SubscriptionProgramRail = {};
const SubscriptionEpisodeFeed = {};
const getListenStats = async () => [];
const listenedPercentStepped = () => 0;
const cancelDownload = async () => {};
const removeDownload = async () => {};
const startDownload = async () => {};
const nasEpisodeGuidSet = async () => new Set();
const normFeedUrl = value => value;
const applySubscriptionUpdateCompletion = () => {};
const getSubscriptionUpdatesSnapshot = async () => ({});
const getSubscriptionUpdateView = () => ({ episodes: [], groups: [], flatItems: [], metrics: [], totalHeight: 0 });
const markSubscriptionUpdatesDirty = () => {};
const countPendingSubscriptionEpisodes = () => 0;
const resolveSubscriptionSelection = (podcasts, selected) => selected;
const markAllSubscriptionsEntryFromUpdates = () => {};
const onSubscriptionUpdatesChanged = () => () => {};
const onSubscriptionUpdatesScrollTop = () => () => {};
const rankSubscriptionRail = podcasts => podcasts;
return {`
  );
  return Function('refreshSubscribedPodcasts', script)(
    refreshSubscribedPodcasts
  );
}

function createVm(component) {
  const vm = {
    ...component.data.call({}),
    _destroyed: false,
    _isActive: true,
    $refs: {},
    $nextTick(callback) {
      callback();
    },
    $route: { name: 'library' },
    $store: { state: {} },
  };
  Object.keys(component.methods).forEach(name => {
    vm[name] = (...args) => component.methods[name].apply(vm, args);
  });
  return vm;
}

function withFakeClock(run) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  global.setTimeout = (callback, delay) => {
    const id = nextId++;
    timers.set(id, { callback, due: now + Number(delay || 0) });
    return id;
  };
  global.clearTimeout = id => timers.delete(id);

  const clock = {
    activeCount() {
      return timers.size;
    },
    advance(ms) {
      now += ms;
      let progressed = true;
      while (progressed) {
        progressed = false;
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.due <= now)
          .sort((left, right) => left[1].due - right[1].due);
        due.forEach(([id, timer]) => {
          if (!timers.delete(id)) return;
          progressed = true;
          timer.callback();
        });
      }
    },
  };

  return Promise.resolve()
    .then(() => run(clock))
    .finally(() => {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    });
}

async function main() {
  const source = fs.readFileSync(viewPath, 'utf8');
  const refreshSource = fs.readFileSync(refreshPath, 'utf8');
  assert(
    source.includes('if (result.skipped) return;') &&
      source.indexOf('if (result.skipped) return;') <
        source.indexOf('this.showRefreshFailureNotice(result.results || []);'),
    'skipped coordinator results must not be remapped into a refresh notification'
  );
  assert(
    refreshSource.includes('onAttempt') &&
      refreshSource.indexOf('if (!force && Date.now() - readLastRefresh() < minInterval)') <
        refreshSource.indexOf("if (typeof onAttempt === 'function') onAttempt();"),
    'only a true refresh attempt may clear a previous notification before network work starts'
  );

  await withFakeClock(async clock => {
    const attempts = [
      {
        kind: 'real',
        result: {
          skipped: false,
          changed: false,
          results: [{ id: 'a', error: 'offline' }, { id: 'b' }],
        },
      },
      {
        kind: 'skipped',
        result: {
          skipped: true,
          results: [{ id: 'a', error: 'offline' }, { id: 'b' }],
        },
      },
      {
        kind: 'real',
        result: {
          skipped: false,
          changed: false,
          results: [{ id: 'a' }, { id: 'b' }],
        },
      },
      {
        kind: 'real',
        result: {
          skipped: false,
          changed: false,
          results: [{ id: 'c', error: 'timeout' }, { id: 'd' }],
        },
      },
      {
        kind: 'skipped',
        result: { skipped: true, results: [{ id: 'c', error: 'timeout' }] },
      },
    ];
    let requestCount = 0;
    const component = loadComponent(source, options => {
      const next = attempts.shift();
      assert(next, 'the test must provide one result per component refresh');
      requestCount += 1;
      if (next.kind === 'real' && options && options.onAttempt) {
        options.onAttempt();
      }
      return Promise.resolve(next.result);
    });
    const vm = createVm(component);

    await vm.checkBackgroundRefresh();
    assert.deepStrictEqual(vm.refreshFailureNotice, { count: 1, total: 2 });
    assert.strictEqual(
      component.computed.refreshFailureText.call(vm),
      '1 个节目暂时无法更新，其余订阅已完成'
    );
    assert.strictEqual(clock.activeCount(), 1, 'one partial failure has one expiry timer');

    const firstNotice = vm.refreshFailureNotice;
    await vm.checkBackgroundRefresh();
    assert.strictEqual(
      vm.refreshFailureNotice,
      firstNotice,
      'a min-interval skipped result must not replay or replace an old failure notice'
    );
    assert.strictEqual(clock.activeCount(), 1, 'skipped work must not schedule a second timer');

    clock.advance(7999);
    assert(vm.refreshFailureNotice, 'notice remains visible until its eight-second expiry');
    clock.advance(1);
    assert.strictEqual(vm.refreshFailureNotice, null, 'notice expires after eight seconds');
    assert.strictEqual(clock.activeCount(), 0);

    await vm.checkBackgroundRefresh();
    assert.strictEqual(
      vm.refreshFailureNotice,
      null,
      'a later all-success attempt clears any previous failure state immediately'
    );

    await vm.checkBackgroundRefresh();
    assert.deepStrictEqual(
      vm.refreshFailureNotice,
      { count: 1, total: 2 },
      'a later real partial failure creates a fresh notice'
    );
    component.deactivated.call(vm);
    assert.strictEqual(vm.refreshFailureNotice, null, 'deactivation clears the notice');
    assert.strictEqual(clock.activeCount(), 0, 'deactivation releases the expiry timer');

    vm._isActive = true;
    vm._destroyed = false;
    await vm.checkBackgroundRefresh();
    assert.strictEqual(
      vm.refreshFailureNotice,
      null,
      'returning to a kept-alive page with a skipped refresh cannot replay old failures'
    );
    assert.strictEqual(requestCount, 5);

    vm.refreshFailureNotice = { count: 1, total: 2 };
    vm._refreshFailureNoticeTimer = setTimeout(() => {}, 8000);
    component.beforeDestroy.call(vm);
    assert.strictEqual(vm.refreshFailureNotice, null, 'destroy clears the notice');
    assert.strictEqual(clock.activeCount(), 0, 'destroy releases the expiry timer');
  });

  process.stdout.write('subscription refresh notice smoke: PASS\n');
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
