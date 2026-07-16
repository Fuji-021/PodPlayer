const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-subscription-rail-contract-')
);

function closeTo(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 0.02,
    message + ': expected ' + expected + ', received ' + actual
  );
}

function transformOffset(transform) {
  const match = /translate3d\(([-\d.]+)px/.exec(transform || '');
  return match ? Number(match[1]) : 0;
}

function createRafClock() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    request(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
    flush(timestamp) {
      const next = callbacks.entries().next().value;
      if (!next) return false;
      callbacks.delete(next[0]);
      next[1](timestamp);
      return true;
    },
    get size() {
      return callbacks.size;
    },
  };
}

function buildRailHarness(
  component,
  { scrollLeft = 180, reducedMotion = false } = {}
) {
  const pageLeft = 300;
  let viewportWidth = 300;
  let scrollWidth = 800;
  let trackWidth = 400;
  const itemWidth = 80;
  const gap = 10;
  const positions = {
    all: 0,
    B: 90,
    C: 180,
    D: 270,
    E: 360,
    F: 450,
    G: 540,
  };
  const writes = [];
  const timerCalls = [];
  const layoutReads = { viewport: 0, item: 0, track: 0 };
  const raf = createRafClock();
  const rootClasses = new Set();
  let vm;
  let railLeft = scrollLeft;

  const viewport = {
    get clientWidth() {
      layoutReads.viewport += 1;
      return viewportWidth;
    },
    set clientWidth(value) {
      viewportWidth = value;
    },
    get scrollWidth() {
      layoutReads.viewport += 1;
      return scrollWidth;
    },
    set scrollWidth(value) {
      scrollWidth = value;
    },
    get scrollLeft() {
      return railLeft;
    },
    set scrollLeft(value) {
      railLeft = value;
      writes.push(value);
      if (vm && vm._dispatchScrollOnWrite) vm.onScroll();
    },
    getBoundingClientRect() {
      layoutReads.viewport += 1;
      return {
        left: pageLeft,
        right: pageLeft + viewportWidth,
        width: viewportWidth,
      };
    },
  };
  const root = {
    classList: {
      toggle(name, enabled) {
        if (enabled) rootClasses.add(name);
        else rootClasses.delete(name);
      },
    },
  };
  const track = {
    get clientWidth() {
      layoutReads.track += 1;
      return trackWidth;
    },
    set clientWidth(value) {
      trackWidth = value;
    },
  };
  const thumb = { offsetWidth: 64, style: {} };
  const makeItem = (id, contentLeft) => {
    const attributes = {};
    const halo = { style: {} };
    return {
      dataset: { podcastId: id },
      offsetParent: { id: 'page-positioned-parent' },
      // Deliberately page-relative: this is the real regression shape.
      offsetLeft: pageLeft + contentLeft,
      offsetWidth: itemWidth,
      focusOptions: null,
      focusCalls: 0,
      halo,
      focus(options) {
        this.focusCalls += 1;
        this.focusOptions = options || null;
        global.document.activeElement = this;
      },
      setAttribute(name, value) {
        attributes[name] = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attributes, name)
          ? attributes[name]
          : null;
      },
      removeAttribute(name) {
        delete attributes[name];
      },
      querySelector(selector) {
        return selector === '.rail-cover-halo' ? halo : null;
      },
      getBoundingClientRect() {
        layoutReads.item += 1;
        return {
          left: pageLeft + contentLeft - viewport.scrollLeft,
          right: pageLeft + contentLeft - viewport.scrollLeft + itemWidth,
          width: itemWidth,
        };
      },
    };
  };
  const allItem = makeItem('all', positions.all);
  const items = Object.keys(positions)
    .filter(id => id !== 'all')
    .map(id => makeItem(id, positions[id]));
  const emitted = [];
  const data = component.data.call({});

  vm = {
    ...data,
    podcasts: items.map(item => ({
      id: item.dataset.podcastId,
      coverUrl: 'https://covers.test/' + item.dataset.podcastId + '.jpg',
    })),
    selectedPodcastId: '',
    $refs: { root, viewport, track, thumb, items },
    $el: {
      querySelector(selector) {
        return selector === '.rail-all' ? allItem : null;
      },
    },
    $nextTick(callback) {
      callback();
    },
    $set(target, key, value) {
      target[key] = value;
    },
    $emit(name, value) {
      emitted.push({ name, value, goalAtEmit: vm._railGoal });
      if (name !== 'select') return;
      vm.selectedPodcastId = value;
      component.watch.selectedPodcastId.call(vm, value);
    },
    _railActive: true,
    _destroyed: false,
    _dispatchScrollOnWrite: true,
  };
  Object.keys(component.methods).forEach(name => {
    vm[name] = (...args) => component.methods[name].apply(vm, args);
  });

  return {
    vm,
    viewport,
    track,
    thumb,
    writes,
    timerCalls,
    layoutReads,
    raf,
    rootClasses,
    emitted,
    items,
    pageLeft,
    get scrollLeft() {
      return railLeft;
    },
    set scrollLeft(value) {
      railLeft = value;
    },
    reducedMotion,
    itemWidth,
    gap,
  };
}

