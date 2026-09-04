'use strict'

/* ============ DSH 桌宠渲染逻辑 ============ */

const root = document.getElementById('root')
const elBubble = document.getElementById('bubble')
const elTitle = document.getElementById('bubble-title')
const elBody = document.getElementById('bubble-body')

let bubbleOn = true
let lastMode = null
let soundOn = true

/* ---------------- 状态提示音 ----------------
 * 播放由主进程用系统播放器 afplay 执行（custom/ 优先，回退内置），
 * 避免 Chromium 音频输出在 macOS 上的无声问题。
 */
function playSound(mode) {
  if (!soundOn) return
  window.pet.playSound(mode)
}

/* ---------------- 像素版绘制 ---------------- */
const elCanvas = document.getElementById('pixel-canvas')
const pixCtx = elCanvas.getContext('2d')
const PIXEL_SCALE = 6 // 80*6=480 物理宽, 58*6=348 物理高（HD 网格 2x 超采样）

let skin = 'vector'
let currentMode = 'starting'
let rafId = null

/* ---------------- 鲸鱼大小控制 ---------------- */
const elStage = document.getElementById('stage')
// 全尺寸（缩放系数 1.0）时的布局尺寸
const STAGE_FULL = { w: 262, h: 174 }  // 高度贴合鲸鱼内容，避免留白撑大间距
const CANVAS_FULL = { w: 240, h: 174 }
let petScale = 0.67 // 默认：比原尺寸减小 1/3

function applyScale() {
  elStage.style.width = `${Math.round(STAGE_FULL.w * petScale)}px`
  elStage.style.height = `${Math.round(STAGE_FULL.h * petScale)}px`
  elCanvas.style.width = `${Math.round(CANVAS_FULL.w * petScale)}px`
  elCanvas.style.height = `${Math.round(CANVAS_FULL.h * petScale)}px`
}

window.pet.onScaleChange((v) => {
  petScale = v
  applyScale()
  queueHit() // 缩放会改变鲸鱼/气泡几何 → 重算热区
})
applyScale()

function drawPixel(time) {
  PIXEL.draw(pixCtx, currentMode, time || 0, PIXEL_SCALE)
  const animated = currentMode === 'working' || currentMode === 'done'
  if (animated) rafId = requestAnimationFrame(drawPixel)
}

function scheduleDraw() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null }
  if (skin !== 'pixel') return
  drawPixel(performance.now())
}

let lastAttentionCount = 0

window.pet.onState((s) => {
  currentMode = s.mode
  root.dataset.mode = s.mode
  elTitle.textContent = s.bubble.title
  elBody.textContent = s.bubble.body

  const attentionCount = (s.attention || []).length
  // 仅在状态(mode)真正变化时才让气泡弹一下 + 播放对应提示音；
  // 同一状态下的轮询刷新不再触发动画，避免持续闪动
  if (s.mode !== lastMode) {
    lastMode = s.mode
    playSound(s.mode)
    elBubble.classList.remove('pop')
    void elBubble.offsetWidth
    elBubble.classList.add('pop')
    scheduleDraw() // 像素皮肤：状态变化时重绘
  } else if (s.mode === 'attention' && attentionCount > lastAttentionCount) {
    // 已在「需要确认」状态时又来了新的待确认项：再次响铃提醒（如新审批/新提问）
    playSound('attention')
    elBubble.classList.remove('pop')
    void elBubble.offsetWidth
    elBubble.classList.add('pop')
  }
  lastAttentionCount = attentionCount
  queueHit() // 状态/气泡内容变化 → 重算热区
})

window.pet.onSoundToggle((v) => {
  soundOn = v
})

// 菜单「测试提示音」：依次播放完成音，供用户确认/试听
window.pet.onTestSound(() => {
  playSound('done')
})

window.pet.onBubbleVisibility((v) => {
  bubbleOn = v
  elBubble.style.display = v ? 'block' : 'none'
  queueHit() // 气泡收起/展开 → 该区域立即恢复/停止命中
})

window.pet.onSkinChange((v) => {
  skin = v
  root.dataset.skin = v
  scheduleDraw()
  queueHit() // 像素/矢量皮肤切换 → 命中方式随之切换
})

// 自定义素材包：覆盖内置像素网格/调色板（来自 custom/sprites.json）
window.pet.onCustomSprites((data) => {
  if (data?.palette && typeof data.palette === 'object') {
    Object.assign(PIXEL_SPRITES.palette, data.palette)
  }
  if (data?.sprites && typeof data.sprites === 'object') {
    PIXEL_SPRITES.sprites = data.sprites
  }
  scheduleDraw()
  queueHit()
})

/* ---------------- 拖拽 + 点击（热区：仅气泡 + 鲸鱼本体） ---------------- */
let down = false
let moved = false
let sx = 0
let sy = 0

