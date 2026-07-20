const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const viewPath = path.join(root, 'src/views/subscriptionUpdates.vue');
const navbarPath = path.join(root, 'src/components/Navbar.vue');
const feedPath = path.join(
  root,
  'src/components/podcast/SubscriptionEpisodeFeed.vue'
);
const rowPath = path.join(
  root,
  'src/components/podcast/SubscriptionEpisodeRow.vue'
);

function loadComponent(
  source,
  rankSubscriptionRail,
  onSubscriptionUpdatesChanged = () => () => {},
  onSubscriptionUpdatesScrollTop = () => () => {}
) {
  const match = source.match(/<script>([\s\S]*?)<\/script>/);
  assert(match, 'subscription updates page must contain a script block');
  const script = match[1].replace(/^import[\s\S]*?;\r?\n/gm, '').replace(
    'export default {',
    `const ContextMenu = {};
const SvgIcon = {};
const SubscriptionProgramRail = {};
const SubscriptionEpisodeFeed = {};
return {`
  );
  return Function(
    'rankSubscriptionRail',
    'onSubscriptionUpdatesChanged',
    'onSubscriptionUpdatesScrollTop',
    script
  )(
    rankSubscriptionRail,
    onSubscriptionUpdatesChanged,
    onSubscriptionUpdatesScrollTop
  );
}

function createVm(component) {
  const state = component.data.call({});
  let resetCount = 0;
  let smoothTopCount = 0;
  let ensureVisibleCount = 0;
  const vm = {
    ...state,
    $refs: {
      episodeFeed: {
        resetToTop() {
          resetCount += 1;
        },
        scrollToTopSmooth() {
          smoothTopCount += 1;
        },
      },
      programRail: {
        ensureSelectedVisible() {
          ensureVisibleCount += 1;
        },
      },
    },
    $nextTick(callback) {
      callback();
    },
    $set(target, key, value) {
      target[key] = value;
    },
    $route: { name: 'library' },
  };
  Object.keys(component.methods).forEach(name => {
    vm[name] = (...args) => component.methods[name].apply(vm, args);
  });
  return {
    vm,
    getResetCount() {
      return resetCount;
    },
    getEnsureVisibleCount() {
      return ensureVisibleCount;
    },
    getSmoothTopCount() {
      return smoothTopCount;
    },
  };
}

