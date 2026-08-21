# dsh-pet Windows 修复技术文档

> 项目: FlytoMAYDAY80/dsh-pet (Electron 桌面桌宠)
> 目标平台: Windows 10/11, 150% DPI 缩放 (scaleFactor=1.5)
> 状态: 修复完成, 待作者合并

---

## 1. 问题背景

用户在三项核心交互上遇到故障:
1. **拖拽漂移**: 拖动鲸鱼时窗口往右/右下偏移, 松手不停在光标处
2. **右上角遮挡**: 宠物停在右上角时被遮挡、无法点击
3. **点击拉起不一致**: 单击宠物有时弹壳子窗口、有时弹浏览器, 行为不可预测

## 2. 根因分析(带证据)

### 2.1 拖拽漂移 — 两个叠加的根因

**根因 A: 高 DPI 单位混用(原始 bug)**
- 原实现: renderer 用 `e.screenX - sx` 计算增量, 通过 IPC 发给主进程, 主进程 `setPosition(x + dx)`
- 机器 scaleFactor=1.5: `e.screenX` 是**物理像素**, `setPosition` 用 **DIP(逻辑像素)**
- 效果: 窗口移动 = 鼠标移动 × 1.5, 越拖越偏右下
- 证据: `probe-units.ps1` 输出 `scaleFactor=1.5`, `probe-position.ps1` 验证 `setPosition(100)` → `getBounds` 差 100(确认 setPosition 用 DIP)

**根因 B: 幽灵拖拽(残留 bug, 审查后确认)**
- `setIgnoreMouseEvents(true, {forward:true})` 在 Windows 上会**转发窗口外**的鼠标事件
- 拖拽中窗口滞后光标 ≥1 帧, 光标短暂离开命中区 → `updateClickable` 翻转穿透 → 丢失 mousemove/mouseup → `down` 保持 true → 下一次悬停恢复"幽灵拖拽"
- 证据: 轨迹日志显示第二次 drag-start 时 光标 (970,316) 在窗口 (728,-158, 282x342) 外 134px —— mousedown 不可能发生在窗口外, 只能是转发事件
- 修复: drag-start 校验 `cursorInsideWindow()`, 拒绝窗口外起点; drag-move 中光标离窗自动结束

### 2.2 右上角遮挡

- 置顶层级 `'floating'` 在 Windows 上不是最高级, 会被其他窗口覆盖
- 280×340 透明窗口整块拦截鼠标, 透明区也吃掉点击
- 修复: Windows 用 `'screen-saver'` 层级; 默认 `setIgnoreMouseEvents(true, {forward:true})`, renderer 报告指针命中才恢复可交互

### 2.3 点击拉起不一致 — 单向棘轮

- `openGui()` 先探测浏览器窗口标题(`browserHasDshPage()`), 再查持久化 `openMode`
- 一旦浏览器开过 DSH 标签, 探测几乎永远命中 → 用户被永久转成浏览器打开, 无法回到壳子模式
- 且 `spawnSync('powershell', {timeout:3000})` 在点击路径上**阻塞整个主进程** 0.5~3s
- 修复: 删除探测, 行为 = 壳子活着→拉壳子; 否则按持久化 openMode(默认壳子)

## 3. 修复清单

| # | 文件 | 修复 | 对应根因 |
|---|------|------|---------|
| 1 | main.js | `getCursorScreenPoint()` 无参协议, 绝对位移 DIP 重算 | 2.1A |
| 2 | preload.js | 删除重复 `dragMove` 键(旧 (dx,dy) 版覆盖无参版) | 2.1A |
| 3 | main.js | `setPassthrough()` 单一所有者 + `dragging` 闩锁 | 2.1B |
| 4 | renderer.js | `updateClickable` 加 `if (down) return` 守卫 | 2.1B |
| 5 | main.js | drag-start 校验光标在窗口内; drag-move 离窗自动结束 | 2.1B |
| 6 | main.js | Windows `'screen-saver'` 置顶层级 + 默认鼠标穿透 | 2.2 |
| 7 | main.js | `openGui` 删除浏览器探测; `openMode` 持久化; 最小化壳子 `restore()` | 2.3 |
| 8 | main.js | `openGui` 三分支日志 + drag/passthrough 轨迹日志 | 可观测性 |

## 4. 验证方法

```powershell
# 在隔离环境(连测试 DSH, 不碰真实环境)运行验证脚本
```

验证项:
1. 拖拽: 快拖/慢拖均跟手, 松手停原地, 无漂移
2. 右上角: 可点击, 不被遮挡
3. 点击: 壳子活着→拉壳子; 关壳子再点→弹壳子; 显式切浏览器→浏览器(重启记住)
4. 最小化壳子→点宠物→恢复

## 5. 关键日志

```
[pet] drag-start REJECTED (cursor outside window)   # 幽灵拖拽被拒绝
[pet] drag-move -> auto drag-end (cursor left window) # 离窗自动结束
[pet] passthrough on/off                            # 穿透状态切换
[pet] openGui -> pull existing shell / browser / open shell
```

## 6. 已知限制

- 混合 DPI 多显示器: 绝对 DIP 位移在单显示器 150% 下正确, 跨异缩放显示器未实测
- 音效: `afplay` 是 macOS 命令, Windows 上静默失效(原项目问题, 未在本 PR 范围)
- 浏览器标题探测已删除, "系统浏览器"模式完全由用户显式选择
