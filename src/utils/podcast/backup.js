// Local podcast data backup and recovery. Normal scheduled backups deliberately
// omit episodes and cover cache; pre-restore snapshots capture every podcast
// table so an interrupted full restore can rebuild the prior local state.
import { db } from '@/utils/db';
import { exportSubscriptionsOpml } from '@/utils/podcast/service';
import { clearPodcastMem } from '@/utils/podcast/db';

const ipcRenderer = window.require
  ? window.require('electron').ipcRenderer
  : null;

export const BACKUP_FORMAT_VERSION = 2;
export const BACKUP_SCHEMA_VERSION = 16;

export const RESTORE_TABLES = [
  'podcasts',
  'favorites',
  'episodeProgress',
  'episodeListenStats',
  'listenDaily',
  'episodeDownloads',
  'transcripts',
  'transcriptDict',
  'transcriptAi',
  'transcriptSummaries',
];

export const ROLLBACK_TABLES = [
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

export const HISTORY_TABLES = [
  'favorites',
  'episodeProgress',
  'episodeListenStats',
  'listenDaily',
  'episodeDownloads',
];

const PRIMARY_KEYS = {
  podcasts: 'id',
  episodes: 'id',
  episodeProgress: 'id',
  favorites: 'id',
  episodeListenStats: 'id',
  episodeDownloads: 'id',
  listenDaily: 'key',
  coverCache: 'url',
  transcripts: 'id',
  transcriptDict: 'id',
  transcriptAi: 'id',
  transcriptSummaries: 'id',
};

// The original scheduled backup (2026-06-15) already carried these six
// records. Transcript-related tables arrived later, so only legacy backups may
// omit them. New format-v2 backups must declare every scheduled restore table.
const LEGACY_REQUIRED_TABLES = [
  'podcasts',
  'favorites',
  'episodeProgress',
  'episodeListenStats',
  'listenDaily',
  'episodeDownloads',
];

function restoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorMessage(error, fallback) {
  return String((error && error.message) || error || fallback);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

function getBackupFormat(data, kind) {
  const meta = data && data._meta;
  if (
    meta != null &&
    (!meta || typeof meta !== 'object' || Array.isArray(meta))
  ) {
    throw restoreError('invalid-backup-meta', '备份版本信息无效，已取消恢复。');
  }
  if (!meta || !hasOwn(meta, 'backupVersion')) {
    // All historical backups used _meta.v = 1 without a schema contract.
    return { legacy: true, backupVersion: 1, schemaVersion: null };
  }
  if (!isPositiveInteger(meta.backupVersion)) {
    throw restoreError(
      'invalid-backup-version',
      '备份格式版本无效，已取消恢复。'
    );
  }
  const backupVersion = Number(meta.backupVersion);
  if (backupVersion > BACKUP_FORMAT_VERSION) {
    throw restoreError(
      'unsupported-backup-version',
      '备份来自更新版本，当前应用无法安全恢复。'
    );
  }
  if (backupVersion < BACKUP_FORMAT_VERSION) {
    return { legacy: true, backupVersion, schemaVersion: null };
  }
  if (!isPositiveInteger(meta.schemaVersion)) {
    throw restoreError(
      'invalid-backup-schema',
      '备份数据库版本无效，已取消恢复。'
    );
  }
  if (Number(meta.schemaVersion) !== BACKUP_SCHEMA_VERSION) {
    throw restoreError(
      'unsupported-backup-schema',
      '备份数据库版本与当前应用不兼容，已取消恢复。'
    );
  }
  if (!Array.isArray(meta.tables)) {
    throw restoreError(
      'invalid-backup-table-manifest',
      '备份表清单无效，已取消恢复。'
    );
  }
  if (
    kind &&
    meta.kind &&
    (kind === 'recovery'
      ? meta.kind !== 'pre-restore-snapshot'
      : meta.kind !== 'scheduled-backup')
  ) {
    throw restoreError(
      'invalid-backup-kind',
      '备份类型与恢复入口不匹配，已取消恢复。'
    );
  }
  return {
    legacy: false,
    backupVersion,
    schemaVersion: Number(meta.schemaVersion),
    tables: meta.tables,
  };
}

function tableIsRequired(table, format, kind) {
  if (kind === 'recovery') return true;
  if (!format.legacy) return true;
  return LEGACY_REQUIRED_TABLES.includes(table);
}

function validatePrimaryKey(table, row) {
  const key = PRIMARY_KEYS[table];
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    !key ||
    row[key] == null ||
    String(row[key]).trim() === ''
  ) {
    throw restoreError(
      'invalid-backup-row',
      `备份中的 ${table} 数据缺少有效主键，已取消恢复。`
    );
  }
  if (
    table === 'podcasts' &&
    (typeof row.feedUrl !== 'string' || !row.feedUrl.trim())
  ) {
    throw restoreError(
      'invalid-backup-row',
      '备份中的 podcasts 数据缺少有效订阅地址，已取消恢复。'
    );
  }
}

function normalizeBits(bits) {
  if (bits == null || bits instanceof Uint8Array) return bits;
  let values = bits;
  if (!Array.isArray(bits)) {
    if (!bits || typeof bits !== 'object') {
      throw restoreError(
        'invalid-backup-bits',
        '备份中的收听统计位图无法恢复。'
      );
    }
    const keys = Object.keys(bits).sort((a, b) => Number(a) - Number(b));
    if (
      keys.some(
        (key, index) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) !== index
      )
    ) {
      throw restoreError(
        'invalid-backup-bits',
        '备份中的收听统计位图索引已损坏。'
      );
    }
    values = keys.map(key => bits[key]);
  }
  if (!Array.isArray(values)) {
    throw restoreError('invalid-backup-bits', '备份中的收听统计位图无法恢复。');
  }
  const normalized = values.map(value => Number(value));
  if (
    normalized.some(
      value => !Number.isInteger(value) || value < 0 || value > 255
    )
  ) {
    throw restoreError('invalid-backup-bits', '备份中的收听统计位图已损坏。');
  }
  return Uint8Array.from(normalized);
}

