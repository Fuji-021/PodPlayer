<template>
  <!-- [统计动画] --stat-k = 动画时长倍率：Dev 测试床版=2(慢放观察)，主线/dev-serve=1(不受影响) -->
  <div class="stats-page" :style="{ '--stat-k': animK }">
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

    <!-- [统计动画 v1.2] 时长矩形条统一动画：宽度由响应式 _w 驱动，走同一条 CSS width 过渡。
         留存条伸缩(俯视缩小)+FLIP 移动；新增条从 0 长出(从左)；离开条塌缩裁切。全程不透明、无渐隐(v1.2 去残影)。 -->
    <transition-group name="stat" tag="div" class="stat-list">
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
      // [B-63] 默认"全部"；记忆用户上次选择(localStorage)，离开再回来保持
      range:
        localStorage.getItem('statsPage.range') === 'week' ? 'week' : 'all',
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
    // [统计动画] 动画时长倍率：仅 Dev 测试床构建(VUE_APP_DEV_SEED=true)放慢 2 倍供观察，
    //   主线/dev-serve 该变量不为 'true' → 1 倍，完全不受影响。
    animK() {
      return process.env.VUE_APP_DEV_SEED === 'true' ? 2 : 1;
    },
  },
  async created() {
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
      // [C] 并发守卫：锁定本次加载序号与 range，await 后失效则放弃，避免旧请求覆盖/存错键
      const seq = (this._loadSeq = (this._loadSeq || 0) + 1);
      const range = this.range;
      const { totalWall, list } = await getListenStatsByPodcast(
        range === 'week' ? 7 : 'all'
      );
      if (seq !== this._loadSeq) return;
      this.rangeTotal = totalWall;
      this.animateTo(list);
      this.saveSnapshot(range, list);
    },
    // [统计动画 v1 路线] 进入页面：以上次快照(各自宽度)为起点 → animateTo(fresh) 平滑过渡。
    //   留存条**同时**位移+伸缩(无等待)、新增条从左长出、离开条收走，即用户认可的"重排"动画。
    //   (v1=重排；v1.1=消残影；v1.2=去渐隐塌缩；v1.2.1=塌缩改纯CSS修顶部闪现；
    //    v1.3=整行不透明底色根治半透明条交叉透叠+文字叠糊残影；
    //    v1.4=离开行钉坐标+镜像[已废弃：快速切换时内联残留致崩]；
    //    v1.5=离开行**瞬时消失**(砍掉整条 leave 路径) + .bar overflow:hidden 修封面越界。
    //    规则见开发文档「版本命名规则」。)
    async enterWithAnimation() {
      // [C] 并发守卫：锁定本次加载序号与 range，每个 await 后校验，避免初次加载期间切范围导致旧 fresh 覆盖/存错键
      const seq = (this._loadSeq = (this._loadSeq || 0) + 1);
      const range = this.range;
      this.pickMood();
      await this.loadTotal();
      if (seq !== this._loadSeq) return;
      const snap = this.loadSnapshot(range);
      if (snap && snap.length) {
        const sMax = snap[0].wallSec || 1;
        this.list = snap.map(it => {
          const w = this.barTargetPct(it, sMax);
          return { ...it, _target: w, _w: w };
        });
      } else {
        this.list = [];
      }
      await this.$nextTick();
      if (seq !== this._loadSeq) return;
      const fresh = await getListenStatsByPodcast(range === 'week' ? 7 : 'all');
      if (seq !== this._loadSeq) return;
      this.rangeTotal = fresh.totalWall;
      this.animateTo(fresh.list);
      this.saveSnapshot(range, fresh.list);
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
    //   新增条：宽度从 0 长出(从左边长出来)，不透明(v1.2 去淡入)
    //   离开条：瞬时消失(v1.5，无 leave 动画)
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
      // 双 rAF：先让"起点宽度"(新条 0 / 留存条旧值)真正绘制一帧，再统一过渡到目标宽 → 必触发 width 过渡。
      // [v1.5/B69-V1 消除] 写的是本次捕获的 next(每次 animateTo 都新建对象)而非 this.list：
      //   快速切换时旧 rAF 不会把"瞬时到位"误写进新一轮列表(否则新条会跳过从 0 长出的过程)。
      this.$nextTick(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            next.forEach(it => {
              it._w = it._target;
            });
          });
        });
      });
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
      // [B-63] 记忆选择：离开再回来保持上次的范围
      try {
        localStorage.setItem('statsPage.range', r);
      } catch (e) {
        /* 忽略 */
      }
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
    // [统计动画 v1.5] v1.4 的 pinLeave 已删除：内联钉的 top/left/width 在离开动画被**中途取消**
    //   (用户周/全部快速来回切，同 key 行复活)时不会被清掉 → 布局永久畸形、离开行卡死不走
    //   (Dev 实测"切换直接崩、周显示全部 12 行")。leave 路径自 v1~v1.4 五版皆出 bug(残影/顶闪/
    //   切割/越界/卡死)，v1.5 决定性收敛：**离开行瞬时消失**(无 leave 动画、无钩子、无内联残留)，
    //   留存行 FLIP + 新增行从左长出保持不变。
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
  // [B-63改/v1.2.1] 独立层叠上下文(v1.5 后离开行已瞬时移除，保留它无害且利于未来叠层控制)
  isolation: isolate;
}
.stat-move {
  transition: transform calc(0.65s * var(--stat-k, 1))
    cubic-bezier(0.22, 1, 0.36, 1);
}
/* [统计动画 v1.2] 新增条：不再淡入。时间条"从左长出"由 .bar 的 width 过渡(0→目标宽)驱动，
   整条始终不透明 = 实心条生长；行级仅加「轻微左移→归位」让文字不硬蹦，无 opacity。 */
