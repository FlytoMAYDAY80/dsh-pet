<h1 align="center">
  <img src="assets/icon.png" width="64" alt="DSH 桌宠 icon" valign="middle" />
  DSH 有声桌宠
</h1>

<p align="center">
  <strong>悬浮在桌面上的 DeepSeek 小鲸鱼 —— 不打开 DSH 页面，也能实时感知会话状态。</strong><br/>
  独立置顶悬浮窗，跨全屏 App 可见：有会话在跑、需要你审批、任务做完了，余光即得。
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/FlytoMAYDAY80/dsh-pet" /></a>
  <a href="https://github.com/FlytoMAYDAY80/dsh-pet/releases"><img alt="Release" src="https://img.shields.io/github/v/release/FlytoMAYDAY80/dsh-pet" /></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-171513.svg" />
  <img alt="Runtime: Electron" src="https://img.shields.io/badge/runtime-Electron-47848F.svg" />
</p>

![五种状态预览](docs/contact-sheet.png)

DSH 桌宠是一只独立的桌面应用：当你在浏览器、IDE、文档里工作时，鲸鱼始终悬浮在桌面一角，用表情、气泡和音效告诉你——**有会话在跑、需要你去审批、任务做完了**。把"任务状态"从需要主动查看的页面，变成余光即得的实时信号。

> 📦 本项目随 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 发布而开源（原托管于 `dsh-external` 组织仓库，现以个人账号仓库作为公开源）。欢迎使用、定制与贡献。

## ✨ 核心特性

- **离屏状态感知**：独立置顶悬浮窗，跨全屏 App 可见，不打开 DSH 也能看见状态
- **人工介入零遗漏**：「需要确认」（审批/提问）最高优先级呈现 + 专属音效，不会错过需要你的节点
- **毫秒级实时**：双 SSE 通道（审批/提问推送 + 运行状态翻转推送），状态变化即时响应
- **跨会话聚合**：多会话并行时气泡逐行列出每个会话，数量再多也可滚动查看
- **低打扰**：只在状态真正变化时动画/发声，不刷存在感
- **对 DSH 零侵入**：纯只读 HTTP/SSE 接口，不写入任何数据，卸载即消失
- **零代码定制**：`custom/` 目录一键换图案、配色、音效（见下方"定制"）

## 📊 五种状态

| 状态 | 鲸鱼表现 | 含义 |
|---|---|---|
| 🔴 需要确认 | 瞪眼 + 眉毛 + o 嘴 + 提示音 | 有审批/提问等你处理 |
| 🔵 工作中 | 专注眼 + 喷水动画 | 有会话正在运行 |
| 🟢 完成待查看 | 开心眯眼 ^^ + 星星 | 任务刚完成，去看结果 |
| 💤 空闲 | 睡觉 + zzz | 无任务，安心休息 |
| 😵 离线 | 灰度 + X 眼 | 连不上 DSH，自动重试 |

优先级：`需要确认 > 工作中 > 完成待查看 > 空闲 > 离线`。

## ⬇️ 下载与安装

**方式一：下载安装包（推荐）** — 从 [GitHub Releases](https://github.com/FlytoMAYDAY80/dsh-pet/releases/latest) 下载：

| 平台 | 安装包 | 说明 |
|---|---|---|
| macOS Apple Silicon | `dsh-pet-<版本>-arm64.dmg` | 双击打开，把鲸鱼拖入 Applications |
| macOS Apple Silicon | `dsh-pet-<版本>-arm64-mac.zip` | 便携版，解压即用；删文件夹即卸载 |

**方式二：从源码运行** — 需要 [Node.js](https://nodejs.org) 18+ 与 [pnpm](https://pnpm.io)：

```bash
pnpm install   # 安装依赖（Electron）
pnpm start     # 启动桌宠（默认右下角）
```

> 可选：`DSH_PET_URL=http://127.0.0.1:3080` 指定 DSH GUI 地址（默认 3080）。

## 🖱️ 使用

| 操作 | 行为 |
|---|---|
| 单击鲸鱼/气泡 | 打开 DSH GUI（系统浏览器，可切换桌宠窗口直达会话） |
| 按住拖拽 | 移动位置 |
| 右键鲸鱼/气泡（或托盘图标） | 菜单：气泡开关、音效开关、大小调节、打开方式 |
| 滚轮（气泡内） | 滚动查看多会话列表 |

## 🎨 定制（零代码）

把文件放进 `custom/` 目录，重启即生效：

```text
custom/
├── sprites.json      ← 像素图案 + 配色（可用脚本从参考图生成）
├── attention.m4a     ← 「需要确认」音效
└── done.m4a          ← 「任务完成」音效
```

从参考图生成图案：

```bash
python3 scripts/ref_to_sprites.py <你的参考图.png>
```

详细格式见 [`custom/README.md`](custom/README.md) 与 [`产品说明.md`](产品说明.md)。

## ❓ 常见问题

**Q：桌宠没出现在桌面上？**
先确认 DSH GUI 已在 `http://127.0.0.1:3080` 运行；桌宠离线状态（灰度 X 眼）会自动重试连接。

**Q：听不到提示音？**
右键鲸鱼 → 菜单里打开"音效"，并确认系统音量；「需要确认」与「任务完成」各有专属音效。

**Q：桌宠会不会把数据传到云端？**
不会。桌宠只读取本地 DSH 接口（HTTP/SSE），无任何云端上报，卸载即消失。

## 🛠️ 开发与自检

```bash
pnpm smoke        # 状态引擎冒烟测试（连接/轮询/SSE/状态推导）
pnpm shot         # 两种皮肤 × 5 状态截图到 .shots/
python3 scripts/verify_pixel_src.py   # 素材规格与参考图一致性校验
python3 scripts/gen_icon.py           # 重新生成应用图标
```

## 📁 目录结构

```
main.js          主进程：窗口/托盘 + DSH 状态引擎（轮询 + 双 SSE）+ 素材包加载
preload.js       contextBridge IPC
app/             渲染层：index.html + styles.css + renderer.js + 像素素材 + 音效
custom/          自定义素材包（用户定制入口）
pixel-src-hd/    像素素材源（JSON + PNG）
scripts/         生成/自检脚本
docs/            截图与演示素材
```

## 📄 License

[MIT](LICENSE) © FlytoMAYDAY80

---

## 免责声明

本仓库是**独立的第三方工具**，与 DeepSeek / DeepSeek AI 官方无关。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）是官方项目（MIT）。鲸鱼形象与"DeepSeek"名称用于指代所对接的官方产品，版权归其各自所有者。

---

## English

> A floating desktop whale for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — know your session status at a glance without opening the DSH page.

DSH 桌宠 (dsh-pet) is a standalone desktop app: a small whale floats in a corner of your screen and reflects your DSH session state — **needs your approval / working / finished / idle / offline** — via expressions, bubbles and sounds.

- **Download**: [GitHub Releases](https://github.com/FlytoMAYDAY80/dsh-pet/releases/latest) (macOS Apple Silicon, DMG or ZIP)
- **Run from source**: `pnpm install && pnpm start` (Node.js 18+, pnpm)
- **Customize**: drop your own sprites/colors/sounds into `custom/`, restart to apply
- **Privacy**: reads only the local DSH HTTP/SSE interface, no cloud upload
- **License**: MIT

*DSH 桌宠只读取本地 DSH 接口，无任何云端上报。*
