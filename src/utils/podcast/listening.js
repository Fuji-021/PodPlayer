// [播客改造] 真实收听统计：
// - listenedSec / completed：用于"听过 X%" / "已听完"标记
// - totalPlayWallSec：墙钟秒数（用户真花了多久）
// - totalPlayContentSec：节目时长域秒数（按倍速换算）
//
// 算法见 docs §B-30/...：去重秒、跳跃判定、倍速考虑。
import { db } from '@/utils/db';

export async function getListenStats(id) {
  if (!id) return null;
  return await db.episodeListenStats.get(id);
}

// [B-36] 批量取收听统计：一次 bulkGet 代替 N 次 get（节目详情页列表提速）
export async function getListenStatsBulk(ids) {
  if (!ids || !ids.length) return [];
  return await db.episodeListenStats.bulkGet(ids);
}

export async function getAllListenStats() {
  return await db.episodeListenStats.toArray();
}

/**
 * [B69-F5 降频] 批量收听 tick：把一个时间窗口(由 Player 端累积 ~LISTEN_FLUSH_SEC 秒)的
 *   "记 bit 的秒位置数组 + 墙钟/内容增量"一次性写入。原逐秒 tickListen 每秒各开 2 个 rw 事务
 *   (episodeListenStats 整行 put 含 KB 级 bits + listenDaily)，长集(机核 4h≈14400s)累计数万次写事务、
 *   bits 每秒整段重写 → 功耗/SSD 写放大 + 与列表读争用。改为批量后写事务量降到约 1/N。
 *   语义完全不变：逐位 dedup 置位、completed 判定、listenDaily 按天聚合。
 *
 * 设计要点：
 *   - 仍用 `db.transaction('rw', …)` 包 R-M-W(承袭 审P2-10，防 flush 重叠丢更新)。
 *   - **每次都读最新 DB 行**(不缓存内存行) → 对 resetEpisodeListening(重播已听完单集会清 bits)天然友好：
 *     flush 读到的就是重置后的行，不会用陈旧内存行把重置覆盖掉。
 *   - 数据缓冲在 Player 端(随播放会话，切集/暂停/退出 flush)，本函数无模块级状态。
 *
 * @param {string} id           episode.id
 * @param {number} totalSec     单集总时长（秒）
 * @param {object} opts
 *   - secs: 本窗口"记 bit"的秒位置数组（大跳那秒不入此数组，只计墙钟；可含重复，逐位 dedup 兜底）
 *   - wallDeltaSec: 本窗口墙钟增量合计（通常 = 窗口秒数）
 *   - contentDeltaSec: 本窗口节目时长域增量合计（按倍速；大跳秒计 0）
 * @returns 写后的 row（供 UI 广播 5% 步进/完成）
 */
export async function tickListenBatch(
  id,
  totalSec,
  { secs = [], wallDeltaSec = 0, contentDeltaSec = 0 } = {}
) {
  if (!id || !totalSec || totalSec <= 0) return null;
  let row;
  let newReal = 0; // 本窗口新置位(=新增真实听过秒)数，供 listenDaily 累加
  await db.transaction('rw', db.episodeListenStats, async () => {
    row = (await db.episodeListenStats.get(id)) || {
      id,
      totalSec,
      bits: new Uint8Array(Math.ceil((totalSec + 1) / 8)),
      listenedSec: 0,
      completed: false,
      totalPlayWallSec: 0,
      totalPlayContentSec: 0,
      updatedAt: Date.now(),
    };
    // 总时长可能从无到有，扩容 bits
    if (totalSec > row.totalSec) {
      const newLen = Math.ceil((totalSec + 1) / 8);
      if (newLen > row.bits.length) {
        const nb = new Uint8Array(newLen);
        nb.set(row.bits);
        row.bits = nb;
      }
      row.totalSec = totalSec;
    }
    // 批量置位（逐位 dedup：已置位的不重复计入 listenedSec）
    for (const sec of secs) {
      if (sec < 0 || sec >= row.totalSec) continue;
      const byteIdx = sec >> 3;
      const bitIdx = sec & 7;
      if (byteIdx >= row.bits.length) continue;
      const had = (row.bits[byteIdx] >> bitIdx) & 1;
      if (!had) {
        row.bits[byteIdx] |= 1 << bitIdx;
        row.listenedSec += 1;
        newReal += 1;
      }
    }
    row.totalPlayWallSec = (row.totalPlayWallSec || 0) + wallDeltaSec;
    row.totalPlayContentSec = (row.totalPlayContentSec || 0) + contentDeltaSec;
    if (row.totalSec > 0 && row.listenedSec >= row.totalSec - 5) {
      row.completed = true;
    }
    row.updatedAt = Date.now();
    await db.episodeListenStats.put(row);
  });
  // [B-37] 同步累加「按天×节目」聚合，供"最近 N 天"统计（episodeListenStats 只有累计值，无时间分布）。
  //   [审P2-10] 同样用 listenDaily 独立 rw 事务串行 get→改→put；保持独立 try/catch=daily 失败不影响主进度。
  try {
    const podcastId = String(id).split('::')[0];
    const dateStr = dayKey();
    const dkey = `${dateStr}::${podcastId}`;
    await db.transaction('rw', db.listenDaily, async () => {
      const drow = (await db.listenDaily.get(dkey)) || {
        key: dkey,
        date: dateStr,
        podcastId,
        wallSec: 0,
        contentSec: 0,
      };
      drow.wallSec += wallDeltaSec;
      drow.contentSec += contentDeltaSec;
      // [B-55] 真实听过秒（bit 新置位）的按天增量，供"最近 N 天"用真实时长统计（拖动水的不算）
      drow.listenedSec = (drow.listenedSec || 0) + newReal;
      await db.listenDaily.put(drow);
    });
  } catch (e) {
    // ignore（daily 统计失败不影响主进度）
  }
  return row;
}

