const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const viewPath = path.join(root, 'src/views/subscriptionUpdates.vue');

function loadComponent(source) {
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
  return Function(script)();
}

function createVm(component) {
  const state = component.data.call({});
  let resetCount = 0;
  return {
    vm: {
      ...state,
      $refs: {
        episodeFeed: {
          resetToTop() {
            resetCount += 1;
          },
        },
      },
      $nextTick(callback) {
        callback();
      },
    },
    getResetCount() {
      return resetCount;
    },
  };
}

function main() {
  const source = fs.readFileSync(viewPath, 'utf8');
  assert(!source.includes(['un', 'finishedOnly'].join('')));
  assert(!source.includes(['未', '听完'].join('')));
  assert(source.includes('@click="setListenFilter(\'all\')"'));
  assert(source.includes('@click="setListenFilter(\'completed\')"'));
  assert(source.includes("listenFilter === 'all'"));
  assert(source.includes("listenFilter === 'completed'"));
  assert(source.includes('已听完'));

  const component = loadComponent(source);
  const { vm, getResetCount } = createVm(component);
  assert.strictEqual(vm.listenFilter, 'all');

  component.methods.setListenFilter.call(vm, 'completed');
  assert.strictEqual(vm.listenFilter, 'completed');
  assert.strictEqual(getResetCount(), 1);

  component.methods.setListenFilter.call(vm, 'all');
  assert.strictEqual(vm.listenFilter, 'all');
  assert.strictEqual(getResetCount(), 2);

  component.methods.setListenFilter.call(vm, 'unknown');
  assert.strictEqual(vm.listenFilter, 'all');
  assert.strictEqual(getResetCount(), 2);

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