/*
 * 命中判断—统一以视口 CSS 像素坐标为输入，基于当前帧真实显示内容：
 * 像素版：读 canvas 当前帧该点 alpha（>8 仅过滤抗锯齿噪点，不缩掉可见边缘）；
 * 矢量版：elementFromPoint 是否命中 SVG 内已绘制图形（SVG 根/容器不算，周边空白返回 false）。
 */
function pointOverWhale(cx, cy) {
  if (skin === 'pixel') {
    const rect = elCanvas.getBoundingClientRect()
    if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) return false
    const px = Math.floor((cx - rect.left) / rect.width * elCanvas.width)
    const py = Math.floor((cy - rect.top) / rect.height * elCanvas.height)
    try {
      return pixCtx.getImageData(px, py, 1, 1).data[3] > 8
    } catch { return false }
  }
  const el = document.elementFromPoint(cx, cy)
  return !!el && el.closest('svg') !== null && el.tagName !== 'svg' && el.id !== 'whale'
}

// 气泡可交互区 = 当前可见气泡的实际 DOM 矩形 + ::after 尾巴三角形；
// 不把尾巴所在的整条透明带算入热区。
function pointOverBubble(cx, cy) {
  if (elBubble.style.display === 'none') return false
  const r = elBubble.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return false
  if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return true
  const tailHeight = 10
  const tailHalfWidth = 10
  const dy = cy - r.bottom
  if (dy < 0 || dy > tailHeight) return false
  const tailCenterX = (r.left + r.right) / 2
  return Math.abs(cx - tailCenterX) <= tailHalfWidth * (1 - dy / tailHeight)
}

// 兼容旧调用（事件对象 → 坐标）
function isWhaleHit(e) {
  return pointOverWhale(e.clientX, e.clientY)
}

const hitAreas = [elBubble, elStage]

for (const el of hitAreas) {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (el === elStage && !isWhaleHit(e)) return // 鲸鱼周边空白：不响应
    down = true
    moved = false
    sx = e.screenX
    sy = e.screenY
    updateHit() // 按住期间保持可交互，防止拖到透明区被穿透打断
  })
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (el === elStage && !isWhaleHit(e)) return
    window.pet.contextMenu()
  })
}

/* ---------------- 点击穿透：仅鲸鱼轮廓 + 气泡矩形可交互 ----------------
 * 主进程据上报结果对透明置顶窗调用 setIgnoreMouseEvents(ignore, {forward:true})，
 * 交叠层（像素轮廓/气泡）之外一律 click-through，透传后方窗口的点击/拖拽/滚轮/悬停。
 */
let lastPointer = { x: -1, y: -1 }
let hitPending = false
let lastInteractive = null // 只在状态翻转时发 IPC，避免 150ms 兜底轮询刷屏

// 计算当前指针是否落在可交互区并上报主进程。down(按住/拖动)时强制可交互，
// 保证拖拽期间鼠标事件不被打断、松开时能收到 mouseup。
function updateHit() {
  let interactive = down
  if (!interactive && lastPointer.x >= 0 && lastPointer.y >= 0) {
    interactive = pointOverBubble(lastPointer.x, lastPointer.y) || pointOverWhale(lastPointer.x, lastPointer.y)
  }
  if (interactive === lastInteractive) return
  lastInteractive = interactive
  window.pet.setInteractive(interactive)
}
function queueHit() {
  if (hitPending) return
  hitPending = true
  requestAnimationFrame(() => { hitPending = false; updateHit() })
}
// 低频兜底：鲸鱼动画（浮动/尾摆/喷水）在光标静止时也在移动，需让热区跟随当前显示内容
setInterval(() => {
  if (lastPointer.x >= 0 || down) updateHit()
}, 150)

window.addEventListener('mousemove', (e) => {
  lastPointer.x = e.clientX
  lastPointer.y = e.clientY
  queueHit()
  if (!down) return
  const dx = e.screenX - sx
  const dy = e.screenY - sy
  if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
    moved = true
    root.classList.add('dragging')
  }
  if (moved) {
    sx = e.screenX
    sy = e.screenY
    window.pet.dragMove(dx, dy)
  }
})

window.addEventListener('mouseleave', () => {
  lastPointer.x = -1
  lastPointer.y = -1
  updateHit()
})

window.addEventListener('mouseup', () => {
  if (down && !moved) {
    window.pet.openGui() // 单击鲸鱼/气泡 → 打开 DSH GUI
  }
  down = false
  moved = false
  root.classList.remove('dragging')
  updateHit() // 松开后按指针实际位置恢复命中/穿透
})

// 初始基线：尚无指针位置，默认整窗 click-through（避免铺开即阻塞后方应用）
updateHit()