function normalizeRows(table, rows) {
  if (!Array.isArray(rows)) {
    throw restoreError(
      'invalid-backup-table',
      `备份中的 ${table} 表结构无效，已取消恢复。`
    );
  }
  return rows.map(row => {
    validatePrimaryKey(table, row);
    if (table !== 'episodeListenStats') return row;
    return { ...row, bits: normalizeBits(row.bits) };
  });
}

export function normalizeBackupPayload(data, tables, options = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw restoreError('invalid-backup-json', '备份文件不是可恢复的数据。');
  }
  const targetTables = tables || RESTORE_TABLES;
  const format = getBackupFormat(data, options.kind);
  return targetTables.reduce((result, table) => {
    const required = tableIsRequired(table, format, options.kind);
    if (!hasOwn(data, table) && required) {
      throw restoreError(
        'missing-backup-table',
        `备份缺少必需的 ${table} 表，已取消恢复。`
      );
    }
    if (!format.legacy && !format.tables.includes(table)) {
      throw restoreError(
        'backup-table-manifest-mismatch',
        `备份表清单未声明 ${table}，已取消恢复。`
      );
    }
    // Only tables proven to have been added after the original backup format
    // can be absent from legacy snapshots. Every current-format table is exact.
    const rows = hasOwn(data, table) ? data[table] : [];
    result[table] = normalizeRows(table, rows);
    return result;
  }, {});
}

function countRows(snapshot, tables) {
  return (tables || Object.keys(snapshot)).reduce((result, table) => {
    result[table] = (snapshot[table] || []).length;
    return result;
  }, {});
}

async function readBackupPayload() {
  if (!ipcRenderer) {
    throw restoreError('not-electron', '当前环境无法读取本地备份。');
  }
  const res = await ipcRenderer.invoke('podcast:backup:readLatest');
  if (!res || !res.ok || !res.json) {
    throw restoreError('no-backup', (res && res.error) || '没有可用备份。');
  }
  try {
    return { name: res.name, data: JSON.parse(res.json) };
  } catch (error) {
    throw restoreError(
      'invalid-backup-json',
      '备份文件无法解析，未改动当前数据。'
    );
  }
}

async function readRecoverySnapshotPayload(name) {
  if (!ipcRenderer) {
    throw restoreError('not-electron', '当前环境无法读取恢复前安全快照。');
  }
  const res = await ipcRenderer.invoke('podcast:backup:readRecoverySnapshot', {
    name,
  });
  if (!res || !res.ok || !res.json || !res.name) {
    throw restoreError(
      'no-recovery-snapshot',
      (res && res.error) || '没有可用的恢复前安全快照。'
    );
  }
  try {
    return {
      name: res.name,
      relativePath: res.relativePath || `backups/recovery/${res.name}`,
      data: JSON.parse(res.json),
    };
  } catch (error) {
    throw restoreError(
      'invalid-backup-json',
      '恢复前安全快照无法解析，未改动当前数据。'
    );
  }
}

