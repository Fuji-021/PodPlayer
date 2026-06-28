// [转文字稿·质量优化 A1] 模糊拼音同音归一（纯函数 · 原始不动 · 可重算可回退）
// ----------------------------------------------------------------------------
// 思路：词典只存一个正确专名(anchor)，把文稿中读音相近的等长片段一次归一成它，
//   破解"同音变体枚举不完"(黄峥 一集 10+ 写法)。接在 applyDict(精确替换) 之后。
// 模糊组(真实变体集实测定档：命中率 92%、误伤率 0%)：
//   声母 zh/z·ch/c·sh/s·n/l·r/l·f/h/w；韵母 en/eng·in/ing·an/ang·ian/iang。
//   ⚠️ ong 不并 eng(黄忠 zhōng ≠ 黄峥 zhēng，防三国误伤)；uang/介音不动(代价=王峥不命中，可手动 exact 补)。
// 防误伤：① 节目级作用域(调用方只传该节目 anchor) ② anchor ≥2 字 ③ 命中片段长度严格=anchor 长度。
import { pinyin } from 'pinyin-pro';

function parseSyl(syl) {
  const m = String(syl).match(/^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(.*)$/);
  return { i: (m && m[1]) || '', f: (m && m[2]) || '' };
}
const INI_FUZZY = {
  zh: 'z',
  z: 'z',
  ch: 'c',
  c: 'c',
  sh: 's',
  s: 's',
  n: 'l',
  l: 'l',
  r: 'l',
  f: 'h',
  h: 'h',
  w: 'h',
};
function fuzzIni(i) {
  return INI_FUZZY[i] !== undefined ? INI_FUZZY[i] : i;
}
function fuzzFin(f) {
  if (f === 'iang') return 'ian';
  if (f === 'ing') return 'in';
  if (f === 'eng') return 'en';
  if (f === 'ang') return 'an';
  return f; // ong / uang 等保持，防黄忠/介音误伤
}
function sylKey(syl) {
  const p = parseSyl(syl);
  return fuzzIni(p.i) + fuzzFin(p.f);
}
function isPy(p) {
  return /^[a-z]+$/.test(p);
}

// 词的模糊拼音键（非汉字字符以空格占位、不参与归一）
export function fuzzyPinyinKey(word) {
  const arr = pinyin(word, { toneType: 'none', type: 'array' });
  return arr.map(p => (isPy(p) ? sylKey(p) : ' ')).join('|');
}

// anchors: [{to}] 或 [string] → [{to,key,len}]，过滤 <2 字，按长度降序(长优先)
export function buildAnchors(words) {
  return (words || [])
    .map(w => (typeof w === 'string' ? w : w && w.to))
    .filter(Boolean)
    .map(to => ({
      to: to,
      key: fuzzyPinyinKey(to),
      len: Array.from(to).length,
    }))
    .filter(a => a.len >= 2)
    .sort((a, b) => b.len - a.len);
}

// 对 text 做等长滑窗模糊归一；builtAnchors=buildAnchors() 的结果(已预算 key/len)。
export function pinyinNormalize(text, builtAnchors) {
  if (!builtAnchors || !builtAnchors.length) return String(text || '');
  const chars = Array.from(String(text || ''));
  if (!chars.length) return '';
  const py = pinyin(chars.join(''), { toneType: 'none', type: 'array' });
  // py 与 chars 等长(每字一拼音/原字符)；长度不一致则保守不归一
  if (!py || py.length !== chars.length) return chars.join('');
  let out = '';
  let i = 0;
  while (i < chars.length) {
    let matched = false;
    for (let k = 0; k < builtAnchors.length; k++) {
      const a = builtAnchors[k];
      if (i + a.len <= chars.length) {
        const seg = py.slice(i, i + a.len);
        if (seg.length === a.len && seg.every(isPy)) {
          if (seg.map(sylKey).join('|') === a.key) {
            out += a.to;
            i += a.len;
            matched = true;
            break;
          }
        }
      }
    }
    if (!matched) {
      out += chars[i];
      i++;
    }
  }
  return out;
}
