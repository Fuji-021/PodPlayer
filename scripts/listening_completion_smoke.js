const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-listening-coverage-smoke-')
);

async function loadCoverage() {
  const output = path.join(tempDir, 'coverage.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/podcast/listenCoverage.js')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  return require(output);
}

function addAll(target, values) {
  values.forEach(value => target.add(value));
}

function legacyTickSamples(rate, totalSec) {
  const heard = new Set();
  let position = 0;
  while (position < totalSec - 1) {
    position = Math.min(totalSec - 1, position + rate);
    heard.add(Math.floor(position));
  }
  return heard;
}

function playContinuously(coverage, rate, totalSec) {
  let now = 0;
  let position = 0;
  let anchor = coverage.createListenCoverageAnchor(position, now);
  const heard = new Set();
  let contentDelta = 0;

  while (position < totalSec - 1) {
    now += 1000;
    position = Math.min(totalSec - 1, position + rate);
    const result = coverage.advanceListenCoverage(anchor, {
      position,
      playbackRate: rate,
      totalSec,
      now,
    });
    anchor = result.anchor;
    addAll(heard, result.secs);
    contentDelta += result.contentDeltaSec;
  }
  return { heard, contentDelta };
}

async function main() {
  try {
    const coverage = await loadCoverage();

    [1.1, 1.5, 2, 3].forEach(rate => {
      assert.ok(
        legacyTickSamples(rate, 120).size < 115,
        `${rate}x reproduces the old one-sample-per-tick completion gap`
      );
    });

    [1, 1.1, 1.5, 2, 3].forEach(rate => {
      const totalSec = 120;
      const result = playContinuously(coverage, rate, totalSec);
      assert.ok(
        result.heard.size >= totalSec - 5,
        `${rate}x should reach the existing completion threshold`
      );
      assert.ok(result.contentDelta > 0, `${rate}x should retain content time`);
    });

    let anchor = coverage.createListenCoverageAnchor(0, 0);
    const slowFirst = coverage.advanceListenCoverage(anchor, {
      position: 0.5,
      playbackRate: 0.5,
      totalSec: 20,
      now: 1000,
    });
    const slowSecond = coverage.advanceListenCoverage(slowFirst.anchor, {
      position: 1,
      playbackRate: 0.5,
      totalSec: 20,
      now: 2000,
    });
    const slowHeard = new Set();
    addAll(slowHeard, slowFirst.secs);
    addAll(slowHeard, slowSecond.secs);
    assert.deepStrictEqual([...slowHeard], [0, 1]);

    anchor = coverage.createListenCoverageAnchor(0, 0);
    const driftFirst = coverage.advanceListenCoverage(anchor, {
      position: 1.1,
      playbackRate: 1,
      totalSec: 20,
      now: 1100,
    });
    const driftSecond = coverage.advanceListenCoverage(driftFirst.anchor, {
      position: 3.15,
      playbackRate: 1,
      totalSec: 20,
      now: 3150,
    });
    assert.strictEqual(driftFirst.continuous, true);
    assert.strictEqual(driftSecond.continuous, true);

    const stalled = coverage.advanceListenCoverage(
      coverage.createListenCoverageAnchor(10, 0),
      {
        position: 20,
        playbackRate: 1,
        totalSec: 100,
        now: 5000,
      }
    );
    assert.strictEqual(stalled.continuous, false);
    assert.deepStrictEqual(stalled.secs, []);

    const beforePause = coverage.createListenCoverageAnchor(5, 5000);
    const afterPause = coverage.advanceListenCoverage(null, {
      position: 50,
      playbackRate: 1,
      totalSec: 100,
      now: 15000,
    });
    assert.deepStrictEqual(afterPause.secs, []);
    const resumed = coverage.advanceListenCoverage(afterPause.anchor, {
      position: 51,
      playbackRate: 1,
      totalSec: 100,
      now: 16000,
    });
    assert.deepStrictEqual(resumed.secs, [50, 51]);
    assert.notStrictEqual(beforePause.position, afterPause.anchor.position);

    const explicitSeek = coverage.advanceListenCoverage(null, {
      position: 90,
      playbackRate: 1,
      totalSec: 100,
      now: 20000,
    });
    assert.deepStrictEqual(explicitSeek.secs, []);
    const afterSeek = coverage.advanceListenCoverage(explicitSeek.anchor, {
      position: 91,
      playbackRate: 1,
      totalSec: 100,
      now: 21000,
    });
    assert.deepStrictEqual(afterSeek.secs, [90, 91]);

    [
      'forward seek',
      'backward seek',
      'skip forward 30',
      'skip backward 15',
      'shownotes timestamp',
      'track switch',
      'source rebuild',
      'system resume',
    ].forEach(label => {
      const discontinuity = coverage.advanceListenCoverage(null, {
        position: 70,
        playbackRate: 1,
        totalSec: 100,
        now: 25000,
      });
      assert.deepStrictEqual(
        discontinuity.secs,
        [],
        `${label} must establish a new anchor before recording coverage`
      );
    });

    const directToEnd = coverage.advanceListenCoverage(null, {
      position: 119,
      playbackRate: 1,
      totalSec: 120,
      now: 30000,
    });
    assert.deepStrictEqual(directToEnd.secs, []);

    const replay = playContinuously(coverage, 1, 20);
    const replayAgain = playContinuously(coverage, 1, 20);
    const replayBits = new Set(replay.heard);
    addAll(replayBits, replayAgain.heard);
    assert.strictEqual(replayBits.size, replay.heard.size);
    const resetReplayBits = new Set(replayAgain.heard);
    assert.strictEqual(resetReplayBits.size, replayAgain.heard.size);

    const finalPayload = coverage.toListenBatchPayload({
      secs: [115, 116, 117],
      wall: 3,
      content: 4.5,
      count: 3,
    });
    assert.deepStrictEqual(finalPayload, {
      secs: [115, 116, 117],
      wallDeltaSec: 3,
      contentDeltaSec: 4.5,
    });

    process.stdout.write('listening completion smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
