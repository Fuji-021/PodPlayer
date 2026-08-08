// Small renderer-side guard for persisted JSON. A malformed localStorage value
// must never prevent the store or request layer from loading.

const reportedIssues = new Set();

function cloneFallback(value) {
  if (Array.isArray(value)) return value.map(cloneFallback);
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((copy, key) => {
      copy[key] = cloneFallback(value[key]);
      return copy;
    }, {});
  }
  return value;
}

function matchesExpectedType(value, expectedType) {
  if (!expectedType) return true;
  if (expectedType === 'array') return Array.isArray(value);
  if (expectedType === 'object') {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
  return typeof value === expectedType;
}

function reportIssue(key, status) {
  const marker = `${key}:${status}`;
  if (reportedIssues.has(marker)) return;
  reportedIssues.add(marker);
  // Never log the stored value: it can contain private settings or corrupted
  // user data. The key and error class are enough for diagnostics.
  // eslint-disable-next-line no-console
  console.warn('[local-storage] using fallback', { key, status });
}

function getDefaultStorage() {
  if (typeof localStorage !== 'undefined') return localStorage;
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

export function parseStoredJson(raw, fallback, expectedType) {
  if (raw === null || raw === undefined) {
    return { value: cloneFallback(fallback), status: 'missing' };
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    return { value: cloneFallback(fallback), status: 'invalid-json' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { value: cloneFallback(fallback), status: 'invalid-json' };
  }
  if (!matchesExpectedType(parsed, expectedType)) {
    return { value: cloneFallback(fallback), status: 'type-mismatch' };
  }
  return { value: parsed, status: 'ok' };
}

export function readLocalStorageJsonResult(
  key,
  fallback,
  expectedType,
  storage = getDefaultStorage()
) {
  let raw;
  try {
    if (!storage || typeof storage.getItem !== 'function') {
      return { value: cloneFallback(fallback), status: 'storage-unavailable' };
    }
    raw = storage.getItem(key);
  } catch (error) {
    return { value: cloneFallback(fallback), status: 'storage-read-error' };
  }
  const result = parseStoredJson(raw, fallback, expectedType);
  if (result.status !== 'ok' && result.status !== 'missing') {
    reportIssue(key, result.status);
  }
  return result;
}

export function readLocalStorageJson(key, fallback, expectedType, storage) {
  return readLocalStorageJsonResult(key, fallback, expectedType, storage).value;
}
