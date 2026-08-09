const assert = require('assert');
const { EventEmitter } = require('events');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-asr-queue-lifecycle-')
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function validConfig() {
  return {
    ok: true,
    config: {
      modelFile: 'model.onnx',
      tokensFile: 'tokens.txt',
      vadModel: 'vad.onnx',
      numThreads: 1,
      language: 'auto',
      source: 'test',
    },
  };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stderr = new EventEmitter();
    this.killCalls = [];
  }

  kill(signal) {
    this.killCalls.push(signal || 'TERM');
    return true;
  }
}

async function buildModule() {
  const mocks = path.join(tempDir, 'mocks');
  fs.mkdirSync(mocks, { recursive: true });
  const electron = path.join(mocks, 'electron.js');
  const childProcess = path.join(mocks, 'child-process.js');
  const fakeFs = path.join(mocks, 'fs.js');
  const asrModel = path.join(mocks, 'asr-model.js');
  fs.writeFileSync(
    electron,
    `export const ipcMain = { handle(channel, handler) { global.__asrHarness.handlers[channel] = handler; } };
export const app = { isPackaged: false, getPath() { return global.__asrHarness.userData; } };
export const dialog = { showSaveDialog() { return Promise.resolve({ canceled: true }); } };\n`
  );
  fs.writeFileSync(
    childProcess,
    'export function spawn() { return global.__asrHarness.spawn(); }\n'
  );
  fs.writeFileSync(
    fakeFs,
    `const fakeFs = {
  existsSync(target) { return !!target; },
  mkdirSync() {},
  rmSync() {},
  rmdirSync() {},
  readFileSync() { return ''; },
  writeFileSync() {},
};
export default fakeFs;\n`
  );
  fs.writeFileSync(
    asrModel,
    `export function getVerifiedModelConfigSync() { return global.__asrHarness.syncConfig; }
export function getVerifiedModelConfigForUse() { return global.__asrHarness.nextConfig(); }
export function isAsrPlatformSupported() { return true; }\n`
  );
  const outfile = path.join(tempDir, 'asr.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'electron', 'asr.js')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'asr-lifecycle-mocks',
        setup(build) {
          const aliases = {
            electron,
            child_process: childProcess,
            fs: fakeFs,
            './asrModelManager': asrModel,
          };
          Object.keys(aliases).forEach(key => {
            build.onResolve({ filter: new RegExp(`^${key}$`) }, () => ({
              path: aliases[key],
            }));
          });
        },
      },
    ],
  });
  return outfile;
}

function createHarness(configs, spawnPlan = [], mediaManager) {
  const events = [];
  const children = [];
  const configQueue = configs.slice();
  const spawnQueue = spawnPlan.slice();
  return {
    handlers: {},
    events,
    children,
    userData: path.join(tempDir, 'user-data'),
    syncConfig: null,
    nextConfig() {
      const next = configQueue.shift();
      return next || Promise.resolve(validConfig());
    },
    spawn() {
      const plan = spawnQueue.length ? spawnQueue.shift() : 'running';
      if (plan === 'throw') throw new Error('spawn-throw');
      const child = new FakeChild(
        plan === 'spawn-error' ? undefined : 1000 + children.length
      );
      children.push(child);
      return child;
    },
    getWindow() {
      return {
        isDestroyed() {
          return false;
        },
        webContents: {
          send(channel, payload) {
            events.push({ channel, payload });
          },
        },
      };
    },
    mediaManager: mediaManager || {
      acquire(request) {
        return Promise.resolve({
          sourceType: 'persistent',
          localPath: request.persistentPath || request.audioPath,
          ownerToken: request.ownerToken,
          release() {
            return Promise.resolve({ ok: true });
          },
        });
      },
      release() {
        return Promise.resolve({ ok: true });
      },
      releaseEpisode() {
        return Promise.resolve({ ok: true });
      },
    },
  };
}

