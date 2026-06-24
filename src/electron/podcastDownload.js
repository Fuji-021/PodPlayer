// [B-32 播客改造] 主进程：单集下载（Node 原生 https/http 版）
//
// 为什么不用 axios：
//   axios 0.26 + follow-redirects 处理 302 重定向时会读取 HTTPS_PROXY 环境变量，
//   在 TUN 代理环境下对重定向后的 https 目标做 http-proxy 隧道握手失败
//   （"socket disconnected before secure TLS connection"）。
//   curl --noproxy 直连这些 CDN 是成功的 → 说明正确做法是「直连」，把代理决策
//   交给 Clash TUN 网卡层（国内 DIRECT、国外走代理）；不开代理时直连国内 CDN 也 OK。
//   Node 原生 https.get 默认就不读代理环境变量，正好满足「开/不开代理都能下」。
//
// [国际下载回退] 但直连对国际 CDN(如 Acast/CloudFront)在「无 TUN」环境会因 DNS 污染(域名被投毒成
//   Facebook IP)→ connect ETIMEDOUT。故策略改为：直连优先(国内 CDN 快、不绕代理)，直连失败时问
//   Chromium 该 URL 该用什么代理(session.resolveProxy，跟随系统代理/PAC、不硬编码端口)，有代理就挂
//   HttpsProxyAgent 经代理回退重试一次 → 国际播客一律能下，且不依赖用户记得开 TUN。
//
// 进度 / 完成 / 失败通过 webContents.send 推回 renderer。
import { app, ipcMain, Notification, session } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { URL } from 'url';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 YesPlayMusicPodcast/0.1';

// [国际下载回退] https-proxy-agent 仅用于「直连失败后的代理回退」。兼容 v5(默认导出是工厂、且带
//   .HttpsProxyAgent 类)与 v7(具名导出类)：统一取类、用 new 实例化。取不到则置 null → 回退不启用、
//   维持纯直连(绝不崩)。webpack 会把它打进主进程包(externals 仅排除 rust-napi)，prod 也在。
let HttpsProxyAgent = null;
try {
  const mod = require('https-proxy-agent');
  HttpsProxyAgent = (mod && mod.HttpsProxyAgent) || mod || null;
} catch (e) {
  HttpsProxyAgent = null;
}

// epId → { res (当前响应流), writeStream, filePath, canceled }
const activeTasks = new Map();

function getPodcastsDir() {
  const dir = path.join(app.getPath('userData'), 'podcasts');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 用 feedUrl 的 sha1 前 12 位作为目录名，避免文件系统对长 URL / 非法字符的限制
function podcastHashOf(feedUrl) {
  return crypto
    .createHash('sha1')
    .update(String(feedUrl || ''))
    .digest('hex')
    .slice(0, 12);
}

// 根据 audioUrl + content-type 推断扩展名
function guessExt(audioUrl, contentType) {
  if (contentType) {
    if (/mpeg/i.test(contentType)) return '.mp3';
    if (/aac|mp4|m4a/i.test(contentType)) return '.m4a';
    if (/ogg|opus/i.test(contentType)) return '.ogg';
    if (/wav/i.test(contentType)) return '.wav';
  }
  try {
    const u = new URL(audioUrl);
    const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (m) return '.' + m[1].toLowerCase();
  } catch (e) {
    // ignore
  }
  return '.mp3';
}

function safeFileName(guid) {
  return crypto
    .createHash('sha1')
    .update(String(guid || ''))
    .digest('hex')
    .slice(0, 16);
}

// 发起 GET 并手动跟随重定向，resolve 成最终 200 响应流。
// 完全不使用代理环境变量（直连，交给 TUN 网卡层处理）。
function streamGet(url, redirects = 0, proxyUrl = '') {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      reject(new Error('重定向次数过多'));
      return;
    }
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error('非法音频地址'));
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    // [国际下载回退] 有代理 + https 目标 → 挂 HttpsProxyAgent(经代理 CONNECT 隧道直达 CDN)；
    //   无代理(默认/直连优先) 或 http 目标 → agent 留空，Node 默认直连，与原行为完全一致。
    let agent;
    if (proxyUrl && HttpsProxyAgent && u.protocol === 'https:') {
      try {
        agent = new HttpsProxyAgent(proxyUrl);
      } catch (e) {
        agent = undefined;
      }
    }
    const req = lib.get(
      url,
      {
        agent,
        headers: { 'User-Agent': UA, Accept: '*/*' },
      },
      res => {
        const code = res.statusCode || 0;
        // 3xx 重定向：丢弃 body，跟随 location
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, url).href;
          } catch (e) {
            reject(new Error('重定向地址非法'));
            return;
          }
          streamGet(next, redirects + 1, proxyUrl).then(resolve, reject);
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error('HTTP ' + code));
          return;
        }
        resolve({ res, finalUrl: url });
      }
    );
    req.on('error', reject);
    // 连接级超时：30s 内没有任何响应头则放弃
    req.setTimeout(30000, () => {
      req.destroy(new Error('连接超时'));
    });
  });
}

