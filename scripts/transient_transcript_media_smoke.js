const assert = require('assert');
const crypto = require('crypto');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-transient-transcript-media-')
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

async function buildModule() {
  const mocks = path.join(tempDir, 'mocks');
  fs.mkdirSync(mocks, { recursive: true });
  const electron = path.join(mocks, 'electron.js');
  const downloads = path.join(mocks, 'downloads.js');
  const range = path.join(mocks, 'range.js');
  const taskState = path.join(mocks, 'task-state.js');
  fs.writeFileSync(
    electron,
    `export const app = { getPath() { return global.__mediaHarness.userData; } };
export const ipcMain = { handle(channel, handler) { global.__mediaHarness.handlers[channel] = handler; } };
`
  );
  fs.writeFileSync(
    downloads,
    `import path from 'path';
export function getPodcastsDir() { return path.join(global.__mediaHarness.userData, 'podcasts'); }
export function guessExt() { return '.mp3'; }
export function streamGetWithFallback() { throw new Error('network should be injected in this smoke'); }
`
  );
  fs.writeFileSync(
    range,
    `export function inspectRangeResponse(status, contentRange, start) {
  if (status === 206 && String(contentRange || '').indexOf('bytes ' + start + '-') === 0) return { ok: true, total: 100 };
  return { ok: false, error: status === 200 ? 'range-status' : 'range-mismatch' };
}
`
  );
  fs.writeFileSync(
    taskState,
    `import path from 'path';
export function isPathInsideDirectory(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
`
  );
  const outfile = path.join(tempDir, 'transcript-media.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/electron/transcriptMediaSource.js')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'transient-media-mocks',
        setup(build) {
          const aliases = {
            electron,
            './podcastDownload': downloads,
            './downloadResumePolicy': range,
            './downloadTaskState': taskState,
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
  return require(outfile);
}

function newHarness() {
  const userData = path.join(
    tempDir,
    'user-data-' + Math.random().toString(16).slice(2)
  );
  fs.mkdirSync(userData, { recursive: true });
  return { userData, handlers: {} };
}

function writeMedia(record, bytes) {
  fs.mkdirSync(record.dir, { recursive: true });
  fs.writeFileSync(record.finalPath, Buffer.alloc(bytes || 16, 1));
  return record.finalPath;
}

async function main() {
  try {
    const mod = await buildModule();

    // A finished permanent download is reused without any temporary network or
    // directory. The manager never knows about Dexie/download-list state.
    global.__mediaHarness = newHarness();
    const podcastsDir = path.join(global.__mediaHarness.userData, 'podcasts');
    fs.mkdirSync(podcastsDir, { recursive: true });
    const persistent = path.join(podcastsDir, 'feed', 'episode.mp3');
    fs.mkdirSync(path.dirname(persistent), { recursive: true });
    fs.writeFileSync(persistent, 'persistent');
    let fetchCalls = 0;
    let manager = mod.createTranscriptMediaManager({
      fetchToFile() {
        fetchCalls += 1;
      },
    });
    let source = await manager.acquire({
      episodeId: 'feed::persistent',
      ownerToken: 'persistent-owner',
      persistentPath: persistent,
      audioUrl: 'https://cdn.example.test/episode.mp3',
    });
    assert.strictEqual(source.sourceType, 'persistent');
    assert.strictEqual(source.localPath, persistent);
    assert.strictEqual(fetchCalls, 0);

    // When a user-started permanent download is already active, ASR waits for
    // its final file and reuses it. A failed permanent attempt instead falls
    // back to task-local media without touching download records.
    global.__mediaHarness = newHarness();
    const waitedPodcastsDir = path.join(
      global.__mediaHarness.userData,
      'podcasts'
    );
    const waitedPersistent = path.join(waitedPodcastsDir, 'feed', 'waited.mp3');
    let persistentPolls = 0;
    fetchCalls = 0;
    manager = mod.createTranscriptMediaManager({
      config: { waitForPersistentPollMs: 0 },
      getPersistentInfo() {
        persistentPolls += 1;
        if (persistentPolls === 1)
          return { active: true, finalPath: waitedPersistent };
        fs.mkdirSync(path.dirname(waitedPersistent), { recursive: true });
        fs.writeFileSync(waitedPersistent, 'finished by download');
        return { active: false, finalPath: waitedPersistent };
      },
      fetchToFile() {
        fetchCalls += 1;
      },
    });
    source = await manager.acquire({
      episodeId: 'feed::wait-permanent',
      ownerToken: 'wait-owner',
      audioUrl: 'https://cdn.example.test/waited.mp3',
    });
    assert.strictEqual(source.sourceType, 'persistent');
    assert.strictEqual(source.localPath, waitedPersistent);
    assert.strictEqual(fetchCalls, 0);

    // A permanent download remains the owner even beyond the old 45-second
    // fallback threshold. The transcript request waits until it has actually
    // settled, then reuses the final file instead of starting a second request.
    global.__mediaHarness = newHarness();
    const longWaitedPersistent = path.join(
      global.__mediaHarness.userData,
      'podcasts',
      'feed',
      'long-waited.mp3'
    );
    persistentPolls = 0;
    let logicalWaitMs = 0;
    fetchCalls = 0;
    manager = mod.createTranscriptMediaManager({
      config: { waitForPersistentPollMs: 1000 },
      wait(ms) {
        logicalWaitMs += ms;
        return Promise.resolve();
      },
      getPersistentInfo() {
        persistentPolls += 1;
        if (persistentPolls <= 61) {
          return { active: true, finalPath: longWaitedPersistent };
        }
        fs.mkdirSync(path.dirname(longWaitedPersistent), { recursive: true });
        fs.writeFileSync(longWaitedPersistent, 'finished after a long download');
        return { active: false, finalPath: longWaitedPersistent };
      },
      fetchToFile() {
        fetchCalls += 1;
      },
    });
    source = await manager.acquire({
      episodeId: 'feed::long-wait-permanent',
      ownerToken: 'long-wait-owner',
      audioUrl: 'https://cdn.example.test/long-waited.mp3',
    });
    assert.strictEqual(source.sourceType, 'persistent');
    assert.strictEqual(logicalWaitMs > 45000, true);
    assert.strictEqual(fetchCalls, 0);

    global.__mediaHarness = newHarness();
    fetchCalls = 0;
    manager = mod.createTranscriptMediaManager({
      config: { waitForPersistentPollMs: 0 },
      getPersistentInfo() {
        return { active: false, finalPath: '' };
      },
      fetchToFile(record) {
        fetchCalls += 1;
        return Promise.resolve(writeMedia(record, 24));
      },
    });
    source = await manager.acquire({
      episodeId: 'feed::fallback-after-download',
      ownerToken: 'fallback-owner',
      audioUrl: 'https://cdn.example.test/fallback.mp3',
    });
    assert.strictEqual(source.sourceType, 'transient');
    assert.strictEqual(fetchCalls, 1);
    await source.release('done');

    // An undownloaded episode receives an owner-isolated task-local file, then
    // release removes it. No temporary path is placed under the permanent
    // podcasts root.
    global.__mediaHarness = newHarness();
    fetchCalls = 0;
    manager = mod.createTranscriptMediaManager({
      fetchToFile(record, report) {
        fetchCalls += 1;
        report(50, 100);
        report(100, 100);
        return Promise.resolve(writeMedia(record, 100));
      },
    });
    const progress = [];
    source = await manager.acquire({
      episodeId: 'feed::temporary',
      ownerToken: 'temporary-owner',
      audioUrl: 'https://cdn.example.test/temporary.mp3',
      onProgress(value) {
        progress.push(value);
      },
    });
    assert.strictEqual(source.sourceType, 'transient');
    assert.strictEqual(fetchCalls, 1);
    assert.strictEqual(fs.existsSync(source.localPath), true);
    assert.strictEqual(
      source.localPath.includes(path.join('podcasts', '')),
      false
    );
    assert.strictEqual(progress.length, 2);
    await source.release('done');
    assert.strictEqual(fs.existsSync(source.localPath), false);
    assert.deepStrictEqual(manager.getStats(), {
      count: 0,
      bytes: 0,
      pausedCount: 0,
      partCount: 0,
    });

    // A late completion acknowledgement from owner A must not remove owner B
    // for the same episode. Owner isolation is the cleanup authority, not a
    // best-effort episode-wide delete.
    global.__mediaHarness = newHarness();
    manager = mod.createTranscriptMediaManager({
      fetchToFile(record) {
        return Promise.resolve(writeMedia(record, 32));
      },
    });
    const ownerA = await manager.acquire({
      episodeId: 'feed::same-episode',
      ownerToken: 'owner-a',
      audioUrl: 'https://cdn.example.test/same.mp3',
    });
    const ownerB = await manager.acquire({
      episodeId: 'feed::same-episode',
      ownerToken: 'owner-b',
      audioUrl: 'https://cdn.example.test/same.mp3',
    });
    assert.notStrictEqual(ownerA.localPath, ownerB.localPath);
    await ownerA.release('done');
    assert.strictEqual(fs.existsSync(ownerB.localPath), true);
    await ownerB.release('done');

    // Repeated activation with the same owner coalesces. A cancellation that
    // races a late fetch result cannot recreate the deleted source directory.
    global.__mediaHarness = newHarness();
    const late = deferred();
    fetchCalls = 0;
    manager = mod.createTranscriptMediaManager({
      fetchToFile(record) {
        fetchCalls += 1;
        late.promise.then(() => writeMedia(record, 32));
        return late.promise.then(() => record.finalPath);
      },
    });
    const first = manager.acquire({
      episodeId: 'feed::late',
      ownerToken: 'late-owner',
      audioUrl: 'https://cdn.example.test/late.mp3',
    });
    const duplicate = manager.acquire({
      episodeId: 'feed::late',
      ownerToken: 'late-owner',
      audioUrl: 'https://cdn.example.test/late.mp3',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(fetchCalls, 1);
    await manager.release('late-owner', 'canceled');
    late.resolve();
    await assert.rejects(first, /已取消准备音频/);
    await assert.rejects(duplicate, /已取消准备音频/);
    assert.strictEqual(fs.existsSync(manager.rootDir()), true);
    assert.strictEqual(manager.getStats().count, 0);

    // Paused media can be retained for a bounded continuation, while manual
    // cleanup removes it. Completed/canceled media always removes immediately.
    global.__mediaHarness = newHarness();
    manager = mod.createTranscriptMediaManager({
      fetchToFile(record) {
        return Promise.resolve(writeMedia(record, 80));
      },
    });
    source = await manager.acquire({
      episodeId: 'feed::paused',
      ownerToken: 'paused-owner',
      audioUrl: 'https://cdn.example.test/paused.mp3',
    });
    await source.release('paused');
    assert.strictEqual(manager.getStats().pausedCount, 1);
    const resumed = await manager.acquire({
      episodeId: 'feed::paused',
      ownerToken: 'paused-owner-next',
      audioUrl: 'https://cdn.example.test/paused.mp3',
    });
    assert.strictEqual(
      resumed.localPath,
      source.localPath,
      'a paused task may retain its task-local audio for the next ASR owner'
    );
    await resumed.release('paused');
    assert.strictEqual(manager.cleanupInactive({ manual: true }).count, 0);

    // A transient source held by a live owner survives manual cleanup. The
    // cleanup command only removes inactive manifest-owned directories.
    global.__mediaHarness = newHarness();
    manager = mod.createTranscriptMediaManager({
      fetchToFile(record) {
        return Promise.resolve(writeMedia(record, 48));
      },
    });
    source = await manager.acquire({
      episodeId: 'feed::manual-cleanup-active',
      ownerToken: 'manual-active-owner',
      audioUrl: 'https://cdn.example.test/manual-active.mp3',
    });
    manager.cleanupInactive({ manual: true });
    assert.strictEqual(fs.existsSync(source.localPath), true);
    await source.release('done');

    // Retryable failures retain an owned .part for bounded Range continuation;
    // permanent HTTP failures discard it. Neither path adds a download record.
    global.__mediaHarness = newHarness();
    manager = mod.createTranscriptMediaManager({
      fetchToFile(record) {
        fs.mkdirSync(record.dir, { recursive: true });
        fs.writeFileSync(record.partPath, Buffer.alloc(21, 3));
        const error = new Error('ECONNRESET');
        error.code = 'ECONNRESET';
        return Promise.reject(error);
      },
    });
    await assert.rejects(
      manager.acquire({
        episodeId: 'feed::retryable',
        ownerToken: 'retryable-owner',
        audioUrl: 'https://cdn.example.test/retryable.mp3',
      }),
      /ECONNRESET/
    );
    await manager.release('retryable-owner', 'error');
    assert.strictEqual(manager.getStats().partCount, 1);
    await manager.releaseEpisode('feed::retryable', 'canceled-delete');
    assert.strictEqual(manager.getStats().count, 0);

    global.__mediaHarness = newHarness();
    manager = mod.createTranscriptMediaManager({
      fetchToFile(record) {
        fs.mkdirSync(record.dir, { recursive: true });
        fs.writeFileSync(record.partPath, Buffer.alloc(21, 4));
        return Promise.reject(new Error('HTTP 404'));
      },
    });
    await assert.rejects(
      manager.acquire({
        episodeId: 'feed::fatal',
        ownerToken: 'fatal-owner',
        audioUrl: 'https://cdn.example.test/fatal.mp3',
      }),
      /HTTP 404/
    );
    await manager.release('fatal-owner', 'error');
    assert.strictEqual(manager.getStats().count, 0);

    // A retry resumes into the original .part path even if a later response
    // reports a different content type. The Range bytes append to the first
    // 40 bytes instead of creating an invalid second partial file.
    global.__mediaHarness = newHarness();
    manager = mod.createTranscriptMediaManager({
      streamGet(_url, rangeStart) {
        assert.strictEqual(rangeStart, 40);
        const response = Readable.from([Buffer.alloc(60, 2)]);
        response.headers = {
          'content-length': '60',
          'content-range': 'bytes 40-99/100',
          'content-type': 'audio/mp4',
        };
        return Promise.resolve({
          status: 206,
          res: response,
          finalUrl: 'https://redirected.example.test/resume.m4a',
        });
      },
    });
    const resumeRoot = manager.rootDir();
    const priorDir = mod.transcriptMediaDirectory(
      resumeRoot,
      'feed::range',
      'range-old-owner'
    );
    fs.mkdirSync(priorDir, { recursive: true });
    fs.writeFileSync(
      path.join(priorDir, 'audio.mp3.part'),
      Buffer.alloc(40, 1)
    );
    fs.writeFileSync(
      path.join(priorDir, 'manifest.json'),
      JSON.stringify({
        status: 'retryable',
        sourceUrlHash: crypto
          .createHash('sha256')
          .update('https://cdn.example.test/range.mp3')
          .digest('hex'),
        partName: 'audio.mp3.part',
        updatedAt: Date.now(),
      })
    );
    source = await manager.acquire({
      episodeId: 'feed::range',
      ownerToken: 'range-new-owner',
      audioUrl: 'https://cdn.example.test/range.mp3',
    });
    const resumedBytes = fs.readFileSync(source.localPath);
    assert.strictEqual(path.basename(source.localPath), 'audio.mp3');
    assert.strictEqual(resumedBytes.length, 100);
    assert.strictEqual(resumedBytes[0], 1);
    assert.strictEqual(resumedBytes[39], 1);
    assert.strictEqual(resumedBytes[40], 2);
    assert.strictEqual(resumedBytes[99], 2);
    await source.release('done');

    // The profile-owned root has one shared cap. A known Content-Length that
    // cannot fit must fail before any media bytes are written.
    global.__mediaHarness = newHarness();
    manager = mod.createTranscriptMediaManager({
      config: { totalMaxBytes: 64, budgetCheckBytes: 16 },
      streamGet() {
        const response = Readable.from([Buffer.alloc(80, 7)]);
        response.headers = {
          'content-length': '80',
          'content-type': 'audio/mpeg',
        };
        return Promise.resolve({
          status: 200,
          res: response,
          finalUrl: 'https://cdn.example.test/too-large.mp3',
        });
      },
    });
    await assert.rejects(
      manager.acquire({
        episodeId: 'feed::too-large',
        ownerToken: 'capacity-owner',
        audioUrl: 'https://cdn.example.test/too-large.mp3',
      }),
      error => error && error.code === 'transcript-media-cap-exceeded'
    );
    assert.strictEqual(manager.getStats().bytes, 0);
    await manager.release('capacity-owner', 'canceled');

    // Servers may omit Content-Length. The stream is still checked at bounded
    // byte intervals and cannot grow past the same root-wide budget.
    global.__mediaHarness = newHarness();
    manager = mod.createTranscriptMediaManager({
      config: { totalMaxBytes: 64, budgetCheckBytes: 1 },
      streamGet() {
        const response = Readable.from([Buffer.alloc(80, 9)]);
        response.headers = { 'content-type': 'audio/mpeg' };
        return Promise.resolve({
          status: 200,
          res: response,
          finalUrl: 'https://cdn.example.test/unknown-size.mp3',
        });
      },
    });
    await assert.rejects(
      manager.acquire({
        episodeId: 'feed::unknown-size',
        ownerToken: 'unknown-size-owner',
        audioUrl: 'https://cdn.example.test/unknown-size.mp3',
      }),
      error => error && error.code === 'transcript-media-cap-exceeded'
    );
    await manager.release('unknown-size-owner', 'canceled');

    // Safety helpers make bad URLs and filename/path traversal fail before a
    // request can write outside the profile-owned transcript-media root.
    assert.throws(
      () => mod.normalizeTranscriptAudioUrl('file:///C:/secret.mp3'),
      /不支持的音频地址/
    );
    assert.strictEqual(
      mod.isSafeTranscriptMediaFileName('../escape.mp3'),
      false
    );
    assert.strictEqual(
      mod.isSafeTranscriptMediaFileName('audio.mp3.part'),
      true
    );
    assert.deepStrictEqual(
      mod.validateTranscriptRangeResponse(206, 'bytes 40-99/100', 40),
      { ok: true, total: 100 }
    );
    assert.strictEqual(
      mod.validateTranscriptRangeResponse(200, '', 40).ok,
      false
    );

    // Startup cleanup only touches manifest-owned, inactive directories.
    global.__mediaHarness = newHarness();
    manager = mod.createTranscriptMediaManager();
    const orphanDir = mod.transcriptMediaDirectory(
      manager.rootDir(),
      'feed::orphan'
    );
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'audio.mp3'), 'orphan');
    fs.writeFileSync(
      path.join(orphanDir, 'manifest.json'),
      JSON.stringify({
        status: 'ready',
        fileName: 'audio.mp3',
        updatedAt: Date.now(),
      })
    );
    manager.cleanupInactive();
    assert.strictEqual(fs.existsSync(orphanDir), false);

    process.stdout.write('transient transcript media smoke: PASS\n');
  } finally {
    delete global.__mediaHarness;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
