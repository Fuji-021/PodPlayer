import defaultShortcuts from './shortcuts';

export const SHORTCUT_FIELDS = ['shortcut', 'globalShortcut'];

const MODIFIER_ORDER = ['CommandOrControl', 'Alt', 'Shift'];
const MODIFIER_ALIASES = {
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  control: 'CommandOrControl',
  ctrl: 'CommandOrControl',
  command: 'CommandOrControl',
  cmd: 'CommandOrControl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};
const KEY_ALIASES = {
  arrowleft: 'Left',
  left: 'Left',
  arrowright: 'Right',
  right: 'Right',
  arrowup: 'Up',
  up: 'Up',
  arrowdown: 'Down',
  down: 'Down',
  space: 'Space',
  ' ': 'Space',
  mediaplaypause: 'MediaPlayPause',
  medianexttrack: 'MediaNextTrack',
  mediaprevioustrack: 'MediaPreviousTrack',
};
const VALID_PUNCTUATION = ['=', '-', '~', '[', ']', ';', "'", ',', '.', '/'];

// These accelerators are owned by fixed application/menu actions. They are
// never made configurable because stealing one would make the menu ambiguous.
export const FIXED_ACCELERATORS = [
  'MediaPlayPause',
  'MediaNextTrack',
  'MediaPreviousTrack',
  'CommandOrControl+F',
  'Alt+R',
  'Alt+S',
  'F12',
  'CommandOrControl+,',
];

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeKey(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  const lowered = value.toLowerCase();
  if (KEY_ALIASES[lowered]) return KEY_ALIASES[lowered];
  if (/^[a-z]$/i.test(value)) return value.toUpperCase();
  if (/^[0-9]$/.test(value)) return value;
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(value)) return value.toUpperCase();
  if (VALID_PUNCTUATION.includes(value)) return value;
  return null;
}

function normalizePart(raw) {
  if (typeof raw !== 'string') return null;
  const lowered = raw.trim().toLowerCase();
  return MODIFIER_ALIASES[lowered] || normalizeKey(raw);
}

export function normalizeShortcut(value) {
  if (value === '') return '';
  if (typeof value !== 'string') return null;
  const parts = value.split('+');
  if (!parts.length || parts.some(part => !part.trim())) return null;

  const modifiers = new Set();
  let key = null;
  for (const rawPart of parts) {
    const part = normalizePart(rawPart);
    if (!part) return null;
    if (MODIFIER_ORDER.includes(part)) {
      if (modifiers.has(part)) return null;
      modifiers.add(part);
      continue;
    }
    if (key) return null;
    key = part;
  }
  if (!key) return null;
  return MODIFIER_ORDER.filter(part => modifiers.has(part))
    .concat(key)
    .join('+');
}

export function shortcutFromKeyboardEvent(event) {
  const e = event || {};
  if (e.isComposing) return { kind: 'ignore' };
  if (e.key === 'Escape') return { kind: 'cancel' };
  if (
    (e.key === 'Backspace' || e.key === 'Delete') &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey
  ) {
    return { kind: 'clear', shortcut: '' };
  }
  if (e.key === 'Tab') return { kind: 'tab' };
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) {
    return { kind: 'continue' };
  }

  const key = normalizeKey(e.key);
  if (!key) return { kind: 'invalid' };
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  const shortcut = normalizeShortcut(parts.join('+'));
  return shortcut ? { kind: 'candidate', shortcut } : { kind: 'invalid' };
}

function normalizedDefaultRecords(defaults) {
  const seen = new Set();
  const records = [];
  (Array.isArray(defaults) ? defaults : []).forEach(item => {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id.trim()) {
      return;
    }
    if (seen.has(item.id)) return;
    seen.add(item.id);
    const record = Object.assign({}, item);
    SHORTCUT_FIELDS.forEach(field => {
      const normalized = normalizeShortcut(record[field]);
      record[field] = normalized === null ? '' : normalized;
    });
    records.push(record);
  });
  return records;
}

