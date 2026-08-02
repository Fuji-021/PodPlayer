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
    `${message}: expected ${expected}, received ${actual}`
  );
}

function transformOffset(transform) {
  const match = /translate3d\(([-\d.]+)px/.exec(transform || '');
  return match ? Number(match[1]) : 0;
}

function createEvent(type, options = {}) {
  return {
    type,
    key: options.key || '',
    target: options.target || null,
    currentTarget: options.currentTarget || options.target || null,
    deltaX: options.deltaX || 0,
    deltaY: options.deltaY || 0,
    shiftKey: !!options.shiftKey,
    pointerId: options.pointerId || 1,
    clientX: options.clientX || 0,
    isPrimary: options.isPrimary !== false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
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
  const itemWidth = 80;
  let viewportWidth = 300;
  let trackWidth = 400;
  let railLeft = scrollLeft;
  let vm;
  const raf = createRafClock();
  const writes = [];
  const layoutReads = { viewport: 0, item: 0, track: 0 };
  const timerCalls = [];
  const rootClasses = new Set();
  const viewportAttributes = {};
  const viewportStyle = {};

  const viewport = {
    style: {
      setProperty(name, value) {
        viewportStyle[name] = String(value);
      },
    },
    get clientWidth() {
      layoutReads.viewport += 1;
      return viewportWidth;
    },
    set clientWidth(value) {
      viewportWidth = value;
    },
    get scrollWidth() {
      layoutReads.viewport += 1;
      return 800;
    },
    get scrollLeft() {
      return railLeft;
    },
    set scrollLeft(value) {
      railLeft = value;
      writes.push(value);
      if (vm && vm._dispatchScrollOnWrite) vm.onScroll();
    },
    focus(options) {
      this.focusOptions = options || null;
      this.focusCalls = (this.focusCalls || 0) + 1;
      global.document.focusElement(this);
    },
    blur() {
      if (global.document.activeElement === this)
        global.document.focusElement(null);
    },
    setAttribute(name, value) {
      viewportAttributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(viewportAttributes, name)
        ? viewportAttributes[name]
        : null;
    },
    removeAttribute(name) {
      delete viewportAttributes[name];
    },
  };
  const rootNode = {
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

  const makeItem = id => {
    const attributes = {};
    const halo = { style: {} };
    return {
      dataset: { podcastId: id },
      offsetWidth: itemWidth,
      halo,
      focusCalls: 0,
      focus(options) {
        this.focusCalls += 1;
        this.focusOptions = options || null;
        global.document.focusElement(this);
      },
      blur() {
        if (global.document.activeElement === this) {
          global.document.focusElement(null);
        }
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
        if (selector === '.rail-cover-halo') return halo;
        if (selector === '.rail-cover-image') return { offsetWidth: 72 };
        return null;
      },
    };
  };

  const allItem = makeItem('');
  const ids = ['B', 'C', 'D', 'E', 'F', 'G'];
  const items = ids.map(makeItem);
  viewport.contains = target =>
    target === viewport || target === allItem || items.includes(target);
  const emitted = [];
  const data = component.data.call({});
  vm = {
    ...data,
    podcasts: items.map(item => ({
      id: item.dataset.podcastId,
      coverUrl: `https://covers.test/${item.dataset.podcastId}.jpg`,
    })),
    selectedPodcastId: '',
    $refs: { root: rootNode, viewport, track, thumb, items },
    $el: {
      querySelector(selector) {
        return selector === '.rail-all' ? allItem : null;
      },
    },
    $nextTick(callback) {
      callback();
    },
    $emit(name, value) {
      emitted.push({ name, value, goalAtEmit: vm._railGoalStart });
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
    viewportStyle,
    track,
    thumb,
    allItem,
    items,
    emitted,
    raf,
    writes,
    layoutReads,
    timerCalls,
    rootClasses,
    get scrollLeft() {
      return railLeft;
    },
    set scrollLeft(value) {
      railLeft = value;
    },
    reducedMotion,
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
  const addListener = (name, callback) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
  };
  const removeListener = (name, callback) => {
    const set = listeners.get(name);
    if (!set) return;
    set.delete(callback);
    if (!set.size) listeners.delete(name);
  };
  global.document = {
    activeElement: null,
    addEventListener: addListener,
    removeEventListener: removeListener,
    dispatchEvent(event) {
      const set = listeners.get(event.type);
      if (set) [...set].forEach(listener => listener(event));
      return !event.defaultPrevented;
    },
    focusElement(target) {
      const previous = this.activeElement;
      if (previous === target) return;
      if (previous && activeHarness) {
        activeHarness.vm.handleRailFocusOut({
          target: previous,
          relatedTarget: target,
        });
      }
      this.activeElement = target;
      if (target && activeHarness && activeHarness.viewport.contains(target)) {
        activeHarness.vm.handleRailFocusIn({ target, relatedTarget: previous });
      }
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
    const { component, source } = await buildComponent();
    activeHarness = buildRailHarness(component);
    const {
      vm,
      viewport,
      viewportStyle,
      thumb,
      allItem,
      items,
      emitted,
      raf,
      writes,
      layoutReads,
      rootClasses,
    } = activeHarness;
    const item = id => items.find(entry => entry.dataset.podcastId === id);
    const flushMotion = (startAt = 0) => {
      let now = startAt;
      let guard = 0;
      while (raf.size && guard < 12) {
        now += 100;
        raf.flush(now);
        guard += 1;
      }
      assert.ok(
        guard < 12,
        'rail controller must settle without an unbounded rAF tail'
      );
    };
    const pointerSelect = (target, id) => {
      vm.handleRailPointerDown(createEvent('pointerdown', { target }));
      target.focus(); // native button focus, not component-managed focus
      vm.select(id);
    };

    vm.updateMetrics();
    assert.strictEqual(viewportStyle['--rail-outer-gutter'], '20px');
    assert.strictEqual(vm._railRenderPosition, 2);
    assert.strictEqual(vm._railWindowStart, 2);
    assert.ok(!source.includes('getRailSlotSelectionTarget'));
    assert.ok(!source.includes('getRailSlotArrowGoal'));
    assert.ok(!source.includes('getRailSlotTarget'));
    assert.ok(source.includes('getRailWindowSelectionTarget'));
    assert.ok(source.includes('getRailWindowRevealTarget'));
    assert.ok(source.includes('getRailRenderMotionFrame'));
    assert.ok(!source.includes('draggable="false"'));
    assert.ok(!source.includes('-webkit-user-drag: none'));
    assert.ok(!source.includes('@dragstart.prevent'));
    assert.ok(source.includes("[data-rail-keyboard-focus='true']:focus"));
    assert.ok(!source.includes(':focus-visible'));

    // Real click chain: pointerdown -> native focus -> select -> parent prop
    // writeback -> watcher -> rAF -> programmatic scroll/thumb projection.
    pointerSelect(item('C'), 'C');
    assert.strictEqual(vm._railGoalStart, 1, 'left edge C must reveal B');
    assert.strictEqual(
      emitted[0].goalAtEmit,
      1,
      'parent writeback sees one logical goal'
    );
    assert.strictEqual(
      item('C').getAttribute('data-rail-keyboard-focus'),
      null
    );
    assert.strictEqual(allItem.getAttribute('data-rail-keyboard-focus'), null);
    assert.strictEqual(raf.size, 1, 'selection must use one controller rAF');
    flushMotion();
    assert.strictEqual(
      viewport.scrollLeft,
      90,
      'left edge advances one slot only'
    );
    closeTo(
      transformOffset(thumb.style.transform),
      vm._thumbGeometry.travel / 4,
      'thumb shares C edge frame'
    );

    vm.commitRailFrame(2, { settled: true });
    vm.selectedPodcastId = '';
    emitted.length = 0;
    pointerSelect(item('E'), 'E');
    assert.strictEqual(vm._railGoalStart, 3, 'right edge E must reveal F');
    flushMotion(400);
    assert.strictEqual(
      viewport.scrollLeft,
      270,
      'right edge advances one slot only'
    );

    vm.commitRailFrame(2, { settled: true });
    vm.selectedPodcastId = '';
    const beforeMiddleWriteCount = writes.length;
    pointerSelect(item('D'), 'D');
    assert.strictEqual(
      vm._railGoalStart,
      null,
      'middle selection must not queue motion'
    );
    assert.strictEqual(
      writes.length,
      beforeMiddleWriteCount,
      'middle selection keeps scrollLeft intact'
    );
    assert.strictEqual(
      raf.size,
      0,
      'middle selection has no controller animation'
    );

    vm.commitRailFrame(2, { settled: true });
    vm.selectedPodcastId = 'E';
    const repeatEmitCount = emitted.length;
    pointerSelect(item('E'), 'E');
    assert.strictEqual(
      emitted.length,
      repeatEmitCount,
      'same selected feed does not emit a duplicate filter event'
    );
    assert.strictEqual(
      vm._railGoalStart,
      3,
      'same selected right edge still advances the carousel'
    );
    flushMotion(800);
    assert.strictEqual(viewport.scrollLeft, 270);

    vm.commitRailFrame(2, { settled: true });
    vm.selectedPodcastId = '';
    emitted.length = 0;
    pointerSelect(item('C'), 'C');
    pointerSelect(item('F'), 'F');
    pointerSelect(item('G'), 'G');
    assert.strictEqual(
      vm._railGoalStart,
      4,
      'rapid A->B->C style input keeps only the latest logical target'
    );
    assert.deepStrictEqual(
      emitted.map(entry => entry.goalAtEmit),
      [1, 3, 4]
    );
    flushMotion(1200);
    assert.strictEqual(
      viewport.scrollLeft,
      360,
      'latest selection wins without returning to an obsolete target'
    );

    // Parent prop echoes can arrive out of order. A stale C echo must not
    // reveal C after the user has already requested F.
    vm.commitRailFrame(2, { settled: true });
    vm.selectedPodcastId = '';
    const originalEmit = vm.$emit;
    vm.$emit = () => {};
    vm.select('C');
    vm.select('F');
    assert.strictEqual(vm._pendingUserSelection.id, 'F');
    assert.strictEqual(vm._railGoalStart, 3);
    vm.selectedPodcastId = 'C';
    component.watch.selectedPodcastId.call(vm, 'C');
    assert.strictEqual(
      vm._railGoalStart,
      3,
      'a stale parent echo must not overwrite the latest rail selection goal'
    );
    assert.strictEqual(vm._pendingUserSelection.id, 'F');
    vm.selectedPodcastId = 'F';
    component.watch.selectedPodcastId.call(vm, 'F');
    assert.strictEqual(vm._pendingUserSelection, null);
    vm.$emit = originalEmit;
    vm.interruptRailMotion();

    // A controller frame cannot read layout and commits rail and thumb using
    // exactly the same renderPosition.
    vm.commitRailFrame(1, { settled: true });
    layoutReads.viewport = 0;
    layoutReads.item = 0;
    layoutReads.track = 0;
    vm.retargetRailMotion(3, { direction: 1 });
    assert.strictEqual(raf.size, 1);
    raf.flush(1600);
    const firstRenderPosition = vm._railRenderPosition;
    closeTo(
      transformOffset(thumb.style.transform),
      (vm._thumbGeometry.travel * firstRenderPosition) / vm.getRailMaxStart(),
      'controller frame projects one renderPosition to thumb'
    );
    assert.deepStrictEqual(layoutReads, { viewport: 0, item: 0, track: 0 });
    flushMotion(1600);
    assert.strictEqual(viewport.scrollLeft, 270);
    assert.ok(!rootClasses.has('is-moving'));

    vm.commitRailFrame(2, { settled: true });
    vm.scrollRail(1);
    assert.strictEqual(
      vm._railGoalStart,
      4,
      'arrow pages visibleCount - 1 slots'
    );
    vm.scrollRail(-1);
    assert.strictEqual(
      vm._railGoalStart,
      0,
      'reverse arrow derives from the live render position'
    );
    vm.interruptRailMotion();

    vm.commitRailFrame(2, { settled: true });
    let prevented = 0;
    vm.handleRailWheel({
      ...createEvent('wheel', { deltaX: 30, target: viewport }),
      preventDefault() {
        prevented += 1;
      },
    });
    vm.handleRailWheel({
      ...createEvent('wheel', { deltaX: 20, target: viewport }),
      preventDefault() {
        prevented += 1;
      },
    });
    assert.strictEqual(raf.size, 1, 'wheel frames merge current input');
    raf.flush(2000);
    closeTo(
      viewport.scrollLeft,
      230,
      'wheel keeps a fractional physical render position'
    );
    vm.finishNativeRailMotion();
    assert.strictEqual(
      vm._railGoalStart,
      3,
      'wheel release snaps to a complete slot'
    );
    vm.interruptRailMotion();
    assert.strictEqual(prevented, 2);

    vm.commitRailFrame(1, { settled: true });
    const dragTarget = {
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    vm.startDrag(
      createEvent('pointerdown', {
        pointerId: 7,
        clientX: 10,
        currentTarget: dragTarget,
      })
    );
    vm.onDragMove(createEvent('pointermove', { pointerId: 7, clientX: 52 }));
    assert.strictEqual(
      raf.size,
      1,
      'thumb drag merges pointer input through one rAF'
    );
    raf.flush(2200);
    assert.ok(
      vm._railRenderPosition > 1,
      'thumb drag updates logical render position'
    );
    vm.finishDrag(createEvent('pointerup', { pointerId: 7 }));
    assert.ok(
      !vm._drag,
      'pointer capture and temporary drag state must be released on pointerup'
    );
    vm.interruptRailMotion();

    // Resize changes geometry at a measurement boundary, clamps the logical
    // window, and only then performs a reveal if the selected item is outside.
    viewport.clientWidth = 500;
    vm.updateMetrics(true);
    assert.strictEqual(vm._railSlotLayout.visibleCount, 5);
    assert.strictEqual(vm.getRailMaxStart(), 2);
    assert.ok(
      vm._railRenderPosition <= 2,
      'resize clamps to the new complete-slot range'
    );

    vm.bindRailTabTracking();
    assert.ok(listeners.has('keydown') && listeners.has('keyup'));
    global.document.dispatchEvent(
      createEvent('keydown', { key: 'Tab', target: { id: 'before-rail' } })
    );
    viewport.focus({ preventScroll: true });
    global.document.dispatchEvent(
      createEvent('keyup', { key: 'Tab', target: viewport })
    );
    assert.strictEqual(
      viewport.getAttribute('data-rail-keyboard-focus'),
      'true'
    );
    vm.moveRailFocus(1);
    const keyboardTarget = global.document.activeElement;
    assert.strictEqual(
      keyboardTarget.getAttribute('data-rail-keyboard-focus'),
      'true'
    );
    const homeEvent = createEvent('keydown', {
      key: 'Home',
      target: keyboardTarget,
    });
    vm.handleRailEdgeKey(homeEvent, false);
    assert.strictEqual(homeEvent.defaultPrevented, true);
    assert.strictEqual(global.document.activeElement, allItem);

    vm.deactivateRail();
    assert.strictEqual(
      listeners.size,
      0,
      'deactivation releases document listeners'
    );

    activeHarness = buildRailHarness(component, {
      scrollLeft: 180,
      reducedMotion: true,
    });
    activeHarness.vm.updateMetrics();
    activeHarness.vm.retargetRailMotion(3, { direction: 1 });
    assert.strictEqual(activeHarness.viewport.scrollLeft, 270);
    assert.strictEqual(
      activeHarness.raf.size,
      0,
      'reduced motion shares targets but skips rAF animation'
    );

    activeHarness.vm.deactivateRail();
    assert.strictEqual(
      listeners.size,
      0,
      'deactivation releases document listeners'
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
