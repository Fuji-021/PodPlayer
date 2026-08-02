import { getCachedCover, peekCachedCover } from '@/utils/podcast/coverCache';
import { peekTinyCover } from '@/utils/podcast/coverHalo';

// The texture is deliberately tiny. It is a visual fill for the stats bar, not
// a second cover image, so keeping it in a bounded in-memory cache is enough.
// V5 parameters live here so visual tuning cannot leak into the page runtime.
export const STATS_BAR_TEXTURE_CONFIG = Object.freeze({
  version: 5,
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
  // Absolute OKLCH chroma, rather than HSL saturation, decides whether a
  // pixel carries visible colour. This prevents near-black JPEG channel noise
  // such as RGB(4, 0, 0) from becoming a vivid band after the lightness lift.
  neutralChromaThreshold: 0.035,
  perceptualChromaReference: 0.18,
  minReadableOklabLightness: 0.5,
  maxReadableOklabLightness: 0.82,
  maxPerceptualChroma: 0.24,
  rowBaseWeight: 0.45,
  rowMidtoneWeight: 0.45,
  rowChromaWeight: 0.55,
  colorClusterHueBins: 18,
  colorClusterLightnessBins: 4,
  colorClusterNeutralChroma: 0.035,
  rowAccentMinCoverage: 0.04,
  globalClusterMinCoverage: 0.012,
  accentCoverageFull: 0.28,
  accentMinChroma: 0.055,
  accentChromaReference: 0.22,
  accentChromaScoreWeight: 0.78,
  accentLightnessScoreWeight: 0.22,
  accentMixMax: 0.14,
  lowVarianceThreshold: 0.003,
  paletteVarianceThreshold: 0.008,
  lowVarianceMix: 0.12,
  paletteAccentFlowMix: 0.32,
  edgeSampleWidth: 2,
  bridgeOuterWidth: 24,
  bridgeCoverIngress: 8,
  bridgeWidth: 32,
  bridgeIngressSourceWidth: 8,
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

export function shouldPrepareStatsBarTextures(textureEnabled, active) {
  return !!textureEnabled && !!active;
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

export function linearRgbToOklab(sample) {
  const l = Math.cbrt(
    Math.max(
      0,
      sample.r * 0.4122214708 +
        sample.g * 0.5363325363 +
        sample.b * 0.0514459929
    )
  );
  const m = Math.cbrt(
    Math.max(
      0,
      sample.r * 0.2119034982 +
        sample.g * 0.6806995451 +
        sample.b * 0.1073969566
    )
  );
  const s = Math.cbrt(
    Math.max(
      0,
      sample.r * 0.0883024619 +
        sample.g * 0.2817188376 +
        sample.b * 0.6299787005
    )
  );
  return {
    L: l * 0.2104542553 + m * 0.793617785 - s * 0.0040720468,
    a: l * 1.9779984951 - m * 2.428592205 + s * 0.4505937099,
    b: l * 0.0259040371 + m * 0.7827717662 - s * 0.808675766,
  };
}

export function oklabToLinearRgb(lab) {
  const l = Math.pow(lab.L + lab.a * 0.3963377774 + lab.b * 0.2158037573, 3);
  const m = Math.pow(lab.L - lab.a * 0.1055613458 - lab.b * 0.0638541728, 3);
  const s = Math.pow(lab.L - lab.a * 0.0894841775 - lab.b * 1.291485548, 3);
  return {
    r: l * 4.0767416621 - m * 3.3077115913 + s * 0.2309699292,
    g: -l * 1.2684380046 + m * 2.6097574011 - s * 0.3413193965,
    b: -l * 0.0041960863 - m * 0.7034186147 + s * 1.707614701,
  };
}

export function oklabToOklch(lab) {
  const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  return {
    L: lab.L,
    C: chroma,
    h: chroma > 0.000001 ? Math.atan2(lab.b, lab.a) : 0,
  };
}

export function linearRgbToOklch(sample) {
  return oklabToOklch(linearRgbToOklab(sample));
}

export function oklchToLinearRgb(lch) {
  return oklabToLinearRgb({
    L: lch.L,
    a: lch.C * Math.cos(lch.h),
    b: lch.C * Math.sin(lch.h),
  });
}

function isLinearRgbInGamut(sample) {
  return (
    sample.r >= -0.000001 &&
    sample.r <= 1.000001 &&
    sample.g >= -0.000001 &&
    sample.g <= 1.000001 &&
    sample.b >= -0.000001 &&
    sample.b <= 1.000001
  );
}

// Lightness adjustments can push an otherwise valid OKLCH colour outside
// sRGB. Reduce only chroma until it fits, preserving the perceptual hue rather
// than clipping individual RGB channels into a different colour.
export function mapOklchToLinearRgb(lch) {
  const bounded = {
    L: clamp(lch.L, 0, 1),
    C: Math.max(0, lch.C),
    h: lch.h || 0,
  };
  const direct = oklchToLinearRgb(bounded);
  if (isLinearRgbInGamut(direct)) return direct;
  let low = 0;
  let high = bounded.C;
  let mapped = oklchToLinearRgb({
    L: bounded.L,
    C: 0,
    h: bounded.h,
  });
  for (let index = 0; index < 10; index += 1) {
    const middle = (low + high) / 2;
    const candidate = oklchToLinearRgb({
      L: bounded.L,
      C: middle,
      h: bounded.h,
    });
    if (isLinearRgbInGamut(candidate)) {
      low = middle;
      mapped = candidate;
    } else {
      high = middle;
    }
  }
  return mapped;
}

function normalizedHue(hue) {
  const turn = hue / (Math.PI * 2);
  return turn - Math.floor(turn);
}

export function isStatsBarTextureNeutralChroma(chroma) {
  return chroma < STATS_BAR_TEXTURE_CONFIG.neutralChromaThreshold;
}

function toLinearSample(data, offset) {
  const sample = {
    r: srgbByteToLinear(data[offset]),
    g: srgbByteToLinear(data[offset + 1]),
    b: srgbByteToLinear(data[offset + 2]),
    alpha: data[offset + 3] / 255,
  };
  sample.luminance = linearLuminance(sample);
  const lch = linearRgbToOklch(sample);
  sample.hue = normalizedHue(lch.h);
  sample.perceptualLightness = lch.L;
  sample.chroma = lch.C;
  return sample;
}

// Pure diagnostics for the offline smoke. Runtime rendering never logs or
// stores these counts; they let fixtures prove that neutral JPEG noise is not
// classified as usable colour by the same threshold used in production.
export function inspectStatsBarTextureImage(imageData) {
  if (!imageData || !imageData.data) return null;
  let visiblePixelCount = 0;
  let neutralPixelCount = 0;
  let chromaticPixelCount = 0;
  for (let index = 0; index < imageData.width * imageData.height; index += 1) {
    const sample = toLinearSample(imageData.data, index * 4);
    if (!sample.alpha) continue;
    visiblePixelCount += 1;
    if (isStatsBarTextureNeutralChroma(sample.chroma)) {
      neutralPixelCount += 1;
    } else {
      chromaticPixelCount += 1;
    }
  }
  return {
    visiblePixelCount,
    neutralPixelCount,
    chromaticPixelCount,
    chromaticCoverage: visiblePixelCount
      ? chromaticPixelCount / visiblePixelCount
      : 0,
  };
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

function clusterKeyForSample(sample) {
  const config = STATS_BAR_TEXTURE_CONFIG;
  const lightnessBin = clamp(
    Math.floor(sample.perceptualLightness * config.colorClusterLightnessBins),
    0,
    config.colorClusterLightnessBins - 1
  );
  if (sample.chroma < config.colorClusterNeutralChroma) {
    return `neutral:${lightnessBin}`;
  }
  const hueBin = clamp(
    Math.floor(sample.hue * config.colorClusterHueBins),
    0,
    config.colorClusterHueBins - 1
  );
  return `colour:${hueBin}:${lightnessBin}`;
}

// V5 never promotes one vivid pixel to a whole stats band. The cluster
// coverage is calculated from source pixels that survived the robust trim.
export function clusterStatsBarTextureSamples(samples) {
  const buckets = new Map();
  let totalWeight = 0;
  (samples || []).forEach(sample => {
    if (!sample || !sample.alpha) return;
    const weight = Math.max(0, sample.alpha);
    if (!weight) return;
    const key = clusterKeyForSample(sample);
    const bucket = buckets.get(key) || {
      key,
      count: 0,
      weight: 0,
      r: 0,
      g: 0,
      b: 0,
    };
    bucket.count += 1;
    bucket.weight += weight;
    bucket.r += sample.r * weight;
    bucket.g += sample.g * weight;
    bucket.b += sample.b * weight;
    buckets.set(key, bucket);
    totalWeight += weight;
  });
  if (!totalWeight) return [];
  return Array.from(buckets.values()).map(bucket => {
    const color = {
      r: bucket.r / bucket.weight,
      g: bucket.g / bucket.weight,
      b: bucket.b / bucket.weight,
    };
    const lch = linearRgbToOklch(color);
    return {
      key: bucket.key,
      count: bucket.count,
      coverage: bucket.weight / totalWeight,
      color,
      chroma: lch.C,
      perceptualLightness: lch.L,
      luminance: linearLuminance(color),
      isNeutral: bucket.key.indexOf('neutral:') === 0,
    };
  });
}

function accentQuality(cluster) {
  const chroma = clamp(
    (cluster.chroma - STATS_BAR_TEXTURE_CONFIG.neutralChromaThreshold) /
      Math.max(
        0.001,
        STATS_BAR_TEXTURE_CONFIG.accentChromaReference -
          STATS_BAR_TEXTURE_CONFIG.neutralChromaThreshold
      ),
    0,
    1
  );
  return clamp(
    chroma * STATS_BAR_TEXTURE_CONFIG.accentChromaScoreWeight +
      Math.sqrt(cluster.perceptualLightness) *
        STATS_BAR_TEXTURE_CONFIG.accentLightnessScoreWeight,
    0,
    1
  );
}

function pickAccentCluster(clusters, minCoverage) {
  let selected = null;
  (clusters || []).forEach(cluster => {
    if (
      !cluster ||
      cluster.isNeutral ||
      cluster.coverage < minCoverage ||
      cluster.chroma < STATS_BAR_TEXTURE_CONFIG.accentMinChroma
    ) {
      return;
    }
    const score = cluster.coverage * accentQuality(cluster);
    if (!selected || score > selected.score) {
      selected = { cluster, score };
    }
  });
  return selected && selected.cluster;
}

export function statsBarTextureAccentMix(cluster, minCoverage) {
  if (!cluster || cluster.isNeutral) return 0;
  const floor =
    minCoverage == null
      ? STATS_BAR_TEXTURE_CONFIG.rowAccentMinCoverage
      : minCoverage;
  const coverage = smoothstep(
    (cluster.coverage - floor) /
      Math.max(0.001, STATS_BAR_TEXTURE_CONFIG.accentCoverageFull - floor)
  );
  return (
    STATS_BAR_TEXTURE_CONFIG.accentMixMax * coverage * accentQuality(cluster)
  );
}

export function tuneStatsBarTextureColor(sample) {
  const lch = linearRgbToOklch(sample);
  const chroma = isStatsBarTextureNeutralChroma(lch.C)
    ? 0
    : Math.min(lch.C, STATS_BAR_TEXTURE_CONFIG.maxPerceptualChroma);
  const tuned = mapOklchToLinearRgb({
    L: clamp(
      lch.L,
      STATS_BAR_TEXTURE_CONFIG.minReadableOklabLightness,
      STATS_BAR_TEXTURE_CONFIG.maxReadableOklabLightness
    ),
    C: chroma,
    h: lch.h,
  });
  return linearToRgb(tuned);
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
  const retained = ordered.slice(start, end);
  const main = averageLinear(retained, sample => {
    const midtone = 1 - Math.min(1, Math.abs(sample.luminance - 0.48) / 0.48);
    const chroma = clamp(
      (sample.chroma - STATS_BAR_TEXTURE_CONFIG.neutralChromaThreshold) /
        Math.max(
          0.001,
          STATS_BAR_TEXTURE_CONFIG.perceptualChromaReference -
            STATS_BAR_TEXTURE_CONFIG.neutralChromaThreshold
        ),
      0,
      1
    );
    return (
      sample.alpha *
      (STATS_BAR_TEXTURE_CONFIG.rowBaseWeight +
        midtone * STATS_BAR_TEXTURE_CONFIG.rowMidtoneWeight +
        chroma * STATS_BAR_TEXTURE_CONFIG.rowChromaWeight)
    );
  }) || { r: 0, g: 0, b: 0 };
  // Only the robustly retained pixels can contribute an accent. A pixel that
  // the main estimate rejected as an extreme must not sneak back in as colour.
  const accent = pickAccentCluster(
    clusterStatsBarTextureSamples(retained),
    STATS_BAR_TEXTURE_CONFIG.rowAccentMinCoverage
  );
  if (!accent) return main;
  return mixLinear(
    main,
    accent.color,
    statsBarTextureAccentMix(
      accent,
      STATS_BAR_TEXTURE_CONFIG.rowAccentMinCoverage
    )
  );
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

export function analyseStatsBarTexturePalette(imageData) {
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
  let variance = 0;
  samples.forEach(sample => {
    variance += squaredDistance(sample, mean);
  });
  const clusters = clusterStatsBarTextureSamples(samples);
  const eligible = clusters.filter(
    cluster =>
      cluster.coverage >= STATS_BAR_TEXTURE_CONFIG.globalClusterMinCoverage
  );
  const primaryCluster = eligible
    .slice()
    .sort((first, second) => second.coverage - first.coverage)[0];
  const primary = (primaryCluster && primaryCluster.color) || mean;
  let secondary = primary;
  let secondaryScore = -1;
  eligible.forEach(cluster => {
    const score =
      squaredDistance(cluster.color, primary) * Math.sqrt(cluster.coverage);
    if (score > secondaryScore) {
      secondary = cluster.color;
      secondaryScore = score;
    }
  });
  const accentCluster = pickAccentCluster(
    eligible,
    STATS_BAR_TEXTURE_CONFIG.globalClusterMinCoverage
  );
  return {
    mean,
    secondary,
    accent: (accentCluster && accentCluster.color) || primary,
    variance: samples.length ? variance / samples.length : 0,
    clusters,
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

function readIngressRows(imageData, sampleCount) {
  const rows = [];
  const columns = STATS_BAR_TEXTURE_CONFIG.bridgeCoverIngress;
  const sourceWidth = Math.min(
    imageData.width,
    STATS_BAR_TEXTURE_CONFIG.bridgeIngressSourceWidth
  );
  for (let index = 0; index < sampleCount; index += 1) {
    const y = sourceYForOutputRow(imageData.height, index, sampleCount);
    const row = [];
    for (let column = 0; column < columns; column += 1) {
      const sourceX = clamp(
        Math.floor(((column + 0.5) * sourceWidth) / columns),
        0,
        imageData.width - 1
      );
      const sample = toLinearSample(
        imageData.data,
        (y * imageData.width + sourceX) * 4
      );
      row.push(
        linearToRgb(sample.alpha ? sample : { r: 0, g: 0, b: 0, alpha: 1 })
      );
    }
    rows.push(row);
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

function buildBridgePixels(fillRows, edgeRows, ingressRows, seed) {
  const width = STATS_BAR_TEXTURE_CONFIG.bridgeWidth;
  const outerWidth = STATS_BAR_TEXTURE_CONFIG.bridgeOuterWidth;
  const ingressWidth = STATS_BAR_TEXTURE_CONFIG.bridgeCoverIngress;
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
    const baseTransitionLength =
      outerWidth - STATS_BAR_TEXTURE_CONFIG.bridgeWobble;
    const transitionLength = clamp(
      baseTransitionLength + wobble,
      outerWidth - STATS_BAR_TEXTURE_CONFIG.bridgeWobble * 2,
      outerWidth
    );
    const transitionStart = outerWidth - transitionLength;
    const fill = fillRows[y];
    const edge = edgeRows[y] || fill;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (x < outerWidth) {
        const progress = smoothstep(
          (x - transitionStart) / Math.max(1, transitionLength - 1)
        );
        data[offset] = Math.round(fill.r + (edge.r - fill.r) * progress);
        data[offset + 1] = Math.round(fill.g + (edge.g - fill.g) * progress);
        data[offset + 2] = Math.round(fill.b + (edge.b - fill.b) * progress);
        data[offset + 3] = 255;
        continue;
      }
      const ingressIndex = Math.min(ingressWidth - 1, x - outerWidth);
      const ingress = (ingressRows[y] && ingressRows[y][ingressIndex]) || edge;
      const ingressProgress = (ingressIndex + 1) / ingressWidth;
      const color = mixLinear(edge, ingress, smoothstep(ingressProgress));
      // The rightmost column is fully transparent. It lets the real cover
      // take over rather than faking a second, interactive cover image.
      const alpha = Math.round(255 * (1 - smoothstep(ingressProgress)));
      data[offset] = Math.round(color.r);
      data[offset + 1] = Math.round(color.g);
      data[offset + 2] = Math.round(color.b);
      data[offset + 3] = alpha;
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
  const palette = analyseStatsBarTexturePalette(imageData);
  const rows = applyLowVarianceCompensation(smoothRows(band.samples), palette);
  const fillRows = rows.map(tuneStatsBarTextureColor);
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
      readIngressRows(imageData, height),
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