async function buildComponent() {
  const source = fs.readFileSync(
    path.join(root, 'src/components/podcast/SubscriptionProgramRail.vue'),
    'utf8'
  );
  const script = source.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'SubscriptionProgramRail must contain a script block');
  const entry = path.join(tempDir, 'SubscriptionProgramRail.entry.js');
  const output = path.join(tempDir, 'SubscriptionProgramRail.cjs');
  const podImage = path.join(tempDir, 'PodImage.mock.js');
  const svgIcon = path.join(tempDir, 'SvgIcon.mock.js');
  const coverHalo = path.join(tempDir, 'coverHalo.mock.js');
  fs.writeFileSync(entry, script[1]);
  fs.writeFileSync(podImage, 'export default {};\n');
  fs.writeFileSync(svgIcon, 'export default {};\n');
  fs.writeFileSync(
    coverHalo,
    'export function ensureTinyCover() { return Promise.resolve("tiny-cover"); }\nexport function peekTinyCover() { return "tiny-cover"; }\n'
  );
  await esbuild.build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'subscription-rail-component-mocks',
        setup(build) {
          build.onResolve({ filter: /^@\/components\/PodImage\.vue$/ }, () => ({
            path: podImage,
          }));
          build.onResolve({ filter: /^@\/components\/SvgIcon\.vue$/ }, () => ({
            path: svgIcon,
          }));
          build.onResolve({ filter: /^@\/utils\/podcast\/coverHalo$/ }, () => ({
            path: coverHalo,
          }));
          build.onResolve(
            { filter: /^@\/utils\/podcast\/subscriptionUpdatesRules$/ },
            () => ({
              path: path.join(
                root,
                'src/utils/podcast/subscriptionUpdatesRules.js'
              ),
            })
          );
        },
      },
    ],
  });
  return { component: require(output).default, source };
}

