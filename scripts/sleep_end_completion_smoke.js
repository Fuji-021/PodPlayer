const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-sleep-end-smoke-')
);

async function loadPolicy() {
  const output = path.join(tempDir, 'sleep-end-policy.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/podcast/sleepEndPolicy.js')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  return require(output);
}

function loadPlayer(events) {
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

function createNaturalEndPlayer(Player, events, handler) {
  const player = Object.create(Player.prototype);
  player._sleepEndMode = true;
  player._sleepEndCompletionHandler = handler;
  player._sleepEndCompletionToken = 0;
  player._currentTrack = { podcastEpisodeId: 'episode-1' };
  player._flushListenBuf = () => events.push(['flush']);
  player._invalidateListenCoverage = () => events.push(['invalidate']);
  player._scrobble = () => events.push(['scrobble']);
  player._setPlaying = value => events.push(['setPlaying', value]);
  player._playNextTrack = () => events.push(['next']);
  player.isPersonalFM = false;
  player.repeatMode = 'off';
  return player;
}

async function main() {
  try {
    const policy = await loadPolicy();

    assert.strictEqual(
      policy.shouldFinishSleepAtEnd({
        sleepMode: 'end',
        duration: 100,
        progress: 98.2,
        playing: true,
      }),
      true,
      'the normal polling path should finish while playback is still active'
    );
    assert.strictEqual(
      policy.shouldFinishSleepAtEnd({
        sleepMode: 'end',
        duration: 100,
        progress: 99,
        playing: false,
      }),
      false,
      'a manual pause near the end must not look like a sleep completion'
    );
    assert.deepStrictEqual(
      policy.getSleepCompletionPlan({
        alreadyStopped: true,
        sleepShutdown: true,
      }),
      { shouldPause: false, shouldStartShutdown: true },
      'the natural-end fallback should retain sleepShutdown without pausing twice'
    );

    const events = [];
    const Player = loadPlayer(events);
    const signals = [];
    const sleepingPlayer = createNaturalEndPlayer(Player, events, signal => {
      events.push(['handler']);
      signals.push(signal);
    });
    sleepingPlayer._nextTrackCallback();
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(signals)),
      [{ reason: 'natural-end', token: 1, trackId: 'episode-1' }],
      'an onend that arrives after polling must emit exactly one completion signal'
    );
    assert.ok(
      events.some(([type, value]) => type === 'setPlaying' && value === false)
    );
    assert.ok(
      events.findIndex(([type]) => type === 'setPlaying') <
        events.findIndex(([type]) => type === 'handler'),
      'Vue must receive the completion only after Player has stopped'
    );
    assert.ok(!events.some(([type]) => type === 'next'));
    assert.strictEqual(
      policy.shouldHandleNaturalSleepEnd({
        sleepMode: 'end',
        signal: signals[0],
      }),
      true
    );
    assert.strictEqual(
      policy.shouldHandleNaturalSleepEnd({
        sleepMode: 'off',
        signal: signals[0],
      }),
      false
    );

    const repeatEvents = [];
    const repeatPlayer = createNaturalEndPlayer(Player, repeatEvents, () => {});
    repeatPlayer._sleepEndMode = false;
    repeatPlayer.repeatMode = 'one';
    repeatPlayer.currentTrackID = 'repeat-track';
    repeatPlayer._currentTrack = { id: 'repeat-track' };
    repeatPlayer._replaceCurrentTrack = id => repeatEvents.push(['repeat', id]);
    repeatPlayer._nextTrackCallback();
    assert.deepStrictEqual(
      repeatEvents.filter(([type]) => type === 'repeat'),
      [['repeat', 'repeat-track']]
    );
    assert.ok(!repeatEvents.some(([type]) => type === 'next'));

    const normalEvents = [];
    const normalPlayer = createNaturalEndPlayer(Player, normalEvents, () => {});
    normalPlayer._sleepEndMode = false;
    normalPlayer._nextTrackCallback();
    assert.ok(
      normalEvents.some(([type]) => type === 'next'),
      'ordinary natural ends must continue through the existing next-track path'
    );

    process.stdout.write('sleep end completion smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
