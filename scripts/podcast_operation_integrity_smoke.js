const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-operation-integrity-')
);

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function buildModule(entryRelative, outputName, aliases = {}) {
  const outfile = path.join(tempDir, outputName);
  await esbuild.build({
    entryPoints: [path.join(root, entryRelative)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'operation-integrity-mocks',
        setup(build) {
          Object.keys(aliases).forEach(key => {
            build.onResolve({ filter: new RegExp('^' + key + '$') }, () => ({
              path: aliases[key],
            }));
          });
        },
      },
    ],
  });
  delete require.cache[require.resolve(outfile)];
  return require(outfile);
}

async function buildFavoriteQueue() {
  return buildModule(
    'src/utils/podcast/favoriteOperationQueue.js',
    'favorite-queue.cjs'
  );
}

async function buildRefreshCoordinator() {
  const mocks = path.join(tempDir, 'refresh-mocks');
  fs.mkdirSync(mocks, { recursive: true });
  const service = path.join(mocks, 'service.js');
  const snapshot = path.join(mocks, 'snapshot.js');
  const navigation = path.join(mocks, 'navigation.js');
  fs.writeFileSync(
    service,
    'export function refreshAllSubscriptions() { return global.__refreshHarness.next(); }\n'
  );
  fs.writeFileSync(
    snapshot,
    'export function markSubscriptionUpdatesDirty() { global.__refreshHarness.dirty += 1; }\n'
  );
  fs.writeFileSync(
    navigation,
    'export function notifySubscriptionUpdatesChanged() { global.__refreshHarness.notified += 1; }\n'
  );
  return buildModule(
    'src/utils/podcast/subscriptionRefresh.js',
    'subscription-refresh.cjs',
    {
      './service': service,
      './subscriptionUpdatesData': snapshot,
      './subscriptionNavigation': navigation,
    }
  );
}

async function buildPodcastDb() {
  const mocks = path.join(tempDir, 'podcast-db-mocks');
  fs.mkdirSync(mocks, { recursive: true });
  const dbMock = path.join(mocks, 'db.js');
  const navigation = path.join(mocks, 'navigation.js');
  fs.writeFileSync(dbMock, 'export const db = global.__operationHarness.db;\n');
  fs.writeFileSync(
    navigation,
    'export function notifySubscriptionUpdatesChanged() { global.__operationHarness.notifications += 1; }\n'
  );
  return buildModule('src/utils/podcast/db.js', 'podcast-db.cjs', {
    '@/utils/db': dbMock,
    './subscriptionNavigation': navigation,
  });
}

async function testFavoriteQueue() {
  const { createFavoriteOperationQueue } = await buildFavoriteQueue();
  const queue = createFavoriteOperationQueue();
  let favorite = false;
  const observed = [];

  function toggle() {
    return queue.run('episode-A', async () => {
      const already = favorite;
      await Promise.resolve();
      favorite = !already;
      observed.push(already ? 'remove' : 'add');
    });
  }

  await Promise.all([toggle(), toggle()]);
  assert.deepStrictEqual(observed, ['add', 'remove']);
  assert.strictEqual(favorite, false);
}

async function testRefreshThrottle() {
  const values = new Map();
  const previousWindow = global.window;
  const previousNow = Date.now;
  let calls = 0;
  global.window = {
    localStorage: {
      getItem(key) {
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        values.set(key, value);
      },
    },
  };
  Date.now = () => 10000;
  global.__refreshHarness = {
    dirty: 0,
    notified: 0,
    next() {
      calls += 1;
      if (calls < 3) {
        return Promise.resolve({
          changed: false,
          totalNew: 0,
          results: [{ id: 'feed', error: 'offline' }],
        });
      }
      return Promise.resolve({
        changed: true,
        totalNew: 1,
        results: [{ id: 'feed', totalNew: 1 }],
      });
    },
  };

  try {
    const { refreshSubscribedPodcasts } = await buildRefreshCoordinator();
    await refreshSubscribedPodcasts({ minInterval: 500 });
    await refreshSubscribedPodcasts({ minInterval: 500 });
    assert.strictEqual(calls, 2);
    assert.strictEqual(values.has('podcastLibrary.lastAutoRefresh'), false);
    await refreshSubscribedPodcasts({ minInterval: 500 });
    assert.strictEqual(values.get('podcastLibrary.lastAutoRefresh'), '10000');
    assert.strictEqual(
      (await refreshSubscribedPodcasts({ minInterval: 500 })).skipped,
      true
    );
    assert.strictEqual(calls, 3);
    assert.strictEqual(global.__refreshHarness.dirty, 1);
    assert.strictEqual(global.__refreshHarness.notified, 1);
  } finally {
    Date.now = previousNow;
    global.window = previousWindow;
    delete global.__refreshHarness;
  }
}

async function testNewCountTransaction() {
  const row = { id: 'feed-A', newCount: 0 };
  let transactionTail = Promise.resolve();
  const db = {
    podcasts: {
      async get(id) {
        await new Promise(resolve => setImmediate(resolve));
        return id === row.id ? { ...row } : undefined;
      },
      async update(id, patch) {
        await new Promise(resolve => setImmediate(resolve));
        if (id === row.id) Object.assign(row, patch);
      },
    },
    transaction(_mode, _table, work) {
      const task = transactionTail.then(() => work());
      transactionTail = task.catch(() => {});
      return task;
    },
  };
  global.__operationHarness = { db, notifications: 0 };
  try {
    const { incrementPodcastNewCount } = await buildPodcastDb();
    const results = await Promise.all([
      incrementPodcastNewCount('feed-A', 1),
      incrementPodcastNewCount('feed-A', 1),
    ]);
    assert.deepStrictEqual(results, [1, 2]);
    assert.strictEqual(
      row.newCount,
      2,
      'concurrent increments must not lose a badge update'
    );
  } finally {
    delete global.__operationHarness;
  }
}

