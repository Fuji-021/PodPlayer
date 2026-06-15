<template>
  <div class="settings-page" @click="clickOutside">
    <div class="container">
      <div v-if="showUserInfo" class="user">
        <div class="left">
          <img class="avatar" :src="data.user.avatarUrl" loading="lazy" />
          <div class="info">
            <div class="nickname">{{ data.user.nickname }}</div>
            <div class="extra-info">
              <span v-if="data.user.vipType !== 0" class="vip"
                ><img
                  class="cvip"
                  src="data:image/png;base64,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"
                  loading="lazy"
                />
                <span class="text">黑胶VIP</span>
              </span>
              <span v-else class="text">{{ data.user.signature }}</span>
            </div>
          </div>
        </div>
        <div class="right">
          <button @click="logout">
            <svg-icon icon-class="logout" />
            {{ $t('settings.logout') }}
          </button>
        </div>
      </div>

      <div class="item">
        <div class="left">
          <div class="title"> {{ $t('settings.language') }} </div>
        </div>
        <div class="right">
          <select v-model="lang">
            <option value="en">🇬🇧 English</option>
            <option value="tr">🇹🇷 Türkçe</option>
            <option value="zh-CN">🇨🇳 简体中文</option>
            <option value="zh-TW">繁體中文</option>
          </select>
        </div>
      </div>
      <div class="item">
        <div class="left">
          <div class="title"> {{ $t('settings.appearance.text') }} </div>
        </div>
        <div class="right">
          <select v-model="appearance">
            <option value="auto">{{ $t('settings.appearance.auto') }}</option>
            <option value="light"
              >🌞 {{ $t('settings.appearance.light') }}</option
            >
            <option value="dark"
              >🌚 {{ $t('settings.appearance.dark') }}</option
            >
          </select>
        </div>
      </div>
      <div v-if="isElectron" class="item">
        <div class="left">
          <div class="title"> {{ $t('settings.trayIcon.text') }} </div>
        </div>
        <div class="right">
          <select v-model="trayIconTheme">
            <option value="auto">{{ $t('settings.trayIcon.auto') }}</option>
            <option value="light">{{ $t('settings.trayIcon.light') }}</option>
            <option value="dark">{{ $t('settings.trayIcon.dark') }}</option>
          </select>
        </div>
      </div>
      <!-- [删] 「音乐语种偏好」(网易云推荐语种) + 「音质选择」(网易云码率)：与播客无关、本就没法用，已删。 -->

      <div v-if="isElectron" class="item">
        <div class="left">
          <div class="title"> {{ $t('settings.deviceSelector') }} </div>
        </div>
        <div class="right">
          <select v-model="outputDevice" v-tip="currentOutputDeviceLabel">
            <option
              v-for="device in allOutputDevices"
              :key="device.deviceId"
              :value="device.deviceId"
              :selected="device.deviceId == outputDevice"
            >
              {{ $t(device.label) }}
            </option>
          </select>
        </div>
      </div>

      <!-- [NAS] 就近音源配置中心：总开关 + 当前连接 + 连接历史(一键切换) + 添加(自动发现库) -->
      <h3 v-if="isElectron">NAS 就近音源</h3>
      <div v-if="isElectron" class="item">
        <div class="left">
          <div class="title">启用 NAS 就近音源</div>
          <div class="description">
            已归档的单集就近从 NAS 流式播放，更快、零流量；NAS
            不可用时自动回落在线音源。
          </div>
        </div>
        <div class="right">
          <div class="toggle">
            <input
              id="nas-enable"
              type="checkbox"
              :checked="nas.enabled"
              @change="toggleNas($event)"
            />
            <label for="nas-enable"></label>
          </div>
        </div>
      </div>
      <div v-if="isElectron" class="item">
        <div class="left">
          <div class="title">订阅时自动托管到 NAS</div>
          <div class="description">
            新订阅的节目自动在 NAS 上创建并开启自动下载（留最近 100 集）；未连接
            NAS 时此项无效，可随时关闭回退。
          </div>
        </div>
        <div class="right">
          <div class="toggle">
            <input
              id="nas-handoff-enable"
              v-model="nasHandoffEnabled"
              type="checkbox"
              name="nas-handoff-enable"
            />
            <label for="nas-handoff-enable"></label>
          </div>
        </div>
      </div>
      <div v-if="isElectron && activeProfile" class="item">
        <div class="left">
          <div class="title">
            <span
              class="nas-cfg-dot"
              :class="nas.status.alive ? 'on' : 'off'"
            ></span>
            当前连接：{{ activeProfile.name }}
          </div>
          <div class="description">{{ activeProfileDesc }}</div>
        </div>
        <div class="right">
          <button @click="testCurrentNas">测试连接</button>
        </div>
      </div>
      <div v-if="isElectron && nas.profiles.length" class="item nas-history">
        <div class="left nas-history-left">
          <div class="title">连接历史</div>
          <div
            v-for="p in nas.profiles"
            :key="p.id"
            class="nas-profile-row"
            :class="{ active: p.id === nas.activeProfileId }"
          >
            <span
              class="nas-cfg-dot"
              :class="
                p.id === nas.activeProfileId && nas.status.alive ? 'on' : 'off'
              "
            ></span>
            <span class="np-name">{{ p.name }}</span>
            <span class="np-base">{{ shortHost(p.baseUrl) }}</span>
            <span class="np-ago">{{ fmtAgo(p.lastConnectedAt) }}</span>
            <span v-if="p.id === nas.activeProfileId" class="np-current"
              >当前</span
            >
            <button v-else class="np-btn" @click="connectProfile(p.id)">
              连接
            </button>
            <button class="np-btn" @click="editProfile(p)">编辑</button>
            <button class="np-btn danger" @click="removeProfile(p)"
              >删除</button
            >
          </div>
        </div>
      </div>
      <div v-if="isElectron" class="item">
        <div class="left">
          <div class="title">添加连接</div>
        </div>
        <div class="right">
          <button @click="openNasDialog()">+ 添加 NAS 连接</button>
        </div>
      </div>

      <!-- [§12] 「自定义」段(连接 Last.fm 听歌 scrobble + Discord Rich Presence「正在听」)=
           网易云音乐专属、与播客无关，已删；NAS 入口为独立的「NAS 就近音源」段。 -->
      <h3>{{ $t('settings.others') }}</h3>
      <div v-if="isElectron && !isMac" class="item">
        <div class="left">
          <div class="title"> {{ $t('settings.closeAppOption.text') }} </div>
        </div>
        <div class="right">
          <select v-model="closeAppOption">
            <option value="ask">
              {{ $t('settings.closeAppOption.ask') }}
            </option>
            <option value="exit">
              {{ $t('settings.closeAppOption.exit') }}
            </option>
            <option value="minimizeToTray">
              {{ $t('settings.closeAppOption.minimizeToTray') }}
            </option>
          </select>
        </div>
      </div>

      <div v-if="isElectron && isLinux" class="item">
        <div class="left">
          <div class="title"> {{ $t('settings.enableCustomTitlebar') }} </div>
        </div>
        <div class="right">
          <div class="toggle">
            <input
              id="enable-custom-titlebar"
              v-model="enableCustomTitlebar"
              type="checkbox"
              name="enable-custom-titlebar"
            />
            <label for="enable-custom-titlebar"></label>
          </div>
        </div>
      </div>

      <!-- [启动页] 启动后显示：首页 / 我的订阅 二选一。原 YesPlayMusic「启动后显示音乐库」布尔开关，
           改造为播客语义的二选一；纯渲染端实现(main.js onReady 按 settings.showLibraryDefault redirect)。 -->
      <div v-if="isElectron" class="item">
        <div class="left">
          <div class="title">启动后显示</div>
        </div>
        <div class="right">
          <select v-model="startupPageChoice">
            <option value="home">首页</option>
            <option value="library">我的订阅</option>
          </select>
        </div>
      </div>

      <!-- [日志] 出问题时打开日志文件排查/发开发者；落 userData\logs\main.log -->
      <div v-if="isElectron" class="item">
        <div class="left">
          <div class="title">应用日志</div>
          <div class="description">
            出问题时点开看日志文件，便于排查（也可发给开发者定位）。
          </div>
        </div>
        <div class="right">
          <button @click="openLogFolder">打开日志文件夹</button>
        </div>
      </div>

      <!-- [§12] 已删 3 个网易云音乐专属开关：Apple Music 歌单(showPlaylistsByAppleMusic)、
           双语字幕(subTitleDefault)、倒序播放(enableReversedMode) —— 播客无关。 -->
      <div class="item">
        <div class="left">
          <!-- [设置] 彩虹猫=吉祥物：进度条样式开关，标题直接用吉祥物 gif(后续会加更多样式) -->
          <div v-tip="'进度条彩虹猫样式'" class="title nyancat-title">
            <img src="/img/logos/nyancat.gif" alt="进度条彩虹猫样式" />
          </div>
        </div>
        <div class="right">
          <div class="toggle">
            <input
              id="nyancat-style"
              v-model="nyancatStyle"
              type="checkbox"
              name="nyancat-style"
            />
            <label for="nyancat-style"></label>
          </div>
        </div>
      </div>

      <!-- [§12] 已删「代理」+「Real IP」段：原为网易云 API 走代理 / 伪装 IP 绕区域限制；
           本应用播客 RSS 走主进程直连、下载走 Node 原生 https(Clash TUN 路由)，不依赖此设置。
           底层 proxy/realIP 配置逻辑保留(dormant)、仅移除 UI 配置项。 -->
      <div v-if="isElectron">
        <h3>快捷键</h3>
        <div class="item">
          <div class="left">
            <div class="title"> {{ $t('settings.enableGlobalShortcut') }}</div>
          </div>
          <div class="right">
            <div class="toggle">
              <input
                id="enable-enable-global-shortcut"
                v-model="enableGlobalShortcut"
                type="checkbox"
                name="enable-enable-global-shortcut"
              />
              <label for="enable-enable-global-shortcut"></label>
            </div>
          </div>
        </div>
        <div
          id="shortcut-table"
          :class="{ 'global-disabled': !enableGlobalShortcut }"
          tabindex="0"
          @keydown="handleShortcutKeydown"
        >
          <div class="row row-head">
            <div class="col">功能</div>
            <div class="col">快捷键</div>
            <div class="col">全局快捷键</div>
          </div>
          <div
            v-for="shortcut in settings.shortcuts"
            :key="shortcut.id"
            class="row"
          >
            <div class="col">{{ shortcutName(shortcut.id) }}</div>
            <div class="col">
              <div
                class="keyboard-input"
                :class="{
                  active:
                    shortcutInput.id === shortcut.id &&
                    shortcutInput.type === 'shortcut',
                }"
                @click.stop="readyToRecordShortcut(shortcut.id, 'shortcut')"
              >
                {{
                  shortcutInput.id === shortcut.id &&
                  shortcutInput.type === 'shortcut' &&
                  recordedShortcutComputed !== ''
                    ? formatShortcut(recordedShortcutComputed)
                    : formatShortcut(shortcut.shortcut)
                }}
              </div>
            </div>
            <div class="col">
              <div
                class="keyboard-input"
                :class="{
                  active:
                    shortcutInput.id === shortcut.id &&
                    shortcutInput.type === 'globalShortcut' &&
                    enableGlobalShortcut,
                }"
                @click.stop="
                  readyToRecordShortcut(shortcut.id, 'globalShortcut')
                "
                >{{
                  shortcutInput.id === shortcut.id &&
                  shortcutInput.type === 'globalShortcut' &&
                  recordedShortcutComputed !== ''
                    ? formatShortcut(recordedShortcutComputed)
                    : formatShortcut(shortcut.globalShortcut)
                }}</div
              >
            </div>
          </div>
          <button
            class="restore-default-shortcut"
            @click="restoreDefaultShortcuts"
            >恢复默认快捷键</button
          >
        </div>
      </div>

      <div class="footer">
        <p class="author">DESIGN BY FUJII</p>
        <p class="version">v{{ version }}</p>

        <a
          v-if="!isElectron"
          href="https://vercel.com/?utm_source=ohmusic&utm_campaign=oss"
        >
          <img
            height="36"
            src="https://www.datocms-assets.com/31049/1618983297-powered-by-vercel.svg"
          />
        </a>
      </div>
    </div>
    <!-- [NAS] 添加/编辑连接弹窗：填地址+token → 测试并发现库(免手填 UUID) → 保存 -->
    <div
      v-if="nasDialog.open"
      class="nas-dialog-mask"
      @click.self="closeNasDialog"
    >
      <div class="nas-dialog">
        <div class="nd-title">
          {{ nasDialog.editId ? '编辑 NAS 连接' : '添加 NAS 连接' }}
        </div>
        <label class="nd-field"
          >名称（可选）
          <input v-model="nasDialog.name" placeholder="如：家里飞牛" />
        </label>
        <label class="nd-field"
          >地址
          <input
            v-model="nasDialog.baseUrl"
            placeholder="http://192.168.2.108:13378/audiobookshelf"
          />
        </label>
        <label class="nd-field"
          >Token
          <input
            v-model="nasDialog.token"
            :placeholder="
              nasDialog.editId
                ? '留空 = 沿用原 token'
                : 'ABS → 设置 → 用户 → API Token'
            "
          />
        </label>
        <button
          class="nd-test"
          :disabled="nasDialog.testing"
          @click="testAndDiscover"
        >
          {{ nasDialog.testing ? '连接中…' : '测试并发现库' }}
        </button>
        <div
          v-if="nasDialog.testMsg"
          class="nd-msg"
          :class="{ ok: nasDialog.testOk }"
        >
          {{ nasDialog.testMsg }}
        </div>
        <label v-if="nasDialog.libraries.length" class="nd-field"
          >库
          <select v-model="nasDialog.libraryId">
            <option v-for="l in nasDialog.libraries" :key="l.id" :value="l.id">
              {{ l.name }}
            </option>
          </select>
        </label>
        <div class="nd-actions">
          <button @click="closeNasDialog">取消</button>
          <button
            class="primary"
            :disabled="!nasDialog.libraryId"
            @click="saveNasDialog"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { mapState, mapActions } from 'vuex';
