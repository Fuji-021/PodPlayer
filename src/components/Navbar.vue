<template>
  <div>
    <nav :class="{ 'has-custom-titlebar': hasCustomTitlebar }">
      <Win32Titlebar v-if="enableWin32Titlebar" />
      <LinuxTitlebar v-if="enableLinuxTitlebar" />
      <div class="navigation-buttons">
        <button-icon @click.native="go('back')"
          ><svg-icon icon-class="arrow-left"
        /></button-icon>
        <!-- [B-44] 前进键还原：复用 arrow-left 水平翻转，确保与返回键样式严格对应。
             （arrow-right.svg 已被改成发现页"探索更多"长箭头，不能再用于此处） -->
        <button-icon @click.native="go('forward')"
          ><svg-icon icon-class="arrow-left" class="flip-x"
        /></button-icon>
      </div>
      <div class="navigation-links">
        <router-link to="/" :class="{ active: navSection === 'home' }">{{
          $t('nav.home')
        }}</router-link>
        <!-- [播客改造] 暂时屏蔽"发现"入口（源码保留） -->
        <router-link
          v-if="false"
          to="/explore"
          :class="{ active: $route.name === 'explore' }"
          >{{ $t('nav.explore') }}</router-link
        >
        <router-link
          to="/library"
          :class="{ active: navSection === 'library' }"
          >{{ $t('nav.library') }}</router-link
        >
        <!-- [NAS] 连接状态图标：放「我的订阅」旁，绿(在线·呼吸)/红(断联·静止)；未启用不显示。点击重连。
             外包 transition：启停时图标平滑收起/展开（max-width+opacity 渐变），
             使「我的订阅」跟着缓缓归位，而非生切补位。 -->
        <transition name="nas-collapse">
          <div
            v-if="nasState.enabled"
            class="nas-status"
            :class="nasStateClass"
            @click="onNasClick"
          >
            <svg-icon icon-class="router-wifi-alt" />
            <span class="nas-tip">{{ nasTitle }}</span>
          </div>
        </transition>
      </div>
      <div class="right-part">
        <!-- [B-52] 播客搜索框：本地(我的订阅/单集) + 在线(iTunes)，回车跳搜索页 -->
        <div class="search-box">
          <div
            class="container"
            :class="{ active: inputFocus, dimmed: searchDimmed }"
          >
            <svg-icon icon-class="search" />
            <div class="input">
              <input
                ref="searchInput"
                v-model="keywords"
                type="search"
                :placeholder="inputFocus ? '' : '搜索播客'"
                @keydown.enter="doSearch"
                @focus="inputFocus = true"
                @blur="inputFocus = false"
              />
            </div>
            <!-- [B-63] 自定义清除 ×（替换难调色的原生按钮，颜色跟随文字；仅有内容时显示）。
                 用 button 包裹确保原生点击可触发(svg-icon 是组件，@click 需 .native)。 -->
            <button
              v-if="keywords"
              v-tip="'清除'"
              class="clear-btn"
              @click.stop="clearSearch"
            >
              <svg-icon icon-class="x" />
            </button>
          </div>
        </div>
        <img
          class="avatar"
          :src="avatarUrl"
          loading="lazy"
          @click="showUserProfileMenu"
        />
      </div>
    </nav>

    <ContextMenu ref="userProfileMenu">
      <!-- [B-67] "我的"二级菜单重排：最重要的「收听数据」置顶 → 收藏/下载/历史/已屏蔽 -->
      <div class="item" @click="toStats">
        <svg-icon icon-class="duration" />
        收听数据
      </div>
      <div class="item" @click="toFavorites">
        <svg-icon icon-class="heart" />
        我的收藏
      </div>
      <div class="item" @click="toDownloads">
        <svg-icon icon-class="download" />
        我的下载
      </div>
      <div class="item" @click="toHistory">
        <svg-icon icon-class="time-past" />
        收听历史
      </div>
      <div class="item" @click="toBlocked">
        <svg-icon icon-class="ban" />
        已屏蔽节目
      </div>
      <hr />
      <!-- [B-48 第5点] 自定义头像 -->
      <div class="item" @click="onPickAvatar">
        <svg-icon icon-class="square-plus" />
        更换头像
      </div>
      <div v-if="hasCustomAvatar" class="item" @click="resetAvatar">
        <svg-icon icon-class="refresh" />
        恢复默认头像
      </div>
      <hr />
      <div class="item" @click="toSettings">
        <svg-icon icon-class="settings" />
        {{ $t('library.userProfileMenu.settings') }}
      </div>
      <!-- [播客改造] 暂时屏蔽网易云登录/退出菜单项（源码保留） -->
      <div v-if="false" class="item" @click="toLogin">
        <svg-icon icon-class="login" />
        {{ $t('login.login') }}
      </div>
      <div v-if="false" class="item" @click="logout">
        <svg-icon icon-class="logout" />
        {{ $t('library.userProfileMenu.logout') }}
      </div>
    </ContextMenu>

    <!-- [B-48 第5点] 头像上传 + 裁切弹窗 -->
    <input
      ref="avatarInput"
      type="file"
      accept="image/png,image/jpeg,image/jpg,image/webp,image/*"
      style="display: none"
      @change="onAvatarFile"
    />
    <AvatarCropper
      v-if="cropperSrc"
      :src="cropperSrc"
      @done="onCropDone"
      @cancel="cropperSrc = ''"
    />
  </div>
