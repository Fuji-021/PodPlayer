const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const componentPath = path.join(root, 'src/components/MainScrollBackToTop.vue');
const feedPath = path.join(
  root,
  'src/components/podcast/SubscriptionEpisodeFeed.vue'
);
const podcastDetailPath = path.join(root, 'src/views/podcastDetail.vue');
const episodeDetailPath = path.join(root, 'src/views/episodeDetail.vue');
const transcriptPanelPath = path.join(
  root,
  'src/components/TranscriptPanel.vue'
);

function loadComponent(source) {
  const match = source.match(/<script>([\s\S]*?)<\/script>/);
  assert(match, 'shared back-to-top component must contain a script block');
  const script = match[1]
    .replace(/^import SvgIcon from .*;\r?\n/gm, '')
    .replace('export default {', 'const SvgIcon = {};\nreturn {');
  return Function(script)();
}

function createRafScheduler() {
  let nextId = 1;
  const frames = new Map();
  return {
    request(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancel(id) {
      frames.delete(id);
    },
    runOne(now) {
      const entry = frames.entries().next();
      assert(!entry.done, 'expected one queued animation frame');
      const [id, callback] = entry.value;
      frames.delete(id);
      callback(now);
    },
    get size() {
      return frames.size;
    },
  };
}

function createMain() {
  const listeners = new Map();
  return {
    scrollTop: 0,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    emit(type) {
      const listener = listeners.get(type);
      if (listener) listener({ type });
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function createVm(component, main) {
  const vm = {
    ...component.data.call({}),
    threshold: 520,
    $el: { closest: selector => (selector === 'main' ? main : null) },
    $parent: null,
    $nextTick(callback) {
      callback();
    },
  };
  Object.keys(component.methods).forEach(name => {
    vm[name] = (...args) => component.methods[name].apply(vm, args);
  });
  vm._destroyed = false;
  vm._isActive = true;
  vm.bindMainScroll();
  return vm;
}

function main() {
  const componentSource = fs.readFileSync(componentPath, 'utf8');
  const feedSource = fs.readFileSync(feedPath, 'utf8');
  const podcastDetailSource = fs.readFileSync(podcastDetailPath, 'utf8');
  const episodeDetailSource = fs.readFileSync(episodeDetailPath, 'utf8');
  const transcriptPanelSource = fs.readFileSync(transcriptPanelPath, 'utf8');

  assert(componentSource.includes('v-tip="\'回到顶部\'"'));
  assert(componentSource.includes('aria-label="回到顶部"'));
  assert(componentSource.includes('scrollTop > this.threshold'));
  assert(componentSource.includes("addEventListener('wheel'"));
  assert(componentSource.includes("addEventListener('pointerdown'"));
  assert(componentSource.includes("addEventListener('touchstart'"));
  assert(componentSource.includes('deactivated()'));
  assert(componentSource.includes('beforeDestroy()'));

  [feedSource, podcastDetailSource, episodeDetailSource].forEach(source => {
    assert(
      source.includes(
        "import MainScrollBackToTop from '@/components/MainScrollBackToTop.vue'"
      )
    );
    assert(source.includes('<MainScrollBackToTop />'));
  });
  assert(!feedSource.includes('showBackTop'));
  assert(!feedSource.includes('scrollToTopSmooth'));
  assert(!feedSource.includes('updates-back-top'));
  assert(podcastDetailSource.includes('pendingRestore'));
  assert(podcastDetailSource.includes('this._bindScroll()'));
  assert(podcastDetailSource.includes('this._onMainScroll()'));
  // The transcript toolbar is now intentionally limited to follow, display
  // version, AI tools, and more. Page-level back-to-top remains the shared
  // component above, so the retired inline toolbar action must not return.
  assert(!transcriptPanelSource.includes('t-top-link'));
  assert(!transcriptPanelSource.includes('scrollPageTop'));
  assert(!transcriptPanelSource.includes('回到本页顶部'));

  const component = loadComponent(componentSource);
  const scheduler = createRafScheduler();
  const oldRaf = global.requestAnimationFrame;
  const oldCancelRaf = global.cancelAnimationFrame;
  global.requestAnimationFrame = callback => scheduler.request(callback);
  global.cancelAnimationFrame = id => scheduler.cancel(id);

  try {
    const mainElement = createMain();
    const vm = createVm(component, mainElement);
    assert.strictEqual(
      mainElement.listenerCount(),
      4,
      'bind once per main target'
    );

    mainElement.scrollTop = 520;
    mainElement.emit('scroll');
    scheduler.runOne(0);
    assert.strictEqual(vm.visible, false, 'threshold is exclusive at 520px');

    mainElement.scrollTop = 521;
    mainElement.emit('scroll');
    scheduler.runOne(1);
    assert.strictEqual(vm.visible, true, 'show once beyond threshold');

    mainElement.scrollTop = 1600;
    vm.scrollToTopSmooth();
    assert.strictEqual(scheduler.size, 1, 'one click queues one rAF');
    vm.scrollToTopSmooth();
    assert.strictEqual(
      scheduler.size,
      1,
      'repeat clicks replace, not stack rAFs'
    );
    scheduler.runOne(100000);
    assert.strictEqual(
      mainElement.scrollTop,
      0,
      'final animation frame reaches exact top'
    );
    assert.strictEqual(vm.visible, false, 'completed animation hides button');

    ['wheel', 'pointerdown', 'touchstart'].forEach(type => {
      mainElement.scrollTop = 1200;
      vm.scrollToTopSmooth();
      assert.strictEqual(scheduler.size, 1, `${type} test begins with one rAF`);
      mainElement.emit(type);
      assert.strictEqual(
        scheduler.size,
        0,
        `${type} interrupts smooth scrolling`
      );
    });

    component.deactivated.call(vm);
    assert.strictEqual(
      mainElement.listenerCount(),
      0,
      'deactivate releases listeners'
    );
    assert.strictEqual(scheduler.size, 0, 'deactivate releases rAF');

    const destroyMain = createMain();
    const destroyVm = createVm(component, destroyMain);
    destroyMain.scrollTop = 900;
    destroyVm.scrollToTopSmooth();
    component.beforeDestroy.call(destroyVm);
    assert.strictEqual(
      destroyMain.listenerCount(),
      0,
      'destroy releases listeners'
    );
    assert.strictEqual(scheduler.size, 0, 'destroy releases rAF');
  } finally {
    global.requestAnimationFrame = oldRaf;
    global.cancelAnimationFrame = oldCancelRaf;
  }

  console.log('main scroll back-to-top smoke: PASS');
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