function main() {
  const source = fs.readFileSync(viewPath, 'utf8');
  const navbarSource = fs.readFileSync(navbarPath, 'utf8');
  const feedSource = fs.readFileSync(feedPath, 'utf8');
  const rowSource = fs.readFileSync(rowPath, 'utf8');
  assert(!source.includes(['un', 'finishedOnly'].join('')));
  assert(!source.includes(['未', '听完'].join('')));
  assert(source.includes('@click="setListenFilter(\'all\')"'));
  assert(source.includes('@click="setListenFilter(\'completed\')"'));
  assert(source.includes("listenFilter === 'all'"));
  assert(source.includes("listenFilter === 'completed'"));
  assert(source.includes('已听完'));

  const rankByListenWall = podcasts =>
    [...podcasts].sort(
      (left, right) =>
        Number(right.listenWallSec || 0) - Number(left.listenWallSec || 0)
    );
  let updateScrollListener = null;
  const component = loadComponent(
    source,
    rankByListenWall,
    () => () => {},
    listener => {
      updateScrollListener = listener;
      return () => {};
    }
  );
  const { vm, getResetCount, getEnsureVisibleCount, getSmoothTopCount } =
    createVm(component);
  assert.strictEqual(vm.listenFilter, 'all');

  component.methods.setListenFilter.call(vm, 'completed');
  assert.strictEqual(vm.listenFilter, 'completed');
  assert.strictEqual(getResetCount(), 1);

  component.methods.setListenFilter.call(vm, 'all');
  assert.strictEqual(vm.listenFilter, 'all');
  assert.strictEqual(getResetCount(), 2);

  vm.selectedPodcastId = 'second';
  vm._isActive = true;
  vm._destroyed = false;
  vm.loadInitialSnapshot = () => {};
  vm.scheduleLocalDayRefresh = () => {};
  component.created.call(vm);
  assert.strictEqual(
    typeof updateScrollListener,
    'function',
    'the active update page registers one navbar scroll request listener'
  );
  updateScrollListener();
  assert.strictEqual(
    getSmoothTopCount(),
    1,
    'active update route delegates repeat navigation to the shared smooth back-to-top control'
  );
  assert.strictEqual(
    vm.selectedPodcastId,
    'second',
    'repeat navigation must not reset the selected podcast'
  );
  vm.$route.name = 'subscriptionLibrary';
  component.methods.handleSubscriptionUpdatesScrollTop.call(vm);
  assert.strictEqual(
    getSmoothTopCount(),
    1,
    'secondary subscription management route must not receive the update-feed scroll request'
  );
  vm.$route.name = 'library';
  vm._isActive = false;
  component.methods.handleSubscriptionUpdatesScrollTop.call(vm);
  assert.strictEqual(
    getSmoothTopCount(),
    1,
    'a cached or deactivated update page must ignore repeat navigation events'
  );
  vm._isActive = true;

  assert(
    navbarSource.includes('@click.native="onLibraryNavigation"') &&
      navbarSource.includes("this.$route.name === 'library'") &&
      navbarSource.includes('requestSubscriptionUpdatesScrollTop();'),
    'only an already-active update-route navbar click should request a smooth scroll-to-top'
  );
  assert(
    source.includes('onSubscriptionUpdatesScrollTop(') &&
      source.includes('feed.scrollToTopSmooth()'),
    'the update page owns the event subscription and forwards it to the shared control'
  );
  assert(
    feedSource.includes('ref="backToTop"') &&
      feedSource.includes('scrollToTopSmooth() {') &&
      feedSource.includes('backToTop.scrollToTopSmooth()'),
    'the feed exposes the existing shared back-to-top implementation without copying its animation'
  );
  const playIndex = rowSource.indexOf('@click.stop="$emit(\'play\', episode)"');
  const menuIndex = rowSource.indexOf('icon-class="menu-dots-vertical"');
  assert(
    playIndex >= 0 && menuIndex > playIndex,
    'the update row renders play before more so more is the rightmost action'
  );

  component.methods.setListenFilter.call(vm, 'unknown');
  assert.strictEqual(vm.listenFilter, 'all');
  assert.strictEqual(getResetCount(), 2);

  vm.snapshot = {
    podcasts: [
      { id: 'first', listenWallSec: 1 },
      { id: 'second', listenWallSec: 10 },
    ],
    episodes: [],
  };
  vm.syncRailOrderFromSnapshot();
  assert.deepStrictEqual(vm.railOrderIds, ['first', 'second']);
  vm._railListenWallByPodcast.set('first', 20);
  vm._railOrderDirty = true;
  assert.deepStrictEqual(
    component.computed.railPodcasts.call(vm).map(podcast => podcast.id),
    ['first', 'second'],
    'a listen tick must retain the current rail order until a stable boundary'
  );
  vm.selectedPodcastId = 'second';
  vm._railListenWallByPodcast.set('first', 0);
  vm._railListenWallByPodcast.set('second', 20);
  vm._railOrderDirty = true;
  vm.refreshRailOrdering({ force: true });
  assert.deepStrictEqual(
    vm.railOrderIds,
    ['second', 'first'],
    'stable boundary ordering uses the live per-podcast aggregate'
  );
  assert.strictEqual(
    getEnsureVisibleCount(),
    1,
    'a real stable reorder must retain the selected rail within the scroll context'
  );
  assert.ok(
    source.includes(
      "'$store.state.podcastListening.listenTick'() {\n      this.syncListeningState();"
    ) &&
      !source.includes(
        "'$store.state.podcastListening.listenTick'() {\n      this.refreshRailOrdering"
      ),
    'listen ticks may refresh live aggregates but must not reorder every tick'
  );
  assert.ok(
    source.includes(
      'currentEpisodeId() {\n      this.refreshRailOrdering({ force: true });'
    ) &&
      source.includes(
        'if (wasPlaying && !playing) this.refreshRailOrdering({ force: true });'
      ),
    'track changes and playback stop remain explicit stable reordering boundaries'
  );

  assert.strictEqual(
    component.computed.emptyFilterTitle.call({
      selectedPodcastId: 'pod-a',
      listenFilter: 'completed',
    }),
    '这个节目还没有已听完的单集'
  );
  assert.strictEqual(
    component.computed.emptyFilterTitle.call({
      selectedPodcastId: '',
      listenFilter: 'completed',
    }),
    '当前订阅中还没有已听完的单集'
  );

  console.log('subscription updates component contract smoke passed');
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
