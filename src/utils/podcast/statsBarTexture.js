import { getCachedCover, peekCachedCover } from '@/utils/podcast/coverCache';
import { peekTinyCover } from '@/utils/podcast/coverHalo';

// The texture is deliberately tiny. It is a visual fill for the stats bar, not
// a second cover image, so keeping it in a bounded in-memory cache is enough.
export const STATS_BAR_TEXTURE_WIDTH = 4;
export const STATS_BAR_TEXTURE_HEIGHT = 64;

export const STATS_BAR_TEXTURE_PROFILES = {
  soft: 40,
  balanced: STATS_BAR_TEXTURE_HEIGHT,
  fine: STATS_BAR_TEXTURE_HEIGHT,
};

export const STATS_BAR_TEXTURE_DEFAULT_PROFILE = 'balanced';
export const STATS_BAR_TEXTURE_CACHE_MAX = 128;
export const STATS_BAR_TEXTURE_CONCURRENCY = 2;
export const STATS_BAR_TEXTURE_QUEUE_MAX = 256;

const LEFT_EDGE_RATIO = 0.08;

export function shouldPrepareStatsBarTextures(nyancatStyle, active) {
  return !!nyancatStyle && !!active;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isDataImage(value) {
  return typeof value === 'string' && /^data:image\//i.test(value);
}

function hasDecodedImage(image) {
  return !!(
    image &&
    (image.naturalWidth || image.width) > 0 &&
    (image.naturalHeight || image.height) > 0
  );
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (!delta) return [0, 0, l];
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h;
  if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  return [h / 6, s, l];
}

function hueToRgb(p, q, t) {
  let h = t;
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h < 1 / 6) return p + (q - p) * 6 * h;
  if (h < 1 / 2) return q;
  if (h < 2 / 3) return p + (q - p) * (2 / 3 - h) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (!s) {
    const gray = Math.round(l * 255);
    return [gray, gray, gray];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  ];
}

function tuneColor(sample) {
  const hsl = rgbToHsl(sample.r, sample.g, sample.b);
  const saturation = clamp(hsl[1] * 1.15, 0, 0.92);
  const lightness = clamp(0.5 + (hsl[2] - 0.5) * 1.08, 0.1, 0.9);
  const rgb = hslToRgb(hsl[0], saturation, lightness);
  return {
    r: clamp(rgb[0], 18, 237),
    g: clamp(rgb[1], 18, 237),
    b: clamp(rgb[2], 18, 237),
  };
}

function averageBandRow(data, width, height, center, y, thickness) {
  const half = Math.floor(thickness / 2);
  const start = clamp(center - half, 0, width - 1);
  const end = clamp(center + half, 0, width - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let x = start; x <= end; x += 1) {
    const offset = (y * width + x) * 4;
    r += data[offset];
    g += data[offset + 1];
    b += data[offset + 2];
    count += 1;
  }
  return { r: r / count, g: g / count, b: b / count };
}

function readBand(imageData, sampleCount, center, thickness) {
  const samples = [];
  const height = imageData.height;
  for (let index = 0; index < sampleCount; index += 1) {
    const y = clamp(
      Math.floor(((index + 0.5) * height) / sampleCount),
      0,
      height - 1
    );
    samples.push(
      averageBandRow(
        imageData.data,
        imageData.width,
        height,
        center,
        y,
        thickness
      )
    );
  }
  return samples;
}

export function selectStatsBarTextureBand(imageData, sampleCount) {
  if (!imageData || !imageData.data || !imageData.width || !imageData.height) {
    return null;
  }
  const count = clamp(
    sampleCount || STATS_BAR_TEXTURE_PROFILES.balanced,
    40,
    STATS_BAR_TEXTURE_HEIGHT
  );
  const thickness = clamp(Math.round(imageData.width * 0.02), 3, 5);
  const center = clamp(
    Math.round((imageData.width - 1) * LEFT_EDGE_RATIO),
    0,
    imageData.width - 1
  );
  return {
    center,
    thickness,
    samples: readBand(imageData, count, center, thickness),
  };
}

