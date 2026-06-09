<template>
  <div class="stats-page">
    <!-- [B-38] 顶部：彩虹猫跑步彩蛋（替代火星天）。文案宽度 = 彩虹条长度，末端 nyancat 在跑 -->
    <div class="hero">
      <div class="run-line">
        <span class="prefix">{{ catName }} 跑了</span>
        <span class="num">{{ totalHours }}</span>
        <span class="unit">小时</span>
        <span class="num">{{ totalMins }}</span>
        <span class="unit">分钟</span>
        <span class="prefix">，{{ mood }}</span>
      </div>
      <div class="rainbow-wrap">
        <div class="rainbow-bar"></div>
        <img class="nyan" src="/img/logos/nyancat.gif" alt="" />
      </div>
    </div>

    <!-- 范围切换：最近 1 周 / 全部 -->
    <div class="range-tabs">
      <div
        class="tab"
        :class="{ active: range === 'week' }"
        @click="setRange('week')"
      >
        最近 1 周
      </div>
      <div
        class="tab"
        :class="{ active: range === 'all' }"
        @click="setRange('all')"
      >
        全部
      </div>
    </div>

    <div class="range-total"> 共 {{ fmtDur(rangeTotal) }} </div>

    <div v-if="!visibleList.length" class="empty">这段时间还没有收听记录</div>

    <!-- [B-54/B-61] 时长矩形条统一动画：宽度由响应式 _w 驱动，走同一条 CSS width 过渡。
         留存条伸缩(俯视缩小)+FLIP 移动；新增条从 0 长出(从左长出来)+淡入；离开条回缩到 0+淡出。 -->
    <transition-group name="stat" tag="div" class="stat-list" @leave="onLeave">
      <div
        v-for="item in visibleList"
        :key="item.podcastId"
        class="stat-row"
        @click="goPodcast(item)"
      >
        <div
          class="bar"
          :style="{ width: item._w + '%', background: barColor(item) }"
        >
          <PodImage class="thumb" :src="item.coverUrl" @error="onCoverError" />
        </div>
        <div class="label">
          <div class="name">{{ item.title }}</div>
          <div class="dur">{{ fmtDur(item.wallSec) }}</div>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<script>
import { getListenStatsByPodcast } from '@/utils/podcast/listening';
import { getCoverColor } from '@/utils/podcast/coverColor';

