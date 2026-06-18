<template>
  <div v-show="podcast" class="podcast-detail-page">
    <div v-if="podcast" class="podcast-detail">
      <!-- [B-34] 右键封面弹菜单浮层：批量下载（左）/ 取消订阅（右）。点外部关闭。 -->
      <!-- [B-63] 封面 hover 微动+光晕（复用首页 cover-box/cover-shadow 设计） -->
      <div class="cover-box">
        <div
          class="cover-shadow"
          :style="{ backgroundImage: `url(${podcast.coverUrl})` }"
        ></div>
        <div
          class="cover-wrap"
          :class="{ 'menu-active': coverMenuMode }"
          @contextmenu.prevent="toggleCoverMenu"
        >
          <PodImage
            class="cover-lg"
            :src="podcast.coverUrl"
            @error="onCoverError"
          />
          <div v-if="coverMenuMode" class="cover-menu-overlay" @click.stop>
            <button
              v-tip="'批量下载'"
              class="cover-menu-btn"
              @click="enterMultiDownload"
            >
              <svg-icon icon-class="download" />
            </button>
            <!-- [B-50] 只有真订阅的节目才显示"取消订阅"（预览节目不是订阅，不显示） -->
            <button
              v-if="podcast.subscribed !== false"
              v-tip="'取消订阅'"
              class="cover-menu-btn danger"
              @click="confirmUnsubscribe"
            >
              <svg-icon icon-class="heart-crack" />
            </button>
          </div>
        </div>
      </div>
      <div class="meta">
        <div class="t">{{ podcast.title }}</div>
        <div class="a">{{ podcast.author }}</div>
        <!-- [B-50] 预览(未订阅)节目：点卡片进来=试听浏览，未自动订阅 → 显示订阅按钮 -->
        <!-- [B67-BUG-2] 骨架载入态(_loading)先不显示订阅按钮(此时 feedUrl 还是哨兵) -->
        <button
          v-if="
            podcast.subscribed === false &&
            !podcast._loading &&
            !podcast._loadError
          "
          class="sub-this-btn"
          :class="{ ready: subBtnReady }"
          :style="subBtnColor ? { background: subBtnColor } : {}"
          @click="subscribeThis"
        >
          <svg-icon icon-class="square-plus" />订阅到我的
        </button>
        <div class="d">{{ cleanDescription }}</div>
      </div>
    </div>

    <div class="episode-list" :class="{ 'select-mode': selectMode }">
      <!-- [B-70] 预览失败原地错误态：不跳走，给原因 + 返回，不甩用户到我的订阅 -->
      <div v-if="podcast && podcast._loadError" class="ep-loading ep-error">
        <div>该节目暂时无法打开，链接可能已失效。</div>
        <button class="ep-error-back" @click="$router.replace('/')">
          返回首页
        </button>
      </div>
      <!-- [B67-BUG-2] 缓存优先骨架态：后台预览抓取中，单集区给个轻提示，不留空白 -->
      <div v-else-if="podcast && podcast._loading" class="ep-loading">
        正在载入单集…
      </div>
      <div
        v-for="ep in visibleEpisodes"
        :key="ep.id"
        class="episode-row"
        :class="{
          selected: isSelected(ep),
          'is-downloaded': selectMode && isDownloaded(ep),
        }"
        @click="onRowClick(ep)"
        @dblclick="onRowDblClick(ep)"
        @contextmenu.prevent="openEpisodeMenu($event, ep)"
      >
        <!-- [B-34] 多选框：已下载的显示绿勾禁用；未下载可勾选 -->
        <div
          v-if="selectMode"
          class="ep-checkbox"
          :class="{ checked: isSelected(ep), disabled: isDownloaded(ep) }"
        >
          <svg-icon
            v-if="isSelected(ep) || isDownloaded(ep)"
            icon-class="check"
          />
        </div>
        <!-- [B-31] 下载中：整行背景灰色进度条（弱视觉，不影响文字可读性） -->
        <div
          v-if="downloadPercent(ep) >= 0"
          class="ep-dl-bar"
          :style="{ width: Math.max(2, downloadPercent(ep)) + '%' }"
        ></div>
        <div class="ep-main">
          <div class="ep-title">
            {{ ep.title
            }}<span
              v-if="nasEpOn(ep)"
              v-tip="'NAS 上有此单集（音源就近）'"
              class="nas-dot"
              :style="nasGlow(ep.guid)"
              ><svg-icon icon-class="wifi"
            /></span>
          </div>
          <div class="ep-sub">
            <span>{{ formatDate(ep.pubDate) }}</span>
            <!-- [C-4 改] 时长 / 剩余 / 听过X%(黄) / 已听完(绿) -->
            <span
              v-if="ep.duration"
              class="ep-prog"
              :class="progressLabelClass(ep)"
            >
              · {{ formatProgressLabel(ep) }}
            </span>
          </div>
        </div>
        <!-- [B-33] 状态按钮排序原则：从右到左变动频率递减。
             更多(最右,常驻) ← 播放(常驻) ← 收藏 ← 已下载。DOM 左到右即：已下载 收藏 播放 更多 -->
        <!-- [B-34] 多选模式下隐藏右侧操作按钮，只留多选框 + 内容 -->
        <!-- [B-59] 排队中：显式状态图标，只提示不操作（取消请用更多菜单里的"取消下载"） -->
        <div
          v-if="!selectMode && isQueued(ep)"
          v-tip="'排队中'"
          class="ep-queued"
        >
          <svg-icon icon-class="queue-alt" />
        </div>
        <!-- 已下载（点击 → 中央确认删除弹窗） -->
        <button
          v-if="!selectMode && isDownloaded(ep)"
          v-tip="'已下载（点击删除）'"
          class="ep-downloaded-btn"
          @click.stop="askDeleteDownload(ep)"
          @dblclick.stop
        >
          <svg-icon icon-class="check-circle" />
        </button>
        <!-- 已收藏（点击 → 取消收藏） -->
        <button
          v-if="!selectMode && isFavorited(ep)"
          v-tip="'已收藏（点击取消）'"
          class="ep-fav-btn"
          @click.stop="toggleFav(ep)"
          @dblclick.stop
        >
          <svg-icon icon-class="heart-solid" />
        </button>
        <!-- 播放 + 更多 -->
        <button
          v-if="!selectMode"
          class="ep-play-btn"
          @click.stop="playEpisode(ep)"
          @dblclick.stop
        >
          <svg-icon icon-class="play-circle" />
        </button>
        <button
          v-if="!selectMode"
          class="ep-menu-btn"
          @click.stop="openEpisodeMenu($event, ep)"
          @dblclick.stop
        >
          <svg-icon icon-class="menu-dots-vertical" />
        </button>
      </div>
      <!-- [B-75/F1] 后台水合中(还没补满) → 底部轻提示，补满即消失 -->
      <div v-if="episodes.length > visibleEpisodes.length" class="ep-more-hint">
        载入中 · {{ visibleEpisodes.length }} / {{ episodes.length }}
      </div>
      <!-- [B-76] 原"滑到底彩虹猫"彩蛋#1 已移除：改后台水合后不再有加载空白，
           该彩蛋失去语境、属冗余 → 删之（吉祥物以后另觅合适场景）。 -->
    </div>

    <!-- [B-34] 多选模式固定下载栏（滚动时固定在播放栏上方） -->
    <transition name="mdl-slide">
      <div v-if="selectMode" class="multi-dl-bar">
        <button class="mdl-cancel" @click="cancelMultiSelect">取消</button>
        <div class="mdl-info">
          已选 <b>{{ selectedEpIds.length }}</b> 项
        </div>
        <button
          class="mdl-go"
          :disabled="!selectedEpIds.length"
          @click="downloadSelected"
        >
          <svg-icon icon-class="download" />
          <span>下载</span>
        </button>
      </div>
    </transition>

    <!-- [S-3] 单集操作菜单（贴触发点） -->
    <div
      v-if="episodeMenu.open"
      ref="episodeMenu"
      class="ep-ctx-menu"
      :style="{ left: episodeMenu.x + 'px', top: episodeMenu.y + 'px' }"
      @click.stop
    >
      <div class="ctx-item" @click="onMenuPlay">
        <svg-icon icon-class="play-circle" />
        <span>立即播放</span>
      </div>
      <div class="ctx-item" @click="onMenuQueue">
        <svg-icon icon-class="layer-plus" />
        <span>加入播放列表</span>
      </div>
      <div class="ctx-item" @click="onMenuFavorite">
        <svg-icon
          :icon-class="
            isFavorited(episodeMenu.target) ? 'heart-solid' : 'heart'
          "
        />
        <span>{{ isFavorited(episodeMenu.target) ? '取消收藏' : '收藏' }}</span>
      </div>
      <div
        class="ctx-item"
        :class="{ danger: isDownloaded(episodeMenu.target) }"
        @click="onMenuDownload"
      >
        <svg-icon :icon-class="downloadMenuIcon(episodeMenu.target)" />
        <span>{{ downloadMenuLabel(episodeMenu.target) }}</span>
      </div>
    </div>

    <!-- [B-31] 删除下载确认弹窗 -->
    <div
      v-if="dlDeleteTarget"
      class="dialog-mask"
      @click.self="dlDeleteTarget = null"
    >
      <div class="confirm-dialog">
        <div class="title">删除下载</div>
        <div class="msg">
          确定要删除已下载的
          <b>"{{ dlDeleteTarget.title }}"</b>
          吗？<br />本地音频文件会被删除，单集听过的进度不会被删除。
        </div>
        <div class="actions">
          <button class="btn-secondary" @click="dlDeleteTarget = null">
            取消
          </button>
          <button class="btn-danger" @click="confirmDeleteDownload">
            确定删除
          </button>
        </div>
      </div>
    </div>

    <!-- [播客改造] 取消订阅确认弹窗（替换原系统 confirm 弹窗，与软件风格一致） -->
    <div
      v-if="showConfirmUnsub"
      class="dialog-mask"
      @click.self="showConfirmUnsub = false"
    >
      <div class="confirm-dialog">
        <div class="title">取消订阅</div>
        <div class="msg">
          确定要取消订阅 <b>"{{ podcast && podcast.title }}"</b> 吗？<br />
          单集历史进度不会被删除。
        </div>
        <div class="actions">
          <button class="btn-secondary" @click="showConfirmUnsub = false">
            取消
          </button>
          <button class="btn-danger" @click="doUnsubscribe">
            确定取消订阅
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import {
  getPodcast,
  getEpisodesByPodcast,
  deletePodcast,
  updatePodcast,
} from '@/utils/podcast/service';
// [B67-BUG-2] 缓存优先：未订阅节目的后台预览抓取在详情页内做
import { previewPodcast } from '@/utils/podcast/discover';
import { getEpisodeProgressBulk } from '@/utils/podcast/db';
import {
  getListenStats,
  getListenStatsBulk,
  listenedPercentStepped,
} from '@/utils/podcast/listening';
import {
  startDownload,
  cancelDownload,
  removeDownload,
} from '@/utils/podcast/downloads';
import { stripHtmlToText } from '@/utils/podcast/sanitizeHtml';
import { getCoverColor } from '@/utils/podcast/coverColor';
import { getEpisodeCache, setEpisodeCache } from '@/utils/podcast/episodeCache';
import { prefetchShownotesForEpisodes } from '@/utils/podcast/shownotesEnrich';
import {
  prefetchNasPodcast,
  nasEpisodeGuidSet,
  normFeedUrl,
} from '@/utils/podcast/nasSource';
import SvgIcon from '@/components/SvgIcon.vue';

