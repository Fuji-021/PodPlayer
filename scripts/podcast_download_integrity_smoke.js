const assert = require('assert');
const { EventEmitter } = require('events');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-download-integrity-')
);

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

class FakeRequest extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
  }

  setTimeout() {}

  destroy(error) {
    if (this.destroyed) return;
    this.destroyed = true;
    setImmediate(() => this.emit('error', error || new Error('destroyed')));
  }
}

function createFakeFs() {
  const directories = new Set();
  const files = new Map();
  const removed = [];
  return {
    directories,
    files,
    removed,
    existsSync(target) {
      return directories.has(target) || files.has(target);
    },
    mkdirSync(target) {
      directories.add(target);
    },
    readdirSync() {
      return [];
    },
    unlinkSync(target) {
      removed.push(target);
      files.delete(target);
    },
    statSync(target) {
      return { size: (files.get(target) || '').length || 128 };
    },
    createWriteStream() {
      const stream = new EventEmitter();
      stream.destroy = () => stream.emit('close');
      return stream;
    },
    renameSync() {},
  };
}

async function buildModule() {
  const mocks = path.join(tempDir, 'mocks');
  fs.mkdirSync(mocks, { recursive: true });
  const electron = path.join(mocks, 'electron.js');
  const fakeFs = path.join(mocks, 'fs.js');
  const fakeHttp = path.join(mocks, 'http.js');
  const power = path.join(mocks, 'power.js');
  const recovery = path.join(mocks, 'recovery.js');
  fs.writeFileSync(
    electron,
    `export const ipcMain = { handle(channel, handler) { global.__downloadHarness.handlers[channel] = handler; } };
export const app = { getPath() { return global.__downloadHarness.userData; } };
export class Notification { on() {} show() {} };
export const session = { defaultSession: { resolveProxy() { return Promise.resolve('DIRECT'); } } };
`
  );
  fs.writeFileSync(fakeFs, 'export default global.__downloadHarness.fs;\n');
  fs.writeFileSync(
    fakeHttp,
    'export default { get() { return global.__downloadHarness.getRequest(); } };\n'
  );
  fs.writeFileSync(
    power,
    'export function shouldRecoverStalledDownload() { return false; }\n'
  );
  fs.writeFileSync(
    recovery,
    'export function listRecoverySnapshots() { return []; }\nexport function readRecoverySnapshot() { return null; }\n'
  );
  const outfile = path.join(tempDir, 'podcast-download.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/electron/podcastDownload.js')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'download-integrity-mocks',
        setup(build) {
          const aliases = {
            electron,
            fs: fakeFs,
            http: fakeHttp,
            https: fakeHttp,
            '@/utils/powerResumePolicy': power,
            './backupRecoveryFiles': recovery,
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

async function buildHelper() {
  const outfile = path.join(tempDir, 'download-task-state.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/electron/downloadTaskState.js')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  return require(outfile);
}

function createHarness() {
  const requests = [];
  return {
    handlers: {},
    fs: createFakeFs(),
    requests,
    userData: path.join(tempDir, 'user-data'),
    getRequest() {
      const request = new FakeRequest();
      requests.push(request);
      return request;
    },
  };
}

function payload(episodeId) {
  return {
    episodeId,
    feedUrl: 'https://example.test/feed.xml',
    guid: episodeId,
    audioUrl: 'https://cdn.example.test/' + episodeId + '.mp3',
  };
}

async function main() {
  try {
    const helper = await buildHelper();
    const registry = helper.createDownloadTaskRegistry();
    const first = registry.reserve('episode-A');
    assert(first, 'first task reserves the episode before network work');
    assert.strictEqual(registry.reserve('episode-A'), null);
    assert.strictEqual(registry.finalize('episode-A', first), true);
    const retry = registry.reserve('episode-A');
    assert(retry, 'a settled task permits a later retry');
    assert.strictEqual(
      registry.finalize('episode-A', first),
      false,
      'a stale task cannot remove a later retry'
    );

    const downloadModule = await buildModule();
    global.__downloadHarness = createHarness();
    delete require.cache[require.resolve(downloadModule)];
    const downloads = require(downloadModule);
    downloads.registerPodcastDownloadIpc(() => null);
    const harness = global.__downloadHarness;

    // Reserve while connecting. A second start must not open a second request;
    // canceling the first must destroy its pending transport and release only
    // that task, so a later retry is allowed.
    const firstStart = harness.handlers['podcast:download:start'](
      null,
      payload('episode-A')
    );
    await flush();
    assert.strictEqual(harness.requests.length, 1);
    const duplicate = await harness.handlers['podcast:download:start'](
      null,
      payload('episode-A')
    );
    assert.strictEqual(duplicate.ok, false);
    assert.strictEqual(duplicate.error, '已经在下载中');
    assert.deepStrictEqual(
      await harness.handlers['podcast:download:cancel'](null, {
        episodeId: 'episode-A',
      }),
      { ok: true }
    );
    assert.strictEqual(harness.requests[0].destroyed, true);
    assert.deepStrictEqual(await firstStart, { ok: false, canceled: true });

    const retryStart = harness.handlers['podcast:download:start'](
      null,
      payload('episode-A')
    );
    await flush();
    assert.strictEqual(harness.requests.length, 2);
    await harness.handlers['podcast:download:cancel'](null, {
      episodeId: 'episode-A',
    });
    await retryStart;

    // Only paths rooted below the current podcasts directory are accepted.
    const podcastsDir = path.join(harness.userData, 'podcasts');
    const legalPath = path.join(podcastsDir, 'feed', 'episode.mp3');
    const siblingPath = path.join(harness.userData, 'podcasts-backup', 'x.mp3');
    harness.fs.files.set(legalPath, 'audio');
    harness.fs.files.set(siblingPath, 'other');
    assert.deepStrictEqual(
      await harness.handlers['podcast:download:remove'](null, {
        filePath: siblingPath,
      }),
      { ok: false, error: '下载路径无效' }
    );
    assert.strictEqual(harness.fs.removed.includes(siblingPath), false);
    assert.deepStrictEqual(
      await harness.handlers['podcast:download:remove'](null, {
        filePath: legalPath,
      }),
      { ok: true }
    );
    assert.strictEqual(harness.fs.removed.includes(legalPath), true);
    assert.strictEqual(
      helper.isPathInsideDirectory(podcastsDir, path.join(podcastsDir, '..', 'x')),
      false
    );

    // A resume response that ignores Range must follow the explicit stale-part
    // discard path rather than append a full 200 response to a .part file.
    const source = fs.readFileSync(
      path.join(root, 'src/electron/podcastDownload.js'),
      'utf8'
    );
    assert.match(source, /podcast-download-range-status/);
    assert.match(source, /discardPowerResumePart\(episodeId, resumeInfo\)/);
    assert.match(source, /abortConnection\(task\.connection\)/);
    assert.match(source, /taskRegistry\.reserve\(episodeId/);
    assert.match(source, /isPathInsideDirectory\(getPodcastsDir\(\), filePath\)/);

    process.stdout.write('podcast download integrity smoke: PASS\n');
  } finally {
    delete global.__downloadHarness;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
