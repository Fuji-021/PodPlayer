// [转文字稿] 渲染端封装：Dexie 索引 DAO + IPC 命令/事件 + 活动任务实时态。
//   仿 utils/podcast/downloads.js 的惯例（window.require('electron').ipcRenderer、
//   registerXListeners() 一次、invoke 发命令、on 收事件、store.dispatch('showToast')）。
//   只负责"触发转录 + 维护状态/索引"，引擎在主进程子进程里，渲染端不碰。
import Vue from 'vue';
import { db } from '@/utils/db';
import store from '@/store';
import { getDownload } from '@/utils/podcast/downloads';
import { refineEpisode, AI_PROMPT_VERSION } from '@/utils/podcast/aiRefine';
import {
  buildSummaryParagraphs,
  generateTranscriptSummary,
  hashTranscriptSummarySource,
  TRANSCRIPT_SUMMARY_PROMPT_VERSION,
} from '@/utils/podcast/transcriptSummary';
import { hasOpenAiKey } from '@/utils/podcast/openAiCompatible';

const ipcRenderer = window.require
  ? window.require('electron').ipcRenderer
  : null;

// 活动任务实时态（单任务队列 → 全 app 唯一）。Vue.observable 使面板直接响应式读取，
//   不必往全局 Vuex store 增加切面。面板按 episodeId 比对决定是否展示这份实时态。
export const transcribeState = Vue.observable({
  episodeId: '',
  status: 'idle', // idle | running | done | error | canceled
  phase: '', // '' | decoding | loading | transcribing
  processedSec: 0,
  totalSec: 0,
  segCount: 0,
  lastText: '', // 最近一段文本（转录中 ticker）
  error: '',
});
const transcriptDeleteGuards = new Map();

function guardTranscriptDelete(episodeId) {
  const oldTimer = transcriptDeleteGuards.get(episodeId);
  if (oldTimer) clearTimeout(oldTimer);
  const timer = setTimeout(() => {
    transcriptDeleteGuards.delete(episodeId);
  }, 30000);
  transcriptDeleteGuards.set(episodeId, timer);
}

function clearTranscriptDeleteGuard(episodeId) {
  const timer = transcriptDeleteGuards.get(episodeId);
  if (timer) clearTimeout(timer);
  transcriptDeleteGuards.delete(episodeId);
}

function resetLive(episodeId, totalSec) {
  transcribeState.episodeId = episodeId;
  transcribeState.status = 'running';
  transcribeState.phase = '';
  transcribeState.processedSec = 0;
  transcribeState.totalSec = totalSec || 0;
  transcribeState.segCount = 0;
  transcribeState.lastText = '';
  transcribeState.error = '';
}

// ---------- Dexie 索引 DAO ----------
export function getTranscript(episodeId) {
  return db.transcripts.get(episodeId);
}

// 批量读多集的转录持久态(Dexie，渲染端，不碰主进程)：episodeId → status。
//   供列表(如节目详情)显示各集转录状态。仅一次 bulkGet。
export async function listTranscriptStatuses(episodeIds) {
  const map = {};
  const ids = episodeIds || [];
  if (!ids.length) return map;
  try {
    const rows = await db.transcripts.bulkGet(ids);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].status) map[ids[i]] = rows[i].status;
    }
  } catch (e) {
    /* ignore */
  }
  return map;
}

export async function saveTranscript(episodeId, data) {
  const podcastId = String(episodeId).split('::')[0];
  let existing = null;
  try {
    existing = await db.transcripts.get(episodeId);
  } catch (e) {
    existing = null;
  }
  const createdAt = (existing && existing.createdAt) || Date.now();
  return db.transcripts.put(
    Object.assign({ id: episodeId, podcastId, createdAt }, data, {
      updatedAt: Date.now(),
    })
  );
}

export function updateTranscript(episodeId, patch) {
  return db.transcripts.update(
    episodeId,
    Object.assign({}, patch, { updatedAt: Date.now() })
  );
}

