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
        <router-link to="/" :class="{ active: $route.name === 'home' }">{{
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
          :class="{ active: $route.name === 'library' }"
          >{{ $t('nav.library') }}</router-link
        >
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
              class="clear-btn"
              title="清除"
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
      <!-- [A-26] "我的"二级菜单：收藏 / 下载 / 收听历史 / 设置 -->
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
      <!-- [B-38] 收听数据图标：duration -->
      <div class="item" @click="toStats">
        <svg-icon icon-class="duration" />
        收听数据
      </div>
      <!-- [B-47 第5点] 已屏蔽节目 -->
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
  methods: {
    go(where) {
      if (where === 'back') this.$router.go(-1);
      else this.$router.go(1);
    },
    doSearch() {
      const kw = (this.keywords || '').trim();
      if (!kw) return;
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
      this.$refs.userProfileMenu.openMenu(e);
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
    border-radius: 8px;
    // 宽度仅够「🔍 搜索播客」+ 清除×，不再占大块
    width: 150px;
    // [B-52] 轻反馈 + 聚焦缩放动画
    transition: transform 0.18s ease, background 0.18s ease;
    transform-origin: right center;
    &:hover {
      background: var(--color-primary-bg-for-transparent);
      transform: scale(1.02);
    }
  }

  .svg-icon {
    height: 15px;
    width: 15px;
    color: var(--color-text);
    opacity: 0.28;
    margin: {
      left: 8px;
      right: 4px;
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
      width: 13px;
      height: 13px;
      margin: 0; // 覆盖 .search-box .svg-icon 的左右 margin
      opacity: 1; // 覆盖放大镜的 0.28，避免与 button opacity 叠加过淡
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
