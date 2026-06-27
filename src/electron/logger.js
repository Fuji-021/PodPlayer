// [日志] 主进程日志中枢：用 electron-log 把日志写到文件(userData\logs\main.log，自动 5MB 轮转)，
//   并接住：① 渲染端经 IPC 送来的日志(见 utils/log.js)；② 主进程未捕获异常/拒绝。
//   开发者/支持可直接看文件、也便于据日志回溯用户操作。文件路径在设置页「打开日志文件夹」一键打开。
//   注：本文件在 src/electron/ 主进程域，按项目约定**不使用可选链 ?. / 空值合并 ??**。
import log from 'electron-log';
import { ipcMain, shell, app } from 'electron';

let _inited = false;

export function initMainLogger() {
  if (_inited) return;
  _inited = true;
  try {
    // 显式锁定日志路径到当前 profile 的 userData(本函数须在 app.setName/setPath 之后调用)，
    //   否则 electron-log 会用默认 app 名(yesplaymusic)把日志写错目录。
    log.transports.file.resolvePath = () =>
      require('path').join(app.getPath('userData'), 'logs', 'main.log');
  } catch (e) {
    /* ignore */
  }
  try {
    log.transports.file.level = 'info';
    log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB 轮转(超出自动归档 .old.log)
    log.transports.console.level = 'info';
  } catch (e) {
    /* ignore */
  }
  let p = '';
  try {
    p = log.transports.file.getFile().path;
  } catch (e) {
    p = '(path-pending)';
  }
  // [修] 与 background.js 同口径解析 profile：未显式设 PODPLAYER_PROFILE 时，有 WEBPACK_DEV_SERVER_URL
  //   即 dev、否则 prod。原来直接 `env || 'prod'` 会把"裸跑 yarn electron:serve(实为 dev)"误记成 prod。
  var _profile =
    process.env.PODPLAYER_PROFILE ||
    (process.env.WEBPACK_DEV_SERVER_URL ? 'dev' : 'prod');
  log.info('====== app start ====== profile=' + _profile + ' logfile=' + p);
  // 主进程未捕获异常/拒绝 → 落文件(与 background.js 既有 console 兜底并存，不退出)
  process.on('uncaughtException', err => {
    try {
      log.error('[main.uncaughtException]', (err && err.stack) || err);
    } catch (e) {
      /* ignore */
    }
  });
  process.on('unhandledRejection', reason => {
    try {
      log.error('[main.unhandledRejection]', reason);
    } catch (e) {
      /* ignore */
    }
  });
}

export function registerLogIpc() {
  // 渲染端日志 → 落同一文件(渲染端 utils/log.js 的 rlog / 全局错误监听经此发来)
  ipcMain.on('app:log', (_e, level, parts) => {
    try {
      const fn = log[level] ? log[level] : log.info;
      const arr = Array.isArray(parts) ? parts : [parts];
      fn('[renderer]', ...arr);
    } catch (e) {
      /* ignore */
    }
  });
  // 设置页「打开日志文件夹」：在文件管理器里定位日志文件
  ipcMain.handle('app:openLogs', () => {
    try {
      const p = log.transports.file.getFile().path;
      shell.showItemInFolder(p);
      return { ok: true, path: p };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('app:getLogPath', () => {
    try {
      return { path: log.transports.file.getFile().path };
    } catch (e) {
      return { path: '' };
    }
  });
}

export { log };