export default {
  name: 'StatsPage',
  data() {
    return {
      catName: 'Fujii',
      // [B-40] 跑步趣味提示词随机池，每次进来随机一个（词别太长，免得撑破彩虹条）
      mood: '我还能跑～',
      moods: [
        '我还能跑～',
        '加油，干就完了！',
        '不想再跑了 qvq',
        '好累啊…',
        '好想睡觉啊～',
        '待会吃什么呢？',
        '也没看到终点啊…',
        '腿快不是我的了',
        '风里雨里都在跑',
        '再跑亿点点',
        '今天也很努力呢',
        '喵？还要跑吗',
        '坚持住，冲鸭！',
        '路还长着呢…',
      ],
      range: 'week',
      totalWall: 0, // 全部累计（顶部大数字始终显示总量）
      rangeTotal: 0, // 当前范围合计
      list: [],
    };
  },
  computed: {
    totalHours() {
      return Math.floor(this.totalWall / 3600);
    },
    totalMins() {
      return Math.floor((this.totalWall % 3600) / 60);
    },
    // [B-47 第5点] 统计页不显示已屏蔽节目（取消屏蔽后恢复；数据不删，仅不显示）
    blockedNames() {
      return new Set(
        (this.$store.state.podcastBlocked.items || []).map(b =>
          (b.name || '').trim()
        )
      );
    },
    visibleList() {
      return this.list.filter(
        it => !this.blockedNames.has((it.title || '').trim())
      );
    },
  },
  async created() {
    await this.enterWithAnimation();
  },
  async activated() {
    // keep-alive：每次重新进入都跑一次"重排"动画（用上次快照当起点）
    await this.enterWithAnimation();
  },
  methods: {
    // [B-40] 每次进来随机一条跑步提示词
    pickMood() {
      this.mood = this.moods[Math.floor(Math.random() * this.moods.length)];
    },
    async loadTotal() {
      const { totalWall } = await getListenStatsByPodcast('all');
      this.totalWall = totalWall;
    },
    async loadRange() {
      const { totalWall, list } = await getListenStatsByPodcast(
        this.range === 'week' ? 7 : 'all'
      );
      this.rangeTotal = totalWall;
      this.animateTo(list);
      this.saveSnapshot(this.range, list);
    },
    // [B-63] 进入页面的动画：**每次进入都重新计算本范围数据并从 0 长出一遍**
    //   （不论数据是否变化、不管从首页还是任意页面返回都触发）。所有条 _w 从 0 → 目标宽，
    //   配合按排名顺序渲染，得到一致、符合直觉的"数据刷新/长出"动画（比快照对比更稳、无残影）。
    async enterWithAnimation() {
      this.pickMood();
      await this.loadTotal();
      const fresh = await getListenStatsByPodcast(
        this.range === 'week' ? 7 : 'all'
      );
      this.rangeTotal = fresh.totalWall;
      const maxWall = fresh.list.length ? fresh.list[0].wallSec : 1;
      // 起点：全部条 _w=0（收起）；下一帧统一长到目标宽 → CSS width 过渡逐条长出
      this.list = fresh.list.map(it => ({
        ...it,
        _target: this.barTargetPct(it, maxWall),
        _w: 0,
      }));
      this.extractColors();
      this.$nextTick(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.list.forEach(it => {
              it._w = it._target;
            });
          });
        });
      });
      this.saveSnapshot(this.range, fresh.list);
    },
    // [B-39] 异步提取每个节目封面主色填充矩形条（不阻塞渲染，到了再刷新该行）
    extractColors() {
      this.list.forEach((item, i) => {
        if (item.colorHsl) return; // [B-61] 已沿用上次的色 → 跳过，避免重排时闪色
        getCoverColor(item.coverUrl).then(hsl => {
          if (
            hsl &&
            this.list[i] &&
            this.list[i].podcastId === item.podcastId
          ) {
            this.$set(this.list[i], 'colorHsl', hsl);
          }
        });
      });
    },
    // [B-61] 单条目标宽度%（相对最长条；最长占 60% 留出右侧给名字，最短保底 7% 放得下封面）
    barTargetPct(item, maxWall) {
      const pct = (item.wallSec / Math.max(1, maxWall)) * 60;
      return Math.max(7, pct);
    },
    // [B-61] 把当前 list 平滑过渡到 freshList（统一动画核心）：
    //   留存条：保持当前宽 → 下一帧过渡到新宽(最长条变长→其余整体变细=俯视抬高缩小) + FLIP 移动
    //   新增条：宽度从 0 长出(从左边长出来) + 淡入
    //   离开条：宽度回缩到 0 + 淡出(见 onLeave)
    animateTo(freshList) {
      const maxWall = freshList.length ? freshList[0].wallSec : 1;
      const prev = {};
      this.list.forEach(it => {
        prev[it.podcastId] = it;
      });
      const next = freshList.map(it => {
        const p = prev[it.podcastId];
        return {
          ...it,
          _target: this.barTargetPct(it, maxWall),
          _w: p ? p._w : 0, // 留存：沿用当前宽(随后过渡到新宽)；新增：从 0 起
          colorHsl: p ? p.colorHsl : undefined, // 留存沿用色，避免闪色
        };
      });
      this.list = next;
      this.extractColors();
      // 双 rAF：先让"起点宽度"(新条 0 / 留存条旧值)真正绘制一帧，再统一过渡到目标宽 → 必触发 width 过渡
      this.$nextTick(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.list.forEach(it => {
              it._w = it._target;
            });
          });
        });
      });
    },
    // [B-61] 离开动画：时间条回缩到 0 + 整行淡出（与"从左长出"镜像；position:absolute 让留存条 FLIP 补位）
    onLeave(el, done) {
      const bar = el.querySelector('.bar');
      // [B-63] 离开项压到底层(z-index)，让 FLIP 上移进来的留存项盖住它 → 消除第一行"残影"重叠；
      //   同时回缩+淡出比留存项移动略快，离开项尽早消失，进一步减少视觉叠影。
      el.style.zIndex = '0';
      el.style.transition = 'opacity 0.32s ease';
      el.style.opacity = '0';
      if (bar) {
        bar.style.transition = 'width 0.34s cubic-bezier(0.4, 0, 0.2, 1)';
        bar.style.width = '0%';
      }
      setTimeout(done, 360);
    },
    // [B-54] 上次进入时的排行快照（localStorage，按 range 分键），作为下次动画起点
    loadSnapshot(range) {
      try {
        return JSON.parse(
          localStorage.getItem('statsPage.snap.v2.' + range) || '[]'
        );
      } catch (e) {
        return [];
      }
    },
    saveSnapshot(range, list) {
      try {
        const slim = (list || []).map(x => ({
          podcastId: x.podcastId,
          title: x.title,
          coverUrl: x.coverUrl,
          wallSec: x.wallSec,
          colorHsl: x.colorHsl,
        }));
        localStorage.setItem(
          'statsPage.snap.v2.' + range,
          JSON.stringify(slim)
        );
      } catch (e) {
        // localStorage 满/异常忽略
      }
    },
    async setRange(r) {
      if (this.range === r) return;
      this.range = r;
      await this.loadRange();
    },
    barColor(item) {
      // [B-41] 封面主色 → 低饱和纯色 + 半透明（透明度低于实色封面，参考小宇宙：
      // 封面是实色焦点，时长条用同色系的"淡一档"衬托，不抢封面）。
      if (item.colorHsl) {
        const [h, s, l] = item.colorHsl;
        return `hsla(${h}, ${s}%, ${l}%, 0.6)`;
      }
      const str = item.podcastId || item.title || '';
      let h = 0;
      for (let i = 0; i < str.length; i++) {
        h = (h * 31 + str.charCodeAt(i)) % 360;
      }
      return `hsla(${h}, 30%, 52%, 0.6)`;
    },
    fmtDur(sec) {
      sec = Math.floor(sec || 0);
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      if (h > 0) return `${h} 小时 ${m} 分钟`;
      if (m > 0) return `${m} 分钟`;
      return `${sec} 秒`;
    },
    goPodcast(item) {
      if (!item.podcastId) return;
      this.$router.push({
        name: 'podcastDetail',
        params: { feedUrlEncoded: encodeURIComponent(item.podcastId) },
      });
    },
    onCoverError(e) {
      e.target.style.opacity = 0;
    },
  },
};
</script>

