// [缓存·B 流播缓存代理 · tee 模型] 边播边缓存的根治。
//
// 关键思路：播放器经本地 express 的 /pa 播放时，主进程**对上游只开一条连接**，把这条流
//   **同时**喂给播放器(直接 pipe)**和**写进本地缓存文件(三通/tee)。
//   → 网络上只有这一条连接(就是播放器本来要走的那条)，缓存是它的"分流副本"，**绝不另起下载抢带宽**；
//   播放健壮性 == 现有直连流播(tee 只是顺手写盘，写盘失败也不影响播放)。
//   线性听到哪、缓存就攒到哪；连续续听会把 .part 接着写长，整集听完即落正式缓存文件，下次命中 pathMap 秒播。
//
// 为什么不"先下到本地再让播放器读本地"(tail-serve)：那要处理"服务增长文件/等字节/seek/无Content-Length"
//   一堆边界，盲写难做对(审查已暴露多个会 hang/放不出的坑)。tee 模型把播放交还给"上游直连"这条久经验证的
//   路径，代理只做无害的旁路写盘，简单且稳。
//
// 安全：① 受设置 audioCacheEnabled 控制(渲染端不启用就不拼 /pa)；② 播放器侧对 /pa 失败有 fallback 回退直连；
//   ③ 任何上游错误都让响应结束，触发播放器 fallback；④ tee 写盘任何异常都"只停止缓存、不打断播放"。
//
// ⚠️ 本文件在 src/electron/(主进程 Node14) → 禁用 ?./??，统一 && / ||。
import { ipcMain } from 'electron';
import {
  getPodcastsDir,
  podcastHashOf,
  safeFileName,
  guessExt,
  streamGetWithFallback,
} from './podcastDownload';
import fs from 'fs';
import path from 'path';

const PART_SUFFIX = '.pcache'; // 代理在途缓存(与手动下载的 .part 区分，互不干扰)
const _teeing = new Set(); // 正在写缓存的 episodeId(避免同集并发请求重复写)

function mimeOf(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.mp3') return 'audio/mpeg';
  if (e === '.m4a' || e === '.aac' || e === '.mp4') return 'audio/mp4';
  if (e === '.ogg' || e === '.opus') return 'audio/ogg';
  if (e === '.wav') return 'audio/wav';
  return 'audio/mpeg';
}

function dirGuidFor(eid) {
  const idx = String(eid || '').indexOf('::');
  const feedUrl = idx > 0 ? eid.slice(0, idx) : '';
  const guid = idx > 0 ? eid.slice(idx + 2) : eid;
  return {
    dir: path.join(getPodcastsDir(), podcastHashOf(feedUrl)),
    guid,
  };
}

function parseRangeStart(rangeHeader) {
  if (!rangeHeader) return 0;
  const m = String(rangeHeader).match(/bytes=(\d+)-/);
  return m ? Number(m[1]) || 0 : 0;
}

// 完整缓存文件按 Range 静态服务(206/200)。正常情况下渲染端命中 pathMap 会直接 file://，这里只是兜底。
function serveStaticFile(req, res, filePath) {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch (e) {
    res.statusCode = 404;
    res.end();
    return;
  }
  if (size <= 0) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const start = parseRangeStart(req.headers && req.headers.range);
  if (start >= size) {
    res.statusCode = 416;
    res.setHeader('Content-Range', 'bytes */' + size);
    res.end();
    return;
  }
  const hasRange = !!(req.headers && req.headers.range);
  res.statusCode = hasRange ? 206 : 200;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeOf(path.extname(filePath)));
  res.setHeader('Content-Length', size - start);
  if (hasRange) {
    res.setHeader(
      'Content-Range',
      'bytes ' + start + '-' + (size - 1) + '/' + size
    );
  }
  fs.createReadStream(filePath, { start })
    .on('error', () => {
      if (!res.destroyed) res.end();
    })
    .pipe(res);
}

