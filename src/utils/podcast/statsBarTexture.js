import { getCachedCover, peekCachedCover } from '@/utils/podcast/coverCache';
import { peekTinyCover } from '@/utils/podcast/coverHalo';

// The texture is deliberately tiny. It is a visual fill for the stats bar, not
// a second cover image, so keeping it in a bounded in-memory cache is enough.
// V3 parameters live here so visual tuning cannot leak into the page runtime.
export const STATS_BAR_TEXTURE_CONFIG = Object.freeze({
  version: 3,
  fillWidth: 4,
  fillHeight: 64,
  analysisMaxDimension: 64,
  profiles: {
    soft: 40,
    balanced: 64,
    fine: 64,
  },
  trimDarkRatio: 0.1,
  trimLightRatio: 0.05,
  minReadableLightness: 0.33,
  maxReadableLightness: 0.8,
  maxSaturation: 0.9,
  rowBaseWeight: 0.45,
  rowMidtoneWeight: 0.45,
  rowSaturationWeight: 0.55,
  accentSaturationScoreWeight: 0.78,
  accentLuminanceScoreWeight: 0.22,
  accentMixMax: 0.14,
  accentMixSaturationWeight: 0.85,
  accentMixLuminanceWeight: 0.15,
  lowVarianceThreshold: 0.003,
  paletteVarianceThreshold: 0.008,
  lowVarianceMix: 0.12,
  paletteAccentFlowMix: 0.32,
  edgeSampleWidth: 2,
  bridgeWidth: 28,
  bridgeOverlap: 5,
  bridgeWobble: 3,
  bridgePrimaryFrequency: 0.43,
  bridgePrimaryAmplitude: 2,
  bridgeSecondaryFrequency: 0.12,
  bridgeSecondaryAmplitude: 1,
});

export const STATS_BAR_TEXTURE_WIDTH = STATS_BAR_TEXTURE_CONFIG.fillWidth;
export const STATS_BAR_TEXTURE_HEIGHT = STATS_BAR_TEXTURE_CONFIG.fillHeight;
export const STATS_BAR_TEXTURE_PROFILES = STATS_BAR_TEXTURE_CONFIG.profiles;

export const STATS_BAR_TEXTURE_DEFAULT_PROFILE = 'balanced';
export const STATS_BAR_TEXTURE_CACHE_MAX = 128;
export const STATS_BAR_TEXTURE_CONCURRENCY = 2;
export const STATS_BAR_TEXTURE_QUEUE_MAX = 256;

