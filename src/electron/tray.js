/* global __static */
import path from 'path';
import { app, nativeImage, Tray, Menu, nativeTheme } from 'electron';
import { isLinux } from '@/utils/platform';

// [托盘菜单图标深色适配] 深色系统菜单背景用白色(-light)图标、浅色用原黑色图标。
//   注:Electron 模板图(setTemplateImage)只在 macOS 反色，Windows/Linux 忽略 → 必须显式换两套 PNG。
//   图标明暗跟【系统菜单背景】nativeTheme.shouldUseDarkColors，而非 settings.trayIconTheme(那是任务栏小图标)。
function menuIcon(name) {
  const sfx = nativeTheme.shouldUseDarkColors ? '-light' : '';
  return nativeImage.createFromPath(
    path.join(__static, 'img/icons/' + name + sfx + '.png')
  );
}

function createMenuTemplate(win) {
  return [
    {
      label: '播放',
      icon: menuIcon('play'),
      click: () => {
        win.webContents.send('play');
      },
      id: 'play',
    },
    {
      label: '暂停',
      icon: menuIcon('pause'),
      click: () => {
        win.webContents.send('play');
      },
      id: 'pause',
      visible: false,
    },
    {
      // [文案统一·2026-06-16] 托盘菜单与应用菜单(menu.js)/物理媒体键/全局快捷键一致:
      //   播客无"上/下一首"语义,'previous'/'next' 实际是 快退15/快进30(见 ipcRenderer),
      //   label 随功能改、不再写"上/下一首"。点击行为本就是 seek、未变。
      label: '快退 15 秒',
      icon: menuIcon('left'),
      accelerator: 'CmdOrCtrl+Left',
      click: () => {
        win.webContents.send('previous');
      },
    },
    {
      label: '快进 30 秒',
      icon: menuIcon('right'),
      accelerator: 'CmdOrCtrl+Right',
      click: () => {
        win.webContents.send('next');
      },
    },
    {
      label: '循环播放',
      icon: menuIcon('repeat'),
      accelerator: 'Alt+R',
      click: () => {
        win.webContents.send('repeat');
      },
    },
    {
      label: '加入喜欢',
      icon: menuIcon('like'),
      accelerator: 'CmdOrCtrl+L',
      click: () => {
        win.webContents.send('like');
      },
      id: 'like',
    },
    {
      label: '取消喜欢',
      icon: menuIcon('unlike'),
      accelerator: 'CmdOrCtrl+L',
      click: () => {
        win.webContents.send('like');
      },
      id: 'unlike',
      visible: false,
    },
    {
      label: '退出',
      icon: menuIcon('exit'),
      accelerator: 'CmdOrCtrl+W',
      click: () => {
        app.exit();
      },
    },
  ];
}

// linux下托盘的实现方式比较迷惑
// right-click无法在linux下使用
// click在默认行为下会弹出一个contextMenu，里面的唯一选项才会调用click事件
// setContextMenu应该是目前唯一能在linux下使用托盘菜单api
// 但是无法区分鼠标左右键

// 发现openSUSE KDE环境可以区分鼠标左右键
// 添加左键支持
// 2022.05.17
class YPMTrayLinuxImpl {
  constructor(tray, win, emitter, store) {
    this.tray = tray;
    this.win = win;
    this.emitter = emitter;
    this.store = store;
    this.template = undefined;
    this.initTemplate();
    this.contextMenu = Menu.buildFromTemplate(this.template);

    this.tray.setContextMenu(this.contextMenu);
    this.handleEvents();
  }

  initTemplate() {
    //在linux下，鼠标左右键都会呼出contextMenu
    //所以此处单独为linux添加一个 显示主面板 选项
    this.template = [
      {
        label: '显示主面板',
        click: () => {
          this.win.show();
        },
      },
      {
        type: 'separator',
      },
    ].concat(createMenuTemplate(this.win));
  }

  handleEvents() {
    this.tray.on('click', () => {
      this.win.show();
    });

    this.emitter.on('updateTooltip', title => this.tray.setToolTip(title));
    this.emitter.on('updatePlayState', isPlaying => {
      this.contextMenu.getMenuItemById('play').visible = !isPlaying;
      this.contextMenu.getMenuItemById('pause').visible = isPlaying;
      this.tray.setContextMenu(this.contextMenu);
    });
    this.emitter.on('updateLikeState', isLiked => {
      this.contextMenu.getMenuItemById('like').visible = !isLiked;
      this.contextMenu.getMenuItemById('unlike').visible = isLiked;
      this.tray.setContextMenu(this.contextMenu);
    });
    this.emitter.on('updateIcon', () => {
      this.updateIcon();
    });
  }

