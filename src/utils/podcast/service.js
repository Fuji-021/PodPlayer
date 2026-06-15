// [播客改造] 播客业务服务：把"主进程抓 RSS → 渲染端解析 → 入库"串起来。
// 这一层让界面层不用关心抓取/解析细节。
import { parseRss, parseOpml, cleanUrl } from './rssParser';
import {
  upsertPodcast,
  updatePodcast,
  upsertEpisodes,
  getAllPodcasts,
  getSubscribedPodcasts,
  getPodcast,
  getEpisodesByPodcast,
  deletePodcast,
} from './db';

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer = electron?.ipcRenderer ?? null;

async function ipcFetch(channel, url) {
  if (!ipcRenderer) {
    throw new Error('当前不在 Electron 环境，无法抓取第三方 RSS（CORS 限制）');
  }
  const res = await ipcRenderer.invoke(channel, url);
  if (!res?.ok) throw new Error(res?.error || '抓取失败');
  return res.text;
}

/**
 * 添加/刷新一档播客订阅。
 * @param {string} feedUrl  RSS 链接
 * @returns {Promise<{ podcast: object, episodes: object[] }>}
 */
export async function subscribeByRssUrl(feedUrl, source = 'manual') {
  // [播客改造] cleanUrl 去尾巴杂字符（如复制时多带的 "！@ 等），
  // 让用户粘贴时不必"洁癖"地修整。
  const url = cleanUrl(feedUrl);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('请填写以 http(s):// 开头的 RSS 链接');
  }
  const xml = await ipcFetch('podcast:fetchRss', url);
  const { podcast, episodes } = parseRss(xml, url);
  // [B-48 第1点] 记录来源：'manual'(粘贴RSS/OPML/文件) / 'discover'(首页发现页)
  // [B-50] 显式订阅 → subscribed:true
  // [审操作#11] 重复订阅已存在档：upsertPodcast=put 会整条覆盖 → 原 newCount(角标)被清、source 被改
  //   (原 discover 被 manual 覆盖、发现页溯源黄点消失)、其它已存在字段丢失。改为「合并」：先铺 existing
  //   保留其全部字段，再用本次 parseRss 的新元数据覆盖(标题/简介/封面等刷新)，最后 source 保留原值、置 subscribed。
  const existing = await getPodcast(url);
  const merged = existing
    ? {
        ...existing,
        ...podcast,
        source: existing.source || source,
        subscribed: true,
      }
    : { ...podcast, source, subscribed: true };
  await upsertPodcast(merged);
  await upsertEpisodes(episodes);
  return { podcast: merged, episodes };
}

/**
 * [B-50] 预览一档播客（发现页点卡片进详情用）：抓 RSS 入库供详情页/试听，但**不订阅**。
 * - 节目不存在 → subscribed:false 入库（不进"我的订阅"，不算已订阅状态）。
 * - 节目已存在 → 保留其原 subscribed（绝不把已订阅的降级）。
 * @param {string} feedUrl
 * @returns {Promise<{ podcast: object, episodes: object[] }>}
 */
export async function previewByRssUrl(feedUrl) {
  const url = cleanUrl(feedUrl);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('无效的 RSS 链接');
  }
  const xml = await ipcFetch('podcast:fetchRss', url);
  const { podcast, episodes } = parseRss(xml, url);
  // [B-50 / TOCTOU 修] 抓取耗时期间用户可能刚订阅了本节目；ipcFetch 之后再取最新 existing，
  //   且**绝不**用预览流程写 subscribed（订阅态只由显式订阅/取消维护）：
  //   - 已存在 → updatePodcast 只更新元数据字段，保留原 subscribed/source；
  //   - 不存在 → upsertPodcast 带 subscribed:false 创建（不进"我的订阅"、不算已订阅）。
  const existing = await getPodcast(url);
  // podcast 来自 parseRss，本身不含 subscribed/source，不会污染订阅态。
  if (existing) {
    await updatePodcast(url, { ...podcast });
  } else {
    await upsertPodcast({ ...podcast, source: 'discover', subscribed: false });
  }
  await upsertEpisodes(episodes);
  const subscribed = existing ? existing.subscribed !== false : false;
  const source = existing && existing.source ? existing.source : 'discover';
  return { podcast: { ...podcast, source, subscribed }, episodes };
}

