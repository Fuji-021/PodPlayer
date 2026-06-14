'use strict';
import {
  app,
  protocol,
  BrowserWindow,
  shell,
  dialog,
  globalShortcut,
  nativeTheme,
  screen,
} from 'electron';
import {
  isWindows,
  isMac,
  isLinux,
  isDevelopment,
  isCreateTray,
  isCreateMpris,
} from '@/utils/platform';
import { createProtocol } from 'vue-cli-plugin-electron-builder/lib';
import { startNeteaseMusicApi } from './electron/services';
import { initIpcMain } from './electron/ipcMain.js';
// [播客改造] 主进程 RSS/OPML 抓取，绕开渲染进程 CORS 限制。
import { registerPodcastIpc } from './electron/podcastFetch';
// [NAS] 主进程 NAS 音源桥 IPC（未配置时各 handler 直接返回未就绪，不激活任何网络）
import { registerNasIpc } from './electron/nasBridge';
import { registerPodcastDownloadIpc } from './electron/podcastDownload';
import { registerPodcastDiscoverIpc } from './electron/podcastDiscover';
import { createMenu } from './electron/menu';
import { createTray } from '@/electron/tray';
import { createTouchBar } from './electron/touchBar';
import { createDockMenu } from './electron/dockMenu';
import { registerGlobalShortcut } from './electron/globalShortcut';
import { autoUpdater } from 'electron-updater';
import installExtension, { VUEJS_DEVTOOLS } from 'electron-devtools-installer';
import { EventEmitter } from 'events';
import express from 'express';
import expressProxy from 'express-http-proxy';
import Store from 'electron-store';
import { createMpris, createDbus } from '@/electron/mpris';
import { spawn } from 'child_process';
const clc = require('cli-color');
const log = text => {
  console.log(`${clc.blueBright('[background.js]')} ${text}`);
};

// [审P1-1 兜底] 主进程最后一道防线：任何未捕获异常 / 未处理 Promise 拒绝只记录、不让整个 app 崩溃。
//   配合 podcastDownload.js 已给下载写入流补 'error' 监听（首要修复），这里再兜底其它意外路径
//   —— Node 默认对未捕获 'error'/rejection 会直接终止主进程，对桌面 app 是灾难。
//   只 log、不退出、不弹窗，避免打断正在进行的播放 / 下载。
process.on('uncaughtException', err => {
  console.error(
    '[background.js] uncaughtException:',
    (err && err.stack) || err
  );
});
process.on('unhandledRejection', reason => {
  console.error('[background.js] unhandledRejection:', reason);
});

// [事故根治·实例隔离] 用环境变量 PODPLAYER_PROFILE 驱动「身份 → userData → IndexedDB」
//   与端口三件套，让 正式版 / 开发版 / 测试床 各自拥有独立 app name → 独立 userData 目录
//   → 独立 LevelDB，三者可同时运行、永不抢同一个 LOCK（本次 backing store 打不开的根因）。
//   未设置时：dev-serve(有 WEBPACK_DEV_SERVER_URL)默认 dev、打包默认 prod，
//   保证裸跑 `yarn electron:serve` 时 neapi 与 .env 烘焙的 dev API 端口(10755)一致、不 ECONNREFUSED。
//   详见 docs/实例隔离规范.md。
const PODPLAYER_PROFILE =
  process.env.PODPLAYER_PROFILE ||
  (process.env.WEBPACK_DEV_SERVER_URL ? 'dev' : 'prod');
const PODPLAYER_PROFILES = {
  prod: { name: 'PodPlayer', title: 'PodPlayer', neapi: 10754, express: 27232 },
  dev: {
    name: 'PodPlayerDev',
    title: 'PodPlayer Dev',
    neapi: 10755,
    express: 27233,
  },
  sandbox: {
    name: 'PodPlayerSandbox',
    title: 'PodPlayer 测试床',
    neapi: 10756,
    express: 27234,
  },
};
const PROFILE =
  PODPLAYER_PROFILES[PODPLAYER_PROFILE] || PODPLAYER_PROFILES.prod;
log(
  `instance profile = ${PODPLAYER_PROFILE} ` +
    `(name=${PROFILE.name}, neapi=${PROFILE.neapi}, express=${PROFILE.express})`
);