import { isLooseLoggedIn, doLogout } from '@/utils/auth';
import { changeAppearance } from '@/utils/common';
import defaultShortcuts from '@/utils/shortcuts';
import pkg from '../../package.json';
// [NAS] 配置中心：多档连接 + 自动发现库 + 一键切换（token 仅主进程）
import {
  listNasProfiles,
  saveNasProfile,
  deleteNasProfile,
  activateNasProfile,
  setNasEnabled,
  listNasLibraries,
  testNasReachable,
  nasStatus,
  initNas,
} from '@/utils/podcast/nasSource';

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer =
  process.env.IS_ELECTRON === true ? electron.ipcRenderer : null;

const validShortcutCodes = ['=', '-', '~', '[', ']', ';', "'", ',', '.', '/'];

export default {
  name: 'Settings',
  data() {
    return {
      allOutputDevices: [
        {
          deviceId: 'default',
          label: 'settings.permissionRequired',
        },
      ],
      shortcutInput: {
        id: '',
        type: '',
        recording: false,
      },
      recordedShortcut: [],
      // [NAS] 配置中心状态
      nas: {
        enabled: false,
        status: { enabled: false, alive: false },
        activeProfileId: '',
        profiles: [],
      },
      nasDialog: {
        open: false,
        editId: '',
        name: '',
        baseUrl: '',
        token: '',
        libraries: [],
        libraryId: '',
        testing: false,
        testMsg: '',
        testOk: false,
      },
    };
  },
  computed: {
    ...mapState(['player', 'settings', 'data', 'lastfm']),
    isElectron() {
      return process.env.IS_ELECTRON;
    },
    isMac() {
      return /macintosh|mac os x/i.test(navigator.userAgent);
    },
    isLinux() {
      return process.platform === 'linux';
    },
    version() {
      return pkg.version;
    },
    // [NAS] 当前激活连接档 + 描述
    activeProfile() {
      return (
        this.nas.profiles.find(p => p.id === this.nas.activeProfileId) || null
      );
    },
    activeProfileDesc() {
      const p = this.activeProfile;
      if (!p) return '';
      return (
        this.shortHost(p.baseUrl) +
        (p.libraryName ? ' · 库：' + p.libraryName : '')
      );
    },
    showUserInfo() {
      return isLooseLoggedIn() && this.data.user.nickname;
    },
    recordedShortcutComputed() {
      let shortcut = [];
      this.recordedShortcut.map(e => {
        if (e.keyCode >= 65 && e.keyCode <= 90) {
          // A-Z
          shortcut.push(e.code.replace('Key', ''));
        } else if (e.key === 'Meta') {
          // ⌘ Command on macOS
          shortcut.push('Command');
        } else if (['Alt', 'Control', 'Shift'].includes(e.key)) {
          shortcut.push(e.key);
        } else if (e.keyCode >= 48 && e.keyCode <= 57) {
          // 0-9
          shortcut.push(e.code.replace('Digit', ''));
        } else if (e.keyCode >= 112 && e.keyCode <= 123) {
          // F1-F12
          shortcut.push(e.code);
        } else if (
          ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)
        ) {
          // Arrows
          shortcut.push(e.code.replace('Arrow', ''));
        } else if (validShortcutCodes.includes(e.key)) {
          shortcut.push(e.key);
        }
      });
      const sortTable = {
        Control: 1,
        Shift: 2,
        Alt: 3,
        Command: 4,
      };
      shortcut = shortcut.sort((a, b) => {
        if (!sortTable[a] || !sortTable[b]) return 0;
        if (sortTable[a] - sortTable[b] <= -1) {
          return -1;
        } else if (sortTable[a] - sortTable[b] >= 1) {
          return 1;
        } else {
          return 0;
        }
      });
      shortcut = shortcut.join('+');
      return shortcut;
    },

    lang: {
      get() {
        return this.settings.lang;
      },
      set(lang) {
        this.$i18n.locale = lang;
        this.$store.commit('changeLang', lang);
      },
    },
    // [音频设备] 当前选中设备完整名称 → outputDevice select 的 :title 悬停看全名(框内省略号折叠时)。
    currentOutputDeviceLabel() {
      const d = this.allOutputDevices.find(
        x => x.deviceId === this.outputDevice
      );
      return d ? this.$t(d.label) : '';
    },
    appearance: {
      get() {
        if (this.settings.appearance === undefined) return 'auto';
        return this.settings.appearance;
      },
      set(value) {
        this.$store.commit('updateSettings', {
          key: 'appearance',
          value,
        });
        changeAppearance(value);
      },
    },
    trayIconTheme: {
      get() {
        if (this.settings.trayIconTheme === undefined) return 'auto';
        return this.settings.trayIconTheme;
      },
      set(value) {
        this.$store.commit('updateSettings', {
          key: 'trayIconTheme',
          value,
        });
        if (this.isElectron) {
          ipcRenderer.send('updateTrayIcon', value);
        }
      },
    },
    outputDevice: {
      get() {
        const isValidDevice = this.allOutputDevices.find(
          device => device.deviceId === this.settings.outputDevice
        );
        if (
          this.settings.outputDevice === undefined ||
          isValidDevice === undefined
        )
          return 'default'; // Default deviceId
        return this.settings.outputDevice;
      },
      set(deviceId) {
        if (deviceId === this.settings.outputDevice || deviceId === undefined)
          return;
        this.$store.commit('changeOutputDevice', deviceId);
        this.player.setOutputDevice();
      },
    },
    nyancatStyle: {
      get() {
        if (this.settings.nyancatStyle === undefined) return false;
        return this.settings.nyancatStyle;
      },
      set(value) {
        this.$store.commit('updateSettings', {
          key: 'nyancatStyle',
          value,
        });
      },
    },
    closeAppOption: {
      get() {
        return this.settings.closeAppOption;
      },
      set(value) {
        this.$store.commit('updateSettings', {
          key: 'closeAppOption',
          value,
        });
      },
    },
    enableGlobalShortcut: {
      get() {
        return this.settings.enableGlobalShortcut;
      },
      set(value) {
        this.$store.commit('updateSettings', {
          key: 'enableGlobalShortcut',
          value,
        });
      },
    },
    // [NAS 托管·P0] 订阅自动托管总开关。未设=默认开(!== false 兼容老用户)。
    nasHandoffEnabled: {
      get() {
        return this.settings.nasHandoffEnabled !== false;
      },
      set(value) {
        this.$store.commit('updateSettings', {
          key: 'nasHandoffEnabled',
          value,
        });
      },
    },
    // [启动页] 二选一(home/library)。用全新 key startupPage(缺省 home)，**不复用旧 showLibraryDefault**——
    //   老 YesPlayMusic 用户那键多被持久化成 true(B-79 当年正因此强制首页)，复用会把他们误带进我的订阅。
    //   新键缺省即 home、保持现状；main.js onReady 读 settings.startupPage 决定是否 replace 到 /library。
    startupPageChoice: {
      get() {
        return this.settings.startupPage === 'library' ? 'library' : 'home';
      },
      set(value) {
        this.$store.commit('updateSettings', {
          key: 'startupPage',
          value: value === 'library' ? 'library' : 'home',
        });
      },
    },
    enableCustomTitlebar: {
      get() {
        return this.settings.linuxEnableCustomTitlebar;
      },
      set(value) {
        this.$store.commit('updateSettings', {
          key: 'linuxEnableCustomTitlebar',
          value,
        });
      },
    },
  },
  created() {
    if (process.env.IS_ELECTRON) {
      this.getAllOutputDevices();
      this.loadNas();
      this.startNasPoll();
    }
  },
  activated() {
    if (process.env.IS_ELECTRON) {
      this.getAllOutputDevices();
      this.loadNas();
      this.startNasPoll();
    }
  },
  deactivated() {
    this.stopNasPoll();
  },
  beforeDestroy() {
    this.stopNasPoll();
  },
  methods: {
    ...mapActions(['showToast']),
    // [日志] 打开日志文件夹(主进程 shell 定位 main.log)；非 electron 无操作。
    openLogFolder() {
      if (!this.isElectron) return;
      try {
        window.require('electron').ipcRenderer.invoke('app:openLogs');
      } catch (e) {
        /* ignore */
      }
    },
    // ===== [NAS] 配置中心方法 =====
    async loadNas() {
      const r = await listNasProfiles();
      this.nas.enabled = !!r.enabled;
      this.nas.activeProfileId = r.activeProfileId || '';
      this.nas.profiles = r.profiles || [];
      this.nas.status = nasStatus();
    },
    startNasPoll() {
      if (this._nasPoll) return;
      this._nasPoll = setInterval(() => {
        this.nas.status = nasStatus();
      }, 2000);
    },
    stopNasPoll() {
      if (this._nasPoll) {
        clearInterval(this._nasPoll);
        this._nasPoll = null;
      }
    },
    async toggleNas(e) {
      const on = !!(e && e.target && e.target.checked);
      await setNasEnabled(on);
      this.nas.enabled = on;
      this.nas.status = nasStatus();
    },
    async testCurrentNas() {
      // [#16 修] 走 testNasReachable(不看总开关) → 总开关关闭时也能真测可达性，不再恒报失败。
      const r = await testNasReachable();
      this.nas.status = nasStatus();
      this.showToast(r && r.ok ? 'NAS 连接正常' : 'NAS 暂时连不上');
    },
    shortHost(url) {
      const m = String(url || '').match(/^https?:\/\/([^/]+)/i);
      return m ? m[1] : String(url || '');
    },
    fmtAgo(ts) {
      if (!ts) return '从未连接';
      const d = Date.now() - ts;
      if (d < 60000) return '刚刚';
      if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
      if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
      return Math.floor(d / 86400000) + ' 天前';
    },
    openNasDialog(profile) {
      const p = profile || null;
      this.nasDialog = {
        open: true,
        editId: p ? p.id : '',
        name: p ? p.name : '',
        baseUrl: p ? p.baseUrl : '',
        token: '',
        libraries:
          p && p.libraryId
            ? [{ id: p.libraryId, name: p.libraryName || '(已选库)' }]
            : [],
        libraryId: p ? p.libraryId : '',
        testing: false,
        testMsg: '',
        testOk: !!(p && p.libraryId),
      };
    },
    closeNasDialog() {
      this.nasDialog.open = false;
    },
    async testAndDiscover() {
      const d = this.nasDialog;
      if (!d.baseUrl) {
        d.testMsg = '请填写地址';
        return;
      }
      if (!d.token) {
        d.testMsg = d.editId
          ? '如需重新发现库，请重新填入 token'
          : '请填写 token';
        return;
      }
      d.testing = true;
      d.testMsg = '正在连接…';
      d.testOk = false;
      const r = await listNasLibraries(d.baseUrl, d.token);
      d.testing = false;
      if (r && r.ok) {
        d.libraries = r.libraries || [];
        if (d.libraries.length && !d.libraryId) d.libraryId = d.libraries[0].id;
        d.testOk = true;
        d.testMsg = '连接成功，发现 ' + d.libraries.length + ' 个播客库';
      } else {
        d.testOk = false;
        d.testMsg = '连接失败：' + ((r && r.error) || '检查地址 / token');
      }
    },
    async saveNasDialog() {
      const d = this.nasDialog;
      if (!d.baseUrl) {
        d.testMsg = '请填写地址';
        return;
      }
      if (!d.libraryId) {
        d.testMsg = '请先「测试并发现库」并选择库';
        return;
      }
      const lib = d.libraries.find(l => l.id === d.libraryId);
      const r = await saveNasProfile({
        id: d.editId || undefined,
        name: d.name,
        baseUrl: d.baseUrl,
        token: d.token,
        libraryId: d.libraryId,
        libraryName: lib ? lib.name : '',
      });
      if (r && r.ok) {
        const hadActive = !!this.nas.activeProfileId;
        const wasEditingActive =
          d.editId && d.editId === this.nas.activeProfileId;
        this.closeNasDialog();
        await this.loadNas();
        if (!hadActive && r.id) {
          await this.connectProfile(r.id); // 首档自动激活(内含 initNas 刷新)
        } else if (wasEditingActive) {
          await initNas(); // [修] 编辑的是当前档(如改名) → 刷新 toast 用的 activeName，否则提示仍显旧名
        }
        this.showToast('已保存 NAS 连接');
      } else {
        d.testMsg = '保存失败：' + ((r && r.error) || '');
      }
    },
    async connectProfile(id) {
      await activateNasProfile(id);
      await this.loadNas();
      this.showToast('已切换 NAS 连接');
    },
    editProfile(p) {
      this.openNasDialog(p);
    },
    async removeProfile(p) {
      await deleteNasProfile(p.id);
      await this.loadNas();
    },
    getAllOutputDevices() {
      navigator.mediaDevices.enumerateDevices().then(devices => {
        this.allOutputDevices = devices.filter(device => {
          return device.kind == 'audiooutput';
        });
        if (
          this.allOutputDevices.length > 0 &&
          this.allOutputDevices[0].label !== ''
        ) {
          this.withoutAudioPriviledge = false;
        } else {
          this.allOutputDevices = [
            {
              deviceId: 'default',
              label: 'settings.permissionRequired',
            },
          ];
        }
      });
    },
    logout() {
      doLogout();
      this.$router.push({ name: 'home' });
    },
    // [快捷键] 显示名按 id 取自 shortcuts.js 默认(改默认即生效)，避开已持久化的旧名(settings.shortcuts)。
    shortcutName(id) {
      const d = defaultShortcuts.find(s => s.id === id);
      return (d && d.name) || id;
    },
    clickOutside() {
      this.exitRecordShortcut();
    },
    formatShortcut(shortcut) {
      shortcut = shortcut
        .replaceAll('+', ' + ')
        .replace('Up', '↑')
        .replace('Down', '↓')
        .replace('Right', '→')
        .replace('Left', '←');
      if (this.settings.lang === 'zh-CN') {
        shortcut = shortcut.replace('Space', '空格');
      } else if (this.settings.lang === 'zh-TW') {
        shortcut = shortcut.replace('Space', '空白鍵');
      }
      if (process.platform === 'darwin') {
        return shortcut
          .replace('CommandOrControl', '⌘')
          .replace('Command', '⌘')
          .replace('Alt', '⌥')
          .replace('Control', '⌃')
          .replace('Shift', '⇧');
      }
      return shortcut.replace('CommandOrControl', 'Ctrl');
    },
    readyToRecordShortcut(id, type) {
      if (type === 'globalShortcut' && this.enableGlobalShortcut === false) {
        return;
      }
      this.shortcutInput = { id, type, recording: true };
      this.recordedShortcut = [];
      ipcRenderer.send('switchGlobalShortcutStatusTemporary', 'disable');
    },
    handleShortcutKeydown(e) {
      if (this.shortcutInput.recording === false) return;
      e.preventDefault();
      if (this.recordedShortcut.find(s => s.keyCode === e.keyCode)) return;
      this.recordedShortcut.push(e);
      if (
        (e.keyCode >= 65 && e.keyCode <= 90) || // A-Z
        (e.keyCode >= 48 && e.keyCode <= 57) || // 0-9
        (e.keyCode >= 112 && e.keyCode <= 123) || // F1-F12
        ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key) || // Arrows
        validShortcutCodes.includes(e.key)
      ) {
        this.saveShortcut();
      }
    },
    saveShortcut() {
      const { id, type } = this.shortcutInput;
      const combo = this.recordedShortcutComputed;
      // [#2a 快捷键冲突检测] 同一列(本地 shortcut / 全局 globalShortcut)内与其它键撞键 → 提示并拒绝保存。
      //   原来无任何检测、且恒提示"已保存"(实则两键映同一组合)。
      const list =
        (this.$store.state.settings && this.$store.state.settings.shortcuts) ||
        [];
      // 归一化修饰键:Win 下 CommandOrControl/Command/Cmd/Ctrl 同为 Control → 新录的 "Control+P"
      //   也能命中默认存储的 "CommandOrControl+P"(同一物理键),避免漏判。
      const norm = c =>
        String(c || '').replace(
          /CommandOrControl|Command|Cmd|Ctrl/gi,
          'Control'
        );
      const dup = list.find(s => s.id !== id && norm(s[type]) === norm(combo));
      if (dup) {
        this.showToast(`快捷键与「${dup.name || dup.id}」冲突，未保存`);
        this.recordedShortcut = [];
        return;
      }
      const payload = { id, type, shortcut: combo };
      this.$store.commit('updateShortcut', payload);
      ipcRenderer.send('updateShortcut', payload);
      this.showToast('快捷键已保存');
      this.recordedShortcut = [];
    },
    exitRecordShortcut() {
      if (this.shortcutInput.recording === false) return;
      this.shortcutInput = { id: '', type: '', recording: false };
      this.recordedShortcut = [];
      ipcRenderer.send('switchGlobalShortcutStatusTemporary', 'enable');
    },
    restoreDefaultShortcuts() {
      this.$store.commit('restoreDefaultShortcuts');
      ipcRenderer.send('restoreDefaultShortcuts');
    },
  },
};
</script>

