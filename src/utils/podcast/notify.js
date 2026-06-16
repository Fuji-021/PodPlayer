// [T3] 渲染端桌面通知帮助函数。fire-and-forget，非 Electron 环境静默 no-op。
var _ipc = null;
try {
  if (process.env.IS_ELECTRON === true && window.require) {
    _ipc = window.require('electron').ipcRenderer;
  }
} catch (e) {
  /* ignore */
}

export function showNotification(title, body) {
  if (!_ipc) return;
  try {
    _ipc.send('notify:show', {
      title: String(title || ''),
      body: String(body || ''),
    });
  } catch (e) {
    /* ignore */
  }
}