</template>

<script>
import { mapState } from 'vuex';
import { isLooseLoggedIn, doLogout } from '@/utils/auth';

// import icons for win32 title bar
// icons by https://github.com/microsoft/vscode-codicons
import 'vscode-codicons/dist/codicon.css';

import Win32Titlebar from '@/components/Win32Titlebar.vue';
import LinuxTitlebar from '@/components/LinuxTitlebar.vue';
import ContextMenu from '@/components/ContextMenu.vue';
import ButtonIcon from '@/components/ButtonIcon.vue';
import AvatarCropper from '@/components/AvatarCropper.vue';
// [NAS] 连接状态（熔断器）：导航栏状态图标读它。未启用则图标不显示。
//   nasActiveName：当前激活档名（toast「托尼的 NAS 已连接」用，随用户改名实时变）。
import {
  nasStatus,
  testNasConnection,
  nasActiveName,
} from '@/utils/podcast/nasSource';

export default {
  name: 'Navbar',
  components: {
    Win32Titlebar,
    LinuxTitlebar,
    ButtonIcon,
    ContextMenu,
    AvatarCropper,
  },
  data() {
    return {
      inputFocus: false,
      langs: ['zh-CN', 'zh-TW', 'en', 'tr'],
      keywords: '',
      enableWin32Titlebar: false,
      enableLinuxTitlebar: false,
      // [B-48 第5点] 头像裁切弹窗源图 dataURL（非空=显示弹窗）
      cropperSrc: '',
      // [NAS] 连接状态（轮询 nasStatus 刷新）：enabled=已配置启用；alive=在线
      nasState: { enabled: false, alive: false },
      // [导航高亮] 当前所在顶层区(home/library)；进节目/单集详情(/library 子页)保持不变
      //   → 高亮不在进详情后消失，且反映"从首页还是我的订阅进来的"。
      navSection: 'home',
    };
  },
  computed: {
    ...mapState(['settings', 'data']),
    isLooseLoggedIn() {
      return isLooseLoggedIn();
    },
    avatarUrl() {
      // [B-48 第5点] 自定义头像优先（裁切后的 dataURL）
      if (this.$store.state.podcastAvatar) {
        return this.$store.state.podcastAvatar;
      }
      return this.data?.user?.avatarUrl && this.isLooseLoggedIn
        ? `${this.data?.user?.avatarUrl}?param=512y512`
        : 'http://s4.music.126.net/style/web2/img/default/default_avatar.jpg?param=60y60';
    },
    hasCustomTitlebar() {
      return this.enableWin32Titlebar || this.enableLinuxTitlebar;
    },
    // [B-48 第5点] 是否已设自定义头像（决定是否显示"恢复默认"项）
    hasCustomAvatar() {
      return !!this.$store.state.podcastAvatar;
    },
    // [B-63] 搜索框文字变暗：有内容 + 不在搜索结果页 + 未聚焦（hover 不算，只 focus 复原）
    //   场景：用户没手动清除、直接点首页/返回离开搜索页 → 残留关键词暗下去，再次点击复原。
    searchDimmed() {
      return (
        !!this.keywords &&
        this.$route.name !== 'searchPodcast' &&
        !this.inputFocus
      );
    },
    // [NAS] 状态图标着色：在线=绿(呼吸)，断联=红(静止)。局域网不存在慢速，无黄态。
    nasStateClass() {
      return this.nasState.alive ? 'online' : 'offline';
    },
    // [NAS] 自定义 hover tooltip 文案（替代原生 title 的丑边框框）。
    nasTitle() {
      return this.nasState.alive ? 'NAS 已连接' : 'NAS 未连接';
    },
  },
  watch: {
    // [C 修复] 搜索框关键词与路由同步：刷新/前进后退/外部跳转进入搜索结果页时，
    //   keywords 仍为 data 初值''，导致搜索框为空（与标题不一致）且 searchDimmed 失效。
    //   immediate 保证首次进入即同步；仅在 searchPodcast 页用路由参数回填。
    $route: {
      immediate: true,
      handler() {
        if (this.$route.name === 'searchPodcast') {
          this.keywords = this.$route.params.keywords || this.keywords;
        }
        // [导航高亮] 仅顶层区切换才更新 navSection；节目/单集详情(/library 子页)保持不变，
        //   使高亮不在进详情后变白，且反映从哪个区进来的。
        const n = this.$route.name;
        if (n === 'home') this.navSection = 'home';
        else if (n === 'library') this.navSection = 'library';
      },
    },
  },
  created() {
    if (process.platform === 'win32') {
      this.enableWin32Titlebar = true;
    } else if (
      process.platform === 'linux' &&
      this.settings.linuxEnableCustomTitlebar
    ) {
      this.enableLinuxTitlebar = true;
    }
  },
  mounted() {
    // [NAS] 轮询熔断状态刷新图标（只读模块状态、无网络）；2s 足够、开销忽略。
    this._nasPoll = setInterval(() => {
      const s = nasStatus();
      if (
        s.enabled !== this.nasState.enabled ||
        s.alive !== this.nasState.alive
      ) {
        this.nasState = { enabled: s.enabled, alive: s.alive };
      }
    }, 2000);
    const s0 = nasStatus();
    this.nasState = { enabled: s0.enabled, alive: s0.alive };
  },
  beforeDestroy() {
    clearInterval(this._nasPoll);
  },
  methods: {
    go(where) {
      if (where === 'back') this.$router.go(-1);
      else this.$router.go(1);
    },
    doSearch() {
      const kw = (this.keywords || '').trim();
      if (!kw) return;
      // [B-63] 记录最近搜索词（供"为你推荐"按搜索词类目相关推荐；去重、最多 10 条）
      try {
        const SK = 'podcast.recentSearch';
        const arr = JSON.parse(localStorage.getItem(SK) || '[]');
        const next = [kw, ...arr.filter(x => x !== kw)].slice(0, 10);
        localStorage.setItem(SK, JSON.stringify(next));
      } catch (e) {
        /* 忽略 */
      }
      if (
        this.$route.name === 'searchPodcast' &&
        this.$route.params.keywords === kw
      ) {
        return;
      }
      // [B-52] 跳播客搜索结果页（本地 + 在线）
      this.$router.push({ name: 'searchPodcast', params: { keywords: kw } });
    },
    // [B-63] 自定义清除 ×：清空并重新聚焦输入框
    clearSearch() {
      this.keywords = '';
      this.$nextTick(() => {
        this.$refs.searchInput && this.$refs.searchInput.focus();
      });
    },
    showUserProfileMenu(e) {
      // [avatar-scroll-lock 修] 头像下拉菜单不锁全局滚动(传 lockScrolling=false)
      this.$refs.userProfileMenu.openMenu(e, false);
    },
    // [NAS] 点状态图标 → 立即重新探测连接（手动重连）；结果反映到图标 + toast。
    //   文案带当前档名（随用户改名变）：「托尼的 NAS 已连接」/「…连不上，已用在线音源」。
    async onNasClick() {
      const r = await testNasConnection();
      const ok = !!(r && r.ok);
      const s = nasStatus();
      this.nasState = { enabled: s.enabled, alive: s.alive };
      const nm = nasActiveName();
      const label = nm ? nm + '的 NAS' : 'NAS';
      this.$store.dispatch(
        'showToast',
        ok ? label + ' 已连接' : label + ' 暂时连不上，已用在线音源'
      );
    },
    logout() {
      if (!confirm('确定要退出登录吗？')) return;
      doLogout();
      this.$router.push({ name: 'home' });
    },
    toSettings() {
      this.$router.push({ name: 'settings' });
    },
    // [A-26] 我的入口
    toFavorites() {
      this.$router.push({ name: 'favorites' });
    },
    toDownloads() {
      this.$router.push({ name: 'downloads' });
    },
    toHistory() {
      this.$router.push({ name: 'history' });
    },
    toStats() {
      this.$router.push({ name: 'stats' });
    },
    // [B-47 第5点] 已屏蔽节目
    toBlocked() {
      this.$router.push({ name: 'blocked' });
    },
    // [B-48 第5点] 自定义头像：选图 → 裁切弹窗 → 存 dataURL
    onPickAvatar() {
      this.$refs.avatarInput.click();
    },
    onAvatarFile(e) {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) {
        this.$store.dispatch('showToast', '请选择图片文件（jpg/png/webp 等）');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        this.cropperSrc = reader.result;
      };
      reader.readAsDataURL(f);
    },
    onCropDone(dataUrl) {
      this.$store.commit('setPodcastAvatar', dataUrl);
      this.cropperSrc = '';
      this.$store.dispatch('showToast', '头像已更新');
    },
    resetAvatar() {
      this.$store.commit('setPodcastAvatar', '');
      this.$store.dispatch('showToast', '已恢复默认头像');
    },
    toGitHub() {
      window.open('https://github.com/qier222/YesPlayMusic');
    },
    toLogin() {
      if (process.env.IS_ELECTRON === true) {
        this.$router.push({ name: 'loginAccount' });
      } else {
        this.$router.push({ name: 'login' });
      }
    },
  },
};
</script>

