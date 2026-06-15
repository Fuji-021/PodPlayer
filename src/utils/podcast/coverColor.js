// [B-39 播客改造] 提取封面主色（node-vibrant，项目已用于歌词页背景）。
// 返回 [h, s, l]（h:0-360, s/l:0-100），并把 s/l 夹到安全区间，避免纯黑/纯白/灰影响阅读。
// webSecurity:false 让跨域封面也能被 canvas 取色。worker 版异步、不阻塞 UI。
import * as Vibrant from 'node-vibrant/dist/vibrant.worker.min.js';

// [审P3-3] LRU 上限：取色结果(仅 [h,s,l] 三个数)很小，但模块级 Map 只增不淘汰会随连播单调增长。
//   套用 episodeCache.js 同款 LRU(命中提到最新、超量淘汰最旧)，cap 100 对个人自用足够。
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
  return [h, s, l];
}

export async function getCoverColor(coverUrl) {
  if (!coverUrl) return null;
  if (cache.has(coverUrl)) {
    const v = cache.get(coverUrl);
    cache.delete(coverUrl);
    cache.set(coverUrl, v); // LRU：命中提到最新
    return v;
  }
  try {
    const palette = await Vibrant.from(coverUrl, {
      colorCount: 1,
    }).getPalette();
    const sw =
      palette.Vibrant ||
      palette.LightVibrant ||
      palette.Muted ||
      palette.DarkVibrant;
    if (!sw || !sw._rgb) return null;
    const [r, g, b] = sw._rgb;
    let [h, s, l] = rgbToHsl(r, g, b);
    h = Math.round(h * 360);
    s = Math.min(46, Math.max(22, Math.round(s * 100))); // [B-40] 低饱和：夹 22~46，柔和不刺眼
    l = Math.min(58, Math.max(44, Math.round(l * 100))); // 亮度 44~58，避免纯黑/纯白
    const hsl = [h, s, l];
    cache.set(coverUrl, hsl);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return hsl;
  } catch (e) {
    return null;
  }
}
