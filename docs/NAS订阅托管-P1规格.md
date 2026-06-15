# PodPlayer NAS 订阅托管 · P1 实现规格书（智能回收 / 声明式对账）

> 状态：**待 P0 真机 ABS 实测通过后落地**。分支 `feature/nas-handoff`。设计源 `docs/NAS订阅托管方案.md` §4.8–§4.13。
> 本文是 P1（对账 / 取消删档 / 冷藏 / 多设备 / 首连差异）的可照写实现规格。凡依赖 P0 的 ABS 契约（POST/PATCH body 形态、folder 解析、`?hard=1` 参数、token 权限）处标 **〔对齐P0〕**——以 P0 本机实测结论为准，收敛到一个抽取函数 `ensureManaged()` 改一处即全对齐。
>
> **贯穿铁律**：无 NAS 全程降级、对账失败静默不抛、`src/electron/` 与 `src/utils/podcast/` 新增 NAS 代码禁可选链 `?.`/`??`（用 `&&` 守卫 + `|| 默认值`）、**所有破坏性操作走「feature-flag(默认关) + 宽限 + 多设备 scope(默认 local) + dry-run gating(默认关)」四闸**。

---

## 0. 现状基线（P1 站在哪些已落地件上，直接复用不重写）

| 件 | 位置 | P1 复用方式 |
|---|---|---|
| `authGet / authPost / authPatch` | `nasBridge.js` | 对账读 + 确保托管直接用 |
| `ensureItems(c)` → `{normFeed: itemId}` 全库映射(分页+TTL+在途去重) | `nasBridge.js` | 对账「ABS 实际有哪些档」唯一数据源 |
| `ensureEps(c,itemId)` → `{byGuid,byUrl}`(单集 ino 映射) | `nasBridge.js` | ⚠️只产 ino、**不含 episode.id**，冷藏删单集不能直接用(见 §5 注) |
| `getFirstFolder(c)` / `sanitizeName` | `nasBridge.js` | 确保托管「创建」分支 |
| `ready(c)` / `getCfg()` / `normFeed()` / `clearCache()` | `nasBridge.js` | 守卫 + 归一化 + 写后清缓存 |
| `nas:handoffSubscription`(幂等:有则 PATCH/无则 POST) | `nasBridge.js` | 内部逻辑抽 `ensureManaged()` 供对账复用 |
| `isNasEnabled()/ensureProbed()/nasAlive/markNasDown()` | `nasSource.js` | 对账「仅在线才跑」门禁 |
| `nasHandoffEnabled`(默认 true，`!==false` 判定) | `initLocalStorage.js`、`settings.vue` | P1 新开关照抄此 get/set 范式 |
| `getLastListenedByPodcast()` → `{podcastId: maxUpdatedAt}` | `db.js` | **冷藏「最后收听时间」唯一来源，已现成** |
| `getAllFavorites()` → 行含 `{id=episodeId, podcastId}` | `db.js` | 冷藏白名单(收藏单集永不删) |
| `getSubscribedPodcasts()`/`getAllPodcasts()` | `db.js` | 期望态派生的本地真相 |
| `deletePodcast(id)` = `update({subscribed:false})`(不删 episodes/统计) | `db.js` | 取消订阅 → 触发「移除」期望态 |
| `runLimited(items,limit,worker)` | `service.js`(**未导出**) | 对账限并发；**nasSource 须自带私有副本**(避免 service→nasSource 反向 import 成环) |
| 对账挂载点 | `main.js initNas()`、`nasSource.activateProfile/setNasEnabled` 末尾 `initNas()` | 启动/换档/启用后跑对账 |

---

## 1. 声明式对账（核心）

### 1.1 两态 → 三期望态（本地真相是唯一真相，对账把 ABS 逼近期望态）

| 本地 `subscribed` | 活跃度(`lastListened`) | 期望 NAS 态 | 动作 |
|---|---|---|---|
| `true`(`!==false`) | 近期(< 6 个月) | **托管** | ABS 没有→创建+autoDownload；有但 autoDownload 关→PATCH 开 |
| `true` | ≥ 6 个月没听 | **冷藏** | hard-delete 单集(留最近 1 集 + 所有收藏单集)+ PATCH autoDownload 关 |
| `false`(已取消、软删后仍在 podcasts 表) | — | **移除** | 记取消时间戳；7 天宽限到期→DELETE 整档(hard) |

三态互斥，一档同时只命中一条。
- **重订阅自愈**：`subscribeByRssUrl` put 回 `subscribed:true` → 下次对账自动回「托管」并撤销「移除」(清 `nasRemoveAt`)。
- **重听被冷藏的**：`getLastListenedByPodcast` 刷新 → 下次对账回「托管」、重开 autoDownload。

