const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-backup-restore-')
);
const tables = [
  'podcasts',
  'episodes',
  'episodeProgress',
  'favorites',
  'episodeListenStats',
  'episodeDownloads',
  'listenDaily',
  'coverCache',
  'transcripts',
  'transcriptDict',
  'transcriptAi',
  'transcriptSummaries',
];

function clone(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((result, key) => {
      result[key] = clone(value[key]);
      return result;
    }, {});
  }
  return value;
}

function emptyTables() {
  return tables.reduce((result, table) => {
    result[table] = [];
    return result;
  }, {});
}

function makeBackup(overrides) {
  return {
    podcasts: [{ id: 'podcast-backup', feedUrl: 'https://feed.test' }],
    favorites: [{ id: 'favorite-backup' }],
    episodeProgress: [{ id: 'progress-backup', progress: 12 }],
    episodeListenStats: [{ id: 'stats-backup', bits: { 0: 1, 1: 2 } }],
    listenDaily: [{ key: '2026-07-28::podcast-backup' }],
    episodeDownloads: [{ id: 'download-backup' }],
    transcripts: [{ id: 'transcript-backup', text: 'backup transcript' }],
    transcriptDict: [{ id: 'dict-backup', to: 'backup' }],
    transcriptAi: [{ id: 'ai-backup', status: 'ready', segs: { 0: 'backup' } }],
    transcriptSummaries: [{ id: 'summary-backup', summary: 'backup summary' }],
    ...(overrides || {}),
  };
}

async function loadBackupModule() {
  const mockDir = path.join(tempDir, 'mocks');
  fs.mkdirSync(mockDir, { recursive: true });
  const db = path.join(mockDir, 'db.js');
  const service = path.join(mockDir, 'service.js');
  const podcastDb = path.join(mockDir, 'podcast-db.js');
  fs.writeFileSync(
    db,
    `function state() { return global.__backupRestoreHarness; }
function clone(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.keys(value).reduce((out, key) => { out[key] = clone(value[key]); return out; }, {});
  return value;
}
function table(name) {
  return {
    async toArray() { return clone(state().tables[name]); },
    async bulkPut(rows) {
      state().events.push('bulk:' + name);
      if (state().shouldFail && state().shouldFail(name)) throw new Error('forced-' + name);
      state().tables[name] = clone(rows);
      return rows.length;
    },
    async count() { return state().tables[name].length; },
  };
}
const names = ${JSON.stringify(tables)};
export const db = names.reduce((out, name) => { out[name] = table(name); return out; }, {
  async delete() { state().events.push('delete'); state().tables = names.reduce((out, name) => { out[name] = []; return out; }, {}); },
  async open() { state().events.push('open'); },
  async transaction(...args) {
    const fn = args[args.length - 1];
    const before = clone(state().tables);
    try { return await fn(); } catch (error) { state().tables = before; throw error; }
  },
});
`
  );
  fs.writeFileSync(
    service,
    "export function exportSubscriptionsOpml() { return Promise.resolve('<opml />'); }\n"
  );
  fs.writeFileSync(
    podcastDb,
    'export function clearPodcastMem() { global.__backupRestoreHarness.memCleared = true; }\n'
  );
  const outfile = path.join(tempDir, 'backup.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/utils/podcast/backup.js')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'backup-restore-mocks',
        setup(build) {
          const exact = {
            '@/utils/db': db,
            '@/utils/podcast/service': service,
            '@/utils/podcast/db': podcastDb,
          };
          Object.keys(exact).forEach(filter => {
            build.onResolve({ filter: new RegExp('^' + filter + '$') }, () => ({
              path: exact[filter],
            }));
          });
        },
      },
    ],
  });
  return require(outfile);
}

function resetHarness(backup, current) {
  const state = {
    backup: { ok: true, name: 'backup.json', json: JSON.stringify(backup) },
    tables: Object.assign(emptyTables(), clone(current || {})),
    events: [],
    recoverySnapshots: [],
    memCleared: false,
    shouldFail: null,
  };
  global.__backupRestoreHarness = state;
  return state;
}

