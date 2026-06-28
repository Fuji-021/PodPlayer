/* eslint-disable */
// [转文字稿] ASR 子进程（独立引擎，与播放核心软解耦）
// ----------------------------------------------------------------------------
// 由主进程 src/electron/asr.js 以 `spawn(process.execPath, [本文件], {ELECTRON_RUN_AS_NODE:1})`
// 拉起 —— 即用 app 自带的 Electron 二进制当纯 Node 跑，dev/打包都无需外部 Node。
//
// ⚠️ 本文件**不被 webpack 打包**（asr.js 只把它当一个磁盘路径 spawn，从不 import），
//    因此必须是纯 CommonJS、Node 14 语法（禁可选链 ?. / 空值合并 ?? / AbortController）。
//    sherpa-onnx-node / ffmpeg-static 在运行时从项目 node_modules 解析（require 即可）。
//
// 流程（faithful port of asr-benchmark/sherpa_run_vad.py，本轮已实测跑通）：
//   1. ffmpeg 把原始音频(mp3/m4a/…) 抽成 16kHz 单声道 wav（落 workDir/audio16k.wav）
//   2. silero-VAD 流式切段（绝不整段喂——长序列退化会漏字+变慢，硬约束）
//   3. SenseVoice int8 逐段转录，每段转完即 append 到 segments.jsonl（崩溃/取消也保住进度）
//   4. 全部完成→汇总 segments.json + transcript.txt + transcript.srt，删中间 wav
//
// 续转：保留 audio16k.wav 与 segments.jsonl；重跑（VAD 确定性、同样切段）时按已落盘段数
//   跳过已转段（只省 ASR、不省 VAD），从断点继续。取消=主进程 child.kill()，partial 已落盘。
//
// 进度/分段/完成/错误经 IPC channel（process.send）回传主进程；无 IPC 时回退 stdout 标记行。

var fs = require('fs');
var path = require('path');
var execFileSync = require('child_process').execFileSync;

function send(ev) {
  try {
    if (process.send) {
      process.send(ev);
    } else {
      process.stdout.write('@@ASR@@' + JSON.stringify(ev) + '\n');
    }
  } catch (e) {
    /* ignore */
  }
}

function readJsonlSegments(jsonlPath) {
  var segs = [];
  if (!fs.existsSync(jsonlPath)) return segs;
  try {
    var lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i].trim();
      if (!L) continue;
      try {
        var o = JSON.parse(L);
        if (o && typeof o.idx === 'number') segs.push(o);
      } catch (e) {
        /* 损坏的尾行（如杀进程时半截写入）丢弃 → 续转会重转该段，安全 */
      }
    }
  } catch (e) {
    /* ignore */
  }
  // 按 idx 去重排序（防极端情况下重复 append）
  segs.sort(function (a, b) {
    return a.idx - b.idx;
  });
  var out = [];
  var seen = {};
  for (var j = 0; j < segs.length; j++) {
    if (seen[segs[j].idx]) continue;
    seen[segs[j].idx] = 1;
    out.push(segs[j]);
  }
  return out;
}

function srtTime(t) {
  var ms = Math.floor(t * 1000);
  var h = Math.floor(ms / 3600000);
  var m = Math.floor((ms % 3600000) / 60000);
  var s = Math.floor((ms % 60000) / 1000);
  var mm = ms % 1000;
  function p(n, w) {
    var x = String(n);
    while (x.length < w) x = '0' + x;
    return x;
  }
  return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(mm, 3);
}

