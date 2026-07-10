# PodPlayer 0.5.0

0.5.0 加入完整的单集转文字稿链路，并把 SenseVoiceSmall 模型部署收口为普通用户可操作、可校验、可恢复的一键流程。本版本的本地 ASR 发布验证范围为 Windows x64。

## 新增与改进

- 本地 SenseVoiceSmall 转写：单任务队列、进度、取消、续转、删除和 TXT / SRT 导出。
- 文稿面板：原文 / 本地规则优化 / 可选 AI 精修三层，支持词典、拼音归一、段落重组、点击跳播和播放跟随。
- 长文稿虚拟列表与滚动优化；沉浸页背景式文稿与单集详情快捷入口。
- 模型一键部署：约 240 MB，支持 `.part` 续传、多源 fallback、连接 / 流空闲超时、取消和异常退出恢复。
- 模型完整性：固定文件 size + SHA256；ready manifest 不能替代真实文件校验；ASR 使用前执行 deep verify，文件变化会使缓存失效。
- 多实例安装锁：活实例互斥，锁包含 PID 与 owner token；持锁进程异常退出后可立即回收孤儿锁。
- 第三方许可证与归属：模型目录和安装包均携带对应 notice / 完整许可证文本。

## 模型来源

- `model.int8.onnx` / `tokens.txt`：优先使用官方 HuggingFace `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`；官方源不可达时可使用 `hf-mirror.com` fallback。
- `silero_vad.onnx`：sherpa-onnx 官方 GitHub `asr-models` release。
- 三个文件只在固定 SHA256 全部通过后标记 ready。镜像只提供传输，不是完整性信任根。
- 安装包不包含 `.onnx` 模型；模型位于共享目录 `D:\MyYesPlayerMusic\PodPlayerData\_models\asr\sensevoice-small\`。

模型名、作者 / 项目归属和许可证见 `THIRD_PARTY_NOTICES.md`。SenseVoiceSmall 适用 FunASR Model Open Source License Agreement 1.1；Silero VAD 适用 MIT；sherpa-onnx 适用 Apache 2.0；打包的 FFmpeg Windows 二进制适用 GPLv3。

## 联网与数据边界

- 一键部署只下载并校验模型，不会自动生成任何文稿。
- 本地转写不会调用 DeepSeek，不会触发 NAS、备份恢复或数据迁移。
- AI 精修默认不运行；只有用户自行配置 key 并明确点击「AI 优化」时，才会把该集文稿发送到配置的 DeepSeek endpoint。
- 不会自动批量下载或转写历史单集。
- 节目详情列表中，用户对未下载单集明确点击转录按钮时，会先下载该集，下载完成后再转录。
- 删除文稿只删除该集文稿正文、Dexie 索引和 AI 精修层，不删除音频。删除模型不删除既有文稿或音频。

## 升级与兼容

- Dexie schema 从 v11 逐步升级到 v15，新增 `transcripts`、`transcriptDict`、`transcriptAi`；旧表为增量兼容。
- 旧备份缺少上述三表时按空数组处理，不阻止恢复。
- Node 开发环境统一为 Node 16 + Yarn 1。

## 平台与已知限制

- 本地 ASR 和一键部署在 Windows x64 验证。macOS / Linux 的其它客户端功能仍保留，但本版本不宣称这些平台的本地 ASR 已验证。
- Windows portable 与 NSIS 安装包当前未做 Authenticode 签名，首次运行可能出现 SmartScreen 提示。
- DeepSeek 精修是可选联网层，不是默认能力，也不是本地模型部署的一部分。
- 本版本没有说话人分离、全文搜索、AI 总结或自动批量转录。
- 文稿正文位于当前 profile 的 `transcripts\`；备份包含索引 / 词典 / AI 层，不复制大体积音频或模型。

## 验证口径

发布门禁包含：全量 lint、web build、Windows packaged build、空目录模型部署、多源 fallback、取消与强杀续传、双实例锁、同尺寸文件替换拒绝、源码 / packaged worker 短音频、Dexie v11 / v13 到 v15 升级，以及旧备份缺表兼容。
