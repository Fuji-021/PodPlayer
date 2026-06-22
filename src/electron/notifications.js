// [T3] 主进程桌面通知 IPC 桥。
//   渲染端 ipcRenderer.send('notify:show', {title, body}) → Electron Notification。
//   本文件在 src/electron/ 主进程域，按项目约束不使用可选链 ?. / 空值合并 ??。
import { Notification, ipcMain } from 'electron';

export function initNotifications(getWindow) {
  ipcMain.on('notify:show', function (_e, opts) {
    if (!opts || !opts.title) return;
    try {
      var n = new Notification({
        title: String(opts.title),
        body: String(opts.body || ''),
      });
      // [通知点击跳转] 点击系统通知 → 激活主窗口(还原+前置+聚焦)，与大部分 Windows 软件一致。
      n.on('click', function () {
        var w = getWindow && getWindow();
        if (w && !w.isDestroyed()) {
          if (w.isMinimized()) w.restore();
          w.show();
          w.focus();
        }
      });
      n.show();
    } catch (e) {
      // 系统关闭通知权限 / API 不可用时静默
    }
  });
}
