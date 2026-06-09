import { getAlbum } from '@/api/album';
import { getArtist } from '@/api/artist';
import { trackScrobble, trackUpdateNowPlaying } from '@/api/lastfm';
import { fmTrash, personalFM } from '@/api/others';
import { getPlaylistDetail, intelligencePlaylist } from '@/api/playlist';
import { getLyric, getMP3, getTrackDetail, scrobble } from '@/api/track';
import store from '@/store';
import { isAccountLoggedIn } from '@/utils/auth';
import { cacheTrackSource, getTrackSource } from '@/utils/db';
// [播客改造 S-1] 单集进度按集保存：用 Dexie 的 episodeProgress 表
import { saveEpisodeProgress, getEpisodeProgress } from '@/utils/podcast/db';
// [播客改造] 真实收听统计
import { tickListen, resetEpisodeListening } from '@/utils/podcast/listening';
import { isCreateMpris, isCreateTray } from '@/utils/platform';
import { Howl, Howler } from 'howler';
import shuffle from 'lodash/shuffle';
import { decode as base642Buffer } from '@/utils/base64';

const PLAY_PAUSE_FADE_DURATION = 200;

const INDEX_IN_PLAY_NEXT = -1;

/**
 * @readonly
 * @enum {string}
 */
const UNPLAYABLE_CONDITION = {
  PLAY_NEXT_TRACK: 'playNextTrack',
  PLAY_PREV_TRACK: 'playPrevTrack',
};

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer =
  process.env.IS_ELECTRON === true ? electron.ipcRenderer : null;
const delay = ms =>
  new Promise(resolve => {
    setTimeout(() => {
      resolve('');
    }, ms);
  });
const excludeSaveKeys = [
  '_playing',
  '_personalFMLoading',
  '_personalFMNextLoading',
];

function setTitle(track) {
  // [B-32] 播客单集：标题栏只显示单集名（不带节目名/app 后缀，
  // 标题栏左侧已有 PodPlayer 品牌区，无需重复）。网易云保持原格式。
  if (!track) {
    document.title = 'YesPlayMusic';
  } else if (track.podcastEpisodeId) {
    document.title = track.name;
  } else {
    document.title = `${track.name} · ${track.ar[0].name} - YesPlayMusic`;
  }
  if (isCreateTray) {
    ipcRenderer?.send('updateTrayTooltip', document.title);
  }
  store.commit('updateTitle', document.title);
}

function setTrayLikeState(isLiked) {
  if (isCreateTray) {
    ipcRenderer?.send('updateTrayLikeState', isLiked);
  }
}

export default class {
  constructor() {
    // 播放器状态
    this._playing = false; // 是否正在播放中
    this._progress = 0; // 当前播放歌曲的进度
    this._enabled = false; // 是否启用Player
    this._repeatMode = 'off'; // off | on | one
    this._shuffle = false; // true | false
    this._reversed = false;
    this._volume = 1; // 0 to 1
    this._volumeBeforeMuted = 1; // 用于保存静音前的音量
    this._playbackRate = 1; // [播客改造] 播放倍速，0.5–3.0
    this._playSourceToken = 0; // [S1 修复] 切源并发竞争令牌
    this._personalFMLoading = false; // 是否正在私人FM中加载新的track
    this._personalFMNextLoading = false; // 是否正在缓存私人FM的下一首歌曲

    // 播放信息
    this._list = []; // 播放列表
    this._current = 0; // 当前播放歌曲在播放列表里的index
    this._shuffledList = []; // 被随机打乱的播放列表，随机播放模式下会使用此播放列表
    this._shuffledCurrent = 0; // 当前播放歌曲在随机列表里面的index
    this._playlistSource = { type: 'album', id: 123 }; // 当前播放列表的信息
    this._currentTrack = { id: 86827685 }; // 当前播放歌曲的详细信息
    this._playNextList = []; // 当这个list不为空时，会优先播放这个list的歌
    this._isPersonalFM = false; // 是否是私人FM模式
    this._personalFMTrack = { id: 0 }; // 私人FM当前歌曲
    this._personalFMNextTrack = {
      id: 0,
    }; // 私人FM下一首歌曲信息（为了快速加载下一首）

    /**
     * The blob records for cleanup.
     *
     * @private
     * @type {string[]}
     */
    this.createdBlobRecords = [];

    // howler (https://github.com/goldfire/howler.js)
    this._howler = null;
    Object.defineProperty(this, '_howler', {
      enumerable: false,
    });

    // init
    this._init();

    window.yesplaymusic = {};
    window.yesplaymusic.player = this;
  }