<style lang="scss" scoped>
.settings-page {
  display: flex;
  justify-content: center;
  margin-top: 32px;
}
.container {
  margin-top: 24px;
  width: 720px;
}
h2 {
  margin-top: 48px;
  font-size: 36px;
  color: var(--color-text);
}

h3 {
  margin-top: 48px;
  padding-bottom: 12px;
  font-size: 26px;
  color: var(--color-text);
  border-bottom: 1px solid rgba(128, 128, 128, 0.18);
}

.user {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--color-secondary-bg);
  color: var(--color-text);
  padding: 16px 20px;
  border-radius: 16px;
  margin-bottom: 48px;
  img.avatar {
    border-radius: 50%;
    height: 64px;
    width: 64px;
  }
  img.cvip {
    height: 13px;
    margin-right: 4px;
  }
  .left {
    display: flex;
    align-items: center;
    .info {
      margin-left: 24px;
    }
    .nickname {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .extra-info {
      font-size: 13px;
      .text {
        opacity: 0.68;
      }
      .vip {
        display: flex;
        align-items: center;
      }
    }
  }
  .right {
    .svg-icon {
      height: 18px;
      width: 18px;
      margin-right: 4px;
    }
    button {
      display: flex;
      align-items: center;
      font-size: 18px;
      font-weight: 600;
      text-decoration: none;
      border-radius: 10px;
      padding: 8px 12px;
      opacity: 0.68;
      color: var(--color-text);
      transition: 0.2s;
      margin: {
        right: 12px;
        left: 12px;
      }
      &:hover {
        opacity: 1;
        background: #eaeffd;
        color: #335eea;
      }
      &:active {
        opacity: 1;
        transform: scale(0.92);
        transition: 0.2s;
      }
    }
  }
}

