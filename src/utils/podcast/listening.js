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
 * 单秒标记 + 累计墙钟/内容秒。
 * @param {string} id           episode.id
 * @param {number} sec          当前秒位置（howler.seek() 取整）
 * @param {number} totalSec     单集总时长（秒）
 * @param {object} opts
 *   - recordBit: 是否对 bit 置位（大跳时 false，只累墙钟）
 *   - wallDeltaSec: 本次墙钟增量（通常 = 1）
 *   - contentDeltaSec: 本次节目时长域增量（通常 = rate）
 */
export async function tickListen(
  id,
  sec,
  totalSec,
  { recordBit = true, wallDeltaSec = 1, contentDeltaSec = 1 } = {}
) {
  if (!id || !totalSec || totalSec <= 0) return null;
  let row;
  let newRealSec = false; // [B-55] 本次是否新增了"真实听过的一秒"(bit 首次置位)
  // [审P2-10] 把 episodeListenStats 的 get→改→put 包进 Dexie rw 事务：每秒 fire-and-forget 的 tick
  //   在 seek/倍速快触发、或写入较慢时会并发重叠，原裸 R-M-W 会"后写覆盖前写"丢更新(少计统计)。
  //   同表 rw 事务会自动串行 → 后一笔读到的是前一笔已提交的值，杜绝丢更新。行为不变、只是计数不再丢。
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
    if (recordBit && sec >= 0 && sec < totalSec) {
      const byteIdx = sec >> 3;
      const bitIdx = sec & 7;
      if (byteIdx < row.bits.length) {
        const had = (row.bits[byteIdx] >> bitIdx) & 1;
        if (!had) {
          row.bits[byteIdx] |= 1 << bitIdx;
          row.listenedSec += 1;
          newRealSec = true;
        }
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
      drow.listenedSec = (drow.listenedSec || 0) + (newRealSec ? 1 : 0);
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
  const eps = await db.episodes.where('podcastId').equals(podcastId).toArray();
  if (!eps.length) return empty;
  const ids = eps.map(e => e.id);
  const stats = await db.episodeListenStats.bulkGet(ids);
  let wallSec = 0;
  let contentSec = 0;
  let finishedCount = 0;
  for (const s of stats) {
    if (!s) continue;
    wallSec += s.totalPlayWallSec || 0;
    contentSec += s.totalPlayContentSec || 0;
    if (s.completed) finishedCount += 1;
  }
  return { wallSec, contentSec, finishedCount, totalCount: ids.length };
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

// [B-37] 收听数据统计：按节目聚合墙钟时长 + join 节目元数据（标题/封面），降序。
//   range='all' → 用 episodeListenStats 累计值（含历史）；range=数字 → 用 listenDaily 最近 N 天。
export async function getListenStatsByPodcast(range = 'all') {
  const byPod = {};
  if (range === 'all') {
    const all = await db.episodeListenStats.toArray();
    all.forEach(s => {
      // [B-55] 真实听过秒（bit-array 去重，大跳/拖动"水时长"不计），而非墙钟
      const sec = s.listenedSec || 0;
      if (sec <= 0) return;
      const pid = String(s.id).split('::')[0];
      byPod[pid] = (byPod[pid] || 0) + sec;
    });
  } else {
    const days = Number(range) || 7;
    const cutoff = dayKey(Date.now() - (days - 1) * 86400000);
    const rows = await db.listenDaily
      .where('date')
      .aboveOrEqual(cutoff)
      .toArray();
    rows.forEach(r => {
      // [B-55] 同样用真实听过秒（B-55 起 listenDaily 记 listenedSec；更早的旧数据无此字段→0）
      const sec = r.listenedSec || 0;
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
