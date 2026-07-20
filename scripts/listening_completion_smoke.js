const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

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

function loadPlayerPrototype(events) {
  let source = fs.readFileSync(path.join(root, 'src/utils/Player.js'), 'utf8');
  source = source.replace(/^import[\s\S]*?;\r?\n/gm, '');
  source = source.replace('export default class {', 'class Player {');
  source += '\nmodule.exports = Player;';
  const context = {
    module: { exports: {} },
    exports: {},
    console,
    document: { title: '' },
    process: { env: {} },
    setTimeout,
    clearTimeout,
    __store: {
      state: { podcastQueue: [] },
      commit: (...args) => events.push(['store.commit', ...args]),
      dispatch: () => {},
    },
  };
  vm.runInNewContext(
    'const store = __store; const isCreateTray = false; const isCreateMpris = false;\n' +
      source,
    context,
    { filename: 'Player.js' }
  );
  return context.module.exports;
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

    [0.5, 1, 1.5, 2, 3].forEach(rate => {
      [5, 30, 60].forEach(elapsedSec => {
        const result = coverage.advanceListenCoverage(
          coverage.createListenCoverageAnchor(10, 0),
          {
            position: 10 + elapsedSec * rate,
            playbackRate: rate,
            totalSec: 600,
            now: elapsedSec * 1000,
          }
        );
        assert.strictEqual(
          result.continuous,
          true,
          `${rate}x ${elapsedSec}s delayed tick should remain continuous`
        );
        assert.strictEqual(result.wallDeltaSec, elapsedSec);
        assert.strictEqual(result.contentDeltaSec, elapsedSec * rate);
      });
    });

    const delayedForFlush = coverage.advanceListenCoverage(
      coverage.createListenCoverageAnchor(10, 0),
      {
        position: 40,
        playbackRate: 1,
        totalSec: 600,
        now: 30000,
      }
    );
    const delayedBuffer = {
      id: 'pod::delayed',
      totalSec: 600,
      secs: delayedForFlush.secs,
      wall: delayedForFlush.wallDeltaSec,
      content: delayedForFlush.contentDeltaSec,
      count: 1,
    };
    assert.strictEqual(
      coverage.shouldFlushListenBuffer(delayedBuffer, 5),
      true,
      'a delayed continuous tick should request an immediate batch flush'
    );
    const delayedPersisted = [];
    await coverage.flushListenBuffer(delayedBuffer, (id, totalSec, payload) =>
      delayedPersisted.push({ id, totalSec, payload })
    ).promise;
    assert.strictEqual(delayedPersisted.length, 1);
    assert.strictEqual(delayedPersisted[0].payload.wallDeltaSec, 30);
    assert.strictEqual(delayedPersisted[0].payload.contentDeltaSec, 30);

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
        position: 10,
        playbackRate: 1,
        totalSec: 100,
        now: 5000,
      }
    );
    assert.strictEqual(stalled.continuous, false);
    assert.deepStrictEqual(stalled.secs, []);

    const delayedMismatch = coverage.advanceListenCoverage(
      coverage.createListenCoverageAnchor(10, 0),
      {
        position: 20,
        playbackRate: 1,
        totalSec: 100,
        now: 30000,
      }
    );
    assert.strictEqual(delayedMismatch.continuous, false);
    assert.strictEqual(delayedMismatch.reason, 'rate-mismatch');

    const delayedJump = coverage.advanceListenCoverage(
      coverage.createListenCoverageAnchor(10, 0),
      {
        position: 80,
        playbackRate: 1,
        totalSec: 100,
        now: 1000,
      }
    );
    assert.strictEqual(delayedJump.continuous, false);
    assert.strictEqual(delayedJump.reason, 'rate-mismatch');

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

    const persisted = [];
    const finalBatch = coverage.flushListenBuffer(
      {
        id: 'pod::episode',
        totalSec: 120,
        secs: [115, 116, 117],
        wall: 3,
        content: 4.5,
        count: 3,
      },
      (id, totalSec, payload) => {
        persisted.push({ id, totalSec, payload });
        return { id, totalSec, completed: false };
      }
    );
    assert.ok(finalBatch, 'a partial final buffer should flush');
    await finalBatch.promise;
    assert.deepStrictEqual(persisted, [
      {
        id: 'pod::episode',
        totalSec: 120,
        payload: {
          secs: [115, 116, 117],
          wallDeltaSec: 3,
          contentDeltaSec: 4.5,
        },
      },
    ]);
    assert.strictEqual(finalBatch.nextBuffer.count, 0);

    const endEvents = [];
    const Player = loadPlayerPrototype(endEvents);
    const endPersisted = [];
    const sleepingPlayer = Object.create(Player.prototype);
    sleepingPlayer._listenBuf = {
      id: 'pod::end',
      totalSec: 120,
      secs: [118, 119],
      wall: 2,
      content: 2,
      count: 2,
    };
    sleepingPlayer._flushListenBuf = () => {
      const batch = coverage.flushListenBuffer(
        sleepingPlayer._listenBuf,
        (id, totalSec, payload) => endPersisted.push({ id, totalSec, payload })
      );
      sleepingPlayer._listenBuf = batch.nextBuffer;
      endEvents.push(['flush']);
      return batch.promise;
    };
    sleepingPlayer._invalidateListenCoverage = () =>
      endEvents.push(['invalidate']);
    sleepingPlayer._scrobble = () => endEvents.push(['scrobble']);
    sleepingPlayer._setPlaying = value => endEvents.push(['setPlaying', value]);
    sleepingPlayer._playNextTrack = () => endEvents.push(['next']);
    sleepingPlayer._sleepEndMode = true;
    sleepingPlayer._currentTrack = { id: 'end-track' };
    sleepingPlayer.isPersonalFM = false;
    sleepingPlayer.repeatMode = 'off';
    sleepingPlayer._nextTrackCallback();
    assert.deepStrictEqual(endPersisted, [
      {
        id: 'pod::end',
        totalSec: 120,
        payload: {
          secs: [118, 119],
          wallDeltaSec: 2,
          contentDeltaSec: 2,
        },
      },
    ]);
    assert.ok(endEvents.some(([type]) => type === 'flush'));
    assert.ok(endEvents.some(([type]) => type === 'invalidate'));
    assert.ok(
      endEvents.some(
        ([type, value]) => type === 'setPlaying' && value === false
      )
    );
    assert.ok(!endEvents.some(([type]) => type === 'next'));
    assert.strictEqual(sleepingPlayer._sleepEndMode, false);

    const normalEndEvents = [];
    const normalPlayer = Object.create(Player.prototype);
    normalPlayer._listenBuf = {
      id: 'pod::normal-end',
      totalSec: 120,
      secs: [118],
      wall: 1,
      content: 1,
      count: 1,
    };
    normalPlayer._flushListenBuf = () => {
      const batch = coverage.flushListenBuffer(
        normalPlayer._listenBuf,
        () => {}
      );
      normalPlayer._listenBuf = batch.nextBuffer;
      normalEndEvents.push(['flush']);
      return batch.promise;
    };
    normalPlayer._invalidateListenCoverage = () =>
      normalEndEvents.push(['invalidate']);
    normalPlayer._scrobble = () => normalEndEvents.push(['scrobble']);
    normalPlayer._playNextTrack = () => normalEndEvents.push(['next']);
    normalPlayer._sleepEndMode = false;
    normalPlayer._currentTrack = { id: 'normal-end-track' };
    normalPlayer.isPersonalFM = false;
    normalPlayer.repeatMode = 'off';
    normalPlayer._nextTrackCallback();
    assert.ok(normalEndEvents.some(([type]) => type === 'flush'));
    assert.ok(normalEndEvents.some(([type]) => type === 'next'));

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