.item {
  margin: 24px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--color-text);

  .title {
    font-size: 16px;
    font-weight: 500;
    opacity: 0.78;
  }

  .description {
    font-size: 14px;
    margin-top: 0.5em;
    opacity: 0.7;
  }
}

// [设置控件统一] 选择框：固定宽度(不再随最长选项撑大成参差长度)，长名(如音频设备)单行省略号折叠、
//   :title 悬停看全名、点开下拉看完整；去掉灰填充背景改干净细描边(用户：不要颜色背景)，聚焦/打开不再变蓝底。
select {
  width: 220px;
  max-width: 220px;
  font-weight: 600;
  border: 1px solid var(--color-secondary);
  padding: 7px 34px 7px 12px;
  border-radius: var(--radius-button);
  color: var(--color-text);
  // [设置控件统一] 补下拉箭头(appearance:none 去掉了原生箭头)→ 看起来像下拉框、与各选择框一致。
  //   #999 中灰在浅/深色下都清晰;右侧留白 34px 容纳箭头。延续"不要色背景"=底仍透明。
  background: transparent
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23999999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")
    no-repeat right 12px center;
  appearance: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: border-color 0.15s;
  &:hover {
    border-color: var(--color-primary);
  }
  &:focus {
    outline: none;
    border-color: var(--color-primary);
  }
}
// [二级菜单] 下拉选项用页面底色，去掉原继承的灰背景(用户：不要颜色背景)。
option {
  background: var(--color-body-bg);
  color: var(--color-text);
}

