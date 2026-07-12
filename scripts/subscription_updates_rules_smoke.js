const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-subscription-updates-smoke-')
);

function localTime(year, monthIndex, day, hour = 12) {
  return new Date(year, monthIndex, day, hour, 0, 0, 0).getTime();
}

async function main() {
  try {
    const output = path.join(tempDir, 'rules.cjs');
    await esbuild.build({
      entryPoints: [
        path.join(root, 'src/utils/podcast/subscriptionUpdatesRules.js'),
      ],
      outfile: output,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const rules = require(output);

    const monday = localTime(2025, 0, 6);
    assert.strictEqual(
      rules.getUpdateDateBucket(localTime(2025, 0, 6, 1), monday),
      'today'
    );
    assert.strictEqual(
      rules.getUpdateDateBucket(localTime(2025, 0, 5, 23), monday),
      'yesterday'
    );
    assert.strictEqual(
      rules.getUpdateDateBucket(localTime(2025, 0, 1), monday),
      'last-week'
    );

    const crossMonthNow = localTime(2024, 2, 1);
    assert.strictEqual(
      rules.getUpdateDateBucket(localTime(2024, 1, 29), crossMonthNow),
      'yesterday'
    );
    assert.strictEqual(
      rules.getUpdateDateBucket(localTime(2024, 1, 26), crossMonthNow),
      'this-week'
    );
    assert.strictEqual(
      rules.getUpdateDateBucket(localTime(2024, 1, 25), crossMonthNow),
      'last-week'
    );

    const crossYearNow = localTime(2025, 0, 1);
    assert.strictEqual(
      rules.getUpdateDateBucket(localTime(2024, 11, 31), crossYearNow),
      'yesterday'
    );
    assert.strictEqual(
      rules.getUpdateDateBucket(localTime(2024, 11, 30), crossYearNow),
      'this-week'
    );
    assert.strictEqual(
      rules.getUpdateDateBucket(localTime(2024, 11, 29), crossYearNow),
      'last-week'
    );

    const sorted = rules.sortSubscriptionUpdates([
      { id: 'invalid-a', pubTime: 0, stableOrder: 2 },
      { id: 'same-b', pubTime: 100, stableOrder: 2 },
      { id: 'new', pubTime: 200, stableOrder: 9 },
      { id: 'same-a', pubTime: 100, stableOrder: 1 },
      { id: 'invalid-b', pubTime: '', stableOrder: 3 },
    ]);
    assert.deepStrictEqual(
      sorted.map(item => item.id),
      ['new', 'same-a', 'same-b', 'invalid-a', 'invalid-b']
    );

    const filtered = rules.filterSubscriptionUpdates(
      [
        { id: 'sub-unplayed', podcastId: 'a', completed: false },
        { id: 'sub-playing', podcastId: 'a', completed: false },
        { id: 'sub-done', podcastId: 'a', completed: true },
        {
          id: 'unsubscribed',
          podcastId: 'b',
          completed: false,
          podcastSubscribed: false,
        },
      ],
      { podcastId: 'a', unfinishedOnly: true }
    );
    assert.deepStrictEqual(
      filtered.map(item => item.id),
      ['sub-unplayed', 'sub-playing']
    );

    const ranked = rules.rankSubscriptionRail(
      [
        {
          id: 'older-favorite',
          latestPubTime: localTime(2024, 11, 15),
          listenWallSec: 1000,
          stableOrder: 0,
        },
        {
          id: 'today-low-listen',
          latestPubTime: localTime(2025, 0, 1, 9),
          listenWallSec: 1,
          stableOrder: 3,
        },
        {
          id: 'today-high-listen',
          latestPubTime: localTime(2025, 0, 1, 8),
          listenWallSec: 10,
          stableOrder: 2,
        },
        {
          id: 'no-date',
          latestPubTime: 0,
          listenWallSec: 99,
          stableOrder: 1,
        },
      ],
      crossYearNow
    );
    assert.deepStrictEqual(
      ranked.map(item => item.id),
      ['today-high-listen', 'today-low-listen', 'older-favorite', 'no-date']
    );

    const metrics = rules.getRailMetrics({
      scrollLeft: 40,
      clientWidth: 300,
      scrollWidth: 900,
    });
    assert.deepStrictEqual(metrics, {
      scrollLeft: 40,
      maxScroll: 600,
      visibleRatio: 1 / 3,
      canScroll: true,
      canPrev: true,
      canNext: true,
    });
    assert.strictEqual(
      rules.getRailArrowTarget({
        scrollLeft: 500,
        clientWidth: 300,
        scrollWidth: 900,
        direction: 1,
      }),
      600
    );
    assert.strictEqual(
      rules.getRailArrowTarget({
        scrollLeft: 50,
        clientWidth: 300,
        scrollWidth: 900,
        direction: -1,
      }),
      0
    );
    assert.strictEqual(
      rules.getRailThumbDragTarget({
        startScrollLeft: 100,
        startPointerX: 10,
        pointerX: 110,
        trackWidth: 300,
        thumbWidth: 100,
        maxScroll: 600,
      }),
      400
    );

    process.stdout.write('subscription updates rules smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
