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
// 进度 / 完成 / 失败通过 webContents.send 推回 renderer。
import { app, ipcMain, Notification } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { URL } from 'url';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 YesPlayMusicPodcast/0.1';

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
function streamGet(url, redirects = 0) {
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
    const req = lib.get(
      url,
      {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        // 显式不走代理：proxy/agent 留空，Node 默认直连
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
          streamGet(next, redirects + 1).then(resolve, reject);
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

export function registerPodcastDownloadIpc(getWindow) {
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

      const { res, finalUrl } = await streamGet(audioUrl);
      console.log(
        '[download] response 200',
        res.headers['content-type'],
        res.headers['content-length']
      );

      const ext = guessExt(finalUrl || audioUrl, res.headers['content-type']);
      const filePath = path.join(dir, safeFileName(guid) + ext);
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
        console.log('[download] done', episodeId, done, 'bytes');
        const w = getWindow && getWindow();
        if (w && !w.isDestroyed()) {
          w.webContents.send('podcast:download:done', {
            episodeId,
            filePath,
            bytesTotal: done,
          });
        }
        // [T3] 下载完成桌面通知
        try {
          var notif = new Notification({
            title: task.title || '下载完成',
            body: '单集已保存到本地',
          });
          notif.show();
        } catch (e) {}
      });
      res.pipe(writeStream);
      return { ok: true, filePath };
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
      const hit = files.find(n => n.indexOf(prefix) === 0);
      if (!hit) continue;
      const fp = path.join(dir, hit);
      let size = 0;
      try {
        size = fs.statSync(fp).size;
      } catch (e) {
        size = 0;
      }
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
  //   userData\backups\，保留最近 10 份。app 的 Dexie 数据此前无任何备份机制，
  //   是本次清库不可恢复的根本缺口。
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
        while (list.length > 10) {
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