  updateIcon() {
    let trayIconSetting = this.store.get('settings.trayIconTheme') || 'auto';
    let iconTheme;
    if (trayIconSetting === 'auto') {
      iconTheme = nativeTheme.shouldUseDarkColors ? 'light' : 'dark';
    } else {
      iconTheme = trayIconSetting;
    }

    let icon = nativeImage
      .createFromPath(path.join(__static, `img/icons/menu-${iconTheme}@88.png`))
      .resize({
        height: 20,
        width: 20,
      });

    this.tray.setImage(icon);
  }
}

class YPMTrayWindowsImpl {
  constructor(tray, win, emitter, store) {
    this.tray = tray;
    this.win = win;
    this.emitter = emitter;
    this.store = store;

    this.isPlaying = false;
    this.curDisplayPlaying = false;

    this.isLiked = false;
    this.curDisplayLiked = false;

    // [托盘菜单图标深色] 按当前系统主题构建菜单(rebuildMenu 内含按主题选图标 + 恢复 visible)
    this.rebuildMenu();

    this.handleEvents();
  }

  // [托盘菜单图标深色适配] 重建菜单(系统深浅色切换时换图标明暗)。Windows 菜单只构建一次，必须显式
  //   重建；重建后按当前 isPlaying/isLiked 恢复 play/pause、like/unlike 的 visible，并同步 curDisplay
  //   (让下次 right-click 的差值判断正确，否则会停在错误项)。
  rebuildMenu() {
    this.template = createMenuTemplate(this.win);
    this.contextMenu = Menu.buildFromTemplate(this.template);
    this.contextMenu.getMenuItemById('play').visible = !this.isPlaying;
    this.contextMenu.getMenuItemById('pause').visible = this.isPlaying;
    this.contextMenu.getMenuItemById('like').visible = !this.isLiked;
    this.contextMenu.getMenuItemById('unlike').visible = this.isLiked;
    this.curDisplayPlaying = this.isPlaying;
    this.curDisplayLiked = this.isLiked;
  }

  handleEvents() {
    this.tray.on('click', () => {
      this.win.show();
    });

    this.tray.on('right-click', () => {
      if (this.isPlaying !== this.curDisplayPlaying) {
        this.curDisplayPlaying = this.isPlaying;
        this.contextMenu.getMenuItemById('play').visible = !this.isPlaying;
        this.contextMenu.getMenuItemById('pause').visible = this.isPlaying;
      }

      if (this.isLiked !== this.curDisplayLiked) {
        this.curDisplayLiked = this.isLiked;
        this.contextMenu.getMenuItemById('like').visible = !this.isLiked;
        this.contextMenu.getMenuItemById('unlike').visible = this.isLiked;
      }

      this.tray.popUpContextMenu(this.contextMenu);
    });

    this.emitter.on('updateTooltip', title => this.tray.setToolTip(title));
    this.emitter.on(
      'updatePlayState',
      isPlaying => (this.isPlaying = isPlaying)
    );
    this.emitter.on('updateLikeState', isLiked => (this.isLiked = isLiked));
    this.emitter.on('updateIcon', () => {
      this.updateIcon();
      // [托盘菜单图标深色] 系统主题切换(background.js nativeTheme.on('updated')→emit('updateIcon'))时
      //   同步重建菜单换图标明暗，复用同一事件源、不再单独加一处 nativeTheme 监听。
      this.rebuildMenu();
    });
  }

  updateIcon() {
    let trayIconSetting = this.store.get('settings.trayIconTheme') || 'auto';
    let iconTheme;
    if (trayIconSetting === 'auto') {
      iconTheme = nativeTheme.shouldUseDarkColors ? 'light' : 'dark';
    } else {
      iconTheme = trayIconSetting;
    }

    let icon = nativeImage
      .createFromPath(path.join(__static, `img/icons/menu-${iconTheme}@88.png`))
      .resize({
        height: 20,
        width: 20,
      });

    this.tray.setImage(icon);
  }
}

export function createTray(win, eventEmitter, store) {
  let trayIconSetting = store.get('settings.trayIconTheme') || 'auto';
  let iconTheme;
  if (trayIconSetting === 'auto') {
    iconTheme = nativeTheme.shouldUseDarkColors ? 'light' : 'dark';
  } else {
    iconTheme = trayIconSetting;
  }

  let icon = nativeImage
    .createFromPath(path.join(__static, `img/icons/menu-${iconTheme}@88.png`))
    .resize({
      height: 20,
      width: 20,
    });

  let tray = new Tray(icon);
  tray.setToolTip('PodPlayer');

  return isLinux
    ? new YPMTrayLinuxImpl(tray, win, eventEmitter, store)
    : new YPMTrayWindowsImpl(tray, win, eventEmitter, store);
}
