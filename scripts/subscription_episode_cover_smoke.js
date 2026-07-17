const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-subscription-episode-cover-')
);

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

function createCacheState() {
  return {
    peek: {},
    get: {},
    getCalls: [],
    persisted: [],
  };
}

function createIdleHarness(reducedMotion = false) {
  let nextId = 0;
  const callbacks = new Map();
  const window = {
    matchMedia: () => ({ matches: reducedMotion }),
    requestIdleCallback(callback, options) {
      const id = ++nextId;
      callbacks.set(id, { callback, options });
      return id;
    },
    cancelIdleCallback(id) {
      callbacks.delete(id);
    },
  };
  return {
    window,
    pendingCount() {
      return callbacks.size;
    },
    captureCallbacks(ids) {
      const requested = ids ? new Set(ids) : null;
      return Array.from(callbacks.entries())
        .filter(([id]) => !requested || requested.has(id))
        .map(([, item]) => item.callback);
    },
    runNext({ didTimeout = false } = {}) {
      const next = callbacks.entries().next();
      if (next.done) return false;
      const [id, item] = next.value;
      callbacks.delete(id);
      item.callback({
        didTimeout,
        timeRemaining: () => (didTimeout ? 0 : 50),
      });
      return true;
    },
    runAll(options) {
      let count = 0;
      while (this.runNext(options)) {
        count += 1;
        if (count > 200) throw new Error('idle harness did not drain');
      }
      return count;
    },
  };
}

function createSchedulerHarness(type) {
  let nextId = 0;
  const callbacks = new Map();
  return {
    schedule(callback) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return { type, id };
    },
    cancel(handle) {
      if (handle) callbacks.delete(handle.id);
    },
    pendingCount() {
      return callbacks.size;
    },
    runNext({ didTimeout = false } = {}) {
      const next = callbacks.entries().next();
      if (next.done) return false;
      const [id, callback] = next.value;
      callbacks.delete(id);
      callback({
        didTimeout,
        timeRemaining: () => (didTimeout ? 0 : 50),
      });
      return true;
    },
  };
}

function createVm(component, episode) {
  const vm = {
    ...component.data(),
    episode: episode,
    $refs: {},
    $nextTick(callback) {
      callback();
    },
  };
  Object.keys(component.methods).forEach(key => {
    vm[key] = component.methods[key].bind(vm);
  });
  return vm;
}

function fakeImage(token, source, decode = true) {
  return {
    complete: true,
    naturalWidth: 64,
    dataset: {
      coverToken: String(token),
      coverSource: source,
    },
    decode() {
      return decode ? Promise.resolve() : Promise.reject(new Error('decode'));
    },
  };
}

function attachImage(vm, layer, image) {
  vm.$refs[layer === 'base' ? 'baseImage' : 'episodeImage'] = image;
  return image;
}

async function buildComponent() {
  const cacheMock = path.join(tempDir, 'cover-cache.js');
  const svgMock = path.join(tempDir, 'svg-icon.js');
  fs.writeFileSync(
    cacheMock,
    `export function peekCachedCover(url) {
  const state = global.__subscriptionEpisodeCoverCache;
  return (state && state.peek[url]) || '';
}
export function getCachedCover(url) {
  const state = global.__subscriptionEpisodeCoverCache;
  state.getCalls.push(url);
  const value = state.get[url];
  return value && typeof value.then === 'function'
    ? value
    : Promise.resolve(value || null);
}
export function cacheCoverFromImg(url, image) {
  const state = global.__subscriptionEpisodeCoverCache;
  state.persisted.push({ url, image });
}
`
  );
  fs.writeFileSync(svgMock, 'export default {};\n');
  const output = path.join(tempDir, 'cover.cjs');
  await esbuild.build({
    entryPoints: [
      path.join(root, 'src/components/podcast/SubscriptionEpisodeCover.vue'),
    ],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'subscription-episode-cover-sfc',
        setup(build) {
          build.onResolve({ filter: /^@\/components\/SvgIcon\.vue$/ }, () => ({
            path: svgMock,
          }));
          build.onResolve(
            { filter: /^@\/utils\/podcast\/coverCache$/ },
            () => ({ path: cacheMock })
          );
          build.onResolve({ filter: /^@\// }, args => {
            const bare = path.join(root, 'src', args.path.slice(2));
            if (fs.existsSync(bare)) return { path: bare };
            if (fs.existsSync(bare + '.js')) return { path: bare + '.js' };
            throw new Error('Unresolved alias: ' + args.path);
          });
          build.onLoad({ filter: /SubscriptionEpisodeCover\.vue$/ }, args => {
            const source = fs.readFileSync(args.path, 'utf8');
            const match = source.match(/<script>([\s\S]*?)<\/script>/);
            if (!match) throw new Error('Missing component script');
            return { contents: match[1], loader: 'js' };
          });
        },
      },
    ],
  });
  return require(output).default;
}

