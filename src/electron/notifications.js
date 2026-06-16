// [T3] 主进程桌面通知 IPC 桥。
//   渲染端 ipcRenderer.send('notify:show', {title, body}) → Electron Notification。
//   本文件在 src/electron/ 主进程域，按项目约束不使用可选链 ?. / 空值合并 ??。
import { Notification, ipcMain } from 'electron';

export function initNotifications() {
  ipcMain.on('notify:show', function (_e, opts) {
    if (!opts || !opts.title) return;
    try {
      var n = new Notification({
        title: String(opts.title),
        body: String(opts.body || ''),
      });
      n.show();
    } catch (e) {
      // 系统关闭通知权限 / API 不可用时静默
    }
  });
}
