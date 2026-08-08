// [转文字稿] 临时音频来源层。它只为一次 ASR 任务准备输入，不登记下载、不接触 NAS
// 或备份；所有删除操作都限制在 userData/tmp/transcript-media 之下。
import { app, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { URL } from 'url';
import {
  getPodcastsDir,
  guessExt,
  streamGetWithFallback,
} from './podcastDownload';
import { inspectRangeResponse } from './downloadResumePolicy';
import { isPathInsideDirectory } from './downloadTaskState';

export const TRANSCRIPT_MEDIA_CONFIG = {
  manifestName: 'manifest.json',
  partTtlMs: 24 * 60 * 60 * 1000,
  retainedTtlMs: 3 * 24 * 60 * 60 * 1000,
  // This is a root-wide ceiling, not merely a cache limit. There is only one
  // active ASR source, so the preparing stream and paused/retryable media share
  // one bounded budget.
  totalMaxBytes: 1024 * 1024 * 1024,
  budgetCheckBytes: 4 * 1024 * 1024,
  waitForPersistentMs: 45000,
  waitForPersistentPollMs: 250,
};

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function now() {
  return Date.now();
}

function asError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

export function normalizeTranscriptAudioUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch (e) {
    throw asError('invalid-audio-url', '音频地址无效');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw asError('unsupported-audio-url', '不支持的音频地址');
  }
  url.hash = '';
  return url.href;
}

export function transcriptMediaDirectory(rootDir, episodeId, ownerToken) {
  const episodeDir = path.join(rootDir, sha256(episodeId).slice(0, 32));
  // A completed task can be acknowledged after a retry for the same episode
  // has started. Its cleanup must never share a directory with the new owner.
  return ownerToken
    ? path.join(episodeDir, sha256(ownerToken).slice(0, 20))
    : episodeDir;
}

export function isSafeTranscriptMediaFileName(name) {
  return /^audio\.[a-z0-9]{2,5}(?:\.part)?$/i.test(String(name || ''));
}

export function validateTranscriptRangeResponse(status, contentRange, start) {
  if (!start) return { ok: status === 200 || status === 206, total: 0 };
  const check = inspectRangeResponse(status, contentRange, start);
  if (check.ok) return { ok: true, total: check.total || 0 };
  return { ok: false, error: check.error || 'range-response-invalid' };
}

function emptyStats() {
  return { count: 0, bytes: 0, pausedCount: 0, partCount: 0 };
}

function safeUnlink(fsImpl, filePath) {
  try {
    if (fsImpl.existsSync(filePath)) fsImpl.unlinkSync(filePath);
    return true;
  } catch (e) {
    return false;
  }
}

function waitForStreamClose(stream) {
  if (!stream || stream.closed || typeof stream.once !== 'function') {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 250);
    stream.once('close', finish);
  });
}

function safeRm(fsImpl, rootDir, target) {
  if (!target || !isPathInsideDirectory(rootDir, target)) return false;
  try {
    if (fsImpl.rmSync) fsImpl.rmSync(target, { recursive: true, force: true });
    else fsImpl.rmdirSync(target, { recursive: true });
    return true;
  } catch (e) {
    return !!(e && e.code === 'ENOENT');
  }
}

function listMediaDirectories(fsImpl, rootDir, manifestName) {
  let episodeDirs = [];
  try {
    episodeDirs = fsImpl
      .readdirSync(rootDir)
      .map(name => path.join(rootDir, name));
  } catch (e) {
    return [];
  }
  const mediaDirs = [];
  episodeDirs.forEach(episodeDir => {
    if (!isPathInsideDirectory(rootDir, episodeDir)) return;
    // Legacy local candidates used one directory per episode. Keep their
    // cleanup safe while all new work uses an owner-isolated child directory.
    if (fsImpl.existsSync(path.join(episodeDir, manifestName))) {
      mediaDirs.push(episodeDir);
      return;
    }
    let ownerDirs = [];
    try {
      ownerDirs = fsImpl.readdirSync(episodeDir);
    } catch (e) {
      return;
    }
    ownerDirs.forEach(name => {
      const ownerDir = path.join(episodeDir, name);
      if (
        isPathInsideDirectory(rootDir, ownerDir) &&
        fsImpl.existsSync(path.join(ownerDir, manifestName))
      ) {
        mediaDirs.push(ownerDir);
      }
    });
  });
  return mediaDirs;
}

