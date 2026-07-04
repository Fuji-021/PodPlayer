// [转文字稿] 主进程 ASR 模块（软耦合：与播放核心完全隔离，引擎可替换）
// ----------------------------------------------------------------------------
// 职责：单任务队列 + 进度/取消/状态 + 子进程编排 + 模型检测。重活全在子进程
//   src/electron/asrWorker.js（spawn 的 Electron-as-Node），本模块只用 child_process/fs/path，
//   不碰原生模块（绕开 webpack 打包原生 .node 的坑）。
//
// ⚠️ 本文件被 webpack 打入 background bundle → 禁可选链 ?. / 空值合并 ?? / AbortController（Node 14）。
//
// IPC：asr:transcribe / asr:cancel / asr:status / asr:read / asr:delete / asr:export
//   事件（主→渲染）：asr:progress / asr:segment / asr:done / asr:error / asr:canceled
import { ipcMain, app, dialog } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  getVerifiedModelConfigSync,
  getVerifiedModelConfigForUse,
} from './asrModelManager';

// 开发期复用 asr-benchmark 已部署的 int8 模型（不进仓库/不进基础包）。
// 可经 设置(asrModelDir/asrVadModel) 或环境变量覆盖；正式版「一键部署」后改指 userData 模型目录。
var DEFAULT_MODEL_DIR =
  'D:\\MyYesPlayerMusic\\chat_to_word\\asr-benchmark\\sherpa\\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
var DEFAULT_VAD =
  'D:\\MyYesPlayerMusic\\chat_to_word\\asr-benchmark\\sherpa\\silero_vad.onnx';
var MODEL_NAME = 'SenseVoiceSmall-int8';

var _getWindow = null;
var _store = null;
var active = null; // { episodeId, child, canceled, settled }
var queue = []; // [{ episodeId, audioPath, title, durationSec }]

function getSettings() {
  var s = {};
  try {
    if (_store && _store.get) s = _store.get('settings') || {};
  } catch (e) {
    s = {};
  }
  return s || {};
}

function resolveConfig() {
  var s = getSettings();
  var verified = getVerifiedModelConfigSync();
  var base = {
    numThreads: Number(s.asrThreads) || 4,
    language: s.asrLanguage || 'auto',
  };
  if (verified && verified.ready) {
    return Object.assign({}, base, {
      modelDir: verified.modelDir,
      modelFile: verified.modelFile,
      tokensFile: verified.tokensFile,
      vadModel: verified.vadModel,
      modelSource: verified.source || 'verified',
      verifiedAt: verified.verifiedAt || '',
      fallback: false,
    });
  }
  if (!allowDevModelFallback()) {
    return Object.assign({}, base, {
      modelDir: '',
      modelFile: '',
      tokensFile: '',
      vadModel: '',
      modelSource: 'missing',
      fallback: false,
    });
  }
  var modelDir =
    s.asrModelDir || process.env.PODPLAYER_ASR_MODEL_DIR || DEFAULT_MODEL_DIR;
  var vadModel = s.asrVadModel || process.env.PODPLAYER_ASR_VAD || DEFAULT_VAD;
  return {
    numThreads: base.numThreads,
    language: base.language,
    modelDir: modelDir,
    modelFile: path.join(modelDir, 'model.int8.onnx'),
    tokensFile: path.join(modelDir, 'tokens.txt'),
    vadModel: vadModel,
    modelSource: 'dev-fallback',
    fallback: true,
  };
}

async function resolveConfigForUse() {
  var s = getSettings();
  var verified = await getVerifiedModelConfigForUse();
  var base = {
    numThreads: Number(s.asrThreads) || 4,
    language: s.asrLanguage || 'auto',
  };
  if (verified && verified.ok && verified.config) {
    return Object.assign({}, base, verified.config, {
      modelSource: verified.config.source || 'verified',
      fallback: false,
    });
  }
  if (!allowDevModelFallback()) {
    return Object.assign({}, base, {
      modelDir: '',
      modelFile: '',
      tokensFile: '',
      vadModel: '',
      modelSource: 'missing',
      verifyError: (verified && verified.error) || 'model-missing',
      fallback: false,
    });
  }
  return resolveConfig();
}

