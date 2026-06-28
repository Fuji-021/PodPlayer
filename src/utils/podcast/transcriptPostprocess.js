// [转文字稿·质量优化] 文稿后处理（纯函数 · 原始不动 · 可重算可回退）
// ----------------------------------------------------------------------------
// 两个 pass，都不改 worker 落盘的原始 segments，仅在渲染时实时计算：
//  1) classifySegment：事件分类 speech / noise / music
//     —— 主力=垃圾文本特征(纯日文假名 / 孤立 the·yeah·单字)，event 仅辅助判"纯音乐歌词段"。
//        实测：event=BGM/Laughter 多是"有效配乐口播 / 带笑对话"，不能据此丢字；而真正的
//        吐垃圾段(あ/Yeah/The/でいいね) event 往往还是 Speech → 必须靠文本特征兜底。
//  2) applyDict：专名替换（节目级 + 全局词典，长匹配优先，确定性字符串替换）。
// 词典更新 → 重跑本模块即可即时生效；切到"原文"=不调用本模块。

const KANA_RE = /[぀-ヿ]/; // 日文 平假名 + 片假名
// 孤立的英文虚词 / 语气词单独成段（the / yeah / oh / um …）= 噪声
const LONE_JUNK_RE =
  /^(the|a|an|yeah|yep|yo|oh|ooh|oah|um|uh|uhh|hmm|mm|mhm|ah|ha|haha|wow|okay|ok|so|and|i|you|huh|hm|er|en)[\s.。!?！？,，~]*$/i;

function meaningfulLen(t) {
  const m = String(t).match(/[一-龥a-zA-Z0-9]/g);
  return m ? m.length : 0;
}

function isMostlyKana(t) {
  const s = String(t).replace(/[^぀-ヿ一-龥a-zA-Z0-9]/g, '');
  if (!s) return false;
  let k = 0;
  for (let i = 0; i < s.length; i++) {
    if (KANA_RE.test(s[i])) k++;
  }
  return k / s.length >= 0.5; // 半数以上是假名 → 中文播客里几乎必是音乐/噪声误识
}

// 这一段是不是"吐垃圾"（与 event 无关，直接命中文稿乱码）
export function looksJunk(text) {
  const t = String(text || '').trim();
  if (!t) return true; // 空段
  if (LONE_JUNK_RE.test(t)) return true;
  if (isMostlyKana(t)) return true;
  if (meaningfulLen(t) <= 1) return true; // 单字 / 单字母 / 纯标点
  return false;
}

function langCode(lang) {
  if (!lang) return '';
  const m = String(lang).match(/<\|([a-z/]+)\|>/i);
  return m ? m[1] : String(lang).replace(/[<>|]/g, '');
}
function eventCode(ev) {
  if (!ev) return '';
  const m = String(ev).match(/<\|([^|]+)\|>/);
  return m ? m[1] : String(ev).replace(/[<>|]/g, '');
}

// 'speech' | 'noise' | 'music'
export function classifySegment(seg, opts) {
  opts = opts || {};
  const mainLang = opts.mainLang || 'zh';
  const text = (seg && seg.text) || '';
  const ev = eventCode(seg && seg.event);
  const lg = langCode(seg && seg.lang);

  // 纯音乐/歌词段：BGM/Sing 且 语种偏离主语种(中文节目里冒出 en/ja…) 且 文本疑似垃圾或极短
  const isMusicEvent = ev === 'BGM' || ev === 'Sing';
  const foreignToMain = !!lg && !!mainLang && lg.indexOf(mainLang) === -1;
  if (
    isMusicEvent &&
    foreignToMain &&
    (looksJunk(text) || meaningfulLen(text) <= 8)
  ) {
    return 'music';
  }
  if (looksJunk(text)) return 'noise';
  return 'speech';
}

// 词典替换器：entries=[{from,to}]。按 from 长度降序后合成单条正则一次扫描替换——
//   同一位置最长优先匹配，且替换结果不再被二次匹配 → 杜绝 split-join 多条链式误替换
//   (如"王心"→X 把"王心凌"误伤成"X凌")。中文专名无需转义，esc 兜底用户加入含正则元字符的词。
export function buildReplacer(entries) {
  const list = (entries || [])
    .filter(e => e && e.from && e.to && e.from !== e.to)
    .slice()
    .sort((a, b) => String(b.from).length - String(a.from).length);
  if (!list.length) return text => String(text || '');
  const map = {};
  for (let i = 0; i < list.length; i++) {
    if (!(list[i].from in map)) map[list[i].from] = list[i].to;
  }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(list.map(e => esc(e.from)).join('|'), 'g');
  return function (text) {
    return String(text || '').replace(re, m =>
      map[m] !== undefined ? map[m] : m
    );
  };
}

export function applyDict(text, entries) {
  return buildReplacer(entries)(text);
}

// 一次性给所有段算出 { ...seg, kind, display }
//  - speech：display = 词典替换后的文本
//  - noise/music：display = 原文（面板会折叠为占位，不直接展示）
// opts: { dict:[{from,to}], mainLang:'zh' }
export function postprocessSegments(segments, opts) {
  opts = opts || {};
  const replace = buildReplacer(opts.dict);
  const mainLang = opts.mainLang || 'zh';
  return (segments || []).map(seg => {
    const kind = classifySegment(seg, { mainLang });
    const display =
      kind === 'speech' ? replace(seg.text || '') : seg.text || '';
    return Object.assign({}, seg, { kind, display });
  });
}
