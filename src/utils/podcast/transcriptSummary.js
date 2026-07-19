import CryptoJS from 'crypto-js';
import { groupParagraphs } from './transcriptPostprocess';
import { requestOpenAiJson, OpenAiRequestError } from './openAiCompatible';

export const TRANSCRIPT_SUMMARY_PROMPT_VERSION = 'v1-2026-07-19';
export const SUMMARY_CHUNK_CHAR_LIMIT = 12000;

const CHUNK_SYSTEM =
  '你是中文播客内容编辑。请忠实压缩给出的文字稿片段，不补充原文没有的事实、时间戳、引语或章节。' +
  '只输出 JSON：{"summary":"不超过220字的连贯摘要"}。';
const FINAL_SYSTEM =
  '你是中文播客内容编辑。请把多段临时摘要合并为一份语义连贯的本集总结。' +
  '只依据输入，不虚构时间戳、章节、引语、人物或结论。只输出 JSON：{"summary":"完整本集总结"}。';

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function throwIfCanceled(isCanceled) {
  if (isCanceled && isCanceled()) {
    throw new OpenAiRequestError('canceled', '已取消本集总结');
  }
}

export function buildSummaryParagraphs(segments) {
  const blocks = groupParagraphs(segments || [], {
    enabled: true,
    gapSec: 1.0,
    maxLen: 100,
  });
  const paragraphs = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block || block.type !== 'para') continue;
    const text = cleanText(
      block.items
        .map(item => item && item.seg && item.seg.display)
        .filter(Boolean)
        .join('')
    );
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

export function hashTranscriptSummarySource(paragraphs) {
  return CryptoJS.SHA256((paragraphs || []).join('\n')).toString();
}

function splitLongParagraph(paragraph, limit) {
  if (paragraph.length <= limit) return [paragraph];
  const sentences = paragraph.match(/[^。！？!?；;]+[。！？!?；;]*/g) || [
    paragraph,
  ];
  const pieces = [];
  let current = '';
  sentences.forEach(sentence => {
    const next = cleanText(sentence);
    if (!next) return;
    if (current && current.length + 1 + next.length > limit) {
      pieces.push(current);
      current = '';
    }
    // A sentence that alone exceeds the limit remains intact: preserving its
    // language boundary is safer than cutting arbitrary characters mid-thought.
    if (!current && next.length > limit) {
      pieces.push(next);
      return;
    }
    current = current ? current + ' ' + next : next;
  });
  if (current) pieces.push(current);
  return pieces;
}

// Paragraphs are grouped first. An unusually long paragraph is then split at
// sentence boundaries, never at an arbitrary character offset.
export function chunkSummaryParagraphs(paragraphs, maxChars) {
  const limit = Math.max(1000, maxChars || SUMMARY_CHUNK_CHAR_LIMIT);
  const chunks = [];
  let current = [];
  let currentLength = 0;
  for (let index = 0; index < (paragraphs || []).length; index += 1) {
    const paragraph = cleanText(paragraphs[index]);
    if (!paragraph) continue;
    const pieces = splitLongParagraph(paragraph, limit);
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const piece = pieces[pieceIndex];
      const nextLength =
        currentLength + (current.length ? 1 : 0) + piece.length;
      if (current.length && nextLength > limit) {
        chunks.push(current);
        current = [];
        currentLength = 0;
      }
      current.push(piece);
      currentLength += (currentLength ? 1 : 0) + piece.length;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function isTranscriptSummaryStale(row, segments) {
  if (!row || !row.summary) return true;
  const paragraphs = buildSummaryParagraphs(segments);
  if (!paragraphs.length) return true;
  return (
    row.promptVersion !== TRANSCRIPT_SUMMARY_PROMPT_VERSION ||
    row.sourceHash !== hashTranscriptSummarySource(paragraphs)
  );
}

export function shouldApplyTranscriptSummaryResult(
  requestEpisodeId,
  activeEpisodeId
) {
  return !!requestEpisodeId && requestEpisodeId === activeEpisodeId;
}

function getSummaryFromResponse(response) {
  const value = response && response.data && response.data.summary;
  const summary = cleanText(value);
  if (!summary) {
    throw new OpenAiRequestError('invalid-summary', 'AI 服务未返回可用总结');
  }
  return summary;
}

function mergeUsage(total, usage) {
  const next = Object.assign({}, total || {});
  const input = usage || {};
  ['prompt_tokens', 'completion_tokens', 'total_tokens'].forEach(key => {
    if (typeof input[key] === 'number') {
      next[key] = (next[key] || 0) + input[key];
    }
  });
  return next;
}

export async function generateTranscriptSummary(options) {
  const opts = options || {};
  const paragraphs = buildSummaryParagraphs(opts.segments);
  if (!paragraphs.length) {
    throw new OpenAiRequestError('no-transcript', '没有可用于总结的文字稿');
  }
  const chunks = chunkSummaryParagraphs(paragraphs, opts.maxChunkChars);
  const requestJson = opts.requestJson || requestOpenAiJson;
  const isCanceled = opts.isCanceled;
  const totalSteps = chunks.length > 1 ? chunks.length + 1 : 1;
  let doneSteps = 0;
  let usage = {};
  let provider = '';
  let model = (opts.cfg && opts.cfg.model) || 'deepseek-chat';
  const interim = [];

  for (let index = 0; index < chunks.length; index += 1) {
    throwIfCanceled(isCanceled);
    const response = await requestJson(
      opts.cfg,
      [
        { role: 'system', content: CHUNK_SYSTEM },
        {
          role: 'user',
          content:
            '以下是本集文字稿的一段。请只依据该段生成忠实的临时摘要：\n\n' +
            chunks[index].join('\n'),
        },
      ],
      { signal: opts.signal }
    );
    throwIfCanceled(isCanceled);
    interim.push(getSummaryFromResponse(response));
    usage = mergeUsage(usage, response && response.usage);
    provider = (response && response.provider) || provider;
    model = (response && response.model) || model;
    doneSteps += 1;
    if (opts.onProgress) opts.onProgress(doneSteps, totalSteps);
  }

  let summary = interim[0];
  if (interim.length > 1) {
    throwIfCanceled(isCanceled);
    const response = await requestJson(
      opts.cfg,
      [
        { role: 'system', content: FINAL_SYSTEM },
        {
          role: 'user',
          content:
            '以下是同一集播客文字稿的临时摘要。请合并成一份完整总结：\n\n' +
            interim
              .map((item, index) => '第' + (index + 1) + '段：' + item)
              .join('\n'),
        },
      ],
      { signal: opts.signal }
    );
    throwIfCanceled(isCanceled);
    summary = getSummaryFromResponse(response);
    usage = mergeUsage(usage, response && response.usage);
    provider = (response && response.provider) || provider;
    model = (response && response.model) || model;
    doneSteps += 1;
    if (opts.onProgress) opts.onProgress(doneSteps, totalSteps);
  }

  return {
    summary,
    sourceHash: hashTranscriptSummarySource(paragraphs),
    promptVersion: TRANSCRIPT_SUMMARY_PROMPT_VERSION,
    provider,
    model,
    usage,
    chunkCount: chunks.length,
  };
}
