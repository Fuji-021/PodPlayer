const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
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
    assert.strictEqual(
      texture.shouldPrepareStatsBarTextures(false, true),
      false,
      'nyancat off schedules zero texture work'
    );
    assert.strictEqual(
      texture.shouldPrepareStatsBarTextures(true, false),
      false,
      'inactive pages schedule zero texture work'
    );
    assert.strictEqual(texture.shouldPrepareStatsBarTextures(true, true), true);

    const fixture = makeImageData(96, 80, (x, y) => {
      if (y > 34 && y < 46) {
        return x % 2 ? [230, 48, 72] : [32, 182, 214];
      }
      return [96, 96, 96];
    });
    const band = texture.selectStatsBarTextureBand(fixture, 128);
    assert.strictEqual(
      band.index,
      2,
      'the highest-information middle band wins'
    );

    const ordered = makeImageData(16, 32, x => [x * 14, 80, 150]);
    const orderedBand = texture.selectStatsBarTextureBand(ordered, 16);
    orderedBand.samples.forEach((sample, index) => {
      if (index) {
        assert.ok(
          sample.r >= orderedBand.samples[index - 1].r,
          'horizontal samples keep source X order'
        );
      }
    });

    const first = texture.buildStatsBarTexturePixels(fixture);
    const second = texture.buildStatsBarTexturePixels(fixture);
    assert.deepStrictEqual(
      Array.from(first.data),
      Array.from(second.data),
      'fixed pixels produce stable texture bytes'
    );
    assert.strictEqual(first.width, 128);
    assert.strictEqual(first.height, 4);
    for (let index = 3; index < first.data.length; index += 4) {
      assert.strictEqual(first.data[index], 255, 'texture output is opaque');
    }
    let written;
    const dataUrl = texture.statsBarTextureDataUrl(first, (width, height) => ({
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
        return 'data:image/png;base64,fixture';
      },
    }));
    assert.ok(
      dataUrl.indexOf('data:image/png') === 0,
      'texture uses PNG data URL'
    );
    assert.strictEqual(written.data[3], 255);

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
    assert.ok(statsSource.includes('transition: opacity 130ms'));
    assert.ok(statsSource.includes('transition-duration: 0ms'));

    process.stdout.write(
      'stats bar texture smoke: PASS ' +
        JSON.stringify({
          profiles: profileMetrics,
          cold: coldMetrics,
          hot: hotMetrics,
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