export function buildStatsBarTexturePixels(imageData, options) {
  const opts = options || {};
  const profile = opts.profile || STATS_BAR_TEXTURE_DEFAULT_PROFILE;
  const sampleCount =
    opts.sampleCount ||
    STATS_BAR_TEXTURE_PROFILES[profile] ||
    STATS_BAR_TEXTURE_PROFILES.balanced;
  const width = clamp(opts.width || STATS_BAR_TEXTURE_WIDTH, 2, 4);
  const height = clamp(opts.height || sampleCount, 40, 64);
  const band = selectStatsBarTextureBand(imageData, height);
  if (!band) return null;
  const smoothed = band.samples.map((sample, index, source) => {
    const before = source[Math.max(0, index - 1)];
    const after = source[Math.min(source.length - 1, index + 1)];
    return {
      r: (before.r + sample.r * 2 + after.r) / 4,
      g: (before.g + sample.g * 2 + after.g) / 4,
      b: (before.b + sample.b * 2 + after.b) / 4,
    };
  });
  const data = new Uint8ClampedArray(width * height * 4);
  // Direction contract: output(x, y) = coverSample(y). Each source Y sample
  // becomes one horizontal colour band, so CSS can stretch the texture along
  // X without turning cover colours into vertical columns.
  smoothed.forEach((sample, y) => {
    const tuned = tuneColor(sample);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = tuned.r;
      data[offset + 1] = tuned.g;
      data[offset + 2] = tuned.b;
      data[offset + 3] = 255;
    }
  });
  return {
    width,
    height,
    data,
    bandCenter: band.center,
  };
}

export function collectStatsBarTextureResults(results, shouldKeep) {
  const entries = {};
  (results || []).forEach(result => {
    if (!result || !result.item || !result.value) return;
    if (shouldKeep && !shouldKeep(result.item)) return;
    entries[result.item.podcastId] = {
      url: result.item.coverUrl,
      value: result.value,
    };
  });
  return entries;
}

function canvasFor(width, height, factory) {
  if (factory) return factory(width, height);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function statsBarTextureDataUrl(pixels, canvasFactory) {
  if (!pixels || !pixels.data) return null;
  try {
    const canvas = canvasFor(pixels.width, pixels.height, canvasFactory);
    if (!canvas) return null;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx || !ctx.createImageData || !ctx.putImageData) return null;
    const imageData = ctx.createImageData(pixels.width, pixels.height);
    imageData.data.set(pixels.data);
    ctx.putImageData(imageData, 0, 0);
    const value = canvas.toDataURL && canvas.toDataURL('image/png');
    return isDataImage(value) ? value : null;
  } catch (e) {
    return null;
  }
}

export function createStatsBarTextureFromImage(image, options) {
  if (!hasDecodedImage(image) || typeof document === 'undefined') return null;
  try {
    const maxDimension = (options && options.sourceMaxDimension) || 192;
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const scale = Math.min(
      1,
      maxDimension / Math.max(sourceWidth, sourceHeight)
    );
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = canvasFor(width, height);
    const ctx = canvas && canvas.getContext && canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    const pixels = buildStatsBarTexturePixels(
      ctx.getImageData(0, 0, width, height),
      options
    );
    return statsBarTextureDataUrl(pixels);
  } catch (e) {
    return null;
  }
}

