import { app, dialog, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import https from 'https';

var MODEL_ID = 'sensevoice-small';
var MODEL_VERSION = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
var MIN_SUPPORTED_VERSION = MODEL_VERSION;
var REMOTE_DOWNLOAD_ENABLED = true;
var REMOTE_DOWNLOAD_BLOCKED_REASON = '';
var LOCK_STALE_MS = 30 * 60 * 1000;
var LOCK_HEARTBEAT_MS = 15 * 1000;
var CONNECT_TIMEOUT_MS = 20 * 1000;
var STREAM_IDLE_TIMEOUT_MS = 60 * 1000;

var REQUIRED_FILES = [
  {
    name: 'model.int8.onnx',
    size: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
    urls: [
      'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
      'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
    ],
    license: 'FunASR Model License 1.1',
  },
  {
    name: 'tokens.txt',
    size: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
    urls: [
      'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
      'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
    ],
    license: 'FunASR Model License 1.1',
  },
  {
    name: 'silero_vad.onnx',
    size: 643854,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    urls: [
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    ],
    license: 'Silero VAD MIT License',
  },
];

var installState = {
  running: false,
  cancel: false,
  req: null,
  runId: 0,
  startedAt: 0,
  lockHeartbeat: null,
};
var _getWindow = null;
var verifiedUseCache = null;

function dataRoot() {
  return path.dirname(app.getPath('userData'));
}

export function getManagedModelDir() {
  return path.join(dataRoot(), '_models', 'asr', 'sensevoice-small');
}

function manifestPath(dir) {
  return path.join(dir || getManagedModelDir(), 'manifest.json');
}

function lockPath() {
  return path.join(getManagedModelDir(), '.install.lock');
}

function downloadsDir() {
  return path.join(getManagedModelDir(), '.downloads');
}

function safeMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rmDir(dir) {
  try {
    if (fs.rmSync) {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
  } catch (e) {
    /* fall through */
  }
  try {
    fs.rmdirSync(dir, { recursive: true });
  } catch (e) {
    /* ignore */
  }
}

function fileSha256(file, checkCanceled) {
  return new Promise(function (resolve, reject) {
    var h = crypto.createHash('sha256');
    var s = fs.createReadStream(file);
    var settled = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }
    s.on('data', function (d) {
      if (checkCanceled) {
        try {
          checkCanceled();
        } catch (e) {
          s.destroy();
          fail(e);
          return;
        }
      }
      h.update(d);
    });
    s.on('error', fail);
    s.on('end', function () {
      if (settled) return;
      settled = true;
      resolve(h.digest('hex'));
    });
  });
}

function quickFileOk(baseDir, spec) {
  var file = path.join(baseDir, spec.name);
  try {
    var st = fs.statSync(file);
    return st.isFile() && st.size === spec.size;
  } catch (e) {
    return false;
  }
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeManifest(dir, manifest) {
  safeMkdir(dir);
  fs.writeFileSync(
    manifestPath(dir),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
}

function expectedFilesForManifest() {
  var out = {};
  REQUIRED_FILES.forEach(function (f) {
    out[f.name] = {
      size: f.size,
      sha256: f.sha256,
      url: f.url || '',
      urls: downloadSources(f),
      license: f.license || '',
    };
  });
  return out;
}

function writeNotices(dir) {
  var license =
    'PodPlayer ASR model notice\n\n' +
    'SenseVoiceSmall ONNX files are converted from FunAudioLLM/SenseVoiceSmall.\n' +
    'License: FunASR Model Open Source License Agreement 1.1.\n' +
    'License URL: https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE\n\n' +
    'silero_vad.onnx is downloaded from the official sherpa-onnx asr-models release.\n' +
    'Silero VAD license: MIT License, Copyright (c) 2020-present Silero Team.\n' +
    'VAD URL: https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx\n';
  var notice =
    'Model files are stored outside the application package.\n' +
    'Remote deployment tries the official HuggingFace source first and may use hf-mirror.com only as a fallback.\n' +
    'model.int8.onnx, tokens.txt, and silero_vad.onnx must pass pinned sha256 checks before use.\n' +
    'Deploying the model does not start transcription or call DeepSeek.\n' +
    'ASR runtime uses only deep-verified model paths.\n';
  fs.writeFileSync(path.join(dir, 'LICENSE.txt'), license, 'utf8');
  fs.writeFileSync(path.join(dir, 'NOTICE.txt'), notice, 'utf8');
}

function replaceManagedFilesFromStaging(staging) {
  var managed = getManagedModelDir();
  var stamp = Date.now();
  var names = REQUIRED_FILES.map(function (f) {
    return f.name;
  });
  ['LICENSE.txt', 'NOTICE.txt'].forEach(function (name) {
    if (fs.existsSync(path.join(staging, name))) names.push(name);
  });
  var backups = [];
  var movedTargets = [];
  try {
    names.forEach(function (name) {
      var target = path.join(managed, name);
      var backup = path.join(managed, name + '.old-' + stamp);
      if (fs.existsSync(target)) {
        fs.renameSync(target, backup);
        backups.push({ target: target, backup: backup });
      }
    });
    names.forEach(function (name) {
      var src = path.join(staging, name);
      var target = path.join(managed, name);
      if (fs.existsSync(src)) {
        fs.renameSync(src, target);
        movedTargets.push(target);
      }
    });
    backups.forEach(function (b) {
      try {
        if (fs.existsSync(b.backup)) fs.unlinkSync(b.backup);
      } catch (e) {
        /* ignore */
      }
    });
  } catch (e) {
    movedTargets.forEach(function (target) {
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch (err) {
        /* ignore */
      }
    });
    backups.forEach(function (b) {
      try {
        if (fs.existsSync(b.backup)) {
          if (fs.existsSync(b.target)) fs.unlinkSync(b.target);
          fs.renameSync(b.backup, b.target);
        }
      } catch (err) {
        /* ignore */
      }
    });
    throw e;
  }
}

function buildManifest(dir, source, verifiedAt) {
  return {
    modelId: MODEL_ID,
    version: MODEL_VERSION,
    minSupportedVersion: MIN_SUPPORTED_VERSION,
    source: source || 'local-import',
    modelDir: dir,
    ready: true,
    installedAt: new Date().toISOString(),
    verifiedAt: verifiedAt || new Date().toISOString(),
    remoteDownloadAvailable: REMOTE_DOWNLOAD_ENABLED,
    remoteDownloadBlockedReason: REMOTE_DOWNLOAD_ENABLED
      ? ''
      : REMOTE_DOWNLOAD_BLOCKED_REASON,
    files: expectedFilesForManifest(),
    license: {
      senseVoice: 'FunASR Model Open Source License Agreement 1.1',
      sileroVad: 'MIT License, Silero Team',
      sherpaOnnxRelease: 'Apache License 2.0',
    },
  };
}

function acquireLock() {
  var dir = getManagedModelDir();
  safeMkdir(dir);
  var lp = lockPath();
  try {
    var st = fs.statSync(lp);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lp);
  } catch (e) {
    /* no lock */
  }
  try {
    fs.writeFileSync(
      lp,
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
      { flag: 'wx' }
    );
    return true;
  } catch (e) {
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(lockPath());
  } catch (e) {
    /* ignore */
  }
}

function touchLock() {
  try {
    var now = new Date();
    fs.utimesSync(lockPath(), now, now);
  } catch (e) {
    /* ignore */
  }
}

function startLockHeartbeat() {
  stopLockHeartbeat();
  touchLock();
  installState.lockHeartbeat = setInterval(touchLock, LOCK_HEARTBEAT_MS);
  if (
    installState.lockHeartbeat &&
    typeof installState.lockHeartbeat.unref === 'function'
  ) {
    installState.lockHeartbeat.unref();
  }
}

function stopLockHeartbeat() {
  if (installState.lockHeartbeat) {
    clearInterval(installState.lockHeartbeat);
    installState.lockHeartbeat = null;
  }
}

function sendProgress(payload) {
  var w = _getWindow && _getWindow();
  if (w && !w.isDestroyed()) {
    try {
      w.webContents.send('asr:modelInstallProgress', payload);
    } catch (e) {
      /* ignore */
    }
  }
}

export async function verifyModelDir(dir, options) {
  if (!dir) return { ok: false, error: 'missing-dir' };
  var checkCanceled = options && options.checkCanceled;
  var files = {};
  for (var i = 0; i < REQUIRED_FILES.length; i++) {
    if (checkCanceled) checkCanceled();
    var spec = REQUIRED_FILES[i];
    var file = path.join(dir, spec.name);
    var st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      return { ok: false, error: 'missing-file', fileName: spec.name };
    }
    if (!st.isFile()) {
      return { ok: false, error: 'not-file', fileName: spec.name };
    }
    if (st.size !== spec.size) {
      return {
        ok: false,
        error: 'size-mismatch',
        fileName: spec.name,
        expected: spec.size,
        actual: st.size,
      };
    }
    var hash = await fileSha256(file, checkCanceled);
    if (checkCanceled) checkCanceled();
    if (hash.toLowerCase() !== spec.sha256) {
      return {
        ok: false,
        error: 'sha256-mismatch',
        fileName: spec.name,
        expected: spec.sha256,
        actual: hash,
      };
    }
    files[spec.name] = {
      size: st.size,
      sha256: hash.toLowerCase(),
    };
  }
  return { ok: true, dir: dir, files: files };
}

function fileFingerprint(file) {
  var st = fs.statSync(file);
  return {
    path: file,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

function buildFingerprints(dir) {
  var files = {};
  for (var i = 0; i < REQUIRED_FILES.length; i++) {
    var spec = REQUIRED_FILES[i];
    files[spec.name] = fileFingerprint(path.join(dir, spec.name));
  }
  return files;
}

function cacheMatches(dir) {
  if (!verifiedUseCache || verifiedUseCache.dir !== dir) return false;
  try {
    for (var i = 0; i < REQUIRED_FILES.length; i++) {
      var spec = REQUIRED_FILES[i];
      var cached = verifiedUseCache.files && verifiedUseCache.files[spec.name];
      if (!cached || cached.sha256 !== spec.sha256) return false;
      var current = fileFingerprint(path.join(dir, spec.name));
      if (
        current.path !== cached.path ||
        current.size !== cached.size ||
        current.mtimeMs !== cached.mtimeMs
      ) {
        return false;
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

function quickReadyFromManifest(dir, manifest) {
  if (!manifest || !manifest.ready) return false;
  if (manifest.modelId !== MODEL_ID) return false;
  if (manifest.version !== MODEL_VERSION) return false;
  for (var i = 0; i < REQUIRED_FILES.length; i++) {
    var spec = REQUIRED_FILES[i];
    if (!quickFileOk(dir, spec)) return false;
    var mf = manifest.files && manifest.files[spec.name];
    if (!mf || String(mf.sha256 || '').toLowerCase() !== spec.sha256) {
      return false;
    }
  }
  return true;
}

function statusFromManifest(deepResult) {
  var dir = getManagedModelDir();
  var manifest = readManifest(dir);
  var ready = quickReadyFromManifest(dir, manifest);
  var missing = [];
  REQUIRED_FILES.forEach(function (f) {
    if (!quickFileOk(dir, f)) missing.push(f.name);
  });
  return {
    ok: true,
    modelId: MODEL_ID,
    version: MODEL_VERSION,
    minSupportedVersion: MIN_SUPPORTED_VERSION,
    ready: ready,
    status: ready ? 'installed' : manifest ? 'path-unavailable' : 'missing',
    modelDir: dir,
    manifest: manifest,
    missingFiles: missing,
    installing: installState.running,
    remoteDownloadAvailable: REMOTE_DOWNLOAD_ENABLED,
    remoteDownloadBlockedReason: REMOTE_DOWNLOAD_ENABLED
      ? ''
      : REMOTE_DOWNLOAD_BLOCKED_REASON,
    expectedFiles: expectedFilesForManifest(),
    verifiedAt: manifest && manifest.verifiedAt,
    deepResult: deepResult || null,
  };
}

export function getVerifiedModelConfigSync() {
  var dir = getManagedModelDir();
  var manifest = readManifest(dir);
  if (!quickReadyFromManifest(dir, manifest)) return null;
  return {
    ready: true,
    source: manifest.source || 'managed',
    modelDir: dir,
    modelFile: path.join(dir, 'model.int8.onnx'),
    tokensFile: path.join(dir, 'tokens.txt'),
    vadModel: path.join(dir, 'silero_vad.onnx'),
    version: manifest.version,
    verifiedAt: manifest.verifiedAt,
  };
}

function verifiedConfigFromManifest(dir, manifest, deepResult) {
  return {
    ready: true,
    source: manifest.source || 'managed',
    modelDir: dir,
    modelFile: path.join(dir, 'model.int8.onnx'),
    tokensFile: path.join(dir, 'tokens.txt'),
    vadModel: path.join(dir, 'silero_vad.onnx'),
    version: manifest.version,
    verifiedAt:
      (deepResult && deepResult.verifiedAt) || manifest.verifiedAt || '',
  };
}

export async function getVerifiedModelConfigForUse() {
  var dir = getManagedModelDir();
  var manifest = readManifest(dir);
  if (!quickReadyFromManifest(dir, manifest)) {
    verifiedUseCache = null;
    return {
      ok: false,
      error: manifest ? 'path-unavailable' : 'missing-manifest',
      status: statusFromManifest(),
    };
  }
  if (cacheMatches(dir)) {
    return {
      ok: true,
      config: verifiedConfigFromManifest(dir, manifest, {
        verifiedAt: verifiedUseCache.verifiedAt,
      }),
      cached: true,
    };
  }
  var res = await verifyModelDir(dir);
  if (!res.ok) {
    verifiedUseCache = null;
    return Object.assign({}, res, { status: statusFromManifest(res) });
  }
  var fingerprints = buildFingerprints(dir);
  REQUIRED_FILES.forEach(function (f) {
    fingerprints[f.name].sha256 = f.sha256;
  });
  var verifiedAt = new Date().toISOString();
  verifiedUseCache = {
    dir: dir,
    files: fingerprints,
    verifiedAt: verifiedAt,
  };
  return {
    ok: true,
    config: verifiedConfigFromManifest(dir, manifest, {
      verifiedAt: verifiedAt,
    }),
    cached: false,
  };
}

export async function importLocalModelDir(srcDir) {
  var managed = getManagedModelDir();
  var staging = path.join(managed, '.staging-local-' + Date.now());
  safeMkdir(staging);
  try {
    for (var i = 0; i < REQUIRED_FILES.length; i++) {
      var name = REQUIRED_FILES[i].name;
      fs.copyFileSync(path.join(srcDir, name), path.join(staging, name));
    }
    writeNotices(staging);
    var verified = await verifyModelDir(staging);
    if (!verified.ok) return verified;
    replaceManagedFilesFromStaging(staging);
    ['LICENSE.txt', 'NOTICE.txt'].forEach(function (name) {
      var src = path.join(staging, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(managed, name));
    });
    var manifest = buildManifest(
      managed,
      'local-import',
      new Date().toISOString()
    );
    writeManifest(managed, manifest);
    verifiedUseCache = null;
    return { ok: true, status: statusFromManifest({ ok: true }) };
  } finally {
    rmDir(staging);
  }
}

function isDownloadPlanComplete() {
  if (!REMOTE_DOWNLOAD_ENABLED) return false;
  return REQUIRED_FILES.every(function (f) {
    return !!(downloadSources(f).length && f.sha256 && f.size && f.license);
  });
}

function downloadSources(spec) {
  var urls = [];
  if (spec.urls && spec.urls.length) {
    urls = spec.urls;
  } else if (spec.url) {
    urls = [spec.url];
  }
  return urls.filter(function (url, index) {
    return !!url && urls.indexOf(url) === index;
  });
}

function downloadFailure(stage, message, extra) {
  var err = new Error(message || stage || 'download-failed');
  err.stage = stage || 'stream';
  if (extra) {
    Object.keys(extra).forEach(function (k) {
      err[k] = extra[k];
    });
  }
  return err;
}

function throwIfCanceled(runId, extra) {
  if (
    installState.cancel ||
    (runId && installState.runId && runId !== installState.runId)
  ) {
    throw downloadFailure(
      'canceled',
      'canceled',
      Object.assign({ code: 'CANCELED' }, extra || {})
    );
  }
}

function setActiveRequest(req, runId) {
  if (!req || runId !== installState.runId || !installState.running) {
    return false;
  }
  installState.req = req;
  return true;
}

function clearActiveRequest(req) {
  if (installState.req === req) installState.req = null;
}

function classifyRequestError(err, state) {
  if (err && err.stage) return err.stage;
  var code = err && err.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS';
  if (!state || !state.lookupDone) return 'DNS';
  if (!state.connectDone) return 'connect';
  if (state.protocol === 'https:' && !state.secureDone) return 'TLS';
  if (state.responseDone) return 'stream';
  return 'HTTP';
}

function partSize(file) {
  try {
    if (fs.existsSync(file)) return fs.statSync(file).size;
  } catch (e) {
    /* ignore */
  }
  return 0;
}

function partMetaPath(part) {
  return part + '.meta.json';
}

function readPartMeta(part) {
  try {
    var metaFile = partMetaPath(part);
    if (!fs.existsSync(metaFile)) return {};
    return JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function writePartMeta(part, meta) {
  try {
    fs.writeFileSync(partMetaPath(part), JSON.stringify(meta || {}, null, 2));
  } catch (e) {
    /* ignore */
  }
}

function removePartMeta(part) {
  try {
    fs.unlinkSync(partMetaPath(part));
  } catch (e) {
    /* ignore */
  }
}

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function renameWithRetry(src, target, runId) {
  var lastErr = null;
  for (var i = 0; i < 8; i++) {
    throwIfCanceled(runId);
    try {
      fs.renameSync(src, target);
      return;
    } catch (e) {
      lastErr = e;
      if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) {
        await wait(150 + i * 100);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function finalizePart(
  spec,
  part,
  target,
  sourceUrl,
  runId,
  progressPercent
) {
  var size = partSize(part);
  var meta = readPartMeta(part);
  var selectedSourceUrl = meta.sourceUrl || sourceUrl;
  throwIfCanceled(runId, {
    fileName: spec.name,
    sourceUrl: selectedSourceUrl,
    partSize: size,
  });
  sendProgress({
    status: 'verifying',
    fileName: spec.name,
    sourceUrl: selectedSourceUrl,
    receivedBytes: size,
    totalBytes: spec.size,
    percent: progressPercent,
  });
  var hash = await fileSha256(part, function () {
    throwIfCanceled(runId, {
      fileName: spec.name,
      sourceUrl: selectedSourceUrl,
      partSize: size,
    });
  });
  throwIfCanceled(runId, {
    fileName: spec.name,
    sourceUrl: selectedSourceUrl,
    partSize: size,
  });
  if (hash.toLowerCase() !== spec.sha256) {
    try {
      fs.unlinkSync(part);
    } catch (e) {
      /* ignore */
    }
    removePartMeta(part);
    throw downloadFailure('hash', 'sha256-mismatch:' + spec.name, {
      sourceUrl: selectedSourceUrl,
      expected: spec.sha256,
      actual: hash.toLowerCase(),
      partSize: size,
    });
  }
  try {
    await renameWithRetry(part, target, runId);
  } catch (e) {
    throw downloadFailure(
      'rename',
      String((e && e.message) || e || 'rename-failed'),
      {
        code: e && e.code,
        sourceUrl: selectedSourceUrl,
        partSize: size,
      }
    );
  }
  removePartMeta(part);
  return selectedSourceUrl;
}

function downloadFromSource(
  spec,
  sourceUrl,
  target,
  progressBase,
  progressSpan,
  sourceIndex,
  sourceCount,
  redirectDepth,
  displaySourceUrl,
  runId
) {
  return new Promise(function (resolve, reject) {
    var publicSourceUrl = displaySourceUrl || sourceUrl;
    var part = path.join(downloadsDir(), spec.name + '.part');
    var req = null;
    var response = null;
    var stream = null;
    var settled = false;
    var connectTimer = null;
    var idleTimer = null;
    var progressPercent = Math.round((progressBase + progressSpan) * 100);

    function clearTimers() {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    }

    function cleanupRequest() {
      clearTimers();
      if (req) clearActiveRequest(req);
    }

    function rejectDownload(err, drainResponse) {
      if (settled) return;
      settled = true;
      cleanupRequest();
      if (response) {
        try {
          if (drainResponse) response.resume();
          else response.destroy();
        } catch (e) {
          /* ignore */
        }
      }
      if (stream && !stream.closed) {
        try {
          if (response) response.unpipe(stream);
        } catch (e) {
          /* ignore */
        }
        stream.once('close', function () {
          reject(err);
        });
        stream.destroy();
        return;
      }
      reject(err);
    }

    function continueWith(factory) {
      if (settled) return;
      settled = true;
      cleanupRequest();
      if (response) {
        try {
          response.resume();
        } catch (e) {
          /* ignore */
        }
      }
      Promise.resolve()
        .then(function () {
          throwIfCanceled(runId, {
            fileName: spec.name,
            sourceUrl: publicSourceUrl,
            partSize: partSize(part),
          });
          return factory();
        })
        .then(resolve, reject);
    }

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(function () {
        if (!req || settled) return;
        req.destroy(
          downloadFailure('stream', 'stream-idle-timeout:' + spec.name, {
            code: 'ETIMEDOUT',
            sourceUrl: publicSourceUrl,
            partSize: partSize(part),
          })
        );
      }, STREAM_IDLE_TIMEOUT_MS);
      if (idleTimer && typeof idleTimer.unref === 'function') {
        idleTimer.unref();
      }
    }

    try {
      throwIfCanceled(runId, {
        fileName: spec.name,
        sourceUrl: publicSourceUrl,
        partSize: partSize(part),
      });
    } catch (e) {
      reject(e);
      return;
    }

    var received = 0;
    try {
      if (fs.existsSync(part)) received = fs.statSync(part).size;
    } catch (e) {
      received = 0;
    }
    if (received === spec.size) {
      continueWith(function () {
        return finalizePart(
          spec,
          part,
          target,
          publicSourceUrl,
          runId,
          progressPercent
        ).then(function (selectedSourceUrl) {
          return { sourceUrl: selectedSourceUrl };
        });
      });
      return;
    }
    if (received > spec.size) {
      try {
        fs.unlinkSync(part);
      } catch (e) {
        /* ignore */
      }
      removePartMeta(part);
      received = 0;
    }
    var urlObj;
    try {
      urlObj = new URL(sourceUrl);
    } catch (e) {
      reject(
        downloadFailure('HTTP', 'invalid-download-url:' + spec.name, {
          sourceUrl: publicSourceUrl,
          partSize: partSize(part),
        })
      );
      return;
    }
    var mod = urlObj.protocol === 'http:' ? http : https;
    var headers = { 'User-Agent': 'PodPlayer-ASR-Model-Installer' };
    if (received > 0) headers.Range = 'bytes=' + received + '-';
    var started = Date.now();
    var state = {
      protocol: urlObj.protocol,
      lookupDone: false,
      connectDone: false,
      secureDone: false,
      responseDone: false,
    };
    req = mod.get(sourceUrl, { headers: headers }, function (res) {
      response = res;
      state.responseDone = true;
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      try {
        throwIfCanceled(runId, {
          fileName: spec.name,
          sourceUrl: publicSourceUrl,
          partSize: partSize(part),
        });
      } catch (e) {
        rejectDownload(e, false);
        return;
      }
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        if (redirectDepth > 5) {
          rejectDownload(
            downloadFailure('HTTP', 'download-redirect-loop:' + spec.name, {
              statusCode: res.statusCode,
              sourceUrl: publicSourceUrl,
              partSize: partSize(part),
            }),
            true
          );
          return;
        }
        var nextUrl = new URL(res.headers.location, sourceUrl).href;
        continueWith(function () {
          return downloadFromSource(
            spec,
            nextUrl,
            target,
            progressBase,
            progressSpan,
            sourceIndex,
            sourceCount,
            redirectDepth + 1,
            publicSourceUrl,
            runId
          );
        });
        return;
      }
      if (res.statusCode === 416 && partSize(part) === spec.size) {
        continueWith(function () {
          return finalizePart(
            spec,
            part,
            target,
            publicSourceUrl,
            runId,
            progressPercent
          ).then(function (selectedSourceUrl) {
            return { sourceUrl: selectedSourceUrl };
          });
        });
        return;
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        rejectDownload(
          downloadFailure('HTTP', 'download-http-' + res.statusCode, {
            statusCode: res.statusCode,
            sourceUrl: publicSourceUrl,
            partSize: partSize(part),
          }),
          true
        );
        return;
      }
      var append = received > 0 && res.statusCode === 206;
      if (received > 0 && res.statusCode === 200) {
        received = 0;
        removePartMeta(part);
      }
      writePartMeta(part, {
        sourceUrl: publicSourceUrl,
        fileName: spec.name,
        updatedAt: new Date().toISOString(),
      });
      stream = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
      resetIdleTimer();
      res.on('data', function (chunk) {
        try {
          throwIfCanceled(runId, {
            fileName: spec.name,
            sourceUrl: publicSourceUrl,
            partSize: partSize(part),
          });
        } catch (e) {
          req.destroy(e);
          return;
        }
        resetIdleTimer();
        received += chunk.length;
        var elapsed = Math.max(1, Date.now() - started);
        var filePercent = Math.min(1, received / spec.size);
        sendProgress({
          status: 'downloading',
          fileName: spec.name,
          sourceIndex: sourceIndex,
          sourceCount: sourceCount,
          sourceUrl: publicSourceUrl,
          receivedBytes: received,
          totalBytes: spec.size,
          percent: Math.round(
            (progressBase + progressSpan * filePercent) * 100
          ),
          speed: Math.round((received * 1000) / elapsed),
        });
      });
      res.on('aborted', function () {
        rejectDownload(
          downloadFailure('stream', 'response-aborted:' + spec.name, {
            sourceUrl: publicSourceUrl,
            partSize: partSize(part),
          }),
          false
        );
      });
      res.on('error', function (err) {
        rejectDownload(
          downloadFailure(
            'stream',
            String((err && err.message) || err || 'response-error'),
            {
              code: err && err.code,
              sourceUrl: publicSourceUrl,
              partSize: partSize(part),
            }
          ),
          false
        );
      });
      res.pipe(stream);
      stream.on('finish', function () {
        if (settled) return;
        settled = true;
        cleanupRequest();
        stream.once('close', async function () {
          try {
            var selectedSourceUrl = await finalizePart(
              spec,
              part,
              target,
              publicSourceUrl,
              runId,
              progressPercent
            );
            resolve({ sourceUrl: selectedSourceUrl });
          } catch (e) {
            reject(e);
          }
        });
      });
      stream.on('error', function (err) {
        rejectDownload(
          downloadFailure(
            'stream',
            String((err && err.message) || err || 'stream-error'),
            {
              sourceUrl: publicSourceUrl,
              partSize: partSize(part),
            }
          ),
          false
        );
      });
    });
    req.on('socket', function (socket) {
      socket.on('lookup', function (_err, address, family, host) {
        state.lookupDone = true;
        state.address = address;
        state.family = family;
        state.host = host;
      });
      socket.on('connect', function () {
        state.connectDone = true;
        state.remoteAddress = socket.remoteAddress;
        state.remotePort = socket.remotePort;
      });
      socket.on('secureConnect', function () {
        state.secureDone = true;
      });
    });
    req.on('error', function (err) {
      var stage = classifyRequestError(err, state);
      rejectDownload(
        downloadFailure(
          stage,
          String((err && err.message) || err || 'request-error'),
          {
            code: err && err.code,
            sourceUrl: publicSourceUrl,
            host: state.host || urlObj.host,
            address: state.address || '',
            remoteAddress: state.remoteAddress || '',
            remotePort: state.remotePort || '',
            partSize: partSize(part),
          }
        ),
        false
      );
    });
    if (!setActiveRequest(req, runId)) {
      req.destroy(
        downloadFailure('canceled', 'canceled', {
          code: 'CANCELED',
          sourceUrl: publicSourceUrl,
          partSize: partSize(part),
        })
      );
    }
    connectTimer = setTimeout(function () {
      if (!req || settled || state.responseDone) return;
      var stage = classifyRequestError({ code: 'ETIMEDOUT' }, state);
      req.destroy(
        downloadFailure(stage, 'request-timeout:' + spec.name, {
          code: 'ETIMEDOUT',
          sourceUrl: publicSourceUrl,
          host: state.host || urlObj.host,
          address: state.address || '',
          remoteAddress: state.remoteAddress || '',
          remotePort: state.remotePort || '',
          partSize: partSize(part),
        })
      );
    }, CONNECT_TIMEOUT_MS);
    if (connectTimer && typeof connectTimer.unref === 'function') {
      connectTimer.unref();
    }
  });
}

async function downloadOne(spec, target, progressBase, progressSpan, runId) {
  var sources = downloadSources(spec);
  var failures = [];
  for (var i = 0; i < sources.length; i++) {
    throwIfCanceled(runId, {
      fileName: spec.name,
      sourceUrl: sources[i],
      partSize: partSize(path.join(downloadsDir(), spec.name + '.part')),
    });
    try {
      sendProgress({
        status: 'source-start',
        fileName: spec.name,
        sourceIndex: i + 1,
        sourceCount: sources.length,
        sourceUrl: sources[i],
        receivedBytes: partSize(path.join(downloadsDir(), spec.name + '.part')),
        totalBytes: spec.size,
        percent: Math.round(
          (progressBase +
            progressSpan *
              Math.min(
                1,
                partSize(path.join(downloadsDir(), spec.name + '.part')) /
                  spec.size
              )) *
            100
        ),
        speed: 0,
      });
      var selected = await downloadFromSource(
        spec,
        sources[i],
        target,
        progressBase,
        progressSpan,
        i + 1,
        sources.length,
        0,
        undefined,
        runId
      );
      throwIfCanceled(runId, {
        fileName: spec.name,
        sourceUrl: (selected && selected.sourceUrl) || sources[i],
      });
      return {
        ok: true,
        sourceUrl: (selected && selected.sourceUrl) || sources[i],
        sourceIndex: i + 1,
      };
    } catch (e) {
      if (installState.cancel || e.stage === 'canceled') throw e;
      var failure = {
        fileName: spec.name,
        sourceUrl: sources[i],
        sourceIndex: i + 1,
        stage: e.stage || 'stream',
        error: String((e && e.message) || e),
        code: e.code || '',
        statusCode: e.statusCode || 0,
        host: e.host || '',
        address: e.address || '',
        remoteAddress: e.remoteAddress || '',
        remotePort: e.remotePort || '',
        partSize: e.partSize || 0,
      };
      failures.push(failure);
      sendProgress(
        Object.assign({ status: 'source-error', speed: 0 }, failure)
      );
      await wait(0);
      throwIfCanceled(runId, {
        fileName: spec.name,
        sourceUrl: sources[i],
        partSize: failure.partSize,
      });
    }
  }
  var err = downloadFailure(
    failures.length ? failures[failures.length - 1].stage : 'stream',
    'model-download-failed:' + spec.name,
    { failures: failures }
  );
  throw err;
}

export async function installModel() {
  if (!isDownloadPlanComplete()) {
    return {
      ok: false,
      error: REMOTE_DOWNLOAD_BLOCKED_REASON,
      message: 'Remote download plan is incomplete or disabled.',
      status: statusFromManifest(),
    };
  }
  if (installState.running) {
    return {
      ok: false,
      error: 'install-running',
      status: statusFromManifest(),
    };
  }
  if (!acquireLock()) {
    return {
      ok: false,
      error: 'install-locked',
      status: statusFromManifest(),
    };
  }
  installState.running = true;
  installState.cancel = false;
  installState.req = null;
  installState.runId += 1;
  var runId = installState.runId;
  installState.startedAt = Date.now();
  startLockHeartbeat();
  sendProgress({ status: 'preparing', percent: 0 });
  var staging = '';
  var result;
  var terminalProgress;
  try {
    throwIfCanceled(runId);
    var dir = getManagedModelDir();
    safeMkdir(dir);
    safeMkdir(downloadsDir());
    staging = path.join(dir, '.staging-download-' + Date.now());
    safeMkdir(staging);
    var selectedSources = {};
    for (var i = 0; i < REQUIRED_FILES.length; i++) {
      throwIfCanceled(runId);
      var spec = REQUIRED_FILES[i];
      var downloaded = await downloadOne(
        spec,
        path.join(staging, spec.name),
        i / REQUIRED_FILES.length,
        1 / REQUIRED_FILES.length,
        runId
      );
      selectedSources[spec.name] = downloaded.sourceUrl;
      throwIfCanceled(runId, {
        fileName: spec.name,
        sourceUrl: downloaded.sourceUrl,
      });
    }
    throwIfCanceled(runId);
    writeNotices(staging);
    throwIfCanceled(runId);
    sendProgress({ status: 'verifying', percent: 99 });
    var verified = await verifyModelDir(staging, {
      checkCanceled: function () {
        throwIfCanceled(runId);
      },
    });
    if (!verified.ok) {
      throw downloadFailure(
        'hash',
        'model-verify-failed:' + (verified.fileName || verified.error),
        verified
      );
    }
    throwIfCanceled(runId);
    replaceManagedFilesFromStaging(staging);
    throwIfCanceled(runId);
    var manifest = buildManifest(dir, 'remote-download');
    manifest.selectedSources = selectedSources;
    throwIfCanceled(runId);
    writeManifest(dir, manifest);
    verifiedUseCache = null;
    result = { ok: true };
    terminalProgress = { status: 'done', percent: 100 };
  } catch (e) {
    terminalProgress = {
      status: installState.cancel ? 'canceled' : 'error',
      error: String((e && e.message) || e),
      failures: e.failures || [],
    };
    result = {
      ok: false,
      error: installState.cancel ? 'canceled' : String((e && e.message) || e),
      downloadFailures: e.failures || [],
    };
  } finally {
    installState.running = false;
    if (installState.runId === runId) installState.req = null;
    stopLockHeartbeat();
    if (staging) rmDir(staging);
    releaseLock();
  }
  try {
    result.status = statusFromManifest(result.ok ? { ok: true } : undefined);
  } catch (e) {
    result.status = statusSafe();
  }
  sendProgress(terminalProgress);
  return result;
}

export function cancelModelInstall() {
  if (!installState.running) {
    return { ok: true, status: statusFromManifest() };
  }
  installState.cancel = true;
  sendProgress({ status: 'canceling' });
  var req = installState.req;
  if (req) {
    try {
      req.destroy(
        downloadFailure('canceled', 'canceled', {
          code: 'CANCELED',
        })
      );
    } catch (e) {
      /* request is already closing */
    }
  }
  return { ok: true, status: statusFromManifest() };
}

function statusSafe() {
  try {
    return statusFromManifest();
  } catch (e) {
    return {
      ok: false,
      ready: false,
      status: 'error',
      error: String((e && e.message) || e),
    };
  }
}

function errorResult(e) {
  return {
    ok: false,
    error: String((e && e.message) || e),
    status: statusSafe(),
  };
}

export function registerAsrModelIpc(getWindow) {
  _getWindow = getWindow;

  ipcMain.handle('asr:modelStatus', async function () {
    try {
      return statusFromManifest();
    } catch (e) {
      return errorResult(e);
    }
  });

  ipcMain.handle('asr:modelInstall', async function () {
    try {
      return installModel();
    } catch (e) {
      return errorResult(e);
    }
  });

  ipcMain.handle('asr:modelCancelInstall', async function () {
    try {
      return cancelModelInstall();
    } catch (e) {
      return errorResult(e);
    }
  });

  ipcMain.handle('asr:modelVerify', async function (_e, payload) {
    try {
      var dir = (payload && payload.dir) || getManagedModelDir();
      var res = await verifyModelDir(dir);
      if (res.ok && dir === getManagedModelDir()) {
        writeNotices(dir);
        writeManifest(dir, buildManifest(dir, 'manual-verify'));
        verifiedUseCache = null;
      }
      return Object.assign({}, res, { status: statusFromManifest(res) });
    } catch (e) {
      return errorResult(e);
    }
  });

  ipcMain.handle('asr:modelSelectLocalDir', async function () {
    try {
      var win = _getWindow && _getWindow();
      var res = await dialog.showOpenDialog(win || undefined, {
        title: 'Select SenseVoiceSmall model directory',
        properties: ['openDirectory'],
      });
      if (!res || res.canceled || !res.filePaths || !res.filePaths[0]) {
        return { ok: false, canceled: true, status: statusFromManifest() };
      }
      if (!acquireLock()) return { ok: false, error: 'install-locked' };
      try {
        var verify = await verifyModelDir(res.filePaths[0]);
        if (!verify.ok)
          return Object.assign({}, verify, { status: statusFromManifest() });
        return await importLocalModelDir(res.filePaths[0]);
      } finally {
        releaseLock();
      }
    } catch (e) {
      return errorResult(e);
    }
  });

  ipcMain.handle('asr:modelRemove', async function () {
    try {
      if (!acquireLock()) return { ok: false, error: 'install-locked' };
      try {
        rmDir(getManagedModelDir());
        verifiedUseCache = null;
        return { ok: true, status: statusFromManifest() };
      } finally {
        releaseLock();
      }
    } catch (e) {
      return errorResult(e);
    }
  });
}
