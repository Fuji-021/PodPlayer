import store from '@/store';
import { db } from '@/utils/db';

const player = store.state.player;

export function ipcRenderer(vueInstance) {
  const self = vueInstance;
  // 添加专有的类名
  document.body.setAttribute('data-electron', 'yes');
  document.body.setAttribute(
    'data-electron-os',
    window.require('os').platform()
  );
  // ipc message channel
  const electron = window.require('electron');
  const ipcRenderer = electron.ipcRenderer;

  // listens to the main process 'changeRouteTo' event and changes the route from
  // inside this Vue instance, according to what path the main process requires.
  // responds to Menu click() events at the main process and changes the route accordingly.

  ipcRenderer.on('changeRouteTo', (event, path) => {
    self.$router.push(path);
    if (store.state.showLyrics) {
      store.commit('toggleLyrics');
    }
  });

  ipcRenderer.on('search', () => {
    // 触发数据响应
    self.$refs.navbar.$refs.searchInput.focus();
    self.$refs.navbar.inputFocus = true;
  });

  // [审P1-4] 优雅退出：主进程真正 app.exit() 前发 'app:before-exit-flush'，这里把 Player 的收听缓冲
  //   + 最后一次播放进度 flush 落盘、再关库，完成后回 'app:flush-done' ack。await Promise 保证 Dexie
  //   事务 commit 后主进程才退(主进程侧另有 800ms 超时兜底，绝不卡死退出)。electron/ 禁可选链。
  ipcRenderer.on('app:before-exit-flush', () => {
    const ack = () => {
      try {
        ipcRenderer.send('app:flush-done');
      } catch (e) {
        /* ignore */
      }
    };
    Promise.resolve()
      .then(() => {
        if (player && typeof player.flushBeforeExit === 'function') {
          return player.flushBeforeExit();
        }
      })
      .then(() => {
        try {
          if (db && db.isOpen()) db.close(); // 等收听/进度写完后再关库，杜绝在途事务被腰斩
        } catch (e) {
          /* ignore */
        }
      })
      .catch(() => {})
      .then(ack); // 无论成败都 ack(主进程那边还有 800ms 兜底)
  });

  // [快捷键修 B] 菜单 accelerator 即使焦点在输入框也会触发并吞键(如搜索框/NAS 弹窗打字时按 Ctrl+L
  //   会触发收藏而非编辑)。播放器动作 handler 入口加"输入聚焦守卫":焦点在 input/textarea/可编辑元素
  //   时不执行播放器动作(search 不加——它本就是要聚焦输入)。electron/ 不可用可选链,故用 el && 判断。
  const inEditable = () => {
    const el = document.activeElement;
    return !!(
      el &&
      (el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.isContentEditable)
    );
  };

  ipcRenderer.on('play', () => {
    if (inEditable()) return;
    player.playOrPause();
  });

  // [播客快捷键] 下一首/上一首对播客无意义(队列导航空操作)→ 改为快进 30 秒 / 快退 15 秒，
  //   与底栏 ±15/30 按钮一致(Player.vue seekForward30 / seekBackward15)。
  ipcRenderer.on('next', () => {
    if (inEditable()) return;
    const cur = player.seek();
    const dur = player.currentTrackDuration || 0;
    player.seek(Math.min(Math.max(0, dur - 1), (cur || 0) + 30));
  });

  ipcRenderer.on('previous', () => {
    if (inEditable()) return;
    const cur = player.seek();
    player.seek(Math.max(0, (cur || 0) - 15));
  });

  ipcRenderer.on('increaseVolume', () => {
    if (inEditable()) return;
    if (player.volume + 0.1 >= 1) {
      return (player.volume = 1);
    }
    player.volume += 0.1;
  });

  ipcRenderer.on('decreaseVolume', () => {
    if (inEditable()) return;
    if (player.volume - 0.1 <= 0) {
      return (player.volume = 0);
    }
    player.volume -= 0.1;
  });

  // [播客快捷键] 收藏：播客单集 → 本地收藏切换；网易云曲 → 原 likeATrack(同 Player.vue toggleFavorite)。
  ipcRenderer.on('like', () => {
    if (inEditable()) return;
    const t = player.currentTrack;
    if (!t) return;
    if (t.podcastEpisodeId) {
      store.dispatch('togglePodcastFavorite', t);
    } else if (t.id) {
      store.dispatch('likeATrack', t.id);
    }
  });

  ipcRenderer.on('repeat', () => {
    if (inEditable()) return;
    player.switchRepeatMode();
  });

  // [操作#15/#2b] 全局快捷键注册失败(被其它应用/系统占用，或非法组合) → 弹 toast 提示，不再静默失灵。
  ipcRenderer.on('globalShortcutRegisterFailed', (event, list) => {
    if (list && list.length) {
      store.dispatch(
        'showToast',
        `快捷键 ${list.join('、')} 注册失败（被其它应用占用或非法组合）`
      );
    }
  });

  ipcRenderer.on('shuffle', () => {
    if (inEditable()) return;
    player.switchShuffle();
  });

  ipcRenderer.on('routerGo', (event, where) => {
    self.$refs.navbar.go(where);
  });

  ipcRenderer.on('nextUp', () => {
    self.$refs.player.goToNextTracksPage();
  });

  ipcRenderer.on('rememberCloseAppOption', (event, value) => {
    store.commit('updateSettings', {
      key: 'closeAppOption',
      value,
    });
  });

  ipcRenderer.on('setPosition', (event, position) => {
    player._howler.seek(position);
  });
}