<style lang="scss" scoped>
nav {
  position: fixed;
  top: 0;
  right: 0;
  left: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 64px;
  // [B-33] 与 main 内容区 padding 完全一致（clamp 48~72px），让 <> / 头像与内容左右缘对齐。
  padding: 0 clamp(48px, 4vw, 72px);
  backdrop-filter: saturate(180%) blur(20px);

  background-color: var(--color-navbar-bg);
  z-index: 100;
  -webkit-app-region: drag;
}

@supports (-moz-appearance: none) {
  nav {
    background-color: var(--color-body-bg);
  }
}

nav.has-custom-titlebar {
  padding-top: 20px;
  -webkit-app-region: no-drag;
}

.navigation-buttons {
  flex: 1;
  display: flex;
  align-items: center;
  // [B-32] 抵消第一个 button-icon 的 margin(4px)+padding(8px)=12px，
  // 让 < 箭头图标左缘与下方"我的订阅"标题左缘平齐（共用内容区左缘锚点）。
  margin-left: -12px;
  .svg-icon {
    height: 24px;
    width: 24px;
  }
  // [B-44] 前进键 = 返回键水平镜像
  .flip-x {
    transform: scaleX(-1);
  }
  button {
    -webkit-app-region: no-drag;
  }
}
@media (max-width: 970px) {
  .navigation-buttons {
    flex: unset;
  }
}

