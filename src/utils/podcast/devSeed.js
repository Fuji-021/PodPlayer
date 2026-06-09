// [DEV BUILD ONLY] 作弊数据注入（动画测试床版 v2）：
//   首次启动写入 5 档测试节目，构造「最近 1 周 3 条 / 全部时间 5 条、时长各异」的场景，
//   用于验证收听统计排行的统一动画（新增条从左长出 / 留存条伸缩+移动 / 离开条回缩）。
//
// 安全约束：
//  - 仅在 process.env.VUE_APP_DEV_SEED === 'true' 的构建中被 main.js 调用
//    （dev-serve 调试实例启动时不带该变量 → 永不在调试数据里注入，互不污染）。
//  - 版本化 run-once：localStorage 标记防重复；升级版本时只清理 devseed- 前缀的旧数据再重灌
//    （绝不动用户真实订阅/收听）。
//  - 本文件只存在于 devbuild 分支，master 主线不含它。
import { db } from '@/utils/db';

const SEED_FLAG = 'devSeed.v2.done'; // 版本号：改造数据结构时 +1 → 自动清旧重灌

// 5 档测试节目。allHours = 全部时间累计(episodeListenStats)；weekHours = 最近 7 天(listenDaily)，
//   weekHours=0 表示「只在 7 天前听过」→ 只出现在「全部」、不出现在「最近 1 周」。
// 设计：全部时长 120/88/60/38/22（降序、各异）；最近一周只有 3 档且顺序故意错位，
//   切到全部时：电影夜话(周#1)→全部#5 一路缩短下移、科技早知道(周#3)→全部#2 上移、
//   深度对话+商业内参 从左长出。
const PODCASTS = [
  { name: '深度对话', color: '#e74c3c', allHours: 120, weekHours: 0 }, // 全部#1，不在周
  { name: '科技早知道', color: '#3498db', allHours: 88, weekHours: 3 }, // 周#3
  { name: '历史的温度', color: '#e67e22', allHours: 60, weekHours: 5 }, // 周#2
  { name: '商业内参', color: '#16a085', allHours: 38, weekHours: 0 }, // 不在周
  { name: '电影夜话', color: '#8e44ad', allHours: 22, weekHours: 7 }, // 周#1
];

// 纯色方块封面（data-URI，无网络依赖）
function coverDataUri(color, label) {
  const ch = (label || '·').slice(0, 1);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">` +
    `<rect width="120" height="120" rx="16" fill="${color}"/>` +
    `<text x="60" y="80" font-size="58" fill="#fff" text-anchor="middle" ` +
    `font-family="sans-serif" font-weight="bold">${ch}</text>` +
    `</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// 最近第 offset 天的本地日期 key（YYYY-MM-DD），与 listening.js 的 dayKey 同格式
function dayKey(offsetDays) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 清理上一版 seed 数据（只删 devseed- 前缀，绝不动真实数据）
async function clearOldSeed() {
  try {
    await db.podcasts.where('id').startsWith('devseed-').delete();
    await db.episodeListenStats.where('id').startsWith('devseed-').delete();
    await db.listenDaily
      .filter(r => String(r && r.podcastId).startsWith('devseed-'))
      .delete();
  } catch (e) {
    // ignore
  }
}

export async function seedDevDataIfNeeded() {
  try {
    if (localStorage.getItem(SEED_FLAG)) return;
    await clearOldSeed(); // 升级/重装时先清旧 seed（v1 的 10 档等）

    const now = Date.now();
    const podcastRows = [];
    const statRows = [];
    const dailyRows = [];

    PODCASTS.forEach((p, idx) => {
      const pid = `devseed-podcast-${idx + 1}`; // 不含 '::'，保证 split('::')[0] 取回 podcastId
      podcastRows.push({
        id: pid,
        feedUrl: pid,
        title: p.name,
        coverUrl: coverDataUri(p.color, p.name),
        description: '【开发测试数据】用于验证统计动画，非真实节目。',
        author: 'PodPlayer Dev',
        subscribed: true,
        source: 'manual',
        updatedAt: now,
      });

      // 全部时间：episodeListenStats，每集 1 小时听满，条数 = allHours
      for (let i = 0; i < p.allHours; i++) {
        statRows.push({
          id: `${pid}::ep${i + 1}`,
          totalSec: 3600,
          bits: new Uint8Array(0),
          listenedSec: 3600,
          completed: true,
          totalPlayWallSec: 3600,
          totalPlayContentSec: 3600,
          updatedAt: now,
        });
      }

      // 最近 1 周：listenDaily 仅落在最近 7 天，周合计 = weekHours
      //   weekHours=0 的节目不写任何 listenDaily → 不出现在「最近 1 周」
      if (p.weekHours > 0) {
        const totalWeekSec = p.weekHours * 3600;
        const perDay = Math.round(totalWeekSec / 7);
        for (let d = 0; d < 7; d++) {
          const date = dayKey(d);
          dailyRows.push({
            key: `${date}::${pid}`,
            date,
            podcastId: pid,
            wallSec: perDay,
            contentSec: perDay,
            listenedSec: perDay,
          });
        }
      }
    });

    await db.podcasts.bulkPut(podcastRows);
    await db.episodeListenStats.bulkPut(statRows);
    await db.listenDaily.bulkPut(dailyRows);
    localStorage.setItem(SEED_FLAG, '1');

    // eslint-disable-next-line no-console
    console.log(
      `[devSeed v2] 注入完成：全部 ${podcastRows.length} 档(120/88/60/38/22h) / 最近1周 3 档(电影夜话7h>历史5h>科技3h) / ${statRows.length} 条单集 / ${dailyRows.length} 条按天`
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[devSeed] 注入失败', e);
  }
}