const closeOnLinux = (e, win, store) => {
  let closeOpt = store.get('settings.closeAppOption');
  if (closeOpt !== 'exit') {
    e.preventDefault();
  }

  if (closeOpt === 'ask') {
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
          win.hide(); //调用 最小化实例方法
        } else if (result.response === 1) {
          win = null;
          app.exit(); //exit()直接关闭客户端，不会执行quit();
        }
      })
      .catch(err => {
        log(err);
      });
  } else if (closeOpt === 'exit') {
    win = null;
    app.quit();
  } else {
    win.hide();
  }
};

class Background {
  constructor() {
    this.window = null;
    this.ypmTrayImpl = null;
    this.store = new Store({
      windowWidth: {
        width: { type: 'number', default: 1440 },
        height: { type: 'number', default: 840 },
      },
    });
    this.neteaseMusicAPI = null;
    this.expressApp = null;
    this.willQuitApp = !isMac;

    this.init();
  }

  init() {
    log('initializing');

    // [事故根治·实例隔离] 身份由 PODPLAYER_PROFILE 决定（见文件顶部 PROFILE）。
    //   app.setName(X) 决定 userData = %APPDATA%\X\ 决定 IndexedDB 物理位置 …\X\IndexedDB\。
    //   name 唯一 → 库物理隔离 → 多实例永不抢同一 LevelDB LOCK。详见 docs/实例隔离规范.md。
    app.setName(PROFILE.name);
    app.setPath(
      'userData',
      require('path').join(app.getPath('appData'), PROFILE.name)
    );

    // Make sure the app is singleton.
    if (!app.requestSingleInstanceLock()) return app.quit();

    // start netease music api（端口随 PROFILE，避免多实例 EADDRINUSE）
    this.neteaseMusicAPI = startNeteaseMusicApi(PROFILE.neapi);
    // [事故根治] 端口被占时吞掉 promise 拒绝、不崩主进程（仅影响网易云音乐，不影响播客）。
    if (this.neteaseMusicAPI && this.neteaseMusicAPI.catch) {
      this.neteaseMusicAPI.catch(e =>
        log('netease api start failed: ' + (e && e.message))
      );
    }

    // create Express app
    this.createExpressApp();

    // Scheme must be registered before the app is ready
    protocol.registerSchemesAsPrivileged([
      { scheme: 'app', privileges: { secure: true, standard: true } },
    ]);

    // handle app events
    this.handleAppEvents();

    // disable chromium mpris
    if (isCreateMpris) {
      app.commandLine.appendSwitch(
        'disable-features',
        'HardwareMediaKeyHandling,MediaSessionService'
      );
    }
  }

  async initDevtools() {
    // Install Vue Devtools extension
    try {
      await installExtension(VUEJS_DEVTOOLS);
    } catch (e) {
      console.error('Vue Devtools failed to install:', e.toString());
    }

    // Exit cleanly on request from parent process in development mode.
    if (isWindows) {
      process.on('message', data => {
        if (data === 'graceful-exit') {
          app.quit();
        }
      });
    } else {
      process.on('SIGTERM', () => {
        app.quit();
      });
    }
  }

  createExpressApp() {
    log('creating express app');

    const expressApp = express();
    expressApp.use('/', express.static(__dirname + '/'));
    expressApp.use('/api', expressProxy('http://127.0.0.1:' + PROFILE.neapi));
    expressApp.use('/player', (req, res) => {
      this.window.webContents
        .executeJavaScript('window.yesplaymusic.player')
        .then(result => {
          res.send({
            currentTrack: result._isPersonalFM
              ? result._personalFMTrack
              : result._currentTrack,
            progress: result._progress,
          });
        });
    });
    this.expressApp = expressApp.listen(PROFILE.express, '127.0.0.1');
    // [事故根治] 端口被占(EADDRINUSE)时优雅记录，而非抛未捕获 'error' 事件崩溃整个主进程。
    this.expressApp.on('error', err => {
      log(`express listen error on :${PROFILE.express} — ${err && err.code}`);
    });
  }