// [国际下载回退] 问 Chromium：该 URL 该走什么代理(跟随系统代理 / PAC，不硬编码端口)。
//   resolveProxy 返回 PAC 串如 'PROXY 127.0.0.1:7897; DIRECT' / 'HTTPS host:port' / 'DIRECT'。
//   取第一个 PROXY/HTTPS 条目 → 'http(s)://host:port'；DIRECT 或失败 → '' (= 不回退)。
async function resolveProxyForUrl(url) {
  try {
    const ses = session && session.defaultSession;
    if (!ses || !ses.resolveProxy) return '';
    const pac = await ses.resolveProxy(url);
    const m = String(pac || '').match(/(PROXY|HTTPS)\s+([^;\s]+)/i);
    if (!m) return '';
    const scheme = m[1].toUpperCase() === 'HTTPS' ? 'https://' : 'http://';
    return scheme + m[2];
  } catch (e) {
    return '';
  }
}

// [国际下载回退] 直连优先(国内 CDN 快、不绕代理)；直连失败(国际 CDN 域名常被 DNS 污染 →
//   ETIMEDOUT/ENOTFOUND/ECONNRESET/连接超时)时，问 Chromium 拿代理回退重试一次。
//   代理不可用(DIRECT / 无 https-proxy-agent) → 抛回原始直连错误(报错信息保持原样)。
async function streamGetWithFallback(url) {
  try {
    return await streamGet(url);
  } catch (directErr) {
    const proxyUrl = await resolveProxyForUrl(url);
    if (!proxyUrl || !HttpsProxyAgent) throw directErr;
    console.log(
      '[download] 直连失败，回退代理重试:',
      proxyUrl,
      '|',
      (directErr && directErr.message) || directErr
    );
    return await streamGet(url, 0, proxyUrl);
  }
}