button {
  color: var(--color-text);
  background: var(--color-secondary-bg);
  padding: 8px 12px 8px 12px;
  font-weight: 600;
  border-radius: var(--radius-button);
  transition: 0.2s;
  &:hover {
    transform: scale(1.06);
  }
  &:active {
    transform: scale(0.94);
  }
}

input.text-input.margin-right-0 {
  margin-right: 0;
}
input.text-input {
  background: var(--color-secondary-bg);
  border: none;
  margin-right: 22px;
  padding: 8px 12px 8px 12px;
  border-radius: 8px;
  color: var(--color-text);
  font-weight: 600;
  font-size: 16px;
}
input::-webkit-outer-spin-button,
input::-webkit-inner-spin-button {
  -webkit-appearance: none;
}
input[type='number'] {
  -moz-appearance: textfield;
}

#proxy-form,
#real-ip {
  display: flex;
  align-items: center;
}
#proxy-form.disabled,
#real-ip.disabled {
  opacity: 0.47;
  button:hover {
    transform: unset;
  }
}

#shortcut-table {
  font-size: 14px;
  /* border: 1px solid black; */
  user-select: none;
  color: var(--color-text);
  .row {
    display: flex;
  }
  .row.row-head {
    opacity: 0.58;
    font-size: 13px;
    font-weight: 500;
  }
  .col {
    min-width: 160px;
    padding: 8px;
    display: flex;
    align-items: center;
    /* border: 1px solid red; */
    &:first-of-type {
      padding-left: 0;
      min-width: 128px;
    }
  }
  .keyboard-input {
    font-weight: 600;
    background-color: var(--color-secondary-bg);
    padding: 8px 12px;
    border-radius: var(--radius-button);
    min-width: 150px;
    min-height: 34px;
    box-sizing: border-box;
    &.active {
      color: var(--color-primary);
      background-color: var(--color-primary-bg);
    }
  }
  .restore-default-shortcut {
    margin-top: 12px;
  }
  &.global-disabled {
    .row .col:last-child {
      opacity: 0.48;
    }
    .row.row-head .col:last-child {
      opacity: 1;
    }
  }
  &:focus {
    outline: none;
  }
}

