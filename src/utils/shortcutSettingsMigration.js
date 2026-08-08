import { normalizeShortcutSettings } from './shortcutConfig';

// Kept as the migration entry point used by updateApp. The same id-based
// normalization now also feeds menu construction and main-process commits.
export function mergeShortcutSettings(defaultShortcuts, storedShortcuts) {
  return normalizeShortcutSettings(defaultShortcuts, storedShortcuts);
}