export function registerPodcastDownloadIpc(getWindow) {
  // [orphan-download] 启动期清理上次崩溃/被杀进程残留的 *.part 半成品(正常完成已 rename 成正式名、
  //   不会留 part)。一次性同步扫 getPodcastsDir() 下各档目录删所有 *.part，避免占空间 + 污染 relink。
  try {
    const sweepBase = getPodcastsDir();
    if (fs.existsSync(sweepBase)) {
      const subs = fs.readdirSync(sweepBase);
      for (let i = 0; i < subs.length; i++) {
        const subDir = path.join(sweepBase, subs[i]);
        let files;
        try {
          files = fs.readdirSync(subDir);
        } catch (e) {
          continue;
        }
        for (let j = 0; j < files.length; j++) {
          const fn = files[j];
          if (fn.length > 5 && fn.slice(-5) === '.part') {
            try {
              fs.unlinkSync(path.join(subDir, fn));
            } catch (e) {
              // ignore
            }
          }
        }
      }
    }
  } catch (e) {
    // sweep 失败不影响下载功能
  }

  // 启动下载
  ipcMain.handle('podcast:download:start', async (_e, payload) => {
    const { episodeId, feedUrl, guid, audioUrl, title } = payload || {};
    console.log('[download] start request', { episodeId, audioUrl });
    if (!episodeId || !audioUrl) {
      return { ok: false, error: '缺少 episodeId / audioUrl' };
    }
    if (activeTasks.has(episodeId)) {
      return { ok: false, error: '已经在下载中' };
    }
    try {
      const dir = path.join(getPodcastsDir(), podcastHashOf(feedUrl));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const { res, finalUrl } = await streamGetWithFallback(audioUrl);
      console.log(
        '[download] response 200',
        res.headers['content-type'],
        res.headers['content-length']
      );

      const ext = guessExt(finalUrl || audioUrl, res.headers['content-type']);
      // [orphan-download] 写 .part 临时文件，writeStream 'finish' 后原子 rename 成正式名 finalPath。
      //   崩溃/被杀进程时 finish 不触发 → 只会残留 *.part(启动期 sweep 清掉)，绝不留下截断的正式
      //   文件被 relink 误判为"已完成"。filePath 仍指 .part(failDownload 删的就是它，无需改动)。
      const finalPath = path.join(dir, safeFileName(guid) + ext);
      const filePath = finalPath + '.part';
      const total = Number(res.headers['content-length']) || 0;
      const writeStream = fs.createWriteStream(filePath);
      const task = {
        res,
        writeStream,
        filePath,
        canceled: false,
        settled: false,
        title: String(title || ''),
      };
      activeTasks.set(episodeId, task);

      // [审P1-1 修] 统一失败收尾：去重(settled) + 停两端流 + 删半成品 + 上报 error(单集不再卡"下载中")。
      //   核心：writeStream 的 'error'(磁盘满 ENOSPC / 目录被删/只读 ENOENT·EACCES)此前无监听，
      //   Node 对未监听的 stream 'error' 会直接 throw → **整个 Electron 主进程崩溃**。这里补上兜底。
      const failDownload = (err, where) => {
        if (task.settled) return;
        task.settled = true;
        activeTasks.delete(episodeId);
        try {
          res.destroy();
        } catch (e) {
          // ignore
        }
        try {
          writeStream.destroy();
        } catch (e) {
          // ignore
        }
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
          // ignore
        }
        if (task.canceled) return;
        console.error(
          '[download]',
          where,
          'error',
          episodeId,
          err && (err.message || err)
        );
        const w = getWindow && getWindow();
        if (w && !w.isDestroyed()) {
          w.webContents.send('podcast:download:error', {
            episodeId,
            error: String((err && err.message) || err),
          });
        }
      };

      let done = 0;
      let lastSent = 0;
      res.on('data', chunk => {
        done += chunk.length;
        const now = Date.now();
        const win = getWindow && getWindow();
        if (
          win &&
          !win.isDestroyed() &&
          (now - lastSent > 300 || (total && done - lastSent > total / 100))
        ) {
          lastSent = now;
          win.webContents.send('podcast:download:progress', {
            episodeId,
            bytesDone: done,
            bytesTotal: total,
          });
        }
      });
      res.on('error', err => failDownload(err, 'response'));
      // [审P1-1] 写入流出错(磁盘满/目录不可写)兜底——缺这条会崩主进程
      writeStream.on('error', err => failDownload(err, 'write'));
      // 完成信号挂 writeStream 'finish'(文件真正落盘后)而非 res 'end'(读完即触发、可能尚未写完)：
      //   更准确，且与 failDownload 的 settled 天然互斥，避免"写失败却报完成"留坏文件。
      writeStream.on('finish', () => {
        if (task.settled || task.canceled) return;
        task.settled = true;
        activeTasks.delete(episodeId);
        // [orphan-download] .part 写完 → 原子 rename 成正式名 finalPath。rename 失败则按失败收尾
        //   (删 .part)、不留半成品冒充完成。
        try {
          if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
          fs.renameSync(filePath, finalPath);
        } catch (e) {
          console.error(
            '[download] rename .part failed',
            episodeId,
            (e && e.message) || e
          );
          try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          } catch (e2) {
            // ignore
          }
          const wf = getWindow && getWindow();
          if (wf && !wf.isDestroyed()) {
            wf.webContents.send('podcast:download:error', {
              episodeId,
              error: 'rename failed',
            });
          }
          return;
        }
        console.log('[download] done', episodeId, done, 'bytes');
        const w = getWindow && getWindow();
        if (w && !w.isDestroyed()) {
          w.webContents.send('podcast:download:done', {
            episodeId,
            filePath: finalPath,
            bytesTotal: done,
          });
        }
        // [T3] 下载完成桌面通知
        try {
          var notif = new Notification({
            title: task.title || '下载完成',
            body: '单集已保存到本地',
          });
          // [通知点击跳转] 点击 → 激活主窗口(同 notifications.js)
          notif.on('click', function () {
            var nw = getWindow && getWindow();
            if (nw && !nw.isDestroyed()) {
              if (nw.isMinimized()) nw.restore();
              nw.show();
              nw.focus();
            }
          });
          notif.show();
        } catch (e) {
          // Notification 不可用时静默忽略
        }
      });
      res.pipe(writeStream);
      // [orphan-download] 返回正式名 finalPath(非在途 .part)：渲染端当前不消费此返回值，
      //   但避免日后误用它指向已被 rename 走的临时文件。
      return { ok: true, filePath: finalPath };
    } catch (err) {
      activeTasks.delete(episodeId);
      console.error('[download] FAILED', err && (err.stack || err.message));
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 取消下载
  ipcMain.handle('podcast:download:cancel', async (_e, { episodeId } = {}) => {
    const task = activeTasks.get(episodeId);
    if (!task) return { ok: false, error: '没有正在进行的下载' };
    task.canceled = true;
    task.settled = true; // [审P1-1] 取消即定锚：destroy 触发的 error/finish 全部短路、不误报
    try {
      task.res.destroy();
    } catch (e) {
      // ignore
    }
    try {
      task.writeStream.destroy();
    } catch (e) {
      // ignore
    }
    try {
      if (task.filePath && fs.existsSync(task.filePath)) {
        fs.unlinkSync(task.filePath);
      }
    } catch (e) {
      // ignore
    }
    activeTasks.delete(episodeId);
    return { ok: true };
  });

  // 删除已下载文件
  ipcMain.handle('podcast:download:remove', async (_e, { filePath } = {}) => {
    if (!filePath) return { ok: false, error: '缺少 filePath' };
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 检查文件是否还在（启动时校验，文件可能被外部删除）
  ipcMain.handle('podcast:download:exists', async (_e, { filePath } = {}) => {
    if (!filePath) return { ok: false, exists: false };
    return { ok: true, exists: fs.existsSync(filePath) };
  });

  // [事故恢复] 返回当前实例 userData 目录：供渲染端做"按当前身份"的下载路径迁移，
  //   避免硬编码身份名把非 dev 实例(测试床/正式版)的下载路径错改。
  ipcMain.handle('podcast:userDataDir', () => app.getPath('userData'));

  // [事故恢复] 下载重挂：清库后下载记录丢失但音频文件还在磁盘(孤儿)。
  //   按与下载端完全相同的命名规则 podcastHashOf(feedUrl)/safeFileName(guid) 反查磁盘文件，
  //   返回匹配到的 { id, podcastId, filePath, bytesTotal }，由渲染端写回 episodeDownloads。
  //   episode.id 格式 = `${feedUrl}::${guid}`，feedUrl/guid 由 id 解析(零偏差)。
  ipcMain.handle('podcast:download:relink', async (_e, episodes = []) => {
    const base = getPodcastsDir();
    const matched = [];
    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      if (!ep || !ep.id) continue;
      const idx = ep.id.indexOf('::');
      if (idx <= 0) continue;
      const feedUrl = ep.id.slice(0, idx);
      const guid = ep.id.slice(idx + 2);
      const dir = path.join(base, podcastHashOf(feedUrl));
      if (!fs.existsSync(dir)) continue;
      const prefix = safeFileName(guid);
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch (e) {
        continue;
      }
      // [orphan-download] 排除 .part 半成品(启动期 sweep 通常已删，此为双保险)，只认正式名。
      const hit = files.find(
        n => n.indexOf(prefix) === 0 && n.slice(-5) !== '.part'
      );
      if (!hit) continue;
      const fp = path.join(dir, hit);
      let size = 0;
      try {
        size = fs.statSync(fp).size;
      } catch (e) {
        size = 0;
      }
      // [orphan-download] 空/不可读文件不回写"已完成"(防截断文件复活成 done)。
      if (size <= 0) continue;
      matched.push({
        id: ep.id,
        podcastId: ep.podcastId,
        filePath: fp,
        bytesTotal: size,
      });
    }
    return { ok: true, matched };
  });

  // [事故恢复·加固] 本地数据备份：把渲染端导出的全表 JSON + 订阅 OPML 落盘到
  //   userData\backups\，保留最近 3 份（超出自动覆盖最旧）。
  ipcMain.handle('podcast:backup:write', async (_e, { json, opml } = {}) => {
    try {
      const dir = path.join(app.getPath('userData'), 'backups');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      if (json)
        fs.writeFileSync(path.join(dir, `podplayer-${stamp}.json`), json);
      if (opml)
        fs.writeFileSync(path.join(dir, `podplayer-${stamp}.opml`), opml);
      ['.json', '.opml'].forEach(ext => {
        let list;
        try {
          list = fs
            .readdirSync(dir)
            .filter(n => n.endsWith(ext))
            .sort();
        } catch (e) {
          list = [];
        }
        while (list.length > 3) {
          const old = list.shift();
          try {
            fs.unlinkSync(path.join(dir, old));
          } catch (e) {
            // ignore
          }
        }
      });
      return { ok: true, dir };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // [事故恢复] 读取最新一份备份 JSON(供"从备份恢复"用)。返回最新 *.json 的文件名与内容。
  ipcMain.handle('podcast:backup:readLatest', async () => {
    try {
      const dir = path.join(app.getPath('userData'), 'backups');
      if (!fs.existsSync(dir)) return { ok: false, error: 'no-backup-dir' };
      const list = fs
        .readdirSync(dir)
        .filter(n => n.endsWith('.json'))
        .sort();
      if (!list.length) return { ok: false, error: 'no-backup' };
      const name = list[list.length - 1];
      const json = fs.readFileSync(path.join(dir, name), 'utf8');
      return { ok: true, name, json };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}