.navigation-links {
  // [B-63 改] 首页/我的订阅 **绝对居中**（原则：搜索非主要入口，导航链接才是画面锚点）。
  //   绝对定位脱离流，不受左右元素影响，永远屏幕正中。
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  justify-content: center;
  text-transform: uppercase;
  user-select: none;
  a {
    -webkit-app-region: no-drag;
    font-size: 18px;
    font-weight: 700;
    text-decoration: none;
    border-radius: 6px;
    padding: 6px 10px;
    color: var(--color-text);
    transition: 0.2s;
    -webkit-user-drag: none;
    margin: {
      right: 12px;
      left: 12px;
    }
    &:hover {
      background: var(--color-secondary-bg-for-transparent);
    }
    &:active {
      transform: scale(0.92);
      transition: 0.2s;
    }
  }
  a.active {
    color: var(--color-primary);
  }
}

.search {
  .svg-icon {
    height: 18px;
    width: 18px;
  }
}

.search-box {
  // [B-63 改] nav-links 已绝对居中 → 这里 flex:1 占据右半区，把(缩小后的)搜索框
  //   居中在「我的订阅(屏幕中)」与头像之间。搜索非主入口，做小、不喧宾夺主。
  flex: 1;
  display: flex;
  justify-content: center;
  -webkit-app-region: no-drag;

  .container {
    display: flex;
    align-items: center;
    height: 32px;
    background: var(--color-secondary-bg-for-transparent);
    border-radius: var(--radius-button);
    // 宽度仅够「🔍 搜索播客」+ 清除×，不再占大块
    width: 168px;
    // [B-52] 轻反馈 + 聚焦缩放动画
    transition: transform 0.18s ease, background 0.18s ease;
    transform-origin: right center;
    &:hover {
      background: var(--color-primary-bg-for-transparent);
      transform: scale(1.02);
    }
  }

  .svg-icon {
    // [B-63改] 放大到≈字体大小(16px)、与右侧×一致；左 margin 加大 → 内容整体右移约两个字身，
    //   平衡"视觉重心偏左"。
    height: 16px;
    width: 16px;
    color: var(--color-text);
    opacity: 0.4;
    margin: {
      left: 24px;
      right: 7px;
    }
  }

  input {
    font-size: 16px;
    border: none;
    background: transparent;
    width: 96%;
    font-weight: 600;
    margin-top: -1px;
    color: var(--color-text);
    transition: color 0.18s ease, opacity 0.18s ease;
    // [B-63] 隐藏原生搜索清除按钮（改用自定义 .clear-icon，颜色可控、无怪异过渡）
    &::-webkit-search-cancel-button {
      -webkit-appearance: none;
      appearance: none;
    }
  }

  // [B-63] 自定义清除 ×：button 包裹确保可点；颜色跟随文字（默认稍淡，hover 实）
  .clear-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: 0 6px 0 2px;
    padding: 2px;
    background: transparent;
    border: none;
    color: var(--color-text);
    opacity: 0.5;
    cursor: pointer;
    -webkit-app-region: no-drag;
    transition: opacity 0.15s ease;
    .svg-icon {
      width: 15px; // [B-63改] 与放大镜/字体大小一致
      height: 15px;
      margin: 0; // 覆盖 .search-box .svg-icon 的左右 margin
      opacity: 1; // 覆盖放大镜的 opacity，避免与 button opacity 叠加过淡
    }
    &:hover {
      opacity: 0.95;
    }
  }

  // [B-63] 离开搜索页未清除：残留关键词暗下去（hover 不变，focus 才复原）
  .container.dimmed input {
    opacity: 0.4;
  }

  .active {
    background: var(--color-primary-bg-for-transparent);
    transform: scale(1.03);
    input,
    .svg-icon {
      opacity: 1;
      color: var(--color-primary);
    }
  }
}