export function shouldPrepareStatsBarTextures(nyancatStyle, active) {
  return !!nyancatStyle && !!active;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isDataImage(value) {
  return typeof value === 'string' && /^data:image\//i.test(value);
}

export function statsBarTextureCacheKey(url) {
  return `stats-bar-texture:v${STATS_BAR_TEXTURE_CONFIG.version}:${String(
    url || ''
  )}`;
}

export function isStatsBarTextureValue(value) {
  return !!(
    value &&
    value.version === STATS_BAR_TEXTURE_CONFIG.version &&
    isDataImage(value.fillUrl) &&
    isDataImage(value.bridgeUrl)
  );
}

function hasDecodedImage(image) {
  return !!(
    image &&
    (image.naturalWidth || image.width) > 0 &&
    (image.naturalHeight || image.height) > 0
  );
}

export function srgbByteToLinear(value) {
  const channel = clamp(value, 0, 255) / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

export function linearToSrgbByte(value) {
  const channel = clamp(value, 0, 1);
  const srgb =
    channel <= 0.0031308
      ? channel * 12.92
      : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  return Math.round(clamp(srgb, 0, 1) * 255);
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

function linearLuminance(sample) {
  return sample.r * 0.2126 + sample.g * 0.7152 + sample.b * 0.0722;
}

function linearToRgb(sample) {
  return {
    r: linearToSrgbByte(sample.r),
    g: linearToSrgbByte(sample.g),
    b: linearToSrgbByte(sample.b),
  };
}

function rgbSaturation(rgb) {
  const max = Math.max(rgb.r, rgb.g, rgb.b) / 255;
  const min = Math.min(rgb.r, rgb.g, rgb.b) / 255;
  return max ? (max - min) / max : 0;
}

function toLinearSample(data, offset) {
  const rgb = {
    r: data[offset],
    g: data[offset + 1],
    b: data[offset + 2],
  };
  const sample = {
    r: srgbByteToLinear(rgb.r),
    g: srgbByteToLinear(rgb.g),
    b: srgbByteToLinear(rgb.b),
    alpha: data[offset + 3] / 255,
  };
  sample.luminance = linearLuminance(sample);
  sample.saturation = rgbSaturation(rgb);
  return sample;
}

function mixLinear(first, second, amount) {
  const mix = clamp(amount, 0, 1);
  return {
    r: first.r + (second.r - first.r) * mix,
    g: first.g + (second.g - first.g) * mix,
    b: first.b + (second.b - first.b) * mix,
  };
}

function averageLinear(samples, weightFor) {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  (samples || []).forEach(sample => {
    const weight = Math.max(
      0,
      weightFor ? weightFor(sample) : sample.alpha || 1
    );
    if (!weight) return;
    r += sample.r * weight;
    g += sample.g * weight;
    b += sample.b * weight;
    total += weight;
  });
  if (!total) return null;
  return { r: r / total, g: g / total, b: b / total };
}

function tuneColor(sample) {
  const rgb = linearToRgb(sample);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  let lightness = hsl[2];
  if (lightness < STATS_BAR_TEXTURE_CONFIG.minReadableLightness) {
    lightness = STATS_BAR_TEXTURE_CONFIG.minReadableLightness;
  } else if (lightness > STATS_BAR_TEXTURE_CONFIG.maxReadableLightness) {
    lightness = STATS_BAR_TEXTURE_CONFIG.maxReadableLightness;
  }
  const saturation = clamp(hsl[1], 0, STATS_BAR_TEXTURE_CONFIG.maxSaturation);
  const tuned = hslToRgb(hsl[0], saturation, lightness);
  return {
    r: tuned[0],
    g: tuned[1],
    b: tuned[2],
  };
}

function samplesForSourceRow(imageData, y) {
  const samples = [];
  for (let x = 0; x < imageData.width; x += 1) {
    const sample = toLinearSample(
      imageData.data,
      (y * imageData.width + x) * 4
    );
    if (sample.alpha > 0) samples.push(sample);
  }
  return samples;
}

function robustSourceRow(imageData, y) {
  const samples = samplesForSourceRow(imageData, y);
  if (!samples.length) return { r: 0, g: 0, b: 0 };
  const ordered = samples
    .slice()
    .sort((first, second) => first.luminance - second.luminance);
  const start = Math.floor(
    ordered.length * STATS_BAR_TEXTURE_CONFIG.trimDarkRatio
  );
  const end = Math.max(
    start + 1,
    Math.ceil(ordered.length * (1 - STATS_BAR_TEXTURE_CONFIG.trimLightRatio))
  );
  const main = averageLinear(ordered.slice(start, end), sample => {
    const midtone = 1 - Math.min(1, Math.abs(sample.luminance - 0.48) / 0.48);
    return (
      sample.alpha *
      (STATS_BAR_TEXTURE_CONFIG.rowBaseWeight +
        midtone * STATS_BAR_TEXTURE_CONFIG.rowMidtoneWeight +
        sample.saturation * STATS_BAR_TEXTURE_CONFIG.rowSaturationWeight)
    );
  }) || { r: 0, g: 0, b: 0 };
  const accent = samples.reduce((best, sample) => {
    const score =
      sample.saturation * STATS_BAR_TEXTURE_CONFIG.accentSaturationScoreWeight +
      Math.sqrt(sample.luminance) *
        STATS_BAR_TEXTURE_CONFIG.accentLuminanceScoreWeight;
    return !best || score > best.score ? { sample, score } : best;
  }, null);
  if (!accent) return main;
  const accentMix =
    STATS_BAR_TEXTURE_CONFIG.accentMixMax *
    clamp(
      accent.sample.saturation *
        STATS_BAR_TEXTURE_CONFIG.accentMixSaturationWeight +
        accent.sample.luminance *
          STATS_BAR_TEXTURE_CONFIG.accentMixLuminanceWeight,
      0,
      1
    );
  return mixLinear(main, accent.sample, accentMix);
}

function sourceYForOutputRow(sourceHeight, index, outputHeight) {
  return clamp(
    Math.floor(((index + 0.5) * sourceHeight) / outputHeight),
    0,
    sourceHeight - 1
  );
}

function readRobustRows(imageData, sampleCount) {
  const rows = [];
  for (let index = 0; index < sampleCount; index += 1) {
    rows.push(
      robustSourceRow(
        imageData,
        sourceYForOutputRow(imageData.height, index, sampleCount)
      )
    );
  }
  return rows;
}

function smoothRows(rows) {
  return rows.map((sample, index, source) => {
    const before = source[Math.max(0, index - 1)];
    const after = source[Math.min(source.length - 1, index + 1)];
    return {
      r: (before.r + sample.r * 2 + after.r) / 4,
      g: (before.g + sample.g * 2 + after.g) / 4,
      b: (before.b + sample.b * 2 + after.b) / 4,
    };
  });
}

function squaredDistance(first, second) {
  return (
    (first.r - second.r) * (first.r - second.r) +
    (first.g - second.g) * (first.g - second.g) +
    (first.b - second.b) * (first.b - second.b)
  );
}

function analysePalette(imageData) {
  const samples = [];
  for (let index = 0; index < imageData.width * imageData.height; index += 1) {
    const sample = toLinearSample(imageData.data, index * 4);
    if (sample.alpha > 0) samples.push(sample);
  }
  const mean = averageLinear(samples, sample => sample.alpha) || {
    r: 0,
    g: 0,
    b: 0,
  };
  let secondary = mean;
  let accent = mean;
  let secondaryDistance = -1;
  let accentScore = -1;
  let variance = 0;
  samples.forEach(sample => {
    const distance = squaredDistance(sample, mean);
    variance += distance;
    if (distance > secondaryDistance) {
      secondary = sample;
      secondaryDistance = distance;
    }
    const score =
      sample.saturation * STATS_BAR_TEXTURE_CONFIG.accentSaturationScoreWeight +
      Math.sqrt(sample.luminance) *
        STATS_BAR_TEXTURE_CONFIG.accentLuminanceScoreWeight;
    if (score > accentScore) {
      accent = sample;
      accentScore = score;
    }
  });
  return {
    mean,
    secondary,
    accent,
    variance: samples.length ? variance / samples.length : 0,
  };
}

function applyLowVarianceCompensation(rows, palette) {
  if (!rows.length) return rows;
  const mean = averageLinear(rows, () => 1) || palette.mean;
  const rowVariance =
    rows.reduce((total, row) => total + squaredDistance(row, mean), 0) /
    rows.length;
  if (
    rowVariance > STATS_BAR_TEXTURE_CONFIG.lowVarianceThreshold ||
    palette.variance < STATS_BAR_TEXTURE_CONFIG.paletteVarianceThreshold
  ) {
    return rows;
  }
  return rows.map((row, index) => {
    const progress = rows.length > 1 ? index / (rows.length - 1) : 0;
    const paletteFlow = mixLinear(
      palette.mean,
      palette.secondary,
      progress * progress * (3 - 2 * progress)
    );
    const accentMix =
      Math.sin(Math.PI * progress) *
      STATS_BAR_TEXTURE_CONFIG.paletteAccentFlowMix;
    const target = mixLinear(paletteFlow, palette.accent, accentMix);
    return mixLinear(row, target, STATS_BAR_TEXTURE_CONFIG.lowVarianceMix);
  });
}

function readEdgeRows(imageData, sampleCount) {
  const rows = [];
  const edgeWidth = Math.min(
    imageData.width,
    STATS_BAR_TEXTURE_CONFIG.edgeSampleWidth
  );
  for (let index = 0; index < sampleCount; index += 1) {
    const y = sourceYForOutputRow(imageData.height, index, sampleCount);
    const samples = [];
    for (let x = 0; x < edgeWidth; x += 1) {
      const sample = toLinearSample(
        imageData.data,
        (y * imageData.width + x) * 4
      );
      if (sample.alpha > 0) samples.push(sample);
    }
    rows.push(
      linearToRgb(
        averageLinear(samples, sample => sample.alpha) || { r: 0, g: 0, b: 0 }
      )
    );
  }
  return rows;
}

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value || 'stats-bar-texture');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function smoothstep(value) {
  const progress = clamp(value, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function buildBridgePixels(fillRows, edgeRows, seed) {
  const width = STATS_BAR_TEXTURE_CONFIG.bridgeWidth;
  const height = fillRows.length;
  const data = new Uint8ClampedArray(width * height * 4);
  const hash = stableHash(seed);
  const phase = ((hash % 997) / 997) * Math.PI * 2;
  for (let y = 0; y < height; y += 1) {
    const wobble = clamp(
      Math.round(
        Math.sin(y * STATS_BAR_TEXTURE_CONFIG.bridgePrimaryFrequency + phase) *
          STATS_BAR_TEXTURE_CONFIG.bridgePrimaryAmplitude +
          Math.sin(
            y * STATS_BAR_TEXTURE_CONFIG.bridgeSecondaryFrequency + phase
          ) *
            STATS_BAR_TEXTURE_CONFIG.bridgeSecondaryAmplitude
      ),
      -STATS_BAR_TEXTURE_CONFIG.bridgeWobble,
      STATS_BAR_TEXTURE_CONFIG.bridgeWobble
    );
    const baseTransitionLength = width - STATS_BAR_TEXTURE_CONFIG.bridgeWobble;
    const transitionLength = clamp(
      baseTransitionLength + wobble,
      width - STATS_BAR_TEXTURE_CONFIG.bridgeWobble * 2,
      width
    );
    const transitionStart = width - transitionLength;
    const fill = fillRows[y];
    const edge = edgeRows[y] || fill;
    for (let x = 0; x < width; x += 1) {
      const progress = smoothstep(
        (x - transitionStart) / Math.max(1, transitionLength - 1)
      );
      const offset = (y * width + x) * 4;
      data[offset] = Math.round(fill.r + (edge.r - fill.r) * progress);
      data[offset + 1] = Math.round(fill.g + (edge.g - fill.g) * progress);
      data[offset + 2] = Math.round(fill.b + (edge.b - fill.b) * progress);
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
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
  return {
    center: null,
    thickness: imageData.width,
    samples: readRobustRows(imageData, count),
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
  const palette = analysePalette(imageData);
  const rows = applyLowVarianceCompensation(smoothRows(band.samples), palette);
  const fillRows = rows.map(tuneColor);
  const data = new Uint8ClampedArray(width * height * 4);
  // Direction contract: output(x, y) = coverSample(y). Each source Y sample
  // becomes one horizontal colour band, so CSS can stretch the texture along
  // X without turning cover colours into vertical columns.
  fillRows.forEach((tuned, y) => {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = tuned.r;
      data[offset + 1] = tuned.g;
      data[offset + 2] = tuned.b;
      data[offset + 3] = 255;
    }
  });
  return {
    version: STATS_BAR_TEXTURE_CONFIG.version,
    width,
    height,
    data,
    bridge: buildBridgePixels(
      fillRows,
      readEdgeRows(imageData, height),
      opts.seed
    ),
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

export function statsBarTextureValueFromPixels(pixels, canvasFactory) {
  if (!pixels || !pixels.bridge) return null;
  const fillUrl = statsBarTextureDataUrl(pixels, canvasFactory);
  const bridgeUrl = statsBarTextureDataUrl(pixels.bridge, canvasFactory);
  const value = {
    version: STATS_BAR_TEXTURE_CONFIG.version,
    fillUrl,
    bridgeUrl,
  };
  return isStatsBarTextureValue(value) ? value : null;
}

export function createStatsBarTextureFromImage(image, options) {
  if (!hasDecodedImage(image) || typeof document === 'undefined') return null;
  try {
    const maxDimension =
      (options && options.sourceMaxDimension) ||
      STATS_BAR_TEXTURE_CONFIG.analysisMaxDimension;
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
    return statsBarTextureValueFromPixels(pixels);
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
      .then(() => sourceFor(task.sourceUrl, task.sourceImage))
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
      sourceUrl: optsForTask.sourceUrl || key,
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
  const sourceUrl = String(url || '');
  return defaultScheduler.request(
    statsBarTextureCacheKey(sourceUrl),
    Object.assign({}, options, {
      sourceUrl,
      seed: (options && options.seed) || sourceUrl,
    })
  );
}

export function peekStatsBarTexture(url) {
  return defaultScheduler.peek(statsBarTextureCacheKey(url));
}

export function cancelStatsBarTextureRequests(predicate) {
  defaultScheduler.cancelWhere(predicate);
}
