#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ABS watchdog —— 自包含单文件版（飞牛 NAS），零第三方依赖，仅 Python 标准库。

功能：
  ① 下载卡死兜底：currentDownload 存活超 STALL_MINUTES 分钟未完成 → 走 docker.sock
     重启 ABS 容器 → 等 healthcheck 恢复 → 全档 PATCH(autoDownload)+checknew 重新入队
     (已下集自动跳过、幂等)。每日重启上限 MAX_RESTARTS_PER_DAY 防风暴。
  ② 总存储监测/驱逐：总占用超 STORAGE_CAP_GB → 按发布时间删全局最老的集到
     STORAGE_TARGET_GB；只删集不删节目，每档至少留 KEEP_MIN_PER_PODCAST 集。
     EVICT_ENABLED=0 时只监测告警不删。删走 DELETE /api/podcasts/{id}/episode/{id}
     (与 maxEpisodesToKeep 同机制、真释放磁盘)。

⚠️ 单一真相同步约定（重要）：
  本文件【下方 body】= docs/docker-compose.watchdog.yml 内嵌 base64 的**逐字节精确解码**，
  二者必须一致。compose 是实际部署/运行的载体；本 .py 是它的**可读副本 + 备选直跑入口**。
  改逻辑时：改完后重新 base64 编码塞回 compose 的 command，或反过来——保持两边同步。
  (本文件由脚本从 compose 解码生成，勿手改单边；旧的 mode-B state/log/token-file 版已被本容器版取代。)

部署（飞牛桌面 → Docker → Compose → 新增项目，粘 docker-compose.watchdog.yml 全文，
  只改 ABS_TOKEN=你的 downL token）。也可直接 `INTERVAL_SECONDS=0 ABS_TOKEN=xxx python3 abs-watchdog.py` 跑单次。

环境变量（默认值见下方 E(...)）：
  ABS_BASE / LIBRARY_ID / ABS_CONTAINER / DOCKER_SOCK / ABS_TOKEN
  STALL_MINUTES=30  INTERVAL_SECONDS=1200(>0 循环常驻; 0 跑一次即退)  MAX_RESTARTS_PER_DAY=4
  KEEP_PER_PODCAST=100  STORAGE_CAP_GB=500  STORAGE_TARGET_GB=480  KEEP_MIN_PER_PODCAST=10  EVICT_ENABLED=1

安全：token 只放 compose/环境变量，别外发、别提交 git。挂 docker.sock = 该容器有宿主
  Docker 控制权（仅用于重启 ABS），个人自用 NAS 可接受。
