// [沉浸式播放页 P0] 封面 3 色调色板：给沉浸页中层「三色径向渐变」用。
//
// 设计取舍（见 docs/沉浸式播放页方案.md §3.1，2026-06-14 定）：
//   - 取消「对立色硬规则」，**忠实封面冷暖分布**：按各 swatch 在封面里的占比(population)排序取最显著的 3 色，
//     日落封面「上暖(橘红天)下冷(青蓝海)」正是封面立意，不再人为砍对立色。
//   - 主色策略：亮封面取 DarkMuted 打底更耐看、暗封面取 Vibrant。
//   - 柔化(学网易云)：统一降饱和(×0.7)+ 明度收敛到中低区间，避免高饱和糊脸；和谐靠柔化+大面积模糊保证。
//   - 退化兜底：单色封面候选不足 → 主色 + 2 个明度变体，保证永远有 3 个层次。
//
// CORS：复用 coverColor.js 同款 node-vibrant worker 版 + Electron webSecurity:false → 跨域封面也能取色
//   (该机制已在播放栏标记主色长期生产使用，无需 express 代理)。取色仅切歌时算一次并缓存。
import * as Vibrant from 'node-vibrant/dist/vibrant.worker.min.js';
// [性能·取色降解码] 复用 coverHalo 64px 降采样图喂 vibrant，命中省 ~99% 解码、未命中用原图不变。
import { peekTinyCover } from './coverHalo';

// [审P3-3] 同 coverColor：模块级 Map 加 LRU 上限，防连播单调增长。
const cache = new Map();
const CACHE_MAX = 100;

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l]; // h:0-1, s:0-1, l:0-1
}

// 柔化：降饱和 ×0.7 + 明度收敛中低区间，返回 [h(0-360), s(%), l(%)]
function softHsl(rgb) {
  let [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  h = Math.round(h * 360);
  s = Math.round(Math.max(0, Math.min(1, s * 0.7)) * 100);
  s = Math.max(16, Math.min(62, s)); // 不灰死也不刺眼
  l = Math.round(Math.max(0, Math.min(1, l)) * 100);
  l = Math.max(28, Math.min(58, l)); // 中低明度，压住过曝
  return [h, s, l];
}

function popOf(sw) {
  if (!sw) return 0;
  if (typeof sw.population === 'number') return sw.population;
  if (typeof sw._population === 'number') return sw._population;
  return 0;
}

// 返回 { hsl: [[h,s,l],[h,s,l],[h,s,l]], dark: bool } 或 null。
export async function getCoverPalette(coverUrl) {
  if (!coverUrl) return null;
  if (cache.has(coverUrl)) {
    const v = cache.get(coverUrl);
    cache.delete(coverUrl);
    cache.set(coverUrl, v); // LRU：命中提到最新
    return v;
  }
  try {
    const src = peekTinyCover(coverUrl) || coverUrl;
    const palette = await Vibrant.from(src, {
      colorCount: 32,
      maxDimension: 128,
    }).getPalette();
    const order = [
      'Vibrant',
      'Muted',
      'DarkVibrant',
      'DarkMuted',
      'LightVibrant',
      'LightMuted',
    ];
    const swatches = order.map(k => palette[k]).filter(s => s && s._rgb);
    if (!swatches.length) return null;

    // 按封面占比降序（忠实封面色彩分布）
    const byPop = [...swatches].sort((a, b) => popOf(b) - popOf(a));
    // 暗/亮封面判定：主导色亮度
    const domL = rgbToHsl(
      byPop[0]._rgb[0],
      byPop[0]._rgb[1],
      byPop[0]._rgb[2]
    )[2];
    const dark = domL < 0.5;
    // 主色：暗封面→Vibrant 提气；亮封面→DarkMuted 打底耐看
    const mainSw = dark
      ? palette.Vibrant || byPop[0]
      : palette.DarkMuted || byPop[byPop.length - 1];

    // 主色优先，其余按占比补足，去重
    const picks = [];
    const pushUnique = sw => {
      if (!sw || !sw._rgb) return;
      const key = sw._rgb.join(',');
      if (!picks.some(p => p._rgb.join(',') === key)) picks.push(sw);
    };
    pushUnique(mainSw);
    byPop.forEach(pushUnique);

    let hsl = picks.slice(0, 3).map(sw => softHsl(sw._rgb));

    // 退化兜底：不足 3 色 → 主色 + 明度变体，保证 3 个层次
    if (hsl.length < 3) {
      const base = softHsl(mainSw._rgb);
      hsl = [
        base,
        [base[0], base[1], Math.min(64, base[2] + 12)],
        [base[0], base[1], Math.max(24, base[2] - 12)],
      ];
    }

    const result = { hsl, dark };
    cache.set(coverUrl, result);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return result;
  } catch (e) {
    return null;
  }
}