export async function deleteTranscript(episodeId) {
  guardTranscriptDelete(episodeId);
  let ipcResult = { ok: true };
  try {
    if (ipcRenderer) {
      ipcResult = await ipcRenderer.invoke('asr:delete', { episodeId });
    }
  } catch (e) {
    ipcResult = { ok: false, error: String((e && e.message) || e) };
  }
  if (!ipcResult || !ipcResult.ok) {
    clearTranscriptDeleteGuard(episodeId);
    return ipcResult || { ok: false, error: 'transcript-delete-failed' };
  }
  try {
    await db.transaction(
      'rw',
      db.transcripts,
      db.transcriptAi,
      db.transcriptSummaries,
      async () => {
        await db.transcripts.delete(episodeId);
        await db.transcriptAi.delete(episodeId);
        await db.transcriptSummaries.delete(episodeId);
      }
    );
  } catch (e) {
    clearTranscriptDeleteGuard(episodeId);
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (transcribeState.episodeId === episodeId) {
    transcribeState.status = 'idle';
    transcribeState.phase = '';
    transcribeState.error = '';
  }
  return { ok: true };
}

// ---------- 专名替换词典 DAO（节目级 + 全局；exact 精确 / anchor 拼音锚定） ----------

// 内置全局通用纠错(A3)。铁律=「错词本身几乎不可能合法出现」，故全局零误伤；
//   有歧义的同音错(如"湿度关系→师徒关系")绝不入此表，留给节目级或后续 LLM 上下文判断。
const BUILTIN_GLOBAL_EXACT = [
  { from: '极时通信', to: '即时通信' }, // "极时通信"非法
  { from: '耳钉面命', to: '耳提面命' }, // 错词非法
  { from: '鸟枪放换炮', to: '鸟枪换炮' }, // 错词非法
];

// id 含 mode，避免同词的 exact/anchor 冲突；anchor 用正确词 to 作键，exact 用 from。
function dictId(scope, podcastId, mode, key) {
  return (
    scope +
    ':' +
    (scope === 'podcast' ? podcastId || '' : '') +
    ':' +
    (mode === 'anchor' ? 'a' : 'e') +
    ':' +
    key
  );
}

// 拆 podcast.author 成人名(A2)：分隔符切分 + 过滤(2–4 纯中文、去停用词、去重)。
const AUTHOR_STOPWORDS = {
  主播: 1,
  嘉宾: 1,
  主持: 1,
  主持人: 1,
  出品: 1,
  制作: 1,
  策划: 1,
  编辑: 1,
  录制: 1,
  后期: 1,
  运营: 1,
  团队: 1,
  电台: 1,
  工作室: 1,
};
export function parseAuthorNames(author) {
  const raw = String(author || '').split(/[\s、&/,，｜|和]+/);
  const seen = {};
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i].trim();
    if (!/^[一-龥]{2,4}$/.test(w)) continue; // 仅 2–4 纯中文
    if (AUTHOR_STOPWORDS[w]) continue;
    if (seen[w]) continue;
    seen[w] = 1;
    out.push(w);
  }
  return out;
}

// 列出某节目可见的全部词条(全局表 + 该节目级)，带 id/scope/mode/source，供管理/删除
export async function listDict(podcastId) {
  try {
    const [g, p] = await Promise.all([
      db.transcriptDict.where('scope').equals('global').toArray(),
      podcastId
        ? db.transcriptDict.where('podcastId').equals(podcastId).toArray()
        : Promise.resolve([]),
    ]);
    const map = {};
    g.concat(p).forEach(r => {
      if (r && (r.from || r.to)) map[r.id] = r;
    });
    return Object.keys(map).map(k => map[k]);
  } catch (e) {
    return [];
  }
}

// 取后处理输入：{ exact:[{from,to}], anchors:[{to}] }
//   exact = 内置全局 + 表里 mode!=='anchor' 的条；anchors = 表里 mode==='anchor' 的条(去重 to)。
export async function getDictParts(podcastId) {
  const rows = await listDict(podcastId);
  const exact = BUILTIN_GLOBAL_EXACT.slice();
  const anchorSeen = {};
  const anchors = [];
  rows.forEach(r => {
    if (r.mode === 'anchor') {
      const to = String(r.to || '').trim();
      if (to && !anchorSeen[to]) {
        anchorSeen[to] = 1;
        anchors.push({ to });
      }
    } else if (r.from && r.to) {
      exact.push({ from: r.from, to: r.to });
    }
  });
  return { exact, anchors };
}