export default {
  name: 'PodcastDetail',
  components: { SvgIcon },
  data() {
    return {
      podcast: null,
      episodes: [],
      showConfirmUnsub: false,
      // [S-3] 单集菜单
      episodeMenu: { open: false, x: 0, y: 0, target: null },
      episodeMenuOutsideListener: null,
      // [B-31] 下载删除确认弹窗的目标
      dlDeleteTarget: null,
      // [B-34] 右键封面菜单（批量下载 / 取消订阅）+ 点外部关闭监听
      coverMenuMode: false,
      coverMenuListener: null,
      // [B-34] 多选下载模式
      selectMode: false,
      selectedEpIds: [],
      // [B-75/F1] 单集渐进渲染上限：首屏 50 条即时上屏(秒开)，随后 _startHydration 在后台
      //   逐帧补满到全量。episodes 始终全量(批量下载/选择/播放广播都用它)，只限制**渲染**节奏。
      epDisplayLimit: 50,
      // [NAS] 本档在 NAS 上已归档的单集 guid 集合(连上才非空；空=不显示 wifi 标识)
      nasEpGuids: new Set(),
      // 订阅按钮底色：取色完成前隐藏(opacity:0)，取色后淡入，避免蓝色闪烁
      subBtnColor: null,
      subBtnReady: false,
    };
  },
  computed: {
    feedUrl() {
      return decodeURIComponent(this.$route.params.feedUrlEncoded || '');
    },
    // [B-75/F1] 实际渲染的单集子集（前 epDisplayLimit 条）。全量在 this.episodes。
    visibleEpisodes() {
      if (this.epDisplayLimit >= this.episodes.length) return this.episodes;
      return this.episodes.slice(0, this.epDisplayLimit);
    },
    // [B-33] 节目简介去 HTML 标签 → 纯文本（避免 RSS 描述里的 <p style> 源码当文字显示）
    cleanDescription() {
      return stripHtmlToText((this.podcast && this.podcast.description) || '');
    },
  },
  watch: {
    // 路由切换到另一档节目时重新加载
    feedUrl: {
      immediate: true,
      handler(v) {
        // [B67-BUG-2] '__preview__' 哨兵 = 未订阅节目秒跳进来 → 先渲染骨架、后台预览，
        //   预览完成后 replace 到真实 feedUrl，watcher 再以真实值走正常 load()。
        if (v === '__preview__') this.startPreview();
        else if (v) this.load();
      },
    },
    // 封面主色 → 订阅按钮底色（coverUrl 有值时提取，路由切换时重算）
    podcast(newVal) {
      const url = newVal && newVal.coverUrl;
      if (!url || url === this._subBtnColorSrc) return;
      this._subBtnColorSrc = url;
      getCoverColor(url)
        .then(hsl => {
          if (hsl && this._subBtnColorSrc === url) {
            this.subBtnColor = `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)`;
            this.subBtnReady = true;
          }
        })
        .catch(() => {});
    },
    // [B-31] 监听播放器广播：若广播的 episodeId 在自己列表里 → 重读那一集 listenStats
    '$store.state.podcastListening.listenTick'() {
      const pl = this.$store.state.podcastListening;
      if (!pl || !pl.episodeId) return;
      const idx = this.episodes.findIndex(e => e.id === pl.episodeId);
      if (idx < 0) return;
      getListenStats(pl.episodeId)
        .then(s => {
          // Vue 2：用 splice 触发响应式
          const ep = this.episodes[idx];
          this.$set(this.episodes, idx, { ...ep, listenStats: s });
        })
        .catch(() => {});
    },
  },
  beforeDestroy() {
    // [B-34] 离开页面时清理浮层/菜单的 document 监听，避免泄漏
    this.closeCoverMenu();
    this.closeEpisodeMenu();
    this._stopHydration(); // [B-75] 取消后台水合，避免在已销毁实例上回调
    if (this._rowClickTimer) clearTimeout(this._rowClickTimer); // [TODO4] 清挂起的单击定时器
  },
  methods: {
    // [B-75/F1] 后台渐进水合：首屏 50 上屏后，用 rAF 逐帧把 epDisplayLimit 补满到全量。
    //   为何这样：B-73.2 靠滚动触发 + B-74 底部占位(spacer)，会让自绘滚动条拖到一片"未渲染的
    //   空白占位"里、且托条按变化的 scrollHeight 算位移而跳动/脱手(用户反馈"还不如上一版")。
    //   改后台水合后：列表很快是**完整真实高度** → 滚动条/拖动稳、永不留空白；首屏仍是即时 50 条。
    // [机核封面 hover 慢半拍根治 2026-06-14 · 对抗式评审收敛]
    //   原 +120/帧：机核(1000+集)每帧 patch 120 行子树(每行约 10 个模板方法) → 单帧远超 16ms，
    //   rAF 连帧背靠背把主线程钉死约 1~2s；这期间头部封面 :hover 的 pointer 事件被排在渲染之后
    //   → 反馈慢半拍(水合完就好、退出再进又复现)。注：单集行不含 PodImage 封面，慢源在「行数×方法」
    //   的 patch 量，非图片。上轮改辉光动画治错了层(饿死的是「输入派发」，改 hover 动什么都没用)。
    //   根治=每帧块 120 → **24**：单帧 patch(~24 行)稳稳 <8ms，留足时间派发输入 + 提交封面合成
    //   → hover 不再排队；1000+ 集约 42 帧(~0.7~1s)填满，仍快到滚动条很快达完整真实高度(B-75)、
    //   且更小步增长更稳。残留可降到 16，过慢可升到 ≤36(勿超 48)。requestIdleCallback+监听器方案
    //   在持续输入下不可靠且反增主线程负担(已否决)；虚拟列表会重新引入 B-74 占位/硬编码行高(已否决)。
    _startHydration() {
      this._stopHydration();
      const CHUNK = 24; // 原 120；小块 = 单帧渲染 <8ms、不饿死输入(封面 hover 即时)
      const step = () => {
        if (this._isDestroyed) return;
        if (this.epDisplayLimit >= this.episodes.length) {
          this._hydrateRaf = null;
          return;
        }
        this.epDisplayLimit = Math.min(
          this.episodes.length,
          this.epDisplayLimit + CHUNK
        );
        this._hydrateRaf = requestAnimationFrame(step);
      };
      this._hydrateRaf = requestAnimationFrame(step);
    },
    _stopHydration() {
      if (this._hydrateRaf) {
        cancelAnimationFrame(this._hydrateRaf);
        this._hydrateRaf = null;
      }
    },
    // [B67-BUG-2] 未订阅节目秒跳进来：先用卡片"种子"渲染骨架(头图/标题/作者立即可见)，
    //   后台跑预览(resolveFeed+抓RSS+入库)，完成后 replace 到真实 feedUrl →
    //   feedUrl watcher 再以真实值走正常 load() 填充单集。失败则 toast + 返回，绝不留空白。
    async startPreview() {
      const seed = this.$route.params.previewSeed;
      if (!seed || !seed.raw) {
        // 无种子(刷新/直接访问哨兵路由，params 是内存态会丢) → 回首页，避免停在空白
        this.$router.replace('/');
        return;
      }
      this.podcast = {
        title: seed.title || '',
        author: seed.author || '',
        coverUrl: seed.coverUrl || '',
        description: '',
        subscribed: false,
        _loading: true, // 骨架态：隐藏订阅按钮、单集区显示"载入中"
      };
      this.episodes = [];
      this.epDisplayLimit = 50; // [B-73.2/F1] 预览态也复位渲染量
      // [B69-P1] 在途令牌 + 守卫：previewPodcast 抓 RSS 可达数秒，期间用户可能已离开骨架页/
      //   返回首页/又点了别的卡片。$router 是全局对象、组件销毁后调用仍生效 → 不加守卫会
      //   "数秒后把用户强行拉回本节目"或 A/B 串台。await 后校验：组件已销毁 / 又发起了新预览 /
      //   已不在哨兵路由 → 直接放弃，不抢导航。
      const token = (this._previewToken = (this._previewToken || 0) + 1);
      const stale = () =>
        this._isDestroyed ||
        token !== this._previewToken ||
        this.$route.params.feedUrlEncoded !== '__preview__';
      try {
        const { feedUrl } = await previewPodcast(seed.raw);
        if (stale()) return;
        // [B-70] 这次成功了 → 清掉该节目的"链接无法解析"红点标记(自愈)
        this.$store.commit('removeBrokenPodcast', seed.title);
        this.$router.replace({
          name: 'podcastDetail',
          params: { feedUrlEncoded: encodeURIComponent(feedUrl) },
        });
      } catch (e) {
        if (stale()) return;
        // [B-70] 预览失败(该节目无 Apple 源 / feed 失效 / 抓取失败，如《她山石》)：
        //   过去 replace('/library') 把用户直接甩到我的订阅(恶性体验)。改为**原地错误态**——
        //   保留骨架头图/标题，单集区显示失败原因 + 返回按钮，绝不擅自跳走。
        //   诊断日志：打印失败原因 + 节目种子(可看出是无 Apple 链接还是 feed/抓取问题)。
        // eslint-disable-next-line no-console
        console.warn('[B-70] 预览失败', {
          name: seed.title,
          raw: seed.raw,
          error: (e && e.message) || e,
        });
        this.$set(this.podcast, '_loading', false);
        this.$set(this.podcast, '_loadError', true);
        // [B-70] 记下该节目"链接无法解析" → 发现页卡片标红点，下次一眼避开
        this.$store.commit('addBrokenPodcast', seed.title);
        this.$store.dispatch(
          'showToast',
          '该节目暂时无法打开：' + ((e && e.message) || e)
        );
      }
    },
    async load() {
      const feedUrl = this.feedUrl;
      // [B-77/L1] 命中内存缓存 → 先用上次数据**秒显**，再后台从 Dexie 校正(stale-while-revalidate)
      const cached = getEpisodeCache(feedUrl);
      if (cached) {
        this.podcast = cached.podcast;
        this.episodes = cached.episodes;
        this._presentEpisodes();
      }
      // 权威重读
      const podcast = await getPodcast(feedUrl);
      if (feedUrl !== this.feedUrl) return; // 期间已切到别的节目 → 放弃这次 stale 结果
      if (!podcast) {
        // [B-70] 节目不存在(被删/URL 错/预览入库竞态)：回首页(不再甩到我的订阅)
        if (!cached) this.$router.replace('/');
        return;
      }
      // [B-46 / D-3] 进详情即视为"已看过新单集"，清掉我的订阅页该卡片的新单集角标
      if (podcast.newCount) {
        updatePodcast(feedUrl, { newCount: 0 }).catch(() => {});
      }
      const eps = await getEpisodesByPodcast(feedUrl);
      if (feedUrl !== this.feedUrl) return;
      // [B-36] 批量 bulkGet 读进度 + listenStats（原来每集各一次 get，百集列表很卡）
      const ids = eps.map(e => e.id);
      const [progresses, stats] = await Promise.all([
        getEpisodeProgressBulk(ids).catch(() => []),
        getListenStatsBulk(ids).catch(() => []),
      ]);
      if (feedUrl !== this.feedUrl) return;
      const mapped = eps.map((ep, i) => ({
        ...ep,
        listenedSec: (progresses[i] && progresses[i].position) || 0,
        listenStats: stats[i] || null,
      }));
      this.podcast = podcast;
      this.episodes = mapped;
      setEpisodeCache(feedUrl, { podcast, episodes: mapped }); // [B-77/L1] 写缓存供下次秒显
      // [B-83/预取] 后台限流补全本档"被小宇宙截断"的单集完整文稿(每集一次、已补全的跳过)，
      //   使你点进单集时完整内容已在本地、秒显无闪。失败静默，不影响列表。
      prefetchShownotesForEpisodes(mapped).catch(() => {});
      // [NAS] 进详情页预热整档 NAS 映射(暖主进程 episodes 缓存)→ 点哪集都秒解析。未启用则 no-op。
      prefetchNasPodcast(feedUrl);
      // [NAS] 拉本档 NAS 已归档单集 guid 集合 → 标"NAS 上有此单集"(未连上则空、无标识)
      nasEpisodeGuidSet(feedUrl)
        .then(s => {
          if (feedUrl === this.feedUrl) this.nasEpGuids = s;
        })
        .catch(() => {});
      if (cached) this._startHydration();
      // 命中过：仅更新数据 + 续水合，不再复位滚动位
      else this._presentEpisodes(); // 未命中：首次复位渲染量/滚顶/水合
    },
    // [B-75/F1] 新节目视图：渲染量回首屏 50、滚动条回顶部(不沿用上个节目深滚动位)，随后后台逐帧水合
    _presentEpisodes() {
      this.epDisplayLimit = 50;
      const main = this.$el && this.$el.closest('main');
      if (main) main.scrollTop = 0;
      this.$nextTick(() => this._startHydration());
    },
    playEpisode(ep) {
      const title = this.podcast ? this.podcast.title : '';
      this.$store.state.player.playPodcastEpisode(ep, title);
    },
    // [S-3] 单集菜单
    openEpisodeMenu(e, ep) {
      // [B-33] toggle：先清理旧菜单/监听；若是同一行再次触发则仅关闭（不重开）。
      const isSame =
        this.episodeMenu.open &&
        this.episodeMenu.target &&
        this.episodeMenu.target.id === ep.id;
      this.closeEpisodeMenu();
      if (isSame) return;
      const w = 200;
      const h = 200;
      const x = Math.min(e.clientX, window.innerWidth - w - 10);
      const y = Math.min(e.clientY, window.innerHeight - h - 10);
      this.episodeMenu = { open: true, x, y, target: ep };
      this.$nextTick(() => {
        // 用 click（左键）关闭：菜单容器和触发按钮都 @click.stop，
        // 所以只有点击菜单外空白才冒泡到这里 → 关闭。右键不产生 click，不会自关。
        this.episodeMenuOutsideListener = ev => {
          const root = this.$refs.episodeMenu;
          if (root && !root.contains(ev.target)) this.closeEpisodeMenu();
        };
        document.addEventListener('click', this.episodeMenuOutsideListener);
      });
    },
    closeEpisodeMenu() {
      this.episodeMenu.open = false;
      this.episodeMenu.target = null;
      if (this.episodeMenuOutsideListener) {
        document.removeEventListener('click', this.episodeMenuOutsideListener);
        this.episodeMenuOutsideListener = null;
      }
    },
    onMenuPlay() {
      const ep = this.episodeMenu.target;
      this.closeEpisodeMenu();
      if (ep) this.playEpisode(ep);
    },
    onMenuQueue() {
      const ep = this.episodeMenu.target;
      this.closeEpisodeMenu();
      if (!ep) return;
      this.$store.dispatch('enqueueEpisode', {
        ...ep,
        podcastTitle: this.podcast ? this.podcast.title : '',
      });
    },
    onMenuFavorite() {
      const ep = this.episodeMenu.target;
      this.closeEpisodeMenu();
      if (!ep) return;
      // 拼一个 track-like 对象给收藏 action
      const title = (this.podcast && this.podcast.title) || '';
      const track = {
        id: `pod:${ep.id}`,
        name: ep.title,
        al: {
          id: 0,
          name: title,
          picUrl: ep.coverUrl || '',
        },
        dt: (ep.duration || 0) * 1000,
        podcastAudioUrl: ep.audioUrl,
        // [审操作#3] 必须带 podcastId(=feedUrl)；否则收藏写入 podcastId='' → 启动时
        //   prunePreviewOrphans 的 favorites.where('podcastId') 保护命中 0 → 该(未订阅)节目连同单集被静默清理。
        podcastId: ep.podcastId || (ep.id || '').split('::')[0],
        podcastEpisodeId: ep.id,
      };
      this.$store.dispatch('togglePodcastFavorite', track);
    },
    onMenuDownload() {
      const ep = this.episodeMenu.target;
      this.closeEpisodeMenu();
      if (!ep) return;
      if (this.isDownloaded(ep)) {
        this.askDeleteDownload(ep);
        return;
      }
      // [B-59] 下载中 或 排队中 → 二次点取消（取消排队也统一按"取消下载"管理）
      if (this.downloadPercent(ep) >= 0 || this.isQueued(ep)) {
        cancelDownload(ep.id);
        return;
      }
      startDownload(ep);
    },
    // [B-31] 下载状态判定 + 进度（-1 = 没在下载）
    isDownloaded(ep) {
      if (!ep) return false;
      const ids =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.doneIds) ||
        [];
      return ids.includes(ep.id);
    },
    // [NAS] 该单集在 NAS 上是否已归档(决定是否显示 wifi 标识)。
    //   [修10集标识] guid 或归一化 audioUrl 任一命中即算在档：ABS 老集无 guid，单 guid 匹配会
    //   漏掉绝大多数已归档老集(实测督工 285 集仅 21 集有 guid)→ 只亮一小撮。nasEpGuids 现含
    //   url 键(见 nasEpisodeGuidSet)，与播放解析的 guid→url 双路兜底同口径。
    nasEpOn(ep) {
      if (!ep) return false;
      if (ep.guid && this.nasEpGuids.has(ep.guid)) return true;
      if (ep.audioUrl && this.nasEpGuids.has(normFeedUrl(ep.audioUrl)))
        return true;
      return false;
    },
    // [呼吸灯 v2.0] 由稳定 id 派生「周期 + 负相位」→ 同点恒定、彼此不同，萤火虫式错落呼吸(不齐步)。
    //   必须 id 派生(非 Math.random)：单集列表重渲(分页/水合)不摇号、不闪。
    nasGlow(id) {
      let h = 0;
      const s = String(id || '');
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      const dur = [3.2, 3.8, 4.4, 5.0][h % 4]; // 4 档非谐波周期，缓慢飘移、几乎不全体重合
      const delay = -(((h >> 3) % Math.round(dur * 100)) / 100); // 负相位铺满各自周期
      return {
        animationDuration: dur + 's',
        animationDelay: delay.toFixed(2) + 's',
      };
    },
    downloadPercent(ep) {
      if (!ep) return -1;
      const map =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.progressMap) ||
        {};
      const p = map[ep.id];
      if (!p || p.status !== 'downloading') return -1;
      if (!p.bytesTotal) return 1; // 仍未拿到 content-length，先显示 1%
      return Math.min(99, (p.bytesDone / p.bytesTotal) * 100);
    },
    // [B-59] 是否排队中（下载并发达上限时入队，status:'queued'）；只做提示，取消走取消下载
    isQueued(ep) {
      if (!ep) return false;
      const map =
        (this.$store.state.podcastDownloads &&
          this.$store.state.podcastDownloads.progressMap) ||
        {};
      const p = map[ep.id];
      return !!(p && p.status === 'queued');
    },
    askDeleteDownload(ep) {
      this.dlDeleteTarget = ep;
    },
    async confirmDeleteDownload() {
      const ep = this.dlDeleteTarget;
      this.dlDeleteTarget = null;
      if (!ep) return;
      await removeDownload(ep.id);
      this.$store.dispatch('showToast', '已删除下载');
    },
    // [S-3] 当前 episode 是否已收藏
    isFavorited(ep) {
      if (!ep) return false;
      const ids =
        (this.$store.state.podcastFavorites &&
          this.$store.state.podcastFavorites.episodeIds) ||
        [];
      return ids.includes(ep.id);
    },
    // [B-33] 单集行收藏按钮：toggle 收藏（点击已收藏的红心 = 取消收藏）
    toggleFav(ep) {
      if (!ep) return;
      const title = (this.podcast && this.podcast.title) || '';
      const track = {
        id: `pod:${ep.id}`,
        name: ep.title,
        al: { id: 0, name: title, picUrl: ep.coverUrl || '' },
        dt: (ep.duration || 0) * 1000,
        podcastAudioUrl: ep.audioUrl,
        // [审操作#3] 必须带 podcastId(=feedUrl)；否则收藏写入 podcastId='' → 启动时
        //   prunePreviewOrphans 的 favorites.where('podcastId') 保护命中 0 → 该(未订阅)节目连同单集被静默清理。
        podcastId: ep.podcastId || (ep.id || '').split('::')[0],
        podcastEpisodeId: ep.id,
      };
      this.$store.dispatch('togglePodcastFavorite', track);
    },
    // [B-33] 右键菜单"下载"项的动态图标/文案（已下载→删除下载，下载中→取消下载）
    downloadMenuIcon(ep) {
      if (this.isDownloaded(ep)) return 'trash';
      // [B-59] 下载中 或 排队中 → 取消语义，用 x 图标，避免「显示 download 却执行取消」
      if (this.downloadPercent(ep) >= 0 || this.isQueued(ep)) return 'x';
      return 'download';
    },
    downloadMenuLabel(ep) {
      if (this.isDownloaded(ep)) return '删除下载';
      // [B-59] 下载中 或 排队中 → 统一「取消下载」（取消排队也走这里）
      if (this.downloadPercent(ep) >= 0 || this.isQueued(ep)) return '取消下载';
      return '下载';
    },
    // [B-34] 右键封面菜单 toggle（批量下载 / 取消订阅）+ 点外部关闭
    toggleCoverMenu() {
      if (this.coverMenuMode) {
        this.closeCoverMenu();
        return;
      }
      this.coverMenuMode = true;
      this.$nextTick(() => {
        this.coverMenuListener = ev => {
          if (!ev.target.closest('.cover-wrap')) this.closeCoverMenu();
        };
        document.addEventListener('click', this.coverMenuListener);
      });
    },
    closeCoverMenu() {
      this.coverMenuMode = false;
      if (this.coverMenuListener) {
        document.removeEventListener('click', this.coverMenuListener);
        this.coverMenuListener = null;
      }
    },
    // [B-34] 进入多选下载模式
    enterMultiDownload() {
      this.closeCoverMenu();
      this.selectMode = true;
      this.selectedEpIds = [];
    },
    cancelMultiSelect() {
      this.selectMode = false;
      this.selectedEpIds = [];
    },
    isSelected(ep) {
      return this.selectedEpIds.includes(ep.id);
    },
    toggleSelect(ep) {
      if (this.isDownloaded(ep)) return; // 已下载不可选
      const i = this.selectedEpIds.indexOf(ep.id);
      if (i >= 0) this.selectedEpIds.splice(i, 1);
      else this.selectedEpIds.push(ep.id);
    },
    // [B-34] 单集行点击：多选模式 → 勾选；否则延迟进单集详情(留窗口给双击拦截)
    // [TODO4] 单击进详情、双击直接播放：单击先挂起 ~250ms；这期间来 dblclick 则取消导航、改播放。
    onRowClick(ep) {
      if (this.selectMode) {
        this.toggleSelect(ep);
        return;
      }
      if (this._rowClickTimer) clearTimeout(this._rowClickTimer);
      this._rowClickTimer = setTimeout(() => {
        this._rowClickTimer = null;
        this.goEpisodeDetail(ep);
      }, 250);
    },
    // [TODO4] 双击单集行 → 取消挂起的"进详情"，直接播放
    onRowDblClick(ep) {
      if (this.selectMode) return; // 多选模式不播放(与单击语义一致:只勾选)
      if (this._rowClickTimer) {
        clearTimeout(this._rowClickTimer);
        this._rowClickTimer = null;
      }
      this.playEpisode(ep);
    },
    // [B-34] 批量下载选中项（并发，每个独立 IPC 任务）
    downloadSelected() {
      if (!this.selectedEpIds.length) return;
      const eps = this.episodes.filter(e => this.selectedEpIds.includes(e.id));
      let n = 0;
      eps.forEach(ep => {
        if (this.isDownloaded(ep)) return; // 已下载，跳过
        if (this.downloadPercent(ep) >= 0) return; // 已在下载中，跳过
        startDownload(ep);
        n += 1;
      });
      this.$store.dispatch(
        'showToast',
        n > 0 ? `已加入下载队列：${n} 项` : '所选单集都已下载'
      );
      this.cancelMultiSelect();
    },
    // [C-5] 进单集详情页
    goEpisodeDetail(ep) {
      this.$router.push({
        name: 'episodeDetail',
        params: {
          feedUrlEncoded: encodeURIComponent(this.feedUrl),
          guidEncoded: encodeURIComponent(ep.guid),
        },
      });
    },
    // [C-4 改] 单集状态：优先用真实收听统计 listenStats，回退到 episodeProgress
    isFinished(ep) {
      return !!(ep.listenStats && ep.listenStats.completed);
    },
    listenPct(ep) {
      return listenedPercentStepped(ep.listenStats);
    },
    // 进度标签：已听完(绿) / 听过X%(黄) / 剩余/总时长（默认灰）
    formatProgressLabel(ep) {
      if (this.isFinished(ep)) return '已听完';
      const pct = this.listenPct(ep);
      if (pct >= 5) return `听过 ${pct}%`;
      const total = ep.duration || 0;
      const listened = ep.listenedSec || 0;
      if (listened > 30 && total > 0) {
        // [审操作#13] Math.max(0,…)：position 超过 RSS 声明时长时 total-listened 为负 → "-1:-50" 乱码。
        return `剩余 ${this.formatDuration(Math.max(0, total - listened))}`;
      }
      return this.formatDuration(total);
    },
    progressLabelClass(ep) {
      if (this.isFinished(ep)) return 'done';
      if (this.listenPct(ep) >= 5) return 'partial';
      return '';
    },
    confirmUnsubscribe() {
      this.closeCoverMenu();
      this.showConfirmUnsub = true;
    },
    // [B-50] 预览节目 → 正式订阅（改 subscribed:true，进我的订阅 + 全局已订阅状态）
    async subscribeThis() {
      if (!this.podcast) return;
      try {
        await updatePodcast(this.feedUrl, { subscribed: true });
        this.podcast = { ...this.podcast, subscribed: true };
        this.$store.commit('addSubscribedPodcast', {
          name: this.podcast.title,
          feedUrl: this.feedUrl,
        });
        this.$store.dispatch('showToast', '已订阅到我的');
      } catch (e) {
        this.$store.dispatch(
          'showToast',
          '订阅失败：' + ((e && e.message) || e)
        );
      }
    },
    async doUnsubscribe() {
      if (!this.podcast) return;
      await deletePodcast(this.podcast.id);
      // [B56-1] 全局同步：发现页/二级页/搜索里同名节目实时回到"未订阅"（与另两个取消订阅入口一致）
      this.$store.commit('removeSubscribedPodcast', {
        feedUrl: this.podcast.id,
        name: this.podcast.title,
      });
      this.showConfirmUnsub = false;
      this.$store.dispatch('showToast', '已取消订阅');
      // 回订阅列表（用 replace 避免历史栈里残留已删除节目的页面）
      this.$router.replace('/library');
    },
    formatDate(s) {
      if (!s) return '';
      const d = new Date(s);
      if (isNaN(d.getTime())) return s;
      return d.toLocaleDateString('zh-CN');
    },
    formatDuration(sec) {
      sec = Number(sec) || 0;
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(
          2,
          '0'
        )}`;
      }
      return `${m}:${String(s).padStart(2, '0')}`;
    },
    onCoverError(e) {
      e.target.style.opacity = 0;
    },
  },
};
</script>

<style lang="scss" scoped>
.podcast-detail-page {
  color: var(--color-text);
  // [bug] 详情页没有顶部 .header（与播客库一级界面相比少了"播客库"标题），
  // 内容直接顶到 navbar 下沿太紧。补一点上边距。
  padding-top: 28px;
}
.podcast-detail {
  display: flex;
  gap: 24px;
  margin-bottom: 32px;
  align-items: flex-start;
  // [B-33] 封面 wrap：承载右键"取消订阅"浮层
  // [B-63] 封面外框：承载光晕 + hover 微动放大（不裁切，光晕可溢出）
  .cover-box {
    position: relative;
    width: 180px;
    height: 180px;
    flex-shrink: 0;
    transition: transform 0.25s ease-out;
    &:hover {
      transform: translateY(-3px) scale(1.02);
    }
    &:hover .cover-shadow {
      // 辉光增强只动 opacity/transform（合成器属性），不动 filter → 不被主线程渲染阻塞、不再慢半拍
      opacity: 0.62;
      transform: scale(0.98);
    }
  }
  .cover-shadow {
    position: absolute;
    left: 0;
    top: 10px;
    width: 100%;
    height: 100%;
    border-radius: 16px;
    background-size: cover;
    background-position: center;
    // [perf] blur 固定不动画（filter 动画走主线程 paint，机核进详情时被千集渲染占用 → 辉光滞后于 scale）；
    //   强弱/扩散改用 opacity + transform scale，纯合成器、与主线程负载解耦。
    filter: blur(20px);
    opacity: 0.4;
    transform: scale(0.92);
    z-index: 0;
    transition: opacity 0.25s ease-out, transform 0.25s ease-out;
    will-change: opacity, transform;
    pointer-events: none;
  }
  .cover-wrap {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    border-radius: var(--radius-cover);
    overflow: hidden;
  }
  .cover-lg {
    width: 100%;
    height: 100%;
    // 圆角交给 .cover-wrap 的 overflow:hidden 裁；内层不再重复 radius（消双重圆角发丝缝裁切）
    object-fit: cover;
    background: var(--color-secondary-bg);
    display: block;
    transition: transform 0.25s ease-out, filter 0.25s ease-out;
  }
  // [B-35] 右键菜单：封面微微放大 + 压暗（同订阅页效果），上面浮两个图标按钮居中。
  // 注意 menu-active 在 .cover-wrap 上，不能用 &（&=.podcast-detail）。
  .cover-wrap.menu-active .cover-lg {
    transform: scale(1.06);
    filter: brightness(0.4);
  }
  .cover-menu-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 22px;
  }
  .cover-menu-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    cursor: pointer;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
    transition: transform 0.15s, background 0.15s, color 0.15s;
    .svg-icon {
      width: 22px;
      height: 22px;
    }
    &:hover {
      transform: scale(1.12);
      background: rgba(255, 255, 255, 0.24);
    }
    &.danger:hover {
      color: #ff7a6b;
      background: rgba(231, 76, 60, 0.28);
    }
  }
  .meta {
    flex: 1;
    // [裁切修] 原 overflow:hidden 会裁掉 .sub-this-btn 的 :hover scale 反馈(按钮左缘贴 .meta 边)；
    //   改 min-width:0：同样防 flex 被长标题撑破，但不裁切放大动画。
    min-width: 0;
    .t {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .a {
      opacity: 0.7;
      margin-bottom: 12px;
    }
    // [B-50] 预览节目的"订阅到我的"按钮（底色=封面主色；取色前隐藏避免蓝色闪烁）
    .sub-this-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
      padding: 7px 14px;
      border-radius: var(--radius-button);
      background: var(--color-primary);
      color: #fff;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.25s, transform 0.15s;
      white-space: nowrap;
      .svg-icon {
        width: 14px;
        height: 14px;
      }
      &.ready {
        opacity: 1;
      }
      &:hover {
        transform: scale(1.04);
      }
    }
    // [B-79] 简介：默认整行全显示；过长才出**细**滚动条(按需)、仅限简介区，不再像以前那样直接裁掉
    //   (凹凸电波这类长简介之前 max-height+overflow:hidden 被切、无法看全)。max-height 用 clamp 随窗口缩放。
    .d {
      font-size: 14px;
      opacity: 0.7;
      line-height: 1.6;
      max-height: clamp(90px, 13vh, 160px);
      overflow-y: auto;
      padding-right: 6px; // 给滚动条留位，文字不贴边
      scrollbar-width: thin; // Firefox 细滚动条
      // 覆盖全局 8px 滚动条：本区更细(5px)、轨道透明(去掉那条左边线)、拇指更淡
      &::-webkit-scrollbar {
        width: 5px;
      }
      &::-webkit-scrollbar-track {
        background: transparent;
        border-left: none;
      }
      &::-webkit-scrollbar-thumb {
        background: rgba(128, 128, 128, 0.3);
        border-radius: 3px;
      }
      &:hover::-webkit-scrollbar-thumb {
        background: rgba(128, 128, 128, 0.5);
      }
    }
  }
  // [B-25] 取消订阅按钮在右上
  .actions {
    flex-shrink: 0;
  }
}
.unsubscribe-btn {
  background: transparent;
  color: var(--color-text);
  opacity: 0.55;
  border-radius: var(--radius-button);
  padding: 6px 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  transition: 0.15s;
  .svg-icon {
    width: 16px;
    height: 16px;
  }
  &:hover {
    opacity: 1;
    background: rgba(231, 76, 60, 0.12);
    color: #e74c3c;
  }
}

.episode-list {
  border-top: 1px solid var(--color-secondary-bg);
}
// [B67-BUG-2] 缓存优先骨架态：单集后台载入中的轻提示
.ep-loading {
  padding: 28px 4px;
  text-align: center;
  font-size: 14px;
  opacity: 0.45;
}
// [B-73.2/F1] 还有未渲染单集时的底部提示（滚动接近会自动加载下一批）
.ep-more-hint {
  padding: 18px 4px 24px;
  text-align: center;
  font-size: 13px;
  opacity: 0.4;
  user-select: none;
}
// [B-70] 预览失败原地错误态
.ep-error {
  opacity: 0.7;
  .ep-error-back {
    margin-top: 14px;
    padding: 7px 18px;
    border: none;
    border-radius: var(--radius-button);
    background: var(--color-secondary-bg);
    color: var(--color-text);
    font-size: 13px;
    cursor: pointer;
    &:hover {
      background: var(--color-primary);
      color: #fff;
    }
  }
}
// [B-35] 多选右移改为「容器一次性 padding」：只 1 个元素做 padding 动画，
// 不再让几十行各自 transition padding（reflow ×N → 卡顿）。
.episode-list.select-mode {
  padding-left: 40px;
  transition: padding-left 0.22s ease;
}
.episode-list {
  transition: padding-left 0.22s ease;
}
.episode-row {
  padding: 14px 4px;
  cursor: pointer;
  border-bottom: 1px solid var(--color-secondary-bg);
  // [B-35] 只过渡 GPU 友好的 transform/opacity + background，去掉 padding 过渡
  transition: transform 0.15s, opacity 0.15s, background 0.15s;
  display: flex;
  align-items: center;
  gap: 12px;
  position: relative; // [B-31] 给 ep-dl-bar 提供绝对定位锚点
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
  // [B-34] 选中：整体微缩 + 暗一点（transform/opacity，GPU 合成不 reflow）
  &.selected {
    transform: scale(0.985);
    opacity: 0.82;
    background: var(--color-primary-bg-for-transparent);
  }
  // [B-34] 多选模式下已下载的：降低存在感（不可选）
  &.is-downloaded {
    opacity: 0.5;
    cursor: default;
  }
  // [B-35] 多选框：绝对定位在容器 padding 腾出的左侧空间（left 负值），缩小圆圈
  .ep-checkbox {
    position: absolute;
    left: -30px;
    top: 50%;
    transform: translateY(-50%);
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1.5px solid var(--color-text);
    opacity: 0.4;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2;
    transition: background 0.15s, border-color 0.15s, opacity 0.15s;
    .svg-icon {
      width: 12px;
      height: 12px;
      color: #fff;
    }
    &.checked {
      background: var(--color-primary);
      border-color: var(--color-primary);
      opacity: 1;
    }
    &.disabled {
      background: #27ae60;
      border-color: #27ae60;
      opacity: 0.9;
    }
  }
  // [B-31] 整行背景下载进度条：弱视觉灰色，z-index 在文字下方
  .ep-dl-bar {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 0%;
    background: rgba(128, 128, 128, 0.18);
    pointer-events: none;
    transition: width 0.4s ease-out;
    z-index: 0;
  }
  .ep-main,
  .ep-play-btn,
  .ep-menu-btn,
  .ep-downloaded-btn,
  .ep-fav-btn,
  .ep-queued {
    position: relative;
    z-index: 1;
  }
  // [B-59] 排队中图标（只提示，弱化显示、不可点）
  .ep-queued {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text);
    opacity: 0.45;
    flex-shrink: 0;
    .svg-icon {
      width: 18px;
      height: 18px;
    }
  }
  // [B-31] 已下载图标按钮：绿色 check-circle
  .ep-downloaded-btn {
    background: transparent;
    color: #27ae60;
    opacity: 0.95;
    padding: 8px;
    border-radius: 50%;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: 0.15s;
    flex-shrink: 0;
    .svg-icon {
      width: 18px;
      height: 18px;
    }
    &:hover {
      background: var(--color-secondary-bg-for-transparent);
      // hover 时露出"删除提示"色（红）
      color: #e74c3c;
    }
  }
  // [B-33] 已收藏图标按钮：红心
  .ep-fav-btn {
    background: transparent;
    color: #e74c3c;
    opacity: 0.95;
    padding: 8px;
    border-radius: 50%;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: 0.15s;
    flex-shrink: 0;
    .svg-icon {
      width: 18px;
      height: 18px;
    }
    &:hover {
      background: var(--color-secondary-bg-for-transparent);
      opacity: 1;
    }
  }
  .ep-main {
    flex: 1;
    min-width: 0;
  }
  .ep-title {
    font-weight: 600;
    font-size: 15px;
    margin-bottom: 4px;
    // [NAS] "NAS 上有此单集"标识：小 wifi 图标接名字后，绿(饱和与 navbar 同步) + 萤火虫式呼吸(nasGlow 按集错相位/微变周期)
    .nas-dot {
      display: inline-flex;
      align-items: center;
      margin-left: 5px;
      vertical-align: middle;
      color: #1db954;
      // 基础周期 3.6s 为兜底；nasGlow 的 inline animation-duration/delay 会按集覆盖
      animation: nas-breathe 3.6s ease-in-out infinite;
      .svg-icon {
        width: 13px;
        height: 13px;
      }
    }
  }
  // [NAS][呼吸灯 v2.0] 柔和不对称曲线：谷 .5 缓升 → 40% 达峰 → 缓降(仿苹果睡眠灯)；不用 linear()(Chromium91)。
  //   周期由各集 nasGlow 的 inline 值驱动(错相位+微变)。
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
  .ep-sub {
    font-size: 12px;
    opacity: 0.6;
    display: flex;
    gap: 4px;
  }
  // [C-4 改] 时长 / 听过X%（黄） / 已听完（绿）
  .ep-prog {
    &.partial {
      color: #e0a800; // 黄
      opacity: 1;
      font-weight: 600;
    }
    &.done {
      color: #27ae60; // 绿
      opacity: 1;
      font-weight: 600;
    }
  }
  // [S-3] play-circle + 三点冒号两按钮共用样式
  .ep-play-btn,
  .ep-menu-btn {
    background: transparent;
    color: var(--color-text);
    opacity: 0.4;
    padding: 8px;
    border-radius: 50%;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: 0.15s;
    flex-shrink: 0;
    .svg-icon {
      width: 18px;
      height: 18px;
    }
    &:hover {
      opacity: 1;
      background: var(--color-secondary-bg-for-transparent);
      color: var(--color-primary);
    }
  }
}

// 确认弹窗
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.confirm-dialog {
  background: var(--color-body-bg);
  color: var(--color-text);
  border-radius: 14px;
  padding: 24px 26px;
  min-width: 360px;
  max-width: 440px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
  .title {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 12px;
  }
  .msg {
    font-size: 14px;
    line-height: 1.6;
    opacity: 0.85;
    margin-bottom: 18px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
}
.btn-secondary {
  background: var(--color-secondary-bg);
  color: var(--color-text);
  padding: 8px 16px;
  border-radius: var(--radius-button);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    background: var(--color-primary-bg-for-transparent);
  }
}
// [S-3] 单集操作弹出菜单
.ep-ctx-menu {
  position: fixed;
  z-index: 220;
  background: var(--color-body-bg);
  color: var(--color-text);
  border-radius: 10px;
  padding: 4px;
  width: 200px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22),
    0 0 0 1px var(--color-secondary-bg-for-transparent);
}
.ctx-item {
  padding: 9px 12px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
  transition: 0.15s;
  .svg-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
  &:hover {
    background: var(--color-secondary-bg-for-transparent);
  }
  // [B-33] 删除下载项：红色警示
  &.danger {
    color: #e74c3c;
    &:hover {
      background: rgba(231, 76, 60, 0.12);
    }
  }
}

.btn-danger {
  background: #e74c3c;
  color: #fff;
  padding: 8px 16px;
  border-radius: var(--radius-button);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: 0.15s;
  &:hover {
    transform: scale(1.04);
  }
}

// [B-34] 多选下载固定栏：钉在底部播放栏上方，随滚动固定
.multi-dl-bar {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: 84px;
  z-index: 120;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 14px 10px 18px;
  border-radius: 14px;
  background: var(--color-body-bg);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.26),
    0 0 0 1px var(--color-secondary-bg-for-transparent);
  .mdl-info {
    font-size: 13px;
    opacity: 0.75;
    b {
      color: var(--color-primary);
      font-size: 15px;
    }
  }
  .mdl-cancel {
    background: transparent;
    color: var(--color-text);
    opacity: 0.6;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    padding: 6px 10px;
    border-radius: var(--radius-button);
    &:hover {
      opacity: 1;
      background: var(--color-secondary-bg-for-transparent);
    }
  }
  .mdl-go {
    background: var(--color-primary);
    color: var(--color-primary-bg);
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    padding: 8px 18px;
    border-radius: var(--radius-button);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: 0.15s;
    .svg-icon {
      width: 15px;
      height: 15px;
    }
    &:hover {
      transform: scale(1.04);
    }
    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
    }
  }
}
// [B-34] 固定栏滑入动画
.mdl-slide-enter-active,
.mdl-slide-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.mdl-slide-enter,
.mdl-slide-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(16px);
}
</style>
