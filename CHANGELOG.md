# Changelog

本项目版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)（`主版本.次版本.修订号`）。

## [Unreleased]

（无）

## [v0.1.1] - 2026-08-17

### 修复
- 审批/提问音效失效：DSH 0.1.0-rc.6 起事件通道（events.mux / events.host）只接受
  WebSocket 升级（普通 GET 返回 426），桌宠原 SSE 客户端连不上导致审批事件收不到。
  改为 WebSocket 连接（帧格式不变，断线自动重连逻辑保留）
- 打包版（app.asar）音效无声：afplay 无法读取 asar 归档内路径（AudioFileOpen failed），
  播放前先解压音效到临时目录
- 提问跟踪失效：question/requested 帧载荷没有 questionRpcId 字段（唯一标识在
  ServerRequest 信封的 rpcId 上），原实现用它做 key 导致多个提问互相覆盖、
  且 question/resolved 永远匹配不上（待决提问残留 30 分钟才过期）。
  改为用信封 rpcId 做 key，与官方客户端 q:<rpcId> 语义一致
- 完成提示音不触发：turn/end 事件的 reason 位于 event.data.reason 而非事件顶层，
  修正判断层级后，会话完成时正常播报完成音

### 发布准备（v0.1.0 候选）
- 补齐发布资产：LICENSE、CHANGELOG、README 首页、应用图标、打包配置、docs 截图素材
- 新增「自定义素材包」机制：`custom/` 目录零代码定制（像素图案/配色/音效），含参考图生成脚本 `scripts/ref_to_sprites.py`
- 产品说明文档新增「素材定制指南」章节

## [v0.1.0] - 2026-08-09（历史功能汇总）

### 核心功能
- 桌面悬浮像素鲸鱼（DeepSeek 品牌形象，HD 80×58 素材），5 态状态机：
  `需要确认 > 工作中 > 完成待查看 > 空闲 > 离线`
- 状态信号：`session.list` 轮询（2s）+ SSE `events.mux`（审批/提问/队列）+ SSE `events.host`（running 翻转即时推送）
- 多会话粒度提示：气泡逐行列出运行中/待确认/完成会话，超高时内部滚动
- 状态音效：审批音 / 完成音（AAC，可开关、可自定义）
- 像素级点击热区、动态间距（喷水自动拉开）、拖拽定位、置顶悬浮

### 交互与可定制
- 单击打开 DSH GUI（系统浏览器 / 桌宠窗口直达会话，两种打开方式可切换）
- 鲸鱼大小调节（50%–110%）、气泡显示/隐藏、状态提示音开关

### 工程
- Electron 41（macOS 验证），透明无边框置顶窗口
- 自检体系：`--shot` 截图模式、像素级验证脚本（`scripts/verify_*.py`）