  get repeatMode() {
    return this._repeatMode;
  }
  set repeatMode(mode) {
    if (this._isPersonalFM) return;
    if (!['off', 'on', 'one'].includes(mode)) {
      console.warn("repeatMode: invalid args, must be 'on' | 'off' | 'one'");
      return;
    }
    this._repeatMode = mode;
  }
  get shuffle() {
    return this._shuffle;
  }
  set shuffle(shuffle) {
    if (this._isPersonalFM) return;
    if (shuffle !== true && shuffle !== false) {
      console.warn('shuffle: invalid args, must be Boolean');
      return;
    }
    this._shuffle = shuffle;
    if (shuffle) {
      this._shuffleTheList();
    }
    // 同步当前歌曲在列表中的下标
    this.current = this.list.indexOf(this.currentTrackID);
  }
  get reversed() {
    return this._reversed;
  }
  set reversed(reversed) {
    if (this._isPersonalFM) return;
    if (reversed !== true && reversed !== false) {
      console.warn('reversed: invalid args, must be Boolean');
      return;
    }
    console.log('changing reversed to:', reversed);
    this._reversed = reversed;
  }
  get volume() {
    return this._volume;
  }
  set volume(volume) {
    this._volume = volume;
    this._howler?.volume(volume);
  }
  // [播客改造] 播放倍速：底层走 howler.rate()（HTML5 模式下用 audio.playbackRate）
  get playbackRate() {
    return this._playbackRate;
  }
  set playbackRate(rate) {
    const r = Math.max(0.5, Math.min(3, Number(rate) || 1));
    this._playbackRate = r;
    this._howler?.rate(r);
  }
  get list() {
    return this.shuffle ? this._shuffledList : this._list;
  }
  set list(list) {
    this._list = list;
  }
  get current() {
    return this.shuffle ? this._shuffledCurrent : this._current;
  }
  set current(current) {
    if (this.shuffle) {
      this._shuffledCurrent = current;
    } else {
      this._current = current;
    }
  }
  get enabled() {
    return this._enabled;
  }
  get playing() {
    return this._playing;
  }
  get currentTrack() {
    return this._currentTrack;
  }
  get currentTrackID() {
    return this._currentTrack?.id ?? 0;
  }
  get playlistSource() {
    return this._playlistSource;
  }
  get playNextList() {
    return this._playNextList;
  }
  get isPersonalFM() {
    return this._isPersonalFM;
  }
  get personalFMTrack() {
    return this._personalFMTrack;
  }
  get currentTrackDuration() {
    const trackDuration = this._currentTrack.dt || 1000;
    let duration = ~~(trackDuration / 1000);
    return duration > 1 ? duration - 1 : duration;
  }
  get progress() {
    return this._progress;
  }
  set progress(value) {
    if (this._howler) {
      // [bug 修复] howler 未 loaded 时 seek 不会生效，要等 'load' 再做
      const applySeek = () => {
        try {
          this._howler?.seek(value);
        } catch (e) {
          /* ignore */
        }
      };
      if (this._howler.state() === 'loaded') {
        applySeek();
      } else {
        this._howler.once('load', applySeek);
      }
      this._progress = value;
      // [播客改造 bug] 拖动进度条时立即保存到 episodeProgress
      const t = this._currentTrack;
      if (t && t.podcastEpisodeId && value > 0) {
        saveEpisodeProgress(t.podcastEpisodeId, Math.floor(value));
      }
      if (isCreateMpris) {
        ipcRenderer?.send('seeked', value);
      }
    }
  }
  get isCurrentTrackLiked() {
    return store.state.liked.songs.includes(this.currentTrack.id);
  }