  createWindow() {
    log('creating app window');

    const appearance = this.store.get('settings.appearance');
    // [B-79] PodPlayer 首屏固定为「首页(/)」，不再落「我的订阅(/library)」。
    //   原 settings.showLibraryDefault 是 YesPlayMusic(音乐播放器)默认进音乐库的设置，
    //   对播客客户端不适用、且用户 store 里已持久化成 true → 直接强制 false。
    const showLibraryDefault = false;

    const options = {
      width: this.store.get('window.width') || 1440,
      height: this.store.get('window.height') || 840,
      minWidth: 1080,
      minHeight: 720,
      titleBarStyle: 'hiddenInset',
      frame: !(
        isWindows ||
        (isLinux && this.store.get('settings.linuxEnableCustomTitlebar'))
      ),
      title: PROFILE.title,
      show: false,
      webPreferences: {
        webSecurity: false,
        nodeIntegration: true,
        enableRemoteModule: true,
        contextIsolation: false,
      },
      backgroundColor:
        ((appearance === undefined || appearance === 'auto') &&
          nativeTheme.shouldUseDarkColors) ||
        appearance === 'dark'
          ? '#222'
          : '#fff',
    };

    if (this.store.get('window.x') && this.store.get('window.y')) {
      let x = this.store.get('window.x');
      let y = this.store.get('window.y');

      let displays = screen.getAllDisplays();
      let isResetWindiw = false;
      if (displays.length === 1) {
        let { bounds } = displays[0];
        if (
          x < bounds.x ||
          x > bounds.x + bounds.width - 50 ||
          y < bounds.y ||
          y > bounds.y + bounds.height - 50
        ) {
          isResetWindiw = true;
        }
      } else {
        isResetWindiw = true;
        for (let i = 0; i < displays.length; i++) {
          let { bounds } = displays[i];
          if (
            x > bounds.x &&
            x < bounds.x + bounds.width &&
            y > bounds.y &&
            y < bounds.y - bounds.height
          ) {
            // 检测到APP窗口当前处于一个可用的屏幕里，break
            isResetWindiw = false;
            break;
          }
        }
      }

      if (!isResetWindiw) {
        options.x = x;
        options.y = y;
      }
    }

    this.window = new BrowserWindow(options);

    // hide menu bar on Microsoft Windows and Linux
    this.window.setMenuBarVisibility(false);

    if (process.env.WEBPACK_DEV_SERVER_URL) {
      // Load the url of the dev server if in development mode
      this.window.loadURL(
        showLibraryDefault
          ? `${process.env.WEBPACK_DEV_SERVER_URL}/#/library`
          : process.env.WEBPACK_DEV_SERVER_URL
      );
      // [播客改造] 开发模式不再自动弹出开发者控制台（按 F12 可手动调出），让窗口更清爽。
      // 如需调试时自动打开，取消下一行注释即可。
      // if (!process.env.IS_TEST) this.window.webContents.openDevTools();
    } else {
      createProtocol('app');
      this.window.loadURL(
        showLibraryDefault
          ? 'http://localhost:' + PROFILE.express + '/#/library'
          : 'http://localhost:' + PROFILE.express
      );
    }
  }

  checkForUpdates() {
    if (isDevelopment) return;
    log('checkForUpdates');
    autoUpdater.checkForUpdatesAndNotify();

    const showNewVersionMessage = info => {
      dialog
        .showMessageBox({
          title: '发现新版本 v' + info.version,
          message: '发现新版本 v' + info.version,
          detail: '是否前往 GitHub 下载新版本安装包？',
          buttons: ['下载', '取消'],
          type: 'question',
          noLink: true,
        })
        .then(result => {
          if (result.response === 0) {
            shell.openExternal(
              'https://github.com/qier222/YesPlayMusic/releases'
            );
          }
        });
    };

    autoUpdater.on('update-available', info => {
      showNewVersionMessage(info);
    });
  }

