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

    <div v-if="!list.length" class="empty">这段时间还没有收听记录</div>

    <!-- [B-38] 节目时长矩形条：bar 宽度=时长比例，封面在条右端，节目名紧跟封面（与各自进度条对齐） -->
    <div
      v-for="item in list"
      :key="item.podcastId"
      class="stat-row"
      @click="goPodcast(item)"
    >
      <div
        class="bar"
        :style="{ width: barWidth(item), background: barColor(item) }"
      >
        <img class="thumb" :src="item.coverUrl" @error="onCoverError" />
      </div>
      <div class="label">
        <div class="name">{{ item.title }}</div>
        <div class="dur">{{ fmtDur(item.wallSec) }}</div>
      </div>
    </div>
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
    maxWall() {
      return this.list.length ? this.list[0].wallSec : 1;
    },
  },
  async created() {
    this.pickMood();
    await this.loadTotal();
    await this.loadRange();
  },
  async activated() {
    this.pickMood();
    await this.loadTotal();
    await this.loadRange();
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
      this.list = list;
      // [B-39] 异步提取每个节目封面主色填充矩形条（不阻塞渲染，到了再刷新该行）
      this.list.forEach((item, i) => {
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
    async setRange(r) {
      if (this.range === r) return;
      this.range = r;
      await this.loadRange();
    },
    // 最长占 60%，留出右侧给节目名；最短保底放得下封面
    barWidth(item) {
      const pct = (item.wallSec / Math.max(1, this.maxWall)) * 60;
      return Math.max(7, pct) + '%';
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
.stat-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  cursor: pointer;
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
    min-width: 48px;
    transition: width 0.4s ease-out;
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
