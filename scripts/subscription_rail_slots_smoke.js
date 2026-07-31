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

  // The product rail is a discrete carousel, not a physical-clipping reveal.
  // O is index 0 and must participate in every window calculation.
  const carousel = { itemCount: 16, visibleCount: 8, maxStart: 8 };
  assert.strictEqual(
    rules.getRailWindowSelectionTarget({
      ...carousel,
      windowStart: 0,
      itemIndex: 7,
    }),
    1,
    'O..G followed by a right-edge click must advance to A..H'
  );
  assert.strictEqual(
    rules.getRailWindowSelectionTarget({
      ...carousel,
      windowStart: 3,
      itemIndex: 6,
    }),
    3,
    'an interior selection changes only the feed filter'
  );
  assert.strictEqual(
    rules.getRailWindowSelectionTarget({
      ...carousel,
      windowStart: 3,
      itemIndex: 3,
    }),
    2,
    'a left-edge click reveals exactly one preceding slot'
  );
  assert.strictEqual(
    rules.getRailWindowSelectionTarget({
      ...carousel,
      windowStart: 3,
      itemIndex: 10,
    }),
    4,
    'a right-edge click reveals exactly one following slot'
  );
  assert.strictEqual(
    rules.getRailWindowRevealTarget({
      ...carousel,
      windowStart: 3,
      itemIndex: 1,
    }),
    1,
    'a hidden item on the left takes the nearest complete window'
  );
  assert.strictEqual(
    rules.getRailWindowRevealTarget({
      ...carousel,
      windowStart: 3,
      itemIndex: 12,
    }),
    5,
    'a hidden item on the right takes the nearest complete window'
  );

  let start = 8;
  const leftEdgeStarts = [];
  while (start > 0) {
    start = rules.getRailWindowSelectionTarget({
      itemCount: 16,
      visibleCount: 7,
      maxStart: 9,
      windowStart: start,
      itemIndex: start,
    });
    leftEdgeStarts.push(start);
  }
  assert.deepStrictEqual(
    leftEdgeStarts,
    [7, 6, 5, 4, 3, 2, 1, 0],
    'repeated left-edge clicks must walk back through G..O without a bounce'
  );

  assert.strictEqual(
    rules.getRailWindowSelectionTarget({
      itemCount: 16,
      visibleCount: 8,
      maxStart: 8,
      windowStart: 0,
      itemIndex: 7,
    }),
    1,
    'reselecting a current right-edge item retains edge navigation semantics'
  );
  assert.strictEqual(
    rules.getRailWindowPageTarget({
      renderPosition: 0,
      maxStart: 8,
      visibleCount: 8,
      direction: 1,
    }),
    7,
    'arrow pagination advances visibleCount - 1 slots'
  );
  assert.strictEqual(
    rules.getRailWindowPageTarget({
      renderPosition: 2.4,
      targetStart: 7,
      targetDirection: 1,
      maxStart: 8,
      visibleCount: 8,
      direction: -1,
    }),
    0,
    'a reverse arrow derives from the live render position, not an old goal'
  );

  const thumbTravel = 336;
  assert.strictEqual(
    rules.getRailWindowThumbOffset({
      renderPosition: 0,
      maxStart: 8,
      thumbTravel,
    }),
    0,
    'thumb starts at the first logical slot'
  );
  assert.strictEqual(
    rules.getRailWindowThumbOffset({
      renderPosition: 8,
      maxStart: 8,
      thumbTravel,
    }),
    thumbTravel,
    'thumb ends exactly at its available travel'
  );
  assert.ok(
    rules.getRailWindowThumbOffset({
      renderPosition: 4,
      maxStart: 8,
      thumbTravel,
    }) >
      rules.getRailWindowThumbOffset({
        renderPosition: 3,
        maxStart: 8,
        thumbTravel,
      }),
    'thumb projection must be monotonic with renderPosition'
  );
  closeTo(
    rules.getRailThumbDragRenderPosition({
      startRenderPosition: 2,
      startPointerX: 10,
      pointerX: 52,
      trackWidth: 400,
      thumbWidth: 64,
      maxStart: 8,
    }),
    3,
    'thumb dragging maps pointer distance to the same logical coordinate'
  );
  assert.strictEqual(
    rules.getRailWindowStart({ renderPosition: 2.51, maxStart: 8 }),
    3,
    'wheel and thumb release settle to the nearest complete slot'
  );
  assert.strictEqual(
    rules.getRailWindowStart({ renderPosition: 2.49, maxStart: 8 }),
    2,
    'slot settling remains stable on the lower side of the midpoint'
  );

  const oneSlot = rules.getRailWindowSelectionTarget({
    itemCount: 1,
    visibleCount: 8,
    maxStart: 0,
    windowStart: 0,
    itemIndex: 0,
  });
  assert.strictEqual(
    oneSlot,
    0,
    'short rails clamp every operation to slot zero'
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
  closeTo(
    rules.getRailLogicalPosition({
      scrollLeft: 135,
      maxScroll: narrow.maxScroll,
      slotStride: narrow.slotStride,
    }),
    1.5,
    'logical position must retain in-flight fractional wheel/thumb movement'
  );
  closeTo(
    rules.getRailSlotThumbProgress({
      scrollLeft: 135,
      maxScroll: narrow.maxScroll,
      slotStride: narrow.slotStride,
      maxStartSlot: narrow.maxStartSlot,
    }),
    0.375,
    'thumb progress must share the logical slot coordinate'
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
    rules.getRailRenderMotionDecision({
      renderPosition: 1,
      targetStart: 2,
      maxStart: narrow.maxStartSlot,
      reducedMotion: true,
    }).immediate,
    true,
    'reduced motion keeps the same target but skips animation'
  );
  const motion = rules.getRailRenderMotionDecision({
    renderPosition: 1,
    targetStart: 2,
    maxStart: 4,
  });
  assert.strictEqual(
    motion.durationMs,
    200,
    'one slot uses a short 200ms motion'
  );
  assert.strictEqual(
    rules.getRailRenderMotionFrame({
      startPosition: 1,
      targetStart: 2,
      elapsedMs: motion.durationMs,
      durationMs: motion.durationMs,
      maxStart: 4,
    }),
    2,
    'elapsed-time easing must land exactly on its discrete target'
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
