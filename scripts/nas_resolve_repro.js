/* NAS 音源三级解析链 + 熔断器 回归测试（fake IPC，零依赖）
 * 复刻 Player._getAudioSource 注入逻辑 + nasSource 熔断语义，断言：
 *   ① 本地命中最高优先级，NAS 不被触碰；
 *   ② 三级 fallback 次序 本地 → NAS → CDN；
 *   ③ 未启用 / 掉线(nasAlive=false) → 不发 nas:resolve IPC、零等待直落 CDN（低耦合铁律）；
 *   ④ splitTrack 从 podcastEpisodeId 正确拆出 guid（含 guid 内含 :: 的情况）。
 * 与 src/utils/podcast/nasSource.js + Player._getAudioSource ②级注入逻辑对齐。
 */

// ---- 复刻 nasSource.splitTrack（与源文件一字对齐） ----
function splitTrack(track) {
  const podcastId = track.podcastId || '';
  const epId = String(track.podcastEpisodeId || '');
  let guid = '';
  if (podcastId && epId.indexOf(podcastId + '::') === 0) {
    guid = epId.slice(podcastId.length + 2);
  } else {
    const i = epId.indexOf('::');
    guid = i >= 0 ? epId.slice(i + 2) : '';
  }
  return { podcastId: podcastId || epId.split('::')[0], guid };
}

// ---- 复刻 nasSource.resolveNasUrl 的熔断语义（fake：用 nas 状态对象 + 计数 IPC） ----
async function resolveNasUrl(track, nas) {
  if (!nas.enabled || !track || !track.podcastEpisodeId) return null;
  // ensureProbed：>30s 才重探；这里直接用 nas.alive（探测本身不发 resolve IPC）
  const alive = nas.alive;
  if (!alive) return null; // ← 掉线/未启用：同步 null，绝不发 resolve IPC（零等待直落 CDN）
  const { podcastId, guid } = splitTrack(track);
  if (!podcastId) return null;
  nas.resolveCalls += 1; // 记一次 nas:resolve IPC
  const ino = guid ? nas.byGuid[guid] : null;
  const url = ino ? `${nas.baseUrl}/api/items/${nas.itemId}/file/${ino}?token=T` : null;
  return url || null;
}

// ---- 复刻 Player._getAudioSource 播客分支（①pathMap → ②NAS → ③CDN） ----
async function getAudioSource(track, pathMap, nas) {
  if (track && track.podcastAudioUrl) {
    if (track.podcastEpisodeId) {
      const fp = pathMap[track.podcastEpisodeId];
      if (fp) return 'file:///' + String(fp).replace(/\\/g, '/').replace(/^\/+/, ''); // ①
      try {
        const nasUrl = await resolveNasUrl(track, nas); // ②
        if (nasUrl) return nasUrl;
      } catch (e) {
        /* 落 CDN */
      }
    }
    return track.podcastAudioUrl; // ③
  }
  return null;
}

function freshNas(over) {
  return Object.assign(
    { enabled: false, alive: false, byGuid: {}, itemId: 'IT1', baseUrl: 'http://nas', resolveCalls: 0 },
    over || {}
  );
}

const TRACK = {
  podcastEpisodeId: 'http://x.com/feed::guid123',
  podcastId: 'http://x.com/feed',
  podcastAudioUrl: 'https://cdn.example/ep.mp3',
};

(async () => {
  let pass = 0;
  let total = 0;
  function ok(name, cond) {
    total++;
    if (cond) pass++;
    console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name);
  }

  // 1. 本地命中 → file://，NAS 不被触碰
  let nas = freshNas({ enabled: true, alive: true, byGuid: { guid123: 999 } });
  let r = await getAudioSource(TRACK, { 'http://x.com/feed::guid123': 'D:\\dl\\ep.mp3' }, nas);
  ok('① 本地命中→file:// 且不触碰 NAS', /^file:\/\/\//.test(r) && nas.resolveCalls === 0);

  // 2. 无本地 + NAS 未启用 → CDN，零 IPC
  nas = freshNas({ enabled: false, alive: false });
  r = await getAudioSource(TRACK, {}, nas);
  ok('② 无本地+NAS未启用→CDN，0 次 resolve IPC', r === TRACK.podcastAudioUrl && nas.resolveCalls === 0);

  // 3. 无本地 + NAS 在线 + 命中 → NAS URL
  nas = freshNas({ enabled: true, alive: true, byGuid: { guid123: 141798 } });
  r = await getAudioSource(TRACK, {}, nas);
  ok('③ 无本地+NAS命中→NAS流URL', r === 'http://nas/api/items/IT1/file/141798?token=T' && nas.resolveCalls === 1);

  // 4. 无本地 + NAS 在线 + 查不到 → CDN
  nas = freshNas({ enabled: true, alive: true, byGuid: {} });
  r = await getAudioSource(TRACK, {}, nas);
  ok('④ 无本地+NAS查不到→CDN兜底', r === TRACK.podcastAudioUrl);

  // 5. 无本地 + NAS 启用但掉线 → CDN，且不发 resolve IPC（零等待短路，低耦合铁律）
  nas = freshNas({ enabled: true, alive: false, byGuid: { guid123: 141798 } });
  r = await getAudioSource(TRACK, {}, nas);
  ok('⑤ NAS掉线→直落CDN且0次resolve IPC(零等待)', r === TRACK.podcastAudioUrl && nas.resolveCalls === 0);

  // 6. splitTrack 基本拆分
  let s = splitTrack({ podcastId: 'http://x.com/feed', podcastEpisodeId: 'http://x.com/feed::guid123' });
  ok('⑥ splitTrack 拆出 guid123', s.guid === 'guid123' && s.podcastId === 'http://x.com/feed');

  // 7. guid 内含 :: 也正确（按 podcastId 前缀切，而非首个 ::）
  s = splitTrack({ podcastId: 'feed', podcastEpisodeId: 'feed::a::b' });
  ok('⑦ guid 含 :: 正确(=a::b)', s.guid === 'a::b');

  // 8. 非播客 track（无 podcastAudioUrl）→ getAudioSource 走原链（这里返回 null 占位，证明不进 NAS）
  nas = freshNas({ enabled: true, alive: true, byGuid: { guid123: 1 } });
  r = await getAudioSource({ id: 123 }, {}, nas);
  ok('⑧ 非播客 track 不触碰 NAS', r === null && nas.resolveCalls === 0);

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
})();
