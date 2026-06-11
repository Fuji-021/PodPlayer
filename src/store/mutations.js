import shortcuts from '@/utils/shortcuts';
import cloneDeep from 'lodash/cloneDeep';

export default {
  updateLikedXXX(state, { name, data }) {
    state.liked[name] = data;
    if (name === 'songs') {
      state.player.sendSelfToIpcMain();
    }
  },
  // [播客改造 A-7.1] 同步播客收藏 id 列表（来自 Dexie）
  setPodcastFavoriteIds(state, ids) {
    state.podcastFavorites.episodeIds = ids || [];
  },
  // [B-43] 发现页：整体设置已订阅映射（启动/进发现页时从 Dexie 灌入）
  setSubscribedPodcastMap(state, map) {
    state.podcastDiscover.subscribedMap = map || {};
  },
  // [B-43] 发现页：新增一条已订阅（订阅成功后实时回显）。整体替换以触发 Vue2 响应式。
  addSubscribedPodcast(state, payload) {
    const name = payload && payload.name && String(payload.name).trim();
    if (!name) return;
    state.podcastDiscover.subscribedMap = {
      ...state.podcastDiscover.subscribedMap,
      [name]: (payload && payload.feedUrl) || '',
    };
  },
  // [B-44] 取消订阅时移除（全局同步：我的订阅页/发现页/二级页同一节目状态一致）。
  //   按 feedUrl 删除所有别名（榜单名 + RSS 标题可能都登记过），再按 name 兜底。
  removeSubscribedPodcast(state, payload) {
    const feedUrl = payload && payload.feedUrl;
    const name = payload && payload.name && String(payload.name).trim();
    const cur = state.podcastDiscover.subscribedMap || {};
    const next = {};
    Object.keys(cur).forEach(k => {
      if (feedUrl && cur[k] === feedUrl) return; // 丢弃指向该 feed 的全部别名
      if (name && k === name) return;
      next[k] = cur[k];
    });
    state.podcastDiscover.subscribedMap = next;
  },
  // [B-47 第5点] 屏蔽节目：新增（按名去重 + 置顶）并持久化到 localStorage
  addBlockedPodcast(state, item) {
    const name = item && item.name && String(item.name).trim();
    if (!name) return;
    const items = state.podcastBlocked.items.filter(b => b.name !== name);
    items.unshift({ name, coverUrl: (item && item.coverUrl) || '' });
    state.podcastBlocked.items = items;
    localStorage.setItem('podcastBlocked', JSON.stringify(items));
  },
  // [B-47 第5点] 取消屏蔽
  removeBlockedPodcast(state, name) {
    const n = String(name || '').trim();
    const items = state.podcastBlocked.items.filter(b => b.name !== n);
    state.podcastBlocked.items = items;
    localStorage.setItem('podcastBlocked', JSON.stringify(items));
  },
  // [B-70] 标记/取消标记"链接无法解析"的节目（发现页卡片标红点）。按节目名为键。
  addBrokenPodcast(state, name) {
    const n = String(name || '').trim();
    if (!n || state.podcastBroken.names.includes(n)) return;
    const names = [...state.podcastBroken.names, n];
    state.podcastBroken.names = names;
    localStorage.setItem('podcastBroken', JSON.stringify(names));
  },
  removeBrokenPodcast(state, name) {
    const n = String(name || '').trim();
    if (!n || !state.podcastBroken.names.includes(n)) return;
    const names = state.podcastBroken.names.filter(x => x !== n);
    state.podcastBroken.names = names;
    localStorage.setItem('podcastBroken', JSON.stringify(names));
  },
  // [B-75] 单集标记位置：加一个标记点（按 episodeId 存秒数；±2s 内视为重复不加；升序）
  addPodcastMark(state, { episodeId, sec } = {}) {
    if (!episodeId || typeof sec !== 'number' || sec < 0) return;
    const map = { ...state.podcastMarks.map };
    const arr = (map[episodeId] || []).slice();
    if (arr.some(s => Math.abs(s - sec) < 2)) return; // 相近点不重复
    arr.push(sec);
    arr.sort((a, b) => a - b);
    map[episodeId] = arr;
    state.podcastMarks.map = map;
    localStorage.setItem('podcastMarks', JSON.stringify(map));
  },
  // [B-75] 清空某集的全部标记（长按标记键触发）
  clearPodcastMarks(state, episodeId) {
    if (!episodeId) return;
    const map = { ...state.podcastMarks.map };
    if (!(episodeId in map)) return;
    delete map[episodeId];
    state.podcastMarks.map = map;
    localStorage.setItem('podcastMarks', JSON.stringify(map));
  },
  // [B-48 第5点] 设置/清除自定义头像（dataURL）
  setPodcastAvatar(state, dataUrl) {
    state.podcastAvatar = dataUrl || '';
    if (dataUrl) localStorage.setItem('podcastAvatar', dataUrl);
    else localStorage.removeItem('podcastAvatar');
  },
  // [播客改造 C-14] 切换音频缓冲状态
  setAudioBuffering(state, val) {
    state.audioBuffering = !!val;
  },
  // [播客改造 A-24] 播放队列：默认加在**头部**（下一首就播这个）
  enqueueEpisodeAtFront(state, ep) {
    const idx = state.podcastQueue.findIndex(x => x.id === ep.id);
    if (idx >= 0) state.podcastQueue.splice(idx, 1); // 已存在就先移除，避免重复
    state.podcastQueue.unshift(ep);
    localStorage.setItem('podcastQueue', JSON.stringify(state.podcastQueue));
  },
  removeFromQueue(state, episodeId) {
    state.podcastQueue = state.podcastQueue.filter(x => x.id !== episodeId);
    localStorage.setItem('podcastQueue', JSON.stringify(state.podcastQueue));
  },
  clearQueue(state) {
    state.podcastQueue = [];
    localStorage.setItem('podcastQueue', JSON.stringify([]));
  },
  setQueue(state, list) {
    state.podcastQueue = Array.isArray(list) ? list : [];
    localStorage.setItem('podcastQueue', JSON.stringify(state.podcastQueue));
  },
  changeLang(state, lang) {
    state.settings.lang = lang;
  },
  changeMusicQuality(state, value) {
    state.settings.musicQuality = value;
  },
  changeLyricFontSize(state, value) {
    state.settings.lyricFontSize = value;
  },
  changeOutputDevice(state, deviceId) {
    state.settings.outputDevice = deviceId;
  },
  updateSettings(state, { key, value }) {
    state.settings[key] = value;
  },
  updateData(state, { key, value }) {
    state.data[key] = value;
  },
  togglePlaylistCategory(state, name) {
    const index = state.settings.enabledPlaylistCategories.findIndex(
      c => c === name
    );
    if (index !== -1) {
      state.settings.enabledPlaylistCategories =
        state.settings.enabledPlaylistCategories.filter(c => c !== name);
    } else {
      state.settings.enabledPlaylistCategories.push(name);
    }
  },
  updateToast(state, toast) {
    state.toast = toast;
  },
  updateModal(state, { modalName, key, value }) {
    state.modals[modalName][key] = value;
    if (key === 'show') {
      // 100ms的延迟是为等待右键菜单blur之后再disableScrolling
      value === true
        ? setTimeout(() => (state.enableScrolling = false), 100)
        : (state.enableScrolling = true);
    }
  },
  toggleLyrics(state) {
    state.showLyrics = !state.showLyrics;
  },
  updateDailyTracks(state, dailyTracks) {
    state.dailyTracks = dailyTracks;
  },
  updateLastfm(state, session) {
    state.lastfm = session;
  },
  updateShortcut(state, { id, type, shortcut }) {
    let newShortcut = state.settings.shortcuts.find(s => s.id === id);
    newShortcut[type] = shortcut;
    state.settings.shortcuts = state.settings.shortcuts.map(s => {
      if (s.id !== id) return s;
      return newShortcut;
    });
  },
  restoreDefaultShortcuts(state) {
    state.settings.shortcuts = cloneDeep(shortcuts);
  },
  enableScrolling(state, status = null) {
    state.enableScrolling = status ? status : !state.enableScrolling;
  },
  updateTitle(state, title) {
    state.title = title;
  },
  // [B-31] 下载相关 mutations
  setDownloadProgress(state, { episodeId, bytesDone, bytesTotal, status }) {
    if (!episodeId) return;
    // Vue 2：动态 key 用 Vue.set 触发响应式
    const map = state.podcastDownloads.progressMap;
    state.podcastDownloads.progressMap = {
      ...map,
      [episodeId]: { bytesDone, bytesTotal, status },
    };
  },
  clearDownloadProgress(state, episodeId) {
    if (!episodeId) return;
    const map = { ...state.podcastDownloads.progressMap };
    delete map[episodeId];
    state.podcastDownloads.progressMap = map;
  },
  // [B-35] payload 改为 { id, filePath }（兼容旧的传 string）
  addDownloadedEpisode(state, payload) {
    const episodeId =
      typeof payload === 'string' ? payload : payload && payload.id;
    const filePath =
      typeof payload === 'string' ? '' : payload && payload.filePath;
    if (!episodeId) return;
    const ids = state.podcastDownloads.doneIds || [];
    if (!ids.includes(episodeId)) {
      state.podcastDownloads.doneIds = [...ids, episodeId];
    }
    if (filePath) {
      state.podcastDownloads.pathMap = {
        ...state.podcastDownloads.pathMap,
        [episodeId]: filePath,
      };
    }
  },
  removeDownloadedEpisode(state, episodeId) {
    if (!episodeId) return;
    state.podcastDownloads.doneIds = (
      state.podcastDownloads.doneIds || []
    ).filter(id => id !== episodeId);
    const pm = { ...state.podcastDownloads.pathMap };
    delete pm[episodeId];
    state.podcastDownloads.pathMap = pm;
  },
  // [B-35] rows: [{ id, filePath }]
  setDownloadedEpisodes(state, rows) {
    const list = Array.isArray(rows) ? rows : [];
    state.podcastDownloads.doneIds = list.map(r => r.id);
    const pm = {};
    list.forEach(r => {
      if (r.id && r.filePath) pm[r.id] = r.filePath;
    });
    state.podcastDownloads.pathMap = pm;
  },
  // [B-31] 收听统计变化广播：Player.js 在 5% 步进 / completed 变化时调用
  bumpListenTick(state, payload) {
    const cur = state.podcastListening || {};
    state.podcastListening = {
      listenTick: (cur.listenTick || 0) + 1,
      episodeId: (payload && payload.episodeId) || '',
      listenedSec: (payload && payload.listenedSec) || 0,
      totalSec: (payload && payload.totalSec) || 0,
      completed: !!(payload && payload.completed),
    };
  },
};