async function testStaleLoadGuard() {
  const { createEpisodeDetailLoadGuard } = await buildModule(
    'src/utils/podcast/episodeDetailLoadGuard.js',
    'episode-load-guard.cjs'
  );
  const guard = createEpisodeDetailLoadGuard();
  const state = { episodeId: '', feedUrl: '', applied: null };
  const stale = deferred();
  const fresh = deferred();
  async function load(episodeId, feedUrl, result) {
    state.episodeId = episodeId;
    state.feedUrl = feedUrl;
    const request = guard.begin({ episodeId, feedUrl });
    const value = await result;
    if (!guard.isCurrent(request, state)) return false;
    state.applied = value;
    return true;
  }

  const oldLoad = load('old', 'feed-old', stale.promise);
  const freshLoad = load('fresh', 'feed-fresh', fresh.promise);
  stale.resolve({ id: 'old' });
  assert.strictEqual(
    await oldLoad,
    false,
    'route replacement blocks an old write'
  );
  fresh.resolve({ id: 'fresh' });
  assert.strictEqual(await freshLoad, true);
  assert.deepStrictEqual(state.applied, { id: 'fresh' });

  const inactive = deferred();
  const inactiveLoad = load('inactive', 'feed-inactive', inactive.promise);
  guard.invalidate();
  inactive.resolve({ id: 'inactive' });
  assert.strictEqual(
    await inactiveLoad,
    false,
    'deactivation blocks a late write'
  );
  assert.notDeepStrictEqual(state.applied, { id: 'inactive' });
}

async function testRuntimeOperationRules() {
  const rules = await buildModule(
    'src/utils/podcast/runtimeOperationRules.js',
    'runtime-operation-rules.cjs'
  );
  assert.deepStrictEqual(
    rules.getStaleAsrPendingIds(
      { failed: true, downloading: true, completed: true },
      { downloading: { status: 'downloading' } },
      { completed: 'C:/audio.mp3' }
    ),
    ['failed'],
    'a failed download must clear its pending ASR marker'
  );
  assert.strictEqual(rules.shouldRemoveQueueEntryAfterHandoff(false), false);
  assert.strictEqual(rules.shouldRemoveQueueEntryAfterHandoff(true), true);
  assert.strictEqual(rules.shouldRemoveQueueEntryAfterHandoff(undefined), true);
  assert.strictEqual(
    rules.getAutoCleanPreviousEpisodeId({
      lastListenCompleted: true,
      previousEpisodeId: 'previous',
      currentEpisodeId: 'current',
      autoCleanEnabled: true,
    }),
    'previous',
    'auto-clean must target the true previous episode'
  );
  assert.strictEqual(
    rules.getAutoCleanPreviousEpisodeId({
      lastListenCompleted: true,
      previousEpisodeId: 'current',
      currentEpisodeId: 'current',
      autoCleanEnabled: true,
    }),
    ''
  );
  assert.strictEqual(rules.getForwardSeekTarget(75, 0, 30), 75);
  assert.strictEqual(rules.getForwardSeekTarget(75, undefined, 30), 75);
  assert.strictEqual(rules.getForwardSeekTarget(75, 90, 30), 89);
}

async function testUnsubscribeFailure() {
  const { requestUnsubscribe } = await buildModule(
    'src/utils/podcast/subscriptionOperations.js',
    'subscription-operations.cjs'
  );
  let calls = 0;
  const failed = await requestUnsubscribe('feed-A', async () => {
    calls += 1;
    throw new Error('internal detail');
  });
  assert.deepStrictEqual(failed, { ok: false, error: 'unsubscribe-failed' });
  assert.strictEqual(calls, 1);
  const succeeded = await requestUnsubscribe('feed-A', async () => {
    calls += 1;
  });
  assert.deepStrictEqual(succeeded, { ok: true });
  assert.strictEqual(calls, 2);
}

function testWiringContracts() {
  const files = {
    detail: fs.readFileSync(
      path.join(root, 'src/views/podcastDetail.vue'),
      'utf8'
    ),
    library: fs.readFileSync(
      path.join(root, 'src/views/podcastLibrary.vue'),
      'utf8'
    ),
    discover: fs.readFileSync(
      path.join(root, 'src/components/DiscoverCard.vue'),
      'utf8'
    ),
    player: fs.readFileSync(path.join(root, 'src/utils/Player.js'), 'utf8'),
    renderer: fs.readFileSync(
      path.join(root, 'src/electron/ipcRenderer.js'),
      'utf8'
    ),
  };
  assert.match(files.detail, /getStaleAsrPendingIds\(/);
  assert.match(files.player, /shouldRemoveQueueEntryAfterHandoff\(/);
  assert.match(files.player, /getAutoCleanPreviousEpisodeId\(/);
  assert.match(files.renderer, /getForwardSeekTarget\(/);
  assert.match(files.detail, /requestUnsubscribe\(/);
  assert.match(files.library, /requestUnsubscribe\(/);
  assert.match(files.discover, /requestUnsubscribe\(/);
}

async function main() {
  try {
    await testFavoriteQueue();
    await testRefreshThrottle();
    await testNewCountTransaction();
    await testStaleLoadGuard();
    await testRuntimeOperationRules();
    await testUnsubscribeFailure();
    testWiringContracts();
    process.stdout.write('podcast operation integrity smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
