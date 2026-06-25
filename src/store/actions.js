// import store, { state, dispatch, commit } from "@/store";
import { isAccountLoggedIn, isLooseLoggedIn } from '@/utils/auth';
import { likeATrack } from '@/api/track';
// [播客改造 A-7.1] 本地收藏 DAO
import {
  addFavorite as podAddFavorite,
  removeFavorite as podRemoveFavorite,
  getAllFavoriteIds as podGetAllFavoriteIds,
  isFavorited as podIsFavorited,
} from '@/utils/podcast/db';
import { getPlaylistDetail } from '@/api/playlist';
import { getTrackDetail } from '@/api/track';
import {
  userPlaylist,
  userPlayHistory,
  userLikedSongsIDs,
  likedAlbums,
  likedArtists,
  likedMVs,
  cloudDisk,
  userAccount,
} from '@/api/user';

export default {
  showToast({ state, commit }, text) {
    if (state.toast.timer !== null) {
      clearTimeout(state.toast.timer);
      commit('updateToast', { show: false, text: '', timer: null });
    }
    commit('updateToast', {
      show: true,
      text,
      timer: setTimeout(() => {
        commit('updateToast', {
          show: false,
          text: state.toast.text,
          timer: null,
        });
      }, 3200),
    });
  },
  likeATrack({ state, commit, dispatch }, id) {
    // [播客改造 A-7.1] 当前在播的是播客单集 → 走本地收藏分支；
    // 走 vuex action `togglePodcastFavorite` 由 Player.vue 触发更合适，这里仍保留旧
    // 兼容入口：若被旧代码路径调到、且当前是播客，则改派到本地收藏。
    const cur = state.player && state.player.currentTrack;
    if (cur && cur.podcastEpisodeId) {
      return dispatch('togglePodcastFavorite', cur);
    }
    if (!isAccountLoggedIn()) {
      // [播客改造 A-7.1] 不再弹"需登录网易云"——非播客且未登录时静默忽略
      return;
    }
    let like = true;
    if (state.liked.songs.includes(id)) like = false;
    likeATrack({ id, like })
      .then(() => {
        if (like === false) {
          commit('updateLikedXXX', {
            name: 'songs',
            data: state.liked.songs.filter(d => d !== id),
          });
        } else {
          let newLikeSongs = state.liked.songs;
          newLikeSongs.push(id);
          commit('updateLikedXXX', {
            name: 'songs',
            data: newLikeSongs,
          });
        }
        dispatch('fetchLikedSongsWithDetails');
      })
      .catch(() => {
        dispatch('showToast', '操作失败，专辑下架或版权锁定');
      });
  },
  fetchLikedSongs: ({ state, commit }) => {
    if (!isLooseLoggedIn()) return;
    if (isAccountLoggedIn()) {
      return userLikedSongsIDs({ uid: state.data.user.userId }).then(result => {
        if (result.ids) {
          commit('updateLikedXXX', {
            name: 'songs',
            data: result.ids,
          });
        }
      });
    } else {
      // TODO:搜索ID登录的用户
    }
  },
  fetchLikedSongsWithDetails: ({ state, commit }) => {
    return getPlaylistDetail(state.data.likedSongPlaylistID, true).then(
      result => {
        if (result.playlist?.trackIds?.length === 0) {
          return new Promise(resolve => {
            resolve();
          });
        }
        return getTrackDetail(
          result.playlist.trackIds
            .slice(0, 12)
            .map(t => t.id)
            .join(',')
        ).then(result => {
          commit('updateLikedXXX', {
            name: 'songsWithDetails',
            data: result.songs,
          });
        });
      }
    );
  },
  fetchLikedPlaylist: ({ state, commit }) => {
    if (!isLooseLoggedIn()) return;
    if (isAccountLoggedIn()) {
      return userPlaylist({
        uid: state.data.user?.userId,
        limit: 2000, // 最多只加载2000个歌单（等有用户反馈问题再修）
        timestamp: new Date().getTime(),
      }).then(result => {
        if (result.playlist) {
          commit('updateLikedXXX', {
            name: 'playlists',
            data: result.playlist,
          });
          // 更新用户”喜欢的歌曲“歌单ID
          commit('updateData', {
            key: 'likedSongPlaylistID',
            value: result.playlist[0].id,
          });
        }
      });
    } else {
      // TODO:搜索ID登录的用户
    }
  },
  fetchLikedAlbums: ({ commit }) => {
    if (!isAccountLoggedIn()) return;
    return likedAlbums({ limit: 2000 }).then(result => {
      if (result.data) {
        commit('updateLikedXXX', {
          name: 'albums',
          data: result.data,
        });
      }
    });
  },
  fetchLikedArtists: ({ commit }) => {
    if (!isAccountLoggedIn()) return;
    return likedArtists({ limit: 2000 }).then(result => {
      if (result.data) {
        commit('updateLikedXXX', {
          name: 'artists',
          data: result.data,
        });
      }
    });
  },
  fetchLikedMVs: ({ commit }) => {
    if (!isAccountLoggedIn()) return;
    return likedMVs({ limit: 1000 }).then(result => {
      if (result.data) {
        commit('updateLikedXXX', {
          name: 'mvs',
          data: result.data,
        });
      }
    });
  },
  fetchCloudDisk: ({ commit }) => {
    if (!isAccountLoggedIn()) return;
    // FIXME: #1242
    return cloudDisk({ limit: 1000 }).then(result => {
      if (result.data) {
        commit('updateLikedXXX', {
          name: 'cloudDisk',
          data: result.data,
        });
      }
    });
  },
  fetchPlayHistory: ({ state, commit }) => {
    if (!isAccountLoggedIn()) return;
    return Promise.all([
      userPlayHistory({ uid: state.data.user?.userId, type: 0 }),
      userPlayHistory({ uid: state.data.user?.userId, type: 1 }),
    ]).then(result => {
      const data = {};
      const dataType = { 0: 'allData', 1: 'weekData' };
      if (result[0] && result[1]) {
        for (let i = 0; i < result.length; i++) {
          const songData = result[i][dataType[i]].map(item => {
            const song = item.song;
            song.playCount = item.playCount;
            return song;
          });
          data[[dataType[i]]] = songData;
        }
        commit('updateLikedXXX', {
          name: 'playHistory',
          data: data,
        });
      }
    });
  },
  fetchUserProfile: ({ commit }) => {
    if (!isAccountLoggedIn()) return;
    return userAccount().then(result => {
      if (result.code === 200) {
        commit('updateData', { key: 'user', value: result.profile });
      }
    });
  },
  // [播客改造 A-24] 加入播放列表（默认加在头部，下一首播这个）
  enqueueEpisode({ commit, dispatch, state }, ep) {
    if (!ep || !ep.id) return;
    // [审P2] 正在播放的这一集不入队：它已作为"正在播放"置顶显示在播放列表里，
    //   再入队会同一集显示两遍。起播时本就会把该集移出队列(Player.js)，故唯一重复源就是此处。
    const cur = state.player && state.player.currentTrack;
    if (cur && cur.podcastEpisodeId === ep.id) {
      dispatch('showToast', '正在播放');
      return;
    }
    commit('enqueueEpisodeAtFront', {
      id: ep.id,
      guid: ep.guid || (ep.id || '').split('::').pop() || '',
      title: ep.title || '',
      audioUrl: ep.audioUrl || ep.podcastAudioUrl || '',
      coverUrl: ep.coverUrl || (ep.al && ep.al.picUrl) || '',
      duration: ep.duration || (ep.dt ? Math.floor(ep.dt / 1000) : 0),
      podcastId: ep.podcastId || '',
      podcastTitle: ep.podcastTitle || (ep.al && ep.al.name) || '',
    });
    dispatch('showToast', '已加入播放列表');
  },
  // [A-24] 取队列下一首并出队
  popNextFromQueue({ state, commit }) {
    if (!state.podcastQueue.length) return null;
    const next = state.podcastQueue[0];
    commit('removeFromQueue', next.id);
    return next;
  },
  // [播客改造 A-7.1] 启动时把本地收藏 id 列表加载进 vuex，UI 用作快速判定
  async fetchPodcastFavorites({ commit }) {
    try {
      const ids = await podGetAllFavoriteIds();
      commit('setPodcastFavoriteIds', ids);
    } catch (e) {
      console.warn('[播客 A-7.1] 加载收藏失败：', e);
    }
  },
  // 切换收藏。track 是当前播放引擎里的 track 对象（含 podcastEpisodeId / 元数据）
  async togglePodcastFavorite({ commit, dispatch }, track) {
    if (!track || !track.podcastEpisodeId) return;
    const id = track.podcastEpisodeId;
    const already = await podIsFavorited(id);
    if (already) {
      await podRemoveFavorite(id);
      dispatch('showToast', '已取消收藏');
    } else {
      await podAddFavorite({
        id,
        podcastId: track.podcastId || (track.al && track.al.id) || '',
        podcastTitle: track.al && track.al.name ? track.al.name : '',
        title: track.name || '',
        coverUrl: track.al && track.al.picUrl ? track.al.picUrl : '',
        audioUrl: track.podcastAudioUrl || '',
        duration: track.dt ? Math.floor(track.dt / 1000) : 0,
      });
      dispatch('showToast', '已加入收藏');
    }
    // 刷新 store 里的 id 列表
    const ids = await podGetAllFavoriteIds();
    commit('setPodcastFavoriteIds', ids);
  },
};
