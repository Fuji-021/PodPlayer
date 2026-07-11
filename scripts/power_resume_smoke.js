const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-power-smoke-')
);

async function bundle(entry, output, withRendererAliases) {
  const plugins = [];
  if (withRendererAliases) {
    const storeStub = path.join(tempDir, 'store-stub.js');
    fs.writeFileSync(storeStub, 'export default {};\n');
    plugins.push({
      name: 'renderer-aliases',
      setup(build) {
        build.onResolve({ filter: /^@\// }, args => {
          if (args.path === '@/store') return { path: storeStub };
          let resolved = path.join(root, 'src', args.path.slice(2));
          if (!path.extname(resolved)) resolved += '.js';
          return { path: resolved };
        });
      },
    });
  }
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(tempDir, output),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins,
  });
  return require(path.join(tempDir, output));
}

async function main() {
  try {
    const power = await bundle('src/utils/powerResumePolicy.js', 'power.cjs');
    const range = await bundle(
      'src/electron/downloadResumePolicy.js',
      'range.cjs'
    );
    const audio = await bundle(
      'src/utils/audioOutputDevices.js',
      'audio.cjs',
      true
    );

    const paused = power.createPlaybackSuspendSnapshot({
      token: 1,
      trackId: 'ep-1',
      wasPlaying: false,
      progress: 42,
    });
    assert.deepStrictEqual(
      power.planPlaybackResume({
        snapshot: paused,
        event: { token: 1 },
        handledToken: 0,
        currentTrackId: 'ep-1',
        currentPlaying: false,
        nodeUsable: true,
      }),
      { action: 'skip', reason: 'paused-and-healthy', consume: true }
    );

    const playing = power.createPlaybackSuspendSnapshot({
      token: 2,
      trackId: 'ep-2',
      wasPlaying: true,
      progress: 88,
    });
    assert.deepStrictEqual(
      power.planPlaybackResume({
        snapshot: playing,
        event: { token: 2 },
        handledToken: 0,
        currentTrackId: 'ep-2',
        currentPlaying: true,
        nodeUsable: false,
      }),
      { action: 'recover', autoplay: true, progress: 88, consume: true }
    );
    assert.strictEqual(
      power.planPlaybackResume({
        snapshot: playing,
        event: { token: 2 },
        handledToken: 2,
        currentTrackId: 'ep-2',
        currentPlaying: true,
        nodeUsable: false,
      }).reason,
      'stale-or-duplicate'
    );
    assert.strictEqual(
      power.planPlaybackResume({
        snapshot: playing,
        event: { token: 2 },
        handledToken: 0,
        currentTrackId: 'ep-2',
        currentPlaying: false,
        nodeUsable: false,
      }).reason,
      'intent-changed'
    );

    assert.strictEqual(
      power.decideOutputDeviceFallback('headset', [
        { kind: 'audiooutput', deviceId: 'headset' },
      ]).fallback,
      false
    );
    assert.deepStrictEqual(
      power.decideOutputDeviceFallback('headset', [
        { kind: 'audiooutput', deviceId: 'default' },
      ]),
      { fallback: true, deviceId: 'default', missingDeviceId: 'headset' }
    );
    assert.strictEqual(
      power.decideOutputDeviceFallback('headset', []).reason,
      'no-output-info'
    );

    const task = {
      powerSuspendToken: 7,
      powerResumeBytes: 1024,
      bytesDone: 1024,
      lastProgressAt: 100,
      settled: false,
      canceled: false,
    };
    assert.strictEqual(
      power.shouldRecoverStalledDownload(task, { token: 7, at: 200 }, 200),
      true
    );
    task.powerResumeAttemptedToken = 7;
    assert.strictEqual(
      power.shouldRecoverStalledDownload(task, { token: 7, at: 200 }, 200),
      false
    );
    task.powerResumeAttemptedToken = 0;
    task.bytesDone = 2048;
    assert.strictEqual(
      power.shouldRecoverStalledDownload(task, { token: 7, at: 200 }, 200),
      false
    );

    assert.deepStrictEqual(
      range.inspectRangeResponse(206, 'bytes 1024-2047/4096', 1024),
      { ok: true, total: 4096 }
    );
    assert.strictEqual(
      range.inspectRangeResponse(200, '', 1024).error,
      'range-status'
    );
    assert.strictEqual(
      range.inspectRangeResponse(206, 'bytes 0-1023/4096', 1024).error,
      'range-mismatch'
    );

    let devices = [{ kind: 'audiooutput', deviceId: 'headset' }];
    let deviceChangeHandler = null;
    let removedHandler = null;
    const mediaDevices = {
      enumerateDevices: async () => devices,
      addEventListener: (name, handler) => {
        if (name === 'devicechange') deviceChangeHandler = handler;
      },
      removeEventListener: (name, handler) => {
        if (name === 'devicechange') removedHandler = handler;
      },
    };
    const calls = { commit: 0, sink: 0, toast: 0 };
    const fakeStore = {
      state: { settings: { outputDevice: 'headset' } },
      commit: (_type, value) => {
        calls.commit++;
        fakeStore.state.settings.outputDevice = value;
      },
      dispatch: () => {
        calls.toast++;
      },
    };
    const fakePlayer = {
      setOutputDevice: async () => {
        calls.sink++;
        return { ok: true };
      },
    };
    const dispose = audio.installAudioOutputDeviceMonitor(fakePlayer, {
      mediaDevices,
      store: fakeStore,
      debounceMs: 0,
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepStrictEqual(calls, { commit: 0, sink: 0, toast: 0 });
    devices = [{ kind: 'audiooutput', deviceId: 'default' }];
    deviceChangeHandler();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepStrictEqual(calls, { commit: 1, sink: 1, toast: 1 });
    deviceChangeHandler();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepStrictEqual(calls, { commit: 1, sink: 1, toast: 1 });
    dispose();
    assert.strictEqual(removedHandler, deviceChangeHandler);
    assert.doesNotThrow(() =>
      audio.installAudioOutputDeviceMonitor(fakePlayer, {
        mediaDevices: {},
        store: fakeStore,
      })()
    );

    process.stdout.write('power resume smoke: PASS\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
