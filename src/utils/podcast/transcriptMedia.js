// [转文字稿] 渲染端只查询已有永久下载的路径提示，并通过 IPC 读取/清理主进程
// 临时来源目录。它不创建下载任务、不拼装文件路径，也不登记下载记录。
import store from '@/store';
import { getDownload } from '@/utils/podcast/downloads';

const ipcRenderer = window.require
  ? window.require('electron').ipcRenderer
  : null;

export async function getPersistentTranscriptMediaHint(episodeId) {
  if (!episodeId) return '';
  try {
    const row = await getDownload(episodeId);
    if (row && row.filePath) return row.filePath;
  } catch (e) {
    // The main process validates every hint; a missing Dexie row simply falls
    // through to the transient source path.
  }
  const paths =
    (store.state.podcastDownloads && store.state.podcastDownloads.pathMap) ||
    {};
  return paths[episodeId] || '';
}

export async function getTranscriptMediaStats() {
  if (!ipcRenderer) return { ok: false, stats: null };
  try {
    return await ipcRenderer.invoke('asr:media:stats');
  } catch (e) {
    return { ok: false, stats: null };
  }
}

export async function cleanupTranscriptMedia() {
  if (!ipcRenderer) return { ok: false, stats: null };
  try {
    return await ipcRenderer.invoke('asr:media:cleanup');
  } catch (e) {
    return { ok: false, stats: null };
  }
}