.stat-enter-active {
  transition: transform calc(0.5s * var(--stat-k, 1))
    cubic-bezier(0.22, 1, 0.36, 1);
}
.stat-enter {
  transform: translateX(-12px);
}
/* [统计动画 v1.5] 离开条：**瞬时消失**(不再定义任何 .stat-leave-* 过渡 → Vue 检测无过渡、立即移除)。
   leave 路径(absolute/钉坐标/max-height 塌缩/条回缩)自 v1~v1.4 五个版本反复出 bug：
   残影(v1.1)→顶部闪现(v1.2.1)→交叉透叠(v1.3)→跳位切割(v1.4)→快速切换内联残留崩坏(v1.4 实测)。
   v1.5 决定性收敛：离开行没有动画就没有这一类 bug；留存行 FLIP 平移 + 新增行从左长出保持原样。 */
.stat-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  cursor: pointer;
  // [统计动画 v1.3] 整行不透明底色(=页面色，静态外观零变化) → 重排交叉时"行覆盖行"，
  //   连同条与文字一起被上层行实实在在遮挡。这才是残影/文字叠糊的根治：
  //   时长条是 hsla(...,0.6) 半透明、z-index 压再低也会透出下层，唯有让整行不透明才能真正盖住。
  background: var(--color-body-bg);
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
    // [B-61] min-width:0 → 新条能从 0 长出；静止态最窄=barTargetPct 的 7% 兜底(常规窗口 ≈ 40px+ 放得下封面)。
    min-width: 0;
    // [v1.5/越界修] 裁掉超出条框的内容：条窄于 40px 封面时(新增条从 0 长出的前几帧 / 极窄窗口的 7% 兜底条)，
    //   右对齐的封面会从条**左缘**溢出、捅出页面左边界(用户截图红圈"全部越界")。裁切后封面随条变宽逐渐露出，
    //   观感正是"从左长出带出封面"。
    overflow: hidden;
    // [B-54/B-61] 进度条伸缩(俯视抬高整体缩小) + 从左长出 的丝滑过渡，与 .stat-move 同缓动
    transition: width calc(0.6s * var(--stat-k, 1))
      cubic-bezier(0.22, 1, 0.36, 1);
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
