function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isShortcutId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getDefaultShortcuts(defaultShortcuts) {
  const byId = new Map();
  const ordered = [];
  (Array.isArray(defaultShortcuts) ? defaultShortcuts : []).forEach(
    shortcut => {
      if (!isObject(shortcut) || !isShortcutId(shortcut.id)) return;
      if (byId.has(shortcut.id)) return;
      const copy = { ...shortcut };
      byId.set(copy.id, copy);
      ordered.push(copy);
    }
  );
  return { byId, ordered };
}

function mergeShortcut(defaultShortcut, savedShortcut) {
  const merged = { ...defaultShortcut };
  if (!isObject(savedShortcut)) return merged;

  // Empty strings are valid: they intentionally disable a shortcut.
  ['shortcut', 'globalShortcut'].forEach(key => {
    if (typeof savedShortcut[key] === 'string') {
      merged[key] = savedShortcut[key];
    }
  });
  return merged;
}

// Settings shortcuts are keyed by their fixed ids. Older arrays can contain
// null, malformed values, duplicates, or entries from removed versions.
export function mergeShortcutSettings(defaultShortcuts, storedShortcuts) {
  const defaults = getDefaultShortcuts(defaultShortcuts);
  const storedById = new Map();

  (Array.isArray(storedShortcuts) ? storedShortcuts : []).forEach(shortcut => {
    if (!isObject(shortcut) || !isShortcutId(shortcut.id)) return;
    if (!defaults.byId.has(shortcut.id) || storedById.has(shortcut.id)) return;
    storedById.set(shortcut.id, shortcut);
  });

  return defaults.ordered.map(defaultShortcut =>
    mergeShortcut(defaultShortcut, storedById.get(defaultShortcut.id))
  );
}
