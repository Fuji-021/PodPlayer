// [封面缓存·治本] 本地持久封面缓存（渲染端）。
//
// 背景：部分节目封面托管在国内不稳定的国际 CDN——实测「疯投圈」封面
//   (https://crazy.capital/assets/icon-square-normal-dark-cn@4x.png) 在 Cloudflare 台北节点，
//   国内访问 TLS 握手时通时断（首次 GET 直接握手失败超时），且响应头带 `max-age=0, must-revalidate`
//   → 浏览器每次打开订阅页都要向不稳定的 CF 发一次实时重校验请求；CF 一抽风，<img> 就在
//   PodImage 的 opacity:0 下长时间空白 =「封面加载很慢」。与图片大小无关（该图仅 15KB）。
//
// 治本思路：封面首次成功加载后（复用 PodImage 里那张已解码的 <img>，不额外发请求、尊重 lazy），
//   canvas 降采样成 ~360px JPEG dataURL，持久化到 Dexie 的 coverCache 表。之后 PodImage 命中即直接
//   用本地 dataURL（零网络），彻底摆脱国际 CDN 的实时往返。全 app 所有封面位置统一受益。
//
// 复用项目既有方案：与 coverHalo.js 同款 canvas 降采样（主窗 webSecurity:false → 跨域封面 toDataURL
//   不被污染）。任何环节失败都安静回退（显示侧仍用原 url 的 <img>），绝不抛、绝不影响展示。
//
// ⚠️ 本文件位于 src/utils/podcast/ → 全程禁用可选链 ?./空值合并 ??（铁律），统一 && / || 守卫。
//   （仅渲染端使用：依赖 document/Image/canvas；不会被主进程 Node14 加载。）

import { db } from '@/utils/db';

const _mem = new Map(); // url -> dataURL（会话内同步命中，免重复 Dexie 读）
const _pendingGet = new Map(); // url -> Promise<string|null>（Dexie 在途读去重）

const MAX_DIM = 360; // 显示档：封面卡最大 ~180px，2x 高清屏 360px 足够清晰，体积可控
const JPEG_Q = 0.82;
const CACHE_MAX = 300; // LRU 上限（远超个人订阅量，纯防失控）；每条 dataURL ~15-40KB

// 同步窥探：会话内存命中返回 dataURL；否则返回 null（调用方先用原 url 兜底，零闪烁）。
export function peekCachedCover(url) {
  if (!url) return null;
  return _mem.has(url) ? _mem.get(url) : null;
}

// 异步读 Dexie 持久缓存（只读、不发网络）：命中返回 dataURL 并写入内存层；未命中/出错返回 null。绝不抛。
export function getCachedCover(url) {
  if (!url) return Promise.resolve(null);
  if (_mem.has(url)) return Promise.resolve(_mem.get(url));
  if (_pendingGet.has(url)) return _pendingGet.get(url);
  const p = db.coverCache
    .get(url)
    .then(row => {
      if (row && row.data) {
        _mem.set(url, row.data);
        // 触碰 ts 供 LRU（失败忽略，不影响命中）
        db.coverCache.update(url, { ts: Date.now() }).catch(() => {});
        return row.data;
      }
      return null;
    })
    .catch(() => null);
  _pendingGet.set(url, p);
  p.finally(() => _pendingGet.delete(url));
  return p;
}

// 把一张已加载完成的 <img> 元素降采样成 dataURL 并持久化（供下次零网络命中）。
//   复用 PodImage 显示用的那张 <img>，不额外发网络请求；失败静默（显示侧不受影响）。
export function cacheCoverFromImg(url, imgEl) {
  if (!url || !imgEl || _mem.has(url)) return;
  try {
    const w = imgEl.naturalWidth || imgEl.width || 0;
    const h = imgEl.naturalHeight || imgEl.height || 0;
    if (!w || !h) return;
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(imgEl, 0, 0, cw, ch);
    const data = c.toDataURL('image/jpeg', JPEG_Q);
    if (!data || data.length < 64) return; // 异常/空 dataURL 不入库
    _mem.set(url, data); // 先进内存层（本会话即时可用），再 fire-and-forget 落盘
    db.coverCache
      .put({ url, data, ts: Date.now() })
      .then(() => pruneCoverCache())
      .catch(() => {});
  } catch (e) {
    // 跨域污染（理论上 webSecurity:false 不会发生）/canvas 失败 → 放弃缓存，回退原 url 展示
  }
}

// 轻量 LRU：超上限时按 ts 删最旧。fire-and-forget，单次去重避免并发重复扫描。
let _pruning = false;
function pruneCoverCache() {
  if (_pruning) return;
  _pruning = true;
  db.coverCache
    .count()
    .then(n => {
      if (n <= CACHE_MAX) return null;
      return db.coverCache
        .orderBy('ts')
        .limit(n - CACHE_MAX)
        .primaryKeys()
        .then(keys =>
          keys && keys.length ? db.coverCache.bulkDelete(keys) : null
        );
    })
    .catch(() => {})
    .finally(() => {
      _pruning = false;
    });
}

// [缓存·C1] 统计封面缓存占用（项数 + 近似字节 = 各 dataURL 字符串长度之和），供设置页"清理缓存"展示。
export async function getCoverCacheStats() {
  try {
    let count = 0;
    let bytes = 0;
    await db.coverCache.each(row => {
      count += 1;
      bytes += (row && row.data && row.data.length) || 0;
    });
    return { count, bytes };
  } catch (e) {
    return { count: 0, bytes: 0 };
  }
}

// [缓存·C1] 清空封面缓存（Dexie 表 + 会话内存层）。下次进各封面位置会重新从远程加载并重新落盘。
export async function clearCoverCache() {
  _mem.clear();
  try {
    await db.coverCache.clear();
  } catch (e) {
    // 忽略
  }
}
