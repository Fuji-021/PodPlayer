import defaultShortcuts from '@/utils/shortcuts';
import {
  analyzeShortcutConflicts,
  cloneShortcutSettings,
  getShortcutDefaults,
  normalizeShortcutSettings,
  shortcutSettingsEqual,
  validateShortcutChange,
} from '@/utils/shortcutConfig';
import { applyMenu, buildMenu } from './menu';

const USER_SHORTCUT_CHANNELS = {
  play: 'play',
  next: 'next',
  previous: 'previous',
  increaseVolume: 'increaseVolume',
  decreaseVolume: 'decreaseVolume',
  like: 'like',
};

const FIXED_MEDIA_SHORTCUTS = [
  ['MediaPlayPause', 'play'],
  ['MediaNextTrack', 'next'],
  ['MediaPreviousTrack', 'previous'],
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isLiveWindow(win) {
  return !!(
    win &&
    (!win.isDestroyed || !win.isDestroyed()) &&
    win.webContents &&
    (!win.webContents.isDestroyed || !win.webContents.isDestroyed())
  );
}

function defaultLog() {}

// The manager owns only user-configurable global accelerators. Fixed media
// controls are registered once and never participate in capture/transactions.
export function createShortcutManager(options) {
  const opts = options || {};
  const win = opts.win;
  const store = opts.store;
  const globalShortcut = opts.globalShortcut;
  const defaults = opts.defaults || defaultShortcuts;
  const menuBuilder =
    opts.buildMenu || (shortcuts => buildMenu(win, store, { shortcuts }));
  const menuApplier = opts.applyMenu || applyMenu;
  const setTimeoutImpl = opts.setTimeout || setTimeout;
  const clearTimeoutImpl = opts.clearTimeout || clearTimeout;
  const captureTimeoutMs = opts.captureTimeoutMs || 20000;
  const log = opts.log || defaultLog;

  let registeredUserShortcuts = new Map();
  let fixedMediaRegistered = false;
  let failedIds = [];
  let capture = null;
  let captureSequence = 0;

  function readSettings() {
    const value = (store && store.get && store.get('settings')) || {};
    return value && typeof value === 'object' ? value : {};
  }

  function readShortcuts() {
    return normalizeShortcutSettings(defaults, readSettings().shortcuts);
  }

  function isGlobalEnabled() {
    return readSettings().enableGlobalShortcut !== false;
  }

  function stateStatus() {
    if (capture) return 'capturing';
    if (!isGlobalEnabled()) return 'disabled';
    return failedIds.length ? 'partial' : 'enabled';
  }

  function shortcutState() {
    return {
      shortcuts: clone(readShortcuts()),
      globalEnabled: isGlobalEnabled(),
      status: stateStatus(),
      failedIds: failedIds.slice(),
      captureActive: !!capture,
    };
  }

  function response(ok, status, reason, extra) {
    return Object.assign(
      {
        ok: !!ok,
        status: status || stateStatus(),
        reason: reason || '',
        shortcutState: shortcutState(),
        conflictIds: [],
        failedIds: failedIds.slice(),
      },
      extra || {}
    );
  }

  function publishState() {
    if (!isLiveWindow(win)) return;
    win.webContents.send('shortcut:state', shortcutState());
  }

  function persist(nextShortcuts, nextEnabled) {
    const current = readSettings();
    const next = Object.assign({}, current, {
      shortcuts: cloneShortcutSettings(nextShortcuts, defaults),
    });
    if (typeof nextEnabled === 'boolean') {
      next.enableGlobalShortcut = nextEnabled;
    }
    store.set('settings', next);
    return next;
  }

  function dispatch(id) {
    if (!isLiveWindow(win)) return;
    if (id === 'minimize') {
      if (win.isVisible()) {
        win.hide();
      } else {
        win.show();
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      return;
    }
    const channel = USER_SHORTCUT_CHANNELS[id];
    if (channel) win.webContents.send(channel);
  }

  function unregister(accelerator) {
    if (!accelerator) return;
    try {
      globalShortcut.unregister(accelerator);
    } catch (error) {
      log('shortcut unregister failed');
    }
  }

  function unregisterMap(map) {
    map.forEach(accelerator => unregister(accelerator));
  }

  function registerOne(id, accelerator) {
    if (!accelerator) return { ok: true, accelerator: '' };
    try {
      const ok = globalShortcut.register(accelerator, () => dispatch(id));
      return ok
        ? { ok: true, accelerator }
        : { ok: false, reason: 'global-register-failed' };
    } catch (error) {
      log('shortcut register failed');
      return { ok: false, reason: 'global-register-failed' };
    }
  }

  function restoreRegistrationSnapshot(snapshot) {
    unregisterMap(registeredUserShortcuts);
    registeredUserShortcuts = new Map();
    snapshot.forEach((accelerator, id) => {
      const result = registerOne(id, accelerator);
      if (result.ok && accelerator) {
        registeredUserShortcuts.set(id, accelerator);
      }
    });
  }

  function registerAllAllowPartial(shortcuts) {
    unregisterMap(registeredUserShortcuts);
    registeredUserShortcuts = new Map();
    const nextFailedIds = [];
    const conflicts = analyzeShortcutConflicts(shortcuts).conflicts;
    shortcuts.forEach(item => {
      const accelerator = item.globalShortcut;
      if (!accelerator) return;
      const result = registerOne(item.id, accelerator);
      if (result.ok) {
        registeredUserShortcuts.set(item.id, accelerator);
      } else {
        nextFailedIds.push(item.id);
      }
      if (conflicts.has(item.id) && !nextFailedIds.includes(item.id)) {
        nextFailedIds.push(item.id);
      }
    });
    failedIds = nextFailedIds;
    return { failedIds: nextFailedIds.slice() };
  }

  function registerAllStrict(shortcuts, rollbackSnapshot) {
    const snapshot = rollbackSnapshot || new Map(registeredUserShortcuts);
    unregisterMap(registeredUserShortcuts);
    registeredUserShortcuts = new Map();
    const conflicts = analyzeShortcutConflicts(shortcuts).conflicts;
    let failedId = '';
    for (const item of shortcuts) {
      if (conflicts.has(item.id)) {
        failedId = item.id;
        break;
      }
      const result = registerOne(item.id, item.globalShortcut);
      if (!result.ok) {
        failedId = item.id;
        break;
      }
      if (item.globalShortcut) {
        registeredUserShortcuts.set(item.id, item.globalShortcut);
      }
    }
    if (!failedId) {
      failedIds = [];
      return { ok: true };
    }
    unregisterMap(registeredUserShortcuts);
    registeredUserShortcuts = new Map();
    restoreRegistrationSnapshot(snapshot);
    return { ok: false, failedId };
  }

  function buildCandidateMenu(shortcuts) {
    try {
      return { ok: true, menu: menuBuilder(shortcuts) };
    } catch (error) {
      log('shortcut menu build failed');
      return { ok: false };
    }
  }

  function applyCandidateMenu(menu) {
    try {
      menuApplier(menu);
      return true;
    } catch (error) {
      log('shortcut menu apply failed');
      return false;
    }
  }

  function restorePersistedAndMenu(settings, shortcuts) {
    try {
      store.set('settings', settings);
    } catch (error) {
      log('shortcut persistence rollback failed');
    }
    const oldMenu = buildCandidateMenu(shortcuts);
    if (oldMenu.ok) applyCandidateMenu(oldMenu.menu);
  }

  function registerFixedMediaShortcuts() {
    if (fixedMediaRegistered) return;
    fixedMediaRegistered = true;
    FIXED_MEDIA_SHORTCUTS.forEach(([accelerator, id]) => {
      try {
        const ok = globalShortcut.register(accelerator, () => dispatch(id));
        if (!ok) log('fixed media shortcut unavailable');
      } catch (error) {
        log('fixed media shortcut unavailable');
      }
    });
  }

  function initialize() {
    const settings = readSettings();
    const shortcuts = readShortcuts();
    if (!shortcutSettingsEqual(settings.shortcuts, shortcuts, defaults)) {
      persist(shortcuts, settings.enableGlobalShortcut !== false);
    }
    const menu = buildCandidateMenu(shortcuts);
    if (menu.ok) applyCandidateMenu(menu.menu);
    registerFixedMediaShortcuts();
    if (isGlobalEnabled()) {
      registerAllAllowPartial(shortcuts);
    } else {
      unregisterMap(registeredUserShortcuts);
      registeredUserShortcuts = new Map();
      failedIds = [];
    }
    publishState();
    return response(true, stateStatus());
  }

  function getState() {
    return response(true, stateStatus());
  }

  function beginCapture() {
    if (capture) return response(false, 'capturing', 'capture-busy');
    const token = `shortcut-capture-${Date.now()}-${++captureSequence}`;
    const snapshot = new Map(registeredUserShortcuts);
    unregisterMap(registeredUserShortcuts);
    registeredUserShortcuts = new Map();
    const timeoutId = setTimeoutImpl(() => {
      endCapture({ token, automatic: true });
    }, captureTimeoutMs);
    capture = { token, snapshot, timeoutId };
    publishState();
    return response(true, 'capturing', '', { captureToken: token });
  }

  function endCapture(payload) {
    const token = payload && payload.token;
    if (!capture) return response(true, 'already-released');
    if (token !== capture.token) {
      return response(false, 'capturing', 'capture-not-owner');
    }
    clearTimeoutImpl(capture.timeoutId);
    capture = null;
    if (isGlobalEnabled()) {
      registerAllAllowPartial(readShortcuts());
    }
    publishState();
    return response(true, stateStatus());
  }

  function commit(payload) {
    if (capture && (!payload || payload.captureToken !== capture.token)) {
      return response(false, 'capturing', 'capture-not-owner');
    }
    const oldSettings = clone(readSettings());
    const oldShortcuts = readShortcuts();
    const validation = validateShortcutChange(oldShortcuts, payload, defaults);
    if (!validation.ok) {
      return response(false, stateStatus(), validation.reason, {
        conflictIds: validation.conflictIds || [],
      });
    }
    const candidateMenu = buildCandidateMenu(validation.shortcuts);
    if (!candidateMenu.ok) {
      return response(false, stateStatus(), 'menu-build-failed');
    }

    const type = payload.type;
    const id = payload.id;
    const captureSnapshot = capture ? new Map(capture.snapshot) : null;
    const oldRegistry = captureSnapshot || new Map(registeredUserShortcuts);
    const oldFailedIds = failedIds.slice();
    if (capture) {
      clearTimeoutImpl(capture.timeoutId);
      capture = null;
    }

    if (type === 'globalShortcut' && isGlobalEnabled() && captureSnapshot) {
      const registration = registerAllStrict(validation.shortcuts, oldRegistry);
      if (!registration.ok) {
        failedIds = oldFailedIds;
        publishState();
        return response(false, stateStatus(), 'global-register-failed', {
          failedIds: [registration.failedId],
        });
      }
    } else if (type === 'globalShortcut' && isGlobalEnabled()) {
      const oldAccelerator = oldRegistry.get(id) || '';
      unregister(oldAccelerator);
      registeredUserShortcuts.delete(id);
      const registration = registerOne(id, validation.shortcut);
      if (!registration.ok) {
        restoreRegistrationSnapshot(oldRegistry);
        return response(false, stateStatus(), 'global-register-failed', {
          failedIds: [id],
        });
      }
      if (validation.shortcut) {
        registeredUserShortcuts.set(id, validation.shortcut);
      }
      failedIds = failedIds.filter(item => item !== id);
    } else if (captureSnapshot && isGlobalEnabled()) {
      // A local shortcut change never tests or replaces globals. It only ends
      // the capture lease and restores exactly the binding set it paused.
      restoreRegistrationSnapshot(oldRegistry);
    }

    try {
      persist(validation.shortcuts, oldSettings.enableGlobalShortcut !== false);
      if (!applyCandidateMenu(candidateMenu.menu)) {
        throw new Error('menu apply');
      }
    } catch (error) {
      restorePersistedAndMenu(oldSettings, oldShortcuts);
      if (isGlobalEnabled() && (type === 'globalShortcut' || captureSnapshot)) {
        restoreRegistrationSnapshot(oldRegistry);
        failedIds = oldFailedIds;
      }
      return response(false, stateStatus(), 'commit-rolled-back');
    }
    publishState();
    return response(true, stateStatus());
  }

  function setGlobalEnabled(payload) {
    if (capture) return response(false, 'capturing', 'capture-active');
    const enabled = !!(payload && payload.enabled);
    const oldSettings = clone(readSettings());
    const shortcuts = readShortcuts();
    const oldRegistry = new Map(registeredUserShortcuts);
    if (!enabled) {
      unregisterMap(registeredUserShortcuts);
      registeredUserShortcuts = new Map();
      failedIds = [];
      try {
        persist(shortcuts, false);
      } catch (error) {
        restoreRegistrationSnapshot(oldRegistry);
        return response(false, 'enabled', 'commit-rolled-back');
      }
      publishState();
      return response(true, 'disabled');
    }

    const beforeFailed = failedIds.slice();
    const registration = registerAllAllowPartial(shortcuts);
    try {
      persist(shortcuts, true);
    } catch (error) {
      unregisterMap(registeredUserShortcuts);
      registeredUserShortcuts = new Map();
      restoreRegistrationSnapshot(oldRegistry);
      failedIds = beforeFailed;
      restorePersistedAndMenu(oldSettings, shortcuts);
      return response(false, 'disabled', 'commit-rolled-back');
    }
    publishState();
    return response(
      true,
      registration.failedIds.length ? 'partial' : 'enabled'
    );
  }

  function restoreDefaults() {
    if (capture) return response(false, 'capturing', 'capture-active');
    const oldSettings = clone(readSettings());
    const oldShortcuts = readShortcuts();
    const defaultsCandidate = getShortcutDefaults();
    const candidateMenu = buildCandidateMenu(defaultsCandidate);
    if (!candidateMenu.ok) {
      return response(false, stateStatus(), 'menu-build-failed');
    }
    const oldRegistry = new Map(registeredUserShortcuts);
    if (isGlobalEnabled()) {
      const registration = registerAllStrict(defaultsCandidate);
      if (!registration.ok) {
        return response(false, stateStatus(), 'global-register-failed', {
          failedIds: [registration.failedId],
        });
      }
    }
    try {
      persist(defaultsCandidate, oldSettings.enableGlobalShortcut !== false);
      if (!applyCandidateMenu(candidateMenu.menu)) {
        throw new Error('menu apply');
      }
    } catch (error) {
      restorePersistedAndMenu(oldSettings, oldShortcuts);
      if (isGlobalEnabled()) restoreRegistrationSnapshot(oldRegistry);
      return response(false, stateStatus(), 'commit-rolled-back');
    }
    failedIds = [];
    publishState();
    return response(true, stateStatus());
  }

  function dispose() {
    if (capture) {
      endCapture({ token: capture.token, automatic: true });
    }
  }

  return {
    initialize,
    getState,
    beginCapture,
    endCapture,
    commit,
    setGlobalEnabled,
    restoreDefaults,
    dispose,
  };
}
