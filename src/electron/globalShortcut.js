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

  globalShortcut.register(
    shortcuts.find(s => s.id === 'play').globalShortcut,
    () => {
      win.webContents.send('play');
    }
  );
  globalShortcut.register(
    shortcuts.find(s => s.id === 'next').globalShortcut,
    () => {
      win.webContents.send('next');
    }
  );
  globalShortcut.register(
    shortcuts.find(s => s.id === 'previous').globalShortcut,
    () => {
      win.webContents.send('previous');
    }
  );
  globalShortcut.register(
    shortcuts.find(s => s.id === 'increaseVolume').globalShortcut,
    () => {
      win.webContents.send('increaseVolume');
    }
  );
  globalShortcut.register(
    shortcuts.find(s => s.id === 'decreaseVolume').globalShortcut,
    () => {
      win.webContents.send('decreaseVolume');
    }
  );
  globalShortcut.register(
    shortcuts.find(s => s.id === 'like').globalShortcut,
    () => {
      win.webContents.send('like');
    }
  );
  globalShortcut.register(
    shortcuts.find(s => s.id === 'minimize').globalShortcut,
    () => {
      // [修] 原 win.show() 不还原/不聚焦 → 隐藏后再按"显示没效果"。补 restore + focus 置前。
      if (win.isVisible()) {
        win.hide();
      } else {
        win.show();
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    }
  );

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
}
