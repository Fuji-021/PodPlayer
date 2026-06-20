// [B-39 播客改造] 首页"发现"服务：取热门榜单 + 分板块 + 一键订阅（Apple id → feedUrl → 复用订阅）。
import { subscribeByRssUrl, previewByRssUrl } from './service';

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer = electron?.ipcRenderer ?? null;

// [E] 寻宝板块起点：榜单前 TREASURE_START 条算"热门"，从此往后才进寻宝池。
//   统一常量，避免 splitSections/reshuffleSection/getSectionFull 各写魔法数导致漂移。
const TREASURE_START = 10;

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

// [B-53] 取"新上线"节目榜单（xyzrank /api/new-podcasts，结构同热门）
export async function fetchNewPodcasts(force = false) {
  if (!ipcRenderer) {
    throw new Error('发现功能仅在桌面版可用');
  }
  const res = await ipcRenderer.invoke('podcast:fetchNew', force);
  if (!res || !res.ok)
    throw new Error((res && res.error) || '获取新上线榜单失败');
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
// [B-52] 取 feedUrl：搜索结果自带 feedUrl 直接用；榜单项用 Apple id → resolveFeed
async function resolveFeedUrl(podcast) {
  if (podcast && podcast.feedUrl) return podcast.feedUrl;
  const appleId = appleIdOf(podcast);
  if (!appleId) throw new Error('该节目暂无 Apple 源');
  if (!ipcRenderer) throw new Error('仅在桌面版可用');
  const res = await ipcRenderer.invoke('podcast:resolveFeed', appleId);
  if (!res || !res.ok || !res.feedUrl) {
    throw new Error((res && res.error) || '未能解析出 RSS 订阅源');
  }
  return res.feedUrl;
}

// [B-52] 在线搜索播客（iTunes Search，主进程；结果含 feedUrl，可直接订阅/预览）
export async function searchPodcasts(term) {
  if (!ipcRenderer) throw new Error('搜索仅在桌面版可用');
  const res = await ipcRenderer.invoke('podcast:search', term);
  if (!res || !res.ok) throw new Error((res && res.error) || '搜索失败');
  return res.items || [];
}

// 一键订阅：feedUrl(搜索) 或 Apple id→feedUrl(榜单) → subscribeByRssUrl（来源 discover）
export async function subscribePodcast(podcast) {
  const feedUrl = await resolveFeedUrl(podcast);
  const result = await subscribeByRssUrl(feedUrl, 'discover');
  return { ...result, feedUrl };
}

// [B-50] 预览：feedUrl(搜索) 或 Apple id→feedUrl(榜单) → previewByRssUrl（入库供试听，不订阅）
export async function previewPodcast(podcast) {
  const feedUrl = await resolveFeedUrl(podcast);
  const result = await previewByRssUrl(feedUrl);
  return { ...result, feedUrl };
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
//   [P2 修] hardExclude=绝不显示(已订阅)；softExclude=尽量避开(其它栏/上一批 reroll)，
//   但软排除后池不足一整行时允许从非订阅全池回填，避免 reroll 后 forYou 只剩两三个。
function buildForYou(items, hardExclude, softExclude, preferredGenres) {
  const nonSub = excludeSubbed(items, hardExclude); // 非订阅全池(硬排除已订阅)
  const soft = softExclude || new Set();
  const fresh = nonSub.filter(p => !soft.has((p.name || '').trim())); // 优先：不在其它栏/上一批
  let result;
  if (!preferredGenres || !preferredGenres.size) {
    result = shuffle(fresh).slice(0, 16);
  } else {
    const matched = [];
    const others = [];
    for (const p of fresh) {
      if (preferredGenres.has((p.primaryGenreName || '').trim()))
        matched.push(p);
      else others.push(p);
    }
    result = shuffle(matched).slice(0, 16);
    if (result.length < 16) {
      result.push(...shuffle(others).slice(0, 16 - result.length));
    }
  }
  // [P2 修「reroll 不换 / 池只剩 3」] 避开软排除后不够一整行(16)时，从非订阅全池回填
  //   (允许与其它栏/上批重叠，但**绝不显示已订阅**) → 既保证真换一批、又不至于只剩两三个。
  if (result.length < 16) {
    const picked = new Set(result.map(p => (p.name || '').trim()));
    const refill = shuffle(nonSub).filter(
      p => !picked.has((p.name || '').trim())
    );
    result.push(...refill.slice(0, 16 - result.length));
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
  const used = new Set(excludeNames || []); // 已订阅+热门：供寻宝池过滤
  const sectionNames = new Set(); // [P2] 其它栏占用名(软排除，**不含已订阅**)：热门+寻宝
  hot.forEach(p => {
    const n = (p.name || '').trim();
    used.add(n);
    sectionNames.add(n);
  });
  const treasurePool = items
    .slice(TREASURE_START)
    .filter(p => !used.has((p.name || '').trim()));
  const treasure = shuffle(treasurePool).slice(0, 16);
  treasure.forEach(p => sectionNames.add((p.name || '').trim()));
  // 推荐：硬排除已订阅(excludeNames)，软排除 热门+寻宝(sectionNames)，按订阅分类加权
  const forYou = buildForYou(
    items,
    excludeNames,
    sectionNames,
    preferredGenres
  );
  return { hot, treasure, forYou };
}

// [B-42] 再随机一批（"再找一找" / "再推荐一次"）。
// [B-43] forYou 走分类加权 buildForYou。
export function reshuffleSection(
  items,
  type,
  hardExclude,
  softExclude,
  preferredGenres
) {
  if (type === 'treasure') {
    // [#6 切片口径对齐] 与 getSectionFull 同口径:先 slice(TREASURE_START) 再排已订阅,
    //   避免"先排已订阅再切片"使边界随订阅数漂移(当前该分支不可达,属预防性对齐)。
    return shuffle(
      excludeSubbed(items.slice(TREASURE_START), hardExclude)
    ).slice(0, 16);
  }
  return buildForYou(items, hardExclude, softExclude, preferredGenres);
}

// [B-42] 二级页全量：hot=全部榜单（榜单序）；treasure=腰部及以后（排除已订阅）
// [修] 操作#4：「换一批」对 new/treasure 之前无 shuffle、点了内容不变 →
//   new/treasure 改为每次 shuffle(复用本文件 shuffle 工具)，返回不同随机顺序的全集；
//   hot=热门排行保持确定性榜单序(按热度，乱序不符合排行榜语义，不 shuffle)。
//   排除已订阅(excludeSubbed)逻辑与切片口径均保持不变。
export function getSectionFull(items, type, excludeNames) {
  if (!items || !items.length) return [];
  if (type === 'treasure')
    return shuffle(excludeSubbed(items.slice(TREASURE_START), excludeNames));
  if (type === 'new') return shuffle(excludeSubbed(items, excludeNames)); // [修] 新上线全部(排除已订阅) + 每次重洗
  return items.slice(); // hot=热门排行：确定性榜单序，不 shuffle
}
