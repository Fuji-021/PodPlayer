const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const electronPath = require('electron');
const workerPath = path.join(
  root,
  'scripts',
  'dexie_transcript_summary_upgrade_worker.js'
);
const dbSource = fs.readFileSync(
  path.join(root, 'src', 'utils', 'db.js'),
  'utf8'
);

assert.ok(dbSource.includes('db.version(15).stores({'));
assert.ok(dbSource.includes('db.version(16).stores({'));
assert.ok(
  dbSource.includes(
    "transcriptSummaries: '&id, podcastId, sourceHash, updatedAt'"
  )
);

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-dexie-upgrade-')
);
try {
  const run = childProcess.spawnSync(electronPath, [workerPath], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PODPLAYER_DEXIE_SMOKE_ROOT: root,
      PODPLAYER_DEXIE_SMOKE_USER_DATA: path.join(tempRoot, 'userData'),
    },
    timeout: 30000,
  });
  if (run.error) throw run.error;
  assert.strictEqual(
    run.status,
    0,
    'Dexie upgrade worker failed:\n' + (run.stdout || '') + (run.stderr || '')
  );
  assert.ok(
    (run.stdout || '').includes(
      'dexie transcript summary upgrade worker: PASS'
    ),
    'Dexie upgrade worker did not report PASS'
  );
  console.log('dexie transcript summary upgrade smoke: PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
