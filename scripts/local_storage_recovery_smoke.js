const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-local-storage-recovery-')
);

function createStorage(values) {
  const records = Object.assign({}, values);
  const writes = [];
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(records, key)
        ? records[key]
        : null;
    },
    setItem(key, value) {
      writes.push([key, value]);
      records[key] = String(value);
    },
    snapshot() {
      return Object.assign({}, records);
    },
    writes,
  };
}

async function bundle(entry, outfile, plugins) {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: plugins || [],
  });
  return require(outfile);
}

function helperPlugin() {
  return {
    name: 'local-storage-helper-alias',
    setup(build) {
      build.onResolve({ filter: /^@\/utils\/safeLocalStorage$/ }, () => ({
        path: path.join(root, 'src', 'utils', 'safeLocalStorage.js'),
      }));
    },
  };
}

async function main() {
  try {
    const helper = await bundle(
      path.join(root, 'src', 'utils', 'safeLocalStorage.js'),
      path.join(tempDir, 'safe-local-storage.cjs')
    );

    assert.deepStrictEqual(
      helper.parseStoredJson(null, [], 'array'),
      { value: [], status: 'missing' }
    );
    assert.deepStrictEqual(
      helper.parseStoredJson('{broken', { safe: true }, 'object'),
      { value: { safe: true }, status: 'invalid-json' }
    );
    assert.deepStrictEqual(
      helper.parseStoredJson('[]', { safe: true }, 'object'),
      { value: { safe: true }, status: 'type-mismatch' }
    );
    assert.deepStrictEqual(
      helper.parseStoredJson('{}', [], 'array'),
      { value: [], status: 'type-mismatch' }
    );
    assert.deepStrictEqual(
      helper.parseStoredJson('{"legacy":true}', {}, 'object'),
      { value: { legacy: true }, status: 'ok' }
    );

    const fake = createStorage({ invalid: '{truncated', array: '{}' });
    assert.deepStrictEqual(
      helper.readLocalStorageJson('invalid', { enabled: false }, 'object', fake),
      { enabled: false }
    );
    assert.deepStrictEqual(
      helper.readLocalStorageJson('array', [], 'array', fake),
      []
    );
    assert.strictEqual(fake.writes.length, 0, 'reads must not rewrite bad data');

    const mocks = path.join(tempDir, 'mocks');
    fs.mkdirSync(mocks, { recursive: true });
    const init = path.join(mocks, 'init.js');
    const update = path.join(mocks, 'update.js');
    fs.writeFileSync(
      init,
      "export default { settings: { shortcuts: [], proxyConfig: {} }, data: { user: {} } };\n"
    );
    fs.writeFileSync(update, 'export default function () {}\n');
    const stateOut = path.join(tempDir, 'state.cjs');
    await esbuild.build({
      entryPoints: [path.join(root, 'src', 'store', 'state.js')],
      outfile: stateOut,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
      plugins: [
        helperPlugin(),
        {
          name: 'state-module-mocks',
          setup(build) {
            build.onResolve({ filter: /^\.\/initLocalStorage$/ }, args => {
              if (args.importer.endsWith(path.join('store', 'state.js'))) {
                return { path: init };
              }
              return null;
            });
            build.onResolve({ filter: /^@\/utils\/updateApp$/ }, () => ({
              path: update,
            }));
          },
        },
      ],
    });
    const previousStorage = global.localStorage;
    global.localStorage = createStorage({
      appVersion: '0.7.0',
      settings: '{broken',
      data: '[]',
      podcastBlocked: '{bad',
      podcastBroken: '{}',
      podcastMarks: '[]',
      podcastQueue: '{}',
      lastfm: '[]',
      player: '{"_volume":0.5}',
    });
    // Re-require after assigning the test localStorage. The module must load
    // even when several persisted keys are malformed or the wrong JSON type.
    delete require.cache[require.resolve(stateOut)];
    const stateModule = require(stateOut);
    const state = stateModule.default || stateModule;
    assert.deepStrictEqual(state.podcastBlocked.items, []);
    assert.deepStrictEqual(state.podcastBroken.names, []);
    assert.deepStrictEqual(state.podcastMarks.map, {});
    assert.deepStrictEqual(state.podcastQueue, []);
    assert.deepStrictEqual(state.lastfm, {});
    assert.deepStrictEqual(state.settings, { shortcuts: [], proxyConfig: {} });
    assert.deepStrictEqual(state.data, { user: {} });
    assert.deepStrictEqual(state.player, { _volume: 0.5 });
    global.localStorage = previousStorage;

    const updateInit = path.join(mocks, 'update-init.js');
    fs.writeFileSync(
      updateInit,
      "export default { settings: { shortcuts: [{ id: 'play' }], proxyConfig: {} }, data: { user: {} } };\n"
    );
    const updateOut = path.join(tempDir, 'update-app.cjs');
    const updateApp = await bundle(
      path.join(root, 'src', 'utils', 'updateApp.js'),
      updateOut,
      [
        helperPlugin(),
        {
          name: 'update-app-mocks',
          setup(build) {
            build.onResolve(
              { filter: /^@\/store\/initLocalStorage\.js$/ },
              () => ({ path: updateInit })
            );
          },
        },
      ]
    );
    const migrationStorage = createStorage({
      appVersion: '0.7.0',
      settings: '{truncated',
      data: '{}',
      player: '{}',
    });
    global.localStorage = migrationStorage;
    global.indexedDB = { deleteDatabase() {} };
    (updateApp.default || updateApp)();
    assert.strictEqual(
      migrationStorage.snapshot().settings,
      '{truncated',
      'migration must preserve corrupt settings instead of overwriting them'
    );
    assert(
      !migrationStorage.writes.some(([key]) => key === 'settings'),
      'migration must not write a fallback over corrupt settings'
    );

    const requestSource = fs.readFileSync(
      path.join(root, 'src', 'utils', 'request.js'),
      'utf8'
    );
    assert(
      /readLocalStorageJson\('settings', \{\}, 'object'\)/.test(
        requestSource
      ),
      'request interceptor must parse settings once through the safe reader'
    );
    assert(
      !/JSON\.parse\(localStorage\.getItem\('settings'\)\)/.test(
        requestSource
      ),
      'request interceptor must not directly parse settings'
    );

    process.stdout.write('local storage recovery smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