function removeEmptyEpisodeDirectory(fsImpl, rootDir, mediaDir) {
  const episodeDir = path.dirname(mediaDir);
  if (!isPathInsideDirectory(rootDir, episodeDir)) return;
  try {
    if (!fsImpl.readdirSync(episodeDir).length) fsImpl.rmdirSync(episodeDir);
  } catch (e) {
    // The directory may still contain another active owner. That is expected.
  }
}

function findReusableMedia(fsImpl, rootDir, episodeId, audioUrl, manifestName) {
  const episodeDir = transcriptMediaDirectory(rootDir, episodeId);
  const expectedUrlHash = sha256(audioUrl);
  const candidates = listMediaDirectories(fsImpl, rootDir, manifestName);
  for (let index = 0; index < candidates.length; index += 1) {
    const dir = candidates[index];
    if (dir !== episodeDir && path.dirname(dir) !== episodeDir) continue;
    const manifest = readJson(fsImpl, path.join(dir, manifestName));
    if (
      !manifest ||
      manifest.sourceUrlHash !== expectedUrlHash ||
      ['paused', 'retryable'].indexOf(manifest.status) === -1
    ) {
      continue;
    }
    const finalPath = isSafeTranscriptMediaFileName(manifest.fileName)
      ? path.join(dir, manifest.fileName)
      : '';
    const partPath = isSafeTranscriptMediaFileName(manifest.partName)
      ? path.join(dir, manifest.partName)
      : '';
    if (
      (finalPath && fsImpl.existsSync(finalPath)) ||
      (partPath && fsImpl.existsSync(partPath))
    ) {
      return { dir, finalPath, partPath };
    }
  }
  return null;
}

function readJson(fsImpl, filePath) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJsonAtomic(fsImpl, filePath, value) {
  const temp = filePath + '.tmp';
  fsImpl.writeFileSync(temp, JSON.stringify(value), 'utf8');
  fsImpl.renameSync(temp, filePath);
}

function formatExtension(audioUrl, contentType) {
  const candidate = String(
    guessExt(audioUrl, contentType) || '.mp3'
  ).toLowerCase();
  return /^\.[a-z0-9]{2,5}$/.test(candidate) ? candidate : '.mp3';
}

function streamFailure(error) {
  const code = error && error.code;
  return code === 'download-canceled' || code === 'transcript-media-canceled';
}

function streamToFile(fsImpl, record, getStream, onProgress, ensureBudget) {
  return (async function () {
    const existingBytes =
      record.partPath && fsImpl.existsSync(record.partPath)
        ? Number(fsImpl.statSync(record.partPath).size) || 0
        : 0;
    const start = existingBytes > 0 ? existingBytes : null;
    const result = await getStream(record.audioUrl, start, record.connection);
    if (record.released) {
      if (result && result.res && result.res.destroy) result.res.destroy();
      throw asError('transcript-media-canceled', '已取消准备音频');
    }
    const range = validateTranscriptRangeResponse(
      result && result.status,
      result &&
        result.res &&
        result.res.headers &&
        result.res.headers['content-range'],
      existingBytes
    );
    if (!range.ok) {
      if (result && result.res && result.res.destroy) result.res.destroy();
      safeUnlink(fsImpl, record.partPath);
      throw asError(
        'transcript-media-' + range.error,
        '服务器不支持安全续传，请重试'
      );
    }
    const res = result && result.res;
    if (!res || !res.pipe)
      throw asError('transcript-media-response-invalid', '音频响应无效');
    const contentLength =
      Number(res.headers && res.headers['content-length']) || 0;
    const total = existingBytes
      ? range.total || existingBytes + contentLength
      : contentLength;
    if (!ensureBudget(record, total || existingBytes)) {
      if (res && res.destroy) res.destroy();
      throw asError(
        'transcript-media-cap-exceeded',
        '转写临时文件空间不足，请先清理后重试'
      );
    }
    const finalUrl = normalizeTranscriptAudioUrl(
      (result && result.finalUrl) || record.audioUrl
    );
    const extension = formatExtension(
      finalUrl,
      res.headers && res.headers['content-type']
    );
    // A resumed Range response must keep the existing partial file name even
    // if a server changes or omits its MIME type. Otherwise bytes N..end could
    // be appended to a brand-new file and corrupt the transient source.
    if (existingBytes && record.partPath) {
      record.finalPath = record.partPath.replace(/\.part$/i, '');
    } else {
      record.partPath = path.join(record.dir, 'audio' + extension + '.part');
      record.finalPath = path.join(record.dir, 'audio' + extension);
    }
    record.expectedBytes = total;
    record.receivedBytes = existingBytes;
    record.nextBudgetCheck =
      record.receivedBytes + Math.max(1, record.budgetCheckBytes || 1);
    writeJsonAtomic(fsImpl, record.manifestPath, record.manifest());

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = callback => {
        if (settled) return;
        settled = true;
        callback();
      };
      const write = fsImpl.createWriteStream(record.partPath, {
        flags: existingBytes ? 'a' : 'w',
      });
      record.response = res;
      record.writer = write;
      const cancel = () =>
        finish(() =>
          reject(asError('transcript-media-canceled', '已取消准备音频'))
        );
      res.on('data', chunk => {
        if (record.released) {
          cancel();
          return;
        }
        record.receivedBytes += chunk.length || 0;
        if (
          !total &&
          record.receivedBytes >= record.nextBudgetCheck &&
          !ensureBudget(record, record.receivedBytes)
        ) {
          if (res.destroy) res.destroy();
          if (write.destroy) write.destroy();
          finish(() =>
            reject(
              asError(
                'transcript-media-cap-exceeded',
                '转写临时文件空间不足，请先清理后重试'
              )
            )
          );
          return;
        }
        if (!total && record.receivedBytes >= record.nextBudgetCheck) {
          record.nextBudgetCheck =
            record.receivedBytes + Math.max(1, record.budgetCheckBytes || 1);
        }
        record.updatedAt = now();
        onProgress(record.receivedBytes, total);
      });
      res.once('error', error => finish(() => reject(error)));
      write.once('error', error => finish(() => reject(error)));
      write.once('finish', () => finish(resolve));
      res.pipe(write);
      if (record.released) cancel();
    });
    if (record.released)
      throw asError('transcript-media-canceled', '已取消准备音频');
    fsImpl.renameSync(record.partPath, record.finalPath);
    record.partPath = '';
    record.localPath = record.finalPath;
    record.expectedBytes = total;
    record.receivedBytes = total || record.receivedBytes;
    return record.finalPath;
  })();
}

