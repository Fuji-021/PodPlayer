import Vue from 'vue';
import VueRouter from 'vue-router';
import { isLooseLoggedIn, isAccountLoggedIn } from '@/utils/auth';

Vue.use(VueRouter);
const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/home.vue'),
    meta: {
      keepAlive: true,
      savePosition: true,
    },
  },
  // [B-42] 发现页二级页（热门排行 / 播客寻宝）
  {
    path: '/discover/:type',
    name: 'discover',
    component: () => import('@/views/discoverList.vue'),
    meta: { requireLogin: false },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/login.vue'),
  },
  {
    path: '/login/username',
    name: 'loginUsername',
    component: () => import('@/views/loginUsername.vue'),
  },
  {
    path: '/login/account',
    name: 'loginAccount',
    component: () => import('@/views/loginAccount.vue'),
  },
  {
    path: '/playlist/:id',
    name: 'playlist',
    component: () => import('@/views/playlist.vue'),
  },
  {
    path: '/album/:id',
    name: 'album',
    component: () => import('@/views/album.vue'),
  },
  {
    path: '/artist/:id',
    name: 'artist',
    component: () => import('@/views/artist.vue'),
    meta: {
      keepAlive: true,
      savePosition: true,
    },
  },
  {
    path: '/artist/:id/mv',
    name: 'artistMV',
    component: () => import('@/views/artistMV.vue'),
    meta: {
      keepAlive: true,
    },
  },
  {
    path: '/mv/:id',
    name: 'mv',
    component: () => import('@/views/mv.vue'),
  },
  {
    path: '/next',
    name: 'next',
    component: () => import('@/views/next.vue'),
    meta: {
      keepAlive: true,
      savePosition: true,
    },
  },
  {
    path: '/search/:keywords?',
    name: 'search',
    component: () => import('@/views/search.vue'),
    meta: {
      keepAlive: true,
    },
  },
  {
    path: '/search/:keywords/:type',
    name: 'searchType',
    component: () => import('@/views/searchType.vue'),
  },
  {
    path: '/new-album',
    name: 'newAlbum',
    component: () => import('@/views/newAlbum.vue'),
  },
  {
    path: '/explore',
    name: 'explore',
    component: () => import('@/views/explore.vue'),
    meta: {
      keepAlive: true,
      savePosition: true,
    },
  },
  {
    path: '/library',
    name: 'library',
    // [播客改造] 原 library.vue 是网易云音乐库，保留源码不删；
    // /library 现在指向播客库新页面，作为本软件的主功能页。
    component: () => import('@/views/podcastLibrary.vue'),
    meta: {
      requireLogin: false,
      keepAlive: true,
      savePosition: true,
    },
  },
  {
    path: '/library/liked-songs',
    name: 'likedSongs',
    component: () => import('@/views/playlist.vue'),
    meta: {
      requireLogin: true,
    },
  },
  // [播客改造 A-23] 节目详情页（二级）：feedUrlEncoded 是 encodeURIComponent 后的 feedUrl
  {
    path: '/library/podcast/:feedUrlEncoded',
    name: 'podcastDetail',
    component: () => import('@/views/podcastDetail.vue'),
    meta: {
      requireLogin: false,
    },
  },
  // [播客改造 C-5] 单集详情页（三级）：guidEncoded 是 encodeURIComponent 后的 guid
  {
    path: '/library/podcast/:feedUrlEncoded/episode/:guidEncoded',
    name: 'episodeDetail',
    component: () => import('@/views/episodeDetail.vue'),
    meta: {
      requireLogin: false,
    },
  },
  // [播客改造 A-26] 我的收藏
  {
    path: '/me/favorites',
    name: 'favorites',
    component: () => import('@/views/favoritesList.vue'),
    meta: { requireLogin: false },
  },
  // [B-33] 我的下载
  {
    path: '/me/downloads',
    name: 'downloads',
    component: () => import('@/views/downloadsList.vue'),
    meta: { requireLogin: false },
  },
  // [B-37] 收听历史
  {
    path: '/me/history',
    name: 'history',
    component: () => import('@/views/historyList.vue'),
    meta: { requireLogin: false },
  },
  // [B-37] 收听数据统计
  {
    path: '/me/stats',
    name: 'stats',
    component: () => import('@/views/statsPage.vue'),
    meta: { requireLogin: false },
  },
  // [B-47 第5点] 已屏蔽节目
  {
    path: '/me/blocked',
    name: 'blocked',
    component: () => import('@/views/blockedList.vue'),
    meta: { requireLogin: false },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/settings.vue'),
  },
  {
    path: '/daily/songs',
    name: 'dailySongs',
    component: () => import('@/views/dailyTracks.vue'),
    meta: {
      requireAccountLogin: true,
    },
  },
  {
    path: '/lastfm/callback',
    name: 'lastfmCallback',
    component: () => import('@/views/lastfmCallback.vue'),
  },
];

const router = new VueRouter({
  mode: process.env.IS_ELECTRON ? 'hash' : 'history',
  routes,
});

const originalPush = VueRouter.prototype.push;
VueRouter.prototype.push = function push(location) {
  return originalPush.call(this, location).catch(err => err);
};

router.beforeEach((to, from, next) => {
  // 需要登录的逻辑
  if (to.meta.requireAccountLogin) {
    if (isAccountLoggedIn()) {
      next();
    } else {
      next({ path: '/login/account' });
    }
  }
  if (to.meta.requireLogin) {
    if (isLooseLoggedIn()) {
      next();
    } else {
      if (process.env.IS_ELECTRON === true) {
        next({ path: '/login/account' });
      } else {
        next({ path: '/login' });
      }
    }
  } else {
    next();
  }
});

export default router;