.footer {
  text-align: center;
  margin-top: 6rem;
  color: var(--color-text);
  font-weight: 600;
  .author {
    // [设置] 署名 DESIGN BY FUJII：衬线 + 略小略细 + 微斜(italic 一点点)
    font-family: Georgia, 'Times New Roman', 'Noto Serif SC', 'Songti SC', serif;
    font-weight: 600;
    font-size: 0.84rem;
    font-style: italic;
    letter-spacing: 0.5px;
    opacity: 0.85;
  }
  .version {
    font-size: 0.88rem;
    opacity: 0.58;
    margin-top: -10px;
  }
}

// [设置] 彩虹猫(进度条样式)项：标题用吉祥物 gif，像素图保持清晰
.nyancat-title {
  display: flex;
  align-items: center;
  gap: 8px;
  img {
    height: 24px;
    width: auto;
    border-radius: 4px;
    image-rendering: pixelated;
  }
}

.beforeAnimation {
  -webkit-transition: 0.2s cubic-bezier(0.24, 0, 0.5, 1);
  transition: 0.2s cubic-bezier(0.24, 0, 0.5, 1);
}
.afterAnimation {
  box-shadow: 0 0 0 1px hsla(0, 0%, 0%, 0.1), 0 4px 0px 0 hsla(0, 0%, 0%, 0.04),
    0 4px 9px hsla(0, 0%, 0%, 0.13), 0 3px 3px hsla(0, 0%, 0%, 0.05);
  -webkit-transition: 0.35s cubic-bezier(0.54, 1.6, 0.5, 1);
  transition: 0.35s cubic-bezier(0.54, 1.6, 0.5, 1);
}
.toggle {
  margin: auto;
}
.toggle input {
  opacity: 0;
  position: absolute;
}
// [iOS化] track 44×26 整 pill、knob 22 圆形(原 52×32 圆角矩形+方钮，偏大偏方)。
.toggle input + label {
  position: relative;
  display: inline-block;
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
  -webkit-transition: 0.4s ease;
  transition: 0.4s ease;
  height: 26px;
  width: 44px;
  background: var(--color-secondary-bg);
  border-radius: 999px;
}
.toggle input + label:before {
  content: '';
  position: absolute;
  display: block;
  -webkit-transition: 0.2s cubic-bezier(0.24, 0, 0.5, 1);
  transition: 0.2s cubic-bezier(0.24, 0, 0.5, 1);
  height: 26px;
  width: 44px;
  top: 0;
  left: 0;
  border-radius: 999px;
}
.toggle input + label:after {
  content: '';
  position: absolute;
  display: block;
  box-shadow: 0 0 0 1px hsla(0, 0%, 0%, 0.02), 0 4px 0px 0 hsla(0, 0%, 0%, 0.01),
    0 4px 9px hsla(0, 0%, 0%, 0.08), 0 3px 3px hsla(0, 0%, 0%, 0.03);
  -webkit-transition: 0.35s cubic-bezier(0.54, 1.6, 0.5, 1);
  transition: 0.35s cubic-bezier(0.54, 1.6, 0.5, 1);
  background: #fff;
  height: 22px;
  width: 22px;
  top: 2px;
  left: 2px;
  border-radius: 50%;
}
.toggle input:checked + label:before {
  background: var(--color-primary);
  -webkit-transition: width 0.2s cubic-bezier(0, 0, 0, 0.1);
  transition: width 0.2s cubic-bezier(0, 0, 0, 0.1);
}
.toggle input:checked + label:after {
  left: 20px;
}

