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
// [缓存·B] 流播缓存代理 URL 构造 + 播放命中本地触碰 lastAccess(LRU)
import {
  buildAudioProxyUrl,
  touchDownloadAccess,
  relinkDownloads,
} from '@/utils/podcast/downloads';
// [NAS] 音源②级：本地未命中→NAS 在线则解析流URL，失败/不可用返回 null 直落 CDN
import {
  resolveNasUrl,
  nasActiveName,
  markNasDown,
} from '@/utils/podcast/nasSource';
// [播客改造] 真实收听统计
// [B69-F5 降频] tickListen(逐秒) → tickListenBatch(批量)：每秒 tick 在 Player 端内存累积，
//   每 LISTEN_FLUSH_SEC 秒批量落盘一次，写事务量降到约 1/N。
import {
  tickListenBatch,
  resetEpisodeListening,
} from '@/utils/podcast/listening';
import {
  advanceListenCoverage,
  createListenCoverageAnchor,
  toListenBatchPayload,
} from '@/utils/podcast/listenCoverage';
import { removeDownload } from '@/utils/podcast/downloads';
import { isCreateMpris, isCreateTray } from '@/utils/platform';
import { Howl, Howler } from 'howler';
import shuffle from 'lodash/shuffle';
import { decode as base642Buffer } from '@/utils/base64';
import {
  createPlaybackSuspendSnapshot,
  planPlaybackResume,
} from '@/utils/powerResumePolicy';

// [D163后续·gap①] 已对某集触发过"本地文件缺失→relink 自愈"的集合：每集每会话只试一次，
//   避免文件真被删时每次播放都重扫磁盘。
const _relinkTriedIds = new Set();

const PLAY_PAUSE_FADE_DURATION = 200;

// [C3 音量渐入] 久未播/隔天打开 + 音量>50% 时的较长渐入时长(ms) + 触发的"久未播"空闲阈值。
//   1.2s = 能感知"轻轻推上来"又不拖沓的甜区(常规防啪嗒淡入 200ms 几乎无感)；阈值 45 分钟。
const VOLUME_RAMP_DURATION = 1200;
const VOLUME_RAMP_IDLE_MS = 45 * 60 * 1000;

// [B69-F5 降频] 收听统计批量落盘窗口：每累积这么多秒 tick 落盘一次（兼顾写放大↓ 与崩溃丢失上限）。
//   崩溃硬退最多丢 ~LISTEN_FLUSH_SEC 秒收听统计；进度(saveEpisodeProgress)仍逐秒、不受影响。
const LISTEN_FLUSH_SEC = 5;

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
  '_listenCoverageAnchor',
  '_personalFMLoading',
  '_personalFMNextLoading',
];

