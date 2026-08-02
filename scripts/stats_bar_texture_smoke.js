const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const Jimp = require('jimp');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-stats-texture-')
);

function makeImageData(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const color = colorAt(x, y);
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = color[3] == null ? 255 : color[3];
    }
  }
  return { width, height, data };
}

function rgbAt(pixels, x, y) {
  const offset = (y * pixels.width + x) * 4;
  return Array.from(pixels.data.slice(offset, offset + 3));
}

function luminance(rgb) {
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function channelSpread(rgb) {
  return Math.max(...rgb) - Math.min(...rgb);
}

function isStrongRed(rgb) {
  return rgb[0] >= 96 && rgb[0] - Math.max(rgb[1], rgb[2]) >= 48;
}

function assertHorizontalBands(pixels) {
  const firstColumn = Array.from({ length: pixels.height }, (_, y) =>
    rgbAt(pixels, 0, y)
  );
  for (let y = 0; y < pixels.height; y += 1) {
    const row = Array.from({ length: pixels.width }, (_, x) =>
      rgbAt(pixels, x, y)
    );
    row.slice(1).forEach(value => {
      assert.deepStrictEqual(
        value,
        row[0],
        'every output row is a horizontal colour band'
      );
    });
  }
  for (let x = 1; x < pixels.width; x += 1) {
    const column = Array.from({ length: pixels.height }, (_, y) =>
      rgbAt(pixels, x, y)
    );
    assert.deepStrictEqual(
      column,
      firstColumn,
      'all output columns keep the same vertical colour sequence'
    );
  }
  return firstColumn;
}

function ticks(count) {
  let promise = Promise.resolve();
  for (let index = 0; index < count; index += 1) {
    promise = promise.then(() => new Promise(resolve => setImmediate(resolve)));
  }
  return promise;
}

async function drainIdle(scheduler, idle) {
  for (let round = 0; round < 80; round += 1) {
    while (idle.length) {
      const task = idle.shift();
      if (!task.canceled) task.callback();
    }
    await ticks(2);
    if (
      !idle.length &&
      scheduler.stats().queued === 0 &&
      scheduler.stats().active === 0
    ) {
      return;
    }
  }
  throw new Error('idle scheduler did not drain');
}

async function main() {
  try {
    const output = path.join(tempDir, 'stats-bar-texture.cjs');
    await esbuild.build({
      entryPoints: [path.join(root, 'src/utils/podcast/statsBarTexture.js')],
      outfile: output,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
      plugins: [
        {
          name: 'stats-bar-texture-test-stubs',
          setup(build) {
            build.onResolve(
              { filter: /^@\/utils\/podcast\/coverCache$/ },
              () => ({ path: 'coverCache', namespace: 'stats-test' })
            );
            build.onResolve(
              { filter: /^@\/utils\/podcast\/coverHalo$/ },
              () => ({ path: 'coverHalo', namespace: 'stats-test' })
            );
            build.onLoad(
              { filter: /^coverCache$/, namespace: 'stats-test' },
              () => ({
                contents:
                  'export const getCachedCover = () => Promise.resolve(null); export const peekCachedCover = () => null;',
                loader: 'js',
              })
            );
            build.onLoad(
              { filter: /^coverHalo$/, namespace: 'stats-test' },
              () => ({
                contents: 'export const peekTinyCover = () => null;',
                loader: 'js',
              })
            );
          },
        },
      ],
    });
    const texture = require(output);
    assert.strictEqual(texture.STATS_BAR_TEXTURE_CONFIG.bridgeOuterWidth, 24);
    assert.strictEqual(texture.STATS_BAR_TEXTURE_CONFIG.bridgeCoverIngress, 8);
    assert.strictEqual(texture.STATS_BAR_TEXTURE_CONFIG.bridgeWidth, 32);
    [
      { nyancatStyle: false, statsBarCoverTexture: false, expected: false },
      { nyancatStyle: true, statsBarCoverTexture: false, expected: false },
      { nyancatStyle: false, statsBarCoverTexture: true, expected: true },
      { nyancatStyle: true, statsBarCoverTexture: true, expected: true },
    ].forEach(state => {
      assert.strictEqual(
        texture.shouldPrepareStatsBarTextures(state.statsBarCoverTexture, true),
        state.expected,
        'texture work follows only statsBarCoverTexture, not nyancatStyle'
      );
    });
    assert.strictEqual(
      texture.shouldPrepareStatsBarTextures(true, false),
      false,
      'inactive pages schedule zero texture work'
    );
    assert.strictEqual(texture.shouldPrepareStatsBarTextures(true, true), true);

    assert.strictEqual(texture.srgbByteToLinear(0), 0);
    assert.strictEqual(texture.linearToSrgbByte(1), 255);
    assert.ok(
      Math.abs(texture.linearToSrgbByte(texture.srgbByteToLinear(128)) - 128) <=
        1,
      'linear RGB conversion remains round-trip stable'
    );

    const fixture = makeImageData(64, 64, (x, y) => {
      if (y < 21) return [228, 48, 72];
      if (y < 42) return [236, 184, 38];
      return [44, 116, 220];
    });
    const orderedBand = texture.selectStatsBarTextureBand(fixture, 64);
    assert.ok(
      orderedBand.samples[0].r > orderedBand.samples[0].b &&
        orderedBand.samples[orderedBand.samples.length - 1].b >
          orderedBand.samples[orderedBand.samples.length - 1].r,
      'vertical samples keep source Y order'
    );

    const first = texture.buildStatsBarTexturePixels(fixture, {
      seed: 'bands',
    });
    const second = texture.buildStatsBarTexturePixels(fixture, {
      seed: 'bands',
    });
    assert.deepStrictEqual(
      Array.from(first.data),
      Array.from(second.data),
      'fixed pixels produce stable texture bytes'
    );
    assert.deepStrictEqual(
      Array.from(first.bridge.data),
      Array.from(second.bridge.data),
      'bridge pixels are deterministic for the same stable seed'
    );
    assert.ok(first.width >= 2 && first.width <= 4);
    assert.ok(first.height >= 40 && first.height <= 64);
    assert.strictEqual(
      first.bridge.width,
      texture.STATS_BAR_TEXTURE_CONFIG.bridgeWidth,
      'bridge width follows the versioned texture configuration'
    );
    assert.ok(first.bridge.height >= 40 && first.bridge.height <= 64);
    for (let index = 3; index < first.data.length; index += 4) {
      assert.strictEqual(first.data[index], 255, 'texture output is opaque');
    }
    // Direction contract: output(x, y) = coverSample(y). A source Y sample
    // must fill a whole output row, never become a left-to-right colour column.
    const firstColumn = assertHorizontalBands(first);
    assert.notDeepStrictEqual(
      firstColumn[0],
      firstColumn[firstColumn.length - 1],
      'different Y rows preserve cover colour variation'
    );
    assert.ok(
      firstColumn[0][0] > firstColumn[0][1] &&
        firstColumn[0][0] > firstColumn[0][2],
      'top fixture samples become red horizontal bands'
    );
    const middle = firstColumn[Math.floor(firstColumn.length / 2)];
    assert.ok(
      middle[0] > 150 && middle[1] > 100 && middle[2] < 100,
      'middle fixture samples become yellow horizontal bands'
    );
    const bottom = firstColumn[firstColumn.length - 1];
    assert.ok(
      bottom[2] > bottom[0] && bottom[2] > bottom[1],
      'bottom fixture samples become blue horizontal bands'
    );

    const leftEdgeSameA = makeImageData(64, 64, (x, y) => {
      if (x < 5) return [36, 36, 36];
      return y < 32 ? [218, 70, 56] : [54, 136, 216];
    });
    const leftEdgeSameB = makeImageData(64, 64, (x, y) => {
      if (x < 5) return [36, 36, 36];
      return y < 32 ? [68, 180, 98] : [214, 176, 54];
    });
    const textureA = texture.buildStatsBarTexturePixels(leftEdgeSameA, {
      seed: 'same-edge-a',
    });
    const textureB = texture.buildStatsBarTexturePixels(leftEdgeSameB, {
      seed: 'same-edge-b',
    });
    assert.notDeepStrictEqual(
      Array.from(textureA.data),
      Array.from(textureB.data),
      'identical left edges with different interiors produce different fill textures'
    );

    const darkLogo = makeImageData(64, 64, (x, y) => {
      if (x >= 22 && x <= 42 && y >= 22 && y <= 42) return [232, 64, 48];
      return [5, 5, 5];
    });
    const darkLogoTexture = texture.buildStatsBarTexturePixels(darkLogo, {
      seed: 'dark-logo',
    });
    const darkLogoPeak = Math.max(
      ...Array.from({ length: darkLogoTexture.height }, (_, y) =>
        luminance(rgbAt(darkLogoTexture, 0, y))
      )
    );
    assert.ok(
      darkLogoPeak > 80,
      'a bright logo keeps influence instead of collapsing the texture to black'
    );

    const nearBlackNoise = makeImageData(64, 64, (x, y) => {
      if (x >= 18 && x < 46 && y >= 22 && y < 42) return [190, 190, 190];
      return [4, 0, 0];
    });
    const nearBlackNoiseTexture = texture.buildStatsBarTexturePixels(
      nearBlackNoise,
      { seed: 'near-black-red-noise' }
    );
    const nearBlackDiagnostics =
      texture.inspectStatsBarTextureImage(nearBlackNoise);
    assert.strictEqual(
      nearBlackDiagnostics.chromaticPixelCount,
      0,
      'near-black red-channel noise is classified as neutral by absolute OKLCH chroma'
    );
    Array.from({ length: nearBlackNoiseTexture.height }, (_, y) =>
      rgbAt(nearBlackNoiseTexture, 0, y)
    ).forEach(rgb => {
      assert.ok(
        !isStrongRed(rgb) && channelSpread(rgb) <= 3,
        'lightness lifting near-black JPEG noise remains neutral instead of creating red bands'
      );
    });
    const nearBlackLch = texture.linearRgbToOklch({
      r: texture.srgbByteToLinear(4),
      g: texture.srgbByteToLinear(0),
      b: texture.srgbByteToLinear(0),
    });
    assert.ok(
      nearBlackLch.C < texture.STATS_BAR_TEXTURE_CONFIG.neutralChromaThreshold,
      'RGB(4, 0, 0) is neutral under the same perceptual threshold used by rows and clusters'
    );
    assert.ok(
      channelSpread(
        Object.values(
          texture.tuneStatsBarTextureColor({
            r: texture.srgbByteToLinear(4),
            g: texture.srgbByteToLinear(0),
            b: texture.srgbByteToLinear(0),
          })
        )
      ) <= 2,
      'the readable-lightness path cannot re-saturate neutral near-black noise'
    );

    const darkWithOneRedPixel = makeImageData(64, 64, (x, y) => {
      if (x === 31 && y === 31) return [232, 36, 44];
      return [36, 36, 36];
    });
    const darkWithoutRedPixel = makeImageData(64, 64, () => [36, 36, 36]);
    const oneRedTexture = texture.buildStatsBarTexturePixels(
      darkWithOneRedPixel,
      { seed: 'one-red-pixel' }
    );
    const noRedTexture = texture.buildStatsBarTexturePixels(
      darkWithoutRedPixel,
      { seed: 'no-red-pixel' }
    );
    const oneRedDelta = Math.max(
      ...Array.from(oneRedTexture.data, (value, index) =>
        Math.abs(value - noRedTexture.data[index])
      )
    );
    assert.ok(
      oneRedDelta <= 8,
      'one red outlier pixel cannot paint a visible red band'
    );

    const thinRedLine = makeImageData(64, 64, (x, y) => {
      if (x < 2) return [232, 36, 44];
      return y < 32 ? [72, 72, 72] : [88, 88, 88];
    });
    const thinRedTexture = texture.buildStatsBarTexturePixels(thinRedLine, {
      seed: 'thin-red-line',
    });
    Array.from({ length: thinRedTexture.height }, (_, y) =>
      rgbAt(thinRedTexture, 0, y)
    ).forEach(rgb => {
      assert.ok(
        rgb[0] - Math.max(rgb[1], rgb[2]) < 48,
        'a one-to-two pixel red edge cannot become a whole-row accent'
      );
    });

    const redLogo = makeImageData(64, 64, (x, y) => {
      if (x >= 18 && x < 46 && y >= 20 && y < 44) return [224, 42, 46];
      return [44, 44, 44];
    });
    const redLogoTexture = texture.buildStatsBarTexturePixels(redLogo, {
      seed: 'red-logo',
    });
    const redLogoBand = rgbAt(
      redLogoTexture,
      0,
      Math.floor(redLogoTexture.height / 2)
    );
    assert.ok(
      redLogoBand[0] > redLogoBand[1] + 36 &&
        redLogoBand[0] > redLogoBand[2] + 36,
      'a red logo with meaningful row coverage still affects its band'
    );

    const accentBase = {
      isNeutral: false,
      chroma: 0.18,
      perceptualLightness: 0.45,
    };
    const accentLow = texture.statsBarTextureAccentMix(
      Object.assign({ coverage: 0.05 }, accentBase)
    );
    const accentMid = texture.statsBarTextureAccentMix(
      Object.assign({ coverage: 0.14 }, accentBase)
    );
    const accentHigh = texture.statsBarTextureAccentMix(
      Object.assign({ coverage: 0.28 }, accentBase)
    );
    assert.ok(
      accentLow > 0 && accentLow < accentMid && accentMid < accentHigh,
      'accent mixing increases continuously with cluster coverage'
    );

    const outlierPalette =
      texture.analyseStatsBarTexturePalette(darkWithOneRedPixel);
    const plainPalette =
      texture.analyseStatsBarTexturePalette(darkWithoutRedPixel);
    const outlierAccent = [
      texture.linearToSrgbByte(outlierPalette.accent.r),
      texture.linearToSrgbByte(outlierPalette.accent.g),
      texture.linearToSrgbByte(outlierPalette.accent.b),
    ];
    const plainAccent = [
      texture.linearToSrgbByte(plainPalette.accent.r),
      texture.linearToSrgbByte(plainPalette.accent.g),
      texture.linearToSrgbByte(plainPalette.accent.b),
    ];
    assert.ok(
      Math.max(
        ...outlierAccent.map((value, index) =>
          Math.abs(value - plainAccent[index])
        )
      ) <= 4,
      'global palette accent cannot be selected from one outlier pixel'
    );

    const edgeNeutralInteriorColor = makeImageData(64, 64, (x, y) => {
      if (x < 6) return [64, 64, 64];
      if (y < 21) return [220, 65, 58];
      if (y < 43) return [236, 184, 42];
      return [50, 120, 220];
    });
    const interiorTexture = texture.buildStatsBarTexturePixels(
      edgeNeutralInteriorColor,
      { seed: 'interior-colour' }
    );
    const interiorBands = assertHorizontalBands(interiorTexture);
    assert.notDeepStrictEqual(
      interiorBands[0],
      interiorBands[interiorBands.length - 1],
      'pure edge pixels do not erase interior colour variation'
    );

    const monochrome = makeImageData(64, 64, () => [88, 88, 88]);
    const monochromeTexture = texture.buildStatsBarTexturePixels(monochrome, {
      seed: 'monochrome',
    });
    Array.from({ length: monochromeTexture.height }, (_, y) =>
      rgbAt(monochromeTexture, 0, y)
    ).forEach(rgb => {
      assert.ok(
        Math.abs(rgb[0] - rgb[1]) <= 2 && Math.abs(rgb[1] - rgb[2]) <= 2,
        'a monochrome cover does not invent unrelated colours'
      );
    });

    const grayscaleSteps = makeImageData(64, 64, (x, y) => {
      if (y < 21) return [5, 5, 5];
      if (y < 43) return [116, 116, 116];
      return [238, 238, 238];
    });
    const grayscaleTexture = texture.buildStatsBarTexturePixels(
      grayscaleSteps,
      { seed: 'grayscale-steps' }
    );
    Array.from({ length: grayscaleTexture.height }, (_, y) =>
      rgbAt(grayscaleTexture, 0, y)
    ).forEach(rgb => {
      assert.ok(
        channelSpread(rgb) <= 2,
        'black, white, and grey rows remain low-chroma after perceptual lightness correction'
      );
    });

    const vividBlue = makeImageData(64, 64, () => [36, 100, 228]);
    const vividTexture = texture.buildStatsBarTexturePixels(vividBlue, {
      seed: 'vivid-blue',
    });
    const vividRgb = rgbAt(
      vividTexture,
      0,
      Math.floor(vividTexture.height / 2)
    );
    assert.ok(
      vividRgb[2] > vividRgb[0] && vividRgb[2] > vividRgb[1],
      'a normally vivid cover keeps its primary hue'
    );

    for (let y = 0; y < textureA.height; y += 1) {
      assert.deepStrictEqual(
        rgbAt(textureA.bridge, 0, y),
        rgbAt(textureA, 0, y),
        'bridge left edge matches the fill band'
      );
      assert.deepStrictEqual(
        rgbAt(
          textureA.bridge,
          texture.STATS_BAR_TEXTURE_CONFIG.bridgeOuterWidth - 1,
          y
        ),
        [36, 36, 36],
        'opaque bridge edge reaches the cover left edge colour'
      );
      const alpha = Array.from(
        { length: texture.STATS_BAR_TEXTURE_CONFIG.bridgeCoverIngress },
        (_, index) =>
          textureA.bridge.data[
            (y * textureA.bridge.width +
              texture.STATS_BAR_TEXTURE_CONFIG.bridgeOuterWidth +
              index) *
              4 +
              3
          ]
      );
      assert.strictEqual(
        alpha[alpha.length - 1],
        0,
        'bridge fully reveals the real cover at its final ingress column'
      );
      alpha.slice(1).forEach((value, index) => {
        assert.ok(
          value <= alpha[index] && alpha[index] - value < 64,
          'cover ingress alpha fades down smoothly without a hard seam'
        );
      });
      for (
        let x = 0;
        x < texture.STATS_BAR_TEXTURE_CONFIG.bridgeOuterWidth;
        x += 1
      ) {
        assert.strictEqual(
          textureA.bridge.data[(y * textureA.bridge.width + x) * 4 + 3],
          255,
          'the bridge stays opaque before it crosses into the cover'
        );
      }
    }
    assert.deepStrictEqual(
      Array.from(first.data),
      Array.from(
        texture.buildStatsBarTexturePixels(fixture, { seed: 'bands' }).data
      ),
      'bar width changes stretch this fixed texture instead of regenerating it'
    );
    let written;
    let canvasCount = 0;
    const canvasFactory = (width, height) => ({
      getContext() {
        return {
          createImageData() {
            return { data: new Uint8ClampedArray(width * height * 4) };
          },
          putImageData(value) {
            written = value;
          },
        };
      },
      toDataURL(type) {
        assert.strictEqual(type, 'image/png');
        canvasCount += 1;
        return 'data:image/png;base64,fixture-' + canvasCount;
      },
    });
    const textureValue = texture.statsBarTextureValueFromPixels(
      first,
      canvasFactory
    );
    assert.ok(
      texture.isStatsBarTextureValue(textureValue),
      'V5 cache values require both fill and bridge PNG data URLs'
    );
    assert.ok(textureValue.fillUrl.indexOf('data:image/png') === 0);
    assert.ok(textureValue.bridgeUrl.indexOf('data:image/png') === 0);
    assert.strictEqual(written.data[3], 255);
    assert.strictEqual(
      texture.isStatsBarTextureValue('data:image/png;base64,legacy'),
      false,
      'legacy one-URL cache entries cannot hit V5'
    );
    assert.strictEqual(
      texture.isStatsBarTextureValue({
        version: 4,
        fillUrl: textureValue.fillUrl,
        bridgeUrl: textureValue.bridgeUrl,
      }),
      false,
      'V4 two-texture entries cannot bypass the V5 cache contract'
    );
    assert.ok(
      texture
        .statsBarTextureCacheKey('https://cover.example/a.png')
        .includes(':v5:'),
      'cache key is versioned with the V5 texture contract'
    );

    const idle = [];
    const scheduled = {
      requestIdle(callback) {
        const handle = { callback, canceled: false };
        idle.push(handle);
        return handle;
      },
      cancelIdle(handle) {
        handle.canceled = true;
      },
    };
    let renders = 0;
    const scheduler = texture.createStatsBarTextureScheduler({
      cacheMax: 2,
      concurrency: 2,
      queueMax: 3,
      scheduler: scheduled,
      sourceFor: async url => ({ url }),
      render: source => {
        renders += 1;
        return 'data:image/png;base64,' + source.url;
      },
    });
    const duplicateA = scheduler.request('cover-a');
    const duplicateB = scheduler.request('cover-a');
    assert.strictEqual(
      duplicateA,
      duplicateB,
      'pending URLs are de-duplicated'
    );
    await drainIdle(scheduler, idle);
    assert.strictEqual(await duplicateA, 'data:image/png;base64,cover-a');
    assert.strictEqual(renders, 1, 'one URL creates one texture job');

    const stale = scheduler.request('stale', { isValid: () => false });
    await drainIdle(scheduler, idle);
    assert.strictEqual(await stale, null, 'stale idle jobs become no-ops');
    assert.strictEqual(renders, 1, 'stale work never reaches canvas rendering');

    const pendingCancel = scheduler.request('cancel-me', {
      options: { token: 99 },
    });
    scheduler.cancelWhere(task => task.options && task.options.token === 99);
    assert.strictEqual(
      await pendingCancel,
      null,
      'queued cancellation releases the task'
    );

    const b = scheduler.request('cover-b');
    const c = scheduler.request('cover-c');
    await drainIdle(scheduler, idle);
    await Promise.all([b, c]);
    assert.strictEqual(
      scheduler.peek('cover-a'),
      null,
      'LRU evicts the oldest texture'
    );
    assert.ok(scheduler.peek('cover-b'));
    assert.ok(scheduler.peek('cover-c'));

    const coldIdle = [];
    const coldScheduled = {
      requestIdle(callback) {
        const handle = { callback, canceled: false };
        coldIdle.push(handle);
        return handle;
      },
      cancelIdle(handle) {
        handle.canceled = true;
      },
    };
    let coldGenerations = 0;
    let maxConcurrent = 0;
    const coldScheduler = texture.createStatsBarTextureScheduler({
      concurrency: 2,
      cacheMax: 128,
      scheduler: coldScheduled,
      sourceFor: async url => ({ url }),
      render: source => {
        coldGenerations += 1;
        maxConcurrent = Math.max(maxConcurrent, coldScheduler.stats().active);
        return 'data:image/png;base64,cold-' + source.url;
      },
    });
    const coldUrls = Array.from({ length: 20 }, (_, index) => 'cold-' + index);
    const coldStarted = performance.now();
    const coldResults = coldUrls.map(url => coldScheduler.request(url));
    await drainIdle(coldScheduler, coldIdle);
    await Promise.all(coldResults);
    const coldMetrics = {
      uniqueCoverCount: coldUrls.length,
      generationCount: coldGenerations,
      cacheHits: 0,
      totalPrepMs: Number((performance.now() - coldStarted).toFixed(2)),
      maxConcurrent,
    };
    assert.strictEqual(coldMetrics.generationCount, 20);
    assert.ok(
      coldMetrics.maxConcurrent <= 2,
      'texture jobs stay within the two-job pool'
    );

    const hotStarted = performance.now();
    const hotResults = await Promise.all(
      coldUrls.map(url => coldScheduler.request(url))
    );
    const hotMetrics = {
      uniqueCoverCount: coldUrls.length,
      generationCount: coldGenerations,
      cacheHits: hotResults.filter(Boolean).length,
      totalPrepMs: Number((performance.now() - hotStarted).toFixed(2)),
    };
    assert.strictEqual(
      coldGenerations,
      20,
      'hot texture cache avoids a second canvas generation batch'
    );
    assert.strictEqual(
      hotMetrics.cacheHits,
      20,
      'all 20 hot textures are cache hits'
    );

    const fallbackScheduler = texture.createStatsBarTextureScheduler({
      scheduler: scheduled,
      sourceFor: async () => null,
      render: () => {
        throw new Error('fallback must not render');
      },
    });
    const fallback = fallbackScheduler.request('no-source');
    await drainIdle(fallbackScheduler, idle);
    assert.strictEqual(
      await fallback,
      null,
      'missing source keeps the solid fallback'
    );

    const results = Array.from({ length: 20 }, (_, index) => ({
      item: { podcastId: 'pod-' + index, coverUrl: 'cover-' + index },
      value: 'data:image/png;base64,' + index,
    }));
    const batch = texture.collectStatsBarTextureResults(results, () => true);
    assert.strictEqual(
      Object.keys(batch).length,
      20,
      'a visible batch is collected before one Vue publish'
    );
    assert.strictEqual(
      Object.keys(texture.collectStatsBarTextureResults(results, () => false))
        .length,
      0,
      'stale batch entries are discarded before publication'
    );

    const profileMetrics = {};
    ['soft', 'balanced', 'fine'].forEach(profile => {
      const started = performance.now();
      let slowest = 0;
      for (let index = 0; index < 20; index += 1) {
        const oneStarted = performance.now();
        texture.buildStatsBarTexturePixels(fixture, { profile });
        slowest = Math.max(slowest, performance.now() - oneStarted);
      }
      profileMetrics[profile] = {
        totalMs: Number((performance.now() - started).toFixed(2)),
        slowestMs: Number(slowest.toFixed(2)),
      };
    });
    assert.ok(
      profileMetrics.balanced.slowestMs < 50,
      'balanced pixel math stays below a 50ms task'
    );

    const statsSource = fs.readFileSync(
      path.join(root, 'src/views/statsPage.vue'),
      'utf8'
    );
    assert.ok(statsSource.includes('Promise.all(requests)'));
    assert.ok(
      statsSource.includes(
        'this.publishStatsTextures(generation, entries, false)'
      )
    );
    assert.ok(statsSource.includes('shouldPrepareStatsBarTextures('));
    assert.ok(statsSource.includes('@load="onStatsCoverLoad(item, $event)"'));
    assert.ok(statsSource.includes('isStatsBarTextureValue('));
    assert.ok(statsSource.includes('bar-texture-fill'));
    assert.ok(statsSource.includes('class="stats-texture-endcap"'));
    assert.ok(statsSource.includes('class="stats-texture-bridge"'));
    assert.ok(!statsSource.includes('bar-texture-bridge-external'));
    assert.ok(!statsSource.includes('bar-texture-ingress'));
    assert.ok(!statsSource.includes('class="thumb-shell"'));
    assert.ok(!statsSource.includes('bar-texture-bridge-overlay'));
    assert.ok(
      statsSource.includes('width: 64px;') &&
        statsSource.includes('width: 40px;') &&
        statsSource.includes('width: var(--stats-texture-bridge-width);'),
      'one endcap contains the 24px outer bridge and 40px cover with an 8px overlap'
    );
    assert.ok(
      statsSource.includes('.stats-texture-endcap') &&
        statsSource.includes('.stats-texture-bridge') &&
        statsSource.includes('pointer-events: none') &&
        statsSource.includes('pointer-events: auto'),
      'the bridge cannot receive pointer input while the real cover remains interactive'
    );
    assert.ok(
      statsSource.indexOf('class="stats-texture-endcap"') <
        statsSource.indexOf('class="stats-texture-bridge"'),
      'the bridge and PodImage share the one endcap clipping context'
    );
    const endcapStyle = statsSource.slice(
      statsSource.indexOf('.stats-texture-endcap {'),
      statsSource.indexOf('.label {')
    );
    assert.ok(
      endcapStyle.includes('border-radius: var(--radius-cover-sm);') &&
        endcapStyle.includes('overflow: hidden;'),
      'the endcap is the sole local radius and clipping owner for bridge plus cover'
    );
    assert.ok(
      endcapStyle.includes('right: 0;') &&
        endcapStyle.includes('left: 0;') &&
        endcapStyle.includes('z-index: 1'),
      'the bridge starts at the endcap edge and overlays exactly the first 8px of the cover'
    );
    assert.strictEqual(
      (statsSource.match(/:style="barTextureBridgeStyle\(item\)"/g) || [])
        .length,
      1,
      'the composite endcap uses one bridge layer rather than a stitched pair'
    );
    assert.ok(
      (statsSource.match(/barTexture\(item\)\.ready/g) || []).length >= 2,
      'fill and composite bridge share one ready flag'
    );
    assert.ok(
      !statsSource.includes('draggable="false"') &&
        !statsSource.includes('-webkit-user-drag: none'),
      'the real cover keeps native drag behaviour'
    );
    assert.ok(statsSource.includes('transition: opacity 130ms'));
    assert.ok(statsSource.includes('transition-duration: 0ms'));
    assert.ok(
      statsSource.includes('statsBarCoverTexture()') &&
        !statsSource.includes('nyancatStyle'),
      'stats page no longer reads nyancatStyle to schedule texture work'
    );
    const prepareSource = statsSource.slice(
      statsSource.indexOf('prepareStatsTextures(rows) {'),
      statsSource.indexOf('onStatsCoverLoad(item, event) {')
    );
    assert.ok(
      prepareSource.indexOf('cancelStatsBarTextureRequests') <
        prepareSource.indexOf('shouldPrepareStatsBarTextures(') &&
        prepareSource.includes(
          'cancelAnimationFrame(this._statsTexturePublishFrame)'
        ) &&
        prepareSource.includes('this._pendingStatsTextures = null;') &&
        prepareSource.includes('this.barTextures = {};'),
      'disabling the texture invalidates pending work before clearing reactive texture state'
    );
    const settingsSource = fs.readFileSync(
      path.join(root, 'src/views/settings.vue'),
      'utf8'
    );
    const defaultsSource = fs.readFileSync(
      path.join(root, 'src/store/initLocalStorage.js'),
      'utf8'
    );
    assert.ok(
      settingsSource.includes('v-model="statsBarCoverTexture"') &&
        settingsSource.includes("key: 'statsBarCoverTexture'") &&
        defaultsSource.includes('statsBarCoverTexture: false'),
      'the independent texture switch persists as a false-by-default settings key'
    );

    let localDiagnostic = null;
    const diagnosticCoverPath = process.env.PODPLAYER_STATS_DIAGNOSTIC_COVER;
    if (diagnosticCoverPath) {
      assert.ok(
        fs.existsSync(diagnosticCoverPath),
        'the requested local diagnostic cover must exist when its path is supplied'
      );
      const cover = await Jimp.read(diagnosticCoverPath);
      const sourceWidth = cover.bitmap.width;
      const sourceHeight = cover.bitmap.height;
      let maxRedAdvantage = -Infinity;
      let nearBlackRedNoiseCount = 0;
      for (let offset = 0; offset < cover.bitmap.data.length; offset += 4) {
        const r = cover.bitmap.data[offset];
        const g = cover.bitmap.data[offset + 1];
        const b = cover.bitmap.data[offset + 2];
        maxRedAdvantage = Math.max(maxRedAdvantage, r - Math.max(g, b));
        if (r <= 8 && g <= 8 && b <= 8 && r > g && r >= b) {
          nearBlackRedNoiseCount += 1;
        }
      }
      cover.resize(64, 64);
      const imageData = {
        width: cover.bitmap.width,
        height: cover.bitmap.height,
        data: cover.bitmap.data,
      };
      const sourceDiagnostics = texture.inspectStatsBarTextureImage(imageData);
      const coverTexture = texture.buildStatsBarTexturePixels(imageData, {
        seed: 'local-cover-diagnostic',
      });
      const nearBlackLch = texture.linearRgbToOklch({
        r: texture.srgbByteToLinear(4),
        g: texture.srgbByteToLinear(0),
        b: texture.srgbByteToLinear(0),
      });
      const tunedNearBlack = texture.tuneStatsBarTextureColor({
        r: texture.srgbByteToLinear(4),
        g: texture.srgbByteToLinear(0),
        b: texture.srgbByteToLinear(0),
      });
      const strongRedRows = Array.from(
        { length: coverTexture.height },
        (_, y) => rgbAt(coverTexture, 0, y)
      ).filter(isStrongRed).length;
      const sampleRows = [0, 16, 32, 48, 63].map(y => ({
        y,
        rgb: rgbAt(coverTexture, 0, y),
      }));
      assert.strictEqual(
        strongRedRows,
        0,
        'the local diagnostic cover cannot produce strong red output rows from near-black noise'
      );
      localDiagnostic = {
        source: {
          width: sourceWidth,
          height: sourceHeight,
          maxRedAdvantage,
          nearBlackRedNoiseCount,
        },
        sample64: sourceDiagnostics,
        keyStages: {
          nearBlackRgb: [4, 0, 0],
          nearBlackOklch: {
            L: Number(nearBlackLch.L.toFixed(5)),
            C: Number(nearBlackLch.C.toFixed(5)),
          },
          tunedNearBlack: [
            tunedNearBlack.r,
            tunedNearBlack.g,
            tunedNearBlack.b,
          ],
        },
        v5: { strongRedRows, sampleRows },
      };
    }

    process.stdout.write(
      'stats bar texture smoke: PASS ' +
        JSON.stringify({
          profiles: profileMetrics,
          cold: coldMetrics,
          hot: hotMetrics,
          localDiagnostic,
        }) +
        '\n'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