export async function listPreRestoreSnapshots() {
  if (!ipcRenderer) {
    return {
      ok: false,
      code: 'not-electron',
      error: '当前环境无法读取恢复前安全快照。',
    };
  }
  try {
    const result = await ipcRenderer.invoke(
      'podcast:backup:listRecoverySnapshots'
    );
    if (!result || !result.ok) {
      return {
        ok: false,
        code: 'recovery-snapshot-list-failed',
        error: (result && result.error) || '无法读取恢复前安全快照。',
      };
    }
    return { ok: true, snapshots: result.snapshots || [] };
  } catch (error) {
    return {
      ok: false,
      code: 'recovery-snapshot-list-failed',
      error: errorMessage(error, '无法读取恢复前安全快照。'),
    };
  }
}

async function captureCurrentSnapshot() {
  try {
    return await captureTables(ROLLBACK_TABLES);
  } catch (error) {
    throw restoreError(
      'pre-restore-capture-failed',
      `无法读取当前数据以创建恢复前安全快照：${errorMessage(
        error,
        '读取失败。'
      )}`
    );
  }
}

async function captureTables(tables) {
  const entries = await Promise.all(
    (tables || []).map(async table => [table, await db[table].toArray()])
  );
  return entries.reduce((snapshot, [table, rows]) => {
    snapshot[table] = rows;
    return snapshot;
  }, {});
}

async function persistPreRestoreSnapshot(snapshot) {
  if (!ipcRenderer) return { ok: false, code: 'not-electron' };
  const json = JSON.stringify({
    _meta: {
      app: 'PodPlayer',
      at: Date.now(),
      v: BACKUP_FORMAT_VERSION,
      backupVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: 'pre-restore-snapshot',
      tables: ROLLBACK_TABLES,
    },
    ...snapshot,
  });
  const result = await ipcRenderer.invoke(
    'podcast:backup:writeRecoverySnapshot',
    {
      json,
    }
  );
  if (!result || !result.ok) {
    throw restoreError(
      'pre-restore-snapshot-failed',
      (result && result.error) || '无法写入恢复前安全快照。'
    );
  }
  return result;
}

async function replaceDatabase(snapshot, tables) {
  await db.delete();
  await db.open();
  const targetTables = tables || RESTORE_TABLES;
  await db.transaction(
    'rw',
    ...targetTables.map(table => db[table]),
    async () => {
      for (const table of targetTables) {
        await db[table].bulkPut(snapshot[table] || []);
      }
    }
  );
}

async function rollbackDatabase(snapshot) {
  await replaceDatabase(snapshot, ROLLBACK_TABLES);
  clearPodcastMem();
}

function recoverySnapshotInfo(snapshot) {
  if (!snapshot || !snapshot.name) return null;
  return {
    name: snapshot.name,
    relativePath: snapshot.relativePath || `backups/recovery/${snapshot.name}`,
  };
}

function recoveryAction(snapshot) {
  const info = recoverySnapshotInfo(snapshot);
  if (!info) return '当前数据未改动；检查备份文件后重试。';
  return (
    `恢复前安全快照保存在 ${info.relativePath}。` +
    `可在开发者工具运行 listPreRestoreSnapshots() 查看名称，再运行 restorePreRestoreSnapshot('${info.name}')；该操作会再次确认并预检。`
  );
}

export async function runBackup() {
  if (!ipcRenderer) return { ok: false, reason: 'not-electron' };
  try {
    const exportData = await captureTables(RESTORE_TABLES);
    if (
      !exportData.podcasts.length &&
      !exportData.favorites.length &&
      !exportData.episodeProgress.length
    ) {
      return { ok: false, skipped: 'empty' };
    }
    const json = JSON.stringify({
      _meta: {
        app: 'PodPlayer',
        at: Date.now(),
        v: BACKUP_FORMAT_VERSION,
        backupVersion: BACKUP_FORMAT_VERSION,
        schemaVersion: BACKUP_SCHEMA_VERSION,
        kind: 'scheduled-backup',
        tables: RESTORE_TABLES,
        note: 'episodes and coverCache are not included in scheduled backups',
      },
      ...exportData,
    });
    let opml = '';
    try {
      opml = await exportSubscriptionsOpml();
    } catch (e) {
      opml = '';
    }
    return await ipcRenderer.invoke('podcast:backup:write', { json, opml });
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'backup-failed') };
  }
}