async function createRuntime(outfile, configs, spawnPlan, mediaManager) {
  global.__asrHarness = createHarness(configs, spawnPlan, mediaManager);
  delete require.cache[require.resolve(outfile)];
  const asr = require(outfile);
  asr.registerAsrIpc(
    global.__asrHarness.getWindow,
    {
      get() {
        return {};
      },
    },
    global.__asrHarness.mediaManager
  );
  return global.__asrHarness;
}

async function status(harness, episodeId) {
  return harness.handlers['asr:status'](null, { episodeId });
}

async function transcribe(harness, episodeId, options) {
  return harness.handlers['asr:transcribe'](
    null,
    Object.assign(
      {
        episodeId,
        audioPath: `C:/mock/${episodeId}.mp3`,
        title: episodeId,
        durationSec: 60,
      },
      options || {}
    )
  );
}

async function main() {
  try {
    const outfile = await buildModule();

    // Two simultaneous requests must reserve A before its async model check,
    // leaving B queued and preventing a second worker spawn.
    const firstConfig = deferred();
    let harness = await createRuntime(outfile, [firstConfig.promise]);
    assert.deepStrictEqual(await transcribe(harness, 'A'), {
      ok: true,
      queued: false,
    });
    assert.deepStrictEqual(await transcribe(harness, 'B'), {
      ok: true,
      queued: true,
    });
    let current = await status(harness, 'A');
    assert.strictEqual(current.activeStatus, 'starting');
    assert.deepStrictEqual(current.queued, ['B']);
    assert.strictEqual(harness.children.length, 0);
    firstConfig.resolve(validConfig());
    await flush();
    assert.strictEqual(harness.children.length, 1);
    assert.strictEqual((await status(harness, 'A')).activeStatus, 'running');
    harness.children[0].emit('error', new Error('runtime-only-error'));
    await flush();
    assert.strictEqual(
      harness.children.length,
      1,
      'a running child error must retain A until exit/close confirms termination'
    );
    current = await status(harness, 'A');
    assert.strictEqual(current.busyEpisodeId, 'A');
    assert.strictEqual(
      current.activeError.code,
      'worker-runtime-error-awaiting-exit'
    );
    harness.children[0].emit('close', 1, null);
    await flush();
    assert.strictEqual(harness.children.length, 2);
    harness.children[0].emit('exit', 1, null);
    assert.strictEqual(
      (await status(harness, 'B')).busyEpisodeId,
      'B',
      'late A exit must not clear B as the active owner'
    );
    assert.strictEqual(
      harness.events.filter(event => event.channel === 'asr:error').length,
      1,
      'error plus late exit must emit a single terminal error'
    );
    harness.children[1].emit('exit', 0, null);
    assert.strictEqual((await status(harness, 'B')).busy, false);

    // An async spawn failure has no pid/spawn confirmation, so it is safe to
    // settle immediately and continue with B.
    harness = await createRuntime(
      outfile,
      [Promise.resolve(validConfig()), Promise.resolve(validConfig())],
      ['spawn-error', 'running']
    );
    await transcribe(harness, 'spawn-failed-A');
    await transcribe(harness, 'spawn-failed-B');
    await flush();
    harness.children[0].emit('error', new Error('ENOENT'));
    await flush();
    assert.strictEqual(harness.children.length, 2);
    assert.strictEqual(
      (await status(harness, 'spawn-failed-B')).busyEpisodeId,
      'spawn-failed-B'
    );
    assert.strictEqual(
      harness.events.filter(event => event.channel === 'asr:error').length,
      1,
      'spawn failure reports one terminal error before starting B'
    );

    // A synchronous spawn throw follows the same safe settlement path.
    harness = await createRuntime(
      outfile,
      [Promise.resolve(validConfig()), Promise.resolve(validConfig())],
      ['throw', 'running']
    );
    await transcribe(harness, 'spawn-throw-A');
    await transcribe(harness, 'spawn-throw-B');
    await flush();
    assert.strictEqual(harness.children.length, 1);
    assert.strictEqual(
      (await status(harness, 'spawn-throw-B')).busyEpisodeId,
      'spawn-throw-B'
    );

    // A duplicate request while starting is coalesced, rather than spawning a
    // second worker after the deferred model verification resolves.
    const duplicateConfig = deferred();
    harness = await createRuntime(outfile, [duplicateConfig.promise]);
    await transcribe(harness, 'same');
    assert.deepStrictEqual(await transcribe(harness, 'same'), {
      ok: true,
      already: true,
    });
    duplicateConfig.resolve(validConfig());
    await flush();
    assert.strictEqual(harness.children.length, 1);

    // Cancellation during the starting phase must settle immediately and the
    // late config response must never spawn a worker.
    const cancelConfig = deferred();
    harness = await createRuntime(outfile, [cancelConfig.promise]);
    await transcribe(harness, 'cancel-starting');
    assert.deepStrictEqual(
      await harness.handlers['asr:cancel'](null, {
        episodeId: 'cancel-starting',
      }),
      { ok: true }
    );
    assert.strictEqual((await status(harness, 'cancel-starting')).busy, false);
    cancelConfig.resolve(validConfig());
    await flush();
    assert.strictEqual(harness.children.length, 0);
    assert.strictEqual(
      harness.events.filter(event => event.channel === 'asr:canceled').length,
      1
    );

    // Renderer pause reaches the IPC handler, retains the exact transient
    // owner after the worker closes, and a later explicit resume starts a new
    // ASR owner. The media manager smoke separately proves that the retained
    // owner directory/Ranged .part is reused rather than downloaded again.
    const lifecycleReleases = [];
    const lifecycleAcquires = [];
    harness = await createRuntime(
      outfile,
      [Promise.resolve(validConfig()), Promise.resolve(validConfig())],
      ['running', 'running'],
      {
        acquire(request) {
          lifecycleAcquires.push(request);
          return Promise.resolve({
            sourceType: 'transient',
            localPath: `C:/mock/${request.ownerToken}.mp3`,
            ownerToken: request.ownerToken,
            release(reason) {
              lifecycleReleases.push({ ownerToken: request.ownerToken, reason });
              return Promise.resolve({ ok: true });
            },
          });
        },
        release() {
          return Promise.resolve({ ok: true });
        },
        releaseEpisode() {
          return Promise.resolve({ ok: true });
        },
      }
    );
    await transcribe(harness, 'pause-resume');
    await flush();
    const pausedChild = harness.children[0];
    assert.deepStrictEqual(
      await harness.handlers['asr:pause'](null, { episodeId: 'pause-resume' }),
      { ok: true, paused: true }
    );
    assert.strictEqual(pausedChild.killCalls.length, 1);
    pausedChild.emit('close', null, 'SIGTERM');
    await flush();
    assert.deepStrictEqual(lifecycleReleases, [
      { ownerToken: lifecycleAcquires[0].ownerToken, reason: 'paused' },
    ]);
    assert.strictEqual(
      harness.events.filter(event => event.channel === 'asr:paused').length,
      1
    );
    await transcribe(harness, 'pause-resume', { resume: true });
    await flush();
    assert.strictEqual(lifecycleAcquires.length, 2);

    // Queue cancellation is destructive only for its task-local media. It
    // never turns a queued job into a paused continuation.
    const queueReleases = [];
    harness = await createRuntime(
      outfile,
      [Promise.resolve(validConfig()), Promise.resolve(validConfig())],
      ['running', 'running'],
      {
        acquire(request) {
          return Promise.resolve({
            sourceType: 'transient',
            localPath: `C:/mock/${request.ownerToken}.mp3`,
            ownerToken: request.ownerToken,
            release(reason) {
              queueReleases.push({ ownerToken: request.ownerToken, reason });
              return Promise.resolve({ ok: true });
            },
          });
        },
        release(ownerToken, reason) {
          queueReleases.push({ ownerToken, reason });
          return Promise.resolve({ ok: true });
        },
        releaseEpisode() {
          return Promise.resolve({ ok: true });
        },
      }
    );
    await transcribe(harness, 'queue-owner-A');
    await transcribe(harness, 'queue-owner-B');
    await flush();
    await harness.handlers['asr:cancel'](null, { episodeId: 'queue-owner-B' });
    await flush();
    assert.strictEqual(
      queueReleases.some(item => item.reason === 'canceled-delete'),
      true
    );

    // A canceled running child may still emit a late done message; it must not
    // write a visible success state after cancellation.
    harness = await createRuntime(outfile, [Promise.resolve(validConfig())]);
    await transcribe(harness, 'late-message');
    await flush();
    const child = harness.children[0];
    await harness.handlers['asr:cancel'](null, { episodeId: 'late-message' });
    child.emit('message', { type: 'done', segCount: 9 });
    child.emit('exit', null, 'SIGTERM');
    assert.strictEqual(
      harness.events.filter(event => event.channel === 'asr:done').length,
      0,
      'late worker messages must not complete a canceled job'
    );
    assert.strictEqual(
      harness.events.filter(event => event.channel === 'asr:canceled').length,
      1
    );

    // Some child-process failures surface as close without a usable exit
    // sequence. That terminal event must release the active slot as well.
    harness = await createRuntime(outfile, [Promise.resolve(validConfig())]);
    await transcribe(harness, 'close-only');
    await flush();
    harness.children[0].emit('close', 1, null);
    assert.strictEqual((await status(harness, 'close-only')).busy, false);
    assert.strictEqual(
      harness.events.filter(event => event.channel === 'asr:error').length,
      1
    );

    // Model preflight runs before source acquisition. A missing local model
    // must not start a transient network request or create a media owner.
    let acquireCalls = 0;
    harness = await createRuntime(
      outfile,
      [Promise.resolve({ ok: false, error: 'model-missing' })],
      [],
      {
        acquire() {
          acquireCalls += 1;
          return Promise.resolve({ localPath: 'C:/mock/unreachable.mp3' });
        },
        release() {
          return Promise.resolve({ ok: true });
        },
        releaseEpisode() {
          return Promise.resolve({ ok: true });
        },
      }
    );
    await transcribe(harness, 'no-model-network');
    await flush();
    assert.strictEqual(acquireCalls, 0);
    assert.strictEqual(
      harness.events.some(
        event =>
          event.channel === 'asr:error' &&
          event.payload.error === 'model-missing'
      ),
      true
    );

    // A transient source survives the worker close only until the renderer
    // acknowledges that the transcript was persisted; then its exact owner is
    // released. A foreign token is fail-closed.
    const released = [];
    harness = await createRuntime(
      outfile,
      [Promise.resolve(validConfig())],
      ['running'],
      {
        acquire(request) {
          return Promise.resolve({
            sourceType: 'transient',
            localPath: 'C:/mock/transient.mp3',
            ownerToken: request.ownerToken,
            release() {
              return Promise.resolve({ ok: true });
            },
          });
        },
        release(ownerToken, reason) {
          released.push({ ownerToken, reason });
          return Promise.resolve({ ok: true });
        },
        releaseEpisode() {
          return Promise.resolve({ ok: true });
        },
      }
    );
    await transcribe(harness, 'persisted-source');
    await flush();
    const transientChild = harness.children[0];
    transientChild.emit('message', { type: 'done', segCount: 1 });
    transientChild.emit('close', 0, null);
    await flush();
    const done = harness.events.find(event => event.channel === 'asr:done');
    assert(done && done.payload.ownerToken);
    assert.deepStrictEqual(
      await harness.handlers['asr:source:release'](null, {
        episodeId: 'persisted-source',
        ownerToken: 'foreign-owner',
        outcome: 'done',
      }),
      { ok: false, error: 'invalid-transcript-media-owner' }
    );
    assert.deepStrictEqual(
      await harness.handlers['asr:source:release'](null, {
        episodeId: 'persisted-source',
        ownerToken: done.payload.ownerToken,
        outcome: 'done',
      }),
      { ok: true }
    );
    assert.deepStrictEqual(released, [
      { ownerToken: done.payload.ownerToken, reason: 'done' },
    ]);

    process.stdout.write('asr queue lifecycle smoke: PASS\n');
  } finally {
    delete global.__asrHarness;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
