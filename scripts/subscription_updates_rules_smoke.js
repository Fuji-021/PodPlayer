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

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check, message) {
  for (let index = 0; index < 30; index += 1) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
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
    const guardOutput = path.join(tempDir, 'input-guard.cjs');
    await esbuild.build({
      entryPoints: [path.join(root, 'src/utils/mainScrollInputGuard.js')],
      outfile: guardOutput,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const { shouldYieldMainScrollKey } = require(guardOutput);
    const mockDbOutput = path.join(tempDir, 'mock-utils-db.js');
    const mockPodcastDbOutput = path.join(tempDir, 'mock-podcast-db.js');
    fs.writeFileSync(
      mockDbOutput,
      `function rows(name) {
  const source = global.__subscriptionSnapshotSmoke || {};
  return Promise.resolve(source[name] || []);
}
function indexed(name) {
  return { where() { return { anyOf() { return { toArray() { return rows(name); } }; } }; } };
}
export const db = {
  episodes: indexed('episodes'),
  episodeListenStats: { toArray() { return rows('stats'); } },
  episodeProgress: { toArray() { return rows('progresses'); } },
  favorites: indexed('favorites'),
  transcripts: indexed('transcripts'),
  episodeDownloads: indexed('downloads'),
};\n`
    );
    fs.writeFileSync(
      mockPodcastDbOutput,
      'export function getSubscribedPodcasts() { return global.__subscriptionSnapshotSmoke.next(); }\n'
    );
    const snapshotOutput = path.join(tempDir, 'snapshot.cjs');
    await esbuild.build({
      entryPoints: [
        path.join(root, 'src/utils/podcast/subscriptionUpdatesData.js'),
      ],
      outfile: snapshotOutput,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
      plugins: [
        {
          name: 'subscription-updates-db-mock',
          setup(build) {
            build.onResolve({ filter: /^@\/utils\/db$/ }, () => ({
              path: mockDbOutput,
            }));
            build.onResolve({ filter: /^\.\/db$/ }, args => {
              if (args.importer.endsWith('subscriptionUpdatesData.js')) {
                return { path: mockPodcastDbOutput };
              }
              return null;
            });
          },
        },
      ],
    });
    const snapshots = require(snapshotOutput);

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

    const lastMonthNow = localTime(2025, 5, 1);
    assert.strictEqual(
      rules.getUpdateDateBucket(localTime(2025, 4, 2), lastMonthNow),
      'last-month'
    );
    assert.strictEqual(
      rules.getUpdateDateBucket(localTime(2025, 4, 1), lastMonthNow),
      'older'
    );

    // Calendar-day boundaries must not use a fixed 24-hour subtraction. This
    // case runs in the host local timezone and remains valid across DST zones.
    const dstBoundaryNow = localTime(2025, 2, 10, 12);
    assert.strictEqual(
      rules.getUpdateDateBucket(localTime(2025, 2, 9, 0), dstBoundaryNow),
      'yesterday'
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
    assert.strictEqual(
      rules.UPDATE_DATE_BUCKETS.find(bucket => bucket.id === 'last-month')
        .label,
      '上个月'
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
    assert.strictEqual(
      rules.resolveSubscriptionSelection([{ id: 'kept' }], 'removed'),
      ''
    );
    assert.strictEqual(
      rules.resolveSubscriptionSelection([{ id: 'kept' }], 'kept'),
      'kept'
    );
    assert.strictEqual(
      rules.countPendingSubscriptionEpisodes(
        [{ id: 'shown' }, { id: 'unchanged' }],
        [{ id: 'new' }, { id: 'shown' }, { id: 'unchanged' }]
      ),
      1
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
    assert.deepStrictEqual(
      rules.getRailPositionMetrics(metrics, 0),
      {
        scrollLeft: 0,
        maxScroll: 600,
        visibleRatio: 1 / 3,
        canScroll: true,
        canPrev: false,
        canNext: true,
      },
      'the left edge starts with only the forward arrow enabled'
    );
    assert.deepStrictEqual(
      rules.getRailPositionMetrics(metrics, 210),
      {
        scrollLeft: 210,
        maxScroll: 600,
        visibleRatio: 1 / 3,
        canScroll: true,
        canPrev: true,
        canNext: true,
      },
      'moving right from the left edge enables the reverse arrow immediately'
    );
    assert.deepStrictEqual(
      rules.getRailPositionMetrics(metrics, 600),
      {
        scrollLeft: 600,
        maxScroll: 600,
        visibleRatio: 1 / 3,
        canScroll: true,
        canPrev: true,
        canNext: false,
      },
      'the right edge starts with only the reverse arrow enabled'
    );
    assert.strictEqual(
      rules.getRailPositionMetrics(metrics, 390).canNext,
      true,
      'moving left from the right edge enables the forward arrow immediately'
    );
    assert.deepStrictEqual(
      rules.getRailPositionMetrics({ maxScroll: 0, visibleRatio: 1 }, 0),
      {
        scrollLeft: 0,
        maxScroll: 0,
        visibleRatio: 1,
        canScroll: false,
        canPrev: false,
        canNext: false,
      },
      'resize-to-fit clears both arrow states'
    );
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
    assert.strictEqual(
      rules.getRailThumbDragTarget({
        startScrollLeft: 100,
        startPointerX: 10,
        pointerX: -1000,
        trackWidth: 300,
        thumbWidth: 100,
        maxScroll: 600,
      }),
      0,
      'dragging the thumb past the left edge clamps and enables only forward'
    );
    assert.strictEqual(
      rules.getRailThumbDragTarget({
        startScrollLeft: 100,
        startPointerX: 10,
        pointerX: 1000,
        trackWidth: 300,
        thumbWidth: 100,
        maxScroll: 600,
      }),
      600,
      'dragging the thumb past the right edge clamps and enables only reverse'
    );
    assert.deepStrictEqual(
      rules.getRailThumbGeometry({
        trackWidth: 1200,
        visibleRatio: 0.25,
        canScroll: true,
      }),
      { width: 100, travel: 1100 }
    );
    assert.deepStrictEqual(
      rules.getRailThumbGeometry({
        trackWidth: 1200,
        visibleRatio: 0.9,
        canScroll: true,
      }),
      { width: 160, travel: 1040 }
    );
    assert.strictEqual(
      rules.getRailArrowGoal({
        scrollLeft: 100,
        goal: 310,
        goalDirection: 1,
        clientWidth: 300,
        scrollWidth: 1200,
        direction: 1,
      }),
      520
    );
    assert.strictEqual(
      rules.getRailArrowGoal({
        scrollLeft: 220,
        goal: 520,
        goalDirection: 1,
        clientWidth: 300,
        scrollWidth: 1200,
        direction: -1,
      }),
      10,
      'a reverse click retargets from the visible position instead of the old goal'
    );
    let rapidGoal = rules.getRailArrowGoal({
      scrollLeft: 220,
      goal: 520,
      goalDirection: 1,
      clientWidth: 300,
      scrollWidth: 1200,
      direction: -1,
    });
    assert.strictEqual(rapidGoal, 10);
    rapidGoal = rules.getRailArrowGoal({
      scrollLeft: 170,
      goal: rapidGoal,
      goalDirection: -1,
      clientWidth: 300,
      scrollWidth: 1200,
      direction: 1,
    });
    assert.strictEqual(rapidGoal, 380);
    assert.strictEqual(
      rules.getRailPositionMetrics(
        { maxScroll: 900, visibleRatio: 0.25 },
        rapidGoal
      ).canPrev,
      true,
      'alternating targets keep a usable reverse arrow state'
    );
    const forwardRailStep = rules.getRailMotionStep({
      scrollLeft: 100,
      goal: 520,
      maxScroll: 900,
      deltaMs: 16,
    });
    assert.ok(forwardRailStep > 100 && forwardRailStep < 520);
    const reversedRailStep = rules.getRailMotionStep({
      scrollLeft: forwardRailStep,
      goal: 0,
      maxScroll: 900,
      deltaMs: 16,
    });
    assert.ok(
      reversedRailStep >= 0 && reversedRailStep < forwardRailStep,
      'rail retarget should reverse from the current position without a snap'
    );

    const selectionContext = {
      clientWidth: 300,
      scrollWidth: 1000,
      itemWidth: 80,
      gap: 10,
      hasPrev: true,
      hasNext: true,
    };
    assert.strictEqual(
      rules.getRailSelectionContextDistance(selectionContext),
      90,
      'selection context keeps one cover and one gap on either side'
    );
    const rightEdgeTarget = rules.getRailSelectionContextTarget({
      ...selectionContext,
      scrollLeft: 0,
      itemLeft: 220,
    });
    const leftEdgeTarget = rules.getRailSelectionContextTarget({
      ...selectionContext,
      scrollLeft: 90,
      itemLeft: 90,
    });
    assert.strictEqual(
      rightEdgeTarget,
      90,
      'selecting the visible right edge reveals the full next cover'
    );
    assert.strictEqual(
      leftEdgeTarget,
      0,
      'selecting the visible left edge reveals the full previous cover'
    );
    assert.strictEqual(
      rightEdgeTarget,
      90 - leftEdgeTarget,
      'left and right edge selection use mirrored context distances'
    );
    assert.strictEqual(
      rules.getRailSelectionContextTarget({
        ...selectionContext,
        scrollLeft: 100,
        itemLeft: 220,
      }),
      100,
      'selection inside the safe zone does not move the rail'
    );
    assert.strictEqual(
      rules.getRailSelectionContextTarget({
        ...selectionContext,
        scrollLeft: 50,
        itemLeft: 0,
        hasPrev: false,
      }),
      0,
      'the first item clamps to the real left edge without a blank gutter'
    );
    assert.strictEqual(
      rules.getRailSelectionContextTarget({
        ...selectionContext,
        scrollLeft: 500,
        itemLeft: 920,
        hasNext: false,
      }),
      700,
      'the last item clamps to the real right edge without a blank gutter'
    );
    assert.strictEqual(
      rules.getRailSelectionContextDistance({
        clientWidth: 120,
        itemWidth: 80,
        gap: 10,
      }),
      20,
      'narrow rails shrink both safe zones by the same formula'
    );
    assert.strictEqual(
      rules.getRailSelectionContextTarget({
        clientWidth: 120,
        scrollWidth: 500,
        scrollLeft: 0,
        itemLeft: 40,
        itemWidth: 80,
        gap: 10,
        hasPrev: true,
        hasNext: true,
      }),
      20,
      'narrow rails still reveal symmetric context without overflowing'
    );
    assert.strictEqual(
      rules.getRailSelectionContextTarget({
        clientWidth: 550,
        scrollWidth: 600,
        scrollLeft: 0,
        itemLeft: 520,
        itemWidth: 80,
        gap: 10,
        hasPrev: true,
        hasNext: false,
      }),
      50,
      'a resize clamps a previously distant selection to its new max scroll'
    );

    const firstSelectionMotion = rules.getRailMotionDecision({
      scrollLeft: 0,
      goal: rightEdgeTarget,
      maxScroll: 700,
    });
    assert.strictEqual(firstSelectionMotion.shouldAnimate, true);
    const afterFirstSelection = rules.getRailMotionStep({
      scrollLeft: 0,
      goal: firstSelectionMotion.target,
      maxScroll: 700,
      deltaMs: 16,
    });
    const latestSelectionMotion = rules.getRailMotionDecision({
      scrollLeft: afterFirstSelection,
      goal: 420,
      maxScroll: 700,
    });
    assert.strictEqual(
      latestSelectionMotion.target,
      420,
      'rapid A -> B -> C retargeting retains only the newest selection goal'
    );
    assert.ok(
      rules.getRailMotionStep({
        scrollLeft: afterFirstSelection,
        goal: latestSelectionMotion.target,
        maxScroll: 700,
        deltaMs: 16,
      }) > afterFirstSelection,
      'the latest target advances from the current visible position'
    );
    assert.deepStrictEqual(
      rules.getRailMotionDecision({
        scrollLeft: 164,
        goal: 520,
        maxScroll: 700,
        interrupted: true,
      }),
      { target: 164, shouldAnimate: false, immediate: true },
      'wheel or drag interruption discards the stale controller goal'
    );
    assert.deepStrictEqual(
      rules.getRailMotionDecision({
        scrollLeft: 164,
        goal: 520,
        maxScroll: 700,
        reducedMotion: true,
      }),
      { target: 520, shouldAnimate: false, immediate: true },
      'reduced motion directly applies the same clamped selection target'
    );

    const alreadySorted = [
      { id: 'today', pubTime: crossYearNow },
      { id: 'yesterday', pubTime: localTime(2024, 11, 31) },
      { id: 'older', pubTime: localTime(2024, 10, 1) },
    ];
    assert.deepStrictEqual(
      rules
        .groupSortedSubscriptionUpdates(alreadySorted, crossYearNow)
        .flatMap(group => group.episodes.map(item => item.id)),
      ['today', 'yesterday', 'older']
    );

    assert.deepStrictEqual(
      rules.getStableVirtualRange({
        itemCount: 100,
        firstVisible: 18,
        lastVisible: 26,
        currentStart: 6,
        currentEnd: 39,
        buffer: 12,
        guard: 4,
      }),
      { start: 6, end: 39, changed: false }
    );
    assert.deepStrictEqual(
      rules.getStableVirtualRange({
        itemCount: 100,
        firstVisible: 35,
        lastVisible: 43,
        currentStart: 6,
        currentEnd: 39,
        buffer: 12,
        guard: 4,
      }),
      { start: 23, end: 56, changed: true }
    );
    assert.deepStrictEqual(
      rules.getStableVirtualRange({
        itemCount: 20,
        firstVisible: 0,
        lastVisible: 5,
        currentStart: 0,
        currentEnd: 0,
        buffer: 12,
        guard: 4,
        force: true,
      }),
      { start: 0, end: 18, changed: true }
    );

    const view = rules.createSubscriptionUpdateView(
      [
        { id: 'today', pubTime: crossYearNow },
        { id: 'older', pubTime: localTime(2024, 10, 1) },
      ],
      crossYearNow,
      { rowHeight: 96, groupHeight: 34 }
    );
    assert.strictEqual(view.flatItems.length, 4);
    assert.strictEqual(view.metrics[0].top, 0);
    assert.strictEqual(view.totalHeight, 260);

    const snapshot = snapshots.createSubscriptionUpdateSnapshot({
      podcasts: [
        { id: 'pod-a', title: 'A' },
        { id: 'pod-b', title: 'B' },
      ],
      episodes: [
        {
          id: 'a-new',
          podcastId: 'pod-a',
          pubTime: crossYearNow,
          completed: false,
        },
        {
          id: 'b-mid',
          podcastId: 'pod-b',
          pubTime: localTime(2024, 11, 31),
          completed: false,
        },
        {
          id: 'a-done',
          podcastId: 'pod-a',
          pubTime: localTime(2024, 11, 30),
          completed: true,
        },
      ],
      now: crossYearNow,
      version: 1,
    });
    const allView = snapshots.getSubscriptionUpdateView(snapshot, {
      now: crossYearNow,
    });
    const unfinishedView = snapshots.getSubscriptionUpdateView(snapshot, {
      unfinishedOnly: true,
      now: crossYearNow,
    });
    const unaffectedPodcastView = snapshots.getSubscriptionUpdateView(
      snapshot,
      {
        podcastId: 'pod-b',
        now: crossYearNow,
      }
    );
    assert.strictEqual(allView.episodes.length, 3);
    assert.strictEqual(unfinishedView.episodes.length, 2);
    const completedSnapshot = snapshots.applySubscriptionUpdateCompletion(
      snapshot,
      'a-new',
      true,
      crossYearNow
    );
    assert.strictEqual(
      snapshots.getSubscriptionUpdateView(completedSnapshot, {
        unfinishedOnly: true,
        now: crossYearNow,
      }).episodes.length,
      1
    );
    assert.strictEqual(
      snapshots.getSubscriptionUpdateView(completedSnapshot, {
        podcastId: 'pod-b',
        now: crossYearNow,
      }),
      unaffectedPodcastView
    );
    const restoredSnapshot = snapshots.applySubscriptionUpdateCompletion(
      completedSnapshot,
      'a-new',
      false,
      crossYearNow
    );
    assert.deepStrictEqual(
      snapshots
        .getSubscriptionUpdateView(restoredSnapshot, {
          unfinishedOnly: true,
          now: crossYearNow,
        })
        .episodes.map(item => item.id),
      ['a-new', 'b-mid']
    );

    assert.strictEqual(shouldYieldMainScrollKey({ tagName: 'INPUT' }), true);
    assert.strictEqual(
      shouldYieldMainScrollKey({
        tagName: 'DIV',
        closest: selector => (selector === '.vue-slider' ? {} : null),
      }),
      true
    );
    assert.strictEqual(
      shouldYieldMainScrollKey({
        tagName: 'DIV',
        closest: () => null,
      }),
      false
    );

    const synthetic = Array.from({ length: 10000 }, (_, index) => ({
      id: 'synthetic-' + index,
      podcastId: 'pod-' + (index % 32),
      pubTime: crossYearNow - index * 60000,
      completed: index % 3 === 0,
      stableOrder: index,
    }));
    const perfStartedAt = process.hrtime.bigint();
    const syntheticView = rules.createSubscriptionUpdateView(
      rules.sortSubscriptionUpdates(synthetic),
      crossYearNow
    );
    const elapsedMs = Number(process.hrtime.bigint() - perfStartedAt) / 1e6;
    assert.strictEqual(syntheticView.episodes.length, 10000);
    assert.ok(
      elapsedMs < 2000,
      '10k pure update view took too long: ' + elapsedMs.toFixed(1) + 'ms'
    );
    const tailIndex = rules.findFixedVirtualIndex(
      syntheticView.metrics,
      syntheticView.totalHeight
    );
    assert.strictEqual(tailIndex, syntheticView.metrics.length - 1);
    const tailRange = rules.getStableVirtualRange({
      itemCount: syntheticView.metrics.length,
      firstVisible: tailIndex,
      lastVisible: tailIndex,
      currentStart: 0,
      currentEnd: 0,
      buffer: 12,
      guard: 4,
      force: true,
    });
    assert.strictEqual(tailRange.end, syntheticView.metrics.length);

    const firstBuild = deferred();
    const secondBuild = deferred();
    let snapshotReadCount = 0;
    global.__subscriptionSnapshotSmoke = {
      episodes: [],
      next() {
        snapshotReadCount += 1;
        return snapshotReadCount === 1
          ? firstBuild.promise
          : secondBuild.promise;
      },
    };
    const dirtyDuringBuild = snapshots.getSubscriptionUpdatesSnapshot({
      force: true,
      now: crossYearNow,
    });
    snapshots.markSubscriptionUpdatesDirty();
    firstBuild.resolve([]);
    await waitFor(
      () => snapshotReadCount === 2,
      'dirty generation did not trigger a serial rebuild'
    );
    secondBuild.resolve([
      { id: 'pod-after-dirty', title: 'Fresh podcast', updatedAt: 1 },
    ]);
    const dirtyResult = await dirtyDuringBuild;
    assert.deepStrictEqual(
      dirtyResult.podcasts.map(podcast => podcast.id),
      ['pod-after-dirty']
    );

    const thirdBuild = deferred();
    const fourthBuild = deferred();
    snapshotReadCount = 0;
    global.__subscriptionSnapshotSmoke.next = () => {
      snapshotReadCount += 1;
      return snapshotReadCount === 1 ? thirdBuild.promise : fourthBuild.promise;
    };
    const forceDuringBuild = snapshots.getSubscriptionUpdatesSnapshot({
      force: true,
      now: crossYearNow,
    });
    snapshots.getSubscriptionUpdatesSnapshot({
      force: true,
      now: crossYearNow,
    });
    thirdBuild.resolve([]);
    await waitFor(
      () => snapshotReadCount === 2,
      'forced generation did not rebuild after the in-flight read'
    );
    fourthBuild.resolve([
      { id: 'pod-after-force', title: 'Forced podcast', updatedAt: 2 },
    ]);
    const forceResult = await forceDuringBuild;
    assert.deepStrictEqual(
      forceResult.podcasts.map(podcast => podcast.id),
      ['pod-after-force']
    );
    delete global.__subscriptionSnapshotSmoke;

    process.stdout.write(
      'subscription updates rules smoke: PASS (' +
        elapsedMs.toFixed(1) +
        'ms / 10k)\n'
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