async function main() {
  global.window = {
    require: () => ({
      ipcRenderer: {
        invoke(channel, payload) {
          const state = global.__backupRestoreHarness;
          if (channel === 'podcast:backup:readLatest')
            return Promise.resolve(state.backup);
          if (channel === 'podcast:backup:writeRecoverySnapshot') {
            state.events.push('recovery-snapshot');
            state.recoverySnapshots.push(payload.json);
            return Promise.resolve({ ok: true, name: 'pre-restore-test.json' });
          }
          if (channel === 'podcast:backup:write')
            return Promise.resolve({ ok: true });
          return Promise.resolve({
            ok: false,
            error: 'unexpected-ipc:' + channel,
          });
        },
      },
    }),
  };
  const backupModule = await loadBackupModule();

  const malformed = resetHarness(makeBackup());
  malformed.backup.json = '{not-json';
  const malformedResult = await backupModule.restoreFromLatestBackup();
  assert.strictEqual(malformedResult.ok, false);
  assert.strictEqual(malformedResult.code, 'invalid-backup-json');
  assert.deepStrictEqual(malformed.events, []);

  const invalidBits = resetHarness(
    makeBackup({ episodeListenStats: [{ id: 'bad', bits: { 0: 999 } }] })
  );
  const invalidBitsResult = await backupModule.restoreFromLatestBackup();
  assert.strictEqual(invalidBitsResult.ok, false);
  assert.strictEqual(invalidBitsResult.code, 'invalid-backup-bits');
  assert.deepStrictEqual(invalidBits.events, []);

  const legacyPayload = makeBackup();
  delete legacyPayload.transcriptSummaries;
  const legacy = resetHarness(legacyPayload, {
    transcripts: [{ id: 'old-transcript', text: 'old' }],
  });
  const legacyResult = await backupModule.restoreFromLatestBackup();
  assert.strictEqual(legacyResult.ok, true);
  assert.strictEqual(legacyResult.transcriptSummaries, 0);
  assert.ok(legacy.recoverySnapshots.length === 1);
  assert.deepStrictEqual(
    Array.from(legacy.tables.episodeListenStats[0].bits),
    [1, 2]
  );

  const currentTranscriptAssets = {
    transcripts: [{ id: 'new-transcript', text: 'new transcript' }],
    transcriptDict: [{ id: 'new-dict', to: 'new dict' }],
    transcriptAi: [{ id: 'new-ai', segs: { 0: 'new ai' }, status: 'ready' }],
    transcriptSummaries: [{ id: 'new-summary', summary: 'new summary' }],
  };
  const merge = resetHarness(makeBackup(), currentTranscriptAssets);
  const beforeAssets = clone({
    transcripts: merge.tables.transcripts,
    transcriptDict: merge.tables.transcriptDict,
    transcriptAi: merge.tables.transcriptAi,
    transcriptSummaries: merge.tables.transcriptSummaries,
  });
  const mergeResult = await backupModule.mergeRestoreHistoryFromLatestBackup({
    force: true,
  });
  assert.strictEqual(mergeResult.ok, true);
  assert.deepStrictEqual(
    {
      transcripts: merge.tables.transcripts,
      transcriptDict: merge.tables.transcriptDict,
      transcriptAi: merge.tables.transcriptAi,
      transcriptSummaries: merge.tables.transcriptSummaries,
    },
    beforeAssets,
    'history merge must never touch transcript-derived assets'
  );
  assert.deepStrictEqual(merge.tables.favorites, makeBackup().favorites);
  assert.deepStrictEqual(
    merge.events.filter(event => event.startsWith('bulk:')),
    [
      'bulk:favorites',
      'bulk:episodeProgress',
      'bulk:episodeListenStats',
      'bulk:listenDaily',
      'bulk:episodeDownloads',
    ]
  );

  const mergeFailure = resetHarness(makeBackup(), currentTranscriptAssets);
  const beforeMergeFailure = clone(mergeFailure.tables);
  mergeFailure.shouldFail = table => table === 'listenDaily';
  const mergeFailureResult =
    await backupModule.mergeRestoreHistoryFromLatestBackup({ force: true });
  assert.strictEqual(mergeFailureResult.ok, false);
  assert.strictEqual(mergeFailureResult.code, 'history-merge-failed');
  assert.deepStrictEqual(
    mergeFailure.tables,
    beforeMergeFailure,
    'history transaction failure must roll back every historical table'
  );

  const restoreFailure = resetHarness(makeBackup(), {
    podcasts: [{ id: 'current-podcast', feedUrl: 'https://current.test' }],
    episodes: [{ id: 'current-episode' }],
    transcripts: [{ id: 'current-transcript', text: 'current' }],
    transcriptAi: [{ id: 'current-ai', segs: { 0: 'current' } }],
  });
  const beforeRestoreFailure = clone(restoreFailure.tables);
  let failuresRemaining = 1;
  restoreFailure.shouldFail = table => {
    if (table === 'transcriptAi' && failuresRemaining > 0) {
      failuresRemaining -= 1;
      return true;
    }
    return false;
  };
  const restoreFailureResult = await backupModule.restoreFromLatestBackup();
  assert.strictEqual(restoreFailureResult.ok, false);
  assert.strictEqual(restoreFailureResult.code, 'restore-failed-rolled-back');
  assert.deepStrictEqual(restoreFailure.tables, beforeRestoreFailure);
  assert.ok(
    restoreFailure.events.indexOf('recovery-snapshot') >= 0 &&
      restoreFailure.events.indexOf('recovery-snapshot') <
        restoreFailure.events.indexOf('delete'),
    'full restore must persist the pre-restore snapshot before deleting IndexedDB'
  );
  assert.ok(restoreFailure.recoverySnapshots.length === 1);

  const rollbackFailure = resetHarness(makeBackup(), {
    transcripts: [{ id: 'current-transcript', text: 'current' }],
    transcriptAi: [{ id: 'current-ai', segs: { 0: 'current' } }],
  });
  let rollbackFailuresRemaining = 2;
  rollbackFailure.shouldFail = table => {
    if (table === 'transcriptAi' && rollbackFailuresRemaining > 0) {
      rollbackFailuresRemaining -= 1;
      return true;
    }
    return false;
  };
  const rollbackFailureResult = await backupModule.restoreFromLatestBackup();
  assert.strictEqual(rollbackFailureResult.ok, false);
  assert.strictEqual(
    rollbackFailureResult.code,
    'restore-failed-rollback-failed'
  );
  assert.ok(rollbackFailureResult.rollbackError);

  process.stdout.write('backup restore smoke: PASS\n');
}

main()
  .catch(error => {
    process.stderr.write(String((error && error.stack) || error) + '\n');
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