  handleWindowEvents() {
    this.window.once('ready-to-show', () => {
      log('window ready-to-show event');
      this.window.show();
      this.store.set('window', this.window.getBounds());
    });

    this.window.on('close', e => {
      log('window close event');

      if (isLinux) {
        closeOnLinux(e, this.window, this.store);
      } else if (isMac) {
        if (this.willQuitApp) {
          this.window = null;
          app.quit();
        } else {
          e.preventDefault();
          this.window.hide();
        }
      } else {
        let closeOpt = this.store.get('settings.closeAppOption');
        if (this.willQuitApp && (closeOpt === 'exit' || closeOpt === 'ask')) {
          this.window = null;
          app.quit();
        } else {
          e.preventDefault();
          this.window.hide();
        }
      }
    });

    this.window.on('resized', () => {
      this.store.set('window', this.window.getBounds());
    });

    this.window.on('moved', () => {
      this.store.set('window', this.window.getBounds());
    });

    this.window.on('maximize', () => {
      this.window.webContents.send('isMaximized', true);
    });

    this.window.on('unmaximize', () => {
      this.window.webContents.send('isMaximized', false);
    });

    this.window.webContents.on('new-window', function (e, url) {
      e.preventDefault();
      log('open url');
      const excludeHosts = ['www.last.fm'];
      const exclude = excludeHosts.find(host => url.includes(host));
      if (exclude) {
        const newWindow = new BrowserWindow({
          width: 800,
          height: 600,
          titleBarStyle: 'default',
          title: PROFILE.title,
          webPreferences: {
            webSecurity: false,
            nodeIntegration: true,
            enableRemoteModule: true,
            contextIsolation: false,
          },
        });
        newWindow.loadURL(url);
        return;
      }
      shell.openExternal(url);
    });
  }

  handleAppEvents() {
    app.on('ready', async () => {
      // This method will be called when Electron has finished
      // initialization and is ready to create browser windows.
      // Some APIs can only be used after this event occurs.
      log('app ready event');

      // for development
      if (isDevelopment) {
        this.initDevtools();
      }

      // create window
      this.createWindow();
      this.window.once('ready-to-show', () => {
        this.window.show();
      });
      this.handleWindowEvents();

      // create tray
      if (isCreateTray) {
        this.trayEventEmitter = new EventEmitter();
        this.ypmTrayImpl = createTray(
          this.window,
          this.trayEventEmitter,
          this.store
        );
      }

      // init ipcMain
      initIpcMain(this.window, this.store, this.trayEventEmitter);

      // [播客改造] 注册 podcast 相关 IPC handler
      registerPodcastIpc();
      // [NAS] 注册 NAS 音源桥 IPC（未配置/未启用时所有 handler 返回未就绪，零副作用）
      registerNasIpc();
      // [B-31] 注册 podcast 下载相关 IPC（流式下载 + 进度推送 + 删除）
      registerPodcastDownloadIpc(() => this.window);
      // [B-39] 注册首页发现 IPC（热门榜单 + Apple id→feedUrl）
      registerPodcastDiscoverIpc();

      // set proxy
      const proxyRules = this.store.get('proxy');
      if (proxyRules) {
        this.window.webContents.session.setProxy({ proxyRules }, result => {
          log('finished setProxy', result);
        });
      }

      // check for updates
      this.checkForUpdates();

      // create menu
      createMenu(this.window, this.store);

      // create dock menu for macOS
      const createdDockMenu = createDockMenu(this.window);
      if (createDockMenu && app.dock) app.dock.setMenu(createdDockMenu);

      // create touch bar
      const createdTouchBar = createTouchBar(this.window);
      if (createdTouchBar) this.window.setTouchBar(createdTouchBar);

      // register global shortcuts
      if (this.store.get('settings.enableGlobalShortcut') !== false) {
        registerGlobalShortcut(this.window, this.store);
      }

      // try to start osdlyrics process on start
      if (this.store.get('settings.enableOsdlyricsSupport')) {
        await createDbus(this.window);
        log('try to start osdlyrics process');
        const osdlyricsProcess = spawn('osdlyrics');

        osdlyricsProcess.on('error', err => {
          log(`failed to start osdlyrics: ${err.message}`);
        });

        osdlyricsProcess.on('exit', (code, signal) => {
          log(`osdlyrics process exited with code ${code}, signal ${signal}`);
        });
      }

      // create mpris
      if (isCreateMpris) {
        createMpris(this.window);
      }
    });

    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      log('app activate event');
      if (this.window === null) {
        this.createWindow();
      } else {
        this.window.show();
      }
    });

    app.on('window-all-closed', () => {
      if (!isMac) {
        app.quit();
      }
    });

    app.on('before-quit', () => {
      this.willQuitApp = true;
    });

    app.on('quit', () => {
      this.expressApp.close();
    });

    app.on('will-quit', () => {
      // unregister all global shortcuts
      globalShortcut.unregisterAll();
    });

    if (!isMac) {
      app.on('second-instance', () => {
        if (this.window) {
          this.window.show();
          if (this.window.isMinimized()) {
            this.window.restore();
          }
          this.window.focus();
        }
      });
    }
  }
}

new Background();
