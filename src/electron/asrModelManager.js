import { app, dialog, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import https from 'https';

var MODEL_ID = 'sensevoice-small';
var MODEL_VERSION = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
var MIN_SUPPORTED_VERSION = MODEL_VERSION;
var REMOTE_DOWNLOAD_ENABLED = false;
var LOCK_STALE_MS = 30 * 60 * 1000;

var REQUIRED_FILES = [
  {
    name: 'model.int8.onnx',
    size: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
    license: 'FunASR Model License 1.1',
  },
  {
    name: 'tokens.txt',
    size: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
    license: 'FunASR Model License 1.1',
  },
  {
    name: 'silero_vad.onnx',
    size: 643854,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    url: '',
    license: 'Silero VAD license source pending for this exact file',
  },
];

var installState = {
  running: false,
  cancel: false,
  req: null,
  startedAt: 0,
};
var _getWindow = null;

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

function fileSha256(file) {
  return new Promise(function (resolve, reject) {
    var h = crypto.createHash('sha256');
    var s = fs.createReadStream(file);
    s.on('data', function (d) {
      h.update(d);
    });
    s.on('error', reject);
    s.on('end', function () {
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
    'Silero VAD is MIT licensed by Silero Team, but the exact 643854-byte ONNX source URL remains pending.\n' +
    'Do not redistribute this model bundle until all upstream notices are rechecked.\n';
  var notice =
    'Model files are stored outside the application package.\n' +
    'Remote download is disabled until model.int8.onnx, tokens.txt, and the exact silero_vad.onnx source/hash/license are fully confirmed.\n' +
    'Current verified path is produced by local import plus sha256 validation.\n';
  fs.writeFileSync(path.join(dir, 'LICENSE.txt'), license, 'utf8');
  fs.writeFileSync(path.join(dir, 'NOTICE.txt'), notice, 'utf8');
}

function replaceManagedFilesFromStaging(staging) {
  var managed = getManagedModelDir();
  var backups = [];
  try {
    REQUIRED_FILES.forEach(function (f) {
      var target = path.join(managed, f.name);
      var backup = path.join(managed, f.name + '.old-' + Date.now());
      if (fs.existsSync(target)) {
        fs.renameSync(target, backup);
        backups.push({ target: target, backup: backup });
      }
    });
    REQUIRED_FILES.forEach(function (f) {
      fs.renameSync(path.join(staging, f.name), path.join(managed, f.name));
    });
    backups.forEach(function (b) {
      try {
        if (fs.existsSync(b.backup)) fs.unlinkSync(b.backup);
      } catch (e) {
        /* ignore */
      }
    });
  } catch (e) {
    backups.forEach(function (b) {
      try {
        if (!fs.existsSync(b.target) && fs.existsSync(b.backup)) {
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
      : 'download-source-unverified',
    files: expectedFilesForManifest(),
    license: {
      senseVoice: 'FunASR Model Open Source License Agreement 1.1',
      sileroVad: 'MIT license upstream, exact bundled ONNX source pending',
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

export async function verifyModelDir(dir) {
  if (!dir) return { ok: false, error: 'missing-dir' };
  var files = {};
  for (var i = 0; i < REQUIRED_FILES.length; i++) {
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
    var hash = await fileSha256(file);
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
      : 'download-source-unverified',
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
    return { ok: true, status: statusFromManifest({ ok: true }) };
  } finally {
    rmDir(staging);
  }
}

function isDownloadPlanComplete() {
  if (!REMOTE_DOWNLOAD_ENABLED) return false;
  return REQUIRED_FILES.every(function (f) {
    return !!(f.url && f.sha256 && f.size);
  });
}

function downloadOne(spec, target, progressBase, progressSpan) {
  return new Promise(function (resolve, reject) {
    var part = path.join(downloadsDir(), spec.name + '.part');
    var received = 0;
    try {
      if (fs.existsSync(part)) received = fs.statSync(part).size;
    } catch (e) {
      received = 0;
    }
    var urlObj = new URL(spec.url);
    var mod = urlObj.protocol === 'http:' ? http : https;
    var headers = { 'User-Agent': 'PodPlayer-ASR-Model-Installer' };
    if (received > 0) headers.Range = 'bytes=' + received + '-';
    var started = Date.now();
    var req = mod.get(spec.url, { headers: headers }, function (res) {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        downloadOne(
          Object.assign({}, spec, { url: res.headers.location }),
          target,
          progressBase,
          progressSpan
        ).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        reject(new Error('download-http-' + res.statusCode));
        return;
      }
      var stream = fs.createWriteStream(part, { flags: received ? 'a' : 'w' });
      installState.req = req;
      res.on('data', function (chunk) {
        if (installState.cancel) {
          req.destroy(new Error('canceled'));
          return;
        }
        received += chunk.length;
        var elapsed = Math.max(1, Date.now() - started);
        var filePercent = Math.min(1, received / spec.size);
        sendProgress({
          status: 'downloading',
          fileName: spec.name,
          receivedBytes: received,
          totalBytes: spec.size,
          percent: Math.round(
            (progressBase + progressSpan * filePercent) * 100
          ),
          speed: Math.round((received * 1000) / elapsed),
        });
      });
      res.pipe(stream);
      stream.on('finish', function () {
        stream.close(async function () {
          try {
            var hash = await fileSha256(part);
            if (hash.toLowerCase() !== spec.sha256) {
              reject(new Error('sha256-mismatch:' + spec.name));
              return;
            }
            fs.renameSync(part, target);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function installModel() {
  if (!isDownloadPlanComplete()) {
    return {
      ok: false,
      error: 'download-source-unverified',
      message:
        'Remote download is disabled until the exact model URLs, hashes, and licenses are confirmed.',
      status: statusFromManifest(),
    };
  }
  if (installState.running) return { ok: false, error: 'install-running' };
  if (!acquireLock()) return { ok: false, error: 'install-locked' };
  installState.running = true;
  installState.cancel = false;
  installState.startedAt = Date.now();
  var staging = '';
  try {
    var dir = getManagedModelDir();
    safeMkdir(dir);
    safeMkdir(downloadsDir());
    staging = path.join(dir, '.staging-download-' + Date.now());
    safeMkdir(staging);
    for (var i = 0; i < REQUIRED_FILES.length; i++) {
      var spec = REQUIRED_FILES[i];
      await downloadOne(
        spec,
        path.join(staging, spec.name),
        i / REQUIRED_FILES.length,
        1 / REQUIRED_FILES.length
      );
    }
    writeNotices(staging);
    var verified = await verifyModelDir(staging);
    if (!verified.ok) return verified;
    replaceManagedFilesFromStaging(staging);
    ['LICENSE.txt', 'NOTICE.txt'].forEach(function (name) {
      fs.copyFileSync(path.join(staging, name), path.join(dir, name));
    });
    writeManifest(dir, buildManifest(dir, 'remote-download'));
    sendProgress({ status: 'done', percent: 100 });
    return { ok: true, status: statusFromManifest({ ok: true }) };
  } catch (e) {
    sendProgress({
      status: installState.cancel ? 'canceled' : 'error',
      error: String((e && e.message) || e),
    });
    return {
      ok: false,
      error: installState.cancel ? 'canceled' : String((e && e.message) || e),
      status: statusFromManifest(),
    };
  } finally {
    installState.running = false;
    installState.req = null;
    if (staging) rmDir(staging);
    releaseLock();
  }
}

export function registerAsrModelIpc(getWindow) {
  _getWindow = getWindow;

  ipcMain.handle('asr:modelStatus', async function () {
    return statusFromManifest();
  });

  ipcMain.handle('asr:modelInstall', async function () {
    return installModel();
  });

  ipcMain.handle('asr:modelCancelInstall', async function () {
    installState.cancel = true;
    try {
      if (installState.req) installState.req.destroy(new Error('canceled'));
    } catch (e) {
      /* ignore */
    }
    return { ok: true, status: statusFromManifest() };
  });

  ipcMain.handle('asr:modelVerify', async function (_e, payload) {
    var dir = (payload && payload.dir) || getManagedModelDir();
    var res = await verifyModelDir(dir);
    if (res.ok && dir === getManagedModelDir()) {
      writeNotices(dir);
      writeManifest(dir, buildManifest(dir, 'manual-verify'));
    }
    return Object.assign({}, res, { status: statusFromManifest(res) });
  });

  ipcMain.handle('asr:modelSelectLocalDir', async function () {
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
  });

  ipcMain.handle('asr:modelRemove', async function () {
    if (!acquireLock()) return { ok: false, error: 'install-locked' };
    try {
      rmDir(getManagedModelDir());
      return { ok: true, status: statusFromManifest() };
    } finally {
      releaseLock();
    }
  });
}
