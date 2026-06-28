// [转文字稿] 渲染端封装：Dexie 索引 DAO + IPC 命令/事件 + 活动任务实时态。
//   仿 utils/podcast/downloads.js 的惯例（window.require('electron').ipcRenderer、
//   registerXListeners() 一次、invoke 发命令、on 收事件、store.dispatch('showToast')）。
//   只负责"触发转录 + 维护状态/索引"，引擎在主进程子进程里，渲染端不碰。
import Vue from 'vue';
import { db } from '@/utils/db';
import store from '@/store';
import { getDownload } from '@/utils/podcast/downloads';

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
  try {
    if (ipcRenderer) await ipcRenderer.invoke('asr:delete', { episodeId });
  } catch (e) {
    /* ignore */
  }
  try {
    await db.transcripts.delete(episodeId);
  } catch (e) {
    /* ignore */
  }
  return { ok: true };
}

// ---------- 专名替换词典 DAO（节目级 + 全局） ----------
function dictId(scope, podcastId, from) {
  return (
    scope + ':' + (scope === 'podcast' ? podcastId || '' : '') + ':' + from
  );
}

// 列出某节目可见的词条（全局 + 该节目级），带 id/scope，供管理/删除
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
      if (r && r.from) map[r.id] = r;
    });
    return Object.keys(map).map(k => map[k]);
  } catch (e) {
    return [];
  }
}

// 取替换器输入：[{from,to}]（供 transcriptPostprocess.buildReplacer）
export async function getDictFor(podcastId) {
  const rows = await listDict(podcastId);
  return rows.map(r => ({ from: r.from, to: r.to }));
}

// 新增/更新一条词条。opts: { scope:'podcast'|'global', podcastId, from, to }
export async function addDictEntry(opts) {
  opts = opts || {};
  const scope = opts.scope === 'global' ? 'global' : 'podcast';
  const from = String(opts.from || '').trim();
  const to = String(opts.to || '').trim();
  if (!from || !to || from === to) {
    return { ok: false, error: '错词/正词为空或相同' };
  }
  const podcastId = scope === 'podcast' ? opts.podcastId || '' : '';
  if (scope === 'podcast' && !podcastId) {
    return { ok: false, error: '缺少节目标识' };
  }
  const id = dictId(scope, podcastId, from);
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
  resetLive(episode.id, episode.duration || 0);
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
    if (transcribeState.episodeId === p.episodeId) {
      transcribeState.lastText = p.seg.text || '';
    }
  });

  ipcRenderer.on('asr:done', async (_e, p) => {
    if (!p || !p.episodeId) return;
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
    store.dispatch('showToast', '文字稿生成完成');
  });

  ipcRenderer.on('asr:error', async (_e, p) => {
    if (!p || !p.episodeId) return;
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
    store.dispatch('showToast', '生成文字稿失败：' + err);
  });

  ipcRenderer.on('asr:canceled', async (_e, p) => {
    if (!p || !p.episodeId) return;
    if (transcribeState.episodeId === p.episodeId) {
      transcribeState.status = 'canceled';
    }
    // 标记为可续（paused）：保留已转段，下次「继续转录」从断点续。
    try {
      const existing = await getTranscript(p.episodeId);
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
    } catch (e) {
      /* ignore */
    }
  });
}