function main() {
  var raw = process.argv[2] || '{}';
  var params = JSON.parse(raw);
  // params: audioPath, workDir, modelFile, tokensFile, vadModel, numThreads, language, model

  var sherpa = require('sherpa-onnx-node');
  var ffmpegPath = require('ffmpeg-static');

  var workDir = params.workDir;
  var wavPath = path.join(workDir, 'audio16k.wav');
  var jsonlPath = path.join(workDir, 'segments.jsonl');
  var segPath = path.join(workDir, 'segments.json');
  var txtPath = path.join(workDir, 'transcript.txt');
  var srtPath = path.join(workDir, 'transcript.srt');

  // ---- 1) ffmpeg 抽 16k 单声道 wav（已存在=续转，跳过） ----
  if (!fs.existsSync(wavPath)) {
    send({ type: 'phase', phase: 'decoding' });
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      throw new Error('ffmpeg 不可用');
    }
    // 写到 .part 再原子改名，避免半截 wav 被续转误用
    var wavPart = wavPath + '.part';
    execFileSync(
      ffmpegPath,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        params.audioPath,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        'wav',
        wavPart,
      ],
      { stdio: 'ignore' }
    );
    fs.renameSync(wavPart, wavPath);
  }

  // ---- 2) 读 wav（必要时重采样到 16k） ----
  send({ type: 'phase', phase: 'loading' });
  var wave = sherpa.readWave(wavPath);
  var samples = wave.samples;
  var sr = wave.sampleRate;
  if (sr !== 16000) {
    var rs = new sherpa.LinearResampler(sr, 16000, 16000, 1);
    samples = rs.resample(samples, true);
    sr = 16000;
  }
  var totalSec = samples.length / 16000;

  // ---- 续转：读已落盘段 ----
  var doneSegs = readJsonlSegments(jsonlPath);
  var doneCount = doneSegs.length;
  // 若 jsonl 有空洞/乱序，规整重写一份连续的，保证后续 append 接得上
  if (doneCount > 0) {
    var rewrite = '';
    for (var k = 0; k < doneSegs.length; k++) {
      doneSegs[k].idx = k + 1;
      rewrite += JSON.stringify(doneSegs[k]) + '\n';
    }
    fs.writeFileSync(jsonlPath, rewrite);
  }
  send({ type: 'resume', doneCount: doneCount, totalSec: totalSec });

  // ---- 3) 引擎：SenseVoice int8 + silero VAD（参数来自已实测 sherpa_run_vad.py） ----
  var recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: params.modelFile,
        useInverseTextNormalization: 1,
        language: params.language || 'auto',
      },
      tokens: params.tokensFile,
      numThreads: Number(params.numThreads) || 4,
      provider: 'cpu',
      debug: 0,
    },
  });
  var vad = new sherpa.Vad(
    {
      sileroVad: {
        model: params.vadModel,
        threshold: 0.5,
        minSpeechDuration: 0.1,
        minSilenceDuration: 0.25,
        maxSpeechDuration: 20.0,
        windowSize: 512,
      },
      sampleRate: 16000,
      numThreads: 1,
      debug: false,
    },
    300
  );
  var win = vad.config.sileroVad.windowSize;

  var idx = 0;
  var lastEmit = 0;
  function emitProgress(end, force) {
    var now = Date.now();
    if (force || now - lastEmit > 300) {
      lastEmit = now;
      send({
        type: 'progress',
        processedSec: end,
        totalSec: totalSec,
        segCount: idx,
      });
    }
  }

  function handleSeg(segment) {
    var start = segment.start / 16000;
    var end = start + segment.samples.length / 16000;
    idx++;
    if (idx <= doneCount) {
      // 续转：该段已转过 → 只推进度，不重复解码
      emitProgress(end, false);
      return;
    }
    var stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: segment.samples });
    recognizer.decode(stream);
    var r = recognizer.getResult(stream);
    var text = (r.text || '').trim();
    // [质量优化·事件过滤] 多存 event/lang（如 <|BGM|>/<|zh|>），供渲染端做事件分类/垃圾过滤。
    //   只在"取结果"处多读两个字段，不动 VAD/识别链路（软耦合）。续转旧行缺这两字段也兼容。
    var rec = {
      idx: idx,
      start: start,
      end: end,
      text: text,
      event: r.event || '',
      lang: r.lang || '',
    };
    // 边转边落盘（同步 append，崩溃/取消也保住此段）
    fs.appendFileSync(jsonlPath, JSON.stringify(rec) + '\n');
    if (text.length > 0) send({ type: 'segment', seg: rec });
    emitProgress(end, false);
  }

  send({ type: 'phase', phase: 'transcribing' });
  for (var i = 0; i + win <= samples.length; i += win) {
    vad.acceptWaveform(samples.subarray(i, i + win));
    while (!vad.isEmpty()) {
      var s = vad.front();
      vad.pop();
      handleSeg(s);
    }
  }
  vad.flush();
  while (!vad.isEmpty()) {
    var s2 = vad.front();
    vad.pop();
    handleSeg(s2);
  }
  emitProgress(totalSec, true);

  // ---- 4) 汇总落盘：segments.json + transcript.txt + transcript.srt ----
  var all = readJsonlSegments(jsonlPath);
  // 跳空文本段不进 txt（保留在 json/srt 里供时间轴对齐？此处 txt 只收有字的）
  var txtLines = [];
  var srtLines = [];
  for (var a = 0; a < all.length; a++) {
    var seg = all[a];
    if (seg.text && seg.text.length > 0) txtLines.push(seg.text);
    srtLines.push(
      String(a + 1) +
        '\n' +
        srtTime(seg.start) +
        ' --> ' +
        srtTime(seg.end) +
        '\n' +
        (seg.text || '') +
        '\n'
    );
  }
  fs.writeFileSync(
    segPath,
    JSON.stringify({
      model: params.model || '',
      language: params.language || 'auto',
      totalSec: totalSec,
      segCount: all.length,
      segments: all,
    })
  );
  fs.writeFileSync(txtPath, txtLines.join('\n'));
  fs.writeFileSync(srtPath, srtLines.join('\n'));

  // 完成→删中间 wav 释放空间（5h ≈ 0.5GB）
  try {
    fs.unlinkSync(wavPath);
  } catch (e) {
    /* ignore */
  }

  send({
    type: 'done',
    segCount: all.length,
    durationMs: Math.round(totalSec * 1000),
    segPath: segPath,
    txtPath: txtPath,
    srtPath: srtPath,
  });
}

try {
  main();
} catch (e) {
  send({ type: 'error', msg: String((e && e.message) || e) });
  try {
    process.exit(1);
  } catch (e2) {
    /* ignore */
  }
}