// 把上游响应「直接喂播放器 + 顺手 tee 一份进 .part」。tee 只在「从 0 / 或正好接上 .part 末尾」时进行(保持
//   缓存文件 contiguous from 0)，seek 到别处则只透传不缓存。tee 任何异常都只停缓存、绝不打断播放。
function streamAndTee(res, up, status, eid, audioUrl, start) {
  // 透传上游头(让播放器拿到正确 Content-Length/Range/Type → 可 seek)
  const ct = up.headers['content-type'];
  const ext = guessExt(audioUrl, ct);
  const dg = dirGuidFor(eid);
  const finalPath = path.join(dg.dir, safeFileName(dg.guid) + ext);
  const partPath = finalPath + PART_SUFFIX;

  res.statusCode = status === 206 ? 206 : 200;
  res.setHeader('Accept-Ranges', 'bytes');
  if (up.headers['content-type']) {
    res.setHeader('Content-Type', up.headers['content-type']);
  } else {
    res.setHeader('Content-Type', mimeOf(ext));
  }
  if (up.headers['content-length']) {
    res.setHeader('Content-Length', up.headers['content-length']);
  }
  if (status === 206 && up.headers['content-range']) {
    res.setHeader('Content-Range', up.headers['content-range']);
  }

  // 解析总长(从 content-range 的 /T 或 200 的 content-length) → 用于判断"是否下满可落正式文件"
  let total = 0;
  if (status === 206 && up.headers['content-range']) {
    const m = String(up.headers['content-range']).match(/\/(\d+)\s*$/);
    if (m) total = Number(m[1]) || 0;
  } else if (up.headers['content-length']) {
    total = Number(up.headers['content-length']) || 0;
  }

  // 是否 tee：contiguous(从0 / 正好接上 .part 末尾) + 该集当前没在写
  let partSize = 0;
  try {
    if (fs.existsSync(partPath)) partSize = fs.statSync(partPath).size;
  } catch (e) {
    partSize = 0;
  }
  const contiguous = start === 0 || start === partSize;
  let ws = null;
  if (!_teeing.has(eid) && contiguous && !fs.existsSync(finalPath)) {
    try {
      if (!fs.existsSync(dg.dir)) fs.mkdirSync(dg.dir, { recursive: true });
      ws = fs.createWriteStream(partPath, {
        flags: start > 0 ? 'r+' : 'w',
        start: start > 0 ? start : 0,
      });
      _teeing.add(eid);
      ws.on('error', () => {
        // 写盘失败 → 只停缓存、不打断播放
        try {
          ws.destroy();
        } catch (e) {
          /* ignore */
        }
        ws = null;
        _teeing.delete(eid);
      });
    } catch (e) {
      ws = null;
    }
  }

  let ended = false;
  // [审P1·idle 看门狗] 上游响应开始后若中途静默挂起(连接不断、不发数据，国际 CDN/被打断隧道常见)，
  //   up 既不 'data' 也不 'end'/'error' → res 永不 end → 播放器无限 buffering 且不回退。
  //   故：收到数据就续命；超 IDLE_MS 仍无新数据 → 主动 destroy 上游 → 触发 up 'error' → res.end → 播放器 fallback。
  //   注意：因背压主动 up.pause() 期间本就不该有数据，那段要 clearIdle，避免把"正常背压"误判成"静默"杀掉。
  let idleTimer = null;
  const IDLE_MS = 20000;
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      try {
        up.destroy(new Error('upstream idle timeout'));
      } catch (e) {
        /* ignore */
      }
    }, IDLE_MS);
  };
  const stopTee = ok => {
    if (!ws) return;
    const w = ws;
    ws = null;
    _teeing.delete(eid);
    try {
      w.end(() => {
        if (!ok) return;
        // 下满(达到 total 或 total 未知但上游正常结束) → 落正式文件 + 通知渲染端登记
        try {
          let size = 0;
          if (fs.existsSync(partPath)) size = fs.statSync(partPath).size;
          const complete = total ? size >= total : ok;
          if (complete && size > 0) {
            fs.renameSync(partPath, finalPath);
            const w2 = getWindowRef && getWindowRef();
            if (w2 && !w2.isDestroyed()) {
              w2.webContents.send('podcast:audioCached', {
                episodeId: eid,
                filePath: finalPath,
                bytesTotal: size,
              });
            }
          }
        } catch (e) {
          /* rename/通知失败不影响播放 */
        }
      });
    } catch (e) {
      /* ignore */
    }
  };

  res.on('close', () => {
    // 播放器断开(切集/seek/关闭) → 停上游 + 收尾 tee(保留 .part 前缀供下次续)
    clearIdle();
    try {
      up.destroy();
    } catch (e) {
      /* ignore */
    }
    if (!ended) stopTee(false);
  });

  up.on('data', chunk => {
    if (res.destroyed) return;
    armIdle(); // 收到数据 → 重置静默看门狗
    const ok = res.write(chunk);
    if (ws) {
      try {
        ws.write(chunk);
        // [审P1·tee 内存上限] 磁盘慢于网络时 ws 缓冲会无上限堆积(峰值≈整集)。缓冲超 16MB → 放弃本次缓存，
        //   保内存与播放(tee 失败本就只停缓存、不打断播放)；下次播放该集会再尝试缓存。
        if (ws.writableLength > 16 * 1024 * 1024) stopTee(false);
      } catch (e) {
        stopTee(false);
      }
    }
    if (!ok) {
      clearIdle(); // 背压主动暂停期间不算"上游静默"，避免误杀正常慢放
      up.pause();
      res.once('drain', () => {
        if (!res.destroyed) {
          up.resume();
          armIdle();
        }
      });
    }
  });
  up.on('end', () => {
    clearIdle();
    ended = true;
    stopTee(true);
    if (!res.destroyed) res.end();
  });
  up.on('error', () => {
    clearIdle();
    ended = true;
    stopTee(false);
    if (!res.destroyed) res.end();
  });

  armIdle(); // 启动看门狗(防上游建连后迟迟不发首字节)
}