function decodeDataImage(dataUrl, ImageCtor) {
  if (!isDataImage(dataUrl) || !ImageCtor) return Promise.resolve(null);
  return new Promise(resolve => {
    const image = new ImageCtor();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

async function defaultSourceFor(url, sourceImage) {
  const memory = peekCachedCover(url);
  if (isDataImage(memory)) return decodeDataImage(memory, Image);
  const persistent = await getCachedCover(url);
  if (isDataImage(persistent)) return decodeDataImage(persistent, Image);
  const tiny = peekTinyCover(url);
  if (isDataImage(tiny)) return decodeDataImage(tiny, Image);
  if (hasDecodedImage(sourceImage)) return sourceImage;
  return null;
}

function scheduleOne(callback, scheduler) {
  if (scheduler && scheduler.requestIdle)
    return scheduler.requestIdle(callback);
  if (typeof window !== 'undefined' && window.requestIdleCallback) {
    const handle = window.requestIdleCallback(callback, { timeout: 700 });
    return { kind: 'idle', handle };
  }
  const handle = setTimeout(callback, 0);
  return { kind: 'timeout', handle };
}

function cancelScheduled(handle, scheduler) {
  if (!handle) return;
  if (scheduler && scheduler.cancelIdle) {
    scheduler.cancelIdle(handle);
    return;
  }
  if (handle.kind === 'idle' && typeof window !== 'undefined') {
    window.cancelIdleCallback && window.cancelIdleCallback(handle.handle);
  } else {
    clearTimeout(handle.handle);
  }
}

export function createStatsBarTextureScheduler(options) {
  const opts = options || {};
  const cacheMax = opts.cacheMax || STATS_BAR_TEXTURE_CACHE_MAX;
  const concurrency = opts.concurrency || STATS_BAR_TEXTURE_CONCURRENCY;
  const queueMax = opts.queueMax || STATS_BAR_TEXTURE_QUEUE_MAX;
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  const sourceFor = opts.sourceFor || defaultSourceFor;
  const render = opts.render || createStatsBarTextureFromImage;
  const scheduler = opts.scheduler || null;
  let active = 0;
  let scheduled = null;

  function remember(url, texture) {
    if (!texture) return;
    if (cache.has(url)) cache.delete(url);
    cache.set(url, texture);
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
  }

  function settle(task, value) {
    pending.delete(task.url);
    task.resolve(value || null);
  }

  function dropOne() {
    while (queue.length >= queueMax) {
      const staleIndex = queue.findIndex(
        task => task.isValid && !task.isValid()
      );
      const index = staleIndex >= 0 ? staleIndex : 0;
      const dropped = queue.splice(index, 1)[0];
      settle(dropped, null);
    }
  }

  function pumpOne() {
    scheduled = null;
    if (active >= concurrency || !queue.length) return;
    const task = queue.shift();
    if (task.isValid && !task.isValid()) {
      settle(task, null);
      schedule();
      return;
    }
    active += 1;
    Promise.resolve()
      .then(() => sourceFor(task.url, task.sourceImage))
      .then(source => {
        if (task.isValid && !task.isValid()) return null;
        return source ? render(source, task.options) : null;
      })
      .then(texture => {
        if (texture) remember(task.url, texture);
        settle(task, texture);
      })
      .catch(() => settle(task, null))
      .finally(() => {
        active -= 1;
        schedule();
      });
    schedule();
  }

  function schedule() {
    if (scheduled || !queue.length || active >= concurrency) return;
    scheduled = scheduleOne(pumpOne, scheduler);
  }

  function request(url, requestOptions) {
    const key = String(url || '');
    if (!key) return Promise.resolve(null);
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit);
      return Promise.resolve(hit);
    }
    const optsForTask = requestOptions || {};
    if (pending.has(key)) {
      const existing = pending.get(key);
      // A PodImage load can arrive while the cache-only request is still queued.
      // Upgrade that one shared task to the decoded image rather than creating a
      // second canvas job or letting the first task miss its only local source.
      if (hasDecodedImage(optsForTask.sourceImage)) {
        existing.sourceImage = optsForTask.sourceImage;
      }
      if (optsForTask.isValid) existing.isValid = optsForTask.isValid;
      if (optsForTask.options) existing.options = optsForTask.options;
      return existing.promise;
    }
    let resolve;
    const promise = new Promise(done => {
      resolve = done;
    });
    const task = {
      url: key,
      resolve,
      promise,
      sourceImage: optsForTask.sourceImage || null,
      isValid: optsForTask.isValid || null,
      options: optsForTask.options || null,
    };
    pending.set(key, task);
    dropOne();
    queue.push(task);
    schedule();
    return promise;
  }

  function cancelWhere(predicate) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const task = queue[index];
      if (predicate(task)) {
        queue.splice(index, 1);
        settle(task, null);
      }
    }
    if (!queue.length && scheduled) {
      cancelScheduled(scheduled, scheduler);
      scheduled = null;
    }
  }

  return {
    request,
    cancelWhere,
    peek(url) {
      return cache.get(String(url || '')) || null;
    },
    clear() {
      cache.clear();
    },
    stats() {
      return {
        cacheSize: cache.size,
        pending: pending.size,
        queued: queue.length,
        active,
      };
    },
  };
}

const defaultScheduler = createStatsBarTextureScheduler();

export function getStatsBarTexture(url, options) {
  return defaultScheduler.request(url, options);
}

export function peekStatsBarTexture(url) {
  return defaultScheduler.peek(url);
}

export function cancelStatsBarTextureRequests(predicate) {
  defaultScheduler.cancelWhere(predicate);
}
