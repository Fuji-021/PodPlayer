// [播客改造] 渲染端：把 RSS / OPML 原文 XML 解析为内部数据结构。
// 用浏览器内置 DOMParser，避免引入新依赖。
//
// 内部数据形状：
//   Podcast  = { id, feedUrl, title, description, coverUrl, author, link }
//   Episode  = { id, podcastId, title, audioUrl, audioType, audioLength,
//                duration, pubDate, description, coverUrl }
//
// id 一律使用 RSS 里的 guid（频道用 feedUrl 作为稳定 id）。

function text(el, name) {
  const node = el?.getElementsByTagName(name)?.[0];
  return node?.textContent?.trim() || '';
}

// [B-82] 取更完整(更长)的一份文本，用于 content:encoded(完整) vs description(可能截断)。
function longerText(a, b) {
  const sa = a || '';
  const sb = b || '';
  return sa.length >= sb.length ? sa : sb;
}

// [审P2-7] 防超大 feed 失控：item 数量安全上限(纯防失控，正常/大档机核都在此之下，不丢真实单集) +
//   单集 description 长度上限 ~100KB(挡内嵌数 MB base64 灌爆 IndexedDB / v-html 巨型 DOM；真实 shownotes 远小于此)。
const MAX_ITEMS = 50000;
const MAX_DESC_LEN = 100000;
function capLen(s) {
  return s && s.length > MAX_DESC_LEN ? s.slice(0, MAX_DESC_LEN) : s;
}

// 取带命名空间的标签，DOMParser 解析 RSS 时这些 itunes:* 标签
// localName 直接是 'image' / 'duration'，我们手动按 localName 匹配。
function textNS(el, localName) {
  const all = el?.getElementsByTagName('*') || [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName && all[i].parentNode === el) {
      return all[i].textContent?.trim() || '';
    }
  }
  return '';
}

function attrNS(el, localName, attr) {
  const all = el?.getElementsByTagName('*') || [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName && all[i].parentNode === el) {
      return all[i].getAttribute(attr) || '';
    }
  }
  return '';
}

