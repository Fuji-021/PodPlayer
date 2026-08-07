const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-operation-integrity-')
);

async function buildFavoriteQueue() {
  const outfile = path.join(tempDir, 'favorite-queue.cjs');
  await esbuild.build({
    entryPoints: [
      path.join(root, 'src/utils/podcast/favoriteOperationQueue.js'),
    ],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  return require(outfile);
}

async function buildRefreshCoordinator() {
  const mocks = path.join(tempDir, 'mocks');
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
  const outfile = path.join(tempDir, 'subscription-refresh.cjs');
  await esbuild.build({
    entryPoints: [
      path.join(root, 'src/utils/podcast/subscriptionRefresh.js'),
    ],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'subscription-refresh-mocks',
        setup(build) {
          const aliases = {
            './service': service,
            './subscriptionUpdatesData': snapshot,
            './subscriptionNavigation': navigation,
          };
          Object.keys(aliases).forEach(key => {
            build.onResolve({ filter: new RegExp(`^${key}$`) }, () => ({
              path: aliases[key],
            }));
          });
        },
      },
    ],
  });
  return require(outfile);
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
  assert.deepStrictEqual(
    observed,
    ['add', 'remove'],
    'same-episode operations must observe the previous durable toggle'
  );
  assert.strictEqual(favorite, false, 'two rapid toggles return to the start');

  const independent = [];
  await Promise.all([
    queue.run('episode-B', () => independent.push('B')),
    queue.run('episode-C', () => independent.push('C')),
  ]);
  assert.strictEqual(independent.length, 2);

  const actionsSource = fs.readFileSync(
    path.join(root, 'src/store/actions.js'),
    'utf8'
  );
  assert.match(actionsSource, /podcastFavoriteOperationQueue\.run\(id/);
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
    assert.strictEqual(
      calls,
      2,
      'a total outage must not write the success throttle timestamp'
    );
    assert.strictEqual(values.has('podcastLibrary.lastAutoRefresh'), false);

    await refreshSubscribedPodcasts({ minInterval: 500 });
    assert.strictEqual(calls, 3);
    assert.strictEqual(values.get('podcastLibrary.lastAutoRefresh'), '10000');
    const skipped = await refreshSubscribedPodcasts({ minInterval: 500 });
    assert.strictEqual(skipped.skipped, true);
    assert.strictEqual(calls, 3, 'a successful refresh may start cooldown');
    assert.strictEqual(global.__refreshHarness.dirty, 1);
    assert.strictEqual(global.__refreshHarness.notified, 1);
  } finally {
    Date.now = previousNow;
    global.window = previousWindow;
    delete global.__refreshHarness;
  }
}

function testSourceContracts() {
  const serviceSource = fs.readFileSync(
    path.join(root, 'src/utils/podcast/service.js'),
    'utf8'
  );
  const updatesSource = fs.readFileSync(
    path.join(root, 'src/views/subscriptionUpdates.vue'),
    'utf8'
  );
  const detailSource = fs.readFileSync(
    path.join(root, 'src/views/podcastDetail.vue'),
    'utf8'
  );
  const playerSource = fs.readFileSync(
    path.join(root, 'src/utils/Player.js'),
    'utf8'
  );

  assert.match(serviceSource, /subscribed:\s*true/);
  assert.match(serviceSource, /notifySubscriptionUpdatesChanged\(\)/);
  assert.match(serviceSource, /incrementPodcastNewCount\(p\.id, newCount\)/);
  assert.match(updatesSource, /this\._loadToken\s*=\s*\(this\._loadToken \|\| 0\) \+ 1/);
  assert.match(detailSource, /progressMap/);
  assert.match(detailSource, /this\.\$delete\(this\.asrPendingMap, id\)/);
  assert.match(playerSource, /oldTrack\.podcastId/);
  assert.match(playerSource, /previousEpisodeId/);
  assert.match(playerSource, /if \(started === false\)/);
}

async function main() {
  try {
    await testFavoriteQueue();
    await testRefreshThrottle();
    testSourceContracts();
    process.stdout.write('podcast operation integrity smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