"""

import os,sys,json,time,socket,http.client,urllib.request
from datetime import datetime
def E(k,d):
    v=os.environ.get(k)
    return v if v else d
ABS=E("ABS_BASE","http://127.0.0.1:13378/audiobookshelf")
LIB=E("LIBRARY_ID","c4379a59-72a4-4b8f-8f89-5170602f8469")
CON=E("ABS_CONTAINER","audiobookshelf-audiobookshelf-1")
SOCK=E("DOCKER_SOCK","/var/run/docker.sock")
TOK=E("ABS_TOKEN","")
STALL=float(E("STALL_MINUTES","30"))
ITV=int(E("INTERVAL_SECONDS","1200"))
MAXR=int(E("MAX_RESTARTS_PER_DAY","4"))
KEEP=int(E("KEEP_PER_PODCAST","100"))
CAP=float(E("STORAGE_CAP_GB","500"))
TGT=float(E("STORAGE_TARGET_GB","480"))
FLOOR=int(E("KEEP_MIN_PER_PODCAST","10"))
EVICT=E("EVICT_ENABLED","1")=="1"
GB=1073741824.0
RC={}
def log(m):
    print("[%s] %s"%(datetime.now().strftime("%Y-%m-%d %H:%M:%S"),m),flush=True)
def api(p,method="GET",body=None,t=30):
    d=json.dumps(body).encode() if body is not None else None
    r=urllib.request.Request(ABS+p,data=d,method=method)
    r.add_header("Authorization","Bearer "+TOK)
    if d is not None:
        r.add_header("Content-Type","application/json")
    x=urllib.request.urlopen(r,timeout=t)
    raw=x.read().decode("utf-8","replace")
    try:
        return x.status,json.loads(raw)
    except Exception:
        return x.status,raw
def drestart(name):
    class U(http.client.HTTPConnection):
        def connect(self):
            s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            s.settimeout(120);s.connect(SOCK);self.sock=s
    c=U("localhost",timeout=120)
    c.request("POST","/v1.41/containers/%s/restart?t=10"%name)
    r=c.getresponse();r.read();c.close()
    return r.status
def healthy(mx=180):
    w=0
    while w<mx:
        time.sleep(5);w+=5
        try:
            if urllib.request.urlopen(ABS+"/healthcheck",timeout=5).status==200:
                return w
        except Exception:
            pass
    return None
def requeue():
    try:
        _,it=api("/api/libraries/%s/items?limit=300"%LIB)
        arr=(it.get("results") or it.get("items") or []) if isinstance(it,dict) else []
    except Exception as e:
        log("list fail %s"%e);return 0
    n=0
    for x in arr:
        i=x.get("id")
        if not i:continue
        try:
            api("/api/items/%s/media"%i,"PATCH",{"lastEpisodeCheck":1,"autoDownloadEpisodes":True,"maxEpisodesToKeep":KEEP})
            api("/api/podcasts/%s/checknew?limit=%d"%(i,KEEP))
            n+=1;time.sleep(0.5)
        except Exception as e:
            log("requeue fail %s"%e)
    return n
def check_download():
    if not TOK:
        log("missing ABS_TOKEN env");return
    try:
        _,dl=api("/api/libraries/%s/episode-downloads"%LIB)
    except Exception as e:
        log("query fail (ABS starting?) %s"%e);return
    cur=dl.get("currentDownload") if isinstance(dl,dict) else None
    q=len(dl.get("queue",[])) if isinstance(dl,dict) else 0
    if not cur:
        log("OK no current download, queue=%d"%q);return
    age=(time.time()*1000-cur.get("createdAt",time.time()*1000))/60000.0
    pod=cur.get("podcastTitle","?");tit=cur.get("episodeDisplayTitle","?")
    if age<STALL:
        log("OK downloading [%s/%s] %.0fmin queue=%d"%(pod,tit,age,q));return
    log("STALL detected [%s/%s] %.0fmin, queue=%d blocked"%(pod,tit,age,q))
    today=datetime.now().strftime("%Y-%m-%d")
    if RC.get(today,0)>=MAXR:
        log("daily restart cap %d reached, stop & wait human"%MAXR);return
    log("restarting container %s ..."%CON)
    try:
        st=drestart(CON)
        if st not in (204,304):
            log("restart bad status %s (check name/docker.sock)"%st);return
    except Exception as e:
        log("restart failed (docker.sock mounted?) %s"%e);return
    RC[today]=RC.get(today,0)+1
    w=healthy()
    if w is None:
        log("wait ABS healthy timeout, retry next round");return
    log("ABS back (%ds), requeue..."%w);time.sleep(5)
    n=requeue()
    log("done: requeued %d podcasts, restarts today=%d"%(n,RC[today]))
def check_storage():
    if not TOK:return
    try:
        _,it=api("/api/libraries/%s/items?limit=300"%LIB)
    except Exception as e:
        log("storage query fail %s"%e);return
    arr=(it.get("results") or it.get("items") or []) if isinstance(it,dict) else []
    total=sum((x.get("size") or 0) for x in arr)
    tg=total/GB
    log("storage: %.1fGB / cap %.0fGB (%d podcasts)"%(tg,CAP,len(arr)))
    if tg<=CAP:return
    if not EVICT:
        log("OVER CAP but EVICT_ENABLED=0, monitor-only");return
    log("OVER CAP %.1f>%.0f, evicting oldest episodes down to %.0fGB ..."%(tg,CAP,TGT))
    eps=[];cnt={}
    for x in arr:
        iid=x.get("id")
        if not iid:continue
        try:
            _,j=api("/api/items/%s?expanded=1"%iid)
        except Exception:
            continue
        es=(j.get("media",{}) or {}).get("episodes",[]) if isinstance(j,dict) else []
        cnt[iid]=len(es)
        for e in es:
            eps.append((e.get("publishedAt") or e.get("addedAt") or 0,iid,e.get("id"),(e.get("size") or 0)))
    eps.sort(key=lambda r:r[0])
    tb=TGT*GB;freed=0;dl=0
    for pub,iid,epid,sz in eps:
        if (total-freed)<=tb:break
        if cnt.get(iid,0)<=FLOOR:continue
        if not epid:continue
        try:
            api("/api/podcasts/%s/episode/%s"%(iid,epid),"DELETE")
            freed+=sz;dl+=1;cnt[iid]-=1;time.sleep(0.3)
        except Exception as e:
            log("evict del fail %s"%e)
    log("evicted %d episodes, ~%.1fGB freed (floor=%d/podcast, shows kept)"%(dl,freed/GB,FLOOR))
log("watchdog up: every %ds, ABS=%s container=%s stall=%.0fmin cap=%.0fGB evict=%s"%(ITV,ABS,CON,STALL,CAP,EVICT))
while True:
    try:
        check_download()
    except Exception as e:
        log("download round error %s"%e)
    try:
        check_storage()
    except Exception as e:
        log("storage round error %s"%e)
    if ITV<=0:break
    time.sleep(ITV)
