export function shouldYieldMainScrollKey(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  ) {
    return true;
  }
  return (
    typeof target.closest === 'function' && !!target.closest('.vue-slider')
  );
}