// 新增/更新一条词条。opts: { scope, podcastId, from, to, mode, source }
export async function addDictEntry(opts) {
  opts = opts || {};
  const scope = opts.scope === 'global' ? 'global' : 'podcast';
  const mode = opts.mode === 'anchor' ? 'anchor' : 'exact';
  const source = opts.source || 'manual';
  const to = String(opts.to || '').trim();
  let from = String(opts.from || '').trim();
  if (!to) return { ok: false, error: '正确词为空' };
  if (mode === 'exact') {
    if (!from || from === to) {
      return { ok: false, error: '错词为空或与正词相同' };
    }
  } else {
    if (Array.from(to).length < 2) {
      return { ok: false, error: 'anchor 正确词需至少 2 字' };
    }
    from = ''; // anchor 不需要错词，锚定正确词、靠拼音命中近音变体
  }
  const podcastId = scope === 'podcast' ? opts.podcastId || '' : '';
  if (scope === 'podcast' && !podcastId) {
    return { ok: false, error: '缺少节目标识' };
  }
  const key = mode === 'anchor' ? to : from;
  const id = dictId(scope, podcastId, mode, key);
  let existing = null;
  try {
    existing = await db.transcriptDict.get(id);
  } catch (e) {
    existing = null;
  }
  await db.transcriptDict.put({
    id,
    scope,
    podcastId,
    from,
    to,
    mode,
    source,
    createdAt: (existing && existing.createdAt) || Date.now(),
    updatedAt: Date.now(),
  });
  return { ok: true, id };
}

export async function removeDictEntry(id) {
  try {
    await db.transcriptDict.delete(id);
  } catch (e) {
    /* ignore */
  }
  return { ok: true };
}

// A2：按 podcast.author 同步该节目的 author 来源 anchor 词条
//   (新增当前人名、删除已不在 author 里的旧 author 条；author 变更即刷新)。
export async function syncAuthorAnchors(podcastId, author) {
  if (!podcastId) return;
  const names = parseAuthorNames(author);
  try {
    const rows = await db.transcriptDict
      .where('podcastId')
      .equals(podcastId)
      .toArray();
    const oldAuthor = rows.filter(r => r && r.source === 'author');
    const want = {};
    names.forEach(n => (want[n] = 1));
    for (let i = 0; i < oldAuthor.length; i++) {
      if (!want[oldAuthor[i].to]) {
        await db.transcriptDict.delete(oldAuthor[i].id).catch(() => {});
      }
    }
    for (let i = 0; i < names.length; i++) {
      await addDictEntry({
        scope: 'podcast',
        podcastId,
        to: names[i],
        mode: 'anchor',
        source: 'author',
      });
    }
  } catch (e) {
    /* ignore */
  }
}

// ---------- IPC 命令 ----------
export async function getAsrStatus(episodeId) {
  if (!ipcRenderer) return { ok: false, modelReady: false };
  try {
    return await ipcRenderer.invoke('asr:status', { episodeId });
  } catch (e) {
    return { ok: false, modelReady: false };
  }
}

export async function readSegments(episodeId) {
  if (!ipcRenderer) return { ok: false, segments: [] };
  try {
    return await ipcRenderer.invoke('asr:read', { episodeId });
  } catch (e) {
    return { ok: false, segments: [] };
  }
}