async function buildPersistenceScheduler() {
  const output = path.join(tempDir, 'persistence.cjs');
  await esbuild.build({
    entryPoints: [
      path.join(
        root,
        'src/utils/podcast/subscriptionEpisodeCoverPersistence.js'
      ),
    ],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  return require(output);
}

function runPersistenceSchedulerSmoke(persistence) {
  const idle = createSchedulerHarness('idle');
  const persisted = [];
  const scheduler =
    persistence.createSubscriptionEpisodeCoverPersistenceScheduler({
      schedule: callback => idle.schedule(callback),
      cancelSchedule: handle => idle.cancel(handle),
    });

  for (let index = 0; index < 20; index++) {
    scheduler.enqueue({
      url: 'https://covers.test/base-' + index + '.jpg',
      isValid: () => true,
      persist: () => persisted.push('base-' + index),
    });
    scheduler.enqueue({
      url: 'https://covers.test/episode-' + index + '.jpg',
      isValid: () => true,
      persist: () => persisted.push('episode-' + index),
    });
  }
  assert.strictEqual(scheduler.getStateForTest().pendingCount, 40);
  assert.strictEqual(
    idle.pendingCount(),
    1,
    'all visible decode completions must share one idle callback'
  );
  for (let index = 0; index < 40; index++) {
    assert.strictEqual(idle.pendingCount(), 1);
    assert.ok(idle.runNext({ didTimeout: true }));
    assert.strictEqual(
      persisted.length,
      index + 1,
      'a timed-out idle turn may encode exactly one cover'
    );
  }
  assert.strictEqual(scheduler.getStateForTest().pendingCount, 0);
  assert.strictEqual(idle.pendingCount(), 0);

  const dedupeIdle = createSchedulerHarness('idle');
  const dedupeReasons = [];
  const dedupePersisted = [];
  const dedupeScheduler =
    persistence.createSubscriptionEpisodeCoverPersistenceScheduler({
      schedule: callback => dedupeIdle.schedule(callback),
      cancelSchedule: handle => dedupeIdle.cancel(handle),
    });
  const firstTicket = dedupeScheduler.enqueue({
    url: 'https://covers.test/shared.jpg',
    isValid: () => true,
    persist: () => dedupePersisted.push('first'),
    onSettled: reason => dedupeReasons.push(reason),
  });
  dedupeScheduler.enqueue({
    url: 'https://covers.test/shared.jpg',
    isValid: () => true,
    persist: () => dedupePersisted.push('latest'),
  });
  assert.strictEqual(firstTicket.job, null);
  assert.deepStrictEqual(dedupeReasons, ['deduped']);
  assert.strictEqual(dedupeScheduler.getStateForTest().pendingCount, 1);
  dedupeIdle.runNext({ didTimeout: true });
  assert.deepStrictEqual(dedupePersisted, ['latest']);

  const reuseIdle = createSchedulerHarness('idle');
  const reusePersisted = [];
  let activeRow = 'a';
  const reuseScheduler =
    persistence.createSubscriptionEpisodeCoverPersistenceScheduler({
      schedule: callback => reuseIdle.schedule(callback),
      cancelSchedule: handle => reuseIdle.cancel(handle),
    });
  const staleTicket = reuseScheduler.enqueue({
    url: 'https://covers.test/a.jpg',
    isValid: () => activeRow === 'a',
    persist: () => reusePersisted.push('a'),
  });
  activeRow = 'b';
  reuseScheduler.enqueue({
    url: 'https://covers.test/b.jpg',
    isValid: () => activeRow === 'b',
    persist: () => reusePersisted.push('b'),
  });
  assert.strictEqual(staleTicket.job, null);
  reuseIdle.runNext({ didTimeout: true });
  assert.deepStrictEqual(reusePersisted, ['b']);

  const capIdle = createSchedulerHarness('idle');
  const capReasons = [];
  const capPersisted = [];
  const capScheduler =
    persistence.createSubscriptionEpisodeCoverPersistenceScheduler({
      maxPending: 3,
      schedule: callback => capIdle.schedule(callback),
      cancelSchedule: handle => capIdle.cancel(handle),
    });
  for (let index = 0; index < 5; index++) {
    capScheduler.enqueue({
      url: 'https://covers.test/cap-' + index + '.jpg',
      isValid: () => true,
      persist: () => capPersisted.push(index),
      onSettled: reason => capReasons.push({ index, reason }),
    });
  }
  assert.strictEqual(capScheduler.getStateForTest().pendingCount, 3);
  assert.deepStrictEqual(capReasons, [
    { index: 0, reason: 'queue-cap' },
    { index: 1, reason: 'queue-cap' },
  ]);
  while (capIdle.runNext({ didTimeout: true })) {
    // Drain each job independently to prove queue-cap survivors remain serial.
  }
  assert.deepStrictEqual(capPersisted, [2, 3, 4]);

  const timeout = createSchedulerHarness('timeout');
  const timeoutPersisted = [];
  const timeoutScheduler =
    persistence.createSubscriptionEpisodeCoverPersistenceScheduler({
      schedule: callback => timeout.schedule(callback),
      cancelSchedule: handle => timeout.cancel(handle),
    });
  for (let index = 0; index < 3; index++) {
    timeoutScheduler.enqueue({
      url: 'https://covers.test/timeout-' + index + '.jpg',
      isValid: () => true,
      persist: () => timeoutPersisted.push(index),
    });
  }
  assert.strictEqual(timeout.pendingCount(), 1);
  for (let index = 0; index < 3; index++) {
    timeout.runNext();
    assert.strictEqual(timeoutPersisted.length, index + 1);
  }
}

async function main() {
  const previousWindow = global.window;
  try {
    const component = await buildComponent();
    const persistence = await buildPersistenceScheduler();
    runPersistenceSchedulerSmoke(persistence);
    const helperOutput = path.join(tempDir, 'helper.cjs');
    await esbuild.build({
      entryPoints: [
        path.join(root, 'src/utils/podcast/subscriptionEpisodeCover.js'),
      ],
      outfile: helperOutput,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const helper = require(helperOutput);

    const episodeUrl = 'https://covers.test/episode.jpg';
    const podcastUrl = 'https://covers.test/podcast.jpg';
    const basePlan = helper.createSubscriptionEpisodeCoverPlan({
      episodeId: 'episode-a',
      episodeCoverUrl: episodeUrl,
      podcastCoverUrl: podcastUrl,
    });
    assert.strictEqual(basePlan.episodeUrl, episodeUrl);
    assert.strictEqual(basePlan.podcastUrl, podcastUrl);
    assert.strictEqual(basePlan.shouldLookupEpisodeCache, true);
    assert.strictEqual(basePlan.shouldLookupPodcastCache, true);

    const noEpisodePlan = helper.createSubscriptionEpisodeCoverPlan({
      episodeId: 'no-episode',
      episodeCoverUrl: '',
      podcastCoverUrl: podcastUrl,
    });
    assert.strictEqual(noEpisodePlan.episodeUrl, '');
    assert.strictEqual(
      noEpisodePlan.episodeSource,
      helper.SUBSCRIPTION_EPISODE_COVER_SOURCES.NONE
    );
    assert.strictEqual(noEpisodePlan.shouldLookupEpisodeCache, false);

    const samePlan = helper.createSubscriptionEpisodeCoverPlan({
      episodeId: 'same',
      episodeCoverUrl: 'http://covers.test/same.jpg',
      podcastCoverUrl: 'https://covers.test/same.jpg',
    });
    assert.strictEqual(samePlan.episodeUrl, '');
    assert.strictEqual(samePlan.shouldLookupEpisodeCache, false);
    assert.strictEqual(
      helper.hasSameSubscriptionEpisodeCoverUrl(
        'http://covers.test/same.jpg',
        'https://covers.test/same.jpg'
      ),
      true
    );

    const memoryPlan = helper.createSubscriptionEpisodeCoverPlan({
      episodeId: 'memory',
      episodeCoverUrl: episodeUrl,
      podcastCoverUrl: podcastUrl,
      memoryEpisodeCover: 'data:image/jpeg;base64,episode',
      memoryPodcastCover: 'data:image/jpeg;base64,podcast',
    });
    const memoryEpisode = helper.resolveSubscriptionEpisodeCoverSource(
      memoryPlan,
      ''
    );
    assert.deepStrictEqual(memoryEpisode, {
      src: 'data:image/jpeg;base64,episode',
      source: helper.SUBSCRIPTION_EPISODE_COVER_SOURCES.MEMORY,
    });
    assert.deepStrictEqual(
      helper.getSubscriptionEpisodeCoverReadyState({
        source: memoryEpisode.source,
        reducedMotion: false,
      }),
      { visible: true, animate: false, settleImmediately: true }
    );

    const persistentEpisode = helper.resolveSubscriptionEpisodeCoverSource(
      basePlan,
      'data:image/jpeg;base64,persisted'
    );
    assert.deepStrictEqual(persistentEpisode, {
      src: 'data:image/jpeg;base64,persisted',
      source: helper.SUBSCRIPTION_EPISODE_COVER_SOURCES.PERSISTENT,
    });
    assert.deepStrictEqual(
      helper.getSubscriptionEpisodeCoverReadyState({
        source: persistentEpisode.source,
        reducedMotion: false,
      }),
      { visible: true, animate: true, settleImmediately: false }
    );
    assert.strictEqual(
      helper.shouldPersistSubscriptionEpisodeCover(persistentEpisode.source),
      false
    );
    assert.strictEqual(
      helper.shouldPersistSubscriptionEpisodeCover(
        helper.SUBSCRIPTION_EPISODE_COVER_SOURCES.REMOTE
      ),
      true
    );
    assert.deepStrictEqual(
      helper.getSubscriptionEpisodeCoverReadyState({
        source: helper.SUBSCRIPTION_EPISODE_COVER_SOURCES.REMOTE,
        reducedMotion: true,
      }),
      { visible: true, animate: false, settleImmediately: true }
    );

    assert.strictEqual(
      helper.isCurrentSubscriptionEpisodeCoverRequest({
        token: 1,
        currentToken: 2,
        episodeId: 'episode-a',
        currentEpisodeId: 'episode-b',
        source: episodeUrl,
        currentSource: 'https://covers.test/episode-b.jpg',
      }),
      false,
      'an old episode request must not overwrite the reused virtual row'
    );

    let idle = createIdleHarness(false);
    global.window = idle.window;
    global.__subscriptionEpisodeCoverCache = createCacheState();
    global.__subscriptionEpisodeCoverCache.peek[episodeUrl] =
      'data:image/jpeg;base64,episode';
    global.__subscriptionEpisodeCoverCache.peek[podcastUrl] =
      'data:image/jpeg;base64,podcast';
    const memoryVm = createVm(component, {
      id: 'memory-row',
      episodeCoverUrl: episodeUrl,
      podcastCoverUrl: podcastUrl,
    });
    memoryVm.resetCover();
    assert.strictEqual(memoryVm.episodeSrc, 'data:image/jpeg;base64,episode');
    assert.strictEqual(memoryVm.episodeReady, false);
    assert.strictEqual(memoryVm.episodeAnimate, false);
    assert.ok(
      !global.__subscriptionEpisodeCoverCache.getCalls.includes(episodeUrl),
      'session cache must render directly without a persistent lookup'
    );
    memoryVm.finishEpisodeImage(
      fakeImage(memoryVm.requestToken, memoryVm.episodeSrc, true),
      memoryVm.requestToken,
      memoryVm.episodeSrc
    );
    await flush();
    assert.strictEqual(
      memoryVm.episodeReady,
      false,
      'the episode layer waits for the stable podcast base'
    );
    memoryVm.finishBaseImage(
      fakeImage(memoryVm.requestToken, memoryVm.baseSrc, true),
      memoryVm.requestToken,
      memoryVm.baseSrc
    );
    await flush();
    assert.strictEqual(memoryVm.baseReady, true);
    assert.strictEqual(memoryVm.episodeReady, true);
    assert.strictEqual(memoryVm.episodeSettled, true);

    global.__subscriptionEpisodeCoverCache = createCacheState();
    global.__subscriptionEpisodeCoverCache.get[episodeUrl] =
      'data:image/jpeg;base64,persisted';
    const persistentVm = createVm(component, {
      id: 'persistent-row',
      episodeCoverUrl: episodeUrl,
      podcastCoverUrl: podcastUrl,
    });
    persistentVm.resetCover();
    await flush();
    assert.strictEqual(
      persistentVm.episodeSrc,
      'data:image/jpeg;base64,persisted'
    );
    assert.strictEqual(
      persistentVm.episodeSource,
      helper.SUBSCRIPTION_EPISODE_COVER_SOURCES.PERSISTENT
    );
    assert.notStrictEqual(
      persistentVm.episodeSrc,
      episodeUrl,
      'a persistent hit must not start the remote episode request'
    );

    global.__subscriptionEpisodeCoverCache = createCacheState();
    const coldVm = createVm(component, {
      id: 'cold-row',
      episodeCoverUrl: episodeUrl,
      podcastCoverUrl: podcastUrl,
    });
    coldVm.resetCover();
    await flush();
    assert.strictEqual(coldVm.baseSrc, podcastUrl);
    assert.strictEqual(coldVm.episodeSrc, episodeUrl);
    const coldImage = fakeImage(coldVm.requestToken, coldVm.episodeSrc, true);
    attachImage(coldVm, 'episode', coldImage);
    coldVm.finishEpisodeImage(
      coldImage,
      coldVm.requestToken,
      coldVm.episodeSrc
    );
    await flush();
    assert.strictEqual(
      coldVm.episodeReady,
      false,
      'cold episode art must wait for the podcast fallback to decode'
    );
    const coldBaseImage = fakeImage(coldVm.requestToken, coldVm.baseSrc, true);
    attachImage(coldVm, 'base', coldBaseImage);
    coldVm.finishBaseImage(coldBaseImage, coldVm.requestToken, coldVm.baseSrc);
    await flush();
    assert.strictEqual(coldVm.episodeReady, true);
    assert.strictEqual(coldVm.episodeAnimate, true);
    assert.strictEqual(coldVm.episodeSettled, false);
    assert.deepStrictEqual(
      global.__subscriptionEpisodeCoverCache.persisted,
      [],
      'decode must reveal the episode before canvas persistence runs'
    );
    assert.strictEqual(
      idle.pendingCount(),
      1,
      'base and episode persistence must share the global idle queue'
    );
    idle.runAll();
    assert.deepStrictEqual(
      global.__subscriptionEpisodeCoverCache.persisted
        .map(item => item.url)
        .sort(),
      [podcastUrl, episodeUrl].sort()
    );
    coldVm.onEpisodeTransitionEnd({
      propertyName: 'opacity',
      currentTarget: coldImage,
    });
    assert.strictEqual(coldVm.episodeSettled, true);

    const failedVm = createVm(component, {
      id: 'failed-row',
      episodeCoverUrl: episodeUrl,
      podcastCoverUrl: podcastUrl,
    });
    failedVm.resetCover();
    await flush();
    const failedImage = fakeImage(
      failedVm.requestToken,
      failedVm.episodeSrc,
      false
    );
    failedVm.finishEpisodeImage(
      failedImage,
      failedVm.requestToken,
      failedVm.episodeSrc
    );
    await flush();
    assert.strictEqual(failedVm.episodeSrc, '');
    assert.strictEqual(failedVm.baseSrc, podcastUrl);

    global.__subscriptionEpisodeCoverCache = createCacheState();
    global.__subscriptionEpisodeCoverCache.get[episodeUrl] = Promise.reject(
      new Error('IndexedDB temporarily unavailable')
    );
    const cacheFailureVm = createVm(component, {
      id: 'cache-failure-row',
      episodeCoverUrl: episodeUrl,
      podcastCoverUrl: podcastUrl,
    });
    cacheFailureVm.resetCover();
    await flush();
    assert.strictEqual(
      cacheFailureVm.episodeSrc,
      episodeUrl,
      'a cache lookup failure must fall back to the episode URL'
    );
    assert.strictEqual(cacheFailureVm.baseSrc, podcastUrl);

    const oldEpisodeUrl = 'https://covers.test/old.jpg';
    const newEpisodeUrl = 'https://covers.test/new.jpg';
    const delayedOld = deferred();
    global.__subscriptionEpisodeCoverCache = createCacheState();
    global.__subscriptionEpisodeCoverCache.get[oldEpisodeUrl] =
      delayedOld.promise;
    const staleVm = createVm(component, {
      id: 'old-row',
      episodeCoverUrl: oldEpisodeUrl,
      podcastCoverUrl: podcastUrl,
    });
    staleVm.resetCover();
    staleVm.episode = {
      id: 'new-row',
      episodeCoverUrl: newEpisodeUrl,
      podcastCoverUrl: podcastUrl,
    };
    staleVm.resetCover();
    await flush();
    assert.strictEqual(staleVm.episodeSrc, newEpisodeUrl);
    delayedOld.resolve('data:image/jpeg;base64,old');
    await flush();
    assert.strictEqual(
      staleVm.episodeSrc,
      newEpisodeUrl,
      'A -> B must discard the old cache result'
    );

    idle = createIdleHarness(true);
    global.window = idle.window;
    global.__subscriptionEpisodeCoverCache = createCacheState();
    const reducedVm = createVm(component, {
      id: 'reduced-row',
      episodeCoverUrl: episodeUrl,
      podcastCoverUrl: podcastUrl,
    });
    reducedVm.resetCover();
    await flush();
    const reducedImage = fakeImage(
      reducedVm.requestToken,
      reducedVm.episodeSrc,
      true
    );
    attachImage(reducedVm, 'episode', reducedImage);
    reducedVm.finishEpisodeImage(
      reducedImage,
      reducedVm.requestToken,
      reducedVm.episodeSrc
    );
    await flush();
    const reducedBaseImage = fakeImage(
      reducedVm.requestToken,
      reducedVm.baseSrc,
      true
    );
    attachImage(reducedVm, 'base', reducedBaseImage);
    reducedVm.finishBaseImage(
      reducedBaseImage,
      reducedVm.requestToken,
      reducedVm.baseSrc
    );
    await flush();
    assert.strictEqual(reducedVm.episodeAnimate, false);
    assert.strictEqual(reducedVm.episodeSettled, true);
    idle.runAll();

    idle = createIdleHarness(false);
    global.window = idle.window;
    global.__subscriptionEpisodeCoverCache = createCacheState();
    const resetVm = createVm(component, {
      id: 'idle-reset-row',
      episodeCoverUrl: episodeUrl,
      podcastCoverUrl: podcastUrl,
    });
    resetVm.resetCover();
    await flush();
    const resetBaseImage = attachImage(
      resetVm,
      'base',
      fakeImage(resetVm.requestToken, resetVm.baseSrc, true)
    );
    resetVm.finishBaseImage(
      resetBaseImage,
      resetVm.requestToken,
      resetVm.baseSrc
    );
    await flush();
    const resetCallbacks = idle.captureCallbacks();
    assert.strictEqual(resetCallbacks.length, 1);
    resetVm.episode = {
      id: 'idle-reset-next-row',
      episodeCoverUrl: newEpisodeUrl,
      podcastCoverUrl: podcastUrl,
    };
    resetVm.resetCover();
    assert.strictEqual(idle.pendingCount(), 0);
    resetCallbacks.forEach(callback =>
      callback({ didTimeout: true, timeRemaining: () => 0 })
    );
    assert.deepStrictEqual(
      global.__subscriptionEpisodeCoverCache.persisted,
      [],
      'a reset must invalidate an idle callback that races cancellation'
    );

    idle = createIdleHarness(false);
    global.window = idle.window;
    global.__subscriptionEpisodeCoverCache = createCacheState();
    const inactiveVm = createVm(component, {
      id: 'idle-inactive-row',
      episodeCoverUrl: episodeUrl,
      podcastCoverUrl: podcastUrl,
    });
    inactiveVm.resetCover();
    await flush();
    const inactiveBaseImage = attachImage(
      inactiveVm,
      'base',
      fakeImage(inactiveVm.requestToken, inactiveVm.baseSrc, true)
    );
    inactiveVm.finishBaseImage(
      inactiveBaseImage,
      inactiveVm.requestToken,
      inactiveVm.baseSrc
    );
    await flush();
    const inactiveTasks = inactiveVm._coverCacheTasks.slice();
    const inactiveCallbacks = idle.captureCallbacks();
    assert.deepStrictEqual(
      inactiveTasks.map(task => task.layer),
      ['base'],
      'only the decoded base image may schedule idle persistence here'
    );
    assert.strictEqual(inactiveCallbacks.length, 1);
    const inactiveTask = inactiveTasks[0];
    component.deactivated.call(inactiveVm);
    assert.strictEqual(inactiveVm._coverActive, false);
    assert.strictEqual(inactiveTask.canceled, true);
    assert.ok(inactiveTasks.every(task => task.canceled));
    assert.strictEqual(inactiveVm._coverCacheTasks.length, 0);
    assert.strictEqual(
      global.__subscriptionEpisodeCoverCache.persisted.length,
      0,
      'deactivation itself must not persist a pending cover'
    );
    inactiveCallbacks.forEach(callback =>
      callback({ didTimeout: true, timeRemaining: () => 0 })
    );
    assert.deepStrictEqual(
      global.__subscriptionEpisodeCoverCache.persisted,
      [],
      'deactivation must invalidate pending idle persistence'
    );

    idle = createIdleHarness(false);
    global.window = idle.window;
    global.__subscriptionEpisodeCoverCache = createCacheState();
    const destroyedVm = createVm(component, {
      id: 'idle-destroyed-row',
      episodeCoverUrl: episodeUrl,
      podcastCoverUrl: podcastUrl,
    });
    destroyedVm.resetCover();
    await flush();
    const destroyedBaseImage = attachImage(
      destroyedVm,
      'base',
      fakeImage(destroyedVm.requestToken, destroyedVm.baseSrc, true)
    );
    destroyedVm.finishBaseImage(
      destroyedBaseImage,
      destroyedVm.requestToken,
      destroyedVm.baseSrc
    );
    await flush();
    const destroyedTask = destroyedVm._coverCacheTasks[0];
    const destroyedCallbacks = idle.captureCallbacks();
    component.beforeDestroy.call(destroyedVm);
    assert.strictEqual(destroyedVm._coverActive, false);
    assert.strictEqual(destroyedTask.canceled, true);
    assert.strictEqual(destroyedVm._coverCacheTasks.length, 0);
    assert.strictEqual(
      global.__subscriptionEpisodeCoverCache.persisted.length,
      0,
      'destruction itself must not persist a pending cover'
    );
    destroyedCallbacks.forEach(callback =>
      callback({ didTimeout: true, timeRemaining: () => 0 })
    );
    assert.deepStrictEqual(
      global.__subscriptionEpisodeCoverCache.persisted,
      [],
      'destruction must invalidate pending idle persistence'
    );

    const componentSource = fs.readFileSync(
      path.join(root, 'src/components/podcast/SubscriptionEpisodeCover.vue'),
      'utf8'
    );
    const persistenceSource = fs.readFileSync(
      path.join(
        root,
        'src/utils/podcast/subscriptionEpisodeCoverPersistence.js'
      ),
      'utf8'
    );
    assert.ok(componentSource.includes('<img'));
    assert.ok(!componentSource.includes('draggable="false"'));
    assert.ok(!componentSource.includes('-webkit-user-drag: none'));
    assert.ok(!componentSource.includes('transition: all'));
    assert.ok(componentSource.includes('visibility: hidden'));
    assert.ok(
      componentSource.includes('enqueueSubscriptionEpisodeCoverPersistence')
    );
    assert.ok(persistenceSource.includes('requestIdleCallback'));
    assert.ok(persistenceSource.includes('setTimeout(callback, 0)'));
    assert.ok(componentSource.includes('pointer-events: none'));
    assert.ok(componentSource.includes('pointer-events: auto'));
    assert.ok(
      componentSource.includes(
        'transition: opacity 140ms cubic-bezier(0.22, 1, 0.36, 1)'
      )
    );

    process.stdout.write('subscription episode cover smoke: PASS\n');
  } finally {
    global.window = previousWindow;
    delete global.__subscriptionEpisodeCoverCache;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
