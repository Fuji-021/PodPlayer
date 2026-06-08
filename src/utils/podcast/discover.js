// [B-39 播客改造] 首页"发现"服务：取热门榜单 + 分板块 + 一键订阅（Apple id → feedUrl → 复用订阅）。
import { subscribeByRssUrl } from './service';

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer = electron?.ipcRenderer ?? null;

// 取热门播客榜单（250 条，主进程已缓存 6h）
export async function fetchHotPodcasts(force = false) {
  if (!ipcRenderer) {
    throw new Error('发现功能仅在桌面版可用');
  }
  const res = await ipcRenderer.invoke('podcast:fetchHot', force);
  if (!res || !res.ok)
    throw new Error((res && res.error) || '获取热门榜单失败');
  return res.items || [];
}

// 从 podcast.links 里找 Apple 链接并提取 id（形如 .../id1582119137）
export function appleIdOf(podcast) {
  const apple = (podcast.links || []).find(l => l && l.name === 'apple');
  if (!apple) return '';
  const m = String(apple.url || '').match(/id(\d+)/);
  return m ? m[1] : '';
}

// 一键订阅：Apple id → feedUrl → subscribeByRssUrl（复用现有订阅入库逻辑）
export async function subscribePodcast(podcast) {
  const appleId = appleIdOf(podcast);
  if (!appleId) {
    throw new Error('该节目暂无 Apple 源，无法自动订阅');
  }
  if (!ipcRenderer) throw new Error('订阅仅在桌面版可用');
  const res = await ipcRenderer.invoke('podcast:resolveFeed', appleId);
  if (!res || !res.ok || !res.feedUrl) {
    throw new Error((res && res.error) || '未能解析出 RSS 订阅源');
  }
  const result = await subscribeByRssUrl(res.feedUrl);
  // 返回 feedUrl 便于订阅后跳转节目详情页
  return { ...result, feedUrl: res.feedUrl };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// [B-42] Apple CDN 封面换高清：.../100x100bb.jpg → .../600x600bb.jpg（榜单只给 100px 预览图）
export function hiResLogo(url, size = 600) {
  if (!url) return '';
  return url.replace(/\/\d+x\d+bb\.(jpg|png|webp)/i, `/${size}x${size}bb.$1`);
}

// 排除已订阅（首页是 Apple 体系、订阅库是 feedUrl，无统一 id → 按节目名粗匹配）
function excludeSubbed(items, excludeNames) {
  if (!excludeNames || !excludeNames.size) return items;
  return items.filter(p => !excludeNames.has((p.name || '').trim()));
}

// [B-43] 从「已订阅节目名」反推用户偏好分类。
//   RSS 不存分类，但榜单 item 自带 primaryGenreName；用订阅节目名在榜单里反查其分类。
//   返回分类名 Set（无订阅 / 订阅都不在榜单 → 空集 → 推荐回退随机）。
export function preferredGenresFrom(items, subscribedNames) {
  const set = new Set();
  if (!items || !subscribedNames || !subscribedNames.size) return set;
  for (const p of items) {
    if (subscribedNames.has((p.name || '').trim())) {
      const g = (p.primaryGenreName || '').trim();
      if (g) set.add(g);
    }
  }
  return set;
}

// [B-43] "为你推荐"：偏好分类优先 + 随机填充。
//   有偏好分类 → 同分类节目随机排前，不足 12 个再用其它随机补足（保证板块不空）。
//   无偏好分类 → 纯随机（与旧行为一致）。每次调用都重洗 → "再推荐一次"有变化。
function buildForYou(items, excludeNames, preferredGenres) {
  const fresh = excludeSubbed(items, excludeNames);
  if (!preferredGenres || !preferredGenres.size) {
    return shuffle(fresh).slice(0, 16);
  }
  const matched = [];
  const others = [];
  for (const p of fresh) {
    if (preferredGenres.has((p.primaryGenreName || '').trim())) matched.push(p);
    else others.push(p);
  }
  const result = shuffle(matched).slice(0, 16);
  if (result.length < 16) {
    result.push(...shuffle(others).slice(0, 16 - result.length));
  }
  return result;
}

// 分三大板块：热门排行（榜单序，含已订阅——热门就是热门）/ 寻宝（随机）/ 推荐（按订阅分类加权，避开已订阅）
export function splitSections(items, excludeNames, preferredGenres) {
  if (!items || !items.length) {
    return { hot: [], treasure: [], forYou: [] };
  }
  // [B-44] 取够 2 行所需量（宽屏列数多）：热门 20 / 寻宝 16 / 推荐 16
  // [B-47 第1点] 除热门外三栏互不重复：热门固定(榜单序)，寻宝排除热门+已订阅，推荐再排除寻宝
  const hot = items.slice(0, 20);
  const used = new Set(excludeNames || []);
  hot.forEach(p => used.add((p.name || '').trim()));
  const treasurePool = items
    .slice(10)
    .filter(p => !used.has((p.name || '').trim()));
  const treasure = shuffle(treasurePool).slice(0, 16);
  treasure.forEach(p => used.add((p.name || '').trim()));
  // 推荐排除 热门+寻宝+已订阅，按订阅分类加权
  const forYou = buildForYou(items, used, preferredGenres);
  return { hot, treasure, forYou };
}

// [B-42] 再随机一批（"再找一找" / "再推荐一次"）。
// [B-43] forYou 走分类加权 buildForYou。
export function reshuffleSection(items, type, excludeNames, preferredGenres) {
  if (type === 'treasure') {
    return shuffle(excludeSubbed(items, excludeNames).slice(10)).slice(0, 16);
  }
  return buildForYou(items, excludeNames, preferredGenres);
}

// [B-42] 二级页全量：hot=全部榜单（榜单序）；treasure=腰部及以后（排除已订阅）
export function getSectionFull(items, type, excludeNames) {
  if (!items || !items.length) return [];
  if (type === 'treasure') return excludeSubbed(items.slice(8), excludeNames);
  return items.slice();
}
