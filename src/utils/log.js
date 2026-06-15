// [日志] 渲染端日志工具：rlog.info/warn/error 同时打 console + 经 IPC('app:log') 送主进程落同一
//   文件(见 electron/logger.js)。并兜底渲染端全局错误(window.error / unhandledrejection)。
//   纯 web 构建(无 ipcRenderer)时只走 console、不报错。utils/ 目录可用可选链。
const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer =
  electron && electron.ipcRenderer ? electron.ipcRenderer : null;

// 把任意参数转成可写进日志的安全字符串(Error→栈、对象→JSON、其余原样)
function safe(a) {
  if (a instanceof Error) return a.stack || a.message || String(a);
  if (a !== null && typeof a === 'object') {
    try {
      return JSON.stringify(a);
    } catch (e) {
      return String(a);
    }
  }
  return a;
}

function send(level, args) {
  if (!ipcRenderer) return;
  try {
    ipcRenderer.send('app:log', level, args.map(safe));
  } catch (e) {
    /* ignore：日志绝不可影响主流程 */
  }
}

export const rlog = {
  info(...a) {
    // eslint-disable-next-line no-console
    console.log(...a);
    send('info', a);
  },
  warn(...a) {
    // eslint-disable-next-line no-console
    console.warn(...a);
    send('warn', a);
  },
  error(...a) {
    // eslint-disable-next-line no-console
    console.error(...a);
    send('error', a);
  },
};

// 安装渲染端全局错误兜底 → 落文件。main.js 启动期调用一次。
export function installRendererLogging() {
  if (typeof window === 'undefined' || !window.addEventListener) return;
  window.addEventListener('error', e => {
    send('error', [
      '[window.error]',
      (e && e.message) || '',
      (e && e.filename ? e.filename : '') + ':' + (e && e.lineno),
    ]);
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e && e.reason;
    send('error', [
      '[unhandledrejection]',
      (r && r.message) || String(r),
      (r && r.stack) || '',
    ]);
  });
  send('info', [
    '[renderer] start',
    (typeof location !== 'undefined' && location.href) || '',
  ]);
}

// 设置页「打开日志文件夹」按钮调用：让主进程在文件管理器里定位日志文件。
export async function openLogs() {
  if (!ipcRenderer) return { ok: false };
  try {
    return await ipcRenderer.invoke('app:openLogs');
  } catch (e) {
    return { ok: false };
  }
}
