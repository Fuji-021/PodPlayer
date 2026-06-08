// [播客改造] 播客业务服务：把"主进程抓 RSS → 渲染端解析 → 入库"串起来。
// 这一层让界面层不用关心抓取/解析细节。
import { parseRss, parseOpml, cleanUrl } from './rssParser';
import {
  upsertPodcast,
  updatePodcast,
  upsertEpisodes,
  getAllPodcasts,
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
  await upsertPodcast({ ...podcast, source });
  await upsertEpisodes(episodes);
  return { podcast: { ...podcast, source }, episodes };
}

/**
 * 从 OPML 文件文本批量导入订阅。
 * @param {string} opmlText
 * @param {(done: number, total: number, currentTitle?: string) => void} [onProgress]
 *        进度回调（用于 UI 显示进度条）
 * @returns {Promise<{ added: string[], failed: { url: string, error: string }[] }>}
 */
export async function importOpmlText(opmlText, onProgress) {
  const entries = parseOpml(opmlText);
  const added = [];
  const failed = [];
  const total = entries.length;
  for (let i = 0; i < total; i++) {
    const e = entries[i];
    if (typeof onProgress === 'function') {
      onProgress(i, total, e.title || e.xmlUrl);
    }
    try {
      const { podcast } = await subscribeByRssUrl(e.xmlUrl);
      added.push(podcast.title || podcast.feedUrl);
    } catch (err) {
      failed.push({ url: e.xmlUrl, error: String(err?.message || err) });
    }
  }
  if (typeof onProgress === 'function') {
    onProgress(total, total, '');
  }
  return { added, failed };
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
  const pods = await getAllPodcasts();
  const total = pods.length;
  let done = 0;
  const results = [];
  await runLimited(pods, 5, async p => {
    let newCount = 0;
    let error = null;
    try {
      const xml = await ipcFetch('podcast:fetchRss', p.id);
      const { episodes } = parseRss(xml, p.id);
      const existing = await getEpisodesByPodcast(p.id);
      const existingIds = new Set(existing.map(e => e.id));
      const fresh = episodes.filter(e => !existingIds.has(e.id));
      newCount = fresh.length;
      if (episodes.length) await upsertEpisodes(episodes);
      if (newCount > 0) {
        await updatePodcast(p.id, {
          newCount: (p.newCount || 0) + newCount,
        });
      }
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

export {
  getAllPodcasts,
  getPodcast,
  getEpisodesByPodcast,
  deletePodcast,
  updatePodcast,
};
