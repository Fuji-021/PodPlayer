// Recovery snapshots are an intentionally narrow file surface. The renderer
// can only name a snapshot produced by this application, never an arbitrary
// path under userData.
const RECOVERY_SNAPSHOT_NAME =
  /^pre-restore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

export function isRecoverySnapshotName(name) {
  return typeof name === 'string' && RECOVERY_SNAPSHOT_NAME.test(name);
}

export function getRecoverySnapshotPath(path, dir, name) {
  if (!isRecoverySnapshotName(name)) {
    const error = new Error('invalid-recovery-snapshot-name');
    error.code = 'invalid-recovery-snapshot-name';
    throw error;
  }
  const root = path.resolve(dir);
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) {
    const error = new Error('invalid-recovery-snapshot-path');
    error.code = 'invalid-recovery-snapshot-path';
    throw error;
  }
  return target;
}

export function listRecoverySnapshots(fs, path, dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isRecoverySnapshotName)
    .sort()
    .reverse()
    .map(name => {
      const stat = fs.statSync(getRecoverySnapshotPath(path, dir, name));
      return {
        name,
        bytes: stat.size,
        modifiedAt: stat.mtimeMs,
        relativePath: `backups/recovery/${name}`,
      };
    });
}

export function readRecoverySnapshot(fs, path, dir, name) {
  const target = getRecoverySnapshotPath(path, dir, name);
  if (!fs.existsSync(target)) {
    const error = new Error('recovery-snapshot-not-found');
    error.code = 'recovery-snapshot-not-found';
    throw error;
  }
  return {
    name,
    json: fs.readFileSync(target, 'utf8'),
    relativePath: `backups/recovery/${name}`,
  };
}
