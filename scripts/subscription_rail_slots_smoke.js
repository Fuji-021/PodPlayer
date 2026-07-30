const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-subscription-rail-slots-')
);

function closeTo(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 0.001,
    `${message}: expected ${expected}, received ${actual}`
  );
}

async function main() {
  const outfile = path.join(tempDir, 'subscription-updates-rules.cjs');
  await esbuild.build({
    entryPoints: [
      path.join(root, 'src/utils/podcast/subscriptionUpdatesRules.js'),
    ],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const rules = require(outfile);

  const desktop = rules.getRailSlotLayout({
    availableWidth: 1200,
    itemCount: 14,
    slotWidth: 96,
    coverSize: 88,
    selectedScale: 1.055,
    minimumGap: 10,
  });
  assert.strictEqual(desktop.visibleCount, 11);
  assert.strictEqual(desktop.slotStride, 106);
  assert.strictEqual(desktop.maxScroll, 318);
  assert.strictEqual(desktop.selectedFitsSlot, true);
  closeTo(
    desktop.contentViewportWidth + desktop.outerGutter * 2,
    desktop.usableWidth,
    'desktop gutter must consume only the leftover width'
  );

  const parentMeasured = rules.getRailSlotLayout({
    availableWidth: 600,
    arrowSafety: 40,
    itemCount: 8,
    slotWidth: 96,
    coverSize: 88,
    selectedScale: 1.055,
    minimumGap: 10,
  });
  assert.strictEqual(parentMeasured.usableWidth, 520);
  closeTo(
    parentMeasured.contentViewportWidth + parentMeasured.outerGutter * 2,
    520,
    'arrow safety must be excluded before complete slots are counted'
  );

  [220, 700, 1600].forEach(width => {
    const layout = rules.getRailSlotLayout({
      availableWidth: width,
      itemCount: 32,
      slotWidth: 96,
      coverSize: 88,
      selectedScale: 1.055,
      minimumGap: 10,
    });
    assert.ok(layout.visibleCount >= 1, `width ${width} must keep one slot`);
    closeTo(
      layout.contentViewportWidth + layout.outerGutter * 2,
      layout.usableWidth,
      `width ${width} must not stretch the logical gap`
    );
    assert.strictEqual(
      layout.maxScroll % layout.slotStride,
      0,
      `width ${width} must finish on a full slot`
    );
  });

  const one = rules.getRailSlotLayout({
    availableWidth: 600,
    itemCount: 1,
    slotWidth: 96,
    coverSize: 88,
    selectedScale: 1.055,
    minimumGap: 10,
  });
  assert.strictEqual(one.visibleCount, 1);
  assert.strictEqual(one.maxScroll, 0);
  closeTo(one.outerGutter, 252, 'one cover must use symmetric outer gutter');

  const narrow = rules.getRailSlotLayout({
    availableWidth: 300,
    itemCount: 7,
    slotWidth: 80,
    coverSize: 72,
    selectedScale: 1.055,
    minimumGap: 10,
  });
  assert.strictEqual(narrow.visibleCount, 3);
  assert.strictEqual(narrow.outerGutter, 20);
  assert.strictEqual(narrow.maxScroll, 360);
  assert.strictEqual(
    rules.getRailSlotSelectionTarget({
      scrollLeft: 180,
      maxScroll: narrow.maxScroll,
      slotStride: narrow.slotStride,
      itemIndex: 2,
      itemCount: 7,
      visibleCount: narrow.visibleCount,
    }),
    90,
    'a left-edge selection must reveal its prior neighbor on a full slot'
  );
  assert.strictEqual(
    rules.getRailSlotSelectionTarget({
      scrollLeft: 260,
      maxScroll: narrow.maxScroll,
      slotStride: narrow.slotStride,
      itemIndex: 5,
      itemCount: 7,
      visibleCount: narrow.visibleCount,
    }),
    360,
    'a right-edge selection must reveal its next neighbor on a full slot'
  );
  assert.strictEqual(
    rules.getRailSlotTarget({
      scrollLeft: 155,
      maxScroll: narrow.maxScroll,
      slotStride: narrow.slotStride,
    }),
    180,
    'wheel or thumb release must settle to the nearest full slot'
  );
  assert.strictEqual(
    rules.getRailSlotArrowGoal({
      scrollLeft: 180,
      clientWidth: 300,
      maxScroll: narrow.maxScroll,
      slotStride: narrow.slotStride,
      direction: 1,
    }),
    360,
    'forward arrow paging must end on a full slot'
  );
  assert.strictEqual(
    rules.getRailSlotArrowGoal({
      scrollLeft: 360,
      goal: 360,
      goalDirection: 1,
      clientWidth: 300,
      maxScroll: narrow.maxScroll,
      slotStride: narrow.slotStride,
      direction: -1,
    }),
    180,
    'reversing arrow direction must retarget from the visible slot'
  );

  const metrics = rules.getRailMetrics({
    scrollLeft: narrow.maxScroll,
    clientWidth: 300,
    scrollWidth: 660,
  });
  const thumb = rules.getRailThumbGeometry({
    trackWidth: 400,
    visibleRatio: metrics.visibleRatio,
    canScroll: metrics.canScroll,
  });
  assert.ok(thumb.width > 0 && thumb.travel > 0);
  assert.strictEqual(metrics.scrollLeft, metrics.maxScroll);
  assert.strictEqual(
    rules.getRailMotionDecision({
      scrollLeft: 90,
      goal: 180,
      maxScroll: narrow.maxScroll,
      reducedMotion: true,
    }).immediate,
    true,
    'reduced motion keeps the same target but skips animation'
  );

  process.stdout.write('subscription rail slots smoke: PASS\n');
}

main()
  .catch(error => {
    process.stderr.write(String((error && error.stack) || error) + '\n');
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
