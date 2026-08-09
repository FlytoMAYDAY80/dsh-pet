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

window.pet.onState((s) => {
  currentMode = s.mode
  root.dataset.mode = s.mode
  elTitle.textContent = s.bubble.title
  elBody.textContent = s.bubble.body

  // 仅在状态(mode)真正变化时才让气泡弹一下 + 播放对应提示音；
  // 同一状态下的轮询刷新不再触发动画，避免持续闪动
  if (s.mode !== lastMode) {
    lastMode = s.mode
    playSound(s.mode)
    elBubble.classList.remove('pop')
    void elBubble.offsetWidth
    elBubble.classList.add('pop')
    scheduleDraw() // 像素皮肤：状态变化时重绘
  }
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
})

window.pet.onSkinChange((v) => {
  skin = v
  root.dataset.skin = v
  scheduleDraw()
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
})

/* ---------------- 拖拽 + 点击（热区：仅气泡 + 鲸鱼本体） ---------------- */
let down = false
let moved = false
let sx = 0
let sy = 0

/**
 * 点击是否落在鲸鱼像素本体上（像素版：读 canvas 该点 alpha；
 * 矢量版：elementFromPoint 是否命中 SVG 图形元素）。鲸鱼周边空白返回 false。
 */
function isWhaleHit(e) {
  if (skin === 'pixel') {
    const rect = elCanvas.getBoundingClientRect()
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return false
    const px = Math.floor((e.clientX - rect.left) / rect.width * elCanvas.width)
    const py = Math.floor((e.clientY - rect.top) / rect.height * elCanvas.height)
    try {
      return pixCtx.getImageData(px, py, 1, 1).data[3] > 0
    } catch { return false }
  }
  const el = document.elementFromPoint(e.clientX, e.clientY)
  return !!el && el.closest('svg') !== null && el.tagName !== 'svg' && el.id !== 'whale'
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
  })
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (el === elStage && !isWhaleHit(e)) return
    window.pet.contextMenu()
  })
}

window.addEventListener('mousemove', (e) => {
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

window.addEventListener('mouseup', () => {
  if (down && !moved) {
    window.pet.openGui() // 单击鲸鱼/气泡 → 打开 DSH GUI
  }
  down = false
  moved = false
  root.classList.remove('dragging')
})
