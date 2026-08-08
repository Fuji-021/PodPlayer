const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-shortcut-settings-')
);

const defaults = [
  {
    id: 'play',
    name: '播放/暂停',
    shortcut: 'CommandOrControl+P',
    globalShortcut: 'CommandOrControl+Alt+P',
  },
  {
    id: 'next',
    name: '快进 30 秒',
    shortcut: 'CommandOrControl+Right',
    globalShortcut: 'CommandOrControl+Alt+Right',
  },
  {
    id: 'previous',
    name: '快退 15 秒',
    shortcut: 'CommandOrControl+Left',
    globalShortcut: 'CommandOrControl+Alt+Left',
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStore(settings) {
  return {
    value: { settings: clone(settings) },
    get(key) {
      return this.value[key];
    },
    set(key, value) {
      this.value[key] = clone(value);
    },
  };
}

function createGlobalShortcut() {
  const active = new Map();
  const failures = new Set();
  const registerCalls = [];
  const unregisterCalls = [];
  return {
    active,
    failures,
    registerCalls,
    unregisterCalls,
    register(accelerator, handler) {
      registerCalls.push(accelerator);
      if (failures.has(accelerator) || active.has(accelerator)) return false;
      active.set(accelerator, handler);
      return true;
    },
    unregister(accelerator) {
      unregisterCalls.push(accelerator);
      active.delete(accelerator);
    },
  };
}

function createTimers() {
  const entries = [];
  return {
    entries,
    setTimeout(callback, delay) {
      const timer = { callback, delay, canceled: false };
      entries.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.canceled = true;
    },
  };
}

function createHarness(managerModule, config, options) {
  const opts = options || {};
  const store = createStore({
    enableGlobalShortcut: true,
    shortcuts: clone(opts.shortcuts || defaults),
    appearance: 'auto',
  });
  const globalShortcut = createGlobalShortcut();
  const timers = createTimers();
  const sent = [];
  const menus = [];
  const win = {
    isDestroyed() {
      return false;
    },
    isVisible() {
      return true;
    },
    isMinimized() {
      return false;
    },
    hide() {},
    show() {},
    restore() {},
    focus() {},
    webContents: {
      isDestroyed() {
        return false;
      },
      send(channel, payload) {
        sent.push({ channel, payload });
      },
    },
  };
  let failMenu = false;
  let failApply = false;
  const manager = managerModule.createShortcutManager({
    win,
    store,
    globalShortcut,
    defaults,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    captureTimeoutMs: 25,
    buildMenu(shortcuts) {
      if (failMenu) throw new Error('candidate menu rejected');
      return { shortcuts: clone(shortcuts) };
    },
    applyMenu(menu) {
      if (failApply) throw new Error('apply rejected');
      menus.push(menu);
    },
  });
  return {
    config,
    store,
    globalShortcut,
    timers,
    sent,
    menus,
    manager,
    setFailMenu(value) {
      failMenu = value;
    },
    setFailApply(value) {
      failApply = value;
    },
  };
}

async function buildModules() {
  const mockDir = path.join(tempDir, 'mocks');
  fs.mkdirSync(mockDir, { recursive: true });
  const menuMock = path.join(mockDir, 'menu.js');
  fs.writeFileSync(
    menuMock,
    'export function buildMenu() { return {}; } export function applyMenu() {}\n'
  );
  const aliasPlugin = {
    name: 'shortcut-aliases',
    setup(build) {
      build.onResolve({ filter: /^@\// }, args => ({
        path: path.join(root, 'src', args.path.slice(2)) + '.js',
      }));
      build.onResolve({ filter: /^\.\/menu$/ }, () => ({ path: menuMock }));
    },
  };
  const managerOutput = path.join(tempDir, 'manager.cjs');
  const configOutput = path.join(tempDir, 'config.cjs');
  const gateOutput = path.join(tempDir, 'gate.cjs');
  await Promise.all([
    esbuild.build({
      entryPoints: [path.join(root, 'src/electron/shortcutManager.js')],
      outfile: managerOutput,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
      plugins: [aliasPlugin],
    }),
    esbuild.build({
      entryPoints: [path.join(root, 'src/utils/shortcutConfig.js')],
      outfile: configOutput,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    }),
    esbuild.build({
      entryPoints: [path.join(root, 'src/utils/shortcutRequestGate.js')],
      outfile: gateOutput,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    }),
  ]);
  return {
    manager: require(managerOutput),
    config: require(configOutput),
    gate: require(gateOutput),
  };
}

async function buildMenuModule() {
  const mockDir = path.join(tempDir, 'menu-mocks');
  fs.mkdirSync(mockDir, { recursive: true });
  const electron = path.join(mockDir, 'electron.js');
  fs.writeFileSync(
    electron,
    `export const app = { name: 'PodPlayer' };
export const Menu = {
  buildFromTemplate(template) { global.__shortcutMenuTemplates.push(template); return { template }; },
  setApplicationMenu(menu) { global.__shortcutMenuApplied.push(menu); },
};\n`
  );
  const output = path.join(tempDir, 'menu.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/electron/menu.js')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'menu-electron-mock',
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: electron }));
          build.onResolve({ filter: /^@\// }, args => ({
            path: path.join(root, 'src', args.path.slice(2)) + '.js',
          }));
        },
      },
    ],
  });
  return require(output);
}