### 1.2 对账触发时机
| 时机 | 触发点 | 说明 |
|---|---|---|
| 启动就绪 | `main.js initNas()` 成功且 `nasAlive` 后 | 延迟到启动空闲(与 prunePreviewOrphans 同段)，不抢首屏 |
| 断线恢复 | `nasSource.probe()` 把 `nasAlive` false→true 那刻 | 全量对账，把断联期所有本地变化一次性同步 |
| 换档/启用 | `activateNasProfile`/`setNasEnabled(true)` 末尾 `initNas()` 后 | 复用「首次连接差异对账」(§4) |
| 每日 | 心跳(5min)内判「距上次对账 > 24h」 | 不另起 timer，搭车心跳；记 `nasLastReconcileAt` |
| 操作后即时 | 取消订阅 `deletePodcast` 后(只记时间戳，真删仍等对账宽限) | 订阅已由 handoff 覆盖 |

**断联跳过不丢**：对账首行 `ready(c)`/`isNasEnabled()+ensureProbed()` 门禁；断联期本地照常变(IndexedDB)，**不靠命令队列**，恢复后用「当前真相」重算 → 无积压丢失。

### 1.3 「取消订阅时间戳」存哪 → **Dexie `podcasts` 表加非索引字段 `nasRemoveAt`**
- 非索引字段可直接 `update` 写，**无需升 schema 版本**(同 `newCount`/`latestPubTime` 先例)。
- `deletePodcast` 时置 `Date.now()`；重订阅时清(`subscribeByRssUrl` 的 merged 加 `nasRemoveAt: null`)。
- 不用 electron-store：订阅真相在渲染端 IndexedDB，放主进程会割裂且无法随软删原子更新。
- 冷藏「最后收听时间」**不需新存**：`getLastListenedByPodcast()` 已现成。
- 可选 `nasColdAt`(上次冷藏时间，幂等防抖，非必须)。

### 1.4 对账分层（渲染端薄壳编排 + 主进程单档执行）
- **渲染端 `nasSource.js` 新增 `reconcileNas()`**(导出)：门禁 → 取本地真相(订阅档/`getLastListenedByPodcast`/`getAllFavorites`) → 派生每档期望态 → 按动作分类分别 invoke。**所有 IndexedDB 读在渲染端**(主进程无 Dexie)。
- **主进程 `nasBridge.js` 新增 IPC**：`nas:ensureManaged`(确保托管，幂等)、`nas:coldStore`(冷藏)、`nas:removeItem`(移除整档)。每个头部 `if(!ready(c)) return {skipped}`、全包 try/catch、绝不抛。
- 不新建模块(避免 import 网扩散)。

### 1.5 对账主循环伪代码（渲染端 `nasSource.js`）
```js
// [NAS 托管·P1] 声明式对账：本地真相 → 期望态 → 把 ABS 逼近。门禁未过直接 return(降级、不报错)。失败静默。
const SIX_MONTHS_MS = 182 * 24 * 60 * 60 * 1000;
const GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 取消订阅 7 天宽限

export async function reconcileNas(opts) {
  opts = opts || {};
  if (!isNasEnabled()) return { skipped: 'no-nas' };
  const alive = await ensureProbed();
  if (!alive) return { skipped: 'nas-down' };

  let pods, lastMap, favs;
  try {
    pods = await getAllPodcasts();              // 含 subscribed:false(移除候选)
    lastMap = await getLastListenedByPodcast(); // {podcastId: maxUpdatedAt}
    favs = await getAllFavorites();
  } catch (e) { return { error: 'db' }; }

  const favByPod = {};
  favs.forEach(f => { if (f && f.podcastId) (favByPod[f.podcastId] = favByPod[f.podcastId] || []).push(f.id); });

  const scope = nasDeviceScope();   // 'local' | 'shared'，默认 'local'
  const coldOn = nasColdStoreOn();  // 冷藏 flag，默认关
  const removeOn = nasRemoveOn();   // 取消删档 flag，默认关
  const now = Date.now();

  const ensure = [], cold = [], remove = [];
  for (const p of pods) {
    if (!p || !p.id) continue;
    const subscribed = p.subscribed !== false;
    if (!subscribed) {
      if (!p.nasRemoveAt) continue;                 // 没时间戳(老数据/从未托管)→不动(安全)
      if (now - p.nasRemoveAt < GRACE_MS) continue; // 宽限期内→跳过(期间重订阅自愈)
      remove.push({ feedUrl: p.id });
      continue;
    }
    const last = lastMap[p.id] || 0;
    const inactive = last > 0 && (now - last) >= SIX_MONTHS_MS;
    if (coldOn && inactive) cold.push({ feedUrl: p.id, keepFavGuids: favByPod[p.id] || [] });
    else ensure.push({ feedUrl: p.id, title: p.title || '' });
  }

  // 先非破坏性(确保托管)
  await runLimited(ensure, 3, async it => { try { await ipcRenderer.invoke('nas:ensureManaged', it); } catch (e) {} });

  // 再破坏性(仅 scope==='local')
  if (scope === 'local') {
    if (coldOn) await runLimited(cold, 2, async it => { try { await ipcRenderer.invoke('nas:coldStore', it); } catch (e) {} });
    if (removeOn) await runLimited(remove, 2, async it => {
      const r = await ipcRenderer.invoke('nas:removeItem', it).catch(() => null);
      if (r && r.ok) { try { await updatePodcast(it.feedUrl, { nasRemoveAt: null }); } catch (e) {} }
    });
  }
  try { window.localStorage.setItem('nasLastReconcileAt', String(now)); } catch (e) {}
  return { ok: true, ensured: ensure.length, cold: cold.length, removed: remove.length, scope };
}
```
> `runLimited` 在 service.js 未导出且 service→nasSource 单向依赖 → **nasSource 内置一份私有 `runLimited`**(10 行)，勿反向 import service。

