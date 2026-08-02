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

    const grow = animation.withStatsBarMotion({ podcastId: 'grow' }, 12, 48, {
      oldIndex: 1,
      newIndex: 4,
    });
    const shrink = animation.withStatsBarMotion(
      { podcastId: 'shrink' },
      48,
      12,
      { oldIndex: 4, newIndex: 1 }
    );
    assert.strictEqual(grow._w, 12);
    assert.strictEqual(grow._target, 48);
    assert.strictEqual(shrink._w, 48);
    assert.strictEqual(shrink._target, 12);
    assert.strictEqual(grow.barDuration, shrink.barDuration);
    assert.strictEqual(grow.moveRows, 3);
    assert.strictEqual(shrink.moveRows, 3);
    assert.strictEqual(grow.moveDuration, shrink.moveDuration);
    assert.strictEqual(
      grow.motionDuration,
      Math.max(grow.barDuration, grow.moveDuration)
    );

    assert.strictEqual(animation.statMoveRows(4, 4), 0);
    assert.strictEqual(animation.statMoveRows(4, 5), 1);
    assert.strictEqual(animation.statMoveRows(4, 8), 4);
    assert.strictEqual(animation.statMoveDurationMs(4, 4), 300);
    assert.strictEqual(animation.statMoveDurationMs(4, 5), 300);
    assert.ok(
      animation.statMoveDurationMs(4, 8) > animation.statMoveDurationMs(4, 5),
      'moving across more rows must take longer without a linear runaway'
    );
    assert.strictEqual(animation.statMoveDurationMs(0, 1000), 650);

    const cleanupDelay = animation.statsBarCleanupDelayMs([
      { barDuration: 280, moveDuration: 300, motionDuration: 300 },
      { barDuration: 455, moveDuration: 520, motionDuration: 520 },
      { barDuration: 320, moveDuration: 650, motionDuration: 650 },
    ]);
    assert.strictEqual(
      cleanupDelay,
      650 + 96,
      'ghost cleanup must wait for the actual longest bar or FLIP motion'
    );
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
      source.includes("'--stat-bar-duration': item.barDuration + 'ms'")
    );
    assert.ok(
      source.includes("'--stat-move-duration': item.moveDuration + 'ms'")
    );
    assert.ok(source.includes('statsBarCleanupDelayMs(ghosts)'));
    assert.ok(
      source.includes('oldIndex: p ? previous.oldIndex : newIndex'),
      'retained rows must derive FLIP distance from the prior and next ranks'
    );
    assert.ok(
      source.includes('newIndex: next.length + ghostIndex'),
      'leaving rows must include their actual final row position in motion timing'
    );
    assert.ok(
      source.includes('this.$nextTick(removeGhosts)'),
      'reduced motion must clean ghosts on the next tick'
    );
    assert.ok(
      source.includes('.stat-move,\n.stat-enter-active,\n.stat-row'),
      'FLIP, enter, and row transforms must have one shared transition source'
    );
    assert.ok(source.includes('cubic-bezier(0.16, 1, 0.3, 1)'));
    assert.ok(!source.includes('720 * (this.animK || 1)'));
    assert.ok(!source.includes('calc(0.65s * var(--stat-k, 1))'));
    assert.ok(!source.includes('calc(0.5s * var(--stat-k, 1))'));
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
