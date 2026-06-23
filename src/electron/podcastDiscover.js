// [B-39 播客改造] 主进程：首页"发现"数据。
// - 热门榜单：xyzrank.com/api/podcasts（必须带 Referer，否则反爬返回 SPA HTML）
// - Apple id → RSS feedUrl：itunes.apple.com/lookup
// 在主进程抓取以绕过渲染进程的 CORS；proxy:false 直连（交给 Clash TUN 网卡层路由）。
import axios from 'axios';
import { ipcMain } from 'electron';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 YesPlayMusicPodcast/0.1';

// 简单内存缓存：榜单每天才更新，缓存 6h 减少请求 + 离线兜底
let hotCache = { ts: 0, items: null };
let newCache = { ts: 0, items: null }; // [B-53] 新上线节目
const HOT_TTL = 6 * 3600 * 1000;
// Apple id → feedUrl 缓存（基本不变，长期缓存）
const feedCache = new Map();

export function registerPodcastDiscoverIpc() {
  // 抓热门播客榜单
  ipcMain.handle('podcast:fetchHot', async (_e, force) => {
    const now = hotCache.ts; // 注意：Date.now() 在运行时可用
    if (!force && hotCache.items && Date.now() - now < HOT_TTL) {
      return { ok: true, items: hotCache.items, cached: true };
    }
    try {
      const res = await axios.get('https://xyzrank.com/api/podcasts', {
        headers: {
          'User-Agent': UA,
          Referer: 'https://xyzrank.com/',
          Accept: 'application/json',
        },
        timeout: 20000,
        proxy: false,
        validateStatus: s => s >= 200 && s < 300,
      });
      const items = (res.data && res.data.items) || [];
      if (items.length) {
        hotCache = { ts: Date.now(), items };
      }
      return { ok: true, items };
    } catch (err) {
      // 失败时如果有旧缓存，降级返回旧的
      if (hotCache.items) {
        return { ok: true, items: hotCache.items, stale: true };
      }
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // [B-53] 抓"新上线"节目榜单（xyzrank /api/new-podcasts，结构同热门榜，带 links）
  ipcMain.handle('podcast:fetchNew', async (_e, force) => {
    if (!force && newCache.items && Date.now() - newCache.ts < HOT_TTL) {
      return { ok: true, items: newCache.items, cached: true };
    }
    try {
      const res = await axios.get('https://xyzrank.com/api/new-podcasts', {
        headers: {
          'User-Agent': UA,
          Referer: 'https://xyzrank.com/',
          Accept: 'application/json',
        },
        timeout: 20000,
        proxy: false,
        validateStatus: s => s >= 200 && s < 300,
      });
      const items = (res.data && res.data.items) || [];
      if (items.length) {
        newCache = { ts: Date.now(), items };
      }
      return { ok: true, items };
    } catch (err) {
      if (newCache.items) {
        return { ok: true, items: newCache.items, stale: true };
      }
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 从 Apple Podcasts id 反查 RSS feedUrl
  ipcMain.handle('podcast:resolveFeed', async (_e, appleId) => {
    if (!appleId) return { ok: false, error: '缺少 appleId' };
    if (feedCache.has(appleId)) {
      return { ok: true, feedUrl: feedCache.get(appleId) };
    }
    try {
      const res = await axios.get(
        `https://itunes.apple.com/lookup?id=${encodeURIComponent(
          appleId
        )}&entity=podcast`,
        {
          headers: { 'User-Agent': UA },
          timeout: 15000,
          proxy: false,
        }
      );
      const r = ((res.data && res.data.results) || [])[0];
      const feedUrl = r && r.feedUrl;
      if (feedUrl) feedCache.set(appleId, feedUrl);
      return { ok: true, feedUrl: feedUrl || '' };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // [B-52] 在线搜索播客（iTunes Search API，中文区，直接返回 feedUrl → 可一键订阅/预览）
  ipcMain.handle('podcast:search', async (_e, term) => {
    const q = String(term || '').trim();
    if (!q) return { ok: true, items: [] };
    try {
      const res = await axios.get('https://itunes.apple.com/search', {
        params: { term: q, entity: 'podcast', country: 'cn', limit: 30 },
        headers: { 'User-Agent': UA },
        timeout: 15000,
        proxy: false,
        validateStatus: s => s >= 200 && s < 300,
      });
      const results = (res.data && res.data.results) || [];
      // 映射成发现页卡片(DiscoverCard)能直接用的结构；带 feedUrl 可跳过 resolveFeed
      const items = results
        .filter(r => r && r.feedUrl)
        .map(r => ({
          id: r.feedUrl,
          name: r.collectionName || r.trackName || '',
          author: r.artistName || '',
          logoURL: r.artworkUrl600 || r.artworkUrl100 || r.artworkUrl60 || '',
          primaryGenreName: r.primaryGenreName || '',
          avgPlayCount: 0,
          feedUrl: r.feedUrl,
          trackCount: r.trackCount || 0,
        }));
      return { ok: true, items };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // [资源池·解析链第三级] PodcastIndex 按词搜索（开放播客索引，400 万+ feed）。
  //   覆盖 Apple/iTunes 都搜不到、但有公开 RSS 的节目——解析链最后一条公开通道。
  //   鉴权(文档一致)：X-Auth-Key=key，X-Auth-Date=unix 秒，Authorization=sha1(key+secret+秒)。
  //   key/secret 由渲染端从用户设置(localStorage)传入、仅用于本次请求，绝不落 git/不打印明文。
  //   Node 内置 crypto，零新依赖；electron 主进程(Node14)禁可选链，用 && + ||。
  ipcMain.handle('podcast:searchIndex', async (_e, payload) => {
    const term = payload && payload.term ? String(payload.term).trim() : '';
    const key = (payload && payload.key) || '';
    const secret = (payload && payload.secret) || '';
    if (!term) return { ok: true, items: [] };
    if (!key || !secret) {
      return { ok: false, error: '未配置 PodcastIndex Key/Secret' };
    }
    try {
      const crypto = require('crypto');
      const apiTime = Math.floor(Date.now() / 1000); // 运行时 Date.now() 可用
      const authHash = crypto
        .createHash('sha1')
        .update(key + secret + apiTime)
        .digest('hex');
      const res = await axios.get(
        'https://api.podcastindex.org/api/1.0/search/byterm',
        {
          params: { q: term, max: 10 },
          headers: {
            'User-Agent': UA,
            'X-Auth-Key': key,
            'X-Auth-Date': String(apiTime),
            Authorization: authHash,
          },
          timeout: 15000,
          proxy: false,
          validateStatus: s => s >= 200 && s < 300,
        }
      );
      const feeds = (res.data && res.data.feeds) || [];
      const items = feeds
        .filter(f => f && f.url)
        .map(f => ({
          id: f.url,
          name: f.title || '',
          author: f.author || '',
          logoURL: f.image || f.artwork || '',
          primaryGenreName: '',
          avgPlayCount: 0,
          feedUrl: f.url,
          trackCount: f.episodeCount || 0,
        }));
      return { ok: true, items };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}