### 1.6 复用收口
- **「确保托管」= P0 handoff 内部逻辑**：把 nasBridge 的 ensureItems 查 existingId→有则 PATCH/无则 getFirstFolder+POST 那段**抽成 `async function ensureManaged(c, feedUrl, title)`**，`nas:handoffSubscription` 与 `nas:ensureManaged` 都调它 → 零重复、契约一处改全对齐。
- 冷藏/移除前先 `ensureItems` 查 itemId，查不到=ABS 本就没有→跳过(幂等)。写后 `clearCache()`。

---

## 2. 取消订阅删整档（破坏性·最高危）

ABS：`DELETE /api/items/{id}?hard=1` 〔对齐P0：hard 参数名/位置以实测为准〕。

### 2.1 完整守卫链（缺一不删）—— 主进程 `nas:removeItem`
```js
ipcMain.handle('nas:removeItem', async (_e, args) => {
  const c = getCfg();
  if (!ready(c)) return { skipped: 'no-nas' };                               // ① NAS 未就绪
  const a = args || {};
  const feedUrl = String(a.feedUrl || '');
  if (!feedUrl) return { error: 'no-feedurl' };
  if (store.get('nasRemoveEnabled') !== true) return { skipped: 'flag-off' };// ② feature flag(默认关)
  if (store.get('nasDeviceScope') === 'shared') return { skipped: 'shared' };// ③ 多设备:共享不删 NAS
  const armed = store.get('nasDestructiveArmed') === true;                   // ④ 放量闸(默认关)→dry-run
  try {
    const items = await ensureItems(c);
    const itemId = items[normFeed(feedUrl)] || '';
    if (!itemId) return { skipped: 'not-on-nas' };                          // ⑤ ABS 本就没有(幂等)
    if (!armed) { console.log('[nas-remove·dry-run]', feedUrl, itemId); return { ok: true, dryRun: true }; }
    await authDelete(c, '/api/items/' + itemId + '?hard=1');                // 〔对齐P0〕
    clearCache();
    return { ok: true, removed: true, itemId };
  } catch (e) { return { error: String((e && e.message) || e) }; }          // ⑥ 失败静默不抛
});
```
> 渲染端上游另有一层：`removeOn` + `scope==='local'` + **7 天宽限**(`now-nasRemoveAt>=GRACE_MS`)。宽限在渲染端判(拿得到时间戳)，flag/scope/gating 主进程兜底再判(双重，防绕过)。

### 2.2 四闸细节
1. **7 天宽限**：`deletePodcast` 写 `nasRemoveAt=Date.now()`；对账只对到期档进 remove 桶；宽限内重订阅清 `nasRemoveAt:null` → 自动撤销删除。
2. **feature flag `nasRemoveEnabled`**：**默认 `false`**(与「托管=加」的 `nasHandoffEnabled:true` 刻意分开)；主进程 electron-store 也存一份(渲染端 setConfig 透传)，主进程独立判。
3. **多设备 `scope==='local'`** 才删(见 §3)。
4. **dry-run gating `nasDestructiveArmed`**：**默认 `false`** → 所有破坏性 IPC 走 dry-run(只 `console.log`、返回 `{dryRun:true}`、**绝不发 DELETE**)。本机 ABS 实测确认(token admin 权限 / `?hard=1` 真删盘且无副作用 / 删的是对的档)后手动置 true 放量。覆盖 `nas:removeItem` 与 `nas:coldStore`。