let getWindowRef = null;

export function registerPodcastAudioProxy(expressApp, getWindow, expressPort) {
  getWindowRef = getWindow;
  // 渲染端(dev 在 webpack 端口，与 express 不同)需显式拿 express 基址来拼 /pa 绝对地址
  ipcMain.handle('podcast:audioProxyBase', () => {
    return 'http://127.0.0.1:' + expressPort;
  });

  // GET /pa?eid=<episodeId>&u=<encodeURIComponent(audioUrl)>
  expressApp.get('/pa', (req, res) => {
    let eid = '';
    let audioUrl = '';
    try {
      eid = (req.query && req.query.eid) || '';
      audioUrl = (req.query && req.query.u) || '';
      if (!eid || !audioUrl) {
        res.statusCode = 400;
        res.end();
        return;
      }
      // 已完整缓存 → 直接当静态文件按 Range 服务(兜底；通常渲染端命中 pathMap 已 file://)
      const ext0 = guessExt(audioUrl, '');
      const dg = dirGuidFor(eid);
      const finalGuess = path.join(dg.dir, safeFileName(dg.guid) + ext0);
      if (fs.existsSync(finalGuess)) {
        serveStaticFile(req, res, finalGuess);
        return;
      }
      const start = parseRangeStart(req.headers && req.headers.range);
      streamGetWithFallback(audioUrl, start)
        .then(({ res: up, status }) => {
          if (res.destroyed) {
            try {
              up.destroy();
            } catch (e) {
              /* ignore */
            }
            return;
          }
          streamAndTee(res, up, status, eid, audioUrl, start);
        })
        .catch(() => {
          // 上游失败 → 结束响应，播放器 fallback 回退直连
          try {
            res.statusCode = 502;
            res.end();
          } catch (e) {
            /* ignore */
          }
        });
    } catch (e) {
      try {
        res.statusCode = 502;
        res.end();
      } catch (e2) {
        /* ignore */
      }
    }
  });
}
