// [播客改造] 播客业务服务：把"主进程抓 RSS → 渲染端解析 → 入库"串起来。
// 这一层让界面层不用关心抓取/解析细节。
import { parseRss, parseOpml, cleanUrl } from './rssParser';
import {
  upsertPodcast,
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
export async function subscribeByRssUrl(feedUrl) {
  // [播客改造] cleanUrl 去尾巴杂字符（如复制时多带的 "！@ 等），
  // 让用户粘贴时不必"洁癖"地修整。
  const url = cleanUrl(feedUrl);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('请填写以 http(s):// 开头的 RSS 链接');
  }
  const xml = await ipcFetch('podcast:fetchRss', url);
  const { podcast, episodes } = parseRss(xml, url);
  await upsertPodcast(podcast);
  await upsertEpisodes(episodes);
  return { podcast, episodes };
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
  await upsertPodcast(podcast);
  await upsertEpisodes(episodes);
  return { podcast, episodes };
}

export { getAllPodcasts, getPodcast, getEpisodesByPodcast, deletePodcast };
