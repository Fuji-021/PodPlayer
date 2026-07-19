// [B 路·AI 精修] 调 DeepSeek 做"段内词汇级同音/近音纠错"（可选 · 默认关 · 自带 key）。
//   回归验证(KB §8.8)：DeepSeek 词汇错纠对 90%、误伤极低；整句重写不靠谱 → 本层**只做段内词汇纠错，
//   坚决不碰整句重写**，且产品层「保守采纳」再挡一道(拼音相近才采、不许变短删重复、超长段不采)。
//   网络走 node https(渲染端 nodeIntegration) → 无 CORS、无需主进程(不必重启 dev、不打扰转录)。
//   只在段内改字词；段边界/段数/时间戳全不动 → 点读/高亮/虚拟滚动复用现有逻辑(同 D 段落重组)。
import { pinyin } from 'pinyin-pro';
import { requestOpenAiJson } from './openAiCompatible';

// 改 prompt / 采纳规则务必改此号 → 旧缓存(Dexie transcriptAi.promptVer)自动失效、重算。
//   v2: 修 UTF-8 跨 chunk 乱码 + 上下文加大(前后各~3段/200字) → 旧乱码缓存自动作废重跑。
export const AI_PROMPT_VERSION = 'v2-2026-06-29';

const BATCH = 12; // 每批段数(带前后上下文)，省调用开销
const LONG_SEG_LIMIT = 80; // 超此长度的段视为整句级 → 不送 LLM、不采其改动(LLM 对长段不可靠)
const SIM_ACCEPT = 0.8; // 保守采纳：原段 vs 改后 拼音相似度下限(同音纠错≈1.0；整句重写会掉下来)

const SYSTEM =
  '你是中文播客文稿校对员。逐段校对 ASR 转录(可能有听错的同音/近音字词)。\n' +
  '铁律：\n' +
  '1. 只改明显的同音/近音错字、错听的词，使其符合上下文。\n' +
  '2. 保持原意与口语风格；不润色、不书面化、不删填充词(嗯/啊/那个)、' +
  '不删除重复字词(ASR 口吃/重复原样保留)、不调语序。\n' +
  '3. 不确定就原样保留 —— 宁可不改，不可乱改。\n' +
  '4. 人名拿不准就别改(仅在非常确定时改)。\n' +
  '5. 不合并/拆分段落；输出段数 = 输入段数，逐段对应。\n' +
  '6. 已知专名以【专名表】为准。\n' +
  '仅输出 JSON 对象：{"segs":[{"i":1,"text":"校对后","changed":true或false}]}。';

// ---- 拼音相似度(音节序列 LCS 比；无声调) ----
function syllables(s) {
  try {
    return pinyin(String(s || ''), { toneType: 'none', type: 'array' });
  } catch (e) {
    return Array.from(String(s || ''));
  }
}
function lcsLen(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      cur[j] =
        a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}
function pySim(a, b) {
  const sa = syllables(a);
  const sb = syllables(b);
  const tot = sa.length + sb.length;
  if (!tot) return 1;
  return (2 * lcsLen(sa, sb)) / tot;
}

// 是否"变短且删的是重复字"(ASR 口吃被 LLM 删掉 → 违反铁律2，拒采)
function shortenedByDedup(orig, refined) {
  if (refined.length >= orig.length) return false;
  // 原段有相邻重复字、改后没有 → 判为删重复
  const hadRepeat = /(.)\1/.test(orig);
  const stillRepeat = /(.)\1/.test(refined);
  return hadRepeat && !stillRepeat;
}

// ⭐ 保守采纳：返回最终应采用的文本(原文 或 改后)。挡整句瞎改/删重复/超长段。
export function conservativeAccept(orig, refined) {
  orig = String(orig || '');
  refined = refined == null ? '' : String(refined);
  if (!refined || refined === orig) return orig;
  if (orig.length > LONG_SEG_LIMIT) return orig; // 超长段不信 LLM
  if (refined.length > orig.length + 3 || refined.length < orig.length - 3)
    return orig; // 长度变化大=重写
  if (shortenedByDedup(orig, refined)) return orig; // 删重复
  if (pySim(orig, refined) < SIM_ACCEPT) return orig; // 拼音差远=整句改成别的(B类瞎改)
  return refined;
}

