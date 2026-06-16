// [播客改造] 主进程：抓取 RSS / OPML。
// 放在主进程是为了绕过渲染进程（Chromium）的 CORS 限制——播客的 RSS 来自各种第三方域名。
import axios from 'axios';
import { ipcMain } from 'electron';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 YesPlayMusicPodcast/0.1';

// [审P1-6] RSS/OPML 抓取大小上限 25MB：axios 默认 maxContentLength/maxBodyLength = -1(无限)，
//   异常大的响应(畸形/超大全量 feed)会无上限读进主进程再经 IPC 克隆双份 → 内存尖峰。
//   超限 axios 直接抛错 → 被下方 IPC handler 的 try/catch 接住、优雅返回 {ok:false}。
const MAX_FEED_BYTES = 25 * 1024 * 1024;

async function fetchText(url) {
  const res = await axios.get(url, {
    timeout: 20000,
    responseType: 'text',
    // 大多数播客平台拒绝裸 Node 默认 UA，伪装成浏览器更稳。
    headers: { 'User-Agent': UA, Accept: '*/*' },
    // 把 4xx/5xx 当成错误抛出。
    validateStatus: function (s) {
      return s >= 200 && s < 300;
    },
    maxRedirects: 5,
    maxContentLength: MAX_FEED_BYTES,
    maxBodyLength: MAX_FEED_BYTES,
  });
  return typeof res.data === 'string' ? res.data : String(res.data);
}

// [T7③·ETag/304] 条件请求版抓取：
//   若提供 etag/lastModified，发 If-None-Match/If-Modified-Since；服务端无变化时返回 304；
//   axios validateStatus 放行 304，避免被当 error 抛出。
//   返回 { notModified: true } 或 { text, etag, lastModified }。
async function fetchRssWithCond(url, etag, lastMod) {
  var reqHeaders = { 'User-Agent': UA, Accept: '*/*' };
  if (etag) {
    reqHeaders['If-None-Match'] = etag;
  } else if (lastMod) {
    reqHeaders['If-Modified-Since'] = lastMod;
  }
  var res = await axios.get(url, {
    timeout: 20000,
    responseType: 'text',
    headers: reqHeaders,
    // 304 也视为正常（无需重解析）
    validateStatus: function (s) {
      return s === 304 || (s >= 200 && s < 300);
    },
    maxRedirects: 5,
    maxContentLength: MAX_FEED_BYTES,
    maxBodyLength: MAX_FEED_BYTES,
  });
  if (res.status === 304) return { notModified: true };
  var text = typeof res.data === 'string' ? res.data : String(res.data);
  var respEtag =
    (res.headers && (res.headers['etag'] || res.headers['ETag'])) || null;
  var respLastMod = (res.headers && res.headers['last-modified']) || null;
  return { text: text, etag: respEtag, lastModified: respLastMod };
}

export function registerPodcastIpc() {
  // 抓 RSS 原文（XML 字符串）。
  // payload 可为 URL 字符串（向后兼容）或 {url, etag, lastModified} 对象（条件请求）。
  // 返回 {ok:true, text, etag?, lastModified?} 或 {ok:true, notModified:true} 或 {ok:false, error}。
  ipcMain.handle('podcast:fetchRss', async (_event, payload) => {
    try {
      var isStr = typeof payload === 'string';
      var url = isStr ? payload : payload && payload.url;
      var etag = (!isStr && payload && payload.etag) || null;
      var lastMod = (!isStr && payload && payload.lastModified) || null;
      if (etag || lastMod) {
        var condResult = await fetchRssWithCond(url, etag, lastMod);
        if (condResult.notModified) return { ok: true, notModified: true };
        return {
          ok: true,
          text: condResult.text,
          etag: condResult.etag,
          lastModified: condResult.lastModified,
        };
      }
      // 普通抓取（新订阅 / 首次 / 无缓存头）
      var text = await fetchText(url);
      return { ok: true, text: text };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 抓 OPML 原文（XML 字符串），逻辑同上，单独留个 channel 便于以后区分日志。
  ipcMain.handle('podcast:fetchOpml', async (_event, url) => {
    try {
      const text = await fetchText(url);
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // [B-83] 抓单集网页 HTML（小宇宙等把 RSS shownotes 截断、完整文稿只在单集页的
  //   __NEXT_DATA__ 里）。渲染端拿到 HTML 后自己解析，主进程只负责绕过 CORS 抓原文。
  ipcMain.handle('podcast:fetchEpisodePage', async (_event, url) => {
    try {
      const text = await fetchText(url);
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}
