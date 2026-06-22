import defaultShortcuts from '@/utils/shortcuts';
const { globalShortcut } = require('electron');

const clc = require('cli-color');
const log = text => {
  console.log(`${clc.blueBright('[globalShortcut.js]')} ${text}`);
};

export function registerGlobalShortcut(win, store) {
  log('registerGlobalShortcut');
  let shortcuts = store.get('settings.shortcuts');
  if (shortcuts === undefined) {
    shortcuts = defaultShortcuts;
  }

  // [操作#15/#2b] 七处用户配置键改"循环注册 + 查返回值"：注册失败(被其它应用/系统占用，或录入非法
  //   组合致 register 返回 false)的键收集起来，末尾经 IPC 回报渲染端弹 toast，不再静默失灵(原先逐个
  //   register 不查返回值，用户以为生效实则被占)。仿下方媒体键组写法。禁可选链(electron/Node14)，用 && + ||。
  const userKeys = [
    ['play', () => win.webContents.send('play')],
    ['next', () => win.webContents.send('next')],
    ['previous', () => win.webContents.send('previous')],
    ['increaseVolume', () => win.webContents.send('increaseVolume')],
    ['decreaseVolume', () => win.webContents.send('decreaseVolume')],
    ['like', () => win.webContents.send('like')],
    [
      'minimize',
      () => {
        // [修] 原 win.show() 不还原/不聚焦 → 隐藏后再按"显示没效果"。补 restore + focus 置前。
        if (win.isVisible()) {
          win.hide();
        } else {
          win.show();
          if (win.isMinimized()) win.restore();
          win.focus();
        }
      },
    ],
  ];
  const failedKeys = [];
  userKeys.forEach(pair => {
    const id = pair[0];
    const handler = pair[1];
    const sc = shortcuts.find(s => s.id === id);
    const accel = sc && sc.globalShortcut;
    if (!accel) return;
    try {
      const ok = globalShortcut.register(accel, handler);
      if (!ok) {
        failedKeys.push(sc.name || accel); // 优先用友好名(如"播放/暂停")，缺失回退 accelerator
        log(`配置键 ${id} (${accel}) 注册失败(被占用/非法键)，跳过`);
      }
    } catch (e) {
      failedKeys.push(sc.name || accel); // 优先用友好名(如"播放/暂停")，缺失回退 accelerator
      log(`配置键 ${id} 注册异常：${(e && e.message) || e}`);
    }
  });

  // [审P1-5] 物理媒体键(键盘/耳机线控的 播放暂停 / 上一首 / 下一首)：与上方用户配置键**并行**
  //   注册系统级 globalShortcut → 最小化到托盘 / 失焦时也能控制(原先只有 Player.vue 页内 keydown，
  //   必须窗口聚焦才生效)。复用既有 IPC 通道(play=playOrPause 切换 / next / previous)。
  //   媒体键常被其它播放器(网易云/Spotify)或系统先占，故逐个 try/catch + 查返回值：注册失败只记
  //   日志、不影响其余键(上方 fork 原代码对配置键也无兜底，此处先把媒体键这组做稳)。
  const mediaKeys = [
    ['MediaPlayPause', 'play'],
    ['MediaNextTrack', 'next'],
    ['MediaPreviousTrack', 'previous'],
  ];
  mediaKeys.forEach(pair => {
    const accel = pair[0];
    const channel = pair[1];
    try {
      const ok = globalShortcut.register(accel, () => {
        if (win && !win.isDestroyed()) win.webContents.send(channel);
      });
      if (!ok) log(`媒体键 ${accel} 注册失败(可能被其它应用/系统占用)，跳过`);
    } catch (e) {
      log(`媒体键 ${accel} 注册异常：${e && e.message}`);
    }
  });

  // [操作#15/#2b] 配置键有注册失败 → 回报渲染端弹 toast(改键时即时反馈；启动首次渲染端若未就绪则跳过、无害)
  if (failedKeys.length && win && !win.isDestroyed()) {
    win.webContents.send('globalShortcutRegisterFailed', failedKeys);
  }
}