[data-theme='dark'] {
  .search-box {
    .active {
      input,
      .svg-icon {
        color: var(--color-text);
      }
    }
  }
}

// [NAS][呼吸灯 v2.0] 状态图标呼吸灯（在线绿态缓慢呼吸；离线红态静止不加此动画）。
//   单点不加错相位(无从比对)，但同步调慢 3.6s + 柔和不对称曲线，与节目/单集点同一呼吸气质。
@keyframes nas-breathe {
  0% {
    opacity: 0.5;
    animation-timing-function: cubic-bezier(0.45, 0, 0.55, 1);
  }
  40% {
    opacity: 1;
    animation-timing-function: cubic-bezier(0.45, 0, 0.55, 1);
  }
  100% {
    opacity: 0.5;
  }
}
// [NAS] 连接状态图标：放「我的订阅」旁(navigation-links 内)，绿(在线·呼吸)/红(断联·静止)
.nas-status {
  -webkit-app-region: no-drag;
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  margin-left: 10px;
  vertical-align: middle;
  .svg-icon {
    width: 18px;
    height: 18px;
  }
  // 呼吸/hover 只作用在图标本身，不波及下方的 tooltip（否则 tooltip 会跟着呼吸忽明忽暗）。
  &.online .svg-icon {
    animation: nas-breathe 3.6s ease-in-out infinite;
  }
  &.online {
    color: #1db954;
  }
  &.offline {
    color: #e74c3c;
  }
  &:hover .svg-icon {
    filter: brightness(1.15);
  }
  // [NAS] 自定义连接提示，替代丑的原生 title：干净深色胶囊、无边框、hover 淡入下滑。
  .nas-tip {
    position: absolute;
    top: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%) translateY(-2px);
    white-space: nowrap;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    color: #fff;
    background: rgba(38, 38, 42, 0.94);
    padding: 6px 10px;
    border-radius: 8px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 0.15s ease, transform 0.15s ease;
    z-index: 100;
  }
  &:hover .nas-tip {
    opacity: 1;
    visibility: visible;
    transform: translateX(-50%) translateY(0);
  }
}
// [NAS] 启停过渡：图标宽度/外边距/透明度一起渐变 → 绝对居中的 nav-links 跟着缓缓归位，
//   消除「关闭 NAS 后『我的订阅』瞬间补位」的生切。收起期间停掉呼吸动画，免与 opacity 打架。
.nas-collapse-enter-active,
.nas-collapse-leave-active {
  // all：一次过渡 max-width/margin-left/opacity/transform，单行免触发 prettier 换行规则
  transition: all 0.35s ease;
  overflow: hidden;
  animation: none !important;
}
.nas-collapse-enter,
.nas-collapse-leave-to {
  opacity: 0;
  max-width: 0;
  margin-left: 0;
  transform: scale(0.4);
}
.nas-collapse-enter-to,
.nas-collapse-leave {
  opacity: 1;
  max-width: 28px; // 图标 18 + margin-left 10
}
.right-part {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  .avatar {
    user-select: none;
    height: 30px;
    margin-left: 12px;
    vertical-align: -7px;
    border-radius: 50%;
    cursor: pointer;
    -webkit-app-region: no-drag;
    -webkit-user-drag: none;
    &:hover {
      filter: brightness(80%);
    }
  }
  .search-button {
    display: none;
    -webkit-app-region: no-drag;
  }
}
</style>
