import { app, dialog, globalShortcut, ipcMain } from 'electron';
import UNM from '@unblockneteasemusic/rust-napi';
import { registerGlobalShortcut } from '@/electron/globalShortcut';
import cloneDeep from 'lodash/cloneDeep';
import shortcuts from '@/utils/shortcuts';
import { createMenu } from './menu';
import { isCreateTray, isMac } from '@/utils/platform';

const clc = require('cli-color');
const log = text => {
  console.log(`${clc.blueBright('[ipcMain.js]')} ${text}`);
};

// [审P1-4] 优雅退出协调：真正 app.exit() 前先让渲染端把 in-flight Dexie 写(收听缓冲/播放进度)
//   flush 落盘 + db.close()，await 一个带超时的 ack(≤800ms 没回也强制退，绝不卡死退出)。只在
//   "真退出"路径用；minimizeToTray 不走这里(它不是退出，不该 flush)。win 已 destroy / 渲染端已挂
//   则直接退。electron/ 禁可选链，全用 && 守卫。根治：app.exit() 立即硬杀渲染进程 → 在途 IndexedDB
//   事务(逐秒进度、收听批写)半途夭折 → 库损坏/丢统计(审P1-4)。
let _gracefulExiting = false;
function gracefulExit(win) {
  const hardExit = () => {
    try {
      app.exit(); //exit()直接关闭客户端，不会执行quit();
    } catch (e) {
      /* ignore */
    }
  };
  if (_gracefulExiting) return; // 防重入(连点"退出")
  _gracefulExiting = true;
  if (
    !win ||
    win.isDestroyed() ||
    !win.webContents ||
    win.webContents.isDestroyed()
  ) {
    return hardExit();
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    ipcMain.removeAllListeners('app:flush-done');
    hardExit();
  };
  ipcMain.once('app:flush-done', finish);
  setTimeout(finish, 800); // [超时兜底] 渲染端卡住也最多等 800ms 必退
  try {
    win.webContents.send('app:before-exit-flush');
  } catch (e) {
    finish(); // 发送失败(渲染已挂)→ 立即退
  }
}

const exitAsk = (e, win) => {
  e.preventDefault(); //阻止默认行为
  dialog
    .showMessageBox({
      type: 'info',
      title: 'Information',
      cancelId: 2,
      defaultId: 0,
      message: '确定要关闭吗？',
      buttons: ['最小化', '直接退出'],
    })
    .then(result => {
      if (result.response == 0) {
        e.preventDefault(); //阻止默认行为
        win.minimize(); //调用 最小化实例方法
      } else if (result.response == 1) {
        // [审P1-4] 优雅退出：先让渲染端 flush 收听/进度并关库，再 app.exit()(带 800ms 超时兜底)
        gracefulExit(win);
      }
    })
    .catch(err => {
      log(err);
    });
};

const exitAskWithoutMac = (e, win) => {
  e.preventDefault(); //阻止默认行为
  dialog
    .showMessageBox({
      type: 'info',
      title: 'Information',
      cancelId: 2,
      defaultId: 0,
      message: '确定要关闭吗？',
      buttons: ['最小化到托盘', '直接退出'],
      checkboxLabel: '记住我的选择',
    })
    .then(result => {
      if (result.checkboxChecked && result.response !== 2) {
        win.webContents.send(
          'rememberCloseAppOption',
          result.response === 0 ? 'minimizeToTray' : 'exit'
        );
      }

      if (result.response === 0) {
        e.preventDefault(); //阻止默认行为
        win.hide(); //调用 最小化实例方法
      } else if (result.response === 1) {
        // [审P1-4] 优雅退出：先让渲染端 flush 收听/进度并关库，再 app.exit()(带 800ms 超时兜底)
        gracefulExit(win);
      }
    })
    .catch(err => {
      log(err);
    });
};

// [启动噪声·2026-06-16] Discord 没开时 discord-rich-presence 连不上，会在内部 EventEmitter 上
//   emit('error')；无 'error' 监听 → Node 抛 "Unhandled 'error' event" → 每次启动一条
//   unhandledRejection(已被审P1-1 主进程兜底成一条 log，但仍是噪声)。挂个静默 'error' 监听吃掉;
//   创建本身也 try/catch 兜底(失败时 client=null，下方两个 presence 调用走守卫 no-op)。
let client = null;
try {
  client = require('discord-rich-presence')('818936529484906596');
  if (client && typeof client.on === 'function') {
    client.on('error', () => {});
  }
} catch (e) {
  log('[discord] rich-presence 初始化失败(忽略)：' + (e && e.message));
}