function buildUser(batchSegs, prevText, nextText, anchors) {
  const nouns = anchors && anchors.length ? anchors.join('、') : '(无)';
  const numbered = batchSegs.map((s, i) => i + 1 + '. ' + s.text).join('\n');
  return (
    '【专名表】' +
    nouns +
    '\n' +
    '【上下文】前文：' +
    (prevText || '').slice(-200) +
    ' ｜ 后文：' +
    (nextText || '').slice(0, 200) +
    '\n' +
    '【输入·逐段编号】\n' +
    numbered +
    '\n' +
    '只输出 JSON：{"segs":[{"i":段号,"text":"校对后文本","changed":是否改动}]}'
  );
}

// 主入口：对一集 speech 段做 AI 精修。
//   segs: [{idx, text}]（idx=在 viewSegments 的下标，调用方负责只传 speech 段）。
//   anchors: 该集 anchor 专名表(正确词)。cfg: {key, model, endpoint}。
//   onProgress(done,total)；isCanceled() 返回 true 即停。existing: 已缓存 {idx:text}(续跑跳过)。
//   返回 { map: {idx: 采纳后的文本}, changedIdx: [idx...], stats:{sent,accepted,rejected} }。
export async function refineEpisode(
  segs,
  anchors,
  cfg,
  onProgress,
  isCanceled,
  existing,
  options
) {
  const opts = options || {};
  if (!cfg || !cfg.key) throw new Error('请先配置联网 AI 服务');
  const map = Object.assign({}, existing || {});
  const changedIdx = [];
  let sent = 0;
  let accepted = 0;
  let rejected = 0;
  // 只送未缓存、且非超长的段
  const todo = segs.filter(
    s => !(s.idx in map) && String(s.text || '').length <= LONG_SEG_LIMIT
  );
  const total = todo.length;
  let done = 0;
  for (let b = 0; b < todo.length; b += BATCH) {
    if (isCanceled && isCanceled()) break;
    const batch = todo.slice(b, b + BATCH);
    // 上下文加大：前后各取 ~3 段(提升清晰节目的跨段一致性)；buildUser 再各截 200 字
    const prevText = todo
      .slice(Math.max(0, b - 3), b)
      .map(s => s.text)
      .join(' ');
    const nextText = todo
      .slice(b + batch.length, b + batch.length + 3)
      .map(s => s.text)
      .join(' ');
    const user = buildUser(batch, prevText, nextText, anchors);
    let parsed = null;
    try {
      const resp = await requestOpenAiJson(
        cfg,
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        { signal: opts.signal }
      );
      const obj = resp.data;
      parsed = obj.segs;
    } catch (e) {
      // 单批失败：该批降级(全保留原文)，不中断整集；记录后继续
      parsed = null;
    }
    sent += batch.length;
    // 段数铁律：输出段数必须 = 输入段数，否则整批不采(降级原文)
    const valid =
      parsed && Array.isArray(parsed) && parsed.length === batch.length;
    for (let k = 0; k < batch.length; k++) {
      const orig = batch[k].text;
      const out = valid ? parsed[k] && parsed[k].text : null;
      const finalText = conservativeAccept(orig, out);
      map[batch[k].idx] = finalText;
      if (finalText !== orig) {
        changedIdx.push(batch[k].idx);
        accepted++;
      } else if (out && out !== orig) {
        rejected++; // LLM 改了但被保守采纳挡下
      }
    }
    done += batch.length;
    if (onProgress) onProgress(done, total);
  }
  return { map, changedIdx, stats: { sent, accepted, rejected } };
}
