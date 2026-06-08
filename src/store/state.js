import initLocalStorage from './initLocalStorage';
import pkg from '../../package.json';
import updateApp from '@/utils/updateApp';

if (localStorage.getItem('appVersion') === null) {
  localStorage.setItem('settings', JSON.stringify(initLocalStorage.settings));
  localStorage.setItem('data', JSON.stringify(initLocalStorage.data));
  localStorage.setItem('appVersion', pkg.version);
}

updateApp();

export default {
  showLyrics: false,
  enableScrolling: true,
  title: 'YesPlayMusic',
  liked: {
    songs: [],
    songsWithDetails: [], // 只有前12首
    playlists: [],
    albums: [],
    artists: [],
    mvs: [],
    cloudDisk: [],
    playHistory: {
      weekData: [],
      allData: [],
    },
  },
  // [播客改造 A-7.1] 本地收藏的播客单集 id 列表（快速判定用，全量数据在 Dexie favorites 表）
  podcastFavorites: {
    episodeIds: [],
  },
  // [B-43] 发现页：已订阅节目映射（节目名 → feedUrl）。
  //   首页发现卡片来自 xyzrank（只有节目名），订阅库以 feedUrl 为键，二者唯一关联键是节目名。
  //   用途：① 卡片"已订阅"回显（绿勾）② 已订阅再点直接拿 feedUrl 进详情，免重复抓 RSS。
  podcastDiscover: {
    subscribedMap: {},
  },
  // [B-47 第5点] 已屏蔽节目（首页发现页右键"屏蔽"）。items: [{name, coverUrl}]，按节目名为键。
  //   屏蔽后：发现页不再显示、统计页不显示；取消屏蔽可恢复。持久化到 localStorage。
  podcastBlocked: {
    items: JSON.parse(localStorage.getItem('podcastBlocked') || '[]'),
  },
  // [播客改造 C-14] 当前是否在加载音频（点单集到出声的等待）
  audioBuffering: false,
  // [播客改造 A-24] 播放队列。每项 = 单集精简对象（id/guid/title/audioUrl/coverUrl/duration/podcastId/podcastTitle）
  podcastQueue: JSON.parse(localStorage.getItem('podcastQueue') || '[]'),
  // [B-31] 下载相关：
  //   progressMap: 正在进行的下载进度 { [epId]: { bytesDone, bytesTotal, status } }
  //   doneIds:     已完成下载的 episodeId 集合（用于 UI O(1) 判断），首次加载从 DB 灌进来
  //   pathMap:     [B-35] 已下载单集 → 本地文件绝对路径，供 Player 同步取 file:// 离线播放
  //                （之前 Player 用动态 import('@/utils/db') 查路径不可靠，回退在线又被代理挡）
  podcastDownloads: {
    progressMap: {},
    doneIds: [],
    pathMap: {},
  },
  // [B-31] 收听统计实时刷新信号：tickListen 在「5% 步进 或 completed 变化」时 bump，
  // UI 监听 listenTick 重读自己列表里那一集的 stats。
  podcastListening: {
    listenTick: 0, // 单调自增，UI 用 watch 触发
    episodeId: '', // 哪一集发生了变化
    listenedSec: 0,
    totalSec: 0,
    completed: false,
  },
  contextMenu: {
    clickObjectID: 0,
    showMenu: false,
  },
  toast: {
    show: false,
    text: '',
    timer: null,
  },
  modals: {
    addTrackToPlaylistModal: {
      show: false,
      selectedTrackID: 0,
    },
    newPlaylistModal: {
      show: false,
      afterCreateAddTrackID: 0,
    },
  },
  dailyTracks: [],
  lastfm: JSON.parse(localStorage.getItem('lastfm')) || {},
  player: JSON.parse(localStorage.getItem('player')),
  settings: JSON.parse(localStorage.getItem('settings')),
  data: JSON.parse(localStorage.getItem('data')),
};
