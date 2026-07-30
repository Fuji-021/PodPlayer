const assert = require('assert');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'podplayer-backup-recovery-files-')
);

async function main() {
  const outfile = path.join(tempDir, 'backup-recovery-files.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/electron/backupRecoveryFiles.js')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const recovery = require(outfile);
  const dir = path.join(tempDir, 'recovery');
  fs.mkdirSync(dir, { recursive: true });
  const valid = 'pre-restore-2026-07-30T12-00-00-123Z.json';
  fs.writeFileSync(path.join(dir, valid), '{"ok":true}', 'utf8');
  fs.writeFileSync(path.join(dir, 'other.json'), '{"ignored":true}', 'utf8');

  assert.strictEqual(recovery.isRecoverySnapshotName(valid), true);
  assert.strictEqual(recovery.isRecoverySnapshotName('../outside.json'), false);
  const listed = recovery.listRecoverySnapshots(fs, path, dir);
  assert.deepStrictEqual(
    listed.map(item => item.name),
    [valid],
    'only fixed-format recovery files may be enumerated'
  );
  assert.strictEqual(listed[0].relativePath, `backups/recovery/${valid}`);
  assert.strictEqual(
    recovery.readRecoverySnapshot(fs, path, dir, valid).json,
    '{"ok":true}'
  );
  assert.throws(
    () => recovery.getRecoverySnapshotPath(path, dir, '../outside.json'),
    /invalid-recovery-snapshot-name/
  );
  assert.throws(
    () => recovery.getRecoverySnapshotPath(path, dir, valid + '.tmp'),
    /invalid-recovery-snapshot-name/
  );
  assert.throws(
    () =>
      recovery.readRecoverySnapshot(
        fs,
        path,
        dir,
        'pre-restore-2026-07-30T12-00-00-124Z.json'
      ),
    /recovery-snapshot-not-found/
  );
  process.stdout.write('backup recovery files smoke: PASS\n');
}

main()
  .catch(error => {
    process.stderr.write(String((error && error.stack) || error) + '\n');
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