// [B-37] 本地日期 key（YYYY-MM-DD，用本地时区，与用户"今天"一致）
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 清掉已听完标记 + bits（用户重听已听完的单集时调用）
 */
export async function resetEpisodeListening(id) {
  if (!id) return;
  const row = await db.episodeListenStats.get(id);
  if (!row) return;
  row.bits = new Uint8Array(row.bits.length);
  row.listenedSec = 0;
  row.completed = false;
  // 注意：totalPlayWallSec / totalPlayContentSec **保留**（累计的总收听时长不应清零）
  row.updatedAt = Date.now();
  await db.episodeListenStats.put(row);
}

/**
 * 单档播客累计统计：墙钟秒、内容秒、听完集数、订阅总集数。
 * 通过 episodes 表查 podcastId → bulkGet listenStats（不改 schema）
 */
export async function getPodcastListenSummary(podcastId) {
  const empty = {
    wallSec: 0,
    contentSec: 0,
    finishedCount: 0,
    totalCount: 0,
  };
  if (!podcastId) return empty;
  // [perf·数据层整档重复读] 原本整档 toArray episodes(每行含 description 重文本)只为拿 id 列表+集数。
  //   改为：① totalCount 用 index count(不反序列化行)；② 统计行用 episodeListenStats 主键前缀
  //   `${podcastId}::` 直接取该档"已听过"的统计行(feedUrl 不含 '::'，加 '::' 前缀安全；只读已听集，
  //   免读未听集与 episodes 大文本)。已订阅档 episodes 不会被单独删除→stats 行 ⊆ episodes，求和集合一致。
  const [totalCount, stats] = await Promise.all([
    db.episodes.where('podcastId').equals(podcastId).count(),
    db.episodeListenStats
      .where('id')
      .startsWith(podcastId + '::')
      .toArray(),
  ]);
  let wallSec = 0;
  let contentSec = 0;
  let finishedCount = 0;
  for (const s of stats) {
    if (!s) continue;
    wallSec += s.totalPlayWallSec || 0;
    contentSec += s.totalPlayContentSec || 0;
    if (s.completed) finishedCount += 1;
  }
  return { wallSec, contentSec, finishedCount, totalCount };
}

/**
 * 把秒数格式化成 "Xh Ym" / "Ym" / "Xs"
 */