function findShortcut(shortcuts, id) {
  return shortcuts.find(item => item.id === id);
}

async function main() {
  try {
    const { manager: managerModule, config, gate } = await buildModules();

    // Legacy null/bad entries are removed, user values remain, and rerunning
    // normalization cannot mutate the result again.
    const migrated = config.normalizeShortcutSettings(defaults, [
      null,
      { id: 'play', shortcut: 'Ctrl+Shift+P', globalShortcut: '' },
      { id: 'play', shortcut: 'Ctrl+P' },
      { id: 'next', shortcut: 42, globalShortcut: 'Alt+Ctrl+Right' },
      { id: 'removed', shortcut: 'Ctrl+X' },
    ]);
    assert.strictEqual(
      migrated.some(item => item == null),
      false
    );
    assert.strictEqual(
      findShortcut(migrated, 'play').shortcut,
      'CommandOrControl+Shift+P'
    );
    assert.strictEqual(findShortcut(migrated, 'play').globalShortcut, '');
    assert.strictEqual(
      findShortcut(migrated, 'next').globalShortcut,
      'CommandOrControl+Alt+Right'
    );
    assert.deepStrictEqual(
      config.normalizeShortcutSettings(defaults, migrated),
      migrated,
      'normalization must be idempotent'
    );
    assert.deepStrictEqual(
      config.shortcutFromKeyboardEvent({ key: 'Escape' }),
      {
        kind: 'cancel',
      }
    );
    assert.deepStrictEqual(
      config.shortcutFromKeyboardEvent({ key: 'Backspace' }),
      {
        kind: 'clear',
        shortcut: '',
      }
    );
    assert.deepStrictEqual(config.shortcutFromKeyboardEvent({ key: 'Tab' }), {
      kind: 'tab',
    });
    assert.deepStrictEqual(
      config.shortcutFromKeyboardEvent({ key: 'p', ctrlKey: true }),
      { kind: 'candidate', shortcut: 'CommandOrControl+P' }
    );
    assert.deepStrictEqual(
      config.shortcutFromKeyboardEvent({ key: 'Control' }),
      {
        kind: 'continue',
      }
    );

    const localConflict = config.validateShortcutChange(
      defaults,
      { id: 'next', type: 'shortcut', shortcut: 'Ctrl+P' },
      defaults
    );
    assert.strictEqual(localConflict.ok, false);
    assert.strictEqual(localConflict.reason, 'shortcut-conflict');
    const crossConflict = config.validateShortcutChange(
      defaults,
      { id: 'next', type: 'globalShortcut', shortcut: 'Ctrl+P' },
      defaults
    );
    assert.strictEqual(crossConflict.ok, false);
    assert.strictEqual(crossConflict.reason, 'shortcut-conflict');
    const reserved = config.validateShortcutChange(
      defaults,
      { id: 'next', type: 'globalShortcut', shortcut: 'MediaPlayPause' },
      defaults
    );
    assert.strictEqual(reserved.ok, false);
    assert.strictEqual(reserved.reason, 'reserved-accelerator');

    const candidateFailure = createHarness(managerModule, config);
    candidateFailure.manager.initialize();
    const oldSettings = JSON.stringify(candidateFailure.store.get('settings'));
    const oldGlobal = findShortcut(
      candidateFailure.store.get('settings').shortcuts,
      'play'
    ).globalShortcut;
    candidateFailure.globalShortcut.failures.add('CommandOrControl+Alt+Q');
    const failedCommit = candidateFailure.manager.commit({
      id: 'play',
      type: 'globalShortcut',
      shortcut: 'Alt+Ctrl+Q',
    });
    assert.strictEqual(failedCommit.ok, false);
    assert.strictEqual(failedCommit.reason, 'global-register-failed');
    assert.strictEqual(
      JSON.stringify(candidateFailure.store.get('settings')),
      oldSettings
    );
    assert.ok(
      candidateFailure.globalShortcut.active.has(oldGlobal),
      'a failed candidate must restore the old live global registration'
    );

    const localMenuFailure = createHarness(managerModule, config);
    localMenuFailure.manager.initialize();
    const previousLocalSettings = JSON.stringify(
      localMenuFailure.store.get('settings')
    );
    localMenuFailure.setFailMenu(true);
    const menuFailure = localMenuFailure.manager.commit({
      id: 'play',
      type: 'shortcut',
      shortcut: 'Ctrl+K',
    });
    assert.strictEqual(menuFailure.ok, false);
    assert.strictEqual(menuFailure.reason, 'menu-build-failed');
    assert.strictEqual(
      JSON.stringify(localMenuFailure.store.get('settings')),
      previousLocalSettings,
      'a menu preview failure must not persist the candidate'
    );

    // The renderer request gate makes a late old response harmless.
    const requestGate = gate.createShortcutRequestGate();
    const oldRequest = requestGate.next();
    const currentRequest = requestGate.next();
    let renderedState = 'new';
    if (requestGate.isCurrent(oldRequest)) renderedState = 'old';
    if (requestGate.isCurrent(currentRequest)) renderedState = 'current';
    assert.strictEqual(renderedState, 'current');

    const captureHarness = createHarness(managerModule, config);
    captureHarness.manager.initialize();
    const capture = captureHarness.manager.beginCapture();
    assert.strictEqual(capture.ok, true);
    assert.strictEqual(capture.status, 'capturing');
    assert.ok(
      captureHarness.globalShortcut.active.has('MediaPlayPause'),
      'fixed media keys must stay registered while recording'
    );
    assert.strictEqual(
      captureHarness.globalShortcut.active.has('CommandOrControl+Alt+P'),
      false,
      'only configurable globals are paused during capture'
    );
    assert.strictEqual(
      captureHarness.manager.commit({
        id: 'play',
        type: 'shortcut',
        shortcut: 'CommandOrControl+J',
      }).reason,
      'capture-not-owner',
      'a capture lease must reject commits without its token'
    );
    assert.strictEqual(
      captureHarness.manager.endCapture({ token: 'another-capture' }).reason,
      'capture-not-owner',
      'a different editor cannot release the active capture lease'
    );
    const released = captureHarness.manager.endCapture({
      token: capture.captureToken,
    });
    assert.strictEqual(released.ok, true);
    assert.ok(
      captureHarness.globalShortcut.active.has('CommandOrControl+Alt+P')
    );
    assert.strictEqual(
      captureHarness.manager.endCapture({ token: capture.captureToken }).status,
      'already-released',
      'duplicate release must be harmless'
    );

    const capturedFailureHarness = createHarness(managerModule, config);
    capturedFailureHarness.manager.initialize();
    const capturedFailureBefore = JSON.stringify(
      capturedFailureHarness.store.get('settings')
    );
    const capturedFailure = capturedFailureHarness.manager.beginCapture();
    capturedFailureHarness.globalShortcut.failures.add(
      'CommandOrControl+Alt+Q'
    );
    const capturedGlobalFailure = capturedFailureHarness.manager.commit({
      id: 'play',
      type: 'globalShortcut',
      shortcut: 'CommandOrControl+Alt+Q',
      captureToken: capturedFailure.captureToken,
    });
    assert.strictEqual(capturedGlobalFailure.ok, false);
    assert.strictEqual(capturedGlobalFailure.reason, 'global-register-failed');
    assert.strictEqual(
      capturedFailureHarness.manager.getState().shortcutState.captureActive,
      false,
      'a rejected candidate ends the capture lease and restores the live map'
    );
    assert.strictEqual(
      JSON.stringify(capturedFailureHarness.store.get('settings')),
      capturedFailureBefore,
      'a failed capture-time global candidate must not persist'
    );
    assert.ok(
      capturedFailureHarness.globalShortcut.active.has(
        'CommandOrControl+Alt+P'
      ),
      'capture-time registration failure must restore the old global binding'
    );

    const capturedSuccessHarness = createHarness(managerModule, config);
    capturedSuccessHarness.manager.initialize();
    const capturedSuccess = capturedSuccessHarness.manager.beginCapture();
    const capturedGlobalSuccess = capturedSuccessHarness.manager.commit({
      id: 'play',
      type: 'globalShortcut',
      shortcut: 'CommandOrControl+Alt+Q',
      captureToken: capturedSuccess.captureToken,
    });
    assert.strictEqual(capturedGlobalSuccess.ok, true);
    assert.strictEqual(
      findShortcut(
        capturedSuccessHarness.store.get('settings').shortcuts,
        'play'
      ).globalShortcut,
      'CommandOrControl+Alt+Q'
    );
    assert.ok(
      capturedSuccessHarness.globalShortcut.active.has(
        'CommandOrControl+Alt+Q'
      ),
      'a successful capture-time global candidate is live before settings persist'
    );
    assert.strictEqual(
      capturedSuccessHarness.manager.endCapture({
        token: capturedSuccess.captureToken,
      }).status,
      'already-released',
      'a successful commit owns and closes the capture lease'
    );

    const capturedLocalHarness = createHarness(managerModule, config);
    capturedLocalHarness.manager.initialize();
    const capturedLocal = capturedLocalHarness.manager.beginCapture();
    const capturedLocalCommit = capturedLocalHarness.manager.commit({
      id: 'play',
      type: 'shortcut',
      shortcut: 'CommandOrControl+J',
      captureToken: capturedLocal.captureToken,
    });
    assert.strictEqual(capturedLocalCommit.ok, true);
    assert.ok(
      capturedLocalHarness.globalShortcut.active.has('CommandOrControl+Alt+P'),
      'a local-only capture commit restores rather than replaces live globals'
    );

    const timedCapture = captureHarness.manager.beginCapture();
    const timeout =
      captureHarness.timers.entries[captureHarness.timers.entries.length - 1];
    timeout.callback();
    assert.strictEqual(
      captureHarness.manager.getState().shortcutState.captureActive,
      false
    );
    assert.ok(
      captureHarness.globalShortcut.active.has('CommandOrControl+Alt+P')
    );
    assert.ok(timedCapture.captureToken);

    const stateHarness = createHarness(managerModule, config);
    stateHarness.globalShortcut.failures.add('CommandOrControl+Alt+Right');
    const startup = stateHarness.manager.initialize();
    assert.strictEqual(startup.status, 'partial');
    assert.deepStrictEqual(startup.failedIds, ['next']);
    assert.strictEqual(
      stateHarness.sent.some(
        event => event.channel === 'globalShortcutRegisterFailed'
      ),
      false,
      'startup reports state only; it must never emit legacy toast events'
    );
    const registrationCount = stateHarness.globalShortcut.registerCalls.length;
    stateHarness.store.value.settings.appearance = 'dark';
    assert.strictEqual(
      stateHarness.globalShortcut.registerCalls.length,
      registrationCount,
      'unrelated settings do not re-register shortcuts'
    );
    const disabled = stateHarness.manager.setGlobalEnabled({ enabled: false });
    assert.strictEqual(disabled.status, 'disabled');
    assert.ok(stateHarness.globalShortcut.active.has('MediaPlayPause'));
    stateHarness.globalShortcut.failures.clear();
    const enabled = stateHarness.manager.setGlobalEnabled({ enabled: true });
    assert.strictEqual(enabled.status, 'enabled');
    assert.deepStrictEqual(enabled.failedIds, []);

    const restoreHarness = createHarness(managerModule, config);
    restoreHarness.manager.initialize();
    const changed = restoreHarness.manager.commit({
      id: 'play',
      type: 'globalShortcut',
      shortcut: 'Ctrl+Alt+Q',
    });
    assert.strictEqual(changed.ok, true);
    const beforeRestore = JSON.stringify(restoreHarness.store.get('settings'));
    restoreHarness.globalShortcut.failures.add('CommandOrControl+Alt+P');
    const restore = restoreHarness.manager.restoreDefaults();
    assert.strictEqual(restore.ok, false);
    assert.strictEqual(restore.reason, 'global-register-failed');
    assert.strictEqual(
      JSON.stringify(restoreHarness.store.get('settings')),
      beforeRestore,
      'default restore must roll back storage when any default cannot register'
    );
    assert.ok(
      restoreHarness.globalShortcut.active.has('CommandOrControl+Alt+Q'),
      'default restore failure must restore the prior active binding'
    );

    const menuModule = await buildMenuModule();
    global.__shortcutMenuTemplates = [];
    global.__shortcutMenuApplied = [];
    const menuStore = {
      get() {
        return [null, { id: 'play', shortcut: 42 }, { id: 'next' }];
      },
    };
    assert.doesNotThrow(() =>
      menuModule.createMenu({ webContents: { send() {} } }, menuStore)
    );
    assert.strictEqual(global.__shortcutMenuApplied.length, 1);

    const settingsSource = fs.readFileSync(
      path.join(root, 'src/views/settings.vue'),
      'utf8'
    );
    const rendererSource = fs.readFileSync(
      path.join(root, 'src/electron/ipcRenderer.js'),
      'utf8'
    );
    assert.match(
      settingsSource,
      /@keydown="\s*onShortcutFieldKeydown\(\$event, shortcut\.id, 'shortcut'\)\s*"/
    );
    assert.match(
      settingsSource,
      /@keydown="\s*onShortcutFieldKeydown\(\$event, shortcut\.id, 'globalShortcut'\)\s*"/
    );
    assert.match(
      settingsSource,
      /:disabled="shortcutOperationBusy \|\| shortcutInput\.recording"/
    );
    assert.match(
      settingsSource,
      /deactivated\(\)[\s\S]*?releaseShortcutCapture\(\)/
    );
    assert.match(
      settingsSource,
      /beforeDestroy\(\)[\s\S]*?releaseShortcutCapture\(\)/
    );
    assert.doesNotMatch(settingsSource, /switchGlobalShortcutStatusTemporary/);
    assert.doesNotMatch(rendererSource, /globalShortcutRegisterFailed/);
    assert.doesNotMatch(rendererSource, /快捷键 .*注册失败/);

    process.stdout.write('shortcut settings integrity smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