function modelReady(cfg) {
  try {
    return (
      fs.existsSync(cfg.modelFile) &&
      fs.existsSync(cfg.tokensFile) &&
      fs.existsSync(cfg.vadModel)
    );
  } catch (e) {
    return false;
  }
}

function allowDevModelFallback() {
  if (process.env.PODPLAYER_ASR_DEV_FALLBACK === '1') return true;
  if (process.env.PODPLAYER_PROFILE === 'dev') return true;
  if (!process.env.PODPLAYER_PROFILE && process.env.WEBPACK_DEV_SERVER_URL) {
    return true;
  }
  return false;
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function workDirFor(episodeId) {
  return path.join(app.getPath('userData'), 'transcripts', sha1(episodeId));
}

// asrWorker.js 不被 webpack 打包，是磁盘上的真实文件；按 dev/prod 多候选定位。
function resolveWorkerPath() {
  var candidates = [
    path.join(process.cwd(), 'src', 'electron', 'asrWorker.js'),
    path.join(__dirname, 'asrWorker.js'),
    path.join(__dirname, '..', 'src', 'electron', 'asrWorker.js'),
  ];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'asrWorker.js'));
  }
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
    } catch (e) {
      /* ignore */
    }
  }
  return candidates[0];
}

function workerEnv() {
  var env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
  if (process.resourcesPath) {
    var paths = [
      path.join(process.resourcesPath, 'app.asar', 'node_modules'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'),
    ];
    env.NODE_PATH = paths
      .concat(env.NODE_PATH ? String(env.NODE_PATH).split(path.delimiter) : [])
      .join(path.delimiter);
  }
  return env;
}

function sendEvent(channel, payload) {
  var w = _getWindow && _getWindow();
  if (w && !w.isDestroyed()) {
    try {
      w.webContents.send(channel, payload);
    } catch (e) {
      /* ignore */
    }
  }
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
    // Node 12/14 兜底
    fs.rmdirSync(dir, { recursive: true });
  } catch (e) {
    /* ignore */
  }
}

function startNext() {
  if (active) return;
  if (!queue.length) return;
  var job = queue.shift();
  runJob(job);
}