export function formatListenDuration(sec) {
  sec = Math.floor(Number(sec) || 0);
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * 计算听过百分比（向下取整到 5% 步进；<5% 返回 0 表示"不显示"）
 */
export function listenedPercentStepped(row) {
  if (!row || !row.totalSec || row.totalSec <= 0) return 0;
  const pct = (row.listenedSec / row.totalSec) * 100;
  const stepped = Math.floor(pct / 5) * 5;
  return stepped;
}

// [B-37] 收听数据统计：按节目聚合收听时长 + join 节目元数据（标题/封面），降序。
//   range='all' → 全部累计；range=数字 → 用 listenDaily 最近 N 天。统一用 contentSec(倍速换算内容秒)口径。
//
// [修「周>全部」· 2026-06-15·终极] 根治"最近一周 > 全部"。
//   ① 旧 bug：「全部」读 `episodeListenStats.listenedSec`(bit-array 计数)，而 `resetEpisodeListening`
//      (重播已听完单集触发，Player.js)清零 bits/listenedSec **却不动 listenDaily** → 听完重听后
//      「全部」被清零重数、「周」仍含旧值 → 周>全部(实测有档周=2×全部)。
//   ② 改用永不 reset 的 contentSec 后仍有**残留**：`episodeListenStats`(全部)与 `listenDaily`(周)
//      是两张表分别写(各自 rw 事务)，审P2-10 之前的并发竞态让两表产生几秒漂移 → 偶发周比全部多 1~2 秒
//      (实测真实备份命中 1 档差 1 秒)。
//   ③ **终极正解**：「全部」= **max(Σ episodeListenStats.totalPlayContentSec, Σ listenDaily.contentSec 全天)**。
//      「周」是 listenDaily 的 7 天子集 ≤ listenDaily 全天 ≤ 全部 → **数学上保证 全部 ≥ 周**(与两表是否一致无关)；
//      取 max 还顺带用上两表里更完整的信号(stats 含 listenDaily 建表前的历史；listenDaily 兜住 stats 漂移)。
//      在用户真实备份上模拟：旧口径 2 档违例、纯 contentSec 1 档违例、**本方案 0 违例**。
//   口径含义=按倍速换算的"内容收听时长"(重听如实计入、大跳/拖动"水时长"记 0)；单次正常收听 ≈ 旧 listenedSec。
//   注：listenedSec/bits 仍各司其职(当前一遍进度/完成%：listenedPercentStepped/bumpListenTick)，只换统计聚合口径。
export async function getListenStatsByPodcast(range = 'all') {
  const byPod = {};
  if (range === 'all') {
    const [stats, daily] = await Promise.all([
      db.episodeListenStats.toArray(),
      db.listenDaily.toArray(),
    ]);
    const statsByPod = {};
    stats.forEach(s => {
      const sec = s.totalPlayContentSec || 0;
      if (sec <= 0) return;
      const pid = String(s.id).split('::')[0];
      statsByPod[pid] = (statsByPod[pid] || 0) + sec;
    });
    const dailyByPod = {};
    daily.forEach(r => {
      const sec = r.contentSec || 0;
      if (sec <= 0) return;
      dailyByPod[r.podcastId] = (dailyByPod[r.podcastId] || 0) + sec;
    });
    new Set([...Object.keys(statsByPod), ...Object.keys(dailyByPod)]).forEach(
      pid => {
        byPod[pid] = Math.max(statsByPod[pid] || 0, dailyByPod[pid] || 0);
      }
    );
  } else {
    const days = Number(range) || 7;
    const cutoff = dayKey(Date.now() - (days - 1) * 86400000);
    const rows = await db.listenDaily
      .where('date')
      .aboveOrEqual(cutoff)
      .toArray();
    rows.forEach(r => {
      const sec = r.contentSec || 0;
      if (sec <= 0) return;
      byPod[r.podcastId] = (byPod[r.podcastId] || 0) + sec;
    });
  }
  const pids = Object.keys(byPod);
  const pods = await db.podcasts.bulkGet(pids);
  // [B-55] 统计**所有听过的节目**（含已取消订阅——deletePodcast 软删保留 podcasts 记录，可 join 名字/封面）；
  //   节目累计真实收听 < 180s(3 分钟) 不显示（零碎/试听不计）；totalWall 与列表一致。
  const MIN_SEC = 180;
  const filtered = pids
    .map((pid, i) => ({ podcastId: pid, pod: pods[i], sec: byPod[pid] }))
    .filter(x => x.pod && x.sec >= MIN_SEC);
  const totalWall = filtered.reduce((s, x) => s + x.sec, 0);
  const list = filtered
    .map(x => ({
      podcastId: x.podcastId,
      title: x.pod.title || '',
      coverUrl: x.pod.coverUrl || '',
      wallSec: x.sec, // 字段名沿用 wallSec（statsPage 用），值=真实听过秒
    }))
    .sort((a, b) => b.wallSec - a.wallSec);
  return { totalWall, list };
}

// [B-63] 最近 N 天有真实收听的 podcastId 列表（供"为你推荐"按近期收听类型加权）
export async function getRecentListenedPodcastIds(days = 7) {
  try {
    const cutoff = dayKey(Date.now() - (days - 1) * 86400000);
    const rows = await db.listenDaily
      .where('date')
      .aboveOrEqual(cutoff)
      .toArray();
    const ids = new Set();
    rows.forEach(r => {
      if (r && (r.listenedSec || 0) > 0) ids.add(r.podcastId);
    });
    return [...ids];
  } catch (e) {
    return [];
  }
}
