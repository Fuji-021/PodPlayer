function asElement(target) {
  if (!target) return null;
  if (target.nodeType === 1) return target;
  return target.parentElement || target.parentNode || null;
}

function nodeIsWithin(root, node) {
  if (!root || !node || typeof root.contains !== 'function') return false;
  return root === node || root.contains(node);
}

/**
 * Returns whether an event target belongs to a user-readable content island.
 * UI shells deliberately remain selectable only when they opt into this marker.
 */
export function isContentSelectionTarget(target) {
  const element = asElement(target);
  return !!(
    element &&
    typeof element.closest === 'function' &&
    element.closest('[data-selection="content"]')
  );
}

/**
 * A selection belongs to a root only when both endpoints are inside it. This
 * avoids an old selection elsewhere in the page suppressing an unrelated click.
 */
export function hasSelectionWithin(root) {
  if (
    !root ||
    typeof window === 'undefined' ||
    typeof window.getSelection !== 'function'
  ) {
    return false;
  }
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) {
    return false;
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (
      range &&
      nodeIsWithin(root, range.startContainer) &&
      nodeIsWithin(root, range.endContainer)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Content text wins over an owning row's click/double-click action whenever
 * the user has made a non-collapsed selection inside that row/read surface.
 */
export function shouldPreserveSelection(event, root) {
  return (
    isContentSelectionTarget(event && event.target) && hasSelectionWithin(root)
  );
}
