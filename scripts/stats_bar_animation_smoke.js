const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podplayer-stats-bar-'));

async function main() {
  try {
    const output = path.join(tempDir, 'stats-bar-animation.cjs');
    await esbuild.build({
      entryPoints: [path.join(root, 'src/utils/podcast/statsBarAnimation.js')],
      outfile: output,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const animation = require(output);

    assert.strictEqual(animation.statBarDurationMs(20, 20), 280);
    assert.strictEqual(animation.statBarDurationMs(0, 8), 280);
    assert.strictEqual(animation.statBarDurationMs(0, 100), 560);
    assert.strictEqual(
      animation.statBarDurationMs(20, 60),
      animation.statBarDurationMs(60, 20),
      'extend and retract use the same distance-based timing rule'
    );

    const samples = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map(
      animation.sampleStatsBarEaseOut
    );
    assert.strictEqual(samples[0], 0);
    assert.strictEqual(samples[samples.length - 1], 1);
    samples.slice(1).forEach((value, index) => {
      assert.ok(value >= samples[index], 'ease-out samples must be monotonic');
    });
    assert.ok(
      samples[2] - samples[0] > samples[6] - samples[4],
      'the early segment must cover more distance than the final segment'
    );

    const grow = animation.withStatsBarMotion({ podcastId: 'grow' }, 12, 48);
    const shrink = animation.withStatsBarMotion(
      { podcastId: 'shrink' },
      48,
      12
    );
    assert.strictEqual(grow._w, 12);
    assert.strictEqual(grow._target, 48);
    assert.strictEqual(shrink._w, 48);
    assert.strictEqual(shrink._target, 12);
    assert.strictEqual(grow._durationMs, shrink._durationMs);

    const cleanupDelay = animation.statsBarCleanupDelayMs([
      { _durationMs: 280 },
      { _durationMs: 455 },
      { _durationMs: 320 },
    ]);
    assert.strictEqual(cleanupDelay, 455 + 96);
    assert.strictEqual(animation.isCurrentStatsBarAnimation(3, 3), true);
    assert.strictEqual(
      animation.isCurrentStatsBarAnimation(3, 4),
      false,
      'a newer range switch invalidates stale ghost cleanup'
    );

    const source = fs.readFileSync(
      path.join(root, 'src/views/statsPage.vue'),
      'utf8'
    );
    assert.ok(
      source.includes("'--stat-bar-duration': item._durationMs + 'ms'")
    );
    assert.ok(source.includes('statsBarCleanupDelayMs(ghosts)'));
    assert.ok(source.includes('cubic-bezier(0.16, 1, 0.3, 1)'));
    assert.ok(!source.includes('720 * (this.animK || 1)'));
    assert.ok(source.includes('prefers-reduced-motion: reduce'));
    process.stdout.write('stats bar animation smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
