# dsh-pet

一只悬浮在桌面角落的小鲸鱼，告诉你 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里的会话现在是什么状态。

不用专门切回 DSH 页面：鲸鱼的表情、气泡和提示音会把「有会话在跑」「需要你确认」「任务做完了」这些变化放在你余光里。需要审批或任务完成时，它还会出声提醒。

## 它做了什么

- 5 种状态：需要确认 / 工作中 / 完成待查看 / 空闲 / 离线，按紧迫度展示
- 多会话并行时，气泡按会话逐行列出，并显示每个会话此刻正在做的事（正在思考、调用某个工具、组织回答）
- 有审批或提问到达时，气泡列出待确认项并播提示音
- 点击宠物会拉起正在运行的 DSH 窗口，找不到就开系统浏览器
- 位置、气泡、音效、大小都能调，也可以换皮肤素材

## 运行

需要 Node.js 18+ 和 pnpm：

```bash
pnpm install
pnpm start
```

默认连接 `http://127.0.0.1:3080`。DSH 在别的端口时用环境变量指定：

```bash
DSH_PET_URL=http://127.0.0.1:52693 pnpm start
```

启动时会自动探测常见端口（3080、52693 等），找到后把地址记到 `pet-config.json`，下次直接连。

### 使用

| 操作 | 行为 |
|---|---|
| 单击鲸鱼/气泡 | 拉起正在运行的 DSH 壳窗口（失败则开系统浏览器） |
| 按住拖拽 | 移动位置（位置会被记住） |
| 右键鲸鱼或托盘图标 | 菜单：气泡开关、音效开关、大小、打开方式、重新探测 DSH |

## 状态数据来源

只读 DSH 的本地接口，不写入任何数据，关掉就没了：

- 每 2 秒轮询 `session.list`，拿会话标题和运行状态
- WebSocket 订阅 `events.mux`（审批、提问、消息事件）和 `events.host`（运行状态翻转）
- 断线自动重连，重连后服务端会重放未决项

## 自定义素材

把文件放进 `custom/` 目录，重启生效：

```text
custom/
├── sprites.json   像素图案与配色
├── attention.m4a  需要确认的音效
└── done.m4a       完成音效
```

## 已知限制

主要是在一台 Windows 上验证的（25H2 build 26200、单显示器 2560x1600、125% 缩放）。以下场景没怎么测试，可能表现一般：

- Linux：提示音对 m4a 的支持不完整，可能无声
- macOS：只在 Apple Silicon 上简单验证过
- 混合 DPI 多屏拖拽：代码全程用 DIP 计算，理论上没问题，但没逐台机器测过
- 如果 DSH 壳以管理员权限运行，宠物拉不起它的窗口（Windows 前台限制）
- 点击宠物时会把 DSH 壳的窗口置顶级别降下来，以免壳把宠物盖住；如果你依赖壳窗口置顶，这个行为要注意

遇到问题欢迎提 issue，说明系统、屏幕缩放、DSH 版本就好。

## 开发与自检

```bash
pnpm smoke        # 连接 / 轮询 / WebSocket / 状态推导冒烟
pnpm shot         # 各状态截图到 .shots/
```

## 目录结构

```text
main.js          主进程：窗口、托盘、DSH 状态引擎、实时动作追踪
preload.js       IPC 桥
app/             渲染层：气泡 UI、像素鲸鱼、音效
custom/          自定义素材入口
tray-icon.js     托盘图标（零依赖 PNG 生成）
```

## License

MIT © FlytoMAYDAY80

## 免责声明

独立第三方工具，与 DeepSeek 官方无关。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）是官方项目（MIT）。鲸鱼形象与产品名称用于指代所对接的官方产品，版权归各自所有者。

---

## English

A tiny whale in the corner of your screen that reflects your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) session state — needs approval / working / finished / idle / offline — so you don't have to keep the DSH page open. The bubble lists each running session and what it is doing right now (thinking, calling a tool, writing output). Click the whale to bring your running DSH window to the front.

- Run from source: `pnpm install && pnpm start` (Node.js 18+, pnpm)
- Point at another DSH: `DSH_PET_URL=http://127.0.0.1:52693 pnpm start`
- Customize: drop sprites/sounds into `custom/`, restart to apply
- Reads DSH local HTTP/WebSocket APIs only; nothing is written, nothing is uploaded
- License: MIT
