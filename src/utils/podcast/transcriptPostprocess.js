// [转文字稿·质量优化] 文稿后处理（纯函数 · 原始不动 · 可重算可回退）
// ----------------------------------------------------------------------------
// 两个 pass，都不改 worker 落盘的原始 segments，仅在渲染时实时计算：
//  1) classifySegment：事件分类 speech / noise / music
//     —— 主力=垃圾文本特征(纯日文假名 / 孤立 the·yeah·单字)，event 仅辅助判"纯音乐歌词段"。
//        实测：event=BGM/Laughter 多是"有效配乐口播 / 带笑对话"，不能据此丢字；而真正的
//        吐垃圾段(あ/Yeah/The/でいいね) event 往往还是 Speech → 必须靠文本特征兜底。
//  2) applyDict：专名精确替换（节目级 + 全局词典，长匹配优先，确定性字符串替换）。
//  3) pinyinNormalize：anchor 模糊拼音同音归一（节目级 + author，破解同音变体枚举不完）。
// 词典更新 → 重跑本模块即可即时生效；切到"原文"=不调用本模块。
import { buildAnchors, pinyinNormalize } from './pinyinNormalize';

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
// opts: { dict:[{from,to}] 精确, anchors:[{to}] 拼音锚定, mainLang:'zh' }
export function postprocessSegments(segments, opts) {
  opts = opts || {};
  const replace = buildReplacer(opts.dict);
  const anchors = buildAnchors(opts.anchors);
  const mainLang = opts.mainLang || 'zh';
  return (segments || []).map(seg => {
    const kind = classifySegment(seg, { mainLang });
    let display = seg.text || '';
    if (kind === 'speech') {
      // 顺序：精确替换 → 拼音同音归一
      display = pinyinNormalize(replace(display), anchors);
    }
    return Object.assign({}, seg, { kind, display });
  });
}

// ----------------------------------------------------------------------------
// [D · 段落重组] 把同一意群的相邻短段聚成"段落"显示，治 VAD 按声学停顿切致的断句过碎
// （能力有限《亚洲足球》"更是历史上/首次/扩军的48支球队/参加比赛"一句被切 4 行）。
//
// 关键设计：**不合并成新段**（那会毁掉点读/高亮的时间锚点），而是只决定"哪些相邻段
//   属于同一段落"，组内每个原始段仍独立保留 {vi, seg}（vi=在输入数组的下标，供点读/高亮）。
//   渲染层把一组渲染成一个段落容器、组内各段作 <span> 连排；点读/高亮粒度不降反升。
// 纯函数、不改 worker、不改 seg 本身、可重算可回退（与本文件其它 pass 一致）。
//
// 返回有序块数组，块为段落或 gap：
//   { type:'para', items:[{vi,seg},…] }        —— 一个自然段落（≥1 个 speech 段连排）
//   { type:'gap',  music:bool, count, items:[…] } —— 连续 noise/music 折叠占位（不并入段落）
const SENT_END_RE = /[。！？!?…]+["'""'）)】」』]*\s*$/; // 句末标点（。！？?!…，可带收尾引号/括号）

function paraTextLen(t) {
  // 段落长度预算：display 可见字符数（去空白），用于"超长断段"兜底
  return Array.from(String(t || '').replace(/\s+/g, '')).length;
}
function segGapSec(prev, cur) {
  // 相邻段时间间隔；无 end 用 start 近似；拿不到时间则当 0（不因缺时间戳硬断段）
  const ps = prev && prev.end != null ? prev.end : prev && prev.start;
  const cs = cur && cur.start;
  if (ps == null || cs == null) return 0;
  const d = cs - ps;
  return d > 0 ? d : 0;
}

// segments: 已 postprocess 的段（含 kind/display）。opts:{ enabled, gapSec, maxLen }
//   enabled=false → 逐句模式：每个 speech 段独立成段落（块结构一致，便于统一渲染）。
export function groupParagraphs(segments, opts) {
  opts = opts || {};
  const enabled = opts.enabled !== false;
  const gapSec = opts.gapSec != null ? opts.gapSec : 1.0;
  const maxLen = opts.maxLen != null ? opts.maxLen : 100;
  const vs = segments || [];
  const blocks = [];
  let para = null;
  let gap = null;
  const flushPara = () => {
    if (para) {
      blocks.push(para);
      para = null;
    }
  };
  const flushGap = () => {
    if (gap) {
      blocks.push(gap);
      gap = null;
    }
  };
  for (let i = 0; i < vs.length; i++) {
    const seg = vs[i];
    if (!seg || seg.kind !== 'speech') {
      // noise/music：天然分隔，断开当前段落、折叠进 gap 块（不并入任何段落）
      flushPara();
      if (!gap) gap = { type: 'gap', music: false, count: 0, items: [] };
      gap.count++;
      gap.items.push({ vi: i, seg: seg });
      if (seg && seg.kind === 'music') gap.music = true;
      continue;
    }
    // speech：先收掉前面的 gap 占位
    flushGap();
    const segLen = paraTextLen(seg.display);
    if (para && enabled) {
      const prev = para.items[para.items.length - 1].seg;
      const prevEndsSentence = SENT_END_RE.test(String(prev.display || ''));
      const gapDur = segGapSec(prev, seg);
      const wouldExceed = para.len + segLen > maxLen;
      // 并入同一段落 ⟺ 前段未以句末标点结束 且 间隔小 且 不超长
      if (!prevEndsSentence && gapDur < gapSec && !wouldExceed) {
        para.items.push({ vi: i, seg: seg });
        para.len += segLen;
        continue;
      }
    }
    // 否则起新段落（逐句模式即时收口 → 每段独立）
    flushPara();
    para = { type: 'para', items: [{ vi: i, seg: seg }], len: segLen };
    if (!enabled) flushPara();
  }
  flushPara();
  flushGap();
  return blocks;
}
