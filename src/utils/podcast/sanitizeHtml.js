// [播客改造 C-5] 简易 HTML sanitizer：把 RSS description 里的富文本安全渲染。
// 不引入新依赖，用浏览器内置 DOMParser。
//
// 策略：
//   - 白名单 tag 保留，其它 tag 拆掉但内容保留
//   - 全部 on* 事件属性删除
//   - <a href> 强制 target="_blank" rel="noopener noreferrer"
//   - href / src 强制 http/https 协议（防 javascript: vbscript:）
//   - <script> / <style> / <iframe> / <object> / <embed> 整块删除

const ALLOWED = new Set([
  'A',
  'B',
  'I',
  'EM',
  'STRONG',
  'P',
  'BR',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'PRE',
  'CODE',
  'FIGURE',
  'FIGCAPTION',
  'IMG',
  'HR',
  'DIV',
  'SPAN',
]);

const DROP_WHOLE = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'AUDIO',
  'VIDEO',
  'NOSCRIPT',
]);

function safeUrl(u) {
  if (!u) return '';
  const s = String(u).trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^data:image\//i.test(s)) return s;
  return '';
}

function cleanNode(node) {
  // 元素节点
  if (node.nodeType !== 1) return;

  const tag = node.tagName.toUpperCase();

  // 整块删除
  if (DROP_WHOLE.has(tag)) {
    node.remove();
    return;
  }

  // 删除所有 on* 事件属性、style 也清掉（防 expression 等老 IE 攻击，纯属保险）
  Array.from(node.attributes).forEach(attr => {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on')) {
      node.removeAttribute(attr.name);
    } else if (name === 'style') {
      // 简单保留 color/background-color/text-align 之类无害样式；这里更保守：删掉
      node.removeAttribute('style');
    }
  });

  // a 标签：强制 target/rel，校验 href
  if (tag === 'A') {
    const href = safeUrl(node.getAttribute('href'));
    if (href) {
      node.setAttribute('href', href);
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else {
      node.removeAttribute('href');
    }
  }

  // img 标签：校验 src
  if (tag === 'IMG') {
    const src = safeUrl(node.getAttribute('src'));
    if (src) {
      node.setAttribute('src', src);
      // 防止超大图占页面
      node.setAttribute('loading', 'lazy');
      node.removeAttribute('width');
      node.removeAttribute('height');
    } else {
      node.remove();
      return;
    }
  }

  // 非白名单 tag：拆掉外层，保留子节点
  if (!ALLOWED.has(tag)) {
    const parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) {
      parent.insertBefore(node.firstChild, node);
    }
    node.remove();
    return;
  }

  // 递归处理子节点（注意：迭代时子节点可能改变，先复制）
  Array.from(node.childNodes).forEach(child => cleanNode(child));
}

/**
 * 把可能不可信的 HTML 字符串清洗为安全的 HTML 字符串，供 v-html 渲染。
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  if (!html) return '';
  // DOMParser 解析为 document
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    'text/html'
  );
  const body = doc.body;
  Array.from(body.childNodes).forEach(n => cleanNode(n));
  return body.innerHTML;
}

/**
 * [B-33] 把 HTML 转成纯文本：用于节目简介等只需一段预览、不需要富文本的小区域。
 * 之前节目详情页直接 {{ description }} 文本插值，含 <p style=...> 的 RSS 描述会把
 * 标签源码当文字显示（看起来像"乱码"）。这里用 DOMParser 取 textContent 彻底去标签，
 * 同时把 &amp; &lt; 等 HTML 实体正确解码、压缩多余空白。
 */
export function stripHtmlToText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}