function setTitle(track) {
  // [B-32] 播客单集：标题栏只显示单集名（不带节目名/app 后缀，
  // 标题栏左侧已有 PodPlayer 品牌区，无需重复）。网易云保持原格式。
  if (!track) {
    document.title = 'PodPlayer';
  } else if (track.podcastEpisodeId) {
    document.title = track.name;
  } else {
    document.title = `${track.name} · ${track.ar[0].name} - PodPlayer`;
  }
  if (isCreateTray) {
    ipcRenderer?.send('updateTrayTooltip', document.title);
  }
  // [启动竞态修 2026-06-16] store=@/store 默认导出；启动期 new Player() 在 store 模块求值完成前被调到
  //   (store/index.js: new Player()→_init→_loadCurrentPodcastEpisode→setTitle)，此刻 store 仍 undefined。
  //   用 ?. 跳过这一次 commit(document.title 已设好、Vuex 也尚未就绪)，避免 'commit of undefined' 未捕获异常
  //   把整个 _loadCurrentPodcastEpisode 中断(连进度读取/音频预置一起没了)。init 完成后的 setTitle 正常 commit。
  store?.commit('updateTitle', document.title);
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
    // [C3 音量渐入] 上次播放态切换的墙钟时刻(ms)。靠 store Proxy 自动落盘到 'player'、重启读回 →
    //   下次 play 据此判"久未播(>45min)/关软件后隔天打开" → 音量做一段较长渐入。0=从未播放。
    this._lastPlayAt = 0;
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
    // [T15] 睡眠「本集结束」队列边界：Vue 层激活 end 模式时置 true；_nextTrackCallback 据此跳过自动续播
    this._sleepEndMode = false;
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
    this._currentAudioSource = '';
    this._powerSuspendSnapshot = null;
    this._handledPowerResumeToken = 0;
    Object.defineProperty(this, '_currentAudioSource', { enumerable: false });
    Object.defineProperty(this, '_powerSuspendSnapshot', { enumerable: false });
    Object.defineProperty(this, '_handledPowerResumeToken', {
      enumerable: false,
    });

    // init
    this._init();

    // [B69-F5 降频] 收听统计批量缓冲（每秒 tick 累积、节流落盘）。退出/刷新前尽力 flush 一次
    //   （best-effort：IndexedDB 写异步，未必赶在卸载前提交；暂停/切集已各自 flush 兜底）。
    this._listenBuf = null;
    this._listenCoverageAnchor = null;
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this._flushListenBuf());
    }

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
    const next = Math.max(0, Math.min(1, Number(volume) || 0));
    // 记住最近可听音量：拖到 0 后 mute() 仍能恢复；从静音滚高后也以新值为准。
    if (next > 0) this._volumeBeforeMuted = next;
    this._volume = next;
    this._howler?.volume(next);
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
    this._invalidateListenCoverage();
    if (this._howler) {
      // [bug 修复] howler 未 loaded 时 seek 不会生效，要等 'load' 再做
      const applySeek = () => {
        try {
          this._howler?.seek(value);
        } catch (e) {
          /* ignore */
        }
      };
      // [播放期坏元素防从0] 播放途中底层 <audio> 已 error/掉到不可播(load 曾成功 → state() 仍恒为
      //   'loaded' 骗过下面判断；但 duration=NaN → howler seek 写不进 currentTime，随后 play() 重载
      //   file:// 归零)。对这种“坏死元素”绝不再原地 seek，改走通用恢复重建续播到 value。
      //   仅当 howler 自认 loaded 时才把 readyState<2 视作坏死(否则是初次加载，应走下面的 once('load'))。
      const node = this._howler._sounds?.[0]?._node;
      const loaded = this._howler.state() === 'loaded';
      if (node && (node.error || (loaded && node.readyState < 2))) {
        this._recoverCurrentSource(value, true); // exact：用户拖动目标，精确(含向后拖)
      } else if (loaded) {
        applySeek();
      } else {
        this._howler.once('load', applySeek);
      }
      this._progress = value;
      // [播客改造 bug] 拖动进度条时立即保存到 episodeProgress
      const t = this._currentTrack;
      if (t && t.podcastEpisodeId && value > 0) {
        saveEpisodeProgress(t.podcastEpisodeId, Math.floor(value)).catch(
          () => {}
        ); // [审P1-2] 拖动 seek 写进度也补 catch(防御纵深)
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
    }

    // [审P2-2] 媒体会话动作处理器**无条件**注册(原先只在 _enabled 时注册，无歌启动则整个缺失)。
    //   且 Player.vue 的 setupMediaControls 重复版已删 → 此处是唯一来源:play/pause 分开正确、
    //   next/prev 与 UI 按钮等价(已核 _playNextTrack(isPersonalFM) === Vue playNextTrack)。
    this._initMediaSession();

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
    // [C3 音量渐入] 记录最后一次播放态切换时刻(play/pause/切歌/停止都经此)，供下次 play 判"久未播/隔天"。
    this._lastPlayAt = Date.now();
    // [B69-F5 降频] 暂停/停止(playing true→false) → 把未落盘的收听缓冲写出，避免丢本窗口统计。
    if (!isPlaying && this._playing) {
      this._flushListenBuf();
      this._invalidateListenCoverage();
    }
    this._playing = isPlaying;
    if (isPlaying && !this._listenCoverageAnchor) {
      this._primeListenCoverage();
    }
    // [审P2-1] 同步系统媒体卡片(SMTC / mediaSession)的播放态——否则暂停后系统"正在播放"卡片仍显
    //   播放中、且 OS 据错误态发反向动作。播放时顺带刷新一次位置锚点(OS 据 playbackRate 外推进度条)。
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
      if (isPlaying) this._updateMediaSessionPositionState();
    }
    if (isCreateTray) {
      ipcRenderer?.send('updateTrayPlayState', this._playing);
    }
  }
  _invalidateListenCoverage() {
    this._listenCoverageAnchor = null;
  }
  _primeListenCoverage() {
    const track = this._currentTrack;
    if (!track || !track.podcastEpisodeId) {
      this._invalidateListenCoverage();
      return;
    }
    let position = this._progress;
    try {
      const current = this._howler && this._howler.seek();
      if (typeof current === 'number' && Number.isFinite(current)) {
        position = current;
      }
    } catch (e) {
      /* keep the latest stable progress */
    }
    this._listenCoverageAnchor = createListenCoverageAnchor(position);
  }
  // [B69-F5 降频] 把累积的收听窗口批量落盘 + 据返回 row 广播 5% 步进/完成给 UI（沿用原逐秒 bump 逻辑）。
  _flushListenBuf() {
    const buf = this._listenBuf;
    if (!buf || !buf.count) return Promise.resolve(); // [审P1-4] 返回 Promise 供退出前 await
    const id = buf.id;
    const totalSec = buf.totalSec;
    const payload = toListenBatchPayload(buf);
    // 同步取出后立即重置窗口(保留 id/totalSec)，防异步落盘期间新 tick 串改本批数据。
    this._listenBuf = {
      id,
      totalSec,
      secs: [],
      wall: 0,
      content: 0,
      count: 0,
    };
    return tickListenBatch(id, totalSec, payload) // [审P1-4] 返回链供退出前 await commit
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
            episodeId: id,
            listenedSec: row.listenedSec || 0,
            totalSec: row.totalSec || 0,
            completed: !!row.completed,
          });
        }
      })
      .catch(() => {});
  }
  // [审P1-4] 退出前一次性 flush：收听缓冲 + 最后一次播放进度，返回 Promise 供主进程 await。
  //   _flushListenBuf 已返回可 await 的 Promise；进度照搬切歌时的存法(seek()>0 才写)。
  flushBeforeExit() {
    const tasks = [this._flushListenBuf()];
    try {
      const t = this._currentTrack;
      if (t && t.podcastEpisodeId && this._howler) {
        const pos = Math.floor(this._howler.seek() || 0);
        if (pos > 0) {
          tasks.push(
            saveEpisodeProgress(t.podcastEpisodeId, pos).catch(() => {})
          );
        }
      }
    } catch (e) {
      /* ignore */
    }
    return Promise.all(tasks).catch(() => {});
  }
  handleSystemSuspend(event) {
    this._flushListenBuf();
    this._invalidateListenCoverage();
    const payload = event || {};
    const track = this._currentTrack || {};
    let progress = Math.max(0, Number(this._progress) || 0);
    try {
      const current = this._howler && this._howler.seek();
      if (typeof current === 'number' && Number.isFinite(current)) {
        progress = Math.max(progress, current);
      }
    } catch (e) {
      /* keep the last stable progress */
    }
    let source = 'unknown';
    if (String(this._currentAudioSource || '').indexOf('file:') === 0) {
      source = 'local';
    } else if (this._nasSourceActive) {
      source = 'nas';
    } else if (this._proxyDirectFallback) {
      source = 'proxy';
    } else if (this._currentAudioSource) {
      source = 'remote';
    }
    this._powerSuspendSnapshot = createPlaybackSuspendSnapshot({
      token: payload.token,
      suspendedAt: payload.at,
      trackId: track.podcastEpisodeId || track.id,
      episodeId: track.podcastEpisodeId || '',
      wasPlaying: this._playing,
      progress,
      source,
      sourceToken: this._playSourceToken,
    });
    return this._powerSuspendSnapshot;
  }
  handleSystemResume(event) {
    this._invalidateListenCoverage();
    const snapshot = this._powerSuspendSnapshot;
    const track = this._currentTrack || {};
    const currentTrackId = track.podcastEpisodeId || track.id;
    const node =
      this._howler && this._howler._sounds[0]
        ? this._howler._sounds[0]._node
        : null;
    const loaded = this._howler && this._howler.state() === 'loaded';
    const nodeUsable = !!(
      node &&
      !node.error &&
      (!loaded || typeof node.readyState !== 'number' || node.readyState >= 2)
    );
    const plan = planPlaybackResume({
      snapshot,
      event,
      handledToken: this._handledPowerResumeToken,
      currentTrackId,
      currentPlaying: this._playing,
      nodeUsable,
    });
    if (plan.consume && snapshot) {
      this._handledPowerResumeToken = snapshot.token;
    }
    if (plan.action !== 'recover') {
      return Promise.resolve({ ok: true, skipped: plan.reason });
    }
    if (!snapshot.episodeId) {
      return Promise.resolve({ ok: true, skipped: 'non-podcast' });
    }

    return this._recoverCurrentSource(plan.progress, true, {
      force: true,
      resolveFresh: true,
      autoplay: plan.autoplay,
    }).then(recovered => {
      if (recovered) return { ok: true, recovered: true };
      if (snapshot.wasPlaying) {
        this._setPlaying(false);
        store.commit('setAudioBuffering', false);
        store.dispatch('showToast', '系统唤醒后播放恢复失败，请点击播放重试');
      }
      return { ok: false, error: 'resume-recovery-failed' };
    });
  }
  // [睡眠到点关机] 先 flush(收听缓冲+当前进度)落盘，再请求主进程关机。
  //   主进程仅 Windows、且仅 prod 真关机(dev/sandbox 干跑)。返回 {ok,dryRun?} 供 UI 提示。
  async requestSystemShutdown() {
    try {
      await this.flushBeforeExit();
    } catch (e) {
      /* flush 失败也继续，别卡住关机意图 */
    }
    if (!ipcRenderer) return { ok: false, reason: 'no-ipc' };
    try {
      return await ipcRenderer.invoke('podcast:systemShutdown');
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
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
      // [P3] NAS 源中途掉线看门狗（本 interval 周期 1s）：howler 自认在播(playing())
      //   但位置连续 ~3s 不前进 = 流停滞(NAS 断网/ABS 冻结)→ 切 CDN 重建 + seek 续播。
      //   仅 NAS 源激活(_nasSourceActive)；本地 file:// / CDN 播放 _nasSourceActive=false 不受影响。
      if (this._nasSourceActive && this._howler.playing()) {
        if (
          this._nasLastPos != null &&
          Math.abs(this._progress - this._nasLastPos) < 0.25
        ) {
          this._nasStallSec = (this._nasStallSec || 0) + 1;
          if (this._nasStallSec >= 3) {
            this._nasStallSec = 0;
            this._failoverNasToCdn();
            return;
          }
        } else {
          this._nasStallSec = 0;
        }
        this._nasLastPos = this._progress;
      } else if (
        // [播放期停滞看门狗·通用] 非 NAS / 非代理(file:// / 直链 CDN)：howler 自认在播但位置连续 ~3s
        //   不前进 = 播放途中停滞且无 'error' 事件(stalled-without-error)→ 通用恢复重建续播 + 清流光。
        //   独立计数器(_genLastPos/_genStallSec)与 NAS 物理隔离；仅 playing() 为真时计数，暂停态零误伤。
        !this._nasSourceActive &&
        !this._proxyDirectFallback &&
        this._howler.playing()
      ) {
        if (
          this._genLastPos != null &&
          Math.abs(this._progress - this._genLastPos) < 0.25
        ) {
          this._genStallSec = (this._genStallSec || 0) + 1;
          if (this._genStallSec >= 3) {
            this._genStallSec = 0;
            this._recoverCurrentSource(this._progress);
            return;
          }
        } else {
          this._genStallSec = 0;
        }
        this._genLastPos = this._progress;
      } else if (this._proxyDirectFallback && this._howler.playing()) {
        // [流播缓存代理停滞看门狗·D163后续] 走 /pa 流播代理(_proxyDirectFallback 已记原始直链)时，
        //   howler 自认在播但位置连续 ~3s 不前进 = 上游 CDN 停滞却不报 'error'(国际 CDN 被污染/冻结的
        //   典型，loaderror/playerror 都不触发)→ 此前无人接管 = 永久缓冲。这里回退原始直链续播
        //   (renderer/Chromium+TUN 是另一条网络路径，给第二次机会)。独立计数器(_proxyLastPos/
        //   _proxyStallSec)与 NAS/通用物理隔离；_fallbackProxyToDirect 会清 _proxyDirectFallback，
        //   之后转由通用看门狗接管直链，不会困在代理里反复停滞。阈值 3s 与 NAS/通用看门狗一致。
        if (
          this._proxyLastPos != null &&
          Math.abs(this._progress - this._proxyLastPos) < 0.25
        ) {
          this._proxyStallSec = (this._proxyStallSec || 0) + 1;
          if (this._proxyStallSec >= 3) {
            this._proxyStallSec = 0;
            this._fallbackProxyToDirect();
            return;
          }
        } else {
          this._proxyStallSec = 0;
        }
        this._proxyLastPos = this._progress;
      }
      const t = this._currentTrack;
      if (
        t &&
        t.podcastEpisodeId &&
        typeof this._progress === 'number' &&
        this._progress > 0
      ) {
        // [审P1-2] 补 .catch：IndexedDB 异常态(锁争用/损坏/配额)下每秒这条若裸跑会一秒一条未捕获
        //   rejection 刷爆控制台、落在数据事故同故障域。失败静默(下一秒会再写)。
        saveEpisodeProgress(
          t.podcastEpisodeId,
          Math.floor(this._progress)
        ).catch(() => {});

        // [缓存·B] 边播边缓存已改为"流播缓存代理"(播放经 /pa 时主进程边喂边写缓存)，
        //   不再于此处后台另起下载(那会与流播抢带宽致卡顿)。见 _getAudioSource ③ + podcastAudioProxy.js。

        // [播客改造] 真实收听统计：每秒 tick
        if (this._playing) {
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
            const rate = this._playbackRate || 1;
            const coverage = advanceListenCoverage(this._listenCoverageAnchor, {
              position: this._progress,
              playbackRate: rate,
              totalSec,
            });
            this._listenCoverageAnchor = coverage.anchor;
            // [B69-F5 降频] 不再每秒各开 2 个 Dexie rw 事务，改为内存累积本窗口
            //   (记 bit 的秒位置 + 墙钟/内容增量)，每 LISTEN_FLUSH_SEC 秒批量落盘(_flushListenBuf)。
            //   切集(id 变)在此 flush 旧集；暂停由 _setPlaying、退出由 beforeunload 兜底 flush。
            let buf = this._listenBuf;
            if (!buf || buf.id !== t.podcastEpisodeId) {
              if (buf) this._flushListenBuf(); // 切集 → 先把上一集缓冲落盘
              buf = this._listenBuf = {
                id: t.podcastEpisodeId,
                totalSec,
                secs: [],
                wall: 0,
                content: 0,
                count: 0,
              };
            }
            buf.totalSec = totalSec; // dt 可能从 0(未知)变为已知
            // 只记录连续播放实际跨过的内容秒；倍速时补齐中间整数秒。
            if (coverage.secs.length) buf.secs.push(...coverage.secs);
            buf.wall += 1; // 真实流逝 1 秒
            buf.content += coverage.contentDeltaSec;
            buf.count += 1;
            if (buf.count >= LISTEN_FLUSH_SEC) this._flushListenBuf();
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
    this._invalidateListenCoverage();
    // [S1 修复 bug-A] 并发令牌：每次调用 +1。如果在 await 期间被新的调用接替，
    // 旧的就此返回，避免两个 howler 同时创建/播放（用户报告"两条音频在响"的根因）
    const myToken = ++this._playSourceToken;

    // [P3] 新一轮播放：重置 NAS 中途掉线看门狗计数（上一集/上次失败的残留清零）。
    this._nasLastPos = null;
    this._nasStallSec = 0;
    // [播放期停滞看门狗·通用] 同步重置通用(file:///CDN)停滞计数，与 NAS 计数物理隔离、互不干扰。
    this._genLastPos = null;
    this._genStallSec = 0;
    // [流播缓存代理停滞看门狗·D163后续] 同步重置代理停滞计数，与 NAS/通用物理隔离、互不干扰。
    this._proxyLastPos = null;
    this._proxyStallSec = 0;

    // [播客改造 C-14] 仅 autoplay=true 时显示缓冲条；重启恢复(autoplay=false)
    // Howler 只是静默 preload，不需要给用户显示"加载中"（且不显示就不会永久停留）
    if (autoplay) store.commit('setAudioBuffering', true);
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
    this._currentAudioSource = source || '';
    // [播客改造] 播客音频常见格式为 m4a/aac/mp4，加入 format 嗅探列表。
    this._howler = new Howl({
      src: [source],
      html5: true,
      preload: true,
      format: ['mp3', 'flac', 'm4a', 'aac', 'mp4'],
      onend: () => {
        this._nextTrackCallback();
      },
      // [审P3-5] 加载成功后「播放期」失败(body 损坏/中途断流/decode 失败)此前无人接 → 不报错不跳集、静默卡住。
      //   补兜底：NAS 源 → 切 CDN 续播；否则提示并跳下一集(与 loaderror 非可恢复分支同口径)。
      onplayerror: (_, err) => {
        console.error('[player] playerror', err);
        if (this._proxyDirectFallback) {
          this._fallbackProxyToDirect(); // [缓存·B] 流播代理出错 → 回退直连续播(绝不让缓存代理害到播放)
          return;
        }
        if (this._nasSourceActive) {
          this._failoverNasToCdn();
          return;
        }
        store.dispatch('showToast', '播放出错，已跳到下一集');
        this._playNextTrack(this._isPersonalFM);
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
    // [播放期故障接管] 给底层 <audio> 挂运行期 'error' 监听：howler html5 只在 load 阶段/play() reject 报错，
    //   对"已 load 成功后、播放途中"的 <audio> 运行期 error 完全不接管。挂在 load 时机(而非 once('play'))
    //   → 暂停态重建(autoplay=false)的元素也覆盖、不必等用户起播；统一交给 _recoverCurrentSource
    //   (它内部把 NAS/代理交还各自 failover、file:///CDN 走通用重建续播，绝不抢路)。__podErrHooked 去重。
    const hookMediaError = () => {
      const node = this._howler?._sounds?.[0]?._node;
      if (node && !node.__podErrHooked) {
        node.__podErrHooked = true;
        node.addEventListener('error', () => {
          const pos = Math.floor(
            Math.max(this._howler?.seek() || 0, this._progress || 0)
          );
          this._recoverCurrentSource(pos);
        });
      }
    };
    if (this._howler.state() === 'loaded') {
      hookMediaError();
    } else {
      this._howler.once('load', hookMediaError);
    }
    this._howler.on('loaderror', (_, errCode) => {
      // [缓存·B] 当前是流播缓存代理且加载失败 → 回退直连续播(绝不让缓存代理害到播放)。
      if (this._proxyDirectFallback) {
        this._fallbackProxyToDirect();
        return;
      }
      // [P3] 当前是 NAS 源且加载失败(任意 code) → 切 CDN 续播，绝不因 NAS 跳过用户想听的集。
      if (this._nasSourceActive) {
        this._failoverNasToCdn();
        return;
      }
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
  // [P3] NAS 源播放中途掉线 → 切 CDN 续播：取掉线位置 → 熔断 NAS → 用原始 CDN 直链
  //   重建 howler 并 seek 回该位置。仅由看门狗 / NAS loaderror 在 _nasSourceActive 时调用。
  _failoverNasToCdn() {
    const track = this._currentTrack;
    if (!track || !track.podcastAudioUrl) return;
    // 防重入：切换中关掉看门狗判定（CDN 重建走 _playAudioSource 不经②，不会再设回 true）。
    this._nasSourceActive = false;
    let pos = 0;
    try {
      const s = this._howler && this._howler.seek();
      const sn = typeof s === 'number' ? s : 0;
      // [seek 回退根治] 出错/被中断的 howl，seek() 可能回 0 → 不能据此从头重建(=用户报的"拖动后从头播放")。
      //   取与 _progress(权威续播位：拖动 set progress 与每秒 tick 都会写)的较大值 → 回退/切源后从所在位置续播。
      pos = Math.floor(Math.max(sn, this._progress || 0));
    } catch (e) {
      pos = Math.floor(this._progress || 0);
    }
    try {
      markNasDown(); // 熔断：30s 内 resolveNasUrl 直返 null → 解析落 CDN；之后自动重探恢复
    } catch (e) {
      /* ignore */
    }
    try {
      store.dispatch('showToast', 'NAS 连接中断，已切到在线音源继续播放');
    } catch (e) {
      /* ignore */
    }
    // 直接用 ③CDN 直链重建（绕过 _getAudioSource 的②NAS）+ seek 回掉线位置续播。
    this._playAudioSource(track.podcastAudioUrl, true, pos);
  }
  // [缓存·B] 流播缓存代理(/pa)加载/播放失败 → 用原始 CDN 直链重建续播(绕过 _getAudioSource 不再走代理)。
  //   绝不让缓存代理影响"能听"这件事;清掉 _proxyDirectFallback 防回退循环。
  _fallbackProxyToDirect() {
    const track = this._currentTrack;
    const direct = this._proxyDirectFallback;
    this._proxyDirectFallback = '';
    if (!track || !direct) return;
    let pos = 0;
    try {
      const s = this._howler && this._howler.seek();
      const sn = typeof s === 'number' ? s : 0;
      // [seek 回退根治] 出错/被中断的 howl，seek() 可能回 0 → 不能据此从头重建(=用户报的"拖动后从头播放")。
      //   取与 _progress(权威续播位：拖动 set progress 与每秒 tick 都会写)的较大值 → 回退/切源后从所在位置续播。
      pos = Math.floor(Math.max(sn, this._progress || 0));
    } catch (e) {
      pos = Math.floor(this._progress || 0);
    }
    console.warn('[player] 流播缓存代理失败，回退直连续播');
    this._playAudioSource(direct, true, pos);
  }
  // [播放期故障通用恢复] 已下载 file:// / 直链 CDN 在“播放途中”底层 <audio> 触发 media error 或长时间
  //   停滞时，howler 的 html5 实现不接管(loaderror/playerror 只覆盖 load 阶段与 play() reject)，
  //   于是：①缓冲流光的 waiting 之后 playing/canplay 永不再来 → 流光卡死；②暂停后拖动时元素已坏死
  //   (duration=NaN/readyState 掉到 0)，howler seek 写不进 currentTime、随后 play() 重载 file:// 归零
  //   → “拖到哪都从头播”。这里把 NAS/代理已验证的“取较大 pos + 重建续播”范式推广到 file:///CDN。
  //   NAS/代理源各有自己的自愈路径，这里一律交还、绝不抢路。
  // exact=true：调用方给的是“用户明确要去的目标位置”(拖动/快进快退)，必须精确到该点(含向后拖)，
  //   不能与 _progress 取 max(否则向后拖会被旧位置吃掉)；exact=false(故障自愈)：seek() 可能回 0，
  //   取 max(pos, seek, _progress) 防归零。
  _recoverCurrentSource(pos, exact = false, options = null) {
    this._invalidateListenCoverage();
    const opts = options || {};
    if (!opts.resolveFresh && this._nasSourceActive)
      return this._failoverNasToCdn();
    if (!opts.resolveFresh && this._proxyDirectFallback)
      return this._fallbackProxyToDirect();
    const track = this._currentTrack;
    const epId = track?.podcastEpisodeId;
    if (!track || !track.podcastAudioUrl) return Promise.resolve(false);
    // 防重入(解析期) + 防回退循环节流(坏文件每次重建都失败时，至少 4s 才再试一次，不打死循环)。
    const now = Date.now();
    if (this._mediaRecovering) return Promise.resolve(true);
    if (!opts.force && this._lastRecoverAt && now - this._lastRecoverAt < 4000)
      return Promise.resolve(false);
    this._lastRecoverAt = now;
    this._mediaRecovering = true;
    // 立即停掉卡死的缓冲流光(重建成功后 once('play') 还会再清一次)。
    try {
      store.commit('setAudioBuffering', false);
    } catch (e) {
      /* ignore */
    }
    const wasPlaying =
      typeof opts.autoplay === 'boolean' ? opts.autoplay : this._playing;
    let p = 0;
    try {
      const s = this._howler && this._howler.seek();
      const sn = typeof s === 'number' ? s : 0;
      // 用户明确目标(exact)→精确取该点(含向后拖)；故障自愈→取较大值防坏元素 seek() 回 0 归零。
      p = exact
        ? Math.max(0, Math.floor(Number(pos) || 0))
        : Math.floor(Math.max(Number(pos) || 0, sn, this._progress || 0));
    } catch (e) {
      p = exact
        ? Math.max(0, Math.floor(Number(pos) || 0))
        : Math.floor(Math.max(Number(pos) || 0, this._progress || 0));
    }
    return this._getAudioSource(track)
      .then(async source => {
        // 重建前再校验当前集未变(迟到的 error/stalled 事件若集已切走，绝不把新集打回旧集)。
        if (!source || this._currentTrack?.podcastEpisodeId !== epId) {
          return false;
        }
        // 经 _playAudioSource：受并发令牌(++_playSourceToken)保护，load 后由 seekToOnLoad 补 seek 到 p。
        await this._playAudioSource(source, wasPlaying, p);
        return true;
      })
      .catch(() => {
        return false;
      })
      .then(result => {
        this._mediaRecovering = false;
        return result;
      });
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
  async _getAudioSource(track) {
    // [P3] 默认标记"当前源非 NAS"；仅②NAS 命中时翻 true，供中途掉线看门狗判定是否介入。
    this._nasSourceActive = false;
    // [缓存·B] 默认清空"代理直连回退"标记；仅③走流播缓存代理时再 set。
    //   否则 file://(本地命中)/NAS 分支会残留上一集的直链 → 它们 loaderror 时误回退到上一集 URL(放错集)。
    this._proxyDirectFallback = '';
    // [播客改造] 播客单集自带音频直链，跳过网易云查询链。
    // [B-35] 已下载 → 同步从 store.podcastDownloads.pathMap 取本地路径返 file://。
    //   原来用动态 import('@/utils/db') 异步查，不可靠（顶部 Dexie get 报错时回退在线，
    //   而在线 url 在渲染进程走 Chromium 代理被 ERR_CONNECTION_CLOSED 拦 → 卡死）。
    //   file:// 经实测可正常播放本地文件，pathMap 在启动/下载完成时已就绪。
    // [NAS] 三级解析链：①本地 file:// → ②NAS(新增) → ③原始 CDN。①③为现状原文不动。
    if (track && track.podcastAudioUrl) {
      if (track.podcastEpisodeId) {
        const pathMap =
          (store.state.podcastDownloads &&
            store.state.podcastDownloads.pathMap) ||
          {};
        const fp = pathMap[track.podcastEpisodeId];
        if (fp) {
          // [D163后续·gap①] 取源时校验本地文件确实存在：pathMap/记录可能指向已被移走或删除的旧路径
          //   (整盘搬迁、用户在文件管理器里删了文件)。原来不校验就返 file://，坏路径要等 howler load
          //   失败再靠 _recoverCurrentSource(D161) 兜——这里在源头拦：存在才返 file://；不存在则当未下载
          //   落 ②NAS/③流播继续能听，并触发一次 relink 自愈记录(按 sha1 反查当前 getPodcastsDir 纠正/复活；
          //   文件真没了则反查不到、记录自然不再命中本地)。
          let fileOk = true;
          if (ipcRenderer) {
            try {
              const r = await ipcRenderer.invoke('podcast:download:exists', {
                filePath: fp,
              });
              // 校验明确返回不存在才判缺失；其余(无返回/异常)按存在处理，不回归(宁可试本地再靠运行期恢复网兜)。
              fileOk = !r || r.exists !== false;
            } catch (e) {
              fileOk = true;
            }
          }
          if (fileOk) {
            touchDownloadAccess(track.podcastEpisodeId); // [C3] 播放命中本地→刷新 lastAccess(LRU)
            const norm = String(fp).replace(/\\/g, '/').replace(/^\/+/, '');
            return Promise.resolve('file:///' + norm); // ① 本地已下载，最高优先级
          }
          console.warn(
            '[player] 已下载记录指向的本地文件不存在，落流播并触发 relink 自愈：',
            fp
          );
          if (!_relinkTriedIds.has(track.podcastEpisodeId)) {
            _relinkTriedIds.add(track.podcastEpisodeId);
            // 不 await：不阻塞本次取源；自愈在后台跑，找回则下次播放即用对的 file:// 路径。
            try {
              relinkDownloads().catch(() => {});
            } catch (e) {
              /* ignore */
            }
          }
          // 不 return：继续往下落 ②NAS → ③CDN/流播代理，本次仍能听。
        }
        // ② [NAS] 本地未命中 → NAS 启用且在线则试解析流 URL；resolveNasUrl 内含熔断
        //    (未启用/不可用同步返回 null、零等待)，失败/查不到也返回 null → 直落 ③CDN，绝不阻断播放。
        try {
          const nasUrl = await resolveNasUrl(track);
          if (nasUrl) {
            this._nasSourceActive = true; // [P3] 本集走 NAS → 启用中途掉线看门狗
            // [NAS] 命中 NAS 时一句轻提示，带上当前连接档名(如"来源于托尼的 NAS")；无名则通用文案。
            try {
              const nm = nasActiveName();
              store.dispatch(
                'showToast',
                nm ? '来源于' + nm + '的 NAS' : '正在从 NAS 就近播放'
              );
            } catch (e2) {
              /* ignore */
            }
            return nasUrl;
          }
        } catch (e) {
          /* 任何异常都落 CDN，保证 NAS 永不影响既有播放 */
        }
      }
      // ③ [缓存·B] 启用缓存 + 代理就绪 → 经本地流播缓存代理(/pa)播放：一条上游连接边喂播放器边写缓存，
      //   播放器读本地增长文件、永不被下载抢带宽。代理 URL 失败 → onloaderror/onplayerror 回退直连。
      const proxyUrl = buildAudioProxyUrl(
        track.podcastEpisodeId,
        track.podcastAudioUrl
      );
      if (proxyUrl) {
        this._proxyDirectFallback = track.podcastAudioUrl; // 记直链供失败回退
        return Promise.resolve(proxyUrl);
      }
      this._proxyDirectFallback = '';
      return Promise.resolve(track.podcastAudioUrl); // ③ 原始 CDN(未启用缓存/代理未就绪)
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
        this._invalidateListenCoverage();
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
    // [#8 repeat 两档] 归一化遗留的列表循环态 'on' → 'off'(已删该档)。直接写私有字段。
    if (this._repeatMode === 'on') this._repeatMode = 'off';
  }
  _initMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => {
        this.play();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        this.pause();
      });
      // [mediaSession 统一·2026-06-16] 播客无"上/下一首"语义 → prev/next/seekbackward/seekforward
      //   四个动作统一做 快退15/快进30(back15/fwd30)，与底栏 ±15/30、ipcRenderer、托盘/应用菜单一致。
      //   作用面=macOS「正在播放」(Control Center)；Windows 的 SMTC 浮窗本 app 未启用(Electron13 不支持，
      //   见 background.js 注释 + [[windows-no-smtc]])、Linux 走 MPRIS 本段被禁。prev/next 不置 null——
      //   否则对应平台的卡片按钮/媒体键会失灵。
      const back15 = () => {
        const cur = this.seek() || 0;
        this.seek(Math.max(0, cur - 15));
        this._updateMediaSessionPositionState();
      };
      const fwd30 = () => {
        const cur = this.seek() || 0;
        const dur = this.currentTrackDuration || 0;
        this.seek(Math.min(Math.max(0, dur - 1), cur + 30));
        this._updateMediaSessionPositionState();
      };
      navigator.mediaSession.setActionHandler('previoustrack', back15);
      navigator.mediaSession.setActionHandler('nexttrack', fwd30);
      navigator.mediaSession.setActionHandler('seekbackward', back15);
      navigator.mediaSession.setActionHandler('seekforward', fwd30);
      navigator.mediaSession.setActionHandler('stop', () => {
        this.pause();
      });
      navigator.mediaSession.setActionHandler('seekto', event => {
        this.seek(event.seekTime);
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
    // [审P2-1 配套] 切歌后刷新系统卡片进度条(时长/位置)，否则 scrubber 要等下次 seek 才出现。
    this._updateMediaSessionPositionState();
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

    // [审P2-5] 原 .on 每次切歌(有歌词+OSDLyrics)注册一个不移除的监听 → 累积 IPC 放大 + MaxListeners 警告。
    //   改 once(收到即自动移除) + 先 removeAllListeners 清掉历史残留，保证任意时刻至多一个监听。
    ipcRenderer.removeAllListeners('saveLyricFinished');
    ipcRenderer.once('saveLyricFinished', () => {
      ipcRenderer?.send('metadata', metadata);
    });
  }
  _updateMediaSessionPositionState() {
    if ('mediaSession' in navigator === false) {
      return;
    }
    if ('setPositionState' in navigator.mediaSession === false) {
      return;
    }
    // [审P2-1 配套] 防御:无 track / 无时长 / position 越界 / 非法 rate 都会让 setPositionState 抛
    //   DOMException → 守卫 + clamp + try/catch。playbackRate 用真实倍速，OS 进度条外推才准。
    const track = this._currentTrack;
    if (!track) return;
    const duration = ~~((track.dt || 0) / 1000);
    if (!(duration > 0)) return;
    let position = this.seek();
    if (typeof position !== 'number' || isNaN(position) || position < 0) {
      position = 0;
    }
    if (position > duration) position = duration;
    let rate = this._playbackRate;
    if (typeof rate !== 'number' || !(rate > 0)) rate = 1.0;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: rate,
        position,
      });
    } catch (e) {
      // 边界竞态偶发抛，忽略不影响播放
    }
  }
  // [T15] 睡眠「本集结束」：Vue 层 applySleep('end') 时置 true，cancelSleep/fireSleep 时置 false。
  setSleepEndMode(active) {
    this._sleepEndMode = !!active;
  }
  _nextTrackCallback() {
    this._scrobble(this._currentTrack, 0, true);
    // [T15] end 模式：自然播完后不续播队列，让 Vue 层的 1s interval 检测到 leftSec<=2 → fireSleep()
    if (this._sleepEndMode) {
      this._sleepEndMode = false;
      return;
    }
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
    // [C3 音量渐入] 久未播(>45min)或关软件后隔天打开 + 音量>50% → 本次出声做一段较长(1.2s)渐入(从 0 推上来)；
    //   否则维持常规 200ms 防啪嗒淡入。_lastPlayAt 由 _setPlaying 记录、Proxy 自动落盘、重启读回(支持跨天判定)。
    const _now = Date.now();
    const _last = this._lastPlayAt || 0;
    const _crossedDay =
      _last > 0 &&
      new Date(_last).toDateString() !== new Date(_now).toDateString();
    const _rampIn =
      this.volume > 0.5 &&
      _last > 0 &&
      (_now - _last > VOLUME_RAMP_IDLE_MS || _crossedDay);
    const _fadeDur = _rampIn ? VOLUME_RAMP_DURATION : PLAY_PAUSE_FADE_DURATION;
    // [C-14] 用户主动点播放 → 立即显示缓冲，出声后(once 'play')清除
    store.commit('setAudioBuffering', true);
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
      this._howler?.fade(0, this.volume, _fadeDur);

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
    // [seek-no-lazyload 修 #9] 启动后 howler 尚未实例化(只 setup 未 load)时，带参 seek 会静默 no-op
    //   (后退15/前进30"点了没反应")。与 playOrPause 同款兜底：播客 track 且 howler 缺失 → 主动
    //   load+autoplay。**不带 startAt** → 保留 episodeProgress 续播位置，不丢进度(本次 seek 增量忽略，
    //   加载后续 seek 正常)。
    if (
      time !== null &&
      !this._howler &&
      this._currentTrack?.podcastEpisodeId
    ) {
      this._loadCurrentPodcastEpisode(true).catch(() => {});
      return time;
    }
    if (isCreateMpris && sendMpris && time) {
      ipcRenderer?.send('seeked', time);
    }
    if (time !== null) {
      this._invalidateListenCoverage();
      // [B-81 修] howler 未 loaded 时直接 seek 会被忽略(时间戳/快进"点了不动"真因之一)。
      //   与 progress setter(224) 同范式：loaded 才立即 seek，否则挂 once('load') 等加载完成再 seek。
      // [播放期坏元素防从0] 与 set progress 对称：底层 <audio> 已 error/掉到不可播时绝不原地 seek
      //   (会触发 file:// 重载从0)，改走通用恢复重建续播到 time。仅 loaded 时把 readyState<2 视作坏死。
      const node = this._howler?._sounds?.[0]?._node;
      const loaded = this._howler && this._howler.state() === 'loaded';
      if (node && (node.error || (loaded && node.readyState < 2))) {
        this._recoverCurrentSource(time, true); // exact：用户快进/快退/拖动目标，精确(含向后)
        return time;
      } else if (this._howler && !loaded) {
        // [B-81 自审] 捕获当前 howler 引用 h：避免 load 触发前用户切了集，
        //   回调里 this._howler 已指向新实例 → 把新单集误 seek 到旧时间戳(跨集污染)。
        //   对被替换/卸载的旧实例 seek 无害，且绝不误碰新实例。
        const h = this._howler;
        h.once('load', () => {
          try {
            h.seek(time);
          } catch (e) {
            /* ignore */
          }
        });
      } else {
        this._howler?.seek(time);
      }
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
  async setOutputDevice(deviceId = store.state.settings.outputDevice) {
    if (this._howler?._sounds.length <= 0 || !this._howler?._sounds[0]._node) {
      return { ok: true, pending: true };
    }
    const node = this._howler._sounds[0]._node;
    if (typeof node.setSinkId !== 'function') {
      return { ok: true, unsupported: true };
    }
    try {
      await node.setSinkId(deviceId || 'default');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
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
    // [#8 repeat 两档] 播客随听随弃，列表循环('on')无意义 → 只在 off↔one(单集循环)间切。
    //   (图标模板天然正确：判 'one'→repeat-1 高亮、否则灰 repeat；'on' 不再产生。)
    this.repeatMode = this._repeatMode === 'one' ? 'off' : 'one';
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
  // [B-74] startAt(秒)：从某时间点起播(show notes 时间戳跳转用)。传入时覆盖续播位置，
  //   走 _playAudioSource 的 once('load') seek 同一条路 → 加载完成才 seek，确定性、不抢跑。
  playPodcastEpisode(episode, podcastTitle, startAt = null) {
    // [B-64] _justEnded 复位必须在任何 early-return 之前：否则取到无音频地址的队列项早退时，
    //   _justEnded 滞留 true，下次手动切集会误判为"自动续播"而丢失当前未播完单集的入队保留。
    const justEnded = this._justEnded;
    this._justEnded = false;
    if (!episode?.audioUrl) {
      store.dispatch('showToast', '该单集没有音频地址');
      return;
    }
    // [UX] 从别处再点"正在播放的同一单集" → 不打断、不重建(否则会重新缓冲/回跳进度)。
    //   仅暂停态时恢复播放；点按反馈由各调用方组件自行处理，与此无关。
    //   startAt 存在(show notes 时间戳跳转)时不短路，交由正常路径 seek。
    if (
      (startAt === null || startAt === undefined) &&
      this._currentTrack &&
      this._currentTrack.podcastEpisodeId === episode.id &&
      this._howler
    ) {
      if (!this._playing) this.play();
      return Promise.resolve(true);
    }
    // [A-24 改] 切换前：旧曲（如果未播完）放回队列头部，下次还能播
    // _justEnded=true 表示当前是 onend 自动续播，旧曲已播完，不入队
    const oldTrack = this._currentTrack;
    if (oldTrack && oldTrack.podcastEpisodeId && this._howler) {
      const curPos = Math.floor(this._howler.seek() || 0);
      if (curPos > 0) {
        saveEpisodeProgress(oldTrack.podcastEpisodeId, curPos).catch(() => {}); // [审P1-2] 切歌存旧进度也补 catch
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
      // [修·软删后遗症] 透传单集发布时间戳，供 NAS 就近播放第三路兜底(rescan 重建集丢了
      //   guid+enclosure 只剩 publishedAt，靠它匹配 ABS byPub)。queue 精简对象无此字段时为 0。
      podcastEpisodePubTime: episode.pubTime || 0,
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
    return this._loadCurrentPodcastEpisode(true, startAt);
  }

  // [播客改造 S-1] 按 this._currentTrack（必须是已构造好的播客 track）装载 howler，
  // 不查网易云。autoplay 控制是否自动播放（重启时为 false，新点一集时为 true）。
  // 同时从 episodeProgress 表读上次进度，howler 加载完成后 seek 过去。
  async _loadCurrentPodcastEpisode(autoplay, startAt = null) {
    const track = this._currentTrack;
    if (!track || !track.podcastAudioUrl) return false;

    // [审P2-1 配套] 恢复/续播路径也刷新系统媒体卡片(SMTC)元数据(标题/封面)——否则 app 重启后直接
    //   resume 恢复的那一集，卡片缺标题封面(只有"点新单集播放"的入口 1581 set 过)。idempotent、安全。
    this._updateMediaSessionMetaData(track);

    // [B69-F5/F1] 切到任意单集前，先把上一集尚未落盘的收听缓冲 flush 出去(自然播完连播 / 手动切歌 /
    //   上一首 都经此)，不再依赖新集首个 tick 才落盘；随后清空，让新集从干净状态累积、且不污染跨集去重态。
    //   此刻 _listenBuf 仍持上一集 id，落盘正确(本方法此前 _currentTrack 已是新集，但缓冲只由 tick 更新)。
    this._flushListenBuf();
    this._listenBuf = null;
    this._invalidateListenCoverage();

    // [播客改造 progress-bug] 立即调 setTitle 让 document.title 含节目名
    // → state.title 一定与原默认值"PodPlayer"不同 → Vue 重渲染读到正确 _progress
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
      // 注：上一集缓冲已在本方法开头 flush+清空，reset 后不会再被陈旧缓冲回写覆盖。
    }
    // [B-74] 时间戳跳转：调用方指定起播秒数 → 覆盖续播位置(放在"已听完归零"之后，
    //   保证时间戳必赢)。clamp 到时长内，避免越界；之后由 once('load') 确定性 seek。
    // [B-81 修] 门槛用 >=0(不是 >1)：点 00:00/00:01 也要覆盖续播位、回到片头，
    //   否则有续播进度时点片头时间戳会停在上次续播点(="点了不跳到该处")。
    if (typeof startAt === 'number' && startAt >= 0) {
      savedPos =
        trackDurSec > 0
          ? Math.min(Math.floor(startAt), trackDurSec - 2)
          : Math.floor(startAt);
    }
    // [T5] 切集：若上一集已听完且用户开启自动清理，在此删除其本地下载文件（此时文件已不在播放中，安全）。
    //   仅当切到「不同单集」时触发，避免重播同集时误删。
    if (this._lastListenCompleted) {
      var _prevId = this._currentTrack && this._currentTrack.podcastEpisodeId;
      var _newId = track && track.podcastEpisodeId;
      if (
        _prevId &&
        _prevId !== _newId &&
        store.state.settings &&
        store.state.settings.autoCleanCompletedDownloads
      ) {
        removeDownload(_prevId).catch(function () {});
      }
    }
    // [B-31] 切集时重置广播缓存（让 5% 步进 / completed 在新集第一次 tick 就能触发广播）
    this._lastListenStep = -1;
    this._lastListenCompleted = false;

    // [进度条·重开根因修] 立即把"显示进度"置为续播位置 savedPos：
    //   重启时走 autoplay=false，howler 未播放(且 html5 未必预载触发 'load')→ _progress 原停在 0
    //   → 进度条无填充、播放时间显 0:00，必须点播放、howler 起播后 tick 才更新 = 用户报的"重开进度条/时间没有"。
    //   D141「重开重挂」只解决了轨道宽度测量、没恢复进度值，故没修彻底。这里同步置位，让重开即显示上次位置；
    //   _setIntervals 的 tick 在 howler 未 loaded 时不写 _progress(有 state 守卫)，不会把这里覆盖回 0；
    //   起播后 once('load') 会再 seek 到同一 savedPos，两者一致、无冲突。autoplay=true 亦无害。
    this._progress = savedPos;
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