async function main() {
  const saved = {
    document: global.document,
    window: global.window,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
  };
  const listeners = new Map();
  let activeHarness;
  global.document = {
    activeElement: null,
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
  };
  global.window = {
    matchMedia() {
      return { matches: !!(activeHarness && activeHarness.reducedMotion) };
    },
    getComputedStyle() {
      return { gap: '10px', columnGap: '10px' };
    },
  };
  global.requestAnimationFrame = callback =>
    activeHarness.raf.request(callback);
  global.cancelAnimationFrame = id => activeHarness.raf.cancel(id);
  global.setTimeout = (callback, delay) => {
    activeHarness.timerCalls.push({ callback, delay });
    return activeHarness.timerCalls.length;
  };
  global.clearTimeout = () => {};

  try {
    const built = await buildComponent();
    const component = built.component;
    const source = built.source;
    activeHarness = buildRailHarness(component);
    const { vm, viewport, track, thumb, raf, timerCalls, emitted } =
      activeHarness;
    vm.updateMetrics();

    // C is at the left edge while B is hidden. Its offsetParent is not the
    // viewport, so the contract catches page-relative offsetLeft regressions.
    vm.ensureSelectedVisible('C');
    assert.strictEqual(
      vm._railGoal,
      90,
      'left-edge C must move the rail left to reveal B in viewport coordinates; actual goal=' +
        vm._railGoal
    );
    vm.interruptRailMotion();

    activeHarness.scrollLeft = 260;
    vm.updateMetrics();
    vm.ensureSelectedVisible('F');
    assert.strictEqual(
      vm._railGoal,
      320,
      'right-edge F must move the rail right to reveal G in viewport coordinates'
    );
    vm.interruptRailMotion();

    // Selection scroll must be prepared before the parent receives the filter
    // update, otherwise the watcher can retarget after the list has changed.
    activeHarness.scrollLeft = 180;
    vm.updateMetrics();
    vm.select('C');
    assert.strictEqual(
      emitted[0].goalAtEmit,
      90,
      'user selection must calculate its contextual rail target before emit'
    );
    vm.interruptRailMotion();

    const cItem = activeHarness.items.find(
      item => item.dataset.podcastId === 'C'
    );
    vm.prepareRailItemFocus({ currentTarget: cItem, pointerType: 'mouse' });
    assert.deepStrictEqual(
      cItem.focusOptions,
      { preventScroll: true },
      'rail item focus must not compete with contextual rail scrolling'
    );
    assert.strictEqual(
      cItem.focusCalls,
      1,
      'pointer preparation should focus a rail item exactly once'
    );
    assert.strictEqual(
      cItem.getAttribute('data-rail-pointer-focus'),
      'true',
      'pointer focus should be marked locally so it cannot show a keyboard outline'
    );
    vm.select('C', { currentTarget: cItem });
    assert.strictEqual(
      cItem.focusCalls,
      1,
      'click selection must not repeat pointer focus'
    );
    vm.handleRailKeyboardInput();
    assert.strictEqual(
      cItem.getAttribute('data-rail-pointer-focus'),
      null,
      'keyboard input must restore normal focus-visible behavior'
    );
    assert.ok(
      source.includes("&[data-rail-pointer-focus='true']:focus-visible"),
      'only pointer-origin focus may suppress the local outline'
    );
    assert.ok(
      source.includes('&:focus-visible'),
      'keyboard focus-visible outline must remain in the component'
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(vm, 'previewPodcastId') &&
        !Object.prototype.hasOwnProperty.call(vm, 'haloMap') &&
        !source.includes('@pointerenter="previewHalo'),
      'hover must not write a reactive full-rail preview state'
    );
    assert.ok(
      source.includes('--rail-cover-lift: -6px;') &&
        source.includes('--rail-cover-scale: 1.055;') &&
        source.includes('.rail-item:active,'),
      'hover and pointer-active cover feedback must use the documented compositor values'
    );

    // A controller frame owns both native position and thumb transform. The
    // passive scroll event caused by that write must not create a stop timer.
    timerCalls.length = 0;
    activeHarness.scrollLeft = 180;
    vm.updateMetrics();
    activeHarness.layoutReads.viewport = 0;
    activeHarness.layoutReads.item = 0;
    activeHarness.layoutReads.track = 0;
    let controllerStateSyncs = 0;
    const originalSyncRailState = vm.syncRailState;
    vm.syncRailState = metrics => {
      controllerStateSyncs += 1;
      return originalSyncRailState(metrics);
    };
    vm.retargetRailMotion(320);
    assert.strictEqual(raf.size, 1, 'controller must own exactly one rAF');
    for (let frame = 1; frame <= 3; frame += 1) {
      assert.ok(
        raf.flush(frame * 16),
        'controller should schedule frame ' + frame
      );
      const ratio = viewport.scrollLeft / vm._metrics.maxScroll;
      const expected = vm._thumbGeometry.travel * ratio;
      closeTo(
        transformOffset(thumb.style.transform),
        expected,
        'thumb must share the controller frame position'
      );
    }
    assert.strictEqual(
      controllerStateSyncs,
      3,
      'controller-owned scroll events must not run a second state update'
    );
    assert.deepStrictEqual(
      activeHarness.layoutReads,
      { viewport: 0, item: 0, track: 0 },
      'controller frames must not remeasure viewport, items, or thumb geometry'
    );
    assert.strictEqual(
      timerCalls.length,
      0,
      'controller-owned scroll events must not schedule stop timers'
    );
    vm.syncRailState = originalSyncRailState;
    vm.interruptRailMotion();
    assert.strictEqual(
      raf.size,
      0,
      'interrupt must cancel the pending controller frame'
    );
    assert.ok(
      !activeHarness.rootClasses.has('is-moving'),
      'interrupt must finish the rail motion class once'
    );

    // The newest selection wins before the next animation frame; stale watcher
    // work must not overwrite it.
    activeHarness.scrollLeft = 260;
    vm.updateMetrics();
    vm.selectedPodcastId = '';
    emitted.length = 0;
    vm.select('C');
    vm.select('F');
    vm.select('D');
    assert.strictEqual(
      vm._railGoal,
      180,
      "rapid C to F to D selection must retain D's newest contextual target; actual goal=" +
        vm._railGoal
    );
    assert.strictEqual(
      raf.size,
      1,
      'rapid selection changes must retarget one existing controller rAF'
    );
    assert.deepStrictEqual(
      emitted.map(item => item.goalAtEmit),
      [90, 320, 180],
      'each user selection must calculate its own target before emit'
    );
    vm.interruptRailMotion();

    // Native wheel and thumb dragging each merge their latest input through
    // one rAF; controller ownership is not reused as a second scroll loop.
    activeHarness.scrollLeft = 180;
    vm.updateMetrics();
    let prevented = 0;
    vm.handleRailWheel({
      deltaX: 30,
      deltaY: 0,
      shiftKey: false,
      preventDefault() {
        prevented += 1;
      },
    });
    vm.handleRailWheel({
      deltaX: 20,
      deltaY: 0,
      shiftKey: false,
      preventDefault() {
        prevented += 1;
      },
    });
    assert.strictEqual(raf.size, 1, 'wheel updates must merge into one rAF');
    assert.strictEqual(
      prevented,
      2,
      'only handled horizontal wheel events prevent page scroll'
    );
    assert.ok(raf.flush(80), 'wheel frame should commit the latest position');
    assert.strictEqual(
      viewport.scrollLeft,
      230,
      'wheel frame should merge both deltas'
    );
    vm.interruptRailMotion();

    const dragTarget = {
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    vm.startDrag({
      isPrimary: true,
      pointerId: 7,
      clientX: 10,
      currentTarget: dragTarget,
    });
    vm.onDragMove({ pointerId: 7, clientX: 35 });
    vm.onDragMove({ pointerId: 7, clientX: 60 });
    assert.strictEqual(raf.size, 1, 'drag updates must merge into one rAF');
    assert.ok(
      raf.flush(96),
      'drag frame should commit the latest pointer position'
    );
    vm.finishDrag({ pointerId: 7 });
    assert.strictEqual(
      listeners.size,
      0,
      'drag cleanup must remove document listeners'
    );

    // Resize changes geometry only at the explicit measurement boundary. First
    // and last targets remain clamped even when the viewport gets wider.
    viewport.clientWidth = 500;
    track.clientWidth = 500;
    activeHarness.scrollLeft = 20;
    vm.updateMetrics();
    assert.strictEqual(
      vm._metrics.maxScroll,
      300,
      'resize should refresh the rail range once'
    );
    assert.ok(
      Number.parseFloat(thumb.style.width) > 64,
      'resize should refresh thumb geometry'
    );
    vm.retargetRailMotion(-100);
    assert.strictEqual(vm._railGoal, 0, 'first-edge target must clamp to zero');
    vm.interruptRailMotion();
    activeHarness.scrollLeft = 280;
    vm.updateMetrics();
    vm.retargetRailMotion(900);
    assert.strictEqual(
      vm._railGoal,
      300,
      'last-edge target must clamp to max scroll'
    );
    vm.interruptRailMotion();

    // Reduced motion still uses the same commit path, but does not schedule a
    // frame or leave a stale controller goal behind.
    activeHarness = buildRailHarness(component, {
      scrollLeft: 180,
      reducedMotion: true,
    });
    activeHarness.vm.updateMetrics();
    activeHarness.vm.retargetRailMotion(320);
    assert.strictEqual(activeHarness.viewport.scrollLeft, 320);
    assert.strictEqual(activeHarness.raf.size, 0);

    const hoverVm = activeHarness.vm;
    const hoverItem = activeHarness.items.find(
      item => item.dataset.podcastId === 'C'
    );
    const hoverPodcast = hoverVm.podcasts.find(item => item.id === 'C');
    hoverVm.beginHaloHover(hoverPodcast, hoverItem);
    assert.strictEqual(
      hoverItem.halo.style.backgroundImage,
      'url("tiny-cover")',
      'hover halo should update only the hovered DOM item without a Vue preview state'
    );
    hoverVm.endHaloHover(hoverPodcast, hoverItem);
    assert.strictEqual(
      hoverItem.halo.style.backgroundImage,
      '',
      'unselected hover must release its halo image after pointer leave'
    );

    console.log('subscription program rail component contract smoke passed');
  } finally {
    global.document = saved.document;
    global.window = saved.window;
    global.requestAnimationFrame = saved.requestAnimationFrame;
    global.cancelAnimationFrame = saved.cancelAnimationFrame;
    global.setTimeout = saved.setTimeout;
    global.clearTimeout = saved.clearTimeout;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
