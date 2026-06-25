// [B-39 播客改造] 主进程：首页"发现"数据。
// - 热门榜单：xyzrank.com/api/podcasts（必须带 Referer，否则反爬返回 SPA HTML）
// - Apple id → RSS feedUrl：itunes.apple.com/lookup
// 在主进程抓取以绕过渲染进程的 CORS；proxy:false 直连（交给 Clash TUN 网卡层路由）。
import axios from 'axios';
import { ipcMain, app } from 'electron';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 YesPlayMusicPodcast/0.1';

// 简单内存缓存：榜单每天才更新，缓存 6h 减少请求 + 离线兜底
let hotCache = { ts: 0, items: null };
let newCache = { ts: 0, items: null }; // [B-53] 新上线节目
let appleCache = { ts: 0, items: null }; // [资源池] Apple 中国区官方热门榜
const HOT_TTL = 6 * 3600 * 1000;
// Apple id → feedUrl 缓存（基本不变，长期缓存）
const feedCache = new Map();

// [缓存·C1] 发现榜单持久化：把内存里的 hot/new/apple 缓存落 userData\discover-cache.json，
//   app 重启后 loadDiscoverCache() 回灌 → 首页/发现页冷启动直接显示上次榜单（再按 6h TTL 后台刷新），
//   不必每次重启都干等一次网络。主进程 Node14：禁可选链 ?./??，用 && + ||。
//   写盘防抖（多源同刷合并一次），读写失败一律静默（缓存非关键，绝不影响发现功能）。
const fs = require('fs');
const path = require('path');
let _discoverSaveTimer = null;
function discoverCacheFile() {
  try {
    return path.join(app.getPath('userData'), 'discover-cache.json');
  } catch (e) {
    return '';
  }
}
function loadDiscoverCache() {
  try {
    const fp = discoverCacheFile();
    if (!fp || !fs.existsSync(fp)) return;
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (data && data.hot && data.hot.items && data.hot.items.length)
      hotCache = data.hot;
    if (data && data.new && data.new.items && data.new.items.length)
      newCache = data.new;
    if (data && data.apple && data.apple.items && data.apple.items.length)
      appleCache = data.apple;
  } catch (e) {
    // 损坏/读失败 → 忽略，当作无缓存
  }
}
function saveDiscoverCache() {
  if (_discoverSaveTimer) return; // 防抖：500ms 内多次更新合并一次写盘
  _discoverSaveTimer = setTimeout(() => {
    _discoverSaveTimer = null;
    try {
      const fp = discoverCacheFile();
      if (!fp) return;
      fs.writeFileSync(
        fp,
        JSON.stringify({ hot: hotCache, new: newCache, apple: appleCache })
      );
    } catch (e) {
      // 写失败静默（磁盘满/权限），不影响发现功能
    }
  }, 500);
}

export function registerPodcastDiscoverIpc() {
  // [缓存·C1] 启动即回灌上次落盘的发现榜单 → 冷启动首页/发现页直接有数据
  loadDiscoverCache();

  // [缓存·C1] 发现缓存占用/年龄（设置页"清理缓存"展示用）
  ipcMain.handle('podcast:discoverCacheInfo', () => {
    try {
      const fp = discoverCacheFile();
      let bytes = 0;
      if (fp && fs.existsSync(fp)) bytes = fs.statSync(fp).size;
      const newest = Math.max(
        hotCache.ts || 0,
        newCache.ts || 0,
        appleCache.ts || 0
      );
      return { ok: true, bytes, ts: newest };
    } catch (e) {
      return { ok: false, bytes: 0, ts: 0 };
    }
  });

  // [缓存·C1] 清空发现缓存（内存 + 落盘文件）；下次进发现页会重新联网抓
  ipcMain.handle('podcast:clearDiscoverCache', () => {
    try {
      hotCache = { ts: 0, items: null };
      newCache = { ts: 0, items: null };
      appleCache = { ts: 0, items: null };
      const fp = discoverCacheFile();
      if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

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
        saveDiscoverCache();
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
        saveDiscoverCache();
      }
      return { ok: true, items };
    } catch (err) {
      if (newCache.items) {
        return { ok: true, items: newCache.items, stale: true };
      }
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // [资源池] 抓 Apple 中国区官方「热门节目」榜(零鉴权官方端点，每条带 Apple id/中文类目/封面)。
  //   归一化成与 xyzrank 同款字段(name/author/logoURL/primaryGenreName/links)，供发现池合并。
  //   软耦合：失败有旧缓存降级、否则返回 {ok:false}(渲染端 .catch([])→不影响 xyzrank)。
  //   feedUrl 不直接给(榜单无)，靠 links 里的 apple url(含 idNNN)经 resolveFeed lookup 解析。
  ipcMain.handle('podcast:fetchAppleCharts', async (_e, force) => {
    if (!force && appleCache.items && Date.now() - appleCache.ts < HOT_TTL) {
      return { ok: true, items: appleCache.items, cached: true };
    }
    try {
      const res = await axios.get(
        'https://rss.marketingtools.apple.com/api/v2/cn/podcasts/top/100/podcasts.json',
        {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          timeout: 8000, // 可选源：短超时快速失败，不拖累发现页整体加载(Promise.all 等最慢者)
          proxy: false,
          validateStatus: s => s >= 200 && s < 300,
        }
      );
      const results =
        (res.data && res.data.feed && res.data.feed.results) || [];
      const items = results
        .filter(r => r && r.id && r.name)
        .map(r => {
          const id = String(r.id);
          const art = String(r.artworkUrl100 || '');
          // 100x100 → 400x400 更清晰(发现卡 ~180px、retina)；无匹配则原样
          const cover = art.replace(
            /\/\d+x\d+bb\.(png|jpg|jpeg|webp)/i,
            '/400x400bb.$1'
          );
          const genre = (r.genres && r.genres[0] && r.genres[0].name) || '';
          // 始终用合成净 URL(只含 idNNN) → appleIdOf 正则 `id(\d+)` 必中正确 id，
          //   避免 r.url 的名字 slug 里恰含 "id 数字"(如 covid19)被误匹配。
          const url = 'https://podcasts.apple.com/cn/podcast/id' + id;
          return {
            id: 'apple-' + id, // 唯一 key(不与 xyzrank id 撞)
            name: r.name,
            author: r.artistName || '',
            authorsText: r.artistName || '',
            logoURL: cover,
            primaryGenreName: genre || '播客', // 无类目兜底，避免卡片 meta 行空白
            avgPlayCount: 0, // Apple 无播放量(卡片端 0 则不显计数)
            source: 'apple',
            // appleIdOf 从 links 的 apple url 提取 idNNN → resolveFeed lookup 得 feedUrl
            links: [{ name: 'apple', url: url }],
          };
        });
      if (items.length) {
        appleCache = { ts: Date.now(), items };
        saveDiscoverCache();
      }
      return { ok: true, items };
    } catch (err) {
      if (appleCache.items) {
        return { ok: true, items: appleCache.items, stale: true };
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