/* [NAS] 配置中心样式 */
.nas-cfg-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}
.nas-cfg-dot.on {
  background: #1db954;
  animation: nas-cfg-breathe 3.6s ease-in-out infinite;
}
.nas-cfg-dot.off {
  background: #c0392b;
}
@keyframes nas-cfg-breathe {
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
.nas-history-left {
  width: 100%;
}
.nas-profile-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  font-size: 14px;
  border-top: 1px solid var(--color-secondary-bg);
  .np-name {
    font-weight: 600;
  }
  .np-base,
  .np-ago {
    opacity: 0.55;
    font-size: 12px;
  }
  .np-ago {
    margin-left: auto;
  }
  .np-current {
    color: #3fa06a;
    font-size: 12px;
    font-weight: 600;
  }
  .np-btn {
    padding: 3px 10px;
    font-size: 12px;
    border-radius: 6px;
    background: var(--color-secondary-bg);
    cursor: pointer;
    border: none;
    color: var(--color-text);
    &.danger {
      color: #c0392b;
    }
  }
}
.nas-dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.nas-dialog {
  width: 420px;
  max-width: 90vw;
  background: var(--color-body-bg);
  color: var(--color-text);
  border-radius: 14px;
  padding: 22px 24px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
  .nd-title {
    font-size: 17px;
    font-weight: 700;
    margin-bottom: 16px;
  }
  .nd-field {
    display: block;
    font-size: 13px;
    opacity: 0.8;
    margin-bottom: 12px;
    input,
    select {
      display: block;
      width: 100%;
      margin-top: 5px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--color-secondary-bg);
      background: var(--color-secondary-bg);
      color: var(--color-text);
      font-size: 14px;
      box-sizing: border-box;
    }
  }
  .nd-test {
    padding: 7px 14px;
    border-radius: var(--radius-button);
    border: none;
    background: var(--color-secondary-bg);
    color: var(--color-text);
    cursor: pointer;
    font-size: 13px;
  }
  .nd-msg {
    margin: 10px 0;
    font-size: 13px;
    color: #c0392b;
    &.ok {
      color: #3fa06a;
    }
  }
  .nd-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 16px;
    button {
      padding: 8px 18px;
      border-radius: var(--radius-button);
      border: none;
      cursor: pointer;
      background: var(--color-secondary-bg);
      color: var(--color-text);
      font-size: 14px;
      &.primary {
        background: var(--color-primary);
        color: #fff;
      }
      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }
  }
}
</style>