// Persistent settings are merged by fixed id. Invalid legacy records are
// discarded, while an empty string remains a deliberate disabled shortcut.
export function normalizeShortcutSettings(defaults, storedShortcuts) {
  const base = normalizedDefaultRecords(defaults || defaultShortcuts);
  const savedById = new Map();
  (Array.isArray(storedShortcuts) ? storedShortcuts : []).forEach(item => {
    if (
      !isObject(item) ||
      typeof item.id !== 'string' ||
      savedById.has(item.id)
    )
      return;
    savedById.set(item.id, item);
  });
  return base.map(defaultRecord => {
    const saved = savedById.get(defaultRecord.id);
    const next = Object.assign({}, defaultRecord);
    if (!saved) return next;
    SHORTCUT_FIELDS.forEach(field => {
      if (typeof saved[field] !== 'string') return;
      const normalized = normalizeShortcut(saved[field]);
      if (normalized !== null) next[field] = normalized;
    });
    return next;
  });
}

export function getShortcutDefaults() {
  return normalizeShortcutSettings(defaultShortcuts, defaultShortcuts);
}

function acceleratorEntries(shortcuts) {
  const entries = [];
  (Array.isArray(shortcuts) ? shortcuts : []).forEach(item => {
    if (!isObject(item) || typeof item.id !== 'string') return;
    SHORTCUT_FIELDS.forEach(field => {
      const shortcut = normalizeShortcut(item[field]);
      if (shortcut) entries.push({ id: item.id, field, shortcut });
    });
  });
  return entries;
}

export function analyzeShortcutConflicts(shortcuts) {
  const entries = acceleratorEntries(shortcuts);
  const byShortcut = new Map();
  entries.forEach(entry => {
    const list = byShortcut.get(entry.shortcut) || [];
    list.push(entry);
    byShortcut.set(entry.shortcut, list);
  });

  const conflicts = new Map();
  const add = (entry, detail) => {
    const list = conflicts.get(entry.id) || [];
    list.push(detail);
    conflicts.set(entry.id, list);
  };
  byShortcut.forEach((entriesForShortcut, shortcut) => {
    if (entriesForShortcut.length > 1) {
      entriesForShortcut.forEach(entry => {
        add(entry, {
          code: 'shortcut-conflict',
          shortcut,
          conflictsWith: entriesForShortcut
            .filter(other => other !== entry)
            .map(other => other.id),
        });
      });
    }
    if (FIXED_ACCELERATORS.includes(shortcut)) {
      entriesForShortcut.forEach(entry => {
        add(entry, {
          code: 'reserved-accelerator',
          shortcut,
          conflictsWith: [],
        });
      });
    }
  });
  return { conflicts, entries };
}

export function validateShortcutChange(shortcuts, payload, defaults) {
  const id = payload && payload.id;
  const type = payload && payload.type;
  if (typeof id !== 'string' || !SHORTCUT_FIELDS.includes(type)) {
    return { ok: false, reason: 'invalid-shortcut-target' };
  }
  const normalized = normalizeShortcut(payload.shortcut);
  if (normalized === null) return { ok: false, reason: 'invalid-shortcut' };
  const next = normalizeShortcutSettings(
    defaults || defaultShortcuts,
    shortcuts
  );
  const row = next.find(item => item.id === id);
  if (!row) return { ok: false, reason: 'invalid-shortcut-target' };
  row[type] = normalized;
  const analysis = analyzeShortcutConflicts(next);
  const ownConflicts = analysis.conflicts.get(id) || [];
  if (ownConflicts.length) {
    const conflictIds = Array.from(
      new Set(
        ownConflicts.reduce(
          (all, detail) => all.concat(detail.conflictsWith || []),
          []
        )
      )
    );
    return {
      ok: false,
      reason: ownConflicts[0].code,
      conflictIds,
      shortcuts: next,
    };
  }
  return { ok: true, shortcuts: next, shortcut: normalized };
}

export function shortcutSettingsEqual(left, right, defaults) {
  return (
    JSON.stringify(
      normalizeShortcutSettings(defaults || defaultShortcuts, left)
    ) ===
    JSON.stringify(
      normalizeShortcutSettings(defaults || defaultShortcuts, right)
    )
  );
}

export function cloneShortcutSettings(value, defaults) {
  return clone(normalizeShortcutSettings(defaults || defaultShortcuts, value));
}