/**
 * Make data a Buffer.
 *
 * @param {?} data The data to convert.
 * @returns {import("buffer").Buffer} The converted data.
 */
function toBuffer(data) {
  if (data instanceof Buffer) {
    return data;
  } else {
    return Buffer.from(data);
  }
}

/**
 * Get the file base64 data from bilivideo.
 *
 * @param {string} url The URL to fetch.
 * @returns {Promise<string>} The file base64 data.
 */
async function getBiliVideoFile(url) {
  const axios = await import('axios').then(m => m.default);
  const response = await axios.get(url, {
    headers: {
      Referer: 'https://www.bilibili.com/',
      'User-Agent': 'okhttp/3.4.1',
    },
    responseType: 'arraybuffer',
  });

  const buffer = toBuffer(response.data);
  const encodedData = buffer.toString('base64');

  return encodedData;
}

/**
 * Parse the source string (`a, b`) to source list `['a', 'b']`.
 *
 * @param {import("@unblockneteasemusic/rust-napi").Executor} executor
 * @param {string} sourceString The source string.
 * @returns {string[]} The source list.
 */
function parseSourceStringToList(executor, sourceString) {
  const availableSource = executor.list();

  return sourceString
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => {
      const isAvailable = availableSource.includes(s);

      if (!isAvailable) {
        log(`This source is not one of the supported source: ${s}`);
      }

      return isAvailable;
    });
}