// 把 "HH:MM:SS" 或纯秒数解析为秒。
function parseDuration(raw) {
  if (!raw) return 0;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(':').map(p => parseInt(p, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

/**
 * 解析一个频道的 RSS XML 文本。
 * @param {string} xmlText
 * @param {string} feedUrl  抓取这份 RSS 用的网址，作为播客主键
 * @returns {{ podcast: object, episodes: object[] }}
 */
export function parseRss(xmlText, feedUrl) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parseErr = doc.getElementsByTagName('parsererror')[0];
  if (parseErr) {
    throw new Error('RSS 解析失败：XML 格式不合法');
  }
  const channel = doc.getElementsByTagName('channel')[0];
  if (!channel) throw new Error('RSS 解析失败：未找到 <channel>');

  const podcast = {
    id: feedUrl,
    feedUrl,
    title: text(channel, 'title'),
    description: text(channel, 'description'),
    coverUrl: attrNS(channel, 'image', 'href') || text(channel, 'image') || '',
    author: textNS(channel, 'author') || '',
    link: text(channel, 'link'),
    updatedAt: Date.now(),
  };

  const allItems = Array.from(channel.getElementsByTagName('item'));
  // [审P2-7] item 数量安全上限(RSS 通常新集在前，slice 保留最新)；正常档不受影响。
  const items =
    allItems.length > MAX_ITEMS ? allItems.slice(0, MAX_ITEMS) : allItems;
  const episodes = items
    .map(item => {
      const enclosure = item.getElementsByTagName('enclosure')[0];
      if (!enclosure) return null;
      const audioUrl = enclosure.getAttribute('url') || '';
      if (!audioUrl) return null;

      const guidEl = item.getElementsByTagName('guid')[0];
      const guid = guidEl?.textContent?.trim() || audioUrl;

      const epCover = attrNS(item, 'image', 'href') || podcast.coverUrl || '';

      return {
        id: `${feedUrl}::${guid}`,
        podcastId: podcast.id,
        guid,
        title: text(item, 'title'),
        audioUrl,
        audioType: enclosure.getAttribute('type') || '',
        audioLength: parseInt(enclosure.getAttribute('length') || '0', 10),
        duration: parseDuration(textNS(item, 'duration')),
        pubDate: text(item, 'pubDate'),
        pubTime: Date.parse(text(item, 'pubDate')) || 0,
        // [B-82] 完整 shownotes 优先取 <content:encoded>(localName=encoded)，
        //   回退 <description>。小宇宙等源的 <description> 是带"去小宇宙看完整"尾巴的
        //   截断版，完整富文本在 content:encoded；取更长的一份避免简介不完整。
        description: capLen(
          longerText(textNS(item, 'encoded'), text(item, 'description'))
        ),
        coverUrl: epCover,
        link: text(item, 'link'),
      };
    })
    .filter(Boolean);

  return { podcast, episodes };
}

/**
 * 解析 OPML，返回订阅列表。
 * @param {string} xmlText
 * @returns {{ title: string, xmlUrl: string }[]}
 *
 * **容错策略**：标准 DOMParser 严格解析失败时（很多生成器输出的 OPML 有未转义的 `&`、
 * text 属性带换行等问题），降级用正则**直接抓取** `<outline ... xmlUrl="..." ...>` 标签，
 * 抢救其中完整的链接。这样即便 OPML 部分损坏，里面合法的链接依然可用。
 */
export function parseOpml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parseErr = doc.getElementsByTagName('parsererror')[0];
  if (!parseErr) {
    const outlines = Array.from(doc.getElementsByTagName('outline'));
    const list = outlines
      .map(o => ({
        title: o.getAttribute('title') || o.getAttribute('text') || '',
        xmlUrl: o.getAttribute('xmlUrl') || '',
      }))
      .filter(x => x.xmlUrl);
    if (list.length > 0) return list;
  }
  // 严格解析失败或没抓到任何 outline → 用正则抢救
  const lenient = parseOpmlLenient(xmlText);
  if (lenient.length > 0) return lenient;
  throw new Error('OPML 解析失败：未找到任何可用订阅链接');
}

/**
 * 宽容解析：用正则直接匹配 outline 标签里的 xmlUrl / title / text 属性。
 * 适用于 XML 整体不合法但单个标签内属性结构正常的场景。
 */
function parseOpmlLenient(xmlText) {
  const results = [];
  // [审P2-8] 超大输入只扫前 8MB：宽容正则的 [^>]* 在数十 MB 畸形 OPML(大段无 '>')上会回溯 O(n·m)、卡 UI 数秒。
  //   8MB 远超任何真实 OPML(通常 KB~几百 KB)，截断仅影响"畸形且超大"的抢救路径，正常订阅不受影响。
  const MAX_SCAN = 8 * 1024 * 1024;
  const scan = xmlText.length > MAX_SCAN ? xmlText.slice(0, MAX_SCAN) : xmlText;
  // 抓 <outline ... xmlUrl="..." ...> 整个开标签
  const re = /<outline\b[^>]*\bxmlUrl\s*=\s*(["'])([^"']+)\1[^>]*>/gi;
  let m;
  while ((m = re.exec(scan)) !== null) {
    const tag = m[0];
    const url = cleanUrl(m[2]);
    if (!url) continue;
    const titleMatch = tag.match(/\btitle\s*=\s*(["'])([^"']*)\1/i);
    const textMatch = tag.match(/\btext\s*=\s*(["'])([^"']*)\1/i);
    const title =
      (titleMatch && titleMatch[2]) || (textMatch && textMatch[2]) || '';
    results.push({ title, xmlUrl: url });
  }
  return results;
}

/**
 * 清洗 URL：去两端空白；截取 http(s):// 开头的合法 URL 字符；
 * 剔除链接末尾误粘的非法字符（如 `"`、`！`、`@` 等）。
 *
 * 例：`https://feed.xyzfm.space/wmnkvmrpwuww"！@` → `https://feed.xyzfm.space/wmnkvmrpwuww`
 */
export function cleanUrl(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  // URL 合法字符（RFC 3986 unreserved + reserved 子集，常见于真实 URL 中）
  const m = trimmed.match(/https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+/);
  if (!m) return trimmed;
  // 进一步去掉常见尾部"裸"标点（用户复制时拖到了文末符号）
  return m[0].replace(/[.,;:!?。，；：！？、'"''""\])]+$/, '');
}
