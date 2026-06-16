// [T4·播客改造] Windows 任务栏缩略图三键（快退 15 秒 / 播放·暂停 / 快进 30 秒）
//
// Electron win.setThumbarButtons() — Windows 独有；其余平台直接 return。
// 点击动作复用已有 IPC 通道：
//   'previous' → ipcRenderer.js → seek -15s
//   'play'     → ipcRenderer.js → playOrPause()
//   'next'     → ipcRenderer.js → seek +30s
// 图标复用托盘已有 PNG（left / play / pause / right）。
// electron/ 目录禁用可选链 ?. / ??，全部用 && 守卫。

/* global __static */
import path from 'path';
import { nativeImage } from 'electron';
import { isWindows } from '@/utils/platform';

function _makeIcon(name) {
  return nativeImage.createFromPath(path.join(__static, 'img/icons/' + name));
}

export function createThumbar(win, eventEmitter) {
  if (!isWindows) return;

  var _playing = false;

  function _set(playing) {
    if (!win || win.isDestroyed()) return;
    try {
      win.setThumbarButtons([
        {
          tooltip: '快退 15 秒',
          icon: _makeIcon('left.png'),
          click: function () {
            if (win && !win.isDestroyed()) win.webContents.send('previous');
          },
        },
        {
          tooltip: playing ? '暂停' : '播放',
          icon: _makeIcon(playing ? 'pause.png' : 'play.png'),
          click: function () {
            if (win && !win.isDestroyed()) win.webContents.send('play');
          },
        },
        {
          tooltip: '快进 30 秒',
          icon: _makeIcon('right.png'),
          click: function () {
            if (win && !win.isDestroyed()) win.webContents.send('next');
          },
        },
      ]);
    } catch (e) {
      // setThumbarButtons 在某些窗口状态下可能失败（最小化/未激活），静默忽略
    }
  }

  // 窗口就绪后初始化（过早调用会被系统忽略）
  win.once('ready-to-show', function () {
    _set(_playing);
  });
  // 兜底：若 ready-to-show 已触发（重复调用 createThumbar 的场景），立即设置
  _set(_playing);

  if (eventEmitter && typeof eventEmitter.on === 'function') {
    eventEmitter.on('updatePlayState', function (playing) {
      _playing = playing;
      _set(_playing);
    });
  }
}