let backupTimer = null;

export function startBackupSchedule() {
  setTimeout(() => {
    runBackup().catch(() => {});
  }, 30000);
  if (backupTimer) return;
  backupTimer = setInterval(() => {
    runBackup().catch(() => {});
  }, 6 * 60 * 60 * 1000);
}

async function restoreBackupPayload(backup, tables, kind) {
  let restoreData;
  try {
    restoreData = normalizeBackupPayload(backup.data, tables, { kind });
  } catch (error) {
    return {
      ok: false,
      state: 'preflight-failed',
      dataChanged: false,
      code: (error && error.code) || 'restore-preflight-failed',
      error: errorMessage(error, '恢复前校验失败。'),
      action: '检查备份文件后重试；当前数据未改动。',
    };
  }

  let previousSnapshot;
  let recoverySnapshot;
  try {
    previousSnapshot = await captureCurrentSnapshot();
    recoverySnapshot = await persistPreRestoreSnapshot(previousSnapshot);
  } catch (error) {
    return {
      ok: false,
      state: 'snapshot-failed',
      dataChanged: false,
      code: (error && error.code) || 'pre-restore-snapshot-failed',
      error: errorMessage(error, '无法创建恢复前安全快照。'),
      action: '当前数据未改动；检查磁盘空间和数据库状态后重试。',
    };
  }

  try {
    await replaceDatabase(restoreData, tables);
    clearPodcastMem();
    return {
      ok: true,
      state: 'restored',
      from: backup.name,
      recoverySnapshot: recoverySnapshotInfo(recoverySnapshot),
      ...countRows(restoreData, tables),
    };
  } catch (error) {
    try {
      await rollbackDatabase(previousSnapshot);
      return {
        ok: false,
        state: 'restore-failed-rollback-succeeded',
        dataChanged: false,
        code: 'restore-failed-rolled-back',
        error: errorMessage(error, '完整恢复失败。'),
        recoverySnapshot: recoverySnapshotInfo(recoverySnapshot),
        action: '已回滚到恢复前数据，可检查备份后重试。',
      };
    } catch (rollbackError) {
      return {
        ok: false,
        state: 'restore-failed-rollback-failed',
        dataChanged: true,
        code: 'restore-failed-rollback-failed',
        error: errorMessage(error, '完整恢复失败。'),
        rollbackError: errorMessage(rollbackError, '恢复前数据回滚失败。'),
        recoverySnapshot: recoverySnapshotInfo(recoverySnapshot),
        action: recoveryAction(recoverySnapshot),
      };
    }
  }
}

// Full restore intentionally includes transcript-derived data. It first checks
// the incoming payload and snapshots the current database before deleting it.
export async function restoreFromLatestBackup() {
  try {
    return await restoreBackupPayload(
      await readBackupPayload(),
      RESTORE_TABLES,
      'scheduled'
    );
  } catch (error) {
    return {
      ok: false,
      state: 'preflight-failed',
      dataChanged: false,
      code: (error && error.code) || 'restore-preflight-failed',
      error: errorMessage(error, '恢复前校验失败。'),
      action: '检查备份文件后重试；当前数据未改动。',
    };
  }
}

export async function restoreFromRecoverySnapshot(name) {
  try {
    return await restoreBackupPayload(
      await readRecoverySnapshotPayload(name),
      ROLLBACK_TABLES,
      'recovery'
    );
  } catch (error) {
    return {
      ok: false,
      state: 'preflight-failed',
      dataChanged: false,
      code: (error && error.code) || 'restore-preflight-failed',
      error: errorMessage(error, '恢复前校验失败。'),
      action: '检查恢复前安全快照名称和文件后重试；当前数据未改动。',
    };
  }
}

