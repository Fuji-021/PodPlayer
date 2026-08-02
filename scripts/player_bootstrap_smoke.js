const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function loadPlayer(personalFM) {
  let source = fs.readFileSync(path.join(root, 'src/utils/Player.js'), 'utf8');
  source = source.replace(/^import[\s\S]*?;\r?\n/gm, '');
  source = source.replace('export default class {', 'class Player {');
  source += '\nmodule.exports = Player;';
  const context = {
    module: { exports: {} },
    exports: {},
    document: { title: '' },
    process: { env: {} },
    setTimeout,
    clearTimeout,
    __personalFM: personalFM,
  };
  vm.runInNewContext('const personalFM = __personalFM;\n' + source, context, {
    filename: 'Player.js',
  });
  return context.module.exports;
}

function createBootstrapState() {
  return {
    _enabled: false,
    _currentTrack: null,
    _personalFMTrack: { id: 0 },
    _personalFMNextTrack: { id: 0 },
    _loadSelfFromLocalStorage() {},
    _initMediaSession() {},
    _setIntervals() {},
  };
}

function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

async function main() {
  const valid = createBootstrapState();
  loadPlayer(() =>
    Promise.resolve({ data: [{ id: 101 }, { id: 102 }] })
  ).prototype._init.call(valid);
  await settle();
  assert.strictEqual(valid._personalFMTrack.id, 101);
  assert.strictEqual(valid._personalFMNextTrack.id, 102);

  const empty = createBootstrapState();
  loadPlayer(() => Promise.resolve(undefined)).prototype._init.call(empty);
  await settle();
  assert.deepStrictEqual(empty._personalFMTrack, { id: 0 });
  assert.deepStrictEqual(empty._personalFMNextTrack, { id: 0 });

  const rejected = createBootstrapState();
  const rejections = [];
  const onUnhandledRejection = reason => rejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    loadPlayer(() =>
      Promise.reject(new Error('personal-fm-unavailable'))
    ).prototype._init.call(rejected);
    await settle();
    await settle();
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
  assert.strictEqual(
    rejections.length,
    0,
    'a failed personal FM prefetch must not create an unhandled rejection'
  );
  assert.deepStrictEqual(rejected._personalFMTrack, { id: 0 });
  assert.deepStrictEqual(rejected._personalFMNextTrack, { id: 0 });

  console.log('player bootstrap smoke: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