// 导出文稿：内容(txt+srt)由渲染端按当前「原文/已优化」模式生成并传入；弹另存为后按扩展名写。
export async function exportTranscriptText(episodeId, defaultName, txt, srt) {
  if (!ipcRenderer) {
    store.dispatch('showToast', '导出仅在桌面版可用');
    return { ok: false };
  }
  try {
    return await ipcRenderer.invoke('asr:exportText', {
      episodeId,
      defaultName: defaultName || 'transcript',
      txt: txt || '',
      srt: srt || '',
    });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 启动/续转。episode 需含 id、duration；本地音频路径从下载记录解析（只转已下载/已缓存的集）。
export async function startTranscribe(episode) {
  if (!ipcRenderer) {
    store.dispatch('showToast', '转文字稿仅在桌面版可用');
    return { ok: false };
  }
  if (!episode || !episode.id) return { ok: false };
  let audioPath = '';
  try {
    const row = await getDownload(episode.id);
    if (row && row.filePath) audioPath = row.filePath;
  } catch (e) {
    /* ignore */
  }
  if (!audioPath) {
    const pm =
      (store.state.podcastDownloads && store.state.podcastDownloads.pathMap) ||
      {};
    audioPath = pm[episode.id] || '';
  }
  if (!audioPath) {
    store.dispatch('showToast', '请先下载本集，再生成文字稿');
    return { ok: false, reason: 'not-downloaded' };
  }
  clearTranscriptDeleteGuard(episode.id);
  // [批量入队·不抢占] 仅当当前无其它正在跑的任务、或就是本集时，才接管实时态显示；
  //   否则(已有别集在转，如批量逐集转录)只入队，不把进度显示从正在转的那条抢过来。
  if (
    !transcribeState.episodeId ||
    transcribeState.status !== 'running' ||
    transcribeState.episodeId === episode.id
  ) {
    resetLive(episode.id, episode.duration || 0);
  }
  try {
    await saveTranscript(episode.id, {
      status: 'running',
      model: '',
      segPath: '',
      txtPath: '',
      segCount: 0,
      durationMs: (episode.duration || 0) * 1000,
      error: '',
    });
  } catch (e) {
    /* ignore */
  }
  let res;
  try {
    res = await ipcRenderer.invoke('asr:transcribe', {
      episodeId: episode.id,
      audioPath,
      title: episode.title || '',
      durationSec: episode.duration || 0,
    });
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  if (!res || !res.ok) {
    const err = (res && res.error) || '';
    transcribeState.status = 'error';
    transcribeState.error = err;
    if (err === 'model-missing') {
      // 模型未部署：回到未转录态、由面板引导部署，不报错
      transcribeState.status = 'idle';
      try {
        await deleteTranscript(episode.id);
      } catch (e) {
        /* ignore */
      }
    } else {
      store.dispatch('showToast', '启动转录失败：' + err);
      try {
        await updateTranscript(episode.id, { status: 'error', error: err });
      } catch (e) {
        /* ignore */
      }
    }
  }
  return res || { ok: false };
}

export async function cancelTranscribe(episodeId) {
  if (!ipcRenderer) return { ok: false };
  try {
    return await ipcRenderer.invoke('asr:cancel', { episodeId });
  } catch (e) {
    return { ok: false };
  }
}

// ---------- IPC 事件监听（启动时注册一次，复用下载端同款幂等守卫） ----------
let _registered = false;
export function registerTranscriptListeners() {
  if (_registered || !ipcRenderer) return;
  _registered = true;

  ipcRenderer.on('asr:progress', (_e, p) => {
    if (!p || !p.episodeId) return;
    if (transcriptDeleteGuards.has(p.episodeId)) return;
    if (transcribeState.episodeId !== p.episodeId) {
      transcribeState.episodeId = p.episodeId;
      transcribeState.lastText = '';
    }
    transcribeState.status = 'running';
    transcribeState.phase = p.phase || '';
    if (typeof p.processedSec === 'number') {
      transcribeState.processedSec = p.processedSec;
    }
    if (typeof p.totalSec === 'number' && p.totalSec) {
      transcribeState.totalSec = p.totalSec;
    }
    if (typeof p.segCount === 'number') transcribeState.segCount = p.segCount;
  });

  ipcRenderer.on('asr:segment', (_e, p) => {
    if (!p || !p.episodeId || !p.seg) return;
    if (transcriptDeleteGuards.has(p.episodeId)) return;
    if (transcribeState.episodeId === p.episodeId) {
      transcribeState.lastText = p.seg.text || '';
    }
  });

  ipcRenderer.on('asr:done', async (_e, p) => {
    if (!p || !p.episodeId) return;
    if (transcriptDeleteGuards.has(p.episodeId)) return;
    if (transcribeState.episodeId === p.episodeId) {
      transcribeState.status = 'done';
      transcribeState.phase = '';
    }
    try {
      await saveTranscript(p.episodeId, {
        status: 'done',
        model: p.model || '',
        segPath: p.segPath || '',
        txtPath: p.txtPath || '',
        segCount: p.segCount || 0,
        durationMs: p.durationMs || 0,
        error: '',
      });
    } catch (e) {
      /* ignore */
    }
    if (transcriptDeleteGuards.has(p.episodeId)) {
      await db.transcripts.delete(p.episodeId).catch(() => {});
      return;
    }
    store.dispatch('showToast', '文字稿生成完成');
  });

  ipcRenderer.on('asr:error', async (_e, p) => {
    if (!p || !p.episodeId) return;
    if (transcriptDeleteGuards.has(p.episodeId)) return;
    const err = (p && p.error) || '';
    if (transcribeState.episodeId === p.episodeId) {
      transcribeState.status = err === 'model-missing' ? 'idle' : 'error';
      transcribeState.error = err;
    }
    if (err === 'model-missing') {
      try {
        await deleteTranscript(p.episodeId);
      } catch (e) {
        /* ignore */
      }
      return;
    }
    try {
      await updateTranscript(p.episodeId, { status: 'error', error: err });
    } catch (e) {
      /* ignore */
    }
    if (transcriptDeleteGuards.has(p.episodeId)) {
      await db.transcripts.delete(p.episodeId).catch(() => {});
      return;
    }
    store.dispatch('showToast', '生成文字稿失败：' + err);
  });

  ipcRenderer.on('asr:canceled', async (_e, p) => {
    if (!p || !p.episodeId) return;
    if (transcriptDeleteGuards.has(p.episodeId)) return;
    if (transcribeState.episodeId === p.episodeId) {
      transcribeState.status = 'canceled';
    }
    // 标记为可续（paused）：保留已转段，下次「继续转录」从断点续。
    try {
      const existing = await getTranscript(p.episodeId);
      if (transcriptDeleteGuards.has(p.episodeId)) return;
      await saveTranscript(p.episodeId, {
        status: 'paused',
        model: (existing && existing.model) || '',
        segPath: (existing && existing.segPath) || '',
        txtPath: (existing && existing.txtPath) || '',
        segCount:
          transcribeState.segCount || (existing && existing.segCount) || 0,
        durationMs: (existing && existing.durationMs) || 0,
        error: '',
      });
      if (transcriptDeleteGuards.has(p.episodeId)) {
        await db.transcripts.delete(p.episodeId).catch(() => {});
      }
    } catch (e) {
      /* ignore */
    }
  });
}

// ---------- [B 路·AI 精修] 第三层：调 DeepSeek 段内词汇纠错(可选/默认关/自带key)，按段存可回退 ----------
export const aiRefineState = Vue.observable({
  episodeId: '',
  status: 'idle', // idle | running | done | error
  done: 0,
  total: 0,
  accepted: 0,
  rejected: 0,
  error: '',
});
let _aiCancel = '';

// 总结任务与精修任务彼此独立。总结不会在转写完成、页面打开或播放时自动启动。
export const transcriptSummaryState = Vue.observable({
  episodeId: '',
  status: 'idle', // idle | running | done | error | canceled
  done: 0,
  total: 0,
  error: '',
});
const summaryJobs = new Map();
const summaryStarts = new Map();

export function getAiRefine(episodeId) {
  return db.transcriptAi.get(episodeId);
}
export function deleteAiRefine(episodeId) {
  return db.transcriptAi.delete(episodeId).catch(() => {});
}
export function getTranscriptSummary(episodeId) {
  return db.transcriptSummaries.get(episodeId);
}
export function deleteTranscriptSummary(episodeId) {
  return db.transcriptSummaries.delete(episodeId).catch(() => {});
}
export function cancelAiRefine(episodeId) {
  _aiCancel = episodeId || aiRefineState.episodeId;
}

export function getAiServiceConfig() {
  const s = (store.state && store.state.settings) || {};
  return {
    key: String(s.deepseekKey || '').trim(),
    model: String(s.deepseekModel || '').trim() || 'deepseek-chat',
    endpoint:
      String(s.deepseekEndpoint || '').trim() || 'https://api.deepseek.com',
  };
}
export function hasAiKey() {
  return hasOpenAiKey(getAiServiceConfig());
}
export const aiPromptVersion = AI_PROMPT_VERSION;

// 编排：speechSegs=[{idx,text}](idx=viewSegments 下标，仅 speech 段)，anchors=该集 anchor 专名表。
//   读旧缓存(同 promptVer)续跑 → refineEpisode → 存 Dexie → 驱动 aiRefineState。失败优雅降级。
export async function startAiRefine(
  episodeId,
  podcastId,
  speechSegs,
  anchors,
  baseSegCount
) {
  const cfg = getAiServiceConfig();
  if (!hasOpenAiKey(cfg)) {
    store.dispatch('showToast', '请先在设置里填入 DeepSeek API Key');
    return { ok: false, reason: 'no-key' };
  }
  _aiCancel = '';
  aiRefineState.episodeId = episodeId;
  aiRefineState.status = 'running';
  aiRefineState.done = 0;
  aiRefineState.total = speechSegs.length;
  aiRefineState.accepted = 0;
  aiRefineState.rejected = 0;
  aiRefineState.error = '';
  let existing = {};
  try {
    const row = await getAiRefine(episodeId);
    if (row && row.promptVer === AI_PROMPT_VERSION && row.segs)
      existing = row.segs;
  } catch (e) {
    /* ignore */
  }
  let res;
  try {
    res = await refineEpisode(
      speechSegs,
      anchors,
      cfg,
      done => {
        aiRefineState.done = done;
      },
      () => _aiCancel === episodeId,
      existing
    );
  } catch (e) {
    aiRefineState.status = 'error';
    aiRefineState.error = String((e && e.message) || e);
    store.dispatch('showToast', 'AI 精修失败：' + aiRefineState.error);
    return { ok: false, error: aiRefineState.error };
  }
  try {
    await db.transcriptAi.put({
      id: episodeId,
      podcastId: podcastId,
      promptVer: AI_PROMPT_VERSION,
      segCount: baseSegCount || 0, // 基于的总段数；段数变(续转)即弃旧缓存防下标错位
      segs: res.map,
      changedIdx: res.changedIdx,
      stats: res.stats,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  } catch (e) {
    /* ignore */
  }
  const canceled = _aiCancel === episodeId;
  aiRefineState.accepted = res.stats.accepted;
  aiRefineState.rejected = res.stats.rejected;
  aiRefineState.status = canceled ? 'idle' : 'done';
  if (!canceled) {
    store.dispatch(
      'showToast',
      'AI 精修完成：纠正 ' +
        res.stats.accepted +
        ' 处' +
        (res.stats.rejected
          ? '（保守挡下 ' + res.stats.rejected + ' 处瞎改）'
          : '')
    );
  }
  return { ok: true, changedIdx: res.changedIdx, segs: res.map, canceled };
}

function summaryErrorMessage(error) {
  const code = error && error.code;
  if (code === 'timeout') return 'AI 服务请求超时，请稍后重试';
  if (code === 'canceled') return '已取消本集总结';
  if (code === 'invalid-json' || code === 'invalid-summary') {
    return 'AI 服务返回的数据无法识别，请重试';
  }
  if (code === 'invalid-endpoint') return 'AI 服务地址无效';
  if (code === 'network') return 'AI 服务连接失败，请检查网络或服务配置';
  if (code === 'http') return 'AI 服务请求失败，请稍后重试';
  return '生成本集总结失败，请稍后重试';
}

export function cancelTranscriptSummary(episodeId) {
  const id = episodeId || transcriptSummaryState.episodeId;
  const job = summaryJobs.get(id) || summaryStarts.get(id);
  if (!job) return;
  job.canceled = true;
  if (job.controller && job.controller.abort) job.controller.abort();
  if (transcriptSummaryState.episodeId === id) {
    transcriptSummaryState.status = 'canceled';
    transcriptSummaryState.error = '';
  }
}

// `segments` must already be the effective source chosen by the caller:
// valid AI-refined text first, otherwise rule-processed proofread text.
// This function never reads audio, starts ASR, or queues a download.
export async function startTranscriptSummary(
  episodeId,
  podcastId,
  segments,
  options
) {
  const opts = options || {};
  const paragraphs = buildSummaryParagraphs(segments);
  if (!paragraphs.length) {
    return { ok: false, reason: 'no-transcript' };
  }
  const sourceHash = hashTranscriptSummarySource(paragraphs);
  const cfg = getAiServiceConfig();
  if (!hasOpenAiKey(cfg)) {
    store.dispatch('showToast', '请先在设置中配置联网 AI 服务');
    return { ok: false, reason: 'no-key' };
  }
  const existingJob =
    summaryJobs.get(episodeId) || summaryStarts.get(episodeId);
  if (existingJob) return existingJob.promise;
  const start = { canceled: false, promise: null };
  summaryStarts.set(episodeId, start);
  start.promise = (async () => {
    let existing = null;
    try {
      existing = await getTranscriptSummary(episodeId);
    } catch (e) {
      existing = null;
    }
    if (start.canceled) return { ok: false, canceled: true };
    if (
      !opts.force &&
      existing &&
      existing.sourceHash === sourceHash &&
      existing.promptVersion === TRANSCRIPT_SUMMARY_PROMPT_VERSION &&
      existing.summary
    ) {
      transcriptSummaryState.episodeId = episodeId;
      transcriptSummaryState.status = 'done';
      transcriptSummaryState.done = 1;
      transcriptSummaryState.total = 1;
      transcriptSummaryState.error = '';
      return { ok: true, cached: true, row: existing };
    }

    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const job = {
      canceled: start.canceled,
      controller: controller,
      promise: null,
    };
    if (job.canceled) return { ok: false, canceled: true };
    transcriptSummaryState.episodeId = episodeId;
    transcriptSummaryState.status = 'running';
    transcriptSummaryState.done = 0;
    transcriptSummaryState.total = 0;
    transcriptSummaryState.error = '';
    summaryJobs.set(episodeId, job);

    job.promise = (async () => {
      try {
        const result = await generateTranscriptSummary({
          cfg,
          segments,
          signal: controller && controller.signal,
          isCanceled: () => job.canceled,
          onProgress: (done, total) => {
            if (summaryJobs.get(episodeId) !== job || job.canceled) return;
            if (transcriptSummaryState.episodeId === episodeId) {
              transcriptSummaryState.done = done;
              transcriptSummaryState.total = total;
            }
          },
        });
        if (job.canceled || summaryJobs.get(episodeId) !== job) {
          return { ok: false, canceled: true };
        }
        const now = Date.now();
        const row = {
          id: episodeId,
          podcastId,
          summary: result.summary,
          sourceHash: result.sourceHash,
          sourceKind: opts.sourceKind || 'proofread',
          promptVersion: result.promptVersion,
          provider: result.provider,
          model: result.model,
          usage: result.usage,
          chunkCount: result.chunkCount,
          createdAt: (existing && existing.createdAt) || now,
          updatedAt: now,
        };
        await db.transcriptSummaries.put(row);
        // IndexedDB may finish after a user pressed cancel. Preserve a prior
        // ready summary rather than exposing the late result as current.
        if (job.canceled || summaryJobs.get(episodeId) !== job) {
          if (existing) await db.transcriptSummaries.put(existing);
          else await db.transcriptSummaries.delete(episodeId);
          return { ok: false, canceled: true };
        }
        if (transcriptSummaryState.episodeId === episodeId) {
          transcriptSummaryState.status = 'done';
          transcriptSummaryState.done = transcriptSummaryState.total || 1;
          transcriptSummaryState.error = '';
        }
        store.dispatch('showToast', '本集总结已生成');
        return { ok: true, row };
      } catch (e) {
        const canceled = job.canceled || (e && e.code === 'canceled');
        if (transcriptSummaryState.episodeId === episodeId) {
          transcriptSummaryState.status = canceled ? 'canceled' : 'error';
          transcriptSummaryState.error = canceled ? '' : summaryErrorMessage(e);
        }
        if (!canceled) store.dispatch('showToast', summaryErrorMessage(e));
        return {
          ok: false,
          canceled,
          error: canceled ? '' : summaryErrorMessage(e),
        };
      } finally {
        if (summaryJobs.get(episodeId) === job) summaryJobs.delete(episodeId);
      }
    })();
    return job.promise;
  })();
  try {
    return await start.promise;
  } finally {
    if (summaryStarts.get(episodeId) === start) summaryStarts.delete(episodeId);
  }
}
