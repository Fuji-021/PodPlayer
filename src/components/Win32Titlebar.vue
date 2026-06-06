<template>
  <div class="win32-titlebar">
    <!-- [播客改造 A-27] 软件名 → PodPlayer + on-air-square logo + @Fujii 署名 -->
    <div class="title">{{ playerTitle }}</div>
    <div class="brand">
      <svg-icon class="brand-logo" icon-class="on-air-square" />
      <span class="brand-sig">@Fujii</span>
    </div>
    <div class="controls">
      <div
        class="button minimize codicon codicon-chrome-minimize"
        @click="windowMinimize"
      ></div>
      <div
        class="button max-restore codicon"
        :class="{
          'codicon-chrome-restore': isMaximized,
          'codicon-chrome-maximize': !isMaximized,
        }"
        @click="windowMaxRestore"
      ></div>
      <div
        class="button close codicon codicon-chrome-close"
        @click="windowClose"
      ></div>
    </div>
  </div>
</template>

<script>
// icons by https://github.com/microsoft/vscode-codicons
import 'vscode-codicons/dist/codicon.css';

import { mapState } from 'vuex';

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer =
  process.env.IS_ELECTRON === true ? electron.ipcRenderer : null;

export default {
  name: 'Win32Titlebar',
  components: {
    SvgIcon: () => import('@/components/SvgIcon.vue'),
  },
  data() {
    return {
      isMaximized: false,
    };
  },
  computed: {
    ...mapState(['title']),
    // [A-27] 把"YesPlayMusic"替换为"PodPlayer"
    playerTitle() {
      return (this.title || 'PodPlayer').replace(/YesPlayMusic/g, 'PodPlayer');
    },
  },
  created() {
    if (process.env.IS_ELECTRON === true) {
      ipcRenderer.on('isMaximized', (_, value) => {
        this.isMaximized = value;
      });
    }
  },
  methods: {
    windowMinimize() {
      ipcRenderer.send('minimize');
    },
    windowMaxRestore() {
      ipcRenderer.send('maximizeOrUnmaximize');
    },
    windowClose() {
      ipcRenderer.send('close');
    },
  },
};
</script>

<style lang="scss" scoped>
.win32-titlebar {
  color: var(--color-text);
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  -webkit-app-region: drag;
  display: flex;
  align-items: center;
  --hover: #e6e6e6;
  --active: #cccccc;

  .title {
    padding: 8px 12px;
    font-size: 12px;
    font-family: 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif;
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-right: 0;
  }
  // [A-27 / bug 修复] 品牌区域：与 .title 同亮度（删除 opacity: 0.6）
  .brand {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-left: 6px;
    flex-shrink: 0;
    .brand-logo {
      width: 14px;
      height: 14px;
    }
    .brand-sig {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
  }
  .controls {
    height: 32px;
    margin-left: auto;
    justify-content: flex-end;
    display: flex;
    .button {
      height: 100%;
      width: 46px;
      font-size: 16px;
      display: flex;
      justify-content: center;
      align-items: center;
      -webkit-app-region: no-drag;
      &:hover {
        background: var(--hover);
      }
      &:active {
        background: var(--active);
      }
      &.close {
        &:hover {
          background: #c42c1b;
          color: rgba(255, 255, 255, 0.8);
        }
        &:active {
          background: #f1707a;
          color: #000;
        }
      }
    }
  }
}
[data-theme='dark'] .win32-titlebar {
  --hover: #191919;
  --active: #333333;
}
</style>
