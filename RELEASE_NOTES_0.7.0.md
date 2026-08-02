# PodPlayer v0.7.0

## 本版重点

- **联网 AI 服务配置**：设置页提供 DeepSeek、OpenAI、Gemini 兼容接口、OpenRouter、本地服务和自定义 OpenAI Chat Completions 服务预设。用户通过“保存并测试”手动验证配置后，才可使用本集总结和文字稿精修。
- **凭据与联网边界**：Windows 使用 DPAPI 保护 API 密钥，并按服务商、规范化 Base URL 和认证方式隔离凭据。仅在用户主动生成总结或精修时发送当前文字稿，音频不会上传；远程 HTTP 服务会被拒绝，本机回环 HTTP 例外。
- **AI 任务一致性**：文字稿精修采用全局单活动任务，同集重复点击复用已有任务；切集、取消、销毁和晚到响应不会覆盖其它单集状态或写入陈旧结果。
- **备份恢复加固**：完整恢复会在删库前预检备份结构、创建独立恢复前快照，并以单一事务回灌；失败时报告真实回滚状态。历史合并只恢复收藏、进度、统计、每日记录和下载记录，不会覆盖文稿资产。
- **安全渲染**：节目、艺人、创作者和 MV 等远端名称改用结构化文本渲染，不再进入未清洗 HTML sink。
- **订阅更新流**：快速节目轨道采用完整槽位和离散边缘导航，统一箭头、滚轮、滑条和键盘逻辑；订阅更新流继续优先展示单集封面。
- **收听统计体验**：排行榜条形、重排和幽灵行采用收口后的非线性动画生命周期；“统计条封面纹理”可独立于彩虹猫样式开关启用，并以节目封面色彩形成横向纹理和端帽过渡。
- **细节收口**：沉浸页控件与标题交互更克制，搜索歌单仅在存在真实 metadata 时显示副标题。

## 联网 AI 与兼容范围

- DeepSeek 已完成实机配置与使用验证。
- OpenAI、Gemini 兼容接口、OpenRouter、本地服务和自定义服务提供 OpenAI Chat Completions 协议层支持；本版不宣称所有模型、认证方式或 JSON mode 都已完成实机质量认证。
- 本版不包含自动总结、批量总结、说话人分离、全文搜索或自动服务商 fallback。

## 平台与已知限制

- 本地 ASR 与模型部署的发布验证范围为 **Windows x64**。SenseVoiceSmall 模型约 240 MB，安装包不内置模型，须由用户在设置页手动部署或选择本地目录。
- Portable 与 NSIS 安装包当前未做 Authenticode 签名，Windows 首次运行可能出现 SmartScreen 提示。
- Electron 主窗口仍使用 `nodeIntegration: true` 与 `contextIsolation: false`，这是后续独立架构加固项；本版已先清除已知远端不可信 HTML 渲染入口。

## 第三方许可

本版没有新增第三方依赖。SenseVoiceSmall、Silero VAD、sherpa-onnx 和 FFmpeg 分别适用其自身许可证与归属要求，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