---

## 3. 多设备（§4.13）

- setting key `nasDeviceScope` ∈ `'local'|'shared'`，**默认 `'local'`**(保守:本机是唯一管理者；但破坏性总闸默认全关，故 local 也不会误删)。
- 渲染端读 localStorage `settings.nasDeviceScope`；主进程读 electron-store(setConfig 透传)。

| 场景 | `local`(仅本机) | `shared`(多设备共享) |
|---|---|---|
| 取消订阅 | 软删本地 + 宽限到期 hard-delete NAS 整档 | 软删本地，**NAS 不删** |
| 6 个月没听冷藏 | hard-delete NAS 单集(留最近1+收藏)+关 autoDownload | **不冷藏 NAS** |
| 确保托管(非破坏) | 照常 | **照常**(幂等无害) |
| NAS 有我无 | 默认不动 + 可选提示导入 | 同左 |

> `shared` 下对账只跑「确保托管」桶，跳过冷藏/移除。

**settings.vue**(仿 `nas-handoff-enable` 结构)在托管开关下加：① 多设备模式(select：仅本机/共享，computed `nasDeviceScope`)；② 取消订阅同步删 NAS(toggle `nasRemoveEnabled`，默认关，红字「破坏性，7 天后生效，期间重订阅撤销」)；③ 长期不听自动清理 NAS(toggle `nasColdStoreEnabled`，默认关)。新 key 补进 `initLocalStorage`：`nasDeviceScope:'local'`/`nasRemoveEnabled:false`/`nasColdStoreEnabled:false`。

---

## 4. 首次连接 / 新机接入差异对账（§4.12）

挂载点：`activateNasProfile`/`setNasEnabled(true)` 末尾 → `reconcileNas({firstConnect:true})`。

| 差异 | 实现 |
|---|---|
| 我订阅 ∩ NAS 有 | 「确保托管」桶 → ensureManaged 命中 itemId → PATCH 确保 autoDownload(P0 已实现) |
| 我订阅 − NAS 没有 | 「确保托管」桶 → itemId 空 → POST 创建(P0 已实现) |
| NAS 有 − 我没订阅 | **对账天然不碰**：reconcile 只遍历 `getAllPodcasts()`(本地真相)，NAS 上我没有的不在循环里 → 声明式自然结论，无需特判 |

可选「导入未订阅」提示(独立、可关、不受 gating)：`suggestImportFromNas()` = `nas:podcastSet`(已有) − 本地 normFeed 集 → 非空且 `nasImportPromptEnabled!==false` → 弹一次「发现 NAS 有 N 档未订阅，是否导入?」→ 确认才逐个 `subscribeByRssUrl`。一次性(记 `nasImportPromptedFor[activeProfileId]`)。key `nasImportPromptEnabled` 默认 `true`(纯加无破坏)。

---

## 5. 新增 ABS 调用清单

| 用途 | endpoint/方法 | body/query | 权限 | helper | gating |
|---|---|---|---|---|---|
| 确保托管·PATCH | `PATCH /api/items/{id}/media` | `{autoDownloadEpisodes,maxNewEpisodesToDownload,maxEpisodesToKeep}`〔对齐P0〕 | update | 复用 `authPatch` | 非破坏 |
| 确保托管·创建 | `POST /api/podcasts` | P0 body〔对齐P0〕 | admin | 复用 `authPost`+`getFirstFolder` | 非破坏 |
| 确保托管·查库 | `GET /api/libraries/{id}/items`(分页) | limit/page | read | 复用 `ensureItems` | — |
| 冷藏·关追新 | `PATCH /api/items/{id}/media` | `{autoDownloadEpisodes:false}` | update | 复用 `authPatch` | **实测后放量** |
| 冷藏·列单集 | `GET /api/items/{id}?expanded=1` | — | read | 见⚠️注 | — |
| 冷藏·删单集 | `DELETE /api/podcasts/{id}/episode/{epId}?hard=1`〔对齐P0〕 | ?hard=1 | admin | **新增 `authDelete`** | **实测后放量·dry-run 优先** |
| 移除·删整档 | `DELETE /api/items/{id}?hard=1`〔对齐P0〕 | ?hard=1 | admin | **新增 `authDelete`** | **实测后放量·dry-run 优先** |
| 导入提示·NAS 全集 | `GET /api/libraries/{id}/items` | — | read | 复用 `ensureItems`/`nas:podcastSet` | 非破坏 |

