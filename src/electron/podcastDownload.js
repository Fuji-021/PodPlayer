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
import { app, ipcMain } from 'electron';
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
    const { episodeId, feedUrl, guid, audioUrl } = payload || {};
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
      const task = { res, writeStream, filePath, canceled: false };
      activeTasks.set(episodeId, task);

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
      res.on('end', () => {
        if (task.canceled) return;
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
      });
      res.on('error', err => {
        activeTasks.delete(episodeId);
        try {
          writeStream.destroy();
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
          // ignore
        }
        if (task.canceled) return;
        console.error('[download] stream error', err && err.message);
        const w = getWindow && getWindow();
        if (w && !w.isDestroyed()) {
          w.webContents.send('podcast:download:error', {
            episodeId,
            error: String((err && err.message) || err),
          });
        }
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
}