  _init() {
    this._loadSelfFromLocalStorage();
    this._howler?.volume(this.volume);

    if (this._enabled) {
      if (this._currentTrack && this._currentTrack.podcastAudioUrl) {
        // [播客改造 S-1] 播客单集走自己的恢复路径，避免 _replaceCurrentTrack
        // 用网易云接口去查 pod:xxx 这种 id，造成 _currentTrack=undefined、播放器死锁
        this._loadCurrentPodcastEpisode(false);
      } else {
        // 原逻辑：网易云曲目按 id 查询恢复
        this._replaceCurrentTrack(this.currentTrackID, false).then(() => {
          this._howler?.seek(
            localStorage.getItem('playerCurrentTrackTime') ?? 0
          );
        });
      }
      this._initMediaSession();
    }

    this._setIntervals();

    // 初始化私人FM
    if (
      this._personalFMTrack.id === 0 ||
      this._personalFMNextTrack.id === 0 ||
      this._personalFMTrack.id === this._personalFMNextTrack.id
    ) {
      personalFM().then(result => {
        this._personalFMTrack = result.data[0];
        this._personalFMNextTrack = result.data[1];
        return this._personalFMTrack;
      });
    }
  }
  _setPlaying(isPlaying) {
    this._playing = isPlaying;
    if (isCreateTray) {
      ipcRenderer?.send('updateTrayPlayState', this._playing);
    }
  }
  _setIntervals() {
    // 同步播放进度
    // TODO: 如果 _progress 在别的地方被改变了，
    // 这个定时器会覆盖之前改变的值，是bug
    setInterval(() => {
      if (this._howler === null) return;
      if (this._howler.state() !== 'loaded') return;
      const cur = this._howler.seek();
      if (typeof cur === 'number' && cur >= 0) {
        this._progress = cur;
      }
      localStorage.setItem('playerCurrentTrackTime', this._progress);
      const t = this._currentTrack;
      if (
        t &&
        t.podcastEpisodeId &&
        typeof this._progress === 'number' &&
        this._progress > 0
      ) {
        saveEpisodeProgress(t.podcastEpisodeId, Math.floor(this._progress));

        // [播客改造] 真实收听统计：每秒 tick
        if (this._playing) {
          const sec = Math.floor(this._progress);
          let totalSec = Math.floor((t.dt || 0) / 1000);
          // [B-64] 单集时长未知(dt=0，如 RSS 缺 itunes:duration)时用 howler 解码时长兜底，
          //   否则 totalSec=0 → 整块跳过 → 收听统计/每日聚合完全不记录。
          if (
            totalSec <= 0 &&
            this._howler &&
            this._howler.state() === 'loaded'
          ) {
            const d = Math.floor(this._howler.duration() || 0);
            if (d > 0) {
              totalSec = d;
              t.dt = d * 1000; // 回写，后续 tick 直接命中、进度条/MediaSession 时长也正确
            }
          }
          if (totalSec > 0) {
            const lastSec = this._lastListenSec;
            const jump = lastSec >= 0 ? Math.abs(sec - lastSec) : 0;
            // 阈值 = max(45, totalSec * 30%)。前进 30 / 后退 15 总在阈值内。
            const bigJumpTh = Math.max(45, Math.floor(totalSec * 0.3));
            const isBigJump = lastSec >= 0 && jump > bigJumpTh;
            const rate = this._playbackRate || 1;
            // [B-31] tickListen 返回 row 后，按"5% 步进 或 completed 变化"广播给 UI
            tickListen(t.podcastEpisodeId, sec, totalSec, {
              recordBit: !isBigJump,
              wallDeltaSec: 1, // 真实流逝 1 秒
              contentDeltaSec: isBigJump ? 0 : rate, // 节目时长域：按倍速
            })
              .then(row => {
                if (!row) return;
                const stepNow = Math.floor(
                  ((row.listenedSec || 0) / Math.max(1, row.totalSec)) * 20
                ); // 5% = 1/20
                const lastStep = this._lastListenStep ?? -1;
                const lastCompleted = this._lastListenCompleted || false;
                if (stepNow !== lastStep || row.completed !== lastCompleted) {
                  this._lastListenStep = stepNow;
                  this._lastListenCompleted = row.completed;
                  store.commit('bumpListenTick', {
                    episodeId: t.podcastEpisodeId,
                    listenedSec: row.listenedSec || 0,
                    totalSec: row.totalSec || 0,
                    completed: !!row.completed,
                  });
                }
              })
              .catch(() => {});
            this._lastListenSec = sec;
          }
        }
      }
      if (isCreateMpris) {
        ipcRenderer?.send('playerCurrentTrackTime', this._progress);
      }
    }, 1000);
  }
  _getNextTrack() {
    const next = this._reversed ? this.current - 1 : this.current + 1;

    if (this._playNextList.length > 0) {
      let trackID = this._playNextList[0];
      return [trackID, INDEX_IN_PLAY_NEXT];
    }

    // 循环模式开启，则重新播放当前模式下的相对的下一首
    if (this.repeatMode === 'on') {
      if (this._reversed && this.current === 0) {
        // 倒序模式，当前歌曲是第一首，则重新播放列表最后一首
        return [this.list[this.list.length - 1], this.list.length - 1];
      } else if (this.list.length === this.current + 1) {
        // 正序模式，当前歌曲是最后一首，则重新播放第一首
        return [this.list[0], 0];
      }
    }

    // 返回 [trackID, index]
    return [this.list[next], next];
  }
  _getPrevTrack() {
    const next = this._reversed ? this.current + 1 : this.current - 1;

    // 循环模式开启，则重新播放当前模式下的相对的下一首
    if (this.repeatMode === 'on') {
      if (this._reversed && this.current === 0) {
        // 倒序模式，当前歌曲是最后一首，则重新播放列表第一首
        return [this.list[0], 0];
      } else if (this.list.length === this.current + 1) {
        // 正序模式，当前歌曲是第一首，则重新播放列表最后一首
        return [this.list[this.list.length - 1], this.list.length - 1];
      }
    }

    // 返回 [trackID, index]
    return [this.list[next], next];
  }
  async _shuffleTheList(firstTrackID = this.currentTrackID) {
    let list = this._list.filter(tid => tid !== firstTrackID);
    if (firstTrackID === 'first') list = this._list;
    this._shuffledList = shuffle(list);
    if (firstTrackID !== 'first') this._shuffledList.unshift(firstTrackID);
  }
  async _scrobble(track, time, completed = false) {
    // [播客改造] 播客单集不调用网易云的"听歌打卡"接口
    if (track && track.podcastAudioUrl) return;
    console.debug(
      `[debug][Player.js] scrobble track 👉 ${track.name} by ${track.ar[0].name} 👉 time:${time} completed: ${completed}`
    );
    const trackDuration = ~~(track.dt / 1000);
    time = completed ? trackDuration : ~~time;
    scrobble({
      id: track.id,
      sourceid: this.playlistSource.id,
      time,
    });
    if (
      store.state.lastfm.key !== undefined &&
      (time >= trackDuration / 2 || time >= 240)
    ) {
      const timestamp = ~~(new Date().getTime() / 1000) - time;
      trackScrobble({
        artist: track.ar[0].name,
        track: track.name,
        timestamp,
        album: track.al.name,
        trackNumber: track.no,
        duration: trackDuration,
      });
    }
  }
  async _playAudioSource(source, autoplay = true, seekToOnLoad = 0) {
    // [S1 修复 bug-A] 并发令牌：每次调用 +1。如果在 await 期间被新的调用接替，
    // 旧的就此返回，避免两个 howler 同时创建/播放（用户报告"两条音频在响"的根因）
    const myToken = ++this._playSourceToken;

    // [播客改造 C-14] 标记进入加载态，让 UI 显示缓冲条
    store.commit('setAudioBuffering', true);
    // [播客改造 A-7.10] 切集淡入淡出：若旧 howler 还在播，先做 ~180ms 淡出再 unload，
    // 避免硬切的"啪嗒"感。淡入由 play() 内已有的 fade(0, volume, PLAY_PAUSE_FADE_DURATION) 完成。
    const old = this._howler;
    if (old && typeof old.playing === 'function' && old.playing()) {
      await new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        try {
          old.once('fade', finish);
          old.fade(old.volume(), 0, 180);
        } catch (e) {
          finish();
        }
        // 兜底：极少情况下 'fade' 事件可能不触发
        setTimeout(finish, 220);
      });
      // [S1 修复 bug-A] await 期间可能已经被新的调用接替，旧的不再继续
      if (myToken !== this._playSourceToken) return;
    }
    Howler.unload();
    if (myToken !== this._playSourceToken) return;
    // [播客改造] 播客音频常见格式为 m4a/aac/mp4，加入 format 嗅探列表。
    this._howler = new Howl({
      src: [source],
      html5: true,
      preload: true,
      format: ['mp3', 'flac', 'm4a', 'aac', 'mp4'],
      onend: () => {
        this._nextTrackCallback();
      },
    });
    // [播客改造] 新建 howler 实例后立即应用当前倍速，避免换曲后被重置为 1.0
    if (this._playbackRate && this._playbackRate !== 1) {
      this._howler.rate(this._playbackRate);
    }
    // [S1 修复] seek 在 'load' 时触发，与 play 互不干扰；先注册（once 按注册顺序）
    if (seekToOnLoad > 1) {
      const doSeek = () => {
        try {
          this._howler?.seek(seekToOnLoad);
          this._progress = seekToOnLoad;
          if (this._currentTrack?.name) setTitle(this._currentTrack);
        } catch (e) {
          /* ignore */
        }
      };
      if (this._howler.state() === 'loaded') {
        doSeek();
      } else {
        this._howler.once('load', doSeek);
      }
    }
    this._howler.on('loaderror', (_, errCode) => {
      // https://developer.mozilla.org/en-US/docs/Web/API/MediaError/code
      // code 3: MEDIA_ERR_DECODE
      if (errCode === 3) {
        this._playNextTrack(this._isPersonalFM);
      } else if (errCode === 4) {
        // code 4: MEDIA_ERR_SRC_NOT_SUPPORTED
        store.dispatch('showToast', `无法播放: 不支持的音频格式`);
        this._playNextTrack(this._isPersonalFM);
      } else {
        const t = this.progress;
        this._replaceCurrentTrackAudio(this.currentTrack, false, false).then(
          replaced => {
            // 如果 replaced 为 false，代表当前的 track 已经不是这里想要替换的track
            // 此时则不修改当前的歌曲进度
            if (replaced) {
              this._howler?.seek(t);
              this.play();
            }
          }
        );
      }
    });
    if (autoplay) {
      this.play();
      if (this._currentTrack.name) {
        setTitle(this._currentTrack);
      }
      setTrayLikeState(store.state.liked.songs.includes(this.currentTrack.id));
    }
    this.setOutputDevice();
  }
  _getAudioSourceBlobURL(data) {
    // Create a new object URL.
    const source = URL.createObjectURL(new Blob([data]));

    // Clean up the previous object URLs since we've created a new one.
    // Revoke object URLs can release the memory taken by a Blob,
    // which occupied a large proportion of memory.
    for (const url in this.createdBlobRecords) {
      URL.revokeObjectURL(url);
    }

    // Then, we replace the createBlobRecords with new one with
    // our newly created object URL.
    this.createdBlobRecords = [source];

    return source;
  }
  _getAudioSourceFromCache(id) {
    return getTrackSource(id).then(t => {
      if (!t) return null;
      return this._getAudioSourceBlobURL(t.source);
    });
  }
  _getAudioSourceFromNetease(track) {
    if (isAccountLoggedIn()) {
      return getMP3(track.id).then(result => {
        if (!result.data[0]) return null;
        if (!result.data[0].url) return null;
        if (result.data[0].freeTrialInfo !== null) return null; // 跳过只能试听的歌曲
        const source = result.data[0].url.replace(/^http:/, 'https:');
        if (store.state.settings.automaticallyCacheSongs) {
          cacheTrackSource(track, source, result.data[0].br);
        }
        return source;
      });
    } else {
      return new Promise(resolve => {
        resolve(`https://music.163.com/song/media/outer/url?id=${track.id}`);
      });
    }
  }
  async _getAudioSourceFromUnblockMusic(track) {
    console.debug(`[debug][Player.js] _getAudioSourceFromUnblockMusic`);

    if (
      process.env.IS_ELECTRON !== true ||
      store.state.settings.enableUnblockNeteaseMusic === false
    ) {
      return null;
    }

    /**
     *
     * @param {string=} searchMode
     * @returns {import("@unblockneteasemusic/rust-napi").SearchMode}
     */
    const determineSearchMode = searchMode => {
      /**
       * FastFirst = 0
       * OrderFirst = 1
       */
      switch (searchMode) {
        case 'fast-first':
          return 0;
        case 'order-first':
          return 1;
        default:
          return 0;
      }
    };

    const retrieveSongInfo = await ipcRenderer.invoke(
      'unblock-music',
      store.state.settings.unmSource,
      track,
      {
        enableFlac: store.state.settings.unmEnableFlac || null,
        proxyUri: store.state.settings.unmProxyUri || null,
        searchMode: determineSearchMode(store.state.settings.unmSearchMode),
        config: {
          'joox:cookie': store.state.settings.unmJooxCookie || null,
          'qq:cookie': store.state.settings.unmQQCookie || null,
          'ytdl:exe': store.state.settings.unmYtDlExe || null,
        },
      }
    );

    if (store.state.settings.automaticallyCacheSongs && retrieveSongInfo?.url) {
      // 对于来自 bilibili 的音源
      // retrieveSongInfo.url 是音频数据的base64编码
      // 其他音源为实际url
      const url =
        retrieveSongInfo.source === 'bilibili'
          ? `data:application/octet-stream;base64,${retrieveSongInfo.url}`
          : retrieveSongInfo.url;
      cacheTrackSource(track, url, 128000, `unm:${retrieveSongInfo.source}`);
    }

    if (!retrieveSongInfo) {
      return null;
    }

    if (retrieveSongInfo.source !== 'bilibili') {
      return retrieveSongInfo.url;
    }

    const buffer = base642Buffer(retrieveSongInfo.url);
    return this._getAudioSourceBlobURL(buffer);
  }
  _getAudioSource(track) {
    // [播客改造] 播客单集自带音频直链，跳过网易云查询链。
    // [B-35] 已下载 → 同步从 store.podcastDownloads.pathMap 取本地路径返 file://。
    //   原来用动态 import('@/utils/db') 异步查，不可靠（顶部 Dexie get 报错时回退在线，
    //   而在线 url 在渲染进程走 Chromium 代理被 ERR_CONNECTION_CLOSED 拦 → 卡死）。
    //   file:// 经实测可正常播放本地文件，pathMap 在启动/下载完成时已就绪。
    if (track && track.podcastAudioUrl) {
      if (track.podcastEpisodeId) {
        const pathMap =
          (store.state.podcastDownloads &&
            store.state.podcastDownloads.pathMap) ||
          {};
        const fp = pathMap[track.podcastEpisodeId];
        if (fp) {
          const norm = String(fp).replace(/\\/g, '/').replace(/^\/+/, '');
          return Promise.resolve('file:///' + norm);
        }
      }
      return Promise.resolve(track.podcastAudioUrl);
    }
    return this._getAudioSourceFromCache(String(track.id))
      .then(source => {
        return source ?? this._getAudioSourceFromNetease(track);
      })
      .then(source => {
        return source ?? this._getAudioSourceFromUnblockMusic(track);
      });
  }
  _replaceCurrentTrack(
    id,
    autoplay = true,
    ifUnplayableThen = UNPLAYABLE_CONDITION.PLAY_NEXT_TRACK
  ) {
    // [播客改造 A-7.3 / 同根 S-1] 播客单集 id（pod:xxx）不能查网易云。
    // 若是当前曲（列表循环/单曲循环都会 next 回到自己），原地 seek(0) 重播；
    // 若是别的播客 id（A-7.5 加入播放列表后才会发生），目前简单 noop。
    if (typeof id === 'string' && String(id).startsWith('pod:')) {
      if (this._currentTrack && this._currentTrack.id === id) {
        this._howler?.seek(0);
        if (autoplay) this.play();
        return Promise.resolve(true);
      }
      console.warn(
        '[Player] 暂不支持跳到非当前的播客单集（待 A-7.5 实现）：',
        id
      );
      return Promise.resolve(false);
    }
    if (autoplay && this._currentTrack.name) {
      this._scrobble(this.currentTrack, this._howler?.seek());
    }
    return getTrackDetail(id).then(data => {
      const track = data.songs[0];
      this._currentTrack = track;
      this._updateMediaSessionMetaData(track);
      return this._replaceCurrentTrackAudio(
        track,
        autoplay,
        true,
        ifUnplayableThen
      );
    });
  }
  /**
   * @returns 是否成功加载音频，并使用加载完成的音频替换了howler实例
   */
  _replaceCurrentTrackAudio(
    track,
    autoplay,
    isCacheNextTrack,
    ifUnplayableThen = UNPLAYABLE_CONDITION.PLAY_NEXT_TRACK,
    seekToOnLoad = 0
  ) {
    return this._getAudioSource(track).then(async source => {
      if (source) {
        let replaced = false;
        if (track.id === this.currentTrackID) {
          // [S1 修复 bug-B] 必须 await，否则后续代码会注册到**旧** howler 上
          await this._playAudioSource(source, autoplay, seekToOnLoad);
          replaced = true;
        }
        if (isCacheNextTrack) {
          this._cacheNextTrack();
        }
        return replaced;
      } else {
        store.dispatch('showToast', `无法播放 ${track.name}`);
        switch (ifUnplayableThen) {
          case UNPLAYABLE_CONDITION.PLAY_NEXT_TRACK:
            this._playNextTrack(this.isPersonalFM);
            break;
          case UNPLAYABLE_CONDITION.PLAY_PREV_TRACK:
            this.playPrevTrack();
            break;
          default:
            store.dispatch(
              'showToast',
              `undefined Unplayable condition: ${ifUnplayableThen}`
            );
            break;
        }
        return false;
      }
    });
  }
  _cacheNextTrack() {
    let nextTrackID = this._isPersonalFM
      ? this._personalFMNextTrack?.id ?? 0
      : this._getNextTrack()[0];
    if (!nextTrackID) return;
    if (this._personalFMTrack.id == nextTrackID) return;
    getTrackDetail(nextTrackID).then(data => {
      let track = data.songs[0];
      this._getAudioSource(track);
    });
  }
  _loadSelfFromLocalStorage() {
    const player = JSON.parse(localStorage.getItem('player'));
    if (!player) return;
    for (const [key, value] of Object.entries(player)) {
      this[key] = value;
    }
  }
  _initMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => {
        this.play();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        this.pause();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        this.playPrevTrack();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        this._playNextTrack(this.isPersonalFM);
      });
      navigator.mediaSession.setActionHandler('stop', () => {
        this.pause();
      });
      navigator.mediaSession.setActionHandler('seekto', event => {
        this.seek(event.seekTime);
        this._updateMediaSessionPositionState();
      });
      navigator.mediaSession.setActionHandler('seekbackward', event => {
        this.seek(this.seek() - (event.seekOffset || 10));
        this._updateMediaSessionPositionState();
      });
      navigator.mediaSession.setActionHandler('seekforward', event => {
        this.seek(this.seek() + (event.seekOffset || 10));
        this._updateMediaSessionPositionState();
      });
    }
  }
  _updateMediaSessionMetaData(track) {
    if ('mediaSession' in navigator === false) {
      return;
    }
    let artists = track.ar.map(a => a.name);
    // [B-64] 播客封面是外部直链，拼网易云 ?param=NxN 尺寸参数会指向不存在的资源 → 系统媒体控件封面空白。
    //   仅对网易云曲目拼 param，播客用原始 URL。
    const picUrl = track.al.picUrl;
    const artwork = track.podcastEpisodeId
      ? [{ src: picUrl, type: 'image/jpg', sizes: '512x512' }]
      : [
          {
            src: picUrl + '?param=224y224',
            type: 'image/jpg',
            sizes: '224x224',
          },
          {
            src: picUrl + '?param=512y512',
            type: 'image/jpg',
            sizes: '512x512',
          },
        ];
    const metadata = {
      title: track.name,
      artist: artists.join(','),
      album: track.al.name,
      artwork,
      length: this.currentTrackDuration,
      trackId: this.current,
      url: '/trackid/' + track.id,
    };

    navigator.mediaSession.metadata = new window.MediaMetadata(metadata);
    if (isCreateMpris) {
      this._updateMprisState(track, metadata);
    }
  }
  // OSDLyrics 会检测 Mpris 状态并寻找对应歌词文件，所以要在更新 Mpris 状态之前保证歌词下载完成
  async _updateMprisState(track, metadata) {
    if (!store.state.settings.enableOsdlyricsSupport) {
      return ipcRenderer?.send('metadata', metadata);
    }

    let lyricContent = await getLyric(track.id);

    if (!lyricContent.lrc || !lyricContent.lrc.lyric) {
      return ipcRenderer?.send('metadata', metadata);
    }

    ipcRenderer.send('sendLyrics', {
      track,
      lyrics: lyricContent.lrc.lyric,
    });

    ipcRenderer.on('saveLyricFinished', () => {
      ipcRenderer?.send('metadata', metadata);
    });
  }
  _updateMediaSessionPositionState() {
    if ('mediaSession' in navigator === false) {
      return;
    }
    if ('setPositionState' in navigator.mediaSession) {
      navigator.mediaSession.setPositionState({
        duration: ~~(this.currentTrack.dt / 1000),
        playbackRate: 1.0,
        position: this.seek(),
      });
    }
  }
  _nextTrackCallback() {
    this._scrobble(this._currentTrack, 0, true);
    if (!this.isPersonalFM && this.repeatMode === 'one') {
      // [播客改造 A-7.3] 播客单曲循环：把已保存进度归零，再走通用重播路径
      const t = this._currentTrack;
      if (t && t.podcastEpisodeId) {
        saveEpisodeProgress(t.podcastEpisodeId, 0).catch(() => {});
      }
      this._replaceCurrentTrack(this.currentTrackID);
      return;
    }
    // [播客改造 A-24] 播客播放结束 → 优先从队列取下一首
    const cur = this._currentTrack;
    if (cur && cur.podcastEpisodeId) {
      const queue = store.state.podcastQueue;
      if (queue && queue.length > 0) {
        const next = queue[0];
        store.commit('removeFromQueue', next.id);
        // [A-24 改] 标记自然播完，让 playPodcastEpisode 不再把旧曲入队
        this._justEnded = true;
        this.playPodcastEpisode(next, next.podcastTitle || '');
        return;
      }
    }
    this._playNextTrack(this.isPersonalFM);
  }
  _loadPersonalFMNextTrack() {
    if (this._personalFMNextLoading) {
      return [false, undefined];
    }
    this._personalFMNextLoading = true;
    return personalFM()
      .then(result => {
        if (!result || !result.data) {
          this._personalFMNextTrack = undefined;
        } else {
          this._personalFMNextTrack = result.data[0];
          this._cacheNextTrack(); // cache next track
        }
        this._personalFMNextLoading = false;
        return [true, this._personalFMNextTrack];
      })
      .catch(() => {
        this._personalFMNextTrack = undefined;
        this._personalFMNextLoading = false;
        return [false, this._personalFMNextTrack];
      });
  }
  _playDiscordPresence(track, seekTime = 0) {
    if (
      process.env.IS_ELECTRON !== true ||
      store.state.settings.enableDiscordRichPresence === false
    ) {
      return null;
    }
    let copyTrack = { ...track };
    copyTrack.dt -= seekTime * 1000;
    ipcRenderer?.send('playDiscordPresence', copyTrack);
  }
  _pauseDiscordPresence(track) {
    if (
      process.env.IS_ELECTRON !== true ||
      store.state.settings.enableDiscordRichPresence === false
    ) {
      return null;
    }
    ipcRenderer?.send('pauseDiscordPresence', track);
  }
  _playNextTrack(isPersonal) {
    if (isPersonal) {
      this.playNextFMTrack();
    } else {
      this.playNextTrack();
    }
  }

  appendTrack(trackID) {
    this.list.append(trackID);
  }
  playNextTrack() {
    // TODO: 切换歌曲时增加加载中的状态
    const [trackID, index] = this._getNextTrack();
    if (trackID === undefined) {
      this._howler?.stop();
      this._setPlaying(false);
      return false;
    }
    let next = index;
    if (index === INDEX_IN_PLAY_NEXT) {
      this._playNextList.shift();
      next = this.current;
    }
    this.current = next;
    this._replaceCurrentTrack(trackID);
    return true;
  }
  async playNextFMTrack() {
    if (this._personalFMLoading) {
      return false;
    }

    this._isPersonalFM = true;
    if (!this._personalFMNextTrack) {
      this._personalFMLoading = true;
      let result = null;
      let retryCount = 5;
      for (; retryCount >= 0; retryCount--) {
        result = await personalFM().catch(() => null);
        if (!result) {
          this._personalFMLoading = false;
          store.dispatch('showToast', 'personal fm timeout');
          return false;
        }
        if (result.data?.length > 0) {
          break;
        } else if (retryCount > 0) {
          await delay(1000);
        }
      }
      this._personalFMLoading = false;

      if (retryCount < 0) {
        let content = '获取私人FM数据时重试次数过多，请手动切换下一首';
        store.dispatch('showToast', content);
        console.log(content);
        return false;
      }
      // 这里只能拿到一条数据
      this._personalFMTrack = result.data[0];
    } else {
      if (this._personalFMNextTrack.id === this._personalFMTrack.id) {
        return false;
      }
      this._personalFMTrack = this._personalFMNextTrack;
    }
    if (this._isPersonalFM) {
      this._replaceCurrentTrack(this._personalFMTrack.id);
    }
    this._loadPersonalFMNextTrack();
    return true;
  }
  playPrevTrack() {
    const [trackID, index] = this._getPrevTrack();
    if (trackID === undefined) return false;
    this.current = index;
    this._replaceCurrentTrack(
      trackID,
      true,
      UNPLAYABLE_CONDITION.PLAY_PREV_TRACK
    );
    return true;
  }
  saveSelfToLocalStorage() {
    let player = {};
    for (let [key, value] of Object.entries(this)) {
      if (excludeSaveKeys.includes(key)) continue;
      player[key] = value;
    }

    localStorage.setItem('player', JSON.stringify(player));
  }

  pause() {
    this._howler?.fade(this.volume, 0, PLAY_PAUSE_FADE_DURATION);

    this._howler?.once('fade', () => {
      this._howler?.pause();
      this._setPlaying(false);
      setTitle(null);
      this._pauseDiscordPresence(this._currentTrack);
    });
  }
  play() {
    if (this._howler?.playing()) return;

    this._howler?.play();

    this._howler?.once('play', () => {
      // [播客改造 C-14] 真的开始出声 → 清除缓冲态
      store.commit('setAudioBuffering', false);
      // [bug 修复] 监听 audio 元素的 waiting/playing 事件，
      // 用户拖到未缓冲位置时会触发 waiting，缓冲完成后触发 playing
      const node = this._howler?._sounds?.[0]?._node;
      if (node && !node.__podBufferHooked) {
        node.__podBufferHooked = true;
        node.addEventListener('waiting', () => {
          store.commit('setAudioBuffering', true);
        });
        node.addEventListener('playing', () => {
          store.commit('setAudioBuffering', false);
        });
        node.addEventListener('canplay', () => {
          store.commit('setAudioBuffering', false);
        });
      }
      this._howler?.fade(0, this.volume, PLAY_PAUSE_FADE_DURATION);

      // 播放时确保开启player.
      // 避免因"忘记设置"导致在播放时播放器不显示的Bug
      this._enabled = true;
      this._setPlaying(true);
      if (this._currentTrack.name) {
        setTitle(this._currentTrack);
      }
      this._playDiscordPresence(this._currentTrack, this.seek());
      if (store.state.lastfm.key !== undefined) {
        trackUpdateNowPlaying({
          artist: this.currentTrack.ar[0].name,
          track: this.currentTrack.name,
          album: this.currentTrack.al.name,
          trackNumber: this.currentTrack.no,
          duration: ~~(this.currentTrack.dt / 1000),
        });
      }
    });
  }
  playOrPause() {
    // [B-31 bug 修] 应用刚启动时 _currentTrack 来自 localStorage，但 _howler 尚未实例化
    //（_loadCurrentPodcastEpisode 是 autoplay=false 时只 setup 不 load）。
    // 用户点 bar 上的 play 按钮 → this._howler?.play() 静默失败，看起来"没反应"。
    // 这里检测：若是播客 track 且 howler 缺失 → 主动 load + autoplay。
    if (!this._howler && this._currentTrack?.podcastEpisodeId) {
      this._loadCurrentPodcastEpisode(true).catch(() => {});
      return;
    }
    if (this._howler?.playing()) {
      this.pause();
    } else {
      this.play();
    }
  }
  seek(time = null, sendMpris = true) {
    if (isCreateMpris && sendMpris && time) {
      ipcRenderer?.send('seeked', time);
    }
    if (time !== null) {
      this._howler?.seek(time);
      if (this._playing)
        this._playDiscordPresence(this._currentTrack, this.seek(null, false));
    }
    return this._howler === null ? 0 : this._howler.seek();
  }
  mute() {
    if (this.volume === 0) {
      this.volume = this._volumeBeforeMuted;
    } else {
      this._volumeBeforeMuted = this.volume;
      this.volume = 0;
    }
  }
  setOutputDevice() {
    if (this._howler?._sounds.length <= 0 || !this._howler?._sounds[0]._node) {
      return;
    }
    this._howler?._sounds[0]._node.setSinkId(store.state.settings.outputDevice);
  }

  replacePlaylist(
    trackIDs,
    playlistSourceID,
    playlistSourceType,
    autoPlayTrackID = 'first'
  ) {
    this._isPersonalFM = false;
    this.list = trackIDs;
    this.current = 0;
    this._playlistSource = {
      type: playlistSourceType,
      id: playlistSourceID,
    };
    if (this.shuffle) this._shuffleTheList(autoPlayTrackID);
    if (autoPlayTrackID === 'first') {
      this._replaceCurrentTrack(this.list[0]);
    } else {
      this.current = this.list.indexOf(autoPlayTrackID);
      this._replaceCurrentTrack(autoPlayTrackID);
    }
  }
  playAlbumByID(id, trackID = 'first') {
    getAlbum(id).then(data => {
      let trackIDs = data.songs.map(t => t.id);
      this.replacePlaylist(trackIDs, id, 'album', trackID);
    });
  }
  playPlaylistByID(id, trackID = 'first', noCache = false) {
    console.debug(
      `[debug][Player.js] playPlaylistByID 👉 id:${id} trackID:${trackID} noCache:${noCache}`
    );
    getPlaylistDetail(id, noCache).then(data => {
      let trackIDs = data.playlist.trackIds.map(t => t.id);
      this.replacePlaylist(trackIDs, id, 'playlist', trackID);
    });
  }
  playArtistByID(id, trackID = 'first') {
    getArtist(id).then(data => {
      let trackIDs = data.hotSongs.map(t => t.id);
      this.replacePlaylist(trackIDs, id, 'artist', trackID);
    });
  }
  playTrackOnListByID(id, listName = 'default') {
    if (listName === 'default') {
      this._current = this._list.findIndex(t => t === id);
    }
    this._replaceCurrentTrack(id);
  }
  playIntelligenceListById(id, trackID = 'first', noCache = false) {
    getPlaylistDetail(id, noCache).then(data => {
      const randomId = Math.floor(
        Math.random() * (data.playlist.trackIds.length + 1)
      );
      const songId = data.playlist.trackIds[randomId].id;
      intelligencePlaylist({ id: songId, pid: id }).then(result => {
        let trackIDs = result.data.map(t => t.id);
        this.replacePlaylist(trackIDs, id, 'playlist', trackID);
      });
    });
  }
  addTrackToPlayNext(trackID, playNow = false) {
    this._playNextList.push(trackID);
    if (playNow) {
      this.playNextTrack();
    }
  }
  playPersonalFM() {
    this._isPersonalFM = true;
    if (this.currentTrackID !== this._personalFMTrack.id) {
      this._replaceCurrentTrack(this._personalFMTrack.id, true);
    } else {
      this.playOrPause();
    }
  }
  async moveToFMTrash() {
    this._isPersonalFM = true;
    let id = this._personalFMTrack.id;
    if (await this.playNextFMTrack()) {
      fmTrash(id);
    }
  }

  sendSelfToIpcMain() {
    if (process.env.IS_ELECTRON !== true) return false;
    let liked = store.state.liked.songs.includes(this.currentTrack.id);
    ipcRenderer?.send('player', {
      playing: this.playing,
      likedCurrentTrack: liked,
    });
    setTrayLikeState(liked);
  }

  switchRepeatMode() {
    if (this._repeatMode === 'on') {
      this.repeatMode = 'one';
    } else if (this._repeatMode === 'one') {
      this.repeatMode = 'off';
    } else {
      this.repeatMode = 'on';
    }
    if (isCreateMpris) {
      ipcRenderer?.send('switchRepeatMode', this.repeatMode);
    }
  }
  switchShuffle() {
    this.shuffle = !this.shuffle;
    if (isCreateMpris) {
      ipcRenderer?.send('switchShuffle', this.shuffle);
    }
  }
  switchReversed() {
    this.reversed = !this.reversed;
  }

  clearPlayNextList() {
    this._playNextList = [];
  }
  removeTrackFromQueue(index) {
    this._playNextList.splice(index, 1);
  }

  // [播客改造] 播放一集播客。
  // episode 是 utils/podcast/rssParser.js 解析出的单集对象。
  // 这里把它包装成播放引擎认识的 "track" 形状（含 al/ar/dt 等字段），
  // 关键扩展字段是 podcastAudioUrl —— 它让 _getAudioSource 直接返回音频地址，
  // 跳过整条网易云查询链。
  playPodcastEpisode(episode, podcastTitle) {
    // [B-64] _justEnded 复位必须在任何 early-return 之前：否则取到无音频地址的队列项早退时，
    //   _justEnded 滞留 true，下次手动切集会误判为"自动续播"而丢失当前未播完单集的入队保留。
    const justEnded = this._justEnded;
    this._justEnded = false;
    if (!episode?.audioUrl) {
      store.dispatch('showToast', '该单集没有音频地址');
      return;
    }
    // [A-24 改] 切换前：旧曲（如果未播完）放回队列头部，下次还能播
    // _justEnded=true 表示当前是 onend 自动续播，旧曲已播完，不入队
    const oldTrack = this._currentTrack;
    if (oldTrack && oldTrack.podcastEpisodeId && this._howler) {
      const curPos = Math.floor(this._howler.seek() || 0);
      if (curPos > 0) {
        saveEpisodeProgress(oldTrack.podcastEpisodeId, curPos);
      }
      const dur = (oldTrack.dt || 0) / 1000;
      // 切换到不同 episode 且旧曲没播完 → 入队保留
      if (
        !justEnded &&
        oldTrack.podcastEpisodeId !== episode.id &&
        dur > 0 &&
        curPos > 0 &&
        curPos < dur - 30
      ) {
        store.commit('enqueueEpisodeAtFront', {
          id: oldTrack.podcastEpisodeId,
          guid: (oldTrack.podcastEpisodeId || '').split('::').pop() || '',
          title: oldTrack.name || '',
          audioUrl: oldTrack.podcastAudioUrl || '',
          coverUrl: (oldTrack.al && oldTrack.al.picUrl) || '',
          duration: Math.floor(dur),
          podcastId: (oldTrack.al && oldTrack.al.id) || '',
          podcastTitle: (oldTrack.al && oldTrack.al.name) || '',
        });
      }
    }
    // 如果新曲已在队列里，先移除（避免重复）
    if (episode.id) {
      store.commit('removeFromQueue', episode.id);
    }
    const track = {
      // 用一个不会与网易云 id 冲突的字符串 id
      id: `pod:${episode.id}`,
      name: episode.title || '未命名单集',
      ar: [{ id: 0, name: podcastTitle || episode.podcastId || '' }],
      al: {
        id: 0,
        name: podcastTitle || '',
        picUrl:
          episode.coverUrl ||
          'http://s4.music.126.net/style/web2/img/default/default_album.jpg',
      },
      dt: (episode.duration || 0) * 1000, // 毫秒
      podcastAudioUrl: episode.audioUrl,
      podcastEpisodeId: episode.id,
      podcastId: episode.podcastId || '', // [B-64] 透传 podcastId，供收藏记录关联节目(actions 优先用它)
    };

    this._enabled = true;
    this._isPersonalFM = false;
    // 单集播放列表，只有它一首；source 类型用 'podcast' 便于将来区分
    this._list = [track.id];
    this._current = 0;
    this._playlistSource = { type: 'podcast', id: episode.podcastId };
    this._currentTrack = track;
    this._updateMediaSessionMetaData(track);

    // [S1] 用户一点就立即显示加载（不要等异步链）
    store.commit('setAudioBuffering', true);
    // [S1] 触发 Vue 重渲染让 UI 立即看到新封面/标题
    if (track.name) setTitle(track);

    // 走统一恢复路径（autoplay=true），含进度续播
    return this._loadCurrentPodcastEpisode(true);
  }

  // [播客改造 S-1] 按 this._currentTrack（必须是已构造好的播客 track）装载 howler，
  // 不查网易云。autoplay 控制是否自动播放（重启时为 false，新点一集时为 true）。
  // 同时从 episodeProgress 表读上次进度，howler 加载完成后 seek 过去。
  async _loadCurrentPodcastEpisode(autoplay) {
    const track = this._currentTrack;
    if (!track || !track.podcastAudioUrl) return false;

    // [播客改造 progress-bug] 立即调 setTitle 让 document.title 含节目名
    // → state.title 一定与原默认值"YesPlayMusic"不同 → Vue 重渲染读到正确 _progress
    // 之前用 commit('updateTitle', document.title) 不工作的原因：重启时 title 没变化
    if (track.name) setTitle(track);

    // 读上次进度（只用按集存的 episodeProgress，不用全局 fallback——
    // 之前的 fallback 在切到新集时会读到上一集还在写入的全局进度，造成"继承上一集进度" bug）
    let savedPos = 0;
    try {
      const saved = await getEpisodeProgress(track.podcastEpisodeId);
      if (saved && typeof saved.position === 'number') {
        savedPos = saved.position;
      }
    } catch (e) {
      console.warn('[播客 S-1] 读取单集进度失败：', e);
    }
    // [S 级 bug 修] 已听完的单集再点播放会 seek 到尾立刻 onend → 跳下一首。
    // 检查进度是否接近结尾，若是清零让它从 0 开始；同时清掉 listenStats 的 bits
    // （totalPlayWallSec 保留，累计总收听时长不清零）。
    const trackDurSec = Math.floor((track.dt || 0) / 1000);
    if (trackDurSec > 0 && savedPos > trackDurSec - 30) {
      savedPos = 0;
      saveEpisodeProgress(track.podcastEpisodeId, 0).catch(() => {});
      resetEpisodeListening(track.podcastEpisodeId).catch(() => {});
    }
    // 每次切到新单集，重置 listening tick 的 lastSec（让首秒不会被错判为跳跃）
    this._lastListenSec = -1;
    // [B-31] 切集时重置广播缓存（让 5% 步进 / completed 在新集第一次 tick 就能触发广播）
    this._lastListenStep = -1;
    this._lastListenCompleted = false;

    // [S1 修复 bug-B] seek 逻辑下沉到 _playAudioSource 内部，
    // 保证注册在**新** howler 上（之前因为竞争注册到旧 howler，永远不触发）
    return await this._replaceCurrentTrackAudio(
      track,
      autoplay,
      false,
      undefined,
      savedPos
    );
  }
}