export async function mergeRestoreHistoryFromLatestBackup(opts) {
  if (!ipcRenderer) {
    return {
      ok: false,
      code: 'not-electron',
      error: '当前环境无法读取本地备份。',
    };
  }
  const force = !!(opts && opts.force);
  if (!force) {
    try {
      const [progressCount, statCount] = await Promise.all([
        db.episodeProgress.count(),
        db.episodeListenStats.count(),
      ]);
      if (progressCount > 0 || statCount > 0) {
        return {
          ok: false,
          code: 'history-not-empty',
          error: '当前已有收听进度或统计，已取消历史合并以免覆盖较新数据。',
        };
      }
    } catch (error) {
      return {
        ok: false,
        code: 'history-check-failed',
        error: errorMessage(error, '无法检查当前收听历史。'),
      };
    }
  }

  let backup;
  let history;
  try {
    backup = await readBackupPayload();
    history = normalizeBackupPayload(backup.data, HISTORY_TABLES);
  } catch (error) {
    return {
      ok: false,
      code: (error && error.code) || 'history-preflight-failed',
      error: errorMessage(error, '历史合并前校验失败。'),
    };
  }

  try {
    await db.transaction(
      'rw',
      ...HISTORY_TABLES.map(table => db[table]),
      async () => {
        for (const table of HISTORY_TABLES) {
          await db[table].bulkPut(history[table]);
        }
      }
    );
    return {
      ok: true,
      from: backup.name,
      ...countRows(history, HISTORY_TABLES),
    };
  } catch (error) {
    return {
      ok: false,
      code: 'history-merge-failed',
      error: errorMessage(error, '历史合并失败，当前数据未被部分写入。'),
      action: '检查备份后重试',
    };
  }
}

// If subscriptions vanished or the database cannot open, offer the full
// recovery. The full data boundary is explicit because transcript assets are
// intentionally included here but never in the history-only merge path.
export async function maybeAutoRestore() {
  if (!ipcRenderer) return;
  try {
    let count = 0;
    try {
      count = await db.podcasts.count();
    } catch (e) {
      count = 0;
    }
    if (count > 0) {
      await maybeMergeRestoreHistory();
      return;
    }
    const backup = await readBackupPayload();
    const restored = normalizeBackupPayload(backup.data, RESTORE_TABLES, {
      kind: 'scheduled',
    });
    const podcasts = restored.podcasts;
    if (!podcasts.length) return;
    const ok =
      typeof window.confirm === 'function' &&
      window.confirm(
        `检测到本地订阅为空，但发现备份（${backup.name}，含 ${podcasts.length} 档订阅）。\n` +
          '完整恢复会覆盖订阅、进度、统计、收藏、下载记录、文稿、词典、精修稿和本集总结；单集会在进入节目时自动重抓。是否继续？'
      );
    if (!ok) return;
    const result = await restoreFromLatestBackup();
    if (!result.ok) {
      if (typeof window.alert === 'function') {
        window.alert(`恢复未完成：${result.error}\n${result.action || ''}`);
      }
      return;
    }
    if (typeof window.alert === 'function') {
      window.alert(`已恢复 ${result.podcasts} 档订阅，即将刷新页面。`);
    }
    window.location.reload();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[auto-restore] failed:', errorMessage(error, 'unknown'));
  }
}

async function maybeMergeRestoreHistory() {
  try {
    const [progressCount, statCount] = await Promise.all([
      db.episodeProgress.count(),
      db.episodeListenStats.count(),
    ]);
    if (progressCount > 0 || statCount > 0) return;
    const backup = await readBackupPayload();
    const history = normalizeBackupPayload(backup.data, HISTORY_TABLES);
    if (!history.episodeProgress.length && !history.episodeListenStats.length) {
      return;
    }
    const ok =
      typeof window.confirm === 'function' &&
      window.confirm(
        `检测到订阅仍在，但收听进度或统计为空，而备份（${backup.name}）中有历史数据。\n` +
          '是否合并恢复收藏、收听进度、统计、每日统计和下载记录？不会改动订阅、单集、文稿、词典、精修稿或本集总结。'
      );
    if (!ok) return;
    const result = await mergeRestoreHistoryFromLatestBackup();
    if (!result.ok) {
      if (typeof window.alert === 'function') {
        window.alert(`历史合并未完成：${result.error}`);
      }
      return;
    }
    if (typeof window.alert === 'function') {
      window.alert('已合并恢复收听历史，即将刷新页面。');
    }
    window.location.reload();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[merge-restore] failed:', errorMessage(error, 'unknown'));
  }
}
