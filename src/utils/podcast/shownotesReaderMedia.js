const MEDIA_CLASS = 'pp-shownotes-reader-media';
const BLOCK_CLASS = 'pp-shownotes-reader-media--block';
const LINK_CLASS = 'pp-shownotes-reader-media-link';
const FLOW_CLASS = 'pp-shownotes-reader-media-flow';
const FIGURE_CLASS = 'pp-shownotes-reader-media-figure';
const MEDIA_CONTAINER_TAGS = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE']);
const TRANSPARENT_MEDIA_TAGS = new Set(['A', 'SPAN', ...MEDIA_CONTAINER_TAGS]);

function getTagName(node) {
  return String((node && node.tagName) || '').toUpperCase();
}

function getChildren(node) {
  return Array.prototype.slice.call((node && node.childNodes) || []);
}

function hasClass(node, className) {
  return String((node && node.getAttribute && node.getAttribute('class')) || '')
    .split(/\s+/)
    .includes(className);
}

function addClass(node, className) {
  if (!node || !node.getAttribute || hasClass(node, className)) return;
  const classNames = String(node.getAttribute('class') || '')
    .split(/\s+/)
    .filter(Boolean);
  classNames.push(className);
  node.setAttribute('class', classNames.join(' '));
}

function isIgnorableNode(node) {
  return (
    (node && node.nodeType === 3 && !String(node.nodeValue || '').trim()) ||
    getTagName(node) === 'BR'
  );
}

function getMeaningfulChildren(node) {
  return getChildren(node).filter(node => !isIgnorableNode(node));
}

function isRenderableImage(node) {
  return (
    getTagName(node) === 'IMG' &&
    !!String(node.getAttribute('src') || '').trim()
  );
}

function getMediaImage(node) {
  if (isRenderableImage(node)) return node;
  if (!TRANSPARENT_MEDIA_TAGS.has(getTagName(node))) return null;

  const children = getMeaningfulChildren(node);
  return children.length === 1 ? getMediaImage(children[0]) : null;
}

function getLinkForImage(image, root) {
  let node = image && image.parentNode;
  while (node && node !== root) {
    if (getTagName(node) === 'A' && getMediaImage(node) === image) {
      return node;
    }
    node = node.parentNode;
  }
  return null;
}

function isMediaOnlyStructure(node) {
  if (isRenderableImage(node)) return true;
  if (!TRANSPARENT_MEDIA_TAGS.has(getTagName(node))) return false;
  const children = getMeaningfulChildren(node);
  return (
    children.length > 0 && children.every(child => isMediaOnlyStructure(child))
  );
}

function isMediaOnlyContainer(node) {
  return (
    MEDIA_CONTAINER_TAGS.has(getTagName(node)) && isMediaOnlyStructure(node)
  );
}

function isReaderMediaFigure(figure) {
  const children = getMeaningfulChildren(figure).filter(
    child => getTagName(child) !== 'FIGCAPTION'
  );
  return children.length > 0 && children.every(isMediaOnlyStructure);
}

function isIndependentReaderMedia(image, root) {
  const figure = findFigureAncestor(image, root);
  if (figure) {
    return !isInsideFigureCaption(image, figure) && isReaderMediaFigure(figure);
  }

  let node = image;
  while (node && node !== root) {
    const parent = node.parentNode;
    if (parent === root) return true;
    if (!parent || !TRANSPARENT_MEDIA_TAGS.has(getTagName(parent))) {
      return false;
    }
    if (
      !isMediaOnlyContainer(parent) &&
      getTagName(parent) !== 'SPAN' &&
      getTagName(parent) !== 'A'
    ) {
      return false;
    }
    if (!isMediaOnlyStructure(parent)) return false;
    node = parent;
  }
  return false;
}

function findFigureAncestor(image, root) {
  let node = image && image.parentNode;
  while (node && node !== root) {
    if (getTagName(node) === 'FIGURE') return node;
    node = node.parentNode;
  }
  return null;
}

function isInsideFigureCaption(image, figure) {
  let node = image && image.parentNode;
  while (node && node !== figure) {
    if (getTagName(node) === 'FIGCAPTION') return true;
    node = node.parentNode;
  }
  return false;
}

function getReaderMediaContainer(image, root) {
  const figure = findFigureAncestor(image, root);
  if (figure && isInsideFigureCaption(image, figure)) return null;

  let node = image;
  let flowContainer = null;
  while (node && node !== root) {
    const parent = node.parentNode;
    if (!parent) return flowContainer;
    if (getTagName(parent) === 'FIGURE') {
      return flowContainer || (isReaderMediaFigure(parent) ? parent : null);
    }
    if (parent === root) return flowContainer;
    if (!TRANSPARENT_MEDIA_TAGS.has(getTagName(parent))) return null;
    if (!isMediaOnlyStructure(parent)) return null;
    if (MEDIA_CONTAINER_TAGS.has(getTagName(parent))) {
      if (!isMediaOnlyContainer(parent)) return null;
      flowContainer = parent;
    }
    node = parent;
  }
  return flowContainer;
}

function markReaderMediaImage(image, root) {
  if (!isRenderableImage(image)) return;
  if (!isIndependentReaderMedia(image, root)) return;

  const container = getReaderMediaContainer(image, root);

  addClass(image, MEDIA_CLASS);
  addClass(image, BLOCK_CLASS);
  if (!image.getAttribute('decoding')) image.setAttribute('decoding', 'async');

  const link = getLinkForImage(image, root);
  if (link) {
    addClass(link, LINK_CLASS);
    addClass(link, BLOCK_CLASS);
  }

  if (container !== root && getTagName(container) !== 'FIGURE') {
    addClass(container, FLOW_CLASS);
  }
}

function markReaderMediaFigure(figure) {
  if (!isReaderMediaFigure(figure)) return;
  addClass(figure, FIGURE_CLASS);
  addClass(figure, FLOW_CLASS);
}

/**
 * Adds display-only reader semantics to an already-sanitized shownotes DOM.
 * It preserves publisher markup and only marks containers made solely of
 * independent media, leaving inline images embedded in prose untouched.
 */
export function normalizeShownotesReaderMedia(root) {
  if (!root || typeof root.getElementsByTagName !== 'function') return root;

  Array.prototype.slice
    .call(root.getElementsByTagName('figure'))
    .forEach(markReaderMediaFigure);
  Array.prototype.slice
    .call(root.getElementsByTagName('img'))
    .forEach(image => markReaderMediaImage(image, root));
  return root;
}
