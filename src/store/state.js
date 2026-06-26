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
  title: 'PodPlayer',
  // [快捷键冲突高亮] 全局快捷键注册失败的 shortcut id 列表(被其它应用/系统占用或非法组合)；
  //   主进程每次注册后回报(成功也回报空数组以清除旧高亮)，设置页据此对应行标红提示。瞬态、不持久化。
  failedGlobalShortcuts: [],
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
  // [B-70] 链接无法解析/打开失败的节目（点进去预览抓取失败）。names: [节目名]，按节目名为键。
  //   用途：发现页卡片标**红点**，让用户一眼避开打不开的节目；下次再点若成功则自动消红点。
  podcastBroken: {
    names: JSON.parse(localStorage.getItem('podcastBroken') || '[]'),
  },
  // [B-75] 单集"标记位置"：用户听到喜欢处打点，进度条上显示细蓝标(封面主色)。
  //   结构 { [episodeId]: [秒,...] }，持久化 localStorage。本集标记 >5 按钮变封面色、>10 变彩虹(彩蛋#2)。
  podcastMarks: {
    map: JSON.parse(localStorage.getItem('podcastMarks') || '{}'),
  },
  // [B-48 第5点] 自定义头像（裁切后的 1:1 dataURL，持久化 localStorage）；空=用默认头像
  podcastAvatar: localStorage.getItem('podcastAvatar') || '',
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