// Main-process-owned acquisition registry. `ownerToken` prevents a late task
// from releasing a newer task's directory after an episode is retried.
export function createTranscriptMediaManager(options) {
  const opts = options || {};
  const fsImpl = opts.fs || fs;
  const appImpl = opts.app || app;
  const getStream = opts.streamGet || streamGetWithFallback;
  const getPersistentInfo = opts.getPersistentInfo || (() => null);
  const clock = opts.now || now;
  const config = Object.assign({}, TRANSCRIPT_MEDIA_CONFIG, opts.config || {});
  const recordsByOwner = new Map();
  const pendingByOwner = new Map();

  function rootDir() {
    return path.join(appImpl.getPath('userData'), 'tmp', 'transcript-media');
  }

  function ensureRoot() {
    const root = rootDir();
    if (!fsImpl.existsSync(root)) fsImpl.mkdirSync(root, { recursive: true });
    return root;
  }

  function manifestFor(record, status) {
    return {
      version: 1,
      episodeHash: sha256(record.episodeId).slice(0, 32),
      sourceUrlHash: sha256(record.audioUrl),
      ownerToken: record.ownerToken,
      status: status || record.status || 'preparing',
      fileName: record.finalPath ? path.basename(record.finalPath) : '',
      partName: record.partPath ? path.basename(record.partPath) : '',
      expectedBytes: record.expectedBytes || 0,
      receivedBytes: record.receivedBytes || 0,
      updatedAt: clock(),
    };
  }

  function persistManifest(record, status) {
    record.status = status || record.status;
    if (!record.manifestPath) return;
    writeJsonAtomic(
      fsImpl,
      record.manifestPath,
      manifestFor(record, record.status)
    );
  }

  function makeTransientSource(record) {
    return {
      sourceType: 'transient',
      localPath: record.localPath,
      episodeId: record.episodeId,
      ownerToken: record.ownerToken,
      release: reason => release(record.ownerToken, reason),
    };
  }

  async function waitForPersistent(episodeId, isCanceled) {
    const first = getPersistentInfo(episodeId);
    if (!first || !first.active) return '';
    const deadline = clock() + config.waitForPersistentMs;
    let candidate = first.finalPath || '';
    while (clock() < deadline) {
      if (isCanceled && isCanceled()) {
        throw asError('transcript-media-canceled', '已取消准备音频');
      }
      if (candidate && fsImpl.existsSync(candidate)) return candidate;
      await new Promise(resolve =>
        setTimeout(resolve, config.waitForPersistentPollMs)
      );
      const next = getPersistentInfo(episodeId);
      if (next && next.finalPath) candidate = next.finalPath;
      if ((!next || !next.active) && candidate) {
        return fsImpl.existsSync(candidate) ? candidate : '';
      }
      if (!next || !next.active) return '';
    }
    return '';
  }

  function validPersistentPath(filePath) {
    return !!(
      filePath &&
      fsImpl.existsSync(filePath) &&
      isPathInsideDirectory(getPodcastsDir(), filePath)
    );
  }

  async function acquireInternal(request, pending) {
    const payload = request || {};
    const episodeId = String(payload.episodeId || '');
    const ownerToken = String(payload.ownerToken || '');
    if (!episodeId || !ownerToken) {
      throw asError('transcript-media-missing-owner', '缺少转写任务标识');
    }
    const existing = recordsByOwner.get(ownerToken);
    if (existing && existing.episodeId === episodeId && !existing.released) {
      if (existing.promise) return existing.promise;
      return makeTransientSource(existing);
    }
    if (validPersistentPath(payload.persistentPath)) {
      return {
        sourceType: 'persistent',
        localPath: payload.persistentPath,
        episodeId,
        ownerToken,
        release: () => Promise.resolve({ ok: true, retained: true }),
      };
    }
    const waitedPath = await waitForPersistent(
      episodeId,
      () => pending && pending.canceled
    );
    if (pending && pending.canceled) {
      throw asError('transcript-media-canceled', '已取消准备音频');
    }
    if (validPersistentPath(waitedPath)) {
      return {
        sourceType: 'persistent',
        localPath: waitedPath,
        episodeId,
        ownerToken,
        release: () => Promise.resolve({ ok: true, retained: true }),
      };
    }
    const audioUrl = normalizeTranscriptAudioUrl(payload.audioUrl);
    const root = ensureRoot();
    const reusable = findReusableMedia(
      fsImpl,
      root,
      episodeId,
      audioUrl,
      config.manifestName
    );
    const dir = reusable
      ? reusable.dir
      : transcriptMediaDirectory(root, episodeId, ownerToken);
    if (!isPathInsideDirectory(root, dir)) {
      throw asError('transcript-media-invalid-path', '临时音频路径无效');
    }
    if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, config.manifestName);
    const previous = readJson(fsImpl, manifestPath);
    const defaultExt = formatExtension(audioUrl, '');
    const previousPart =
      previous && isSafeTranscriptMediaFileName(previous.partName)
        ? path.join(dir, previous.partName)
        : '';
    const previousFinal =
      previous && isSafeTranscriptMediaFileName(previous.fileName)
        ? path.join(dir, previous.fileName)
        : '';
    const record = {
      episodeId,
      ownerToken,
      audioUrl,
      dir,
      manifestPath,
      finalPath:
        previousFinal ||
        (reusable && reusable.finalPath) ||
        path.join(dir, 'audio' + defaultExt),
      partPath:
        previousPart ||
        (reusable && reusable.partPath) ||
        path.join(dir, 'audio' + defaultExt + '.part'),
      localPath: '',
      response: null,
      writer: null,
      connection: {},
      released: false,
      status: 'preparing',
      expectedBytes: 0,
      receivedBytes: 0,
      budgetCheckBytes: config.budgetCheckBytes,
      updatedAt: clock(),
      manifest() {
        return manifestFor(record, record.status);
      },
      promise: null,
    };
    if (
      previous &&
      previous.sourceUrlHash &&
      previous.sourceUrlHash !== sha256(audioUrl)
    ) {
      safeRm(fsImpl, root, dir);
      fsImpl.mkdirSync(dir, { recursive: true });
    }
    if (fsImpl.existsSync(record.finalPath)) {
      record.localPath = record.finalPath;
      record.status = 'ready';
      persistManifest(record, 'ready');
      recordsByOwner.set(ownerToken, record);
      return makeTransientSource(record);
    }
    recordsByOwner.set(ownerToken, record);
    persistManifest(record, 'preparing');
    const reportProgress = (received, total) => {
      if (record.released || typeof payload.onProgress !== 'function') return;
      payload.onProgress({
        episodeId,
        ownerToken,
        receivedBytes: received || 0,
        totalBytes: total || 0,
      });
    };
    record.promise = (
      opts.fetchToFile
        ? opts.fetchToFile(record, reportProgress)
        : streamToFile(
            fsImpl,
            record,
            getStream,
            reportProgress,
            ensureBudgetForRecord
          )
    )
      .then(result => {
        if (record.released)
          throw asError('transcript-media-canceled', '已取消准备音频');
        if (typeof result === 'string') record.localPath = result;
        if (!record.localPath || !fsImpl.existsSync(record.localPath)) {
          throw asError('transcript-media-file-missing', '临时音频文件不存在');
        }
        persistManifest(record, 'ready');
        return makeTransientSource(record);
      })
      .catch(error => {
        if (record.released || streamFailure(error)) {
          return Promise.reject(error);
        }
        // Retryable partial media is deliberately outside the download system.
        // It is TTL/cap bounded and is never exposed as a finished download.
        persistManifest(
          record,
          fsImpl.existsSync(record.partPath) ? 'retryable' : 'error'
        );
        throw error;
      });
    return record.promise;
  }

  function acquire(request) {
    const ownerToken = String((request && request.ownerToken) || '');
    if (!ownerToken) return acquireInternal(request, null);
    const pending = pendingByOwner.get(ownerToken);
    if (pending) return pending.promise;
    const entry = { canceled: false, promise: null };
    entry.promise = acquireInternal(request, entry).finally(function () {
      if (pendingByOwner.get(ownerToken) === entry) {
        pendingByOwner.delete(ownerToken);
      }
    });
    pendingByOwner.set(ownerToken, entry);
    return entry.promise;
  }

  async function release(ownerToken, reason) {
    const pending = pendingByOwner.get(ownerToken);
    if (pending && !recordsByOwner.has(ownerToken)) {
      pending.canceled = true;
      return { ok: true, canceledPending: true };
    }
    const record = recordsByOwner.get(ownerToken);
    if (!record) return { ok: true, alreadyReleased: true };
    if (record.released) return { ok: true, alreadyReleased: true };
    record.released = true;
    recordsByOwner.delete(ownerToken);
    try {
      if (record.connection && record.connection.request)
        record.connection.request.destroy();
    } catch (e) {
      // best effort
    }
    try {
      if (record.response && record.response.destroy) record.response.destroy();
    } catch (e) {
      // best effort
    }
    try {
      if (record.writer && record.writer.destroy) record.writer.destroy();
    } catch (e) {
      // best effort
    }
    await Promise.all([
      waitForStreamClose(record.response),
      waitForStreamClose(record.writer),
    ]);
    const keep = reason === 'paused';
    if (keep) {
      persistManifest(record, 'paused');
      return { ok: true, retained: true };
    }
    const root = rootDir();
    const removed = safeRm(fsImpl, root, record.dir);
    if (removed) removeEmptyEpisodeDirectory(fsImpl, root, record.dir);
    return { ok: removed, removed };
  }

  function releaseEpisode(episodeId, reason) {
    const owners = [];
    recordsByOwner.forEach((record, token) => {
      if (record.episodeId === episodeId) owners.push(token);
    });
    return Promise.all(owners.map(token => release(token, reason))).then(
      () => ({ ok: true })
    );
  }

  function readDirectoryStats(root, includeInactive) {
    const stats = emptyStats();
    listMediaDirectories(fsImpl, root, config.manifestName).forEach(dir => {
      const manifest = readJson(fsImpl, path.join(dir, config.manifestName));
      if (!manifest) return;
      if (
        !includeInactive &&
        manifest.status !== 'paused' &&
        manifest.status !== 'retryable'
      )
        return;
      const candidate = manifest.fileName || manifest.partName || '';
      if (!isSafeTranscriptMediaFileName(candidate)) return;
      const mediaPath = path.join(dir, candidate);
      let bytes = 0;
      try {
        bytes = Number(fsImpl.statSync(mediaPath).size) || 0;
      } catch (e) {
        bytes = 0;
      }
      stats.count += 1;
      stats.bytes += bytes;
      if (manifest.status === 'paused') stats.pausedCount += 1;
      if (manifest.status === 'retryable') stats.partCount += 1;
    });
    return stats;
  }

  function mediaCandidate(root, dir) {
    const manifest = readJson(fsImpl, path.join(dir, config.manifestName));
    const candidate = manifest && (manifest.fileName || manifest.partName);
    let bytes = 0;
    if (candidate && isSafeTranscriptMediaFileName(candidate)) {
      try {
        bytes = Number(fsImpl.statSync(path.join(dir, candidate)).size) || 0;
      } catch (e) {
        bytes = 0;
      }
    }
    return {
      dir,
      bytes,
      updatedAt: Number(manifest && manifest.updatedAt) || 0,
    };
  }

  // Disk capacity belongs to the transcript-media root as a whole. A queued
  // ASR task owns the only active source, while old paused/retryable files are
  // disposable cache. We never evict another active owner to make room.
  function ensureBudgetForRecord(record, targetBytes) {
    const root = rootDir();
    const activeDirs = new Set();
    recordsByOwner.forEach(active => activeDirs.add(active.dir));
    const candidates = listMediaDirectories(
      fsImpl,
      root,
      config.manifestName
    ).map(dir => mediaCandidate(root, dir));
    const own = candidates.find(item => item.dir === record.dir);
    const ownBytes = own ? own.bytes : 0;
    const wantedBytes = Math.max(ownBytes, Number(targetBytes) || 0);
    let total = candidates.reduce((sum, item) => sum + item.bytes, 0);
    total = total - ownBytes + wantedBytes;
    if (total <= config.totalMaxBytes) return true;

    candidates
      .filter(item => item.dir !== record.dir && !activeDirs.has(item.dir))
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .forEach(item => {
        if (total <= config.totalMaxBytes) return;
        if (safeRm(fsImpl, root, item.dir)) {
          total -= item.bytes;
          removeEmptyEpisodeDirectory(fsImpl, root, item.dir);
        }
      });
    return total <= config.totalMaxBytes;
  }

  function cleanupInactive(options) {
    const opts2 = options || {};
    const root = rootDir();
    const activeDirs = new Set();
    recordsByOwner.forEach(record => activeDirs.add(record.dir));
    const candidates = [];
    listMediaDirectories(fsImpl, root, config.manifestName).forEach(dir => {
      if (!isPathInsideDirectory(root, dir) || activeDirs.has(dir)) return;
      const manifest = readJson(fsImpl, path.join(dir, config.manifestName));
      const updatedAt = Number(manifest && manifest.updatedAt) || 0;
      const status = (manifest && manifest.status) || 'unknown';
      const candidate = manifest && (manifest.fileName || manifest.partName);
      let bytes = 0;
      if (candidate && isSafeTranscriptMediaFileName(candidate)) {
        try {
          bytes = Number(fsImpl.statSync(path.join(dir, candidate)).size) || 0;
        } catch (e) {
          bytes = 0;
        }
      }
      candidates.push({ dir, status, updatedAt, bytes });
    });
    const cutoff = clock() - config.retainedTtlMs;
    candidates.forEach(item => {
      const partExpired =
        item.status === 'retryable' &&
        item.updatedAt < clock() - config.partTtlMs;
      const terminal =
        [
          'completed',
          'canceled',
          'error',
          'preparing',
          'running',
          'ready',
        ].indexOf(item.status) >= 0;
      if (opts2.manual || terminal || partExpired || item.updatedAt < cutoff) {
        if (safeRm(fsImpl, root, item.dir)) {
          removeEmptyEpisodeDirectory(fsImpl, root, item.dir);
        }
      }
    });
    if (!opts2.manual) {
      const kept = candidates
        .filter(item => fsImpl.existsSync(item.dir))
        .sort((a, b) => a.updatedAt - b.updatedAt);
      let total = kept.reduce((sum, item) => sum + item.bytes, 0);
      kept.forEach(item => {
        if (total <= config.totalMaxBytes) return;
        if (safeRm(fsImpl, root, item.dir)) {
          total -= item.bytes;
          removeEmptyEpisodeDirectory(fsImpl, root, item.dir);
        }
      });
    }
    return readDirectoryStats(root, true);
  }

  return {
    acquire,
    release,
    releaseEpisode,
    cleanupInactive,
    getStats: () => readDirectoryStats(rootDir(), true),
    shutdown: () =>
      Promise.all(
        Array.from(recordsByOwner.keys()).map(owner =>
          release(owner, 'shutdown')
        )
      ),
    rootDir,
    recordsByOwner,
    pendingByOwner,
  };
}

export function registerTranscriptMediaIpc(manager) {
  const sourceManager = manager;
  if (!sourceManager) return;
  ipcMain.handle('asr:media:stats', async function () {
    try {
      return { ok: true, stats: sourceManager.getStats() };
    } catch (e) {
      return { ok: false, error: 'transcript-media-stats-failed' };
    }
  });
  ipcMain.handle('asr:media:cleanup', async function () {
    try {
      return {
        ok: true,
        stats: sourceManager.cleanupInactive({ manual: true }),
      };
    } catch (e) {
      return { ok: false, error: 'transcript-media-cleanup-failed' };
    }
  });
}