export function initIpcMain(win, store, trayEventEmitter) {
  // WIP: Do not enable logging as it has some issues in non-blocking I/O environment.
  // UNM.enableLogging(UNM.LoggingType.ConsoleEnv);
  const unmExecutor = new UNM.Executor();

  ipcMain.handle(
    'unblock-music',
    /**
     *
     * @param {*} _
     * @param {string | null} sourceListString
     * @param {Record<string, any>} ncmTrack
     * @param {UNM.Context} context
     */
    async (_, sourceListString, ncmTrack, context) => {
      // Formt the track input
      // FIXME: Figure out the structure of Track
      const song = {
        id: ncmTrack.id && ncmTrack.id.toString(),
        name: ncmTrack.name,
        duration: ncmTrack.dt,
        album: ncmTrack.al && {
          id: ncmTrack.al.id && ncmTrack.al.id.toString(),
          name: ncmTrack.al.name,
        },
        artists: ncmTrack.ar
          ? ncmTrack.ar.map(({ id, name }) => ({
              id: id && id.toString(),
              name,
            }))
          : [],
      };

      const sourceList =
        typeof sourceListString === 'string'
          ? parseSourceStringToList(unmExecutor, sourceListString)
          : ['ytdl', 'bilibili', 'pyncm', 'kugou'];
      log(`[UNM] using source: ${sourceList.join(', ')}`);
      log(`[UNM] using configuration: ${JSON.stringify(context)}`);

      try {
        // TODO: tell users to install yt-dlp.
        const matchedAudio = await unmExecutor.search(
          sourceList,
          song,
          context
        );
        const retrievedSong = await unmExecutor.retrieve(matchedAudio, context);

        // bilibili's audio file needs some special treatment
        if (retrievedSong.url.includes('bilivideo.com')) {
          retrievedSong.url = await getBiliVideoFile(retrievedSong.url);
        }

        log(`respond with retrieve song…`);
        log(JSON.stringify(matchedAudio));
        return retrievedSong;
      } catch (err) {
        const errorMessage = err instanceof Error ? `${err.message}` : `${err}`;
        log(`UnblockNeteaseMusic failed: ${errorMessage}`);
        return null;
      }
    }
  );

  ipcMain.on('close', e => {
    if (isMac) {
      win.hide();
      exitAsk(e, win);
    } else {
      let closeOpt = store.get('settings.closeAppOption');
      if (closeOpt === 'exit') {
        // [审P1-4] 优雅退出：先让渲染端 flush 收听/进度并关库，再 app.exit()(带 800ms 超时兜底)
        gracefulExit(win);
      } else if (closeOpt === 'minimizeToTray') {
        e.preventDefault();
        win.hide();
      } else {
        exitAskWithoutMac(e, win);
      }
    }
  });

  ipcMain.on('minimize', () => {
    win.minimize();
  });

  ipcMain.on('maximizeOrUnmaximize', () => {
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });

  // [沉浸式播放页 P1] 进入沉浸 → 最大化；退出 → 按进入前状态决定是否 unmaximize
  ipcMain.handle('imm:enter', () => {
    const wasMax = win.isMaximized();
    if (!wasMax) win.maximize();
    return { wasMax };
  });

  ipcMain.on('imm:exit', (_event, wasMax) => {
    if (!wasMax) win.unmaximize();
  });

  ipcMain.on('settings', (event, options) => {
    store.set('settings', options);
    if (options.enableGlobalShortcut) {
      registerGlobalShortcut(win, store);
    } else {
      log('unregister global shortcut');
      globalShortcut.unregisterAll();
    }
  });

  ipcMain.on('playDiscordPresence', (event, track) => {
    if (!client) return; // [启动噪声] client 初始化失败时 no-op
    client.updatePresence({
      details: track.name + ' - ' + track.ar.map(ar => ar.name).join(','),
      state: track.al.name,
      endTimestamp: Date.now() + track.dt,
      largeImageKey: track.al.picUrl,
      largeImageText: 'Listening ' + track.name,
      smallImageKey: 'play',
      smallImageText: 'Playing',
      instance: true,
    });
  });

  ipcMain.on('pauseDiscordPresence', (event, track) => {
    if (!client) return; // [启动噪声] client 初始化失败时 no-op
    client.updatePresence({
      details: track.name + ' - ' + track.ar.map(ar => ar.name).join(','),
      state: track.al.name,
      largeImageKey: track.al.picUrl,
      largeImageText: 'PodPlayer',
      smallImageKey: 'pause',
      smallImageText: 'Pause',
      instance: true,
    });
  });

  ipcMain.on('setProxy', (event, config) => {
    const proxyRules = `${config.protocol}://${config.server}:${config.port}`;
    store.set('proxy', proxyRules);
    win.webContents.session.setProxy(
      {
        proxyRules,
      },
      () => {
        log('finished setProxy');
      }
    );
  });

  ipcMain.on('removeProxy', () => {
    log('removeProxy');
    win.webContents.session.setProxy({});
    store.set('proxy', '');
  });

  ipcMain.on('switchGlobalShortcutStatusTemporary', (e, status) => {
    log('switchGlobalShortcutStatusTemporary');
    if (status === 'disable') {
      globalShortcut.unregisterAll();
    } else {
      registerGlobalShortcut(win, store);
    }
  });

  ipcMain.on('updateShortcut', (e, { id, type, shortcut }) => {
    log('updateShortcut');
    let shortcuts = store.get('settings.shortcuts');
    let newShortcut = shortcuts.find(s => s.id === id);
    newShortcut[type] = shortcut;
    store.set('settings.shortcuts', shortcuts);

    createMenu(win, store);
    globalShortcut.unregisterAll();
    // [快捷键修 A] 尊重全局开关：用户关掉全局快捷键后，改键不应又把全局键注册回来抢系统热键。
    if (store.get('settings.enableGlobalShortcut') !== false) {
      registerGlobalShortcut(win, store);
    }
  });

  ipcMain.on('restoreDefaultShortcuts', () => {
    log('restoreDefaultShortcuts');
    store.set('settings.shortcuts', cloneDeep(shortcuts));

    createMenu(win, store);
    globalShortcut.unregisterAll();
    // [快捷键修 A] 同上：恢复默认也尊重全局开关，不强行重注册。
    if (store.get('settings.enableGlobalShortcut') !== false) {
      registerGlobalShortcut(win, store);
    }
  });

  if (isCreateTray) {
    ipcMain.on('updateTrayTooltip', (_, title) => {
      trayEventEmitter.emit('updateTooltip', title);
    });
    ipcMain.on('updateTrayPlayState', (_, isPlaying) => {
      trayEventEmitter.emit('updatePlayState', isPlaying);
    });
    ipcMain.on('updateTrayLikeState', (_, isLiked) => {
      trayEventEmitter.emit('updateLikeState', isLiked);
    });
    ipcMain.on('updateTrayIcon', () => {
      trayEventEmitter.emit('updateIcon');
    });
  }
}