async function runJob(job) {
  var cfg;
  try {
    cfg = await resolveConfigForUse();
  } catch (e) {
    sendEvent('asr:error', {
      episodeId: job.episodeId,
      error: String((e && e.message) || e),
    });
    startNext();
    return;
  }
  if (!modelReady(cfg)) {
    sendEvent('asr:error', {
      episodeId: job.episodeId,
      error: cfg.verifyError || 'model-missing',
    });
    startNext();
    return;
  }
  if (!job.audioPath || !fs.existsSync(job.audioPath)) {
    sendEvent('asr:error', {
      episodeId: job.episodeId,
      error: '本地音频文件不存在',
    });
    startNext();
    return;
  }
  var workDir = workDirFor(job.episodeId);
  try {
    fs.mkdirSync(workDir, { recursive: true });
  } catch (e) {
    /* ignore */
  }
  var params = {
    audioPath: job.audioPath,
    workDir: workDir,
    modelFile: cfg.modelFile,
    tokensFile: cfg.tokensFile,
    vadModel: cfg.vadModel,
    numThreads: cfg.numThreads,
    language: cfg.language,
    model: MODEL_NAME,
  };
  var workerPath = resolveWorkerPath();
  var child;
  try {
    child = spawn(process.execPath, [workerPath, JSON.stringify(params)], {
      env: workerEnv(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
  } catch (e) {
    sendEvent('asr:error', {
      episodeId: job.episodeId,
      error: '无法启动转录子进程：' + String((e && e.message) || e),
    });
    startNext();
    return;
  }
  active = {
    episodeId: job.episodeId,
    child: child,
    canceled: false,
    settled: false,
  };
  sendEvent('asr:progress', {
    episodeId: job.episodeId,
    status: 'running',
    processedSec: 0,
    totalSec: job.durationSec || 0,
    segCount: 0,
  });

  child.on('message', function (ev) {
    if (!ev || !active || active.episodeId !== job.episodeId) return;
    if (ev.type === 'progress') {
      sendEvent('asr:progress', {
        episodeId: job.episodeId,
        status: 'running',
        processedSec: ev.processedSec,
        totalSec: ev.totalSec,
        segCount: ev.segCount,
      });
    } else if (ev.type === 'phase') {
      sendEvent('asr:progress', {
        episodeId: job.episodeId,
        status: 'running',
        phase: ev.phase,
        totalSec: job.durationSec || 0,
      });
    } else if (ev.type === 'segment') {
      sendEvent('asr:segment', { episodeId: job.episodeId, seg: ev.seg });
    } else if (ev.type === 'done') {
      active.settled = true;
      sendEvent('asr:done', {
        episodeId: job.episodeId,
        segCount: ev.segCount,
        durationMs: ev.durationMs,
        segPath: ev.segPath,
        txtPath: ev.txtPath,
        srtPath: ev.srtPath,
        model: MODEL_NAME,
      });
    } else if (ev.type === 'error') {
      active.settled = true;
      sendEvent('asr:error', { episodeId: job.episodeId, error: ev.msg });
    }
  });

  var stderrBuf = '';
  if (child.stderr) {
    child.stderr.on('data', function (d) {
      stderrBuf += String(d);
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });
  }

  child.on('error', function (err) {
    if (active && active.episodeId === job.episodeId && !active.settled) {
      active.settled = true;
      sendEvent('asr:error', {
        episodeId: job.episodeId,
        error: String((err && err.message) || err),
      });
    }
  });

  child.on('exit', function (code, signal) {
    var was = active;
    active = null;
    if (was && was.episodeId === job.episodeId && !was.settled) {
      if (was.canceled) {
        sendEvent('asr:canceled', { episodeId: job.episodeId });
      } else {
        sendEvent('asr:error', {
          episodeId: job.episodeId,
          error:
            '转录进程异常退出(code ' +
            code +
            (signal ? '/' + signal : '') +
            ')' +
            (stderrBuf ? '：' + stderrBuf.slice(-300) : ''),
        });
      }
    }
    startNext();
  });
}

export function registerAsrIpc(getWindow, store) {
  _getWindow = getWindow;
  _store = store;

  ipcMain.handle('asr:status', async function (_e, payload) {
    var cfg = resolveConfig();
    var episodeId = (payload && payload.episodeId) || '';
    return {
      ok: true,
      modelReady: modelReady(cfg),
      model: MODEL_NAME,
      modelDir: cfg.modelDir,
      modelSource: cfg.modelSource || '',
      verifiedAt: cfg.verifiedAt || '',
      fallback: !!cfg.fallback,
      busy: !!active,
      busyEpisodeId: active ? active.episodeId : '',
      queued: queue.map(function (j) {
        return j.episodeId;
      }),
      isThisActive: !!(active && episodeId && active.episodeId === episodeId),
      isThisQueued:
        !!episodeId &&
        queue.some(function (j) {
          return j.episodeId === episodeId;
        }),
    };
  });

  ipcMain.handle('asr:transcribe', async function (_e, payload) {
    var episodeId = payload && payload.episodeId;
    var audioPath = payload && payload.audioPath;
    if (!episodeId || !audioPath) {
      return { ok: false, error: '缺少参数' };
    }
    var cfg = await resolveConfigForUse();
    if (!modelReady(cfg)) {
      return { ok: false, error: cfg.verifyError || 'model-missing' };
    }
    if (!fs.existsSync(audioPath)) {
      return { ok: false, error: '本地音频文件不存在' };
    }
    if (active && active.episodeId === episodeId) {
      return { ok: true, already: true };
    }
    if (
      queue.some(function (j) {
        return j.episodeId === episodeId;
      })
    ) {
      return { ok: true, queued: true };
    }
    var willQueue = !!active; // 已有任务在跑 → 本任务排队
    queue.push({
      episodeId: episodeId,
      audioPath: audioPath,
      title: (payload && payload.title) || '',
      durationSec: (payload && payload.durationSec) || 0,
    });
    startNext();
    return { ok: true, queued: willQueue };
  });

  ipcMain.handle('asr:cancel', async function (_e, payload) {
    var episodeId = payload && payload.episodeId;
    if (!episodeId) return { ok: false };
    // 排队中 → 直接出队
    var qi = -1;
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].episodeId === episodeId) {
        qi = i;
        break;
      }
    }
    if (qi >= 0) {
      queue.splice(qi, 1);
      sendEvent('asr:canceled', { episodeId: episodeId });
      return { ok: true, dequeued: true };
    }
    if (active && active.episodeId === episodeId) {
      active.canceled = true;
      try {
        active.child.kill();
      } catch (e) {
        /* ignore */
      }
      return { ok: true };
    }
    return { ok: false, error: 'no-such-task' };
  });

  // 读取已落盘文稿（done → segments.json；中断态 → 退回 segments.jsonl 的 partial）
  ipcMain.handle('asr:read', async function (_e, payload) {
    var episodeId = payload && payload.episodeId;
    if (!episodeId) return { ok: false, error: '缺少 episodeId' };
    var dir = workDirFor(episodeId);
    var segPath = path.join(dir, 'segments.json');
    try {
      if (fs.existsSync(segPath)) {
        var data = JSON.parse(fs.readFileSync(segPath, 'utf8'));
        return {
          ok: true,
          segments: data.segments || [],
          totalSec: data.totalSec || 0,
          partial: false,
        };
      }
      var jsonl = path.join(dir, 'segments.jsonl');
      if (fs.existsSync(jsonl)) {
        var segs = [];
        var lines = fs.readFileSync(jsonl, 'utf8').split('\n');
        for (var i = 0; i < lines.length; i++) {
          var L = lines[i].trim();
          if (!L) continue;
          try {
            segs.push(JSON.parse(L));
          } catch (e) {
            /* ignore */
          }
        }
        return { ok: true, segments: segs, totalSec: 0, partial: true };
      }
      return { ok: false, error: 'no-transcript' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('asr:delete', async function (_e, payload) {
    var episodeId = payload && payload.episodeId;
    if (!episodeId) return { ok: false };
    // 正在转这一集 → 先取消
    if (active && active.episodeId === episodeId) {
      active.canceled = true;
      try {
        active.child.kill();
      } catch (e) {
        /* ignore */
      }
    }
    rmDir(workDirFor(episodeId));
    return { ok: true };
  });

  // 导出文稿：内容由渲染端按当前「原文/已优化」模式生成并传入(txt+srt)，
  //   弹「另存为」后按用户选的扩展名写对应内容(不再 copy 磁盘原始文件)。
  ipcMain.handle('asr:exportText', async function (_e, payload) {
    var episodeId = (payload && payload.episodeId) || '';
    if (!episodeId) return { ok: false, error: '缺少 episodeId' };
    var txt = (payload && payload.txt) || '';
    var srt = (payload && payload.srt) || '';
    var rawName = (payload && payload.defaultName) || 'transcript';
    var safe =
      String(rawName)
        .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
        .slice(0, 80) || 'transcript';
    var win = _getWindow && _getWindow();
    var res;
    try {
      res = await dialog.showSaveDialog(win || undefined, {
        title: '导出文字稿',
        defaultPath: safe + '.txt',
        filters: [
          { name: '纯文本', extensions: ['txt'] },
          { name: '字幕 SRT', extensions: ['srt'] },
        ],
      });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    if (!res || res.canceled || !res.filePath) {
      return { ok: false, canceled: true };
    }
    var target = res.filePath;
    var ext = path.extname(target).toLowerCase();
    var content = ext === '.srt' ? srt : txt;
    try {
      fs.writeFileSync(target, content, 'utf8');
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    return { ok: true, path: target };
  });
}
