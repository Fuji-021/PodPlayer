// [DEV BUILD ONLY] 作弊数据注入：首次启动写入 ~520 小时收听统计 + 10 档测试节目，
// 供「收听数据统计」页 / 进度条重排动画在无需真实收听的情况下验证。
//
// 安全约束：
//  - 仅在 process.env.VUE_APP_DEV_SEED === 'true' 的构建中被 main.js 调用（dev-serve
//    调试实例启动时不带该变量 → 永不在调试数据里注入，互不污染）。
//  - run-once：localStorage 标记防重复注入；若库里已有真实统计数据则跳过（绝不覆盖）。
//  - 本文件只存在于 devbuild 分支，master 主线不含它。
import { db } from '@/utils/db';

const SEED_FLAG = 'devSeed.v1.done';

// 10 档测试节目，时长合计 = 520 小时（降序，便于看排行条长短差异）
const PODCASTS = [
  { name: '深度对话', hours: 100, color: '#e74c3c' },
  { name: '科技早知道', hours: 80, color: '#3498db' },
  { name: '历史的温度', hours: 70, color: '#e67e22' },
  { name: '商业内参', hours: 60, color: '#16a085' },
  { name: '电影夜话', hours: 50, color: '#8e44ad' },
  { name: '宇宙漫游指南', hours: 45, color: '#34495e' },
  { name: '声音手账', hours: 38, color: '#d35400' },
  { name: '城市漫步', hours: 30, color: '#27ae60' },
  { name: '午夜书房', hours: 25, color: '#c0392b' },
  { name: '生活实验室', hours: 22, color: '#2980b9' },
];

// 纯色方块封面（data-URI，无网络依赖；node-vibrant 取色失败也会落到哈希色兜底）
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

export async function seedDevDataIfNeeded() {
  try {
    if (localStorage.getItem(SEED_FLAG)) return;
    // 双保险：库里已有统计数据（真实使用过）则不注入，仅打标记
    const existing = await db.episodeListenStats.count();
    if (existing > 0) {
      localStorage.setItem(SEED_FLAG, '1');
      return;
    }

    const now = Date.now();
    const SPREAD_DAYS = 45; // 把每档时长摊到最近 45 天 → 「最近 1 周」「全部」都有数据

    const podcastRows = [];
    const statRows = [];
    const dailyRows = [];

    PODCASTS.forEach((p, idx) => {
      const pid = `devseed-podcast-${idx + 1}`; // 不含 '::'，保证 split('::')[0] 取回 podcastId
      const cover = coverDataUri(p.color, p.name);

      podcastRows.push({
        id: pid,
        feedUrl: pid,
        title: p.name,
        coverUrl: cover,
        description: '【开发测试数据】用于验证统计功能，非真实节目。',
        author: 'PodPlayer Dev',
        subscribed: true,
        source: 'manual',
        updatedAt: now,
      });

      // episodeListenStats：每集 1 小时(3600s)、听满、completed；条数 = 小时数
      // 「全部」视图用 listenedSec 求和，故每档累计 = hours * 3600
      for (let i = 0; i < p.hours; i++) {
        statRows.push({
          id: `${pid}::ep${i + 1}`,
          totalSec: 3600,
          bits: new Uint8Array(0), // 统计页不读 bits，留空省空间
          listenedSec: 3600,
          completed: true,
          totalPlayWallSec: 3600,
          totalPlayContentSec: 3600,
          updatedAt: now,
        });
      }

      // listenDaily：总时长平摊到最近 SPREAD_DAYS 天，供「最近 N 天」视图
      const perDay = Math.round((p.hours * 3600) / SPREAD_DAYS);
      for (let d = 0; d < SPREAD_DAYS; d++) {
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
    });

    await db.podcasts.bulkPut(podcastRows);
    await db.episodeListenStats.bulkPut(statRows);
    await db.listenDaily.bulkPut(dailyRows);
    localStorage.setItem(SEED_FLAG, '1');

    // eslint-disable-next-line no-console
    console.log(
      `[devSeed] 注入完成：${podcastRows.length} 档节目 / ${statRows.length} 条单集收听 / ${dailyRows.length} 条按天聚合（约 520 小时）`
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[devSeed] 注入失败', e);
  }
}