<style lang="scss" scoped>
.stats-page {
  color: var(--color-text);
  padding-top: 28px;
}
// [B-38] 彩虹猫彩蛋：hero 宽度由文案决定，彩虹条同宽，末端猫在跑
.hero {
  // [B-39] block + fit-content：独占一行（范围 tab 换到下方），宽度仍=文案宽（彩虹条同宽）。
  // 原来 inline-block + tab 的 inline-flex 挤在同一行 → tab 挡住彩虹条末端的猫。
  display: block;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 46px; // 加大与下方 tab 的间距
}
.run-line {
  display: flex;
  align-items: baseline;
  gap: 4px;
  white-space: nowrap;
  .prefix {
    font-size: 18px;
    opacity: 0.7;
    font-weight: 600;
  }
  .num {
    font-size: 52px;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -1px;
  }
  .unit {
    font-size: 18px;
    opacity: 0.55;
  }
}
.rainbow-wrap {
  position: relative;
  width: 100%;
  height: 10px;
  margin-top: 12px;
}
.rainbow-bar {
  width: 100%;
  height: 10px; // ≈ "小时"字号(18px)的一半多一点，醒目的彩虹条
  border-radius: 5px;
  // 经典 nyancat 彩虹（厚度方向分层），复用 slider.css 的配色
  background: linear-gradient(
    to bottom,
    #f00 0%,
    #f90 17%,
    #ff0 33%,
    #3f0 50%,
    #09f 67%,
    #63f 83%
  );
}
.nyan {
  position: absolute;
  right: -18px; // 猫探出条末端在跑
  top: 50%;
  transform: translateY(-50%);
  width: 40px;
  height: 27px;
  image-rendering: pixelated;
}
.range-tabs {
  display: inline-flex;
  gap: 4px;
  background: var(--color-secondary-bg);
  border-radius: 10px;
  padding: 3px;
  margin-bottom: 12px;
  .tab {
    padding: 6px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    opacity: 0.6;
    transition: 0.15s;
    &:hover {
      opacity: 0.9;
    }
    &.active {
      opacity: 1;
      background: var(--color-body-bg);
      color: var(--color-primary);
    }
  }
}
.range-total {
  font-size: 13px;
  opacity: 0.55;
  margin-bottom: 18px;
}
.empty {
  text-align: center;
  opacity: 0.4;
  padding: 60px 0;
  font-size: 14px;
}
// [B-54] 排行重排动画：move=FLIP 位移（节目被刷上/刷下），enter=新增补入，leave=移除
.stat-list {
  position: relative;
  // [B-63] 建立层叠上下文，让"离开行(z:0)"被"留存行(z:1)"盖住 → 第一行无残影
  isolation: isolate;
}
.stat-move {
  transition: transform 0.65s cubic-bezier(0.22, 1, 0.36, 1);
}
/* [B-61] 新增条：淡入（时间条"从左长出"由 .bar 的 width 过渡驱动，0→目标宽） */
.stat-enter-active {
  transition: opacity 0.55s ease;
}
.stat-enter {
  opacity: 0;
}
/* [B-61] 离开条：position:absolute 让留存条 FLIP 上移补位；回缩+淡出在 onLeave(JS) 里做 */
.stat-leave-active {
  position: absolute;
  width: 100%;
}
.stat-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  cursor: pointer;
  // [B-63] 留存/移动行在上层(z:1)，离开行 onLeave 里压到 z:0 → 上移补位的行盖住离开行
  position: relative;
  z-index: 1;
  &:hover .name {
    color: var(--color-primary);
  }
  // [B-38] bar 宽度=时长比例（不再 flex:1），封面叠在条右端
  .bar {
    height: 40px;
    border-radius: 8px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    // [B-61] min-width:0 → 新条能从 0 长出、离开条能回缩到 0；封面 thumb 随右端从左侧带出。
    //   静止态最窄=barTargetPct 的 7% 兜底(常规窗口 ≈ 40px+ 放得下封面)。
    min-width: 0;
    // [B-54/B-61] 进度条伸缩(俯视抬高整体缩小) + 从左长出 的丝滑过渡，与 .stat-move 同缓动
    transition: width 0.6s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .thumb {
    width: 40px;
    height: 40px;
    border-radius: 8px;
    object-fit: cover;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    background: var(--color-secondary-bg);
  }
  // [B-38] 名字紧跟 bar（=与各自进度条右端对齐），不再固定右列对齐
  .label {
    min-width: 0;
    flex-shrink: 1;
    .name {
      font-size: 14px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: color 0.15s;
    }
    .dur {
      font-size: 12px;
      opacity: 0.55;
      margin-top: 2px;
    }
  }
}
</style>