**唯一需新增主进程 helper `authDelete(c,path)`**(照 authPost 形态，禁 `?.`)：
```js
function authDelete(c, path) {
  return axios.delete(c.baseUrl + path, {
    timeout: API_TIMEOUT,
    headers: { Authorization: 'Bearer ' + c.token, 'User-Agent': UA, Accept: 'application/json' },
    validateStatus: s => s >= 200 && s < 300,
  });
}
```
> ⚠️注 **冷藏删单集要 ABS `episode.id`(主键)，而 P0 的 `ensureEps` 只产 `ino`(播放用)**——这是最容易踩的坑。冷藏函数内**独立** `GET /api/items/{id}?expanded=1` 取 `media.episodes[].{id,guid,publishedAt}`，**别动 ensureEps 现有播放解析路径**。

**冷藏 `nas:coldStore`**(破坏性，gating+dry-run)：① ensureItems 查 itemId(空→skip)；② expanded=1 取 episodes 按 publishedAt 倒序；③ 保留 = 最近 1 集 ∪ {guid∈keepFavGuids}；④ 其余 `authDelete(.../episode/{ep.id}?hard=1)`(dry-run 则只 log)；⑤ `authPatch media {autoDownloadEpisodes:false}`(根除白删又重下)。全程 try/catch、单集失败不阻断、返回 `{ok,deleted,kept}`/`{skipped}`/`{error}`。收藏白名单 `keepFavGuids` 是 `feedUrl::guid` 形态，比对前 split 出 guid 段(同 `splitTrack` 口径)。

---

## 6. 落地顺序 + 风险（先非破坏性 → 再破坏性，每步可独立验收/回退）

| 步 | 内容 | 风险 | gating/缓解 |
|---|---|---|---|
| **P1-a** | 抽 `ensureManaged()`；新 IPC `nas:ensureManaged`；`reconcileNas` 只跑「确保托管」桶(cold/remove 空跑)；挂 initNas/断线恢复/换档。 | 重复 PATCH/POST、限流不足灌爆 ABS | `runLimited(…,3)`；幂等；非破坏最坏=多开 autoDownload 无损。〔对齐P0 body〕 |
| **P1-b** | 加 `nasRemoveAt`(deletePodcast 写/subscribeByRssUrl 清)；reconcile 填 remove 桶但**只 dry-run log**；新增 `authDelete`。 | 时间戳错/重订阅没清→误进 remove 桶 | remove 桶此阶段全 dry-run，先核对日志「该删的对不对」 |
| **P1-c** | 设置页加 3 开关 + initLocalStorage 默认值 + setConfig 透传破坏性 flag 到 electron-store。 | 开关默认值错→意外放量 | 默认 local/false/false；主进程独立再判 |
| **P1-d**(本机实测放量) | 实测两个 DELETE + token admin 权限 → 置 `nasDestructiveArmed=true`、开 `nasRemoveEnabled`；**移除整档先放量**(语义简单)。 | hard delete 不可逆、删错档 | dry-run 先验日志；scope=local+7 天宽限；先测试库/单档手验 |
| **P1-e** | 冷藏 `nas:coldStore`(逐集删+关 autoDownload)；冷藏独立取 episodes；开 `nasColdStoreEnabled`。 | 最复杂:误删未听/收藏；删后没关 autoDownload→白删重下 | 收藏白名单+留最近1+删后必关 autoDownload；dry-run 先验；6 个月阈值极保守 |
| **P1-f** | 首连「导入未订阅」可选提示(一次性)。 | 多用途 NAS 误导入 | 纯加、需确认、可关、同档不复弹 |

---

## 关键提醒
1. **`runLimited` 循环依赖**：对账编排在 nasSource，**自带私有 `runLimited`**，勿反向 import service。
2. **`ensureManaged` 是 P1 契约收口点**：P0 实测确定的 POST/PATCH body 只此一处，对账与 handoff 共用 → 实测改一处即全对齐。所有 〔对齐P0〕 收敛于此。
3. **冷藏删单集要 `episode.id` 不是 `ino`** —— ensureEps 现有产物不含 id，冷藏独立取 expanded=1。最容易踩。
4. **dry-run 是 P1 核心安全阀**：`nasDestructiveArmed` 默认 false 让 P1-a~c 全程「只读+确保托管」零风险落地，删除代码先就位不放量，等 P1-d 本机实测过再 arm。