/**
 * 从 OPML 文件文本批量导入订阅。
 * @param {string} opmlText
 * @param {(done: number, total: number, currentTitle?: string) => void} [onProgress]
 *        进度回调（用于 UI 显示进度条）
 * @returns {Promise<{ added: string[], failed: { url: string, error: string }[] }>}
 */
export async function importOpmlText(opmlText, onProgress) {
  // [审操作#10] 按 feedUrl 去重：重复 feed 会被订阅多次(库幂等不重复)但 added 计多次 → "成功 N 档"虚高。
  //   去重键必须用 cleanUrl 归一化(与 subscribeByRssUrl 同口径)——否则 "url/" 与 "url" 算两个、却入库同一条。
  const seen = new Set();
  const entries = parseOpml(opmlText).filter(e => {
    const u = cleanUrl((e && e.xmlUrl) || '');
    if (!u || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
  const added = [];
  const failed = [];
  // [#12 修] 订阅成功的 {title, feedUrl}，供调用方 commit 到 subscribedMap(发现页绿勾即时回显)
  const subscribed = [];
  const total = entries.length;
  let done = 0;
  // [审P2-9] 原为纯串行 for-await：单档 20s 超时会拖死整队(2000 档约 11h 不可用)。
  //   改并发 runLimited(≤5，与 refreshAllSubscriptions 同口径，RSS 站点对突发并发敏感故限流)。
  //   进度用完成计数(并发下按完成顺序回报)。source 保持默认 'manual'——按本文件设计(见 subscribeByRssUrl
  //   注释)manual 即涵盖"粘贴RSS/OPML/文件"，不引入新值以免破坏按 source 的过滤。
  await runLimited(entries, 5, async e => {
    try {
      const { podcast } = await subscribeByRssUrl(e.xmlUrl);
      added.push(podcast.title || podcast.feedUrl);
      subscribed.push({ title: podcast.title, feedUrl: podcast.feedUrl });
    } catch (err) {
      failed.push({
        url: e.xmlUrl,
        error: String((err && err.message) || err),
      });
    } finally {
      done += 1;
      if (typeof onProgress === 'function') {
        onProgress(done, total, e.title || e.xmlUrl);
      }
    }
  });
  if (typeof onProgress === 'function') {
    onProgress(total, total, '');
  }
  return { added, failed, subscribed };
}

/**
 * 从本地 RSS 文件文本导入**单档**订阅。
 *
 * - 自动从 `<atom:link rel="self" href="...">` 提取 feedUrl
 * - 若 RSS 没声明 self link，回退用 fallbackId（建议传文件名）
 *
 * @param {string} rssText
 * @param {string} [fallbackId] 当 RSS 未声明 self link 时使用的 feedUrl/id
 * @returns {Promise<{ podcast: object, episodes: object[] }>}
 */
export async function importRssText(rssText, fallbackId = '') {
  let feedUrl = '';
  const m = rssText.match(/<atom:link[^>]*\brel\s*=\s*["']self["'][^>]*>/i);
  if (m) {
    const hm = m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (hm) feedUrl = hm[1];
  }
  if (!feedUrl) feedUrl = fallbackId;
  if (!feedUrl) {
    throw new Error('RSS 文件未声明自身 URL，且未提供回退 id');
  }
  const { podcast, episodes } = parseRss(rssText, feedUrl);
  // [B-48 第1点] 本地文件导入 = 手动来源
  await upsertPodcast({ ...podcast, source: 'manual' });
  await upsertEpisodes(episodes);
  return { podcast, episodes };
}

// [B-46 / D-3] 限并发跑任务（默认 5）。RSS 站点对突发并发敏感，限流更稳。
async function runLimited(items, limit, worker) {
  const queue = items.slice();
  const runners = [];
  for (let i = 0; i < Math.min(limit, queue.length); i++) {
    runners.push(
      (async () => {
        // 每个 runner 不断从队列取任务，直到取空
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const item = queue.shift();
          if (item === undefined) break;
          await worker(item);
        }
      })()
    );
  }
  await Promise.all(runners);
}

/**
 * [B-46 / D-3] 订阅自动更新：并发(≤5)重抓所有已订阅 feedUrl，diff 出新单集 upsert 入库，
 * 并把每档新增数累加到 podcasts.newCount（卡片角标）。
 * - 旧单集进度不受影响（进度在 episodeProgress 独立表，bulkPut 只覆盖元数据）。
 * - 单档失败不阻塞其它（network/解析错误捕获后记入 results）。
 * @param {(done:number,total:number,title?:string)=>void} [onProgress]
 * @returns {Promise<{ totalNew:number, results:{id,title,newCount,error}[] }>}
 */
export async function refreshAllSubscriptions(onProgress) {
  const pods = await getSubscribedPodcasts();
  const total = pods.length;
  let done = 0;
  const results = [];
  await runLimited(pods, 5, async p => {
    let newCount = 0;
    let error = null;
    try {
      const xml = await ipcFetch('podcast:fetchRss', p.id);
      const { podcast: meta, episodes } = parseRss(xml, p.id);
      const existing = await getEpisodesByPodcast(p.id);
      const existingIds = new Set(existing.map(e => e.id));
      const fresh = episodes.filter(e => !existingIds.has(e.id));
      newCount = fresh.length;
      if (episodes.length) await upsertEpisodes(episodes);
      // [封面同步] 节目可能换了封面——原来刷新只更新单集，coverUrl 永远停在订阅时的旧值，
      //   导致首页/我的订阅显示旧封面、详情页显示新封面对不上。这里把 newCount 与 coverUrl 合并写回，
      //   只在确有变化时写；标题/作者不动（它们是按名关联订阅/推荐的 key，贸然改会断匹配）。
      const patch = {};
      if (newCount > 0) patch.newCount = (p.newCount || 0) + newCount;
      if (meta && meta.coverUrl && meta.coverUrl !== p.coverUrl) {
        patch.coverUrl = meta.coverUrl;
      }
      if (Object.keys(patch).length) await updatePodcast(p.id, patch);
    } catch (e) {
      error = String((e && e.message) || e);
    }
    done++;
    if (typeof onProgress === 'function') onProgress(done, total, p.title);
    results.push({ id: p.id, title: p.title, newCount, error });
  });
  const totalNew = results.reduce((s, r) => s + r.newCount, 0);
  return { totalNew, results };
}

/**
 * [B-51] 把"我的订阅"导出为 OPML 文本（备份 / 迁移到其它播客客户端）。
 * 只导出真订阅（subscribed!==false），每档一行 outline，xmlUrl=feedUrl。
 * @returns {Promise<string>} OPML XML 文本
 */
export async function exportSubscriptionsOpml() {
  const pods = await getSubscribedPodcasts();
  const esc = s =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const outlines = pods
    .map(
      p =>
        `    <outline type="rss" text="${esc(p.title)}" title="${esc(
          p.title
        )}" xmlUrl="${esc(p.id)}" />`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>PodPlayer 订阅导出</title>
  </head>
  <body>
${outlines}
  </body>
</opml>
`;
}

export {
  getAllPodcasts,
  getSubscribedPodcasts,
  getPodcast,
  getEpisodesByPodcast,
  deletePodcast,
  updatePodcast,
};
